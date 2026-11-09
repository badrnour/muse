// Shared provider adapter interface.
// Every provider error is thrown as ProviderError { status, message } so the
// key-failover layer can classify it with one function (see keys.ts).

export class ProviderError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

export interface GenerationInput {
  prompt: string;
  imageUrl?: string;
  aspectRatio?: string;
  resolution?: string;
  background?: string;
  outputFormat?: string;
  enableAudio?: boolean;
  duration?: number;
}

export type CheckStatus = "processing" | "completed" | "failed";

export interface CheckResult {
  status: CheckStatus;
  urls?: string[];
  error?: string;
  progress?: number; // 0..100
}

export interface ProviderAdapter {
  readonly id: "kie" | "cometapi";
  /** Async creation (video, and some images): returns the provider task id. */
  createTask(key: string, model: string, input: GenerationInput): Promise<{ providerTaskId: string }>;
  /** Synchronous image creation when the provider supports it (CometAPI). */
  createImageSync?(key: string, model: string, input: GenerationInput): Promise<{ urls: string[] }>;
  /** Poll a running task. */
  checkTask(key: string, providerTaskId: string): Promise<CheckResult>;
}

/** Small fetch helper with a timeout. Throws ProviderError on network failure. */
export async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs = 60000
): Promise<{ httpStatus: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { httpStatus: res.status, body };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ProviderError(`Network error calling provider: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Extract a readable message from a provider error body. */
export function providerErrorMessage(body: unknown, fallback: string): string {
  if (typeof body === "string" && body.trim()) return body.trim();
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    const msg = obj.msg ?? obj.message ?? obj.error;
    if (typeof msg === "string" && msg.trim()) return msg.trim();
    if (msg && typeof msg === "object") {
      const nested = (msg as Record<string, unknown>).message;
      if (typeof nested === "string" && nested.trim()) return nested.trim();
    }
    const code = obj.code;
    if (code !== undefined) return `${fallback} (code: ${String(code)})`;
  }
  return fallback;
}
