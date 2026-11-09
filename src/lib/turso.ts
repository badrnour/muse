// Turso (libSQL over HTTP) data layer.
// One client, schema created on first access (no migrations tool needed).
// The client is created lazily so importing this module never breaks the
// build when env vars are missing — a clear error is thrown only on use.

import { createClient, type Client } from "@libsql/client";

export type TaskType = "image" | "video" | "merge";
export type TaskStatus = "pending" | "processing" | "completed" | "failed";
export type KeyStatus = "active" | "exhausted" | "disabled";
export type ProviderId = "kie" | "cometapi";

export interface TaskAttempt {
  provider: string;
  keyId?: string;
  keyLabel?: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

export interface TaskRow {
  id: string;
  provider: string | null;
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: TaskType;
  prompt: string;
  params_json: string;
  status: TaskStatus;
  progress: number;
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  // Parsed helpers (filled by the accessors below, never stored).
  resultUrls?: string[];
  attempts?: TaskAttempt[];
  params?: Record<string, unknown>;
}

export interface ApiKeyRow {
  id: string;
  provider: ProviderId;
  label: string;
  api_key: string;
  status: KeyStatus;
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

let client: Client | null = null;

function getClient(): Client {
  if (client) return client;
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) {
    throw new Error(
      "Turso is not configured: set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in .env.local (or Vercel env vars)."
    );
  }
  client = createClient({ url, authToken });
  return client;
}

const CREATE_TASKS_SQL = `CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  provider TEXT,
  provider_task_id TEXT,
  key_id TEXT,
  model TEXT NOT NULL,
  type TEXT NOT NULL,
  prompt TEXT DEFAULT '',
  params_json TEXT DEFAULT '{}',
  status TEXT NOT NULL,
  progress INTEGER DEFAULT 0,
  result_urls_json TEXT,
  error_message TEXT,
  attempts_json TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT
)`;

const CREATE_KEYS_SQL = `CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  label TEXT DEFAULT '',
  api_key TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  usage_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  fail_count INTEGER DEFAULT 0,
  last_used_at TEXT,
  last_checked_at TEXT,
  last_error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
)`;

/** Create both tables if they do not exist yet. Safe to call on every access. */
export async function ensureSchema(): Promise<void> {
  const db = getClient();
  await db.execute(CREATE_TASKS_SQL);
  await db.execute(CREATE_KEYS_SQL);
}

/** Cheap liveness probe for /api/health. */
export async function dbHealthy(): Promise<boolean> {
  try {
    await getClient().execute("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

function parseTask(row: Record<string, unknown>): TaskRow {
  const task = row as unknown as TaskRow;
  try {
    task.resultUrls = task.result_urls_json ? JSON.parse(task.result_urls_json) : [];
  } catch {
    task.resultUrls = [];
  }
  try {
    task.attempts = task.attempts_json ? JSON.parse(task.attempts_json) : [];
  } catch {
    task.attempts = [];
  }
  try {
    task.params = task.params_json ? JSON.parse(task.params_json) : {};
  } catch {
    task.params = {};
  }
  return task;
}

export async function insertTask(task: {
  id: string;
  provider?: string | null;
  provider_task_id?: string | null;
  key_id?: string | null;
  model: string;
  type: TaskType;
  prompt?: string;
  params?: Record<string, unknown>;
  status?: TaskStatus;
}): Promise<TaskRow> {
  await ensureSchema();
  const db = getClient();
  await db.execute({
    sql: `INSERT INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt, params_json, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      task.id,
      task.provider ?? null,
      task.provider_task_id ?? null,
      task.key_id ?? null,
      task.model,
      task.type,
      task.prompt ?? "",
      JSON.stringify(task.params ?? {}),
      task.status ?? "pending",
    ],
  });
  const created = await getTask(task.id);
  if (!created) throw new Error(`Failed to read back task ${task.id} after insert.`);
  return created;
}

export async function getTask(id: string): Promise<TaskRow | null> {
  const db = getClient();
  const res = await db.execute({ sql: "SELECT * FROM tasks WHERE id = ? LIMIT 1", args: [id] });
  if (res.rows.length === 0) return null;
  return parseTask(res.rows[0] as unknown as Record<string, unknown>);
}

export interface TaskPatch {
  provider?: string | null;
  provider_task_id?: string | null;
  key_id?: string | null;
  status?: TaskStatus;
  progress?: number;
  resultUrls?: string[];
  error_message?: string | null;
  /** One attempt appended to attempts_json. */
  attempt?: TaskAttempt;
  /** Replace the stored params (used by the merger to persist processFired). */
  params?: Record<string, unknown>;
}

/**
 * Partial update. Appends `attempt` to the attempts log when given and sets
 * completed_at automatically when the task reaches a terminal status.
 */
export async function updateTask(id: string, patch: TaskPatch): Promise<TaskRow | null> {
  const db = getClient();
  const current = await getTask(id);
  if (!current) return null;

  const sets: string[] = ["updated_at = datetime('now')"];
  const args: (string | number | null | Uint8Array)[] = [];
  if (patch.provider !== undefined) { sets.push("provider = ?"); args.push(patch.provider); }
  if (patch.provider_task_id !== undefined) { sets.push("provider_task_id = ?"); args.push(patch.provider_task_id); }
  if (patch.key_id !== undefined) { sets.push("key_id = ?"); args.push(patch.key_id); }
  if (patch.status !== undefined) { sets.push("status = ?"); args.push(patch.status); }
  if (patch.progress !== undefined) { sets.push("progress = ?"); args.push(patch.progress); }
  if (patch.resultUrls !== undefined) { sets.push("result_urls_json = ?"); args.push(JSON.stringify(patch.resultUrls)); }
  if (patch.error_message !== undefined) { sets.push("error_message = ?"); args.push(patch.error_message); }
  if (patch.params !== undefined) { sets.push("params_json = ?"); args.push(JSON.stringify(patch.params)); }
  if (patch.attempt) {
    const attempts = [...(current.attempts ?? []), patch.attempt];
    sets.push("attempts_json = ?");
    args.push(JSON.stringify(attempts));
  }
  if (patch.status === "completed" || patch.status === "failed") {
    sets.push("completed_at = datetime('now')");
  }
  args.push(id);
  await db.execute({ sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, args });
  return getTask(id);
}

export async function listRecentTasks(
  limit = 10,
  filter: { type?: TaskType; status?: TaskStatus } = {}
): Promise<TaskRow[]> {
  await ensureSchema();
  const db = getClient();
  const where: string[] = [];
  const args: (string | number | null)[] = [];
  if (filter.type) { where.push("type = ?"); args.push(filter.type); }
  if (filter.status) { where.push("status = ?"); args.push(filter.status); }
  const sql = `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY created_at DESC, id DESC LIMIT ?`;
  args.push(limit);
  const res = await db.execute({ sql, args });
  return res.rows.map((r) => parseTask(r as unknown as Record<string, unknown>));
}

export async function taskStats(): Promise<{
  total: number;
  completed: number;
  failed: number;
  processing: number;
}> {
  await ensureSchema();
  const db = getClient();
  const res = await db.execute(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status IN ('pending','processing') THEN 1 ELSE 0 END) AS processing
     FROM tasks`
  );
  const row = res.rows[0] as unknown as Record<string, number>;
  return {
    total: Number(row.total ?? 0),
    completed: Number(row.completed ?? 0),
    failed: Number(row.failed ?? 0),
    processing: Number(row.processing ?? 0),
  };
}
