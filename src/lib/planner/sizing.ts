/**
 * sizing.ts — how much of the user's capital a venue plan uses, decided by
 * the server rather than the model:
 *   - the share comes from the user ("100% of my available capital", "half",
 *     "tout mon capital") or, when they gave none, from a question asked
 *     before any plan is built;
 *   - perp legs on Hyperliquid / Extended are then sized from each venue's
 *     free margin × that share × the leg's leverage, the two legs of a pair
 *     to the smaller of the two, so the plan never trades a token amount
 *     while the margin for ten times more sits idle.
 */

import type { LLMLeg, LLMStrategy } from "@/lib/strategyIntegrity";
import { parseAmount } from "@/lib/tradePlan";
import { SIZING_POLICY } from "@/lib/planner/policy";
import type { VenueBalances } from "@/lib/planner/economics";
import type { PlannerClarify } from "@/lib/planner/clarify";

const CAPITAL_WORDS = "capital|balance|solde|margin|marge|funds|fonds|money|argent|available|disponible|libre|free";

/** The share of the available capital the user asked for (0-1), or undefined when they didn't say. */
export function capitalShare(text: string): number | undefined {
  const pct = text.match(new RegExp(`(\\d{1,3}(?:[.,]\\d+)?)\\s*%\\s*(?:of|de|du|des)?\\s*(?:my|mon|ma|mes|the|le|la|les|l')?\\s*(?:${CAPITAL_WORDS})`, "i"));
  if (pct) {
    const v = Number(pct[1].replace(",", ".")) / 100;
    if (v > 0 && v <= 1) return v;
  }
  if (new RegExp(`\\b(all|every|tout|toute|tous|totalit[ée]|entire|whole|full|max(?:imum)?)(?![a-z])[^.]{0,30}\\b(${CAPITAL_WORDS})`, "i").test(text)) return 1;
  if (new RegExp(`\\b(half|moiti[ée])(?![a-z])[^.]{0,30}\\b(${CAPITAL_WORDS})`, "i").test(text)) return 0.5;
  return undefined;
}

/** Does the request trade on a perp venue (where the size question matters)? */
export function isPerpRequest(text: string): boolean {
  return /\b(long|short|levier|leverage|lev|\d+\s*x|x\s*\d+|neutral|neutre|perps?|hyperliquid|extended|funding|volume|farm\w*)\b/i.test(text);
}

const looksFrench = (text: string) => /\b(en|le|la|les|du|des|et|sur|entre|mon|ma|mes|levier|neutre|avec|pour)\b/i.test(text);

export interface SizeQuestionInput {
  thesis: string;
  /** The user just answered a question: never ask again, size with the policy instead. */
  clarified: boolean;
  hyperliquidFreeUsd?: number | null;
  extendedFreeUsd?: number | null;
}

/**
 * The question to ask before building a perp plan the user gave no size for:
 * how much of the free capital to use. Null when the request has a size (in
 * dollars or as a share), isn't a perp trade, or no venue balance is known.
 */
export function sizeQuestion(i: SizeQuestionInput): { understanding: string; clarify: PlannerClarify } | null {
  if (i.clarified || !isPerpRequest(i.thesis)) return null;
  if (parseAmount(i.thesis) !== undefined || capitalShare(i.thesis) !== undefined) return null;
  const known = [
    typeof i.hyperliquidFreeUsd === "number" ? { venue: "Hyperliquid", usd: i.hyperliquidFreeUsd } : null,
    typeof i.extendedFreeUsd === "number" && i.extendedFreeUsd > 0 ? { venue: "Extended", usd: i.extendedFreeUsd } : null,
  ].filter((x): x is { venue: string; usd: number } => x !== null);
  if (known.length === 0) return null;
  const fmt = (x: number) => `$${x.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
  const balances = known.map((k) => `${k.venue} ${fmt(k.usd)}`).join(", ");
  if (looksFrench(i.thesis)) {
    return {
      understanding: `Avant de dimensionner : marge libre ${balances}.`,
      clarify: {
        question: "Quelle part de ton capital disponible veux-tu engager ?",
        why: `Marge libre ${balances}. Chaque marché a une taille minimale (Extended en quantité, Hyperliquid $10) : une petite part peut passer sous ce minimum.`,
        options: ["100 % de mon capital disponible", "50 % de mon capital disponible", "25 % de mon capital disponible"],
      },
    };
  }
  return {
    understanding: `Before sizing: free margin ${balances}.`,
    clarify: {
      question: "How much of your available capital should this use?",
      why: `Free margin ${balances}. Every market has a minimum size (Extended per quantity, Hyperliquid $10): a small share can fall under it.`,
      options: ["100% of my available capital", "50% of my available capital", "25% of my available capital"],
    },
  };
}

const isPerp = (l: LLMLeg) => /^(long|short)$/i.test(l.side.trim());
const venueOf = (l: LLMLeg): "Hyperliquid" | "Extended" | null => (/extended/i.test(l.protocol) ? "Extended" : /hyperliquid/i.test(l.protocol) ? "Hyperliquid" : null);
const isDepositTo = (venue: string) => (l: LLMLeg) => /^(deposit|fund)$/i.test(l.side.trim()) && new RegExp(venue, "i").test(l.protocol);

/**
 * Perp legs sized from the venues' free margin: notional = (free + the plan's
 * deposits to that venue − the fee reserve) × share ÷ (1 + margin buffer) ×
 * leverage, split between the venue's perp legs; a neutral pair takes the
 * smaller of its two legs on both. Plans with other priced legs (a
 * Hyperliquid spot buy) or an unknown balance keep the model's sizes, and
 * the economics then say what is missing.
 */
export function sizePerpLegs(s: LLMStrategy, pair: [number, number] | undefined, balances: VenueBalances, share: number): LLMStrategy {
  const legs = s.legs ?? [];
  const perps = legs.map((l, i) => ({ l, i, v: venueOf(l) })).filter((x) => isPerp(x.l) && x.v);
  if (perps.length === 0) return s;
  if (legs.some((l) => /^(buy|swap)$/i.test(l.side.trim()) && venueOf(l) === "Hyperliquid")) return s;
  const free: Record<"Hyperliquid" | "Extended", number | null> = {
    Hyperliquid: balances.hyperliquidFreeUsd === null ? null : balances.hyperliquidFreeUsd + legs.filter(isDepositTo("hyperliquid")).reduce((a, l) => a + (l.sizeUsd ?? 0), 0),
    Extended: balances.extendedFreeUsd === null ? null : balances.extendedFreeUsd + legs.filter(isDepositTo("extended")).reduce((a, l) => a + (l.sizeUsd ?? 0), 0),
  };
  if (perps.some((p) => free[p.v!] === null)) return s;
  const count = (v: "Hyperliquid" | "Extended") => perps.filter((p) => p.v === v).length;
  const sized = new Map<number, number>();
  for (const p of perps) {
    const margin = (Math.max(0, (free[p.v!] as number) - SIZING_POLICY.feeReserveUsd) * share) / count(p.v!);
    sized.set(p.i, (margin / (1 + SIZING_POLICY.marginBufferPct / 100)) * Math.max(1, p.l.leverage ?? 1));
  }
  if (pair && sized.has(pair[0]) && sized.has(pair[1])) {
    const both = Math.min(sized.get(pair[0])!, sized.get(pair[1])!);
    sized.set(pair[0], both);
    sized.set(pair[1], both);
  }
  return { ...s, legs: legs.map((l, i) => (sized.has(i) ? { ...l, sizeUsd: Math.floor(sized.get(i)! * 100) / 100 } : l)) };
}
