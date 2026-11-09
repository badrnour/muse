# TEST-REPORT — MCP Media Generator v1.2.0

Date: 2026-11-09. Environment: Node v24.22.1, npm 10.9.4, Next.js 15.5.7 (pinned — `create-next-app@latest` requested Next 16.4.6, which was not installable from the registry at scaffold time), `@modelcontextprotocol/sdk` 1.32.2, `@libsql/client` 0.18.0. Turso database: `libsql://muse-deyaanoor.aws-eu-west-1.turso.io` (real database, real token in `.env.local` only — no token in this file). One real kie.ai key is stored in Turso (masked form `b6cb2ab••••••••f022`).

No secrets appear in this report. Generated media URLs are public provider CDN links and are quoted as test evidence.

## 1. Static checks — PASS

| Check | Result |
|---|---|
| `npx tsc --noEmit` | Clean, 0 errors |
| `npx eslint src/lib src/app` | Clean, 0 errors, 0 warnings |
| `npm run build` | Succeeds; routes: `/` (static), `/mcp`, `/api/health`, `/api/keys`, `/api/keys/[id]`, `/api/tasks` (dynamic) |

## 2. Health endpoint — PASS

`GET /api/health` (production server, real Turso):

```json
{"ok":true,"database":"turso-connected","mcpEndpoint":"/mcp",
 "models":[
   {"canonical":"gpt-image-2-6/flare-text-to-image","type":"image","providers":["kie","cometapi"]},
   {"canonical":"grok-imagine-video-1-5-preview","type":"video","providers":["kie","cometapi"]}],
 "merger":{"base":null,"healthy":false},"authRequired":false}
```

`merger.healthy: false` is honest: no `MERGER_API_BASE` is configured yet (see §8).

## 3. Dashboard page — PASS

`GET /` returns HTML with `<html lang="en" dir="ltr">` and the "MCP Media Generator" heading. All UI text, buttons, badges and notes are English; the page is LTR. Key list shows masked keys only; stats and task list render from `/api/tasks`.

## 4. MCP session + tools/list — PASS

- `initialize` → `protocolVersion 2025-03-26`, server `media-generator-mcp`, session id issued; `notifications/initialized` → HTTP 202.
- `tools/list` returns exactly the 5 tools with the specified schemas:
  - `generate_image`: prompt (required), model enum, aspect_ratio enum (16 values), resolution 1K/2K/4K, background, output_format, wait_seconds 0–240 default 90.
  - `generate_video`: prompt (maxLength 4096), image_url, model enum, aspect_ratio, resolution 480p/720p/1080p, enable_audio default true, duration 1–15 default 8, wait_seconds default 25.
  - `merge_videos`: urls, task_ids, wait_seconds default 60 — no resolution/fps fields. Note: the 2–10 clip limits are enforced in the tool handler (not in the zod schema) so a bad call returns the exact specified message instead of a generic zod validation error (see §7).
  - `get_task`: task_id. `list_media`: type/status/limit 1–50 default 10.

## 5. Image generation e2e (kie.ai) — PASS

`generate_image` — "A cute orange cat sitting on a windowsill at sunset, photorealistic", 1:1, 1K, `wait_seconds: 150`:

- Result (after ~37 s, inside the wait window): `✅ Image generated successfully` + image markdown + direct link.
- URL: `https://tempfile.aiquickdraw.com/models/gpt-image-2.6-flare/6a332caf-6ae8-4675-9607-a9eb4fa434d7.png`
- Verified with HEAD: HTTP 200, `Content-Type: image/png`, 1,721,770 bytes.
- Turso task: provider `kie`, model `gpt-image-2-6/flare-text-to-image`, status `completed`, progress 100, 1 attempt.

### 5a. Retry of a never-created task via get_task — PASS

