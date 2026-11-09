// Admin dashboard (English, LTR): API key manager, live task board, and
// copy-ready MCP connection settings for ChatGPT / Claude Desktop / Cursor.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

interface ApiKeyPublic {
  id: string;
  provider: "kie" | "cometapi";
  label: string;
  maskedKey: string;
  status: "active" | "exhausted" | "disabled";
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_error: string | null;
  created_at: string;
}

interface TaskPublic {
  id: string;
  provider: string | null;
  model: string;
  type: "image" | "video" | "merge";
  prompt: string;
  status: "pending" | "processing" | "completed" | "failed";
  progress: number;
  resultUrls: string[];
  error_message: string | null;
  attempts: number;
  created_at: string;
}

interface Health {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  models: { canonical: string; type: string; providers: string[] }[];
  merger: { base: string | null; healthy: boolean };
  authRequired: boolean;
}

const TOOLS = [
  { name: "generate_image", desc: "Generate an image from a text prompt." },
  { name: "generate_video", desc: "Generate a video with native synchronized audio." },
  { name: "merge_videos", desc: "Merge several clips into one final video, in order." },
  { name: "get_task", desc: "Track any task by its id until it completes." },
  { name: "list_media", desc: "Recall previously generated media from the database." },
];

const STATUS_STYLES: Record<string, string> = {
  active: "bg-emerald-100 text-emerald-800",
  exhausted: "bg-amber-100 text-amber-800",
  disabled: "bg-slate-200 text-slate-600",
  completed: "bg-emerald-100 text-emerald-800",
  failed: "bg-red-100 text-red-800",
  processing: "bg-sky-100 text-sky-800",
  pending: "bg-slate-100 text-slate-700",
};

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700"
    >
      {copied ? "Copied ✓" : label}
    </button>
  );
}

