// Generation orchestrator: sequential key failover + wait window + refresh.
// The AI client NEVER sees key/balance errors: failover is silent, the task
// keeps the same task_id, and a task that fails on every key stays
// "processing" ("Waiting for a valid key…") and is retried on each get_task
// after a ~45s cooldown — so topping up any key completes it by itself.

import {
  getTask,
  insertTask,
  updateTask,
  type ApiKeyRow,
  type TaskRow,
} from "./turso";
import {
  applyErrorClass,
  classifyProviderError,
  getKeyPool,
  isKeyOrBalanceError,
  recordKeyAttempt,
  type ErrorClass,
} from "./keys";
import { providerModelFor, resolveModel, type ModelDef } from "./models";
import { getAdapter } from "./providers";
import { ProviderError, type GenerationInput } from "./providers/types";
import { refreshMergeTask } from "./merger";

export interface GenerationRequest extends GenerationInput {
  type: "image" | "video";
  model: string;
  waitSeconds?: number;
}

export type ProgressNotify = (progress: number, message: string) => Promise<void> | void;

export type GenerationOutcome = "completed" | "processing" | "failed" | "no_keys";

export interface GenerationResult {
  outcome: GenerationOutcome;
  task: TaskRow | null;
  /** User-facing English message (never mentions keys or balances). */
  message: string;
}

const RETRY_COOLDOWN_MS = 45_000;
const POLL_INTERVAL_MS = 3000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function noKeysMessage(model: string): string {
  return `❌ No active keys available for ${model}. Add at least one key from the admin dashboard, then try again.`;
}

function attemptRecord(
  key: ApiKeyRow,
  ok: boolean,
  errorClass?: ErrorClass,
  error?: string
) {
  return {
    provider: key.provider,
    keyId: key.id,
    keyLabel: key.label || key.provider,
    ok,
    errorClass,
    error,
    at: new Date().toISOString(),
  };
}

/**
 * Try to create the provider job with keys in order, starting at fromIndex.
 * Returns the key that succeeded (or null) plus a terminal failure message
 * when the request itself was invalid (params error — switching keys cannot fix it).
 */
async function tryCreateFrom(
  task: TaskRow,
  def: ModelDef,
  pool: ApiKeyRow[],
  fromIndex: number,
  input: GenerationInput
): Promise<{ keyIndex: number; key?: ApiKeyRow; terminalFailure?: string }> {
  for (let i = fromIndex; i < pool.length; i++) {
    const key = pool[i];
    const adapter = getAdapter(key.provider);
    const providerModel = providerModelFor(def, key.provider);
    try {
      // Synchronous image path when the provider supports it (CometAPI).
      if (task.type === "image" && adapter.createImageSync) {
        const { urls } = await adapter.createImageSync(key.api_key, providerModel, input);
        await recordKeyAttempt(key.id, true);
        await updateTask(task.id, {
          provider: key.provider,
          key_id: key.id,
          status: "completed",
          progress: 100,
          resultUrls: urls,
          attempt: attemptRecord(key, true),
        });
        return { keyIndex: i, key };
      }
      const { providerTaskId } = await adapter.createTask(key.api_key, providerModel, input);
      await recordKeyAttempt(key.id, true);
      await updateTask(task.id, {
        provider: key.provider,
        provider_task_id: providerTaskId,
        key_id: key.id,
        status: "processing",
        progress: 5,
        attempt: attemptRecord(key, true),
      });
      return { keyIndex: i, key };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = err instanceof ProviderError ? err.status : undefined;
      const errorClass = classifyProviderError(status, message);
      await applyErrorClass(key, errorClass, message);
      await updateTask(task.id, { attempt: attemptRecord(key, false, errorClass, message) });
      if (errorClass === "params") {
        // A params error will fail on every key — stop immediately.
        await updateTask(task.id, {
          status: "failed",
          error_message: message,
        });
        return { keyIndex: -1, terminalFailure: message };
      }
      // disabled / exhausted / provider / temporary: try the next key.
    }
  }
  return { keyIndex: -1 };
}

