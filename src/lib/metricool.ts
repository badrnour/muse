// Metricool API client (REST API v2) — schedule / publish video posts.
// Official docs (read 2026-11-09):
// - Help guide: https://help.metricool.com/basic-guide-for-api-integration-r97af
// - Official Swagger: https://app.metricool.com/api/swagger.json
// - Common questions/errors: https://help.metricool.com/common-questions-and-errors-when-using-the-api-8x9nq
//
// Auth (per the official docs): EVERY call needs three values —
//   * the API token in the `X-Mc-Auth` header (Account Settings > API),
//   * `userId` and `blogId` (brand) as query parameters.
// The REST API is available ONLY on Advanced and Custom plans. Free and
// Starter plans have NO API access (official help center).
//
// Endpoints used (all relative to https://app.metricool.com/api):
// - POST /v2/scheduler/posts — create a scheduled post. Body is a
//   `ScheduledPost`: required fields are `providers`, `publicationDate`
//   ({dateTime, timezone} — local date-time + IANA timezone, must be in the
//   future) and `text`. Optional: `media` (string array), `autoPublish`,
//   `draft`, `firstCommentText`, `saveExternalMediaFiles`, `facebookData`,
//   `instagramData`, `tiktokData`, `youtubeData`, ...
// - GET /actions/normalize/image/url?url=... — validates a public image URL
//   and turns it into a Metricool-hosted URL (official Swagger).
// - GET /admin/simpleProfiles?userId=... — list brands and their blogIds.
//
// VIDEO MEDIA — READ THIS: the official Swagger exposes a normalize endpoint
// for IMAGES only; there is NO /actions/normalize/video/url. The help guide
// says media links must be public and non-expiring, and the `ScheduledPost`
// schema has `media` (string array) + `saveExternalMediaFiles`. So a public
// video URL is passed directly in `media` with `saveExternalMediaFiles: true`
// and Metricool hosts it. This path is UNVERIFIED against a live account
// (no Metricool account is connected yet) — the first real publish must be
// checked in the Metricool dashboard, and if Metricool rejects the video,
// check the Swagger / help guide for a video-specific flow.
// NOTE: generated video URLs from kie.ai are public CDN links, but they may
// expire — always publish/merge promptly; a merged clip hosted on the
// merging service disappears after ~24h, so publish it the same day.

import {
  insertPublishJob,
  type PublishJobRow,
  type PublishStatus,
} from "./turso";

export const METRICOOL_BASE_URL = "https://app.metricool.com/api";

export const PUBLISH_NETWORKS = [
  "facebook",
  "instagram",
  "tiktok",
  "youtube",
  "threads",
  "linkedin",
  "twitter",
  "pinterest",
] as const;

export type PublishNetwork = (typeof PUBLISH_NETWORKS)[number];

export interface MetricoolConfig {
  token: string;
  userId: string;
  brandId: string;
  timezone: string;
}

export function metricoolConfig(): MetricoolConfig | null {
  const token = (process.env.METRICOOL_API_TOKEN ?? "").trim();
  const userId = (process.env.METRICOOL_USER_ID ?? "").trim();
  const brandId = (process.env.METRICOOL_BRAND_ID ?? "").trim();
  if (!token || !userId || !brandId) return null;
  const timezone = (process.env.METRICOOL_TIMEZONE ?? "").trim() || "Africa/Cairo";
  return { token, userId, brandId, timezone };
}

export function metricoolConfigured(): boolean {
  return metricoolConfig() !== null;
}

export const METRICOOL_NOT_CONFIGURED_MESSAGE =
  "❌ Video publishing is not configured: set METRICOOL_API_TOKEN, METRICOOL_USER_ID and METRICOOL_BRAND_ID in .env.local (or Vercel env vars). " +
  "The Metricool REST API needs an Advanced or Custom plan — Free and Starter plans have no API access. " +
  "Find the token in Metricool under Account Settings > API, and the userId/blogId in the brand URL or via GET /admin/simpleProfiles.";

export class MetricoolError extends Error {
  httpStatus: number;
  constructor(message: string, httpStatus = 0) {
    super(message);
    this.httpStatus = httpStatus;
  }
}

async function metricoolFetch<T>(
  path: string,
  init: RequestInit,
  timeoutMs = 30_000
): Promise<T> {
  const cfg = metricoolConfig();
  if (!cfg) throw new MetricoolError(METRICOOL_NOT_CONFIGURED_MESSAGE, 0);
  const sep = path.includes("?") ? "&" : "?";
  const url =
    `${METRICOOL_BASE_URL}${path}${sep}` +
    `userId=${encodeURIComponent(cfg.userId)}&blogId=${encodeURIComponent(cfg.brandId)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-Mc-Auth": cfg.token,
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!res.ok) {
      const msg =
        (body && typeof body === "object"
          ? ((body as Record<string, unknown>).message as string) ||
            ((body as Record<string, unknown>).error as string) ||
            ""
          : "") || `Metricool returned HTTP ${res.status}.`;
      throw new MetricoolError(msg, res.status);
    }
    return body as T;
  } catch (err) {
    if (err instanceof MetricoolError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new MetricoolError(`Network error calling Metricool: ${message}`, 0);
  } finally {
    clearTimeout(timer);
  }
}

/** Format an instant as a local date-time string in the given IANA timezone. */
function formatLocalDateTime(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "00";
  // Some environments render midnight as hour "24" — normalize to "00".
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}`;
}

export interface SchedulePostInput {
  videoUrl: string;
  caption: string;
  networks: PublishNetwork[];
  /** ISO date-time. Defaults to "now + 5 minutes" (publish as soon as possible). */
  scheduledAt?: string;
  timezone?: string;
  draft?: boolean;
}

