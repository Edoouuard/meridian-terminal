/**
 * strategyFlow.ts — asset-flow check for LLM-built strategies.
 *
 * The strategy engine (api/parse-intent) sometimes writes a leg that deposits
 * an asset the strategy never acquired — e.g. "Bridge USDC to Base" followed by
 * "Supply GHO on Aave": nothing turned the USDC into GHO, so that leg cannot be
 * executed. This walks the legs in order, tracks which assets the strategy
 * holds at each step, and inserts the missing swap right before the leg that
 * needs it. Pure — no network, fully unit-testable.
 */

export interface FlowLeg {
  side: string;
  asset: string;
  protocol: string;
  sizeUsd?: number;
  leverage?: number;
  note?: string;
}

/** Same economic asset under another ticker (wrapped native, bridged USDC). */
const ALIASES: Record<string, string> = {
  WETH: "ETH",
  "USDC.E": "USDC",
  USDBC: "USDC",
};

/** Ethereum liquid-staking receipts: staking into them consumes ETH. */
const ETH_STAKING_RECEIPT = /^(ST|WST|R|CB|WE|EE|SW|OS|M|SFRX|FRX|ANKR|OETH)ETH$/;

export function normalizeAsset(symbol: string): string {
  const s = symbol.trim().toUpperCase().replace(/\s+(PERP|PERPETUAL)$/, "");
  return ALIASES[s] ?? s;
}

/** Split "USDC → ETH" (or "->", " to ") into [from, to]; null when it isn't a pair. */
function splitPair(asset: string): [string, string] | null {
  const m = asset.match(/^\s*(.+?)\s*(?:→|->|=>|\bto\b)\s*(.+?)\s*$/i);
  return m ? [m[1], m[2]] : null;
}

interface LegFlow {
  /** Asset the leg needs in hand before it can run. */
  consumes?: string;
  /** Asset the strategy holds after the leg. */
  produces?: string;
}

/** Base assets a vault share token can wrap ("EDGEUSDC" → USDC). Longest first so WETH wins over ETH. */
const VAULT_BASES = ["USDC", "USDT", "WETH", "WBTC", "USDE", "EURC", "DAI", "GHO", "ETH"];

/**
 * What a deposit actually spends. On vault protocols the model sometimes names
 * the vault's share token ("Supply EDGEUSDC on Morpho") — depositing into that
 * vault spends its base asset (USDC), not the share token.
 */
function depositedAsset(protocol: string, asset: string): string {
  if (!/morpho|yearn|beefy|euler|vault/i.test(protocol)) return asset;
  const base = VAULT_BASES.find((b) => asset.length > b.length && asset.endsWith(b));
  return base ? normalizeAsset(base) : asset;
}

/** An LP position like "WETH-USDC", "ETH/USDC" or "WETH-USDC LP" — two tokens, not one asset. */
function isLpPair(asset: string): boolean {
  return /^\s*[A-Za-z0-9.]+\s*[-/]\s*[A-Za-z0-9.]+(?:\s+(?:LP|POOL|POSITION))?\s*$/i.test(asset);
}

function legFlow(leg: FlowLeg): LegFlow {
  const side = leg.side.trim().toLowerCase();
  // LP legs spend both tokens of the pair in proportions only the pool knows — not tracked.
  if (isLpPair(leg.asset)) return {};
  const pair = splitPair(leg.asset);
  // "USDC → WETH-USDC LP" is how the model writes entering a pool — same as an LP leg.
  if (pair && isLpPair(pair[1])) return {};
  switch (side) {
    case "swap":
    case "buy":
      return pair
        ? { consumes: normalizeAsset(pair[0]), produces: normalizeAsset(pair[1]) }
        : { produces: normalizeAsset(leg.asset) };
    case "bridge": {
      const a = normalizeAsset(pair ? pair[0] : leg.asset);
      return { consumes: a, produces: normalizeAsset(pair ? pair[1] : leg.asset) };
    }
    case "supply":
    case "restake":
      return { consumes: depositedAsset(leg.protocol, normalizeAsset(pair ? pair[1] : leg.asset)) };
    case "stake": {
      const receipt = normalizeAsset(pair ? pair[1] : leg.asset);
      if (pair) return { consumes: normalizeAsset(pair[0]), produces: receipt };
      return ETH_STAKING_RECEIPT.test(receipt) ? { consumes: "ETH", produces: receipt } : { consumes: receipt };
    }
    case "borrow":
    case "withdraw":
      return { produces: normalizeAsset(leg.asset) };
    default:
      // Long / Short (perp margin lives on the venue), Repay, Transfer: not tracked.
      return {};
  }
}

