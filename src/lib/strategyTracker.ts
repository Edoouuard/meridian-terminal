/**
 * strategyTracker.ts — the strategies a user has put to work, so they can be
 * monitored after the chat has moved on.
 *
 * A strategy is tracked from its first confirmed step: each confirmed leg
 * stores its transaction, and once every leg is confirmed the strategy is
 * "live" (completedAt). Stored in localStorage per browser, scoped to the
 * wallet that signed. The pure functions (`strategyId`, `applyLegConfirmed`,
 * `estimatedEarnedUsd`, `matchOpportunity`) are unit-tested.
 */

import { useSyncExternalStore } from "react";
import type { TradeLeg, TradePlan } from "@/lib/tradePlan";
import { strategyView } from "@/lib/strategyView";

export const STRATEGIES_KEY = "meridian:strategies";
const LIMIT = 50;

export interface TrackedLeg {
  side: string;
  asset: string;
  protocol: string;
  chain?: string;
  sizeUsd?: number;
  status: "pending" | "confirmed";
  hash?: string;
  chainId?: number;
  confirmedAt?: number;
}

export interface TrackedStrategy {
  id: string;
  title: string;
  summary: string;
  /** Lowercased address that signed the first step. */
  owner?: string;
  apyPct?: number;
  apyKind: "fixed" | "variable";
  sizeUsd?: number;
  tier?: string;
  exit?: string;
  createdAt: number;
  /** Set when the last leg confirms: the strategy is live from then on. */
  completedAt?: number;
  legs: TrackedLeg[];
}

export interface ConfirmInfo {
  hash: string;
  chainId?: number;
  owner?: string;
}

/** Stable id for a plan: the same strategy rendered again maps to the same entry. */
export function strategyId(plan: TradePlan): string {
  const key = [plan.variantLabel ?? plan.intent, ...plan.legs.map((l) => `${l.side}|${l.asset}|${l.protocol}|${l.chain ?? ""}|${Math.round(l.sizeUsd ?? 0)}`)].join("§");
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `s${(h >>> 0).toString(36)}`;
}

function trackedFromPlan(plan: TradePlan, now: number, owner?: string): TrackedStrategy {
  const view = strategyView(plan);
  return {
    id: strategyId(plan),
    title: plan.variantLabel || plan.summary.split(/[.—]/)[0].slice(0, 80) || "Strategy",
    summary: plan.summary,
    owner: owner?.toLowerCase(),
    apyPct: view.apyPct,
    apyKind: view.apyKind,
    sizeUsd: view.sizeUsd,
    tier: view.tier,
    exit: view.exit,
    createdAt: now,
    legs: plan.legs.map((l: TradeLeg) => ({
      side: l.side,
      asset: l.asset,
      protocol: l.protocol,
      chain: l.chain,
      sizeUsd: l.sizeUsd,
      status: "pending" as const,
    })),
  };
}

/**
 * Record a confirmed leg (pure). Returns the new list, the updated strategy,
 * and whether this confirmation completed it. Confirming the same hash twice
 * is a no-op.
 */
export function applyLegConfirmed(
  list: TrackedStrategy[],
  plan: TradePlan,
  legIndex: number,
  info: ConfirmInfo,
  now: number,
): { list: TrackedStrategy[]; strategy: TrackedStrategy | null; changed: boolean; justCompleted: boolean } {
  const id = strategyId(plan);
  const existing = list.find((s) => s.id === id);
  const base = existing ?? trackedFromPlan(plan, now, info.owner);
  const leg = base.legs[legIndex];
  if (!leg) return { list, strategy: existing ?? null, changed: false, justCompleted: false };
  if (leg.status === "confirmed" && leg.hash === info.hash) return { list, strategy: base, changed: false, justCompleted: false };

  const legs = base.legs.map((l, i) =>
    i === legIndex ? { ...l, status: "confirmed" as const, hash: info.hash, chainId: info.chainId, confirmedAt: now } : l,
  );
  const live = isLive(legs);
  const strategy: TrackedStrategy = { ...base, legs, completedAt: base.completedAt ?? (live ? now : undefined) };
  const justCompleted = live && base.completedAt === undefined;
  const rest = list.filter((s) => s.id !== id);
  return { list: [strategy, ...rest].slice(0, LIMIT), strategy, changed: true, justCompleted };
}

/** Bridges, swaps and transfers only move funds into place; the other legs earn. */
export function isMoveLeg(l: Pick<TrackedLeg, "side">): boolean {
  return /^(bridge|swap|transfer)$/i.test(l.side.trim());
}

/**
 * A strategy is live once every leg that earns has confirmed. A bridge the
 * planner added to top up funds may never be needed (the user already had
 * the funds where they go), so pending moves don't hold a strategy back.
 * Without any earning leg (a pure move), every leg must confirm.
 */
function isLive(legs: TrackedLeg[]): boolean {
  const earning = legs.filter((l) => !isMoveLeg(l));
  return (earning.length > 0 ? earning : legs).every((l) => l.status === "confirmed");
}

