// Health endpoint: DB liveness, merge-service readiness, models, auth flag.

import { NextResponse } from "next/server";
import { dbHealthy, ensureSchema } from "@/lib/turso";
import { MODELS } from "@/lib/models";
import { mergerBase, mergerHealthy } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let database = "turso-error";
  try {
    await ensureSchema();
    database = (await dbHealthy()) ? "turso-connected" : "turso-error";
  } catch {
    database = "turso-error";
  }

  const base = mergerBase();
  const healthy = base ? await mergerHealthy() : false;

  return NextResponse.json({
    ok: database === "turso-connected",
    database,
    mcpEndpoint: "/mcp",
    models: MODELS.map((m) => ({
      canonical: m.canonical,
      type: m.type,
      providers: m.providers,
    })),
    merger: { base: base || null, healthy },
    authRequired: Boolean(process.env.MCP_ACCESS_TOKEN),
  });
}
