/**
 * perpPair.ts — opening both legs of a neutral perp pair in one click.
 *
 * The legs go out one after the other, in the plan's execution sequence (the
 * thinner venue first): the second is sized on what the first actually
 * filled, so both hold the same quantity of the asset. When the second leg
 * fails, the first is closed at once (reduce-only, the filled quantity), so a
 * failed pair never leaves a naked position behind; when the second only
 * partly fills, the first is trimmed to match. Anything the unwind can't close
 * is reported as exposed, with the quantity, never hidden.
 *
 * Pure orchestration: the venues are passed in (components/execute/PerpPairButton
 * wires Hyperliquid, Extended and TxFlow). Unit-tested.
 */

import type { TradeLeg, TradePlan } from "@/lib/tradePlan";

export interface PairFill {
  ok: boolean;
  /** Base quantity filled (0 or undefined: nothing traded). */
  filledQty?: number;
  avgPx?: number;
  /** Venue reference for the strategy tracker ("hyperliquid:ETH:0.5@3000"). */
  ref?: string;
  error?: string;
}

export interface PairVenue {
  /** Market order opening the leg; `qty` set for the second leg (match the first fill). */
  open: (legIndex: number, qty?: number) => Promise<PairFill>;
  /** Reduce-only market order closing `qty` of that leg. */
  close: (legIndex: number, qty: number) => Promise<PairFill>;
}

export type PairStep = { phase: "first" | "second" | "unwinding" | "trimming"; legIndex: number };

export type PairRun =
  | { status: "neutral"; first: Filled; second: Filled; trimmed?: number }
  | { status: "first_failed"; legIndex: number; error: string }
  | { status: "unwound"; first: Filled; secondIndex: number; error: string }
  | { status: "exposed"; legIndex: number; qty: number; error: string; unwindError: string; first: Filled; second?: Filled };

export interface Filled {
  legIndex: number;
  qty: number;
  avgPx?: number;
  ref?: string;
}

/** A second fill within this fraction of the first counts as matched (venue size steps). */
export const PAIR_QTY_TOLERANCE = 0.01;

const filledOf = (legIndex: number, f: PairFill): Filled | null =>
  f.ok && f.filledQty !== undefined && f.filledQty > 0 ? { legIndex, qty: f.filledQty, avgPx: f.avgPx, ref: f.ref } : null;

/** The order the pair is sent in: the plan's execution sequence when it names the two pair legs, else the pair as listed. */
export function pairSequence(plan: Pick<TradePlan, "pair" | "execution">): [number, number] | null {
  const pair = plan.pair?.legs;
  if (!pair) return null;
  const seq = plan.execution?.sequence;
  if (seq && seq.length === 2 && seq.includes(pair[0]) && seq.includes(pair[1]) && seq[0] !== seq[1]) return [seq[0], seq[1]];
  return [pair[0], pair[1]];
}

const PAIR_VENUE = /hyperliquid|extended|txflow/i;
const venueOf = (l: TradeLeg) => (l.protocol || "").toLowerCase().match(PAIR_VENUE)?.[0];
const isPerpLeg = (l: TradeLeg | undefined) => !!l && PAIR_VENUE.test(l.protocol || "") && /^(long|short)$/i.test((l.side || "").trim());

/** One-click pairs: perp legs on two different venues (Hyperliquid, Extended, TxFlow), opposite sides, each with a size. */
export function oneClickPair(plan: Pick<TradePlan, "pair" | "execution" | "legs">): [number, number] | null {
  const seq = pairSequence(plan);
  if (!seq) return null;
  const [a, b] = seq.map((i) => plan.legs[i]);
  if (!isPerpLeg(a) || !isPerpLeg(b)) return null;
  if (a.side.trim().toLowerCase() === b.side.trim().toLowerCase()) return null;
  // Long and short on the same account just net out: a pair spans two venues.
  if (venueOf(a) === venueOf(b)) return null;
  if (!(a.sizeUsd && a.sizeUsd > 0) || !(b.sizeUsd && b.sizeUsd > 0)) return null;
  return seq;
}

const errText = (f: PairFill, fallback: string) => f.error || fallback;

/** Opens the pair: first leg, then the second at the first's quantity; unwinds or trims the first when the second falls short. */
export async function runPerpPair(seq: [number, number], venue: PairVenue, onStep?: (s: PairStep) => void): Promise<PairRun> {
  const [i, j] = seq;
  onStep?.({ phase: "first", legIndex: i });
  const f1 = await venue.open(i).catch((e: unknown): PairFill => ({ ok: false, error: String(e instanceof Error ? e.message : e) }));
  const first = filledOf(i, f1);
  if (!first) return { status: "first_failed", legIndex: i, error: errText(f1, "The first leg didn't fill. Nothing was traded.") };

  onStep?.({ phase: "second", legIndex: j });
  const f2 = await venue.open(j, first.qty).catch((e: unknown): PairFill => ({ ok: false, error: String(e instanceof Error ? e.message : e) }));
  const second = filledOf(j, f2);
  const secondError = errText(f2, "The second leg didn't fill.");

  if (!second) {
    onStep?.({ phase: "unwinding", legIndex: i });
    const u = await venue.close(i, first.qty).catch((e: unknown): PairFill => ({ ok: false, error: String(e instanceof Error ? e.message : e) }));
    const closed = u.ok ? (u.filledQty ?? 0) : 0;
    if (closed >= first.qty * (1 - PAIR_QTY_TOLERANCE)) return { status: "unwound", first, secondIndex: j, error: secondError };
    return { status: "exposed", legIndex: i, qty: first.qty - closed, error: secondError, unwindError: errText(u, "The closing order didn't fill."), first };
  }

  // Rounded: 1 - 0.8 is 0.19999999999999996 in floats, and a venue would read that as a size.
  const excess = Math.round((first.qty - second.qty) * 1e10) / 1e10;
  if (excess <= first.qty * PAIR_QTY_TOLERANCE) return { status: "neutral", first, second };

  // The second leg filled less: bring the first down to the same quantity.
  onStep?.({ phase: "trimming", legIndex: i });
  const t = await venue.close(i, excess).catch((e: unknown): PairFill => ({ ok: false, error: String(e instanceof Error ? e.message : e) }));
  const trimmed = t.ok ? (t.filledQty ?? 0) : 0;
  if (trimmed >= excess * (1 - PAIR_QTY_TOLERANCE)) return { status: "neutral", first: { ...first, qty: first.qty - trimmed }, second, trimmed };
  return {
    status: "exposed",
    legIndex: i,
    qty: excess - trimmed,
    error: `The second leg filled ${second.qty} of ${first.qty}.`,
    unwindError: errText(t, "The trimming order didn't fill."),
    first,
    second,
  };
}
