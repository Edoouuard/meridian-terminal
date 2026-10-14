/**
 * neutralCarry.ts — the beta-neutral ETH carry Meridian can execute with spot
 * legs only (no perp), priced from live Aave and staking rates.
 *
 * The trade, all on one chain:
 *   1. supply USDC on Aave (earns the USDC supply rate, is the collateral);
 *   2. borrow WETH on Aave, a fraction of the USDC — the short ETH side;
 *   3. swap that WETH to a liquid-staking token (wstETH, weETH…) on Uniswap —
 *      the long ETH side, which earns staking rewards;
 *   4. supply the LST on Aave too, as extra collateral.
 * Debt and LST move together with the ETH price, so the position's value
 * barely moves with ETH: the return is the USDC rate plus, on the borrowed
 * part, staking yield minus the WETH borrow rate. Because the LST sits in the
 * same Aave account, a rising ETH price raises collateral almost as fast as
 * debt: liquidation needs a very large ETH rally.
 *
 * Pure: rates in, rows out. The yield-context route feeds the rows to the
 * planner so every number it quotes is computed, not guessed.
 */

/** Share of the USDC that is borrowed as WETH. Low on purpose: it keeps the health factor far from 1. */
export const CARRY_BORROW_SHARE = 0.45;
/** Conservative liquidation thresholds (Aave v3 sets USDC ~0.78 and LSTs ~0.79–0.81 outside e-mode). */
const LT_STABLE = 0.75;
const LT_LST = 0.75;

export interface CarryReserve {
  symbol: string;
  /** Percent. */
  supplyApy: number;
  /** Percent. */
  borrowApy: number;
  /** USD supplied — used to pick the main market when a chain lists a symbol twice. */
  totalSupplyUsd: number;
}

export interface CarryRow {
  chain: string;
  /** The LST that holds the long side. */
  lst: string;
  usdcSupplyApy: number;
  wethBorrowApy: number;
  lstStakingApy: number;
  lstSupplyApy: number;
  /** Net APY on the USDC put in, percent. */
  netApy: number;
  /** Extra APY over just supplying the USDC, percent (negative: not worth it now). */
  edgeApy: number;
  healthFactor: number;
  /** ETH price rise (percent) that would bring the health factor to 1. */
  liquidationRallyPct: number;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/** The deepest reserve per symbol (a chain can list a symbol in several Aave markets). */
function bySymbol(reserves: CarryReserve[]): Map<string, CarryReserve> {
  const out = new Map<string, CarryReserve>();
  for (const r of reserves) {
    const k = r.symbol.toUpperCase();
    const prev = out.get(k);
    if (!prev || r.totalSupplyUsd > prev.totalSupplyUsd) out.set(k, r);
  }
  return out;
}

/**
 * One row per LST that Aave lists on `chain` and that has a live staking
 * yield, best net APY first.
 */
export function neutralCarryRows(
  chain: string,
  reserves: CarryReserve[],
  /** LST symbol (any case) → staking APY in percent. */
  stakingApy: Record<string, number>,
  /** LSTs Meridian can swap into on this chain (tracked token + Uniswap). */
  swappable: string[],
): CarryRow[] {
  const r = bySymbol(reserves);
  const usdc = r.get("USDC");
  const weth = r.get("WETH");
  if (!usdc || !weth || !(weth.borrowApy > 0)) return [];
  const b = CARRY_BORROW_SHARE;
  const healthFactor = LT_STABLE / b + LT_LST;
  // HF(x) = LT_STABLE / (b·x) + LT_LST = 1  →  x = LT_STABLE / (b·(1 − LT_LST))
  const liquidationRallyPct = (LT_STABLE / (b * (1 - LT_LST)) - 1) * 100;

  const rows: CarryRow[] = [];
  for (const lst of swappable) {
    const reserve = r.get(lst.toUpperCase());
    const staking = stakingApy[lst.toUpperCase()];
    if (!reserve || typeof staking !== "number" || !(staking > 0)) continue;
    const spread = staking + reserve.supplyApy - weth.borrowApy;
    rows.push({
      chain,
      lst: lst,
      usdcSupplyApy: round2(usdc.supplyApy),
      wethBorrowApy: round2(weth.borrowApy),
      lstStakingApy: round2(staking),
      lstSupplyApy: round2(reserve.supplyApy),
      netApy: round2(usdc.supplyApy + b * spread),
      edgeApy: round2(b * spread),
      healthFactor: round2(healthFactor),
      liquidationRallyPct: Math.round(liquidationRallyPct),
    });
  }
  return rows.sort((a, b2) => b2.netApy - a.netApy);
}

/** The planner-facing section; empty when no chain has the inputs. */
export function neutralCarrySummary(rows: CarryRow[]): string {
  if (rows.length === 0) return "";
  const pct = Math.round(CARRY_BORROW_SHARE * 100);
  const lines = [
    `\n\n### Beta-neutral ETH carry, spot only (EXECUTABLE now, computed from live Aave + staking rates)`,
    `Legs, all on the row's chain, in this order: (1) Supply USDC on Aave — size C; (2) Borrow WETH on Aave — ${pct}% of C; (3) Swap "WETH → <LST>" on Uniswap — same size as the borrow; (4) Supply <LST> on Aave — 98% of the swap.`,
    `The WETH debt (short ETH) and the LST (long ETH) offset each other: the position's value barely moves with ETH. Return on C = USDC supply + ${pct}% × (LST staking + LST supply − WETH borrow). Quote these numbers exactly.`,
  ];
  for (const r of rows) {
    lines.push(
      `- ${r.chain} | ${r.lst} | net ${r.netApy.toFixed(2)}% on the USDC (USDC ${r.usdcSupplyApy.toFixed(2)}% + ${pct}% × (staking ${r.lstStakingApy.toFixed(2)}% + supply ${r.lstSupplyApy.toFixed(2)}% − WETH borrow ${r.wethBorrowApy.toFixed(2)}%)) | ${r.edgeApy >= 0 ? `+${r.edgeApy.toFixed(2)}% over plain USDC supply` : `${r.edgeApy.toFixed(2)}% vs plain USDC supply: NOT worth it now, say so`} | start health factor ~${r.healthFactor.toFixed(1)}, liquidation only if ETH rallies ~+${r.liquidationRallyPct}%`,
    );
  }
  return lines.join("\n");
}
