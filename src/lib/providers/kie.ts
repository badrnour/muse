// kie.ai adapter — Jobs API (docs.kie.ai).
// Create:  POST /api/v1/jobs/createTask  { model, input } -> { code: 200, data: { taskId } }
// Poll:    GET  /api/v1/jobs/recordInfo?taskId=... -> { code: 200, data: { state, resultJson, failMsg } }
// NOTE: resultJson is a JSON *string* inside the JSON body — parse it twice.
// Media files are never downloaded: only the result URLs are stored.

import {
  ProviderError,
  fetchJson,
  providerErrorMessage,
  type CheckResult,
  type GenerationInput,
  type ProviderAdapter,
} from "./types";

const KIE_BASE = "https://api.kie.ai";

function kieInput(model: string, input: GenerationInput): Record<string, unknown> {
  const out: Record<string, unknown> = { prompt: input.prompt };
  if (input.imageUrl) out.image_url = input.imageUrl;
  if (input.aspectRatio && input.aspectRatio !== "auto") out.aspect_ratio = input.aspectRatio;
  if (input.resolution) out.resolution = input.resolution;
  if (input.background && input.background !== "auto") out.background = input.background;
  if (input.outputFormat) out.output_format = input.outputFormat;
  if (input.enableAudio !== undefined) out.enable_audio = input.enableAudio;
  if (input.duration !== undefined) out.duration = input.duration;
  void model;
  return out;
}

export const kieAdapter: ProviderAdapter = {
  id: "kie",

  async createTask(key, model, input) {
    const { httpStatus, body } = await fetchJson(
      `${KIE_BASE}/api/v1/jobs/createTask`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: kieInput(model, input) }),
      },
      // kie.ai createTask can be slow (an immediate auth rejection alone took
      // ~14s through the egress proxy), so allow a generous timeout.
      120000
    );
    const obj = (body ?? {}) as Record<string, unknown>;
    const data = (obj.data ?? {}) as Record<string, unknown>;
    // kie.ai returns HTTP 200 with the real status in the body `code`
    // (e.g. {"code":401,"msg":"Unauthorized ..."}), so classify on that.
    const providerCode = typeof obj.code === "number" ? obj.code : httpStatus;
    if (httpStatus !== 200 || obj.code !== 200 || typeof data.taskId !== "string") {
      throw new ProviderError(
        providerErrorMessage(body, `kie.ai createTask failed (HTTP ${httpStatus})`),
        providerCode
      );
    }
    return { providerTaskId: data.taskId };
  },

  async checkTask(key, providerTaskId) {
    const { httpStatus, body } = await fetchJson(
      `${KIE_BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`,
      { method: "GET", headers: { Authorization: `Bearer ${key}` } },
      30000
    );
    const obj = (body ?? {}) as Record<string, unknown>;
    const data = (obj.data ?? {}) as Record<string, unknown>;
    const providerCode = typeof obj.code === "number" ? obj.code : httpStatus;
    if (httpStatus !== 200 || obj.code !== 200) {
      throw new ProviderError(
        providerErrorMessage(body, `kie.ai recordInfo failed (HTTP ${httpStatus})`),
        providerCode
      );
    }
    const state = String(data.state ?? "");
    if (state === "success") {
      // resultJson is a JSON string: {"resultUrls": ["https://..."]}
      let urls: string[] = [];
      try {
        const parsed = typeof data.resultJson === "string" ? JSON.parse(data.resultJson) : data.resultJson;
        const raw = (parsed as Record<string, unknown>)?.resultUrls;
        if (Array.isArray(raw)) urls = raw.filter((u): u is string => typeof u === "string");
      } catch {
        urls = [];
      }
      if (urls.length === 0 && typeof data.resultUrl === "string") urls = [data.resultUrl];
      if (urls.length === 0) {
        return { status: "failed", error: "kie.ai reported success but returned no result URL." };
      }
      return { status: "completed", urls, progress: 100 };
    }
    if (state === "fail") {
      const failMsg = typeof data.failMsg === "string" ? data.failMsg : "Generation failed at kie.ai.";
      const result: CheckResult = { status: "failed", error: failMsg };
      return result;
    }
    // waiting | queuing | generating (and any unknown non-terminal state)
    const progress =
      state === "generating" ? 60 : state === "queuing" ? 25 : 10;
    return { status: "processing", progress };
  },
};