The first image attempt (before a fix, see §6) left a task `processing` with no provider task id and the internal note "Waiting for a valid key…". A later `get_task` on it retried creation after the cooldown, the job was created on kie.ai, and a second `get_task` returned `✅ Image generated successfully` with a second verified image URL (`.../62dc379d-3ad5-4c72-ab41-cd1bee65d9f2.png`, HTTP 200, image/png). Task attempts: 2 (1 failed network attempt + 1 success).

## 6. First-attempt network stall (observed, fixed, documented)

The very first image attempt failed with `Network error calling provider: This operation was aborted` (errorClass `temporary`) — the kie.ai `createTask` POST hung until the 60 s client timeout. Direct checks showed the endpoint itself is reachable (curl `recordInfo` ~0.3–1.4 s) but `createTask` is slow: an immediate 401 rejection took ~14.5 s through the VM egress proxy, and latency varies per call. Two changes were made and the build re-tested:

1. kie.ai returns HTTP 200 with the real status in the body `code` (e.g. `{"code":401,"msg":"Unauthorized …"}`) — the adapter now classifies on the body `code`, not only the HTTP status.
2. `createTask` timeout raised 60 s → 120 s.

After the fix, image creation succeeded in ~2–37 s on subsequent calls. No key/balance information ever reached the client.

## 7. Video generation e2e (kie.ai) — PASS

`generate_video` — "A small paper boat glides across a quiet pond at sunrise, gentle ripples, cinematic", duration 8, 480p, `wait_seconds: 25`:

- Immediate reply: `⏳ Task is processing — task_id: 9ff01aa9-…` + "Check with get_task every ~10 seconds until it completes."
- Polled `get_task` every ~15 s: completed on poll 6 (~2 min total).
- Result: `✅ Video generated successfully` + direct link `https://tempfile.aiquickdraw.com/ggg/users/6f6434bf-abda-4414-a2de-6b0b729e3503/generated/56efc406-9801-4f66-9fa8-0bd2c5157e40/generated_video.mp4`
- Verified with HEAD: HTTP 200, `Content-Type: video/mp4`.

## 8. Sequential failover (wrong key first, good key second) — PASS

Setup: bogus kie key inserted first, real kie key re-inserted second (insertion order verified in the key list). `generate_image` ("A red vintage bicycle leaning against a brick wall, morning light, photorealistic"):

- Client reply: only `✅ Image generated successfully` + the image URL (`.../cf67c59e-b975-4deb-995d-ed6fff8713c6.png`, verified HTTP 200). **No mention of keys or balances anywhere in the client reply.**
- Turso after the call:
  - Bogus key: status `disabled`, fail_count 1, last_error `Unauthorized – Authentication failed. …` (401 → `disabled` classification).
  - Real key: status `active`, success_count 1.
  - Task: `completed`, 2 attempts recorded — attempt 1: `ok: false, errorClass: "disabled"`, attempt 2: `ok: true` on the real key, same `task_id`.

## 9. list_media — PASS

`list_media {"limit": 5}` returned the 3 completed tasks (video + 2 images), newest first, each with model, status, progress, prompt excerpt, attempt count and result URLs.

## 10. Merge validation — PASS (messages); real merge — PENDING

| Call | Result |
|---|---|
| `merge_videos` with 1 URL | `❌ Merging needs at least two clips. Pass urls (direct links) or task_ids of completed tasks.` (`isError: true`) |
| `merge_videos` with 11 URLs | `❌ The maximum number of clips to merge is 10 (the merging service accepts at most 10 clips).` (`isError: true`) |
| `merge_videos` with `task_ids` of 2 completed tasks | Both ids resolved to their stored URLs in order; then failed cleanly with the not-configured message below (proves `task_ids` resolution works) |
| `merge_videos` with 2 public MP4 URLs, no merger base | `❌ Video merging is not configured: set MERGER_API_BASE to the merging service URL.` (`isError: true`) |

