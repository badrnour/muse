// MCP endpoint (Streamable HTTP, official SDK).
// Uses the Web Standard transport so it runs natively in Next.js route
// handlers — no manual JSON-RPC anywhere. POST handles messages, DELETE
// ends a session. Sessions are kept in a module-level map.

import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "@/lib/mcp-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

function authFailed(req: NextRequest): boolean {
  const token = process.env.MCP_ACCESS_TOKEN;
  if (!token) return false;
  const header = req.headers.get("authorization") ?? "";
  return header !== `Bearer ${token}`;
}

async function handleMcp(req: NextRequest): Promise<Response> {
  if (authFailed(req)) {
    return new Response(JSON.stringify({ error: "Unauthorized: a valid Bearer token is required for /mcp." }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const sessionId = req.headers.get("mcp-session-id") ?? undefined;
  let transport = sessionId ? sessions.get(sessionId) : undefined;

  if (!transport) {
    transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, transport as WebStandardStreamableHTTPServerTransport);
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
      },
    });
    const server = createMcpServer();
    await server.connect(transport);
  }

  return transport.handleRequest(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handleMcp(req);
}

export async function DELETE(req: NextRequest): Promise<Response> {
  return handleMcp(req);
}

export async function GET(): Promise<Response> {
  return new Response(
    JSON.stringify({
      name: "media-generator-mcp",
      version: "1.2.0",
      endpoint: "/mcp",
      transport: "Streamable HTTP (MCP 2025-03-26)",
      hint: "Send JSON-RPC over POST with Accept: application/json, text/event-stream.",
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}
