// MCP server definition: 5 tools, official SDK (McpServer + zod schemas).
// All tool results are English. The AI client never sees key/balance errors.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { listRecentTasks, getTask } from "./turso";
import { formatTaskReply, refreshTask, runGeneration } from "./generation";
import { runMerge, validateMergeUrls } from "./merger";
import { IMAGE_MODEL_CANONICAL, VIDEO_MODEL_CANONICAL } from "./models";

export const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" } as const;

export const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

const IMAGE_ASPECT_RATIOS = [
  "auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5",
  "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3",
] as const;
const VIDEO_ASPECT_RATIOS = ["auto", "1:1", "16:9", "9:16", "3:2", "2:3"] as const;

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

/** Build a progress notifier from the tool call's _meta.progressToken. */
function makeNotifier(extra: RequestHandlerExtra<ServerRequest, ServerNotification>) {
  const token = extra._meta?.progressToken;
  if (token === undefined) return undefined;
  return async (progress: number, message: string) => {
    try {
      await extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress, total: 100, message },
      });
    } catch {
      // Client went away — progress is best-effort.
    }
  };
}

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_INFO.name, version: SERVER_INFO.version },
    { instructions: SERVER_INSTRUCTIONS }
  );

  server.registerTool(
    "generate_image",
    {
      description:
        "Generate an image with gpt-image-2-6/flare-text-to-image (automatic failover across all active keys). " +
        "Returns the finished image URL if it completes inside the wait window, otherwise a task_id — " +
        "call get_task every ~10 seconds until completed, then show the URL and stop.",
      inputSchema: {
        prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
        model: z
          .enum([IMAGE_MODEL_CANONICAL, "gpt-image-2.6/flare-text-to-image"])
          .default(IMAGE_MODEL_CANONICAL),
        aspect_ratio: z.enum(IMAGE_ASPECT_RATIOS).default("auto"),
        resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
        background: z.enum(["auto", "transparent", "opaque"]).default("auto").describe("Only applied at 1K."),
        output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
        wait_seconds: z.number().int().min(0).max(240).default(90),
      },
    },
    async (args, extra) => {
      const result = await runGeneration(
        {
          type: "image",
          model: args.model,
          prompt: args.prompt,
          aspectRatio: args.aspect_ratio,
          resolution: args.resolution,
          background: args.background,
          outputFormat: args.output_format,
          waitSeconds: args.wait_seconds,
        },
        makeNotifier(extra)
      );
      return textResult(result.message, result.outcome === "failed");
    }
  );

  server.registerTool(
    "generate_video",
    {
      description:
        "Generate a video with grok-imagine-video-1-5-preview (native synchronized audio, optional image-to-video). " +
        "Video takes minutes: a short wait with live progress, then a task_id — " +
        "follow it with get_task every ~10 seconds.",
      inputSchema: {
        prompt: z.string().max(4096).describe("Scene description. Dialogue in the prompt is spoken in the video."),
        image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
        model: z
          .enum([VIDEO_MODEL_CANONICAL, "grok-imagine-video-1.5-preview"])
          .default(VIDEO_MODEL_CANONICAL),
        aspect_ratio: z.enum(VIDEO_ASPECT_RATIOS).default("auto"),
        resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
        enable_audio: z.boolean().default(true),
        duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
        wait_seconds: z.number().int().min(0).max(240).default(25),
      },
    },
    async (args, extra) => {
      const result = await runGeneration(
        {
          type: "video",
          model: args.model,
          prompt: args.prompt,
          imageUrl: args.image_url,
          aspectRatio: args.aspect_ratio,
          resolution: args.resolution,
          enableAudio: args.enable_audio,
          duration: args.duration,
          waitSeconds: args.wait_seconds,
        },
        makeNotifier(extra)
      );
      return textResult(result.message, result.outcome === "failed");
    }
  );

  server.registerTool(
    "merge_videos",
    {
      description:
        "Merge several clips into ONE final video, in the given order. Pass 'urls' (public direct video links — " +
        "e.g. generate_video links) or 'task_ids' (completed video tasks, resolved from the database in order — " +
        "ideal after generating several clips). Merging is usually fast: a short wait with live progress, then a " +
        "merge task_id — track it with get_task. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
      inputSchema: {
        // NOTE: min/max counts are validated in the handler (not in zod) so
        // a bad call gets the exact user-facing message below instead of a
        // generic zod validation error. Limits: 2–10 clips.
        urls: z
          .array(z.string())
          .optional()
          .describe("Public direct video URLs (http/https) in merge order — the first clip starts the final video. 2–10 clips."),
        task_ids: z
          .array(z.string())
          .optional()
          .describe("Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order. 2–10 clips."),
        wait_seconds: z.number().int().min(0).max(240).default(60),
      },
    },
    async (args, extra) => {
      // task_ids first, then direct urls, each in their own order.
      const urls: string[] = [];
      const failedIds: string[] = [];
      if (args.task_ids) {
        for (const id of args.task_ids) {
          const task = await getTask(id);
          const firstUrl = task?.resultUrls?.[0];
          if (task && task.status === "completed" && firstUrl) {
            urls.push(firstUrl);
          } else {
            failedIds.push(`${id} (${task ? `status: ${task.status}` : "not found"})`);
          }
        }
      }
      if (args.urls) urls.push(...args.urls);

      if (urls.length < 2) {
        const detail =
          failedIds.length > 0 ? ` Unresolved task_ids: ${failedIds.join("; ")}.` : "";
        return textResult(
          `❌ Merging needs at least two clips. Pass urls (direct links) or task_ids of completed tasks.${detail}`,
          true
        );
      }
      try {
        validateMergeUrls(urls);
      } catch (err) {
        return textResult(err instanceof Error ? err.message : "❌ Invalid merge request.", true);
      }
      const result = await runMerge(urls, args.wait_seconds, makeNotifier(extra));
      return textResult(result.message, result.outcome === "failed");
    }
  );

  server.registerTool(
    "get_task",
    {
      description:
        "Track any task by its id — image/video generation AND merging (reads the Turso database and refreshes " +
        "from the provider/service while running). Call it every ~10 seconds; when completed you will find the " +
        "result URLs — show them to the user and stop polling.",
      inputSchema: {
        task_id: z.string(),
      },
    },
    async (args) => {
      const task = await refreshTask(args.task_id);
      if (!task) {
        return textResult(`❌ Task not found: ${args.task_id}.`, true);
      }
      return textResult(formatTaskReply(task), task.status === "failed");
    }
  );

  server.registerTool(
    "list_media",
    {
      description:
        "Latest stored images/videos/merges with their URLs from the database (no regeneration) — recall previous results.",
      inputSchema: {
        type: z.enum(["image", "video", "merge"]).optional(),
        status: z.enum(["completed", "failed", "processing"]).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async (args) => {
      const tasks = await listRecentTasks(args.limit, {
        type: args.type,
        status: args.status,
      });
      if (tasks.length === 0) {
        return textResult("No media found matching these filters yet.");
      }
      const lines = tasks.map((t) => {
        const urls = (t.resultUrls ?? []).join(", ") || "—";
        const attempts = (t.attempts ?? []).length;
        return (
          `• [${t.type}] ${t.id} — ${t.status} (${t.progress}%) — model: ${t.model} — ` +
          `attempts: ${attempts} — created: ${t.created_at}\n  prompt: ${(t.prompt || "").slice(0, 120)}\n  urls: ${urls}`
        );
      });
      return textResult(`Latest media (${tasks.length}):\n\n${lines.join("\n\n")}`);
    }
  );

  return server;
}
