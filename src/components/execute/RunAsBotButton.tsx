"use client";

import type { TradePlan } from "@/lib/tradePlan";
import type { PerpVenueName } from "@/lib/planner/markets";
import { marketBase } from "@/lib/perpVenues";
import { openNeutralBot, type BotPrefill } from "@/lib/neutralBot/bus";

const VENUE: Record<string, PerpVenueName> = { hyperliquid: "Hyperliquid", extended: "Extended", txflow: "TxFlow" };
const venueOf = (protocol: string | undefined) => VENUE[(protocol ?? "").toLowerCase().match(/hyperliquid|extended|txflow/)?.[0] ?? ""];

/** The bot's settings for a plan's neutral pair: same asset, venues, size per leg and leverage. */
export function botPrefillFor(plan: TradePlan, seq: [number, number]): BotPrefill | null {
  const [a, b] = seq.map((i) => plan.legs[i]);
  const va = venueOf(a?.protocol);
  const vb = venueOf(b?.protocol);
  if (!a || !b || !va || !vb || va === vb) return null;
  const base = marketBase((a.asset || "").replace(/[-\s]?PERP$/i, "").trim());
  const farming = plan.objective ? plan.objective === "farming" : /farm|volume|points?|airdrop|\bOI\b|open interest/i.test(`${plan.summary} ${plan.variantLabel ?? ""}`);
  return {
    base,
    venues: [va, vb],
    notionalUsd: Math.max(1, Math.round(Math.min(a.sizeUsd ?? 0, b.sizeUsd ?? 0) || 50)),
    leverage: Math.max(1, Math.round(a.leverage ?? 1)),
    mode: farming ? "farm" : "carry",
  };
}

/**
 * "Run it as a bot": the plan's neutral pair handed to the neutral bot in
 * Tools (prefilled, not started), to keep it working on its own — rotated for
 * volume and open interest, or held while the funding spread pays.
 */
export function RunAsBotButton({ plan, seq }: { plan: TradePlan; seq: [number, number] }) {
  const prefill = botPrefillFor(plan, seq);
  if (!prefill) return null;
  return (
    <button type="button" className="btn btn-secondary" style={{ fontSize: 12, width: "100%" }} onClick={() => openNeutralBot(prefill)}>
      {prefill.mode === "farm" ? "Automate it: run as a farming bot (rotates for volume & OI) →" : "Automate it: run as a carry bot →"}
    </button>
  );
}