/** When the strategy went live (also for entries stored before the earning-leg rule). */
export function liveSince(s: TrackedStrategy): number | undefined {
  if (s.completedAt !== undefined) return s.completedAt;
  if (!isLive(s.legs)) return undefined;
  const times = s.legs.filter((l) => !isMoveLeg(l) && l.confirmedAt !== undefined).map((l) => l.confirmedAt as number);
  return times.length > 0 ? Math.max(...times) : s.createdAt;
}

/** How a leg reads in the monitor: a move still pending on a live strategy wasn't needed. */
export function legState(s: TrackedStrategy, i: number): "confirmed" | "pending" | "skipped" {
  const l = s.legs[i];
  if (l.status === "confirmed") return "confirmed";
  return liveSince(s) !== undefined && isMoveLeg(l) ? "skipped" : "pending";
}

/** What is actually put to work: the earning legs' size (bridges move the same money), else the plan size. */
export function deployedUsd(s: TrackedStrategy): number | undefined {
  const earning = s.legs.filter((l) => !isMoveLeg(l) && l.sizeUsd !== undefined);
  if (earning.length > 0) return earning.reduce((sum, l) => sum + (l.sizeUsd as number), 0);
  return s.sizeUsd;
}

/** Rough earnings since the strategy went live, at its entry APY. */
export function estimatedEarnedUsd(s: TrackedStrategy, now: number): number | undefined {
  const since = liveSince(s);
  const size = deployedUsd(s);
  if (since === undefined || !s.apyPct || !size) return undefined;
  const years = Math.max(0, now - since) / (365 * 24 * 3600 * 1000);
  return size * (s.apyPct / 100) * years;
}

/** The leg that earns the yield: the last one that isn't a move (bridge/swap/transfer). */
export function earningLeg(s: TrackedStrategy): TrackedLeg | undefined {
  return [...s.legs].reverse().find((l) => !isMoveLeg(l));
}

export interface OpportunityLike {
  protocol: string;
  chain: string;
  symbol: string;
  apy: number;
}

/** Today's rate for the strategy's earning leg, from the live opportunities feed. */
export function matchOpportunity(s: TrackedStrategy, opps: OpportunityLike[]): OpportunityLike | undefined {
  const leg = earningLeg(s);
  if (!leg) return undefined;
  const norm = (v: string | undefined) => (v ?? "").toLowerCase().replace(/\s+/g, "");
  const proto = norm(leg.protocol);
  return opps.find(
    (o) =>
      (norm(o.protocol) === proto || proto.startsWith(norm(o.protocol))) &&
      norm(o.symbol) === norm(leg.asset) &&
      (!leg.chain || norm(o.chain) === norm(leg.chain)),
  );
}

// ── Store ───────────────────────────────────────────────────────────────

type Listener = () => void;
const listeners = new Set<Listener>();
let cache: TrackedStrategy[] | null = null;
const EMPTY: TrackedStrategy[] = [];

function read(): TrackedStrategy[] {
  if (cache) return cache;
  if (typeof window === "undefined") return EMPTY;
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STRATEGIES_KEY) ?? "[]");
    cache = Array.isArray(parsed) ? (parsed as TrackedStrategy[]).filter((s) => s && typeof s.id === "string" && Array.isArray(s.legs)) : [];
  } catch {
    cache = [];
  }
  return cache;
}

function write(list: TrackedStrategy[]): void {
  cache = list;
  try {
    window.localStorage.setItem(STRATEGIES_KEY, JSON.stringify(list));
  } catch {
    /* quota / private mode: keep the in-memory copy */
  }
  listeners.forEach((l) => l());
}

export function recordLegConfirmed(plan: TradePlan, legIndex: number, info: ConfirmInfo) {
  const res = applyLegConfirmed(read(), plan, legIndex, info, Date.now());
  if (res.changed) write(res.list);
  return res;
}

export function removeStrategy(id: string): void {
  write(read().filter((s) => s.id !== id));
}

function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Tracked strategies, newest first; scoped to `owner` when given (plus any without an owner). */
export function useTrackedStrategies(owner?: string): TrackedStrategy[] {
  const all = useSyncExternalStore(subscribe, read, () => EMPTY);
  if (!owner) return all;
  const o = owner.toLowerCase();
  return all.filter((s) => !s.owner || s.owner === o);
}

// ── Celebration bus ─────────────────────────────────────────────────────

export const CELEBRATE_EVENT = "meridian:celebrate";
export const OPEN_STRATEGIES_EVENT = "meridian:open-strategies";

export interface CelebrateDetail {
  kind: "step" | "strategy";
  strategy: TrackedStrategy;
  legIndex: number;
}

export function celebrate(detail: CelebrateDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<CelebrateDetail>(CELEBRATE_EVENT, { detail }));
}

export function openStrategies(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(OPEN_STRATEGIES_EVENT));
}

/** Record a confirmed leg and fire the matching celebration (step, or the whole strategy). */
export function confirmStrategyLeg(plan: TradePlan, legIndex: number, info: ConfirmInfo): void {
  const { strategy, changed, justCompleted } = recordLegConfirmed(plan, legIndex, info);
  if (!strategy || !changed) return;
  celebrate({ kind: justCompleted ? "strategy" : "step", strategy, legIndex });
}
