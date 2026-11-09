// API key management for the dashboard.
// Keys are ALWAYS masked in responses — the full key is never returned.

import { NextResponse, type NextRequest } from "next/server";
import { addKey, listAllKeys, maskKey } from "@/lib/keys";
import { ensureSchema } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function publicKey(k: Awaited<ReturnType<typeof listAllKeys>>[number]) {
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

export async function GET() {
  try {
    await ensureSchema();
    const keys = await listAllKeys();
    return NextResponse.json({ keys: keys.map(publicKey) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to list keys." },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureSchema();
    const body = (await req.json()) as { provider?: string; api_key?: string; label?: string };
    const provider = body.provider;
    const apiKey = (body.api_key ?? "").trim();
    if (provider !== "kie" && provider !== "cometapi") {
      return NextResponse.json({ error: "provider must be 'kie' or 'cometapi'." }, { status: 400 });
    }
    if (!apiKey) {
      return NextResponse.json({ error: "api_key is required." }, { status: 400 });
    }
    const created = await addKey(provider, apiKey, (body.label ?? "").trim());
    return NextResponse.json({ key: publicKey(created) }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to add key.";
    const status = message.includes("already registered") ? 409 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
