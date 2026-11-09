// Model registry: canonical names the MCP client sees, aliases we accept,
// and the exact model string each provider expects.
// Names can be overridden with env vars if a provider renames a model.

import type { ProviderId } from "./turso";

export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  /** Name the MCP client sees. */
  canonical: string;
  /** Alternative spellings we accept and normalize (dots vs dashes). */
  aliases: string[];
  type: MediaType;
  /** Providers that can serve it — all of their keys are tried in order. */
  providers: ProviderId[];
  /** Model string sent to each provider. */
  providerModel: Record<ProviderId, string>;
}

export const IMAGE_MODEL_CANONICAL = "gpt-image-2-6/flare-text-to-image";
export const VIDEO_MODEL_CANONICAL = "grok-imagine-video-1-5-preview";

function envOr(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : fallback;
}

export const MODELS: ModelDef[] = [
  {
    canonical: IMAGE_MODEL_CANONICAL,
    aliases: ["gpt-image-2.6/flare-text-to-image", "gpt-image-2.6-flare-text-to-image"],
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: {
      kie: envOr("KIE_IMAGE_MODEL", "gpt-image-2-6/flare-text-to-image"),
      cometapi: envOr("COMETAPI_IMAGE_MODEL", "gpt-image-2.6-flare-text-to-image"),
    },
  },
  {
    canonical: VIDEO_MODEL_CANONICAL,
    aliases: ["grok-imagine-video-1.5-preview"],
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: {
      kie: envOr("KIE_VIDEO_MODEL", "grok-imagine-video-1-5-preview"),
      // NOTE: CometAPI's public docs list the Grok model ID as
      // "grok-imagine-video-1.5" (see apidoc.cometapi.com, "Create a video
      // with Grok"). The spec pins "grok-imagine-video-1-5-preview" for both
      // providers, so that is the default; if CometAPI rejects it with
      // "model not found", set COMETAPI_VIDEO_MODEL=grok-imagine-video-1.5.
      cometapi: envOr("COMETAPI_VIDEO_MODEL", "grok-imagine-video-1-5-preview"),
    },
  },
];

/** Normalize a model name for comparison: lowercase, dots become dashes. */
function normalizeModelName(name: string): string {
  return name.trim().toLowerCase().replace(/\./g, "-");
}

/** Resolve any accepted spelling to its canonical definition, or null. */
export function resolveModel(name: string | undefined | null): ModelDef | null {
  if (!name) return null;
  const wanted = normalizeModelName(name);
  for (const def of MODELS) {
    if (normalizeModelName(def.canonical) === wanted) return def;
    if (def.aliases.some((a) => normalizeModelName(a) === wanted)) return def;
    // Also accept the provider-side spellings (e.g. cometapi's dotted form).
    if (Object.values(def.providerModel).some((m) => normalizeModelName(m) === wanted)) {
      return def;
    }
  }
  return null;
}

export function providerModelFor(def: ModelDef, provider: ProviderId): string {
  return def.providerModel[provider];
}