/** Poll a running provider job once; returns the refreshed task. */
async function pollOnce(task: TaskRow): Promise<TaskRow> {
  if (!task.provider_task_id || !task.provider || !task.key_id) return task;
  const adapter = getAdapter(task.provider as "kie" | "cometapi");
  // The key may have been rotated; fetch the current key row from the pool.
  const pool = await getKeyPool([task.provider as "kie" | "cometapi"]);
  const key = pool.find((k) => k.id === task.key_id) ?? pool[0];
  if (!key) return task;
  try {
    const res = await adapter.checkTask(key.api_key, task.provider_task_id);
    if (res.status === "completed") {
      return (
        (await updateTask(task.id, {
          status: "completed",
          progress: 100,
          resultUrls: res.urls ?? [],
        })) ?? task
      );
    }
    if (res.status === "failed") {
      // Key/balance-flavored failure mid-task: recreate on the next key.
      if (res.error && isKeyOrBalanceError(res.error)) {
        return recreateOnNextKey(task, key);
      }
      return (
        (await updateTask(task.id, {
          status: "failed",
          error_message: res.error ?? "Generation failed.",
        })) ?? task
      );
    }
    return (
      (await updateTask(task.id, { progress: res.progress ?? task.progress })) ?? task
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof ProviderError ? err.status : undefined;
    const errorClass = classifyProviderError(status, message);
    if (errorClass === "disabled" || errorClass === "exhausted") {
      await applyErrorClass(key, errorClass, message);
      return recreateOnNextKey(task, key);
    }
    if (errorClass === "params") {
      return (
        (await updateTask(task.id, { status: "failed", error_message: message })) ?? task
      );
    }
    // Temporary (429/5xx/network): keep polling, key stays healthy.
    return task;
  }
}

/**
 * Recreate the SAME task (same task_id) on the next key after `failedKey`.
 * If every key fails, the task stays "processing" with an internal note and
 * will be retried on the next get_task after the cooldown.
 */
async function recreateOnNextKey(task: TaskRow, failedKey: ApiKeyRow): Promise<TaskRow> {
  const def = resolveModel(task.model);
  if (!def) return task;
  const pool = await getKeyPool(def.providers);
  const failedIndex = pool.findIndex((k) => k.id === failedKey.id);
  const input = { ...(task.params ?? {}), prompt: task.prompt } as GenerationInput;
  const res = await tryCreateFrom(task, def, pool, failedIndex + 1, input);
  if (res.keyIndex === -1 && res.terminalFailure) {
    return (await getTask(task.id)) ?? task;
  }
  if (res.keyIndex === -1) {
    await updateTask(task.id, {
      status: "processing",
      error_message: "Waiting for a valid key…",
    });
  }
  return (await getTask(task.id)) ?? task;
}

export async function runGeneration(
  req: GenerationRequest,
  notify?: ProgressNotify
): Promise<GenerationResult> {
  const def = resolveModel(req.model);
  if (!def) {
    return {
      outcome: "failed",
      task: null,
      message: `❌ Unknown model: ${req.model}. Available models: gpt-image-2-6/flare-text-to-image, grok-imagine-video-1-5-preview.`,
    };
  }
  if (def.type !== req.type) {
    return {
      outcome: "failed",
      task: null,
      message: `❌ Model ${def.canonical} generates ${def.type}, not ${req.type}.`,
    };
  }

  const pool = await getKeyPool(def.providers);
  if (pool.length === 0) {
    return { outcome: "no_keys", task: null, message: noKeysMessage(def.canonical) };
  }

  const waitSeconds = Math.min(240, Math.max(0, req.waitSeconds ?? (req.type === "image" ? 90 : 25)));
  const input: GenerationInput = {
    prompt: req.prompt,
    imageUrl: req.imageUrl,
    aspectRatio: req.aspectRatio,
    resolution: req.resolution,
    background: req.background,
    outputFormat: req.outputFormat,
    enableAudio: req.enableAudio,
    duration: req.duration,
  };

  // Record the task BEFORE any external call, so it stays traceable even if
  // the network drops mid-flight.
  const taskId = crypto.randomUUID();
  let task = await insertTask({
    id: taskId,
    model: def.canonical,
    type: req.type,
    prompt: req.prompt,
    params: { ...input, waitSeconds },
    status: "pending",
  });

  const created = await tryCreateFrom(task, def, pool, 0, input);
  task = (await getTask(taskId)) ?? task;
  if (created.keyIndex === -1) {
    if (created.terminalFailure) {
      return { outcome: "failed", task, message: `❌ Task failed: ${created.terminalFailure}` };
    }
    // Every key failed: stay "processing", retry on the next get_task.
    await updateTask(taskId, { status: "processing", error_message: "Waiting for a valid key…" });
    task = (await getTask(taskId)) ?? task;
    return { outcome: "processing", task, message: formatTaskReply(task) };
  }
  if (task.status === "completed") {
    return { outcome: "completed", task, message: formatTaskReply(task) };
  }

  // Wait window: poll every 3s, stream live progress.
  const deadline = Date.now() + waitSeconds * 1000;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await sleep(Math.min(POLL_INTERVAL_MS, remaining));
    const before = task.status;
    task = await pollOnce(task);
    if (task.status === "completed") {
      return { outcome: "completed", task, message: formatTaskReply(task) };
    }
    if (task.status === "failed") {
      return { outcome: "failed", task, message: `❌ Task failed: ${task.error_message ?? "Unknown error."}` };
    }
    if (notify && before === "processing") {
      const elapsed = waitSeconds * 1000 - remaining;
      const progress = Math.min(95, Math.max(task.progress, Math.round((elapsed / (waitSeconds * 1000)) * 90)));
      await notify(progress, `Generating… ${progress}%`);
    }
    // If the job was recreated on a new key mid-wait, pollOnce already
    // updated the task; keep looping until the window ends.
  }
  task = (await getTask(taskId)) ?? task;
  return { outcome: "processing", task, message: formatTaskReply(task) };
}

