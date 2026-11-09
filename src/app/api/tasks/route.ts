// Recent tasks + stats for the dashboard task board.

import { NextResponse, type NextRequest } from "next/server";
import { listRecentTasks, taskStats, type TaskStatus, type TaskType } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const params = req.nextUrl.searchParams;
    const limit = Math.min(50, Math.max(1, Number(params.get("limit") ?? 20) || 20));
    const type = params.get("type") as TaskType | null;
    const status = params.get("status") as TaskStatus | null;
    const [tasks, stats] = await Promise.all([
      listRecentTasks(limit, {
        ...(type && ["image", "video", "merge"].includes(type) ? { type } : {}),
        ...(status && ["completed", "failed", "processing", "pending"].includes(status)
          ? { status }
          : {}),
      }),
      taskStats(),
    ]);
    return NextResponse.json({
      stats,
      tasks: tasks.map((t) => ({
        id: t.id,
        provider: t.provider,
        model: t.model,
        type: t.type,
        prompt: t.prompt,
        status: t.status,
        progress: t.progress,
        resultUrls: t.resultUrls ?? [],
        error_message: t.error_message,
        attempts: (t.attempts ?? []).length,
        created_at: t.created_at,
        updated_at: t.updated_at,
        completed_at: t.completed_at,
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to list tasks." },
      { status: 500 }
    );
  }
}
