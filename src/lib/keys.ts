// Sequential multi-key failover system — the heart of the project.
//
// RULES (never break them):
// 1. Keys are tried in STRICT insertion order (created_at ASC, id ASC).
//    This is deliberate: it is NOT round-robin and NOT "least used first".
// 2. An exhausted key STAYS in the pool and in the database — only a manual
//    disable from the dashboard removes a key from rotation.
// 3. The AI client never sees key/balance errors — failover is silent.

import { createClient } from "@libsql/client";
import type { ApiKeyRow, KeyStatus, ProviderId } from "./turso";

export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

function getClient() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) {
    throw new Error(
      "Turso is not configured: set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in .env.local (or Vercel env vars)."
    );
  }
  return createClient({ url, authToken });
}

/** Never return a full key in any response or log. */
export function maskKey(key: string): string {
  if (!key) return "••••";
  if (key.length <= 7) return `${key.slice(0, 3)}••••`;
  return `${key.slice(0, 7)}••••••••${key.slice(-4)}`;
}

const EXHAUSTED_PATTERNS =
  /insufficient|quota|balance|out of credits|out-of-credits|exhausted|no credit|credit limit|充值|余额不足/;
const DISABLED_PATTERNS =
  /invalid api key|invalid_api_key|unauthorized|unauthenticated|forbidden|authentication|api key not valid|incorrect api key/;
const PROVIDER_PATTERNS = /model not found|unsupported model|model_not_found|unknown model|does not exist/;

/**
 * Classify a provider error into one action bucket.
 * IMPORTANT: exhausted patterns are checked BEFORE the 400 branch, because
 * some providers report "out of credits" with HTTP 400.
 */
export function classifyProviderError(status: number | undefined, message: string): ErrorClass {
  const msg = (message || "").toLowerCase();
  if (EXHAUSTED_PATTERNS.test(msg)) return "exhausted";
  if (status === 402) return "exhausted";
  if (status === 401 || status === 403 || DISABLED_PATTERNS.test(msg)) return "disabled";
  if ((status === 400 || status === 404 || status === 422) && PROVIDER_PATTERNS.test(msg)) {
    return "provider";
  }
  if (status === 400 || status === 422) return "params";
  // 429, 5xx, network errors, timeouts, aborts — temporary, key stays healthy.
  return "temporary";
}

/** Does a provider failure message look like a key/balance problem? */
export function isKeyOrBalanceError(message: string): boolean {
  const msg = (message || "").toLowerCase();
  return (
    EXHAUSTED_PATTERNS.test(msg) ||
    DISABLED_PATTERNS.test(msg) ||
    /\b402\b|\b401\b|unauthorized/.test(msg)
  );
}

/**
 * All non-disabled keys for these providers, in STRICT insertion order.
 * First added = tried first.
 */
export async function getKeyPool(providers: ProviderId[]): Promise<ApiKeyRow[]> {
  const db = getClient();
  if (providers.length === 0) return [];
  const placeholders = providers.map(() => "?").join(", ");
  const res = await db.execute({
    sql: `SELECT * FROM api_keys
          WHERE status != 'disabled' AND provider IN (${placeholders})
          ORDER BY created_at ASC, id ASC`,
    args: [...providers],
  });
  return res.rows as unknown as ApiKeyRow[];
}

export async function listAllKeys(): Promise<ApiKeyRow[]> {
  const db = getClient();
  const res = await db.execute({
    sql: "SELECT * FROM api_keys ORDER BY created_at ASC, id ASC",
    args: [],
  });
  return res.rows as unknown as ApiKeyRow[];
}

export async function getKeyById(id: string): Promise<ApiKeyRow | null> {
  const db = getClient();
  const res = await db.execute({ sql: "SELECT * FROM api_keys WHERE id = ? LIMIT 1", args: [id] });
  return (res.rows[0] as unknown as ApiKeyRow) ?? null;
}

/** Reject duplicates for the same provider (same key value twice). */
export async function addKey(provider: ProviderId, apiKey: string, label = ""): Promise<ApiKeyRow> {
  const db = getClient();
  const dup = await db.execute({
    sql: "SELECT id FROM api_keys WHERE provider = ? AND api_key = ? LIMIT 1",
    args: [provider, apiKey],
  });
  if (dup.rows.length > 0) {
    throw new Error(`This key is already registered for ${provider}.`);
  }
  const id = crypto.randomUUID();
  await db.execute({
    sql: "INSERT INTO api_keys (id, provider, label, api_key, status) VALUES (?, ?, ?, ?, 'active')",
    args: [id, provider, label, apiKey],
  });
  const created = await getKeyById(id);
  if (!created) throw new Error("Failed to read back the new key.");
  return created;
}

export async function setKeyStatus(
  id: string,
  status: KeyStatus,
  lastError?: string | null
): Promise<ApiKeyRow | null> {
  const db = getClient();
  await db.execute({
    sql: "UPDATE api_keys SET status = ?, last_error = ?, last_checked_at = datetime('now') WHERE id = ?",
    args: [status, lastError ?? null, id],
  });
  return getKeyById(id);
}

export async function deleteKey(id: string): Promise<boolean> {
  const db = getClient();
  const res = await db.execute({ sql: "DELETE FROM api_keys WHERE id = ?", args: [id] });
  return (res.rowsAffected ?? 0) > 0;
}

/** Update usage counters after every attempt (success or failure). */
export async function recordKeyAttempt(
  id: string,
  ok: boolean,
  errorClass?: ErrorClass,
  error?: string
): Promise<void> {
  const db = getClient();
  await db.execute({
    sql: `UPDATE api_keys
          SET usage_count = usage_count + 1,
              success_count = success_count + ?,
              fail_count = fail_count + ?,
              last_used_at = datetime('now'),
              last_checked_at = datetime('now'),
              last_error = ?
          WHERE id = ?`,
    args: [ok ? 1 : 0, ok ? 0 : 1, ok ? null : (error ?? errorClass ?? "unknown error"), id],
  });
}

/** Apply the failover action for a classified error. Returns the new status (if changed). */
export async function applyErrorClass(
  key: ApiKeyRow,
  errorClass: ErrorClass,
  error: string
): Promise<void> {
  await recordKeyAttempt(key.id, false, errorClass, error);
  if (errorClass === "disabled") {
    await setKeyStatus(key.id, "disabled", error);
  } else if (errorClass === "exhausted") {
    await setKeyStatus(key.id, "exhausted", error);
  }
  // "provider" / "params" / "temporary": key stays as-is.
}
