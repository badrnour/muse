# MCP Media Generator

An AI media-generation MCP server with video merging and auto-publishing — one Next.js app (App Router + TypeScript + Tailwind) that exposes 7 MCP tools and an English LTR admin dashboard.

- **Generate images** with `gpt-image-2-6/flare-text-to-image`
- **Generate videos with native synchronized audio** with `grok-imagine-video-1-5-preview`
- **Merge clips** into one final video (Video Merger API v2)
- **Create story reels** for the Fayyaz page with `create_story_video` (auto idea pick, video + English caption/hashtags)
- **Publish/schedule videos** to Facebook and other networks with `publish_video` via the Metricool API
- **Sequential multi-key failover**: keys are tried in strict insertion order; on any error or exhausted balance the same task silently continues on the next key under the same `task_id` — the AI client never sees key/balance errors
- **Links only**: no media file is ever downloaded to the server; only result URLs are stored in Turso

## Project layout

```
src/lib/turso.ts        Turso (libSQL over HTTP) layer + schema + task/key/publish-job queries
src/lib/keys.ts         Sequential key pool, error classification, masking, counters
src/lib/models.ts       Model registry (canonical names, aliases, env overrides)
src/lib/providers/      kie.ai + CometAPI adapters (createTask / createImageSync / checkTask)
src/lib/generation.ts   Generation orchestrator: failover, wait window, get_task refresh
src/lib/merger.ts       Video Merger API v2 client (create/process/poll, once-only process)
src/lib/metricool.ts    Metricool API v2 client (schedule/publish posts, publish-job recording)
src/lib/story-ideas.ts  Fayyaz story-idea bank (English, no-face, universal) + captions
src/lib/mcp-server.ts   The 7 MCP tools (McpServer + zod schemas, English replies)
src/app/mcp/route.ts    Streamable HTTP MCP endpoint (Web Standard transport)
src/app/api/health/     Health: Turso status, merger readiness, Metricool config, models, auth flag
src/app/api/keys/       Key CRUD (keys always masked in responses)
src/app/api/tasks/      Recent tasks + stats for the dashboard
src/app/api/publish/    Recent Metricool publish jobs for the dashboard
src/app/page.tsx        Admin dashboard (keys, live task board, publishing, connect settings)
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
| `METRICOOL_API_TOKEN` | For publishing | Metricool API token (Account Settings > API). |
| `METRICOOL_USER_ID` | For publishing | Metricool account user ID (from the brand URL or `GET /admin/simpleProfiles`). |
| `METRICOOL_BRAND_ID` | For publishing | Metricool brand/blog ID (from the brand URL or `GET /admin/simpleProfiles`). |
| `METRICOOL_TIMEZONE` | No | IANA timezone for scheduling (default: `Africa/Cairo`). |
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
3. **Settings → Environment Variables**: add `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `MERGER_API_BASE` (and optionally `MCP_ACCESS_TOKEN`, `METRICOOL_API_TOKEN`, `METRICOOL_USER_ID`, `METRICOOL_BRAND_ID`).
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
| `publish_video` | Publish/schedule a finished video via Metricool (Facebook by default). |
| `create_story_video` | Pick a story idea, generate the reel, write the English caption + hashtags. |

## Auto-publish with Metricool

`publish_video` and `create_story_video` (with `publish=true`) schedule posts through the **Metricool REST API v2** — the same flow shown in the NextGen AI video: generate → merge → publish/schedule automatically.

Official docs: [Basic Guide for API Integration](https://help.metricool.com/basic-guide-for-api-integration-r97af) and the [official Swagger](https://app.metricool.com/api/swagger.json) (`POST /v2/scheduler/posts`, body `ScheduledPost` with `publicationDate`/`text`/`providers`).

**What you need (in this order):**

1. **A Metricool account on an Advanced or Custom plan.** The REST API is NOT available on Free or Starter plans — those plans have no API access at all (official help center). (Metricool also offers a hosted MCP connector on all plans, but this project uses the REST API.)
2. **Connect the Fayyaz Facebook Page inside Metricool** (Brands → connect Facebook). The API can only post to networks already connected in the brand.
3. **API token:** Metricool → Account Settings → API → copy the API access token.
4. **IDs:** `userId` and `blogId` (brand) — read them from the brand URL in Metricool, or call `GET https://app.metricool.com/api/admin/simpleProfiles?userId=<id>` with the `X-Mc-Auth` header.
5. **Set the env vars** (`METRICOOL_API_TOKEN`, `METRICOOL_USER_ID`, `METRICOOL_BRAND_ID`, optional `METRICOOL_TIMEZONE`) in `.env.local` or Vercel → Settings → Environment Variables. The token is never entered in the dashboard and never shown anywhere.

**How it works:**

- `publish_video` takes a completed video (`video_url` or `task_id`) + an English caption. Without `scheduled_at` it schedules for now + 5 minutes with auto-publish; with `scheduled_at` (ISO date-time, must be in the future) it schedules for that time. `draft=true` saves a draft instead.
- `create_story_video` picks today's idea from the bank in `src/lib/story-ideas.ts` (12 universal, no-face, realistic ideas — add more by appending to the list), generates the video with `grok-imagine-video-1-5-preview`, and writes the caption + English-only hashtags. It does **not** publish unless `publish=true` is passed explicitly.
- Every attempt is recorded in the `publish_jobs` table (status `scheduled` / `draft` / `published` / `failed`) and shown in the dashboard **Publishing** section. `/api/health` reports `metricool.configured` (true/false, no values).
- Without the three env vars, `publish_video` returns a clear "not configured" error and records a failed job — nothing is ever published by accident.

**Video media caveat (read before the first real publish):** the official Metricool Swagger exposes a media-normalize endpoint for **images only** (`GET /actions/normalize/image/url`); there is no video normalize endpoint. The client therefore passes the public video URL directly in the post's `media` array with `saveExternalMediaFiles: true` so Metricool hosts it. This path is implemented per the official schemas but **not yet verified against a live Metricool account** — check the first real post in the Metricool dashboard and confirm the video attached. Also note: generated video URLs are public CDN links that may expire, and merged clips disappear from the merging service after ~24h — publish merged videos the same day.

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
- **Metricool account + credentials for real publishing** — an Advanced or Custom plan, the Fayyaz Facebook Page connected inside Metricool, and `METRICOOL_API_TOKEN` / `METRICOOL_USER_ID` / `METRICOOL_BRAND_ID`. The video-attach path (`media` + `saveExternalMediaFiles`) is implemented per the official Swagger but not yet verified live — check the first real post in the Metricool dashboard.
- Optional: a **CometAPI key** to verify the second provider path (kie.ai is fully verified).
- Optional: an **exhausted (402) key** to verify the `exhausted` status path live (classification is implemented and unit-consistent with the failover test).
