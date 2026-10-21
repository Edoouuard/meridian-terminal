/**
 * strategyExit.ts — getting out of a tracked strategy, and what it's worth now.
 *
 * Exit: the confirmed steps undone in reverse order, each through a path
 * Meridian already executes (vault / lending withdraw, Lido unstake request,
 * Hyperliquid spot sell and withdrawal, swap back). Steps that can't be undone
 * from Meridian (perps, a Pendle PT before maturity, EigenLayer's queue,
 * sUSDe's cooldown) become notes saying where and how. Bridges, transfers and
 * wraps aren't undone: the funds simply stay where they are.
 *
 * Value now: the live position behind each confirmed deposit (vault shares,
 * EigenLayer, HLP), summed when every earning step is found. Pure, unit-tested.
 */

import type { TradeLeg, TradePlan } from "@/lib/tradePlan";
import type { TrackedLeg, TrackedStrategy } from "@/lib/strategyTracker";
import { findVault, vaultProtocolFor } from "@/lib/protocols/vaults";
import { CHAIN_LABEL } from "@/lib/onchain";

export interface ExitPlan {
  legs: TradeLeg[];
  /** What Meridian can't undo here, and how to do it. */
  notes: string[];
}

const side = (l: TrackedLeg) => l.side.trim().toLowerCase();
const isPerp = (l: TrackedLeg) => /^(long|short)$/.test(side(l));
const is = (l: TrackedLeg, re: RegExp) => re.test(l.protocol);
const chainIdOf = (name?: string) => Number(Object.entries(CHAIN_LABEL).find(([, label]) => label.toLowerCase() === (name ?? "").toLowerCase())?.[0] ?? 0);

/** The reverse of one confirmed step: a leg Meridian runs, a note, or nothing (funds stay put). */
function undo(l: TrackedLeg): { leg?: TradeLeg; note?: string } {
  const s = side(l);
  const base = { protocol: l.protocol, chain: l.chain, sizeUsd: l.sizeUsd };
  if (isPerp(l)) return { note: `Close the ${l.asset.replace(/\s*PERP$/i, "")} ${s} on ${l.protocol} in Risk → Perp positions (one click, at market).` };
  if (s === "bridge" || s === "transfer" || s === "wrap" || s === "approve") return {};

  if (s === "swap") {
    const [from, to] = l.asset.split(/\s*(?:→|->)\s*/);
    return from && to ? { leg: { ...base, side: "Swap", asset: `${to} → ${from}`, note: "Swap back to what the strategy started with." } } : {};
  }
  if (s === "borrow") return { leg: { ...base, side: "Repay", asset: l.asset, note: "Repay the loan before taking the collateral out." } };

  if (is(l, /pendle/i)) return { note: `${l.asset} pays its fixed rate only if held to maturity: redeem it then, or sell it earlier on app.pendle.finance (at the market price).` };
  if (is(l, /eigen/i)) return { note: "Restaked stETH leaves EigenLayer through its withdrawal queue (~14 days): start it in the EigenLayer app." };
  if (is(l, /lido/i) && (s === "stake" || s === "supply")) {
    return { leg: { ...base, side: "Withdraw", asset: "stETH", protocol: "Lido", chain: "Ethereum", note: "Requests ETH back from Lido's queue (usually 1-5 days), then claim it." } };
  }

  if (is(l, /hyperliquid/i)) {
    if (/\bhlp\b/i.test(l.asset)) return { note: "HLP: withdraw from the vault in the Hyperliquid app once its 4-day lock-up has passed." };
    if ((s === "stake" || s === "delegate") && /\bhype\b/i.test(l.asset)) return { note: "Staked HYPE: undelegate in the Hyperliquid app; it comes back to spot after the 7-day unstaking queue." };
    if (s === "buy") return { leg: { ...base, side: "Sell", asset: l.asset.replace(/\s*\(.*\)$/, ""), chain: "HyperEVM", note: "Sell back to USDC on Hyperliquid spot." } };
    if (s === "deposit" || s === "fund") return { leg: { ...base, side: "Withdraw", asset: "USDC", chain: "Arbitrum", note: "Back to your wallet on Arbitrum in ~5 min ($1 fee)." } };
    return {};
  }

  if (s === "supply" || s === "deposit" || s === "stake" || s === "restake") {
    const vault = vaultProtocolFor(l.protocol) ? findVault(l.protocol, l.asset, chainIdOf(l.chain)) : undefined;
    if (vault && !vault.instantWithdraw) return { note: `${vault.shareSymbol}: ${vault.exit}. Start the withdrawal in ${vault.protocol}'s app.` };
    return { leg: { ...base, side: "Withdraw", asset: l.asset, note: "Takes the deposit (and what it earned up to this size) back to your wallet." } };
  }
  return {};
}