export interface FlowResult<L extends FlowLeg> {
  legs: L[];
  /** Assets a swap was inserted for, in order. */
  insertedFor: string[];
  /** Human-readable account of every pointless swap that was dropped. */
  dropped: string[];
}

/**
 * Insert the swaps a strategy is missing so every deposit-type leg (Supply,
 * Stake, Restake, Bridge) spends an asset the strategy actually holds.
 *
 * `startingAssets` are what the user holds (wallet holdings, or the assets
 * named in their request). When it's empty, the first asset a leg spends is
 * assumed to be held — nothing better is known.
 */
export function ensureAssetFlow<L extends FlowLeg>(legs: L[], startingAssets: string[]): FlowResult<L> {
  const held = new Set(startingAssets.map(normalizeAsset));
  const out: L[] = [];
  const insertedFor: string[] = [];
  const dropped: string[] = [];
  let lastProduced: string | undefined;

  for (const leg of legs) {
    const { consumes, produces } = legFlow(leg);

    // A swap that buys something already held, paid with something that
    // isn't, is pointless (and funding it would mean a circular swap): drop it.
    if (
      leg.side.trim().toLowerCase() === "swap" && consumes && produces &&
      held.size > 0 && !held.has(consumes) && held.has(produces)
    ) {
      dropped.push(`Removed "${leg.side} ${leg.asset}" — ${produces} is already held and there is no ${consumes} to pay with.`);
      continue;
    }

    if (consumes) {
      if (held.size === 0) held.add(consumes);
      if (!held.has(consumes)) {
        const source = lastProduced && lastProduced !== consumes
          ? lastProduced
          : [...held].find((a) => a !== consumes);
        if (source) {
          out.push({
            side: "Swap",
            asset: `${source} → ${consumes}`,
            protocol: "LI.FI",
            ...(leg.sizeUsd !== undefined ? { sizeUsd: leg.sizeUsd } : {}),
            note: `Swap ${source} into ${consumes} first — the next leg needs ${consumes}, which the strategy didn't hold yet (added automatically).`,
          } as L);
          insertedFor.push(consumes);
          held.add(consumes);
          lastProduced = consumes;
        }
      }
    }

    out.push(leg);
    if (produces) {
      held.add(produces);
      lastProduced = produces;
    }
  }

  return { legs: out, insertedFor, dropped };
}

