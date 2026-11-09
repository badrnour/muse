// Recent Metricool publish jobs for the dashboard publishing section.

import { NextResponse, type NextRequest } from "next/server";
import { listRecentPublishJobs } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const params = req.nextUrl.searchParams;
    const limit = Math.min(50, Math.max(1, Number(params.get("limit") ?? 20) || 20));
    const jobs = await listRecentPublishJobs(limit);
    return NextResponse.json({
      jobs: jobs.map((j) => ({
        id: j.id,
        task_id: j.task_id,
        video_url: j.video_url,
        network: j.network,
        caption: j.caption,
        scheduled_at: j.scheduled_at,
        metricool_post_id: j.metricool_post_id,
        status: j.status,
        error_message: j.error_message,
        created_at: j.created_at,
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to list publish jobs." },
      { status: 500 }
    );
  }
}
