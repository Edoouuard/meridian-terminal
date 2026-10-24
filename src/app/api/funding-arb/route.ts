/**
 * GET /api/funding-arb — funding-rate pairs across Hyperliquid, Extended and
 * TxFlow (lib/markets/fundingArb.ts). Today's rates come from the perp
 * snapshot; for the widest candidates, each leg's last 7 days of funding is
 * read from the venue's history (Hyperliquid fundingHistory, Extended
 * /info/{market}/funding; TxFlow publishes none). Cached a few minutes.
 */
import { NextResponse } from "next/server";
import { fetchPerpSnapshot } from "@/lib/perpFeed";
import { EXTENDED_HOSTS } from "@/lib/integrations/extendedProxy";
import {
  averageAnnualPct,
  candidatePairs,
  evaluatePair,
  legsFromSnapshot,
  parseExtendedFundingHistory,
  parseHlFundingHistory,
  rankFundingArbs,
  type FundingLeg,
  type RatePoint,
} from "@/lib/markets/fundingArb";

export const dynamic = "force-dynamic";

/** Candidates whose history is read (two requests each at most). */
const MAX_CANDIDATES = 15;
const DAY_MS = 86_400_000;

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(8000), next: { revalidate: 600 } });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function history(leg: FundingLeg, from: number, now: number): Promise<RatePoint[]> {
  if (leg.venue === "Hyperliquid")
    return parseHlFundingHistory(
      await getJson("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "fundingHistory", coin: leg.market, startTime: from }) }),
    );
  if (leg.venue === "Extended") return parseExtendedFundingHistory(await getJson(`${EXTENDED_HOSTS.mainnet}/api/v1/info/${encodeURIComponent(leg.market)}/funding?startTime=${from}&endTime=${now}`));
  return [];
}

export async function GET() {
  let snapshot;
  try {
    snapshot = await fetchPerpSnapshot();
  } catch {
    return NextResponse.json({ fetchedAt: new Date().toISOString(), pairs: [] }, { status: 502 });
  }
  const now = Date.now();
  const from = now - 7 * DAY_MS;
  const candidates = candidatePairs(legsFromSnapshot(snapshot.quotes)).slice(0, MAX_CANDIDATES);
  const legs = new Map<string, FundingLeg>();
  for (const c of candidates) for (const l of [c.long, c.short]) legs.set(`${l.venue}|${l.market}`, l);
  const averages = new Map(
    await Promise.all([...legs].map(async ([key, leg]) => [key, averageAnnualPct(await history(leg, from, now), from, now)] as const)),
  );
  const withHistory = (l: FundingLeg): FundingLeg => ({ ...l, rate7dPct: averages.get(`${l.venue}|${l.market}`) ?? null });
  const pairs = rankFundingArbs(candidates.map((c) => evaluatePair(withHistory(c.long), withHistory(c.short))));
  return NextResponse.json({ fetchedAt: snapshot.fetchedAt, pairs }, { headers: { "cache-control": "public, s-maxage=300, stale-while-revalidate=600" } });
}