export default function Dashboard() {
  const [health, setHealth] = useState<Health | null>(null);
  const [keys, setKeys] = useState<ApiKeyPublic[]>([]);
  const [tasks, setTasks] = useState<TaskPublic[]>([]);
  const [stats, setStats] = useState({ total: 0, completed: 0, failed: 0, processing: 0 });
  const [provider, setProvider] = useState<"kie" | "cometapi">("kie");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [keyError, setKeyError] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [tab, setTab] = useState<"chatgpt" | "claude" | "cursor">("chatgpt");
  const [mcpUrl, setMcpUrl] = useState("");

  useEffect(() => {
    setMcpUrl(`${window.location.origin}/mcp`);
  }, []);

  const loadAll = useCallback(async () => {
    try {
      const [h, k, t] = await Promise.all([
        fetch("/api/health").then((r) => r.json() as Promise<Health>),
        fetch("/api/keys").then((r) => r.json()),
        fetch("/api/tasks?limit=20").then((r) => r.json()),
      ]);
      setHealth(h);
      if (Array.isArray(k.keys)) setKeys(k.keys);
      if (Array.isArray(t.tasks)) setTasks(t.tasks);
      if (t.stats) setStats(t.stats);
    } catch {
      // Transient fetch failure — the next poll retries.
    }
  }, []);

  useEffect(() => {
    void loadAll();
    const timer = setInterval(() => void loadAll(), 5000);
    return () => clearInterval(timer);
  }, [loadAll]);

  const addKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setKeyError("");
    setKeyBusy(true);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKey, label }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to add key.");
      setApiKey("");
      setLabel("");
      await loadAll();
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : "Failed to add key.");
    } finally {
      setKeyBusy(false);
    }
  };

  const setStatus = async (id: string, status: "active" | "disabled") => {
    await fetch(`/api/keys/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    await loadAll();
  };

  const removeKey = async (id: string) => {
    if (!confirm("Delete this API key?")) return;
    await fetch(`/api/keys/${id}`, { method: "DELETE" });
    await loadAll();
  };

  const connectJson = useMemo(() => {
    const server: Record<string, unknown> = { url: mcpUrl || "<YOUR_DEPLOYED_URL>/mcp" };
    if (health?.authRequired) {
      server.headers = { Authorization: "Bearer <YOUR_MCP_ACCESS_TOKEN>" };
    }
    if (tab === "claude") {
      return JSON.stringify(
        { mcpServers: { "media-generator": { type: "http", ...server } } },
        null,
        2
      );
    }
    return JSON.stringify({ mcpServers: { "media-generator": server } }, null, 2);
  }, [tab, mcpUrl, health?.authRequired]);

  const dbConnected = health?.database === "turso-connected";

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">MCP Media Generator</h1>
          <p className="mt-1 text-sm text-slate-600">
            AI image &amp; video generation (kie.ai + CometAPI) with video merging — sequential
            key failover, links only, nothing downloaded to the server.
          </p>
        </div>
        <div className="flex gap-2">
          <span
            className={`rounded-full px-3 py-1 text-xs font-semibold ${
              dbConnected ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-800"
            }`}
          >
            {health ? (dbConnected ? "● Turso connected" : "● Turso disconnected") : "Checking…"}
          </span>
          <span
            className={`rounded-full px-3 py-1 text-xs font-semibold ${
              health?.merger.healthy ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"
            }`}
          >
            {health ? (health.merger.healthy ? "● Merger ready" : "● Merger not configured") : "Checking…"}
          </span>
        </div>
      </header>

      {/* (A) API key manager */}
      <section className="mb-8 rounded-xl border bg-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold">API Keys</h2>
        <p className="mt-1 text-sm text-slate-600">
          Add several keys per provider — keys are tried sequentially (first added, then the
          next, then the next) with automatic instant failover on any error or exhausted
          balance, without stopping the task.
        </p>
        <form onSubmit={addKey} className="mt-4 flex flex-wrap items-end gap-3">
          <label className="flex flex-col text-sm font-medium">
            Provider
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value as "kie" | "cometapi")}
              className="mt-1 rounded-md border px-3 py-2"
            >
              <option value="kie">kie.ai</option>
              <option value="cometapi">CometAPI</option>
            </select>
          </label>
          <label className="flex flex-col text-sm font-medium">
            Label (optional)
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Main account"
              className="mt-1 rounded-md border px-3 py-2"
            />
          </label>
          <label className="flex grow flex-col text-sm font-medium">
            API key
            <input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Paste the key here"
              className="mt-1 rounded-md border px-3 py-2"
              required
            />
          </label>
          <button
            type="submit"
            disabled={keyBusy}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
          >
            {keyBusy ? "Adding…" : "Add key"}
          </button>
        </form>
        {keyError && <p className="mt-2 text-sm text-red-600">{keyError}</p>}

        <div className="mt-5 space-y-3">
          {keys.length === 0 && (
            <p className="text-sm text-slate-500">
              No keys yet. Add at least one kie.ai or CometAPI key to enable generation.
            </p>
          )}
          {keys.map((k) => (
            <div key={k.id} className="flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3">
              <span className="font-mono text-sm">{k.maskedKey}</span>
              <span className="text-sm font-medium">{k.provider}</span>
              {k.label && <span className="text-sm text-slate-500">({k.label})</span>}
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_STYLES[k.status]}`}>
                {k.status}
              </span>
              <span className="text-xs text-slate-500">
                used {k.usage_count} · ✓ {k.success_count} · ✗ {k.fail_count}
              </span>
              {k.last_error && (
                <span className="w-full truncate text-xs text-red-600" title={k.last_error}>
                  Last error: {k.last_error}
                </span>
              )}
              <span className="ml-auto flex gap-2">
                {k.status === "disabled" ? (
                  <button
                    onClick={() => void setStatus(k.id, "active")}
                    className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-slate-50"
                  >
                    Enable
                  </button>
                ) : (
                  <button
                    onClick={() => void setStatus(k.id, "disabled")}
                    className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-slate-50"
                  >
                    Disable
                  </button>
                )}
                <button
                  onClick={() => void removeKey(k.id)}
                  className="rounded-md border border-red-200 px-3 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                >
                  Delete
                </button>
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* (B) Task board */}
      <section className="mb-8 rounded-xl border bg-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold">Tasks</h2>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ["Total", stats.total],
            ["Completed", stats.completed],
            ["Failed", stats.failed],
            ["Running", stats.processing],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg bg-slate-50 px-4 py-3 text-center">
              <div className="text-2xl font-bold">{value}</div>
              <div className="text-xs text-slate-500">{label}</div>
            </div>
          ))}
        </div>
        <div className="mt-5 space-y-3">
          {tasks.length === 0 && (
            <p className="text-sm text-slate-500">No tasks yet. Generate something from your MCP client.</p>
          )}
          {tasks.map((t) => (
            <div key={t.id} className="rounded-lg border px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-semibold uppercase">{t.type}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_STYLES[t.status]}`}>
                  {t.status}
                </span>
                <span className="font-mono text-xs text-slate-500">{t.id.slice(0, 8)}…</span>
                <span className="text-xs text-slate-500">{t.model}</span>
                <span className="ml-auto text-xs text-slate-400">
                  {new Date(t.created_at + "Z").toLocaleString()}
                </span>
              </div>
              <p className="mt-1 truncate text-sm text-slate-700">{t.prompt}</p>
              <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-100">
                <div
                  className={`h-full ${t.status === "failed" ? "bg-red-400" : "bg-sky-500"}`}
                  style={{ width: `${t.status === "completed" ? 100 : t.progress}%` }}
                />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                <span className="text-slate-500">Attempts: {t.attempts}</span>
                {t.resultUrls.map((u) => (
                  <a
                    key={u}
                    href={u}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-md bg-emerald-600 px-2 py-1 font-medium text-white hover:bg-emerald-500"
                  >
                    Open result ↗
                  </a>
                ))}
                {t.status === "failed" && t.error_message && (
                  <span className="text-red-600">{t.error_message}</span>
                )}
              </div>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-slate-400">Auto-refreshes every ~5 seconds.</p>
      </section>

      {/* (C) Connect your server */}
      <section className="rounded-xl border bg-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold">Connect your server</h2>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <code className="grow rounded-md bg-slate-100 px-3 py-2 font-mono text-sm">
            {mcpUrl || "Loading…"}
          </code>
          <CopyButton text={mcpUrl} label="Copy MCP URL" />
        </div>

        <div className="mt-5 flex gap-2">
          {(
            [
              ["chatgpt", "ChatGPT / GPT Agents"],
              ["claude", "Claude Desktop"],
              ["cursor", "Cursor / Windsurf / Cline"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                tab === id ? "bg-slate-900 text-white" : "bg-slate-100 hover:bg-slate-200"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-slate-900 p-4 font-mono text-xs text-emerald-200">
          {connectJson}
        </pre>
        <div className="mt-2 flex items-start justify-between gap-3">
          <p className="text-xs text-slate-500">
            {tab === "chatgpt" &&
              "In ChatGPT: Settings → Connectors → Create → Custom MCP server, and paste the URL into “Server URL”."}
            {tab === "claude" && "Add this to claude_desktop_config.json under mcpServers."}
            {tab === "cursor" && "Add this to your mcp.json (Cursor / Windsurf / Cline)."}
            {health?.authRequired && " Include the Authorization header with your MCP access token."}
          </p>
          <CopyButton text={connectJson} label="Copy JSON" />
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          {TOOLS.map((t) => (
            <span key={t.name} className="rounded-full bg-slate-100 px-3 py-1 text-xs" title={t.desc}>
              <code className="font-semibold">{t.name}</code> — {t.desc}
            </span>
          ))}
        </div>
        <p className="mt-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Video takes minutes: the server returns a task_id right away, and it is followed
          automatically with get_task every 10 seconds — when the task completes, the link is
          shown in the chat and polling stops. Live progress is streamed during the wait so the
          operation does not time out.
        </p>
      </section>

      <footer className="mt-8 text-center text-xs text-slate-400">
        MCP Media Generator v1.2.0 · MCP endpoint: <code>/mcp</code> · Health: <code>/api/health</code>
      </footer>
    </main>
  );
}