/**
 * Refresh any task from its provider (or the merge service) and return it.
 * Used by get_task. Retries creation for never-created tasks after cooldown.
 */
export async function refreshTask(taskId: string): Promise<TaskRow | null> {
  let task = await getTask(taskId);
  if (!task) return null;
  if (task.status === "completed" || task.status === "failed") return task;

  if (task.type === "merge") {
    return refreshMergeTask(task);
  }

  if (!task.provider_task_id) {
    // Never created (all keys failed at creation): retry after cooldown.
    const updatedAt = new Date(task.updated_at).getTime();
    if (Date.now() - updatedAt < RETRY_COOLDOWN_MS) return task;
    const def = resolveModel(task.model);
    if (!def) return task;
    const pool = await getKeyPool(def.providers);
    if (pool.length === 0) return task;
    const input = { ...(task.params ?? {}), prompt: task.prompt } as GenerationInput;
    const created = await tryCreateFrom(task, def, pool, 0, input);
    task = (await getTask(taskId)) ?? task;
    if (created.keyIndex === -1 && !created.terminalFailure) {
      await updateTask(taskId, { status: "processing", error_message: "Waiting for a valid key…" });
      task = (await getTask(taskId)) ?? task;
    }
    if (created.keyIndex >= 0) {
      task = await pollOnce(task);
    }
    return task;
  }

  return pollOnce(task);
}

/** English, display-ready reply for a task in any state. */
export function formatTaskReply(task: TaskRow): string {
  const urls = task.resultUrls ?? [];
  if (task.status === "completed") {
    const links = urls.map((u) => `Direct link: ${u}`).join("\n");
    if (task.type === "image") {
      const first = urls[0] ?? "";
      return `✅ Image generated successfully\n\n![image](${first})\n\n${links}`;
    }
    if (task.type === "merge") {
      return (
        `✅ Clips merged successfully\n\n${links}\n\n` +
        `⚠️ The merged file is deleted from the merging service after ~24 hours — watch/download it soon.`
      );
    }
    return `✅ Video generated successfully\n\n${links}`;
  }
  if (task.status === "failed") {
    return `❌ Task failed: ${task.error_message ?? "Unknown error."}`;
  }
  return (
    `⏳ Task is processing — task_id: ${task.id}\n\n` +
    `Check with get_task every ~10 seconds until it completes.`
  );
}