/** The APY/APR a leg's note quotes ("currently earning 24.39% APY", "borrow rate of 29.35%"), or null. */
export function quotedRatePct(note: string | undefined): number | null {
  if (!note) return null;
  const m = note.match(/(-?\d+(?:\.\d+)?)\s*%\s*(?:APY|APR)/i) ?? note.match(/rate (?:of|is|at)\s*(-?\d+(?:\.\d+)?)\s*%/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

export interface LoopResult<L extends FlowLeg> {
  legs: L[];
  /** Human-readable account of every loop that was removed. */
  removed: string[];
}

/**
 * Remove borrow-and-resupply loops that lose money: a "Borrow X" leg followed
 * by a "Supply X" leg, where the borrow rate quoted in the notes is at or above
 * the supply rate. Loops whose rates aren't both quoted are left alone.
 */
export function removeNegativeCarryLoops<L extends FlowLeg>(legs: L[]): LoopResult<L> {
  const drop = new Set<number>();
  const removed: string[] = [];
  legs.forEach((borrow, i) => {
    if (borrow.side.trim().toLowerCase() !== "borrow" || drop.has(i)) return;
    const asset = normalizeAsset(borrow.asset);
    const j = legs.findIndex((l, k) =>
      k > i && !drop.has(k) && ["supply", "restake"].includes(l.side.trim().toLowerCase()) && normalizeAsset(l.asset) === asset,
    );
    if (j < 0) return;
    const borrowRate = quotedRatePct(borrow.note);
    const supplyRate = quotedRatePct(legs[j].note);
    if (borrowRate === null || supplyRate === null || borrowRate < supplyRate) return;
    drop.add(i);
    drop.add(j);
    removed.push(`Removed the ${asset} borrow-and-resupply loop — borrowing at ${borrowRate}% to earn ${supplyRate}% loses money.`);
  });
  return { legs: legs.filter((_, k) => !drop.has(k)), removed };
}

export interface BudgetResult<L extends FlowLeg> {
  legs: L[];
  /** Human-readable account of every leg that was resized or removed. */
  adjustments: string[];
}

/**
 * Keep a strategy within what the user actually has: walk the legs with a
 * running USD balance per asset and shrink (or drop) any leg that spends more
 * than is left — e.g. "Supply 3000 USDC" then "Bridge 3000 USDC" out of 3000.
 *
 * Only assets with a known amount are enforced: the ones in `budgetsUsd`, and
 * anything an earlier leg produced. A leg consuming an asset of unknown amount
 * is left as is. Run after `ensureAssetFlow`.
 */
export function fitToBudget<L extends FlowLeg>(legs: L[], budgetsUsd: Record<string, number>): BudgetResult<L> {
  const balance = new Map<string, number>();
  for (const [asset, usd] of Object.entries(budgetsUsd)) {
    const a = normalizeAsset(asset);
    balance.set(a, (balance.get(a) ?? 0) + Math.max(0, usd));
  }
  if (balance.size === 0) return { legs, adjustments: [] };

  const out: L[] = [];
  const adjustments: string[] = [];
  for (const leg of legs) {
    const { consumes, produces } = legFlow(leg);
    let size = leg.sizeUsd ?? 0;
    let kept: L | null = leg;

    if (consumes && balance.has(consumes)) {
      const available = Math.floor(balance.get(consumes)! + 1e-9);
      if (size > available + 0.5) {
        if (available < 1) {
          adjustments.push(`Removed "${leg.side} ${leg.asset}" — no ${consumes} left for it.`);
          kept = null;
          size = 0;
        } else {
          adjustments.push(`Resized "${leg.side} ${leg.asset}" from $${size} to $${available} — only $${available} of ${consumes} was left.`);
          kept = { ...leg, sizeUsd: available };
          size = available;
        }
      }
      balance.set(consumes, Math.max(0, balance.get(consumes)! - size));
    }
    if (produces) balance.set(produces, (balance.get(produces) ?? 0) + size);
    if (kept) out.push(kept);
  }
  return { legs: out, adjustments };
}

const STABLECOINS = new Set(["USDC", "USDT", "DAI", "USDE", "USDS", "GHO", "PYUSD", "FRAX", "LUSD", "USDP", "TUSD", "CRVUSD"]);

/**
 * Stablecoin amounts stated in free text: "I have 5,000 USDC" → { USDC: 5000 }.
 * Only stablecoins — their USD value is their amount, so no price is needed.
 */
export function stableBudgetsMentioned(text: string): Record<string, number> {
  const budgets: Record<string, number> = {};
  const re = /\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(k)?\s+([A-Za-z]{2,8})\b/gi;
  for (const m of text.matchAll(re)) {
    const symbol = normalizeAsset(m[3]);
    if (!STABLECOINS.has(symbol)) continue;
    const amount = parseFloat(m[1].replace(/,/g, "")) * (m[2] ? 1000 : 1);
    if (Number.isFinite(amount) && amount > 0) budgets[symbol] = (budgets[symbol] ?? 0) + amount;
  }
  return budgets;
}

/** Ticker-like words in free text that match a known asset ("I have 5000 USDC" → ["USDC"]). */
export function assetsMentioned(text: string, knownAssets: Iterable<string>): string[] {
  const words = new Set((text.toUpperCase().match(/\b[A-Z][A-Z0-9.]{1,9}\b/g) ?? []).map(normalizeAsset));
  const found: string[] = [];
  for (const a of knownAssets) {
    const n = normalizeAsset(a);
    if (words.has(n) && !found.includes(n)) found.push(n);
  }
  return found;
}
