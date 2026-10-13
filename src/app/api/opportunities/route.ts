/**
 * GET /api/opportunities — the best live yields across the protocols Meridian
 * covers (lib/protocols/registry.ts), on its 7 chains, from DefiLlama's free
 * pools API.
 *
 * Query: ?kind=stable|eth (default stable), ?limit (default 30).
 * Each row says whether Meridian can execute it ("execute") or only shows it
 * for comparison ("watch"), and which protocol name a strategy leg uses.
 */
import { NextResponse } from "next/server";
import { parseOpportunities, type Opportunity } from "@/lib/protocols/opportunities";

export const revalidate = 600;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const kind = url.searchParams.get("kind") === "eth" ? "eth" : "stable";
  const limit = Math.min(60, Math.max(1, Number(url.searchParams.get("limit")) || 30));
  try {
    const res = await fetch("https://yields.llama.fi/pools", { next: { revalidate: 600 }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return NextResponse.json<Opportunity[]>([]);
    const body: { data?: unknown[] } = await res.json();
    return NextResponse.json(parseOpportunities(body.data ?? [], { kind, limit }));
  } catch {
    return NextResponse.json<Opportunity[]>([]);
  }
}