**Real merge e2e is PENDING** — the merger service base URL was masked in the brief and has not been provided. The merger client (`src/lib/merger.ts`) is implemented per the measured API shapes in the spec (create/process/poll, once-only process lock, terminal HTTP errors vs temporary network errors, 24 h expiry note), but no live merge has run yet. To complete it: set `MERGER_API_BASE` and re-run with the two public test clips from the spec.

## 11. Not yet tested live (needs user input)

- **CometAPI path** (image sync + Grok video): no CometAPI key available. Code follows CometAPI's published docs (OpenAI-compatible `/v1/images/generations`; Grok video `POST /grok/v1/videos` → `request_id`, poll `GET /grok/v1/videos/{request_id}`). Note: CometAPI's docs list the Grok model ID as `grok-imagine-video-1.5`; the spec pins `grok-imagine-video-1-5-preview` for both providers, so that is the default and `COMETAPI_VIDEO_MODEL=grok-imagine-video-1.5` is the documented override if CometAPI rejects the name.
- **Exhausted (402) key**: no exhausted key available. Classification (`exhausted` → status `exhausted`, key stays in the DB, failover continues) is implemented and shares the code path proven by the 401 failover test in §8.
- **Vercel deployment**: not deployed; the production build + local production server were verified instead. The app uses no local files (libSQL over HTTP), so the Vercel path is the env vars in the README.

## 12. Cleanup

After testing: the bogus failover-test key was deleted via the API, and all 4 test tasks were deleted from Turso. Final state: **0 tasks, 1 key (kie, active)**. The generated media URLs above remain valid on the provider CDN. No test artifacts remain in the repo (`.env.local` is git-ignored and was never committed).

---

## 13. v1.3.0 — Metricool auto-publishing + story videos (2026-11-09)

### 13.1 Metricool API — sources actually read

- Help guide: https://help.metricool.com/basic-guide-for-api-integration-r97af
- Official Swagger: https://app.metricool.com/api/swagger.json (read in full for the scheduler + media shapes)
- Common questions/errors: https://help.metricool.com/common-questions-and-errors-when-using-the-api-8x9nq

Verified facts: base URL `https://app.metricool.com/api`; auth = `X-Mc-Auth` header (API token) + `userId` + `blogId` query params on every call; `POST /v2/scheduler/posts` with body `ScheduledPost` (required: `providers`, `publicationDate` `{dateTime, timezone}`, `text`; optional `media` string array, `saveExternalMediaFiles`, `autoPublish`, `draft`, `firstCommentText`, `facebookData`, `instagramData`, …); publication date must be in the future; **REST API only on Advanced and Custom plans — Free/Starter have no API access** (official help center). Token lives in Metricool under **Account Settings > API**; `userId`/`blogId` are read from the brand URL (`https://app.metricool.com/evolution/web?blogId=…&userId=…`) or via `GET /admin/simpleProfiles?userId=…`.

**Video-media caveat (unverified):** the official Swagger exposes a media-normalize endpoint for **images only** (`GET /actions/normalize/image/url`) — there is NO video normalize endpoint. The client therefore passes the public video URL directly in `media` with `saveExternalMediaFiles: true`. Implemented per the official schemas, but NOT verified against a live Metricool account yet — check the first real post in the Metricool dashboard.

### 13.2 What was built

