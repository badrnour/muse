// Provider registry: one adapter per provider id.

import type { ProviderAdapter } from "./types";
import type { ProviderId } from "../turso";
import { kieAdapter } from "./kie";
import { cometapiAdapter } from "./cometapi";

export type { ProviderId } from "../turso";

const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  kie: kieAdapter,
  cometapi: cometapiAdapter,
};

export function getAdapter(provider: ProviderId): ProviderAdapter {
  return ADAPTERS[provider];
}