/** Reverse plan for the steps that confirmed, last step first. */
export function exitPlan(s: TrackedStrategy): ExitPlan {
  const legs: TradeLeg[] = [];
  const notes: string[] = [];
  // stETH restaked on EigenLayer isn't in the wallet: Lido can only unstake it once it's out of EigenLayer's queue.
  const restaked = s.legs.some((l) => l.status === "confirmed" && is(l, /eigen/i));
  for (const l of [...s.legs].reverse()) {
    if (l.status !== "confirmed") continue;
    if (restaked && is(l, /lido/i)) {
      notes.push("Once the stETH is out of EigenLayer, ask Meridian to unstake it on Lido.");
      continue;
    }
    const r = undo(l);
    if (r.leg) legs.push(r.leg);
    if (r.note && !notes.includes(r.note)) notes.push(r.note);
  }
  return { legs, notes };
}

/** The exit as a chat plan the existing execution flow runs (each step signed, nothing automatic). */
export function exitTradePlan(s: TrackedStrategy, exit: ExitPlan = exitPlan(s)): TradePlan {
  return {
    intent: "withdraw",
    legs: exit.legs,
    summary: exit.legs.length
      ? `Exit “${s.title}”: ${exit.legs.length} step${exit.legs.length > 1 ? "s" : ""}, last step first, each signed by you.${exit.notes.length ? " " + exit.notes.join(" ") : ""}`
      : `Nothing to undo from Meridian for “${s.title}”. ${exit.notes.join(" ")}`.trim(),
    variantLabel: "Exit",
    exit: "As each step allows",
    exitOf: s.id,
  };
}

export interface PositionLike {
  symbol: string;
  venue: string;
  chain: string;
  usd: number;
}

/** The live position a confirmed deposit sits in, when the portfolio reads that venue. */
export function positionFor(l: TrackedLeg, positions: PositionLike[]): PositionLike | undefined {
  const s = side(l);
  if (!(s === "supply" || s === "deposit" || s === "stake" || s === "restake")) return undefined;
  const chain = (l.chain ?? "").toLowerCase();
  const vault = vaultProtocolFor(l.protocol) ? findVault(l.protocol, l.asset, chainIdOf(l.chain)) : undefined;
  if (vault) return positions.find((p) => p.venue === `${vault.protocol} vault · ${vault.shareSymbol}` && p.chain.toLowerCase() === chain);
  if (is(l, /eigen/i)) return positions.find((p) => p.venue === "EigenLayer");
  if (is(l, /hyperliquid/i) && /\bhlp\b/i.test(l.asset)) return positions.find((p) => p.venue === "Hyperliquid HLP");
  if (is(l, /hyperliquid/i) && /\bhype\b/i.test(l.asset)) return positions.find((p) => p.venue === "Hyperliquid staking");
  if (is(l, /morpho/i)) return positions.find((p) => p.venue.startsWith("Morpho vault") && p.chain.toLowerCase() === chain && p.symbol.toUpperCase() === l.asset.toUpperCase());
  return undefined;
}

/**
 * What the strategy's deposits are worth now, when every earning step's
 * position is read; undefined otherwise (a lending account or a perp mixes
 * other money in). The figure includes anything else the user holds in the
 * same vault, which the UI says.
 */
export function currentValueUsd(s: TrackedStrategy, positions: PositionLike[]): number | undefined {
  // A Hyperliquid account deposit or Lido stake mixes into a balance the user holds anyway; HLP and staked HYPE are positions of their own.
  const ownPosition = (l: TrackedLeg) => !is(l, /hyperliquid|extended|lido/i) || /\b(hlp|hype)\b/i.test(l.asset);
  const deposits = s.legs.filter((l) => l.status === "confirmed" && /^(supply|deposit|stake|restake)$/.test(side(l)) && ownPosition(l));
  if (deposits.length === 0 || s.legs.some((l) => l.status === "confirmed" && isPerp(l))) return undefined;
  let sum = 0;
  const seen = new Set<PositionLike>();
  for (const l of deposits) {
    const p = positionFor(l, positions);
    if (!p) return undefined;
    if (!seen.has(p)) sum += p.usd;
    seen.add(p);
  }
  return sum;
}