- `src/lib/metricool.ts` — Metricool API v2 client: env config (`METRICOOL_API_TOKEN`, `METRICOOL_USER_ID`, `METRICOOL_BRAND_ID`, `METRICOOL_TIMEZONE` default `Africa/Cairo`), `createScheduledPost` (future date required; "publish now" = now + 5 min, autoPublish), `normalizeImageUrl`, `listBrands`, and `publishVideoJob` (records every attempt in Turso). No real values anywhere in code.
- `src/lib/story-ideas.ts` — 12-idea bank for the Fayyaz page (English only, no-face, realistic, 2–3 actions per 10s, comedy from behavior, meaningful twist) + `pickStoryIdea` (deterministic daily rotation) + `buildCaption` (caption + English-only hashtags).
- `src/lib/turso.ts` — new `publish_jobs` table (`id, task_id, video_url, network, caption, scheduled_at, metricool_post_id, status draft|scheduled|published|failed, error_message, created_at, updated_at`) + `insertPublishJob/getPublishJob/updatePublishJob/listRecentPublishJobs`. Existing tables untouched.
- MCP tools (now **7**): `publish_video` (video_url or completed task_id + English caption, facebook default, immediate or scheduled, draft option) and `create_story_video` (auto/custom idea → video via `grok-imagine-video-1-5-preview` → caption + hashtags; publishes ONLY when `publish=true` is passed explicitly). `SERVER_INSTRUCTIONS` updated with the publish flow; version bumped to **1.3.0**.
- `GET /api/health` now includes `metricool: {configured, requiresAdvancedPlan}` (presence only, no values). New `GET /api/publish` route. Dashboard: new **Publishing** section (job list + statuses), Metricool status chip, both new tools listed. All English, LTR.
- `.env.example` + README updated (Metricool setup steps, plan requirement, video-media caveat).

### 13.3 Tests — all real, local production server

| Check | Result |
|---|---|
| `npx tsc --noEmit` | Clean, 0 errors |
| `npx eslint src/lib src/app` | Clean, 0 errors, 0 warnings |
| `npm run build` | Succeeds; new route `ƒ /api/publish` |
| `GET /api/health` | `{"ok":true,"database":"turso-connected",...,"metricool":{"configured":false,"requiresAdvancedPlan":true}}` — honest: no Metricool env vars set |
| `GET /api/publish` | `{"jobs":[]}` before tests |
| MCP `tools/list` | **7 tools**, incl. `publish_video` and `create_story_video` with the specified schemas |
| `publish_video` (public video URL, no config) | `❌ Video publishing is not configured: set METRICOOL_API_TOKEN, METRICOOL_USER_ID and METRICOOL_BRAND_ID …` (`isError: true`) — no success claimed; failed job recorded in Turso and visible in `/api/publish` |
| `publish_video` with completed `task_id` (no config) | Same not-configured error — proves task_id resolution works (it got past the task lookup to the config check) |
| `create_story_video` e2e (custom idea, kie.ai, publish=false) | **PASS** — video generated in ~46 s, `get_task` poll 1 already completed; URL verified HEAD `HTTP 200, video/mp4`; reply included the story title, caption + English hashtags, and "Not published (publish=false) — call publish_video with the task_id when you want it live." |
| Dashboard `GET /` | Renders the Publishing section and both new tool chips (health chips are client-fetched, so they show "Checking…" in raw SSR HTML — expected) |

### 13.4 Not yet tested live (needs user input)

- **Real Metricool publish**: no API token / userId / brandId yet. The user's Metricool account **already has the Fayyaz Pathan Facebook Page connected and Active** (screenshot 2026-11-09: Social Accounts 1/30, Active 1, Expired 0; Page status "Expires in 59 day(s)" — the Facebook connection itself needs re-authorization in ~59 days, around 2027-01-07). Still missing: the API token + userId + brandId (see §13.1 for exactly where to find them). The video-attach path (`media` + `saveExternalMediaFiles`) is the one unverified piece — verify the video attached on the first real post.
- **Bank idea pick (no custom idea)**: not live-tested as a generation (same code path as the tested custom-idea call, only `pickStoryIdea()` differs; deterministic daily rotation by date).
- **CometAPI path / exhausted (402) key / real merge**: still pending as in §11.
- **Vercel deployment**: not deployed; local production server verified instead.

### 13.5 Cleanup (v1.3.0 tests)

Deleted the 1 test video task and the 2 test publish jobs from Turso. Final state: **0 tasks, 0 publish jobs, 1 key (kie, active)**. The generated test video URL remains valid on the provider CDN. No test artifacts in the repo (`.env.local` git-ignored, never committed).