export interface ScheduledPostResult {
  postId: string;
  scheduledAt: string;
  draft: boolean;
}

/**
 * Create a scheduled post on Metricool (POST /v2/scheduler/posts).
 * The post is scheduled for a FUTURE time — Metricool does not accept a past
 * date, so "publish now" means now + 5 minutes with autoPublish.
 */
export async function createScheduledPost(
  input: SchedulePostInput
): Promise<ScheduledPostResult> {
  const cfg = metricoolConfig();
  if (!cfg) throw new MetricoolError(METRICOOL_NOT_CONFIGURED_MESSAGE, 0);
  const tz = input.timezone?.trim() || cfg.timezone;
  const when = input.scheduledAt
    ? new Date(input.scheduledAt)
    : new Date(Date.now() + 5 * 60_000);
  if (Number.isNaN(when.getTime())) {
    throw new MetricoolError(
      "❌ scheduled_at must be a valid ISO date-time string (e.g. 2026-11-10T18:00:00).",
      0
    );
  }
  if (!input.draft && when.getTime() <= Date.now() + 60_000) {
    throw new MetricoolError(
      "❌ scheduled_at must be in the future (at least 1 minute from now). Metricool only schedules future posts.",
      0
    );
  }
  const body = {
    publicationDate: { dateTime: formatLocalDateTime(when, tz), timezone: tz },
    text: input.caption,
    providers: input.networks.map((network) => ({ network })),
    // See the VIDEO MEDIA note at the top of this file.
    media: [input.videoUrl],
    saveExternalMediaFiles: true,
    autoPublish: !input.draft,
    draft: Boolean(input.draft),
  };
  const res = await metricoolFetch<Record<string, unknown>>("/v2/scheduler/posts", {
    method: "POST",
    body: JSON.stringify(body),
  });
  // The response is a JsonOkResponseScheduledPost: { data: { id, ... } }.
  const data = (res as Record<string, unknown>)?.data as
    | Record<string, unknown>
    | undefined;
  const raw = data ?? res;
  const postId = raw?.id ?? raw?.postId;
  if (postId === undefined || postId === null) {
    throw new MetricoolError(
      "Metricool did not return a post id. Check the post in the Metricool dashboard — it may have been created anyway.",
      0
    );
  }
  return { postId: String(postId), scheduledAt: when.toISOString(), draft: Boolean(input.draft) };
}

/**
 * Normalize a public IMAGE url through Metricool (GET /actions/normalize/image/url).
 * Kept for image posts — the video flow does not use it (no video normalize
 * endpoint exists in the official Swagger; see the note at the top).
 */
export async function normalizeImageUrl(url: string): Promise<string> {
  const res = await metricoolFetch<unknown>(
    `/actions/normalize/image/url?url=${encodeURIComponent(url)}`,
    { method: "GET" }
  );
  if (typeof res === "string" && res.startsWith("http")) return res;
  if (res && typeof res === "object") {
    const data = (res as Record<string, unknown>).data as Record<string, unknown> | undefined;
    const candidate = (data?.url ?? (res as Record<string, unknown>).url) as unknown;
    if (typeof candidate === "string" && candidate.startsWith("http")) return candidate;
  }
  return url;
}

/** List the brands (blogIds) the account can post to — use it to find your blogId. */
export async function listBrands(): Promise<unknown> {
  return metricoolFetch<unknown>("/admin/simpleProfiles", { method: "GET" });
}

export interface PublishJobInput {
  taskId?: string | null;
  videoUrl: string;
  caption: string;
  networks: PublishNetwork[];
  scheduledAt?: string;
  timezone?: string;
  draft?: boolean;
}

export type PublishJobOutcome =
  | {
      ok: true;
      job: PublishJobRow;
      postId: string;
      scheduledAt: string;
      draft: boolean;
    }
  | { ok: false; job: PublishJobRow; error: string };

/**
 * Publish/schedule one video through Metricool and record the outcome in the
 * publish_jobs table. Never throws for a config/API failure — the failure is
 * recorded as a failed job and returned, so the caller can report it.
 * Nothing is ever published when Metricool is not configured.
 */
export async function publishVideoJob(
  input: PublishJobInput
): Promise<PublishJobOutcome> {
  const id = crypto.randomUUID();
  const networkLabel = input.networks.join(",");
  const record = async (patch: {
    status: PublishStatus;
    metricoolPostId?: string | null;
    scheduledAt?: string | null;
    errorMessage?: string | null;
  }): Promise<PublishJobRow> =>
    insertPublishJob({
      id,
      taskId: input.taskId ?? null,
      videoUrl: input.videoUrl,
      network: networkLabel,
      caption: input.caption,
      scheduledAt: patch.scheduledAt ?? input.scheduledAt ?? null,
      metricoolPostId: patch.metricoolPostId ?? null,
      status: patch.status,
      errorMessage: patch.errorMessage ?? null,
    });

  if (!metricoolConfigured()) {
    const job = await record({
      status: "failed",
      errorMessage: METRICOOL_NOT_CONFIGURED_MESSAGE,
    });
    return { ok: false, job, error: METRICOOL_NOT_CONFIGURED_MESSAGE };
  }
  try {
    const result = await createScheduledPost({
      videoUrl: input.videoUrl,
      caption: input.caption,
      networks: input.networks,
      scheduledAt: input.scheduledAt,
      timezone: input.timezone,
      draft: input.draft,
    });
    const job = await record({
      status: result.draft ? "draft" : "scheduled",
      metricoolPostId: result.postId,
      scheduledAt: result.scheduledAt,
    });
    return {
      ok: true,
      job,
      postId: result.postId,
      scheduledAt: result.scheduledAt,
      draft: result.draft,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const job = await record({ status: "failed", errorMessage: message });
    return { ok: false, job, error: message };
  }
}
