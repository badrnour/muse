// CometAPI adapter (api.cometapi.com).
// Images: synchronous, OpenAI-compatible
//   POST /v1/images/generations { model, prompt, size } -> { data: [{ url | b64_json }] }
// Video (Grok): async, provider-native endpoint (apidoc.cometapi.com,
//   "Create a video with Grok", updated 2026-08-21):
//   POST /grok/v1/videos { model, prompt, duration, aspect_ratio, resolution, image? }
//     -> { request_id }
//   GET  /grok/v1/videos/{request_id}  (poll until terminal)
// The poll response shape is not fully documented on that page, so checkTask
// parses it defensively (several field names / status spellings).
// Media files are never downloaded: only the result URLs are stored.

import {
  ProviderError,
  fetchJson,
  providerErrorMessage,
  type ProviderAdapter,
} from "./types";

const COMETAPI_BASE = "https://api.cometapi.com";

/** Map (aspect_ratio, resolution) to an OpenAI-style "WxH" size string. */
function imageSize(aspectRatio = "auto", resolution = "1K"): string {
  const base = resolution === "4K" ? 4096 : resolution === "2K" ? 2048 : 1024;
  const ratios: Record<string, [number, number]> = {
    "1:1": [1, 1],
    "3:2": [3, 2],
    "2:3": [2, 3],
    "4:3": [4, 3],
    "3:4": [3, 4],
    "5:4": [5, 4],
    "4:5": [4, 5],
    "16:9": [16, 9],
    "9:16": [9, 16],
    "2:1": [2, 1],
    "1:2": [1, 2],
    "21:9": [21, 9],
    "9:21": [9, 21],
    "3:1": [3, 1],
    "1:3": [1, 3],
  };
  const [w, h] = ratios[aspectRatio] ?? [1, 1];
  const scale = base / Math.max(w, h);
  return `${Math.round(w * scale)}x${Math.round(h * scale)}`;
}

const DONE_STATES = new Set(["completed", "complete", "succeeded", "success", "succeed", "done", "finished"]);
const FAILED_STATES = new Set(["failed", "failure", "error", "cancelled", "canceled"]);

function pickUrls(obj: Record<string, unknown>): string[] {
  const candidates = [
    obj.video_url,
    obj.videoUrl,
    obj.url,
    (obj.data as Record<string, unknown> | undefined)?.video_url,
    (obj.data as Record<string, unknown> | undefined)?.videoUrl,
    (obj.data as Record<string, unknown> | undefined)?.url,
  ];
  const urls = candidates.filter((u): u is string => typeof u === "string" && u.startsWith("http"));
  const data = obj.data as Record<string, unknown> | undefined;
  if (Array.isArray(data?.resultUrls)) {
    urls.push(...(data.resultUrls as unknown[]).filter((u): u is string => typeof u === "string"));
  }
  if (Array.isArray(obj.resultUrls)) {
    urls.push(...(obj.resultUrls as unknown[]).filter((u): u is string => typeof u === "string"));
  }
  return [...new Set(urls)];
}

export const cometapiAdapter: ProviderAdapter = {
  id: "cometapi",

  async createImageSync(key, model, input) {
    const { httpStatus, body } = await fetchJson(
      `${COMETAPI_BASE}/v1/images/generations`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          prompt: input.prompt,
          size: imageSize(input.aspectRatio, input.resolution),
          n: 1,
        }),
      },
      120000
    );
    const obj = (body ?? {}) as Record<string, unknown>;
    if (httpStatus !== 200) {
      throw new ProviderError(
        providerErrorMessage(body, `CometAPI image generation failed (HTTP ${httpStatus})`),
        httpStatus
      );
    }
    const data = Array.isArray(obj.data) ? obj.data : [];
    const urls: string[] = [];
    for (const item of data) {
      const entry = item as Record<string, unknown>;
      if (typeof entry.url === "string" && entry.url.startsWith("http")) urls.push(entry.url);
      else if (typeof entry.b64_json === "string") {
        // No download rule: a base64 payload is not a URL; keep the data URI
        // out of the DB and treat it as an unsupported response instead.
        throw new ProviderError("CometAPI returned base64 image data instead of a URL.");
      }
    }
    if (urls.length === 0) {
      throw new ProviderError("CometAPI returned no image URL.");
    }
    return { urls };
  },

  async createTask(key, model, input) {
    const bodyPayload: Record<string, unknown> = {
      model,
      prompt: input.prompt,
      duration: input.duration ?? 8,
      resolution: input.resolution ?? "480p",
    };
    if (input.aspectRatio && input.aspectRatio !== "auto") {
      bodyPayload.aspect_ratio = input.aspectRatio;
    }
    if (input.imageUrl) bodyPayload.image = { url: input.imageUrl };
    const { httpStatus, body } = await fetchJson(
      `${COMETAPI_BASE}/grok/v1/videos`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(bodyPayload),
      },
      60000
    );
    const obj = (body ?? {}) as Record<string, unknown>;
    const requestId =
      (typeof obj.request_id === "string" && obj.request_id) ||
      (typeof obj.id === "string" && obj.id) ||
      (typeof (obj.data as Record<string, unknown> | undefined)?.request_id === "string" &&
        ((obj.data as Record<string, unknown>).request_id as string));
    if (httpStatus !== 200 || !requestId) {
      throw new ProviderError(
        providerErrorMessage(body, `CometAPI video creation failed (HTTP ${httpStatus})`),
        httpStatus
      );
    }
    return { providerTaskId: requestId };
  },

  async checkTask(key, providerTaskId) {
    const { httpStatus, body } = await fetchJson(
      `${COMETAPI_BASE}/grok/v1/videos/${encodeURIComponent(providerTaskId)}`,
      { method: "GET", headers: { Authorization: `Bearer ${key}` } },
      30000
    );
    const obj = (body ?? {}) as Record<string, unknown>;
    if (httpStatus !== 200) {
      throw new ProviderError(
        providerErrorMessage(body, `CometAPI video status check failed (HTTP ${httpStatus})`),
        httpStatus
      );
    }
    const data = (obj.data ?? obj) as Record<string, unknown>;
    const state = String(data.status ?? data.state ?? obj.status ?? obj.state ?? "").toLowerCase();
    if (DONE_STATES.has(state)) {
      const urls = pickUrls(data);
      if (urls.length === 0) {
        return { status: "failed", error: "CometAPI reported success but returned no video URL." };
      }
      return { status: "completed", urls, progress: 100 };
    }
    if (FAILED_STATES.has(state)) {
      const err =
        (typeof data.error === "string" && data.error) ||
        (typeof data.failMsg === "string" && data.failMsg) ||
        (typeof obj.error === "string" && obj.error) ||
        "Video generation failed at CometAPI.";
      return { status: "failed", error: err };
    }
    // Still running (or an unknown non-terminal state): keep polling.
    let progress = 50;
    const raw = data.progress ?? obj.progress;
    if (typeof raw === "number") progress = raw <= 1 ? Math.round(raw * 100) : Math.round(raw);
    return { status: "processing", progress };
  },
};
