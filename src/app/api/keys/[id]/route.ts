// Enable/disable or delete a single key. The full key is never returned.

import { NextResponse, type NextRequest } from "next/server";
import { deleteKey, getKeyById, maskKey, setKeyStatus } from "@/lib/keys";
import type { KeyStatus } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function publicKey(k: NonNullable<Awaited<ReturnType<typeof getKeyById>>>) {
  return {
    id: k.id,
    provider: k.provider,
    label: k.label,
    maskedKey: maskKey(k.api_key),
    status: k.status,
    usage_count: k.usage_count,
    success_count: k.success_count,
    fail_count: k.fail_count,
    last_used_at: k.last_used_at,
    last_checked_at: k.last_checked_at,
    last_error: k.last_error,
    created_at: k.created_at,
  };
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const body = (await req.json()) as { status?: string };
    const status = body.status;
    if (status !== "active" && status !== "disabled" && status !== "exhausted") {
      return NextResponse.json(
        { error: "status must be 'active', 'disabled' or 'exhausted'." },
        { status: 400 }
      );
    }
    const updated = await setKeyStatus(id, status as KeyStatus);
    if (!updated) return NextResponse.json({ error: "Key not found." }, { status: 404 });
    return NextResponse.json({ key: publicKey(updated) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to update key." },
      { status: 500 }
    );
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const removed = await deleteKey(id);
    if (!removed) return NextResponse.json({ error: "Key not found." }, { status: 404 });
    return NextResponse.json({ deleted: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to delete key." },
      { status: 500 }
    );
  }
}
