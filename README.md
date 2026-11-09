# MCP Media Generator

An AI media-generation MCP server with video merging — one Next.js app (App Router + TypeScript + Tailwind) that exposes 5 MCP tools and an English LTR admin dashboard.

- **Generate images** with `gpt-image-2-6/flare-text-to-image`
- **Generate videos with native synchronized audio** with `grok-imagine-video-1-5-preview`
- **Merge clips** into one final video (Video Merger API v2)
- **Sequential multi-key failover**: keys are tried in strict insertion order; on any error or exhausted balance the same task silently continues on the next key under the same `task_id` — the AI client never sees key/balance errors
- **Links only**: no media file is ever downloaded to the server; only result URLs are stored in Turso

## Project layout

```
src/lib/turso.ts        Turso (libSQL over HTTP) layer + schema + task/key queries
src/lib/keys.ts         Sequential key pool, error classification, masking, counters
src/lib/models.ts       Model registry (canonical names, aliases, env overrides)
src/lib/providers/      kie.ai + CometAPI adapters (createTask / createImageSync / checkTask)
src/lib/generation.ts   Generation orchestrator: failover, wait window, get_task refresh
src/lib/merger.ts       Video Merger API v2 client (create/process/poll, once-only process)
src/lib/mcp-server.ts   The 5 MCP tools (McpServer + zod schemas, English replies)
src/app/mcp/route.ts    Streamable HTTP MCP endpoint (Web Standard transport)
src/app/api/health/     Health: Turso status, merger readiness, models, auth flag
src/app/api/keys/       Key CRUD (keys always masked in responses)
src/app/api/tasks/      Recent tasks + stats for the dashboard
src/app/page.tsx        Admin dashboard (keys, live task board, connect settings)
```

## Run locally

```bash
npm install
cp .env.example .env.local   # then fill in the real values
npm run dev                  # or: npm run build && npm run start
```

Open http://localhost:3000 for the dashboard. The MCP endpoint is `http://localhost:3000/mcp`.

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `TURSO_DATABASE_URL` | Yes | e.g. `libsql://<db>-<org>.turso.io` |
| `TURSO_AUTH_TOKEN` | Yes | Turso token with write access |
| `MERGER_API_BASE` | For merging | Video Merger API v2 base URL (no keys/auth). Without it, `merge_videos` returns a clear "not configured" error and everything else keeps working. |
| `MCP_ACCESS_TOKEN` | No | When set, `/mcp` requires `Authorization: Bearer <token>`. |
| `KIE_IMAGE_MODEL` / `KIE_VIDEO_MODEL` | No | Override model names sent to kie.ai. |
| `COMETAPI_IMAGE_MODEL` / `COMETAPI_VIDEO_MODEL` | No | Override model names sent to CometAPI. |

Create a free Turso database:

```bash
turso db create <name>
turso db show <name> --url
turso db tokens create <name>
```

`.env*` is git-ignored from day one — never commit secrets.

## Deploy on Vercel

1. Push this repo to GitHub (see below).
2. In Vercel: **Add New → Project → Import** the repo.
3. **Settings → Environment Variables**: add `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `MERGER_API_BASE` (and optionally `MCP_ACCESS_TOKEN`).
4. **Deploy**. No local files are used: libSQL connects over HTTP and `/mcp` streams over HTTP.

## Add API keys

Use the dashboard (**API Keys** section) or the API:

```bash
curl -X POST http://localhost:3000/api/keys \
  -H 'Content-Type: application/json' \
  -d '{"provider":"kie","api_key":"<YOUR_KIE_KEY>","label":"Main account"}'
```

Keys are stored in Turso (`api_keys` table), tried in insertion order, and always shown masked (`b6cb2ab••••••••f022`). Add several keys per provider — failover is automatic.

## Connect an MCP client

In the dashboard, **Connect your server** shows copy-ready JSON for ChatGPT / Claude Desktop / Cursor / Windsurf / Cline. The server URL is `<your-deployment>/mcp`. If `MCP_ACCESS_TOKEN` is set, include the `Authorization` header shown there.

## MCP tools

| Tool | What it does |
|---|---|
| `generate_image` | Image from a prompt; returns the URL, or a `task_id` to poll. |
| `generate_video` | Video with synchronized audio (optional image-to-video); returns a `task_id`. |
| `merge_videos` | Merge 2–10 clips (`urls` or `task_ids`) into one video. Merged files expire after ~24h. |
| `get_task` | Poll any task every ~10s until `completed` (URLs) or `failed`. |
| `list_media` | Latest stored media with URLs (no regeneration). |

## Test it (curl)

```bash
# Health
curl -s http://localhost:3000/api/health

# Initialize an MCP session
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl-test","version":"1.0"}}}'
# -> copy the mcp-session-id response header, then:
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H 'mcp-session-id: <SESSION_ID>' \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -H 'mcp-session-id: <SESSION_ID>' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

Full test results (real e2e runs against kie.ai): see [TEST-REPORT.md](./TEST-REPORT.md).

## Push to GitHub

The repo remote is `https://github.com/badrnour/muse.git` (empty repo, no commits yet). To push this project for the first time:

```bash
cd ~/workspace/mcp-media-generator
git add -A
git status            # verify .env.local is NOT listed (it is git-ignored)
git commit -m "Initial commit: MCP Media Generator v1.2.0"
git push -u origin main
```

If `git push` asks for credentials, use your GitHub username and a **Personal Access Token** (classic) with `repo` scope as the password — never paste the token into a file. To push with a token without storing it:

```bash
git push https://<YOUR_GITHUB_TOKEN>@github.com/badrnour/muse.git main
```

(Use a fresh token each time if you prefer; the remote stays `https://github.com/badrnour/muse.git` without any token.)

## Still needed from the user

- **Merger service base URL** (`MERGER_API_BASE`) — the real merge service URL was masked in the original brief. Without it, real merge e2e is untested.
- Optional: a **CometAPI key** to verify the second provider path (kie.ai is fully verified).
- Optional: an **exhausted (402) key** to verify the `exhausted` status path live (classification is implemented and unit-consistent with the failover test).
