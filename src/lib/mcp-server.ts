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
import {
  METRICOOL_NOT_CONFIGURED_MESSAGE,
  PUBLISH_NETWORKS,
  metricoolConfigured,
  publishVideoJob,
  type PublishNetwork,
} from "./metricool";
import {
  DEFAULT_HASHTAGS,
  buildCaption,
  pickStoryIdea,
  type StoryIdea,
} from "./story-ideas";

export const SERVER_INFO = { name: "media-generator-mcp", version: "1.3.0" } as const;

export const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging and Metricool auto-publishing).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
To publish a finished video, call publish_video with the video URL or a completed task_id, an English caption, and the target network (facebook by default). Without scheduled_at it publishes as soon as possible (now + 5 minutes); with scheduled_at it is scheduled for that time. If Metricool is not configured, publish_video returns a clear error — never claim a video was published when it was not.
To make a full Fayyaz-page reel in one call, use create_story_video: it picks a story idea (or uses the one you pass), generates the video, and writes the English caption + hashtags. It does NOT publish unless publish=true is passed explicitly — never publish without being asked.
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

  server.registerTool(
    "publish_video",
    {
      description:
        "Publish/schedule a finished video through Metricool (Facebook by default). Pass 'video_url' (a public direct video link) or 'task_id' of a COMPLETED video/merge task, plus an English caption. Without scheduled_at it publishes as soon as possible (now + 5 minutes); with scheduled_at (ISO date-time) it is scheduled for that time. Returns the Metricool post id and the scheduled time. If Metricool is not configured, returns a clear error — never claim a video was published when it was not.",
      inputSchema: {
        video_url: z
          .string()
          .optional()
          .describe("Public direct video URL to publish."),
        task_id: z
          .string()
          .optional()
          .describe("Alternative to video_url: task_id of a COMPLETED video or merge task — its result URL is published."),
        caption: z
          .string()
          .default("New video! Follow for more.")
          .describe("English caption for the post (hashtags included if you add them)."),
        networks: z
          .array(z.enum(PUBLISH_NETWORKS))
          .default(["facebook"])
          .describe("Target networks — facebook by default. Each must be connected in Metricool."),
        scheduled_at: z
          .string()
          .optional()
          .describe("ISO date-time to schedule for (must be in the future). Omit to publish as soon as possible."),
        timezone: z
          .string()
          .default("Africa/Cairo")
          .describe("IANA timezone for scheduled_at (e.g. Africa/Cairo)."),
        draft: z
          .boolean()
          .default(false)
          .describe("Save as a draft in Metricool instead of scheduling it."),
      },
    },
    async (args) => {
      // Resolve the video URL: task_id first, then the direct URL.
      let videoUrl = args.video_url ?? "";
      let sourceTaskId: string | null = null;
      if (args.task_id) {
        const task = await getTask(args.task_id);
        const firstUrl = task?.resultUrls?.[0];
        if (task && task.status === "completed" && firstUrl) {
          videoUrl = firstUrl;
          sourceTaskId = task.id;
        } else {
          return textResult(
            `❌ Cannot publish task ${args.task_id}: ${task ? `status is ${task.status}` : "task not found"}. Publish only completed video or merge tasks.`,
            true
          );
        }
      }
      if (!videoUrl || !/^https?:\/\//i.test(videoUrl)) {
        return textResult(
          "❌ publish_video needs a video_url (public http/https link) or a task_id of a completed video/merge task.",
          true
        );
      }
      if (!metricoolConfigured()) {
        // Record the failed attempt so the dashboard shows it, then report it.
        await publishVideoJob({
          taskId: sourceTaskId,
          videoUrl,
          caption: args.caption,
          networks: args.networks as PublishNetwork[],
          scheduledAt: args.scheduled_at,
          timezone: args.timezone,
          draft: args.draft,
        });
        return textResult(METRICOOL_NOT_CONFIGURED_MESSAGE, true);
      }
      const result = await publishVideoJob({
        taskId: sourceTaskId,
        videoUrl,
        caption: args.caption,
        networks: args.networks as PublishNetwork[],
        scheduledAt: args.scheduled_at,
        timezone: args.timezone,
        draft: args.draft,
      });
      if (!result.ok) {
        return textResult(`❌ Publishing failed: ${result.error}`, true);
      }
      const when = new Date(result.scheduledAt).toLocaleString("en-GB", {
        timeZone: args.timezone,
      });
      return textResult(
        result.draft
          ? `✅ Video saved as a draft in Metricool\n\nMetricool post id: ${result.postId}\nNetworks: ${args.networks.join(", ")}\nVideo: ${videoUrl}`
          : `✅ Video scheduled on Metricool\n\nMetricool post id: ${result.postId}\nNetworks: ${args.networks.join(", ")}\nScheduled for: ${when} (${args.timezone})\nVideo: ${videoUrl}\nCaption: ${args.caption}`
      );
    }
  );

  server.registerTool(
    "create_story_video",
    {
      description:
        "Make a full Fayyaz-page reel in one call: pick a story idea automatically from the idea bank (or use the 'idea' text you pass), generate the video with grok-imagine-video-1-5-preview, and write the English caption + hashtags. Returns the video task_id (poll with get_task) and the caption. It does NOT publish unless publish=true is passed explicitly — never publish without being asked.",
      inputSchema: {
        idea: z
          .string()
          .optional()
          .describe("Optional custom story idea (plain English text). Omit to pick today's idea from the bank automatically."),
        caption: z
          .string()
          .optional()
          .describe("Optional caption override (English). Omit to use the idea's caption + hashtags."),
        publish: z
          .boolean()
          .default(false)
          .describe("Publish through Metricool as soon as the video completes (only when the video finished inside the wait window). Default: do NOT publish."),
        networks: z
          .array(z.enum(PUBLISH_NETWORKS))
          .default(["facebook"])
          .describe("Networks to publish to when publish=true."),
        scheduled_at: z
          .string()
          .optional()
          .describe("ISO date-time to schedule for when publish=true. Omit to publish as soon as possible."),
        timezone: z.string().default("Africa/Cairo"),
        duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
        aspect_ratio: z.enum(VIDEO_ASPECT_RATIOS).default("9:16").describe("Vertical 9:16 by default for reels."),
        resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
        wait_seconds: z.number().int().min(0).max(240).default(25),
      },
    },
    async (args, extra) => {
      // Resolve the idea: custom text, or today's pick from the bank.
      let idea: StoryIdea;
      if (args.idea && args.idea.trim() !== "") {
        idea = {
          id: "custom",
          title: args.idea.trim().slice(0, 80),
          prompt: args.idea.trim(),
          caption: "Watch this! 😄",
          hashtags: DEFAULT_HASHTAGS,
        };
      } else {
        idea = pickStoryIdea();
      }
      const caption = args.caption?.trim() ? args.caption.trim() : buildCaption(idea);

      const result = await runGeneration(
        {
          type: "video",
          model: VIDEO_MODEL_CANONICAL,
          prompt: idea.prompt,
          aspectRatio: args.aspect_ratio,
          resolution: args.resolution,
          enableAudio: true,
          duration: args.duration,
          waitSeconds: args.wait_seconds,
        },
        makeNotifier(extra)
      );
      if (result.outcome === "failed" || result.outcome === "no_keys" || !result.task) {
        return textResult(result.message, true);
      }
      const task = result.task;
      const videoUrl = task.resultUrls?.[0];

      // Publish only when explicitly asked AND the video already finished.
      if (args.publish && result.outcome === "completed" && videoUrl) {
        const published = await publishVideoJob({
          taskId: task.id,
          videoUrl,
          caption,
          networks: args.networks as PublishNetwork[],
          scheduledAt: args.scheduled_at,
          timezone: args.timezone,
        });
        if (!published.ok) {
          return textResult(
            `${formatTaskReply(task)}\n\nCaption:\n${caption}\n\n❌ Publishing failed: ${published.error}`,
            true
          );
        }
        const when = new Date(published.scheduledAt).toLocaleString("en-GB", {
          timeZone: args.timezone,
        });
        return textResult(
          `${formatTaskReply(task)}\n\nCaption:\n${caption}\n\n✅ Video scheduled on Metricool\nMetricool post id: ${published.postId}\nNetworks: ${args.networks.join(", ")}\nScheduled for: ${when} (${args.timezone})`
        );
      }
      if (args.publish && result.outcome === "processing") {
        return textResult(
          `${formatTaskReply(task)}\n\nCaption (ready to post):\n${caption}\n\n` +
            `The video is still generating, so nothing was published yet. ` +
            `Once get_task shows completed, call publish_video with task_id ${task.id} to publish it.`
        );
      }
      return textResult(
        `${formatTaskReply(task)}\n\nStory: ${idea.title}\nCaption:\n${caption}` +
          (args.publish
            ? ""
            : "\n\nNot published (publish=false) — call publish_video with the task_id when you want it live.")
      );
    }
  );

  return server;
}
