// Video Merger API v2 client.
// Base URL comes from MERGER_API_BASE (no keys, no auth). If it is not set,
// merge requests fail with a clear English error — the base is never invented.
// RULES:
// - Declared HTTP errors from the service (4xx/5xx with an error body) are
//   TERMINAL: retrying gives the same result. Our own network errors
//   (timeout/fetch) are temporary: keep polling until the window ends.
// - `process` is fired exactly once per job (in-memory lock + persisted flag).
// - Merged files are deleted by the service after 24h (expiresAt).

import { getTask, insertTask, updateTask, type TaskRow } from "./turso";
import type { ProgressNotify } from "./generation";

export function mergerBase(): string {
  return (process.env.MERGER_API_BASE ?? "").trim();
}

const POLL_INTERVAL_MS = 3000;
const RETRY_COOLDOWN_MS = 45_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class MergerHttpError extends Error {
  httpStatus: number;
  constructor(message: string, httpStatus: number) {
    super(message);
    this.httpStatus = httpStatus;
  }
}

async function mergerFetch(path: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const base = mergerBase();
  if (!base) {
    throw new Error(
      "Video merging is not configured: set MERGER_API_BASE to the merging service URL."
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}${path}`, {
      ...init,
      signal: controller.signal,
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!res.ok) {
      const msg =
        (body && typeof body === "object" && typeof (body as Record<string, unknown>).error === "string"
          ? ((body as Record<string, unknown>).error as string)
          : "") || `Merging service returned HTTP ${res.status}.`;
      throw new MergerHttpError(msg, res.status);
    }
    return body;
  } catch (err) {
    if (err instanceof MergerHttpError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Network error calling merging service: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}

const DONE_STATES = new Set(["done", "completed", "complete", "success", "succeeded", "finished"]);
const FAILED_STATES = new Set(["error", "failed", "failure", "cancelled", "canceled"]);

function normalizeProgress(raw: unknown): number {
  if (typeof raw !== "number" || Number.isNaN(raw)) return 0;
  const pct = raw <= 1 ? raw * 100 : raw;
  return Math.min(100, Math.max(0, Math.round(pct)));
}

/** Prefer videoUrl, then downloadUrl, then the direct /video endpoint. */
function resolveResultUrl(body: Record<string, unknown>, jobId: string): string | null {
  const base = mergerBase().replace(/\/$/, "");
  if (typeof body.videoUrl === "string" && body.videoUrl.startsWith("http")) {
    return body.videoUrl;
  }
  if (typeof body.downloadUrl === "string" && body.downloadUrl.startsWith("http")) {
    return body.downloadUrl;
  }
  if (jobId) return `${base}/api/jobs/${jobId}/video`;
  return null;
}

interface JobState {
  status: "processing" | "completed" | "failed";
  progress: number;
  urls: string[];
  error?: string;
}

/** Defensive status analysis: an error body without a status means failed. */
function analyzeJob(body: unknown, jobId: string): JobState {
  const obj = (body ?? {}) as Record<string, unknown>;
  const rawStatus = typeof obj.status === "string" ? obj.status.toLowerCase() : "";
  const error =
    typeof obj.error === "string" && obj.error.trim()
      ? obj.error.trim()
      : undefined;
  if (rawStatus && FAILED_STATES.has(rawStatus)) {
    return { status: "failed", progress: 100, urls: [], error: error ?? `Merge failed (status: ${rawStatus}).` };
  }
  if (!rawStatus && error) {
    return { status: "failed", progress: 100, urls: [], error };
  }
  if (rawStatus && DONE_STATES.has(rawStatus)) {
    const url = resolveResultUrl(obj, jobId);
    if (!url) {
      return { status: "failed", progress: 100, urls: [], error: "Merge finished but returned no video URL." };
    }
    return { status: "completed", progress: 100, urls: [url] };
  }
  return { status: "processing", progress: normalizeProgress(obj.progress), urls: [] };
}

async function createMergeJob(urls: string[]): Promise<string> {
  const body = (await mergerFetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videos: urls }),
  }, 30000)) as Record<string, unknown>;
  const jobId = typeof body.jobId === "string" ? body.jobId : typeof body.id === "string" ? body.id : "";
  if (!jobId) throw new Error("Merging service did not return a job id.");
  return jobId;
}

async function getMergeJob(jobId: string): Promise<unknown> {
  return mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "GET" }, 15000);
}

/** In-memory lock so `process` is never fired twice for the same job. */
const processInFlight = new Set<string>();

/**
 * Fire POST /api/jobs/{id}/process exactly once (blocking ~10–15s on the
 * service). Terminal service errors fail the task immediately; our own
 * network errors leave it processing so the poll loop keeps checking.
 */
async function fireProcessOnce(taskId: string, jobId: string): Promise<void> {
  const lockKey = `${taskId}:${jobId}`;
  if (processInFlight.has(lockKey)) return;
  const task = await getTask(taskId);
  if (!task) return;
  if (task.params?.processFired === true) return;
  processInFlight.add(lockKey);
  try {
    await updateTask(taskId, {
      params: { ...(task.params ?? {}), processFired: true },
    });
    const body = await mergerFetch(`/api/jobs/${encodeURIComponent(jobId)}/process`, { method: "POST" }, 120000);
    const state = analyzeJob(body, jobId);
    if (state.status === "completed") {
      await updateTask(taskId, { status: "completed", progress: 100, resultUrls: state.urls });
    } else if (state.status === "failed") {
      await updateTask(taskId, { status: "failed", error_message: state.error });
    }
    // Still processing: the poll loop keeps checking GET /api/jobs/{id}.
  } catch (err) {
    if (err instanceof MergerHttpError) {
      // Declared service error = terminal failure, no retry.
      await updateTask(taskId, { status: "failed", error_message: err.message });
    }
    // Our network error: temporary — leave the task processing.
  } finally {
    processInFlight.delete(lockKey);
  }
}

export function validateMergeUrls(urls: string[]): void {
  if (!Array.isArray(urls) || urls.length < 2) {
    throw new Error(
      "❌ Merging needs at least two clips. Pass urls (direct links) or task_ids of completed tasks."
    );
  }
  if (urls.length > 10) {
    throw new Error("❌ The maximum number of clips to merge is 10 (the merging service accepts at most 10 clips).");
  }
  for (const u of urls) {
    if (typeof u !== "string" || !/^https?:\/\//i.test(u)) {
      throw new Error(`❌ Invalid video URL for merging: ${String(u)}. URLs must be public http/https links.`);
    }
  }
}

export interface MergeResult {
  outcome: "completed" | "processing" | "failed";
  task: TaskRow | null;
  message: string;
}

export async function runMerge(
  urls: string[],
  waitSeconds = 60,
  notify?: ProgressNotify
): Promise<MergeResult> {
  validateMergeUrls(urls);
  if (!mergerBase()) {
    // No merging service configured: fail fast with a clear message instead
    // of leaving a task "processing" forever.
    return {
      outcome: "failed",
      task: null,
      message: "❌ Video merging is not configured: set MERGER_API_BASE to the merging service URL.",
    };
  }
  const wait = Math.min(240, Math.max(0, waitSeconds));
  const taskId = crypto.randomUUID();
  // Record the task BEFORE any external call.
  let task = await insertTask({
    id: taskId,
    provider: "merger",
    model: "video-merger",
    type: "merge",
    prompt: `Merging ${urls.length} clips`,
    params: { urls, waitSeconds: wait, processFired: false },
    status: "pending",
  });

  let jobId = "";
  try {
    jobId = await createMergeJob(urls);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof MergerHttpError) {
      await updateTask(taskId, { status: "failed", error_message: message });
      task = (await getTask(taskId)) ?? task;
      return { outcome: "failed", task, message: `❌ Task failed: ${message}` };
    }
    // Our network error: temporary — keep the task processing; get_task retries.
    await updateTask(taskId, { status: "processing", error_message: "Waiting for the merging service…" });
    task = (await getTask(taskId)) ?? task;
    return { outcome: "processing", task, message: formatMergeReply(task) };
  }

  await updateTask(taskId, { provider_task_id: jobId, status: "processing", progress: 5 });
  task = (await getTask(taskId)) ?? task;

  // Fire process once, in the background (it blocks ~10–15s on the service).
  void fireProcessOnce(taskId, jobId);

  const deadline = Date.now() + wait * 1000;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await sleep(Math.min(POLL_INTERVAL_MS, remaining));
    task = (await getTask(taskId)) ?? task;
    if (task.status === "completed") {
      return { outcome: "completed", task, message: formatMergeReply(task) };
    }
    if (task.status === "failed") {
      return { outcome: "failed", task, message: `❌ Task failed: ${task.error_message ?? "Unknown error."}` };
    }
    try {
      const body = await getMergeJob(jobId);
      const state = analyzeJob(body, jobId);
      if (state.status === "completed") {
        task = (await updateTask(taskId, { status: "completed", progress: 100, resultUrls: state.urls })) ?? task;
        return { outcome: "completed", task, message: formatMergeReply(task) };
      }
      if (state.status === "failed") {
        task = (await updateTask(taskId, { status: "failed", error_message: state.error })) ?? task;
        return { outcome: "failed", task, message: `❌ Task failed: ${state.error}` };
      }
      task = (await updateTask(taskId, { progress: Math.max(task.progress, state.progress) })) ?? task;
      if (notify) await notify(Math.max(5, state.progress), `Merging… ${Math.max(5, state.progress)}%`);
    } catch (err) {
      if (err instanceof MergerHttpError) {
        // Declared service error = terminal failure, no retry.
        task = (await updateTask(taskId, { status: "failed", error_message: err.message })) ?? task;
        return { outcome: "failed", task, message: `❌ Task failed: ${err.message}` };
      }
      // Our network error: temporary — keep polling until the window ends.
      if (notify) await notify(task.progress, `Merging… ${task.progress}%`);
    }
  }
  task = (await getTask(taskId)) ?? task;
  return { outcome: "processing", task, message: formatMergeReply(task) };
}

/** Refresh a merge task from the service (used by get_task). */
export async function refreshMergeTask(task: TaskRow): Promise<TaskRow> {
  if (task.status === "completed" || task.status === "failed") return task;
  const urls = (task.params?.urls as string[] | undefined) ?? [];
  const jobId = task.provider_task_id ?? "";

  if (!jobId) {
    // Never created: retry after cooldown.
    const updatedAt = new Date(task.updated_at).getTime();
    if (Date.now() - updatedAt < RETRY_COOLDOWN_MS) return task;
    try {
      const newJobId = await createMergeJob(urls);
      await updateTask(task.id, { provider_task_id: newJobId, status: "processing", progress: 5 });
      void fireProcessOnce(task.id, newJobId);
      return (await getTask(task.id)) ?? task;
    } catch (err) {
      if (err instanceof MergerHttpError) {
        return (await updateTask(task.id, { status: "failed", error_message: err.message })) ?? task;
      }
      return task;
    }
  }

  // Processing but process was never fired (e.g. server restarted): fire it now.
  if (task.params?.processFired !== true) {
    void fireProcessOnce(task.id, jobId);
  }

  try {
    const body = await getMergeJob(jobId);
    const state = analyzeJob(body, jobId);
    if (state.status === "completed") {
      return (await updateTask(task.id, { status: "completed", progress: 100, resultUrls: state.urls })) ?? task;
    }
    if (state.status === "failed") {
      return (await updateTask(task.id, { status: "failed", error_message: state.error })) ?? task;
    }
    return (await updateTask(task.id, { progress: Math.max(task.progress, state.progress) })) ?? task;
  } catch (err) {
    if (err instanceof MergerHttpError) {
      if (err.httpStatus === 404) {
        return (
          (await updateTask(task.id, {
            status: "failed",
            error_message: "Merge job not found on the merging service (deleted or expired after 24 hours).",
          })) ?? task
        );
      }
      return (await updateTask(task.id, { status: "failed", error_message: err.message })) ?? task;
    }
    // Our network error: temporary — stay processing.
    return task;
  }
}

/** Readiness probe for /api/health (4s timeout). False when unconfigured. */
export async function mergerHealthy(): Promise<boolean> {
  if (!mergerBase()) return false;
  try {
    await mergerFetch("/api/config", { method: "GET" }, 4000);
    return true;
  } catch {
    return false;
  }
}

/** English, display-ready reply for a merge task in any state. */
export function formatMergeReply(task: TaskRow): string {
  const urls = task.resultUrls ?? [];
  if (task.status === "completed") {
    const links = urls.map((u) => `Direct link: ${u}`).join("\n");
    return (
      `✅ Clips merged successfully\n\n${links}\n\n` +
      `⚠️ The merged file is deleted from the merging service after ~24 hours — watch/download it soon.`
    );
  }
  if (task.status === "failed") {
    return `❌ Task failed: ${task.error_message ?? "Unknown error."}`;
  }
  return (
    `⏳ Task is processing — task_id: ${task.id}\n\n` +
    `Check with get_task every ~10 seconds until it completes.`
  );
}
