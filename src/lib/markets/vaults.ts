/**
 * vaults.ts — the vaults perp DEXs run for depositors (market making,
 * liquidations, or being the counterparty to traders), each read from the
 * protocol's own public API (fetched in /api/perp-vaults) and shown in
 * Yields next to the lending and staking pools.
 *
 * Every parser takes the raw answer and returns one vault, or null when the
 * answer is missing or doesn't carry an APR: a vault is never listed with a
 * guessed figure. Shapes checked against the live APIs on 24 Oct 2026:
 *   - Hyperliquid HLP: POST /info {type: "vaultDetails"} → `apr` (fraction),
 *     `portfolio` [["month", {accountValueHistory}] …];
 *   - Extended Vault: /api/v1/vault/public/summary → data.`last30dApr`
 *     (fraction), data.`equity`;
 *   - Lighter LLP: /api/v1/publicPoolsMetadata?index=…&limit=1 →
 *     public_pools[].`annual_percentage_yield` (%), `total_asset_value`;
 *   - Paradex GigaVault: /v1/vaults/summary?address=… →
 *     results[].`last_month_return` (fraction, already annualised), `tvl`;
 *   - Jupiter JLP: perps-api /v1/jlp-info → `jlpApyPct` (%), `aumUsdFormatted`;
 *   - GMX GLV: /apy?period=30d → glvs[token].`apy` (fraction), and
 *     /glvs/info → glvs[] names and markets[].`balanceUsd` (30 decimals);
 *   - Gains gUSDC: /api/apr?chainId=… → collateralRewards[USDC].`vaultApr`
 *     (%), `vaultTvl` (6 decimals);
 *   - dYdX MegaVault: indexer /v4/vault/v1/megavault/historicalPnl → daily
 *     `equity` and cumulative `totalPnl`; dYdX publishes no APR, so it is
 *     the last 30 days' PnL over the equity at the start, annualised.
 * Each protocol computes its figure its own way; `method` says how.
 */

export const HLP_ADDRESS = "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303";
export const PARADEX_GIGAVAULT_ADDRESS = "0x5f43c92dbe4e995115f351254407e7e84abf04cbe32a536345b9d6c36bc750f";
/** Lighter lists public pools from this account index downwards: the first one is the LLP. */
export const LIGHTER_LLP_QUERY_INDEX = "281474976710655";

export interface PerpVault {
  id: string;
  protocol: string;
  name: string;
  chain: string;
  /** What you deposit. */
  asset: string;
  /** What earns the yield. */
  strategy: string;
  /** The protocol's own APR (or APY), in %. */
  aprPct: number;
  tvlUsd: number | null;
  /** How the protocol computes the figure. */
  method: string;
  lock: string;
  /** Depositors are the counterparty to traders: a winning trader is a loss for the vault. */
  carriesTraderPnl: boolean;
  /** Meridian deposits into it from the terminal; otherwise it is a comparison. */
  executable: boolean;
  url: string;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** An APR outside this band (in %) is a broken feed, not a yield. */
const saneApr = (pct: number | null): pct is number => pct !== null && pct > -100 && pct < 1000;

type HistoryPoint = [number, string | number];

/** HLP from vaultDetails: Hyperliquid's APR; TVL is the latest account value of the month window. */
export function parseHlp(json: unknown): PerpVault | null {
  const d = (json ?? {}) as { apr?: unknown; portfolio?: unknown };
  const apr = num(d.apr);
  if (apr === null || !saneApr(apr * 100)) return null;
  const month = Array.isArray(d.portfolio)
    ? ((d.portfolio as [string, { accountValueHistory?: HistoryPoint[] }][]).find((w) => Array.isArray(w) && w[0] === "month")?.[1] ?? null)
    : null;
  const values = (month?.accountValueHistory ?? []).map((p) => num(p?.[1])).filter((v): v is number => v !== null);
  return {
    id: "hlp",
    protocol: "Hyperliquid",
    name: "HLP",
    chain: "Hyperliquid L1",
    asset: "USDC",
    strategy: "Market making and liquidations on every Hyperliquid market",
    aprPct: apr * 100,
    tvlUsd: values.length ? values[values.length - 1] : null,
    method: "Hyperliquid's APR, from the vault's recent PnL over its equity",
    lock: "4 days per deposit",
    carriesTraderPnl: true,
    executable: true,
    url: "https://app.hyperliquid.xyz/vaults/" + HLP_ADDRESS,
  };
}

/** Extended's vault summary: last-30-day APR and equity. */
export function parseExtendedVault(json: unknown): PerpVault | null {
  const d = ((json as { data?: unknown })?.data ?? {}) as Record<string, unknown>;
  const apr = num(d.last30dApr);
  if (apr === null || !saneApr(apr * 100)) return null;
  return {
    id: "extended",
    protocol: "Extended",
    name: "Extended Vault",
    chain: "Starknet",
    asset: "USDC",
    strategy: "Market making, liquidations, lending in Extended's money market",
    aprPct: apr * 100,
    tvlUsd: num(d.equity),
    method: "Extended's last-30-day APR",
    lock: "24 hours",
    carriesTraderPnl: true,
    executable: false,
    url: "https://app.extended.exchange/vault",
  };
}

/** Lighter's public pools from LIGHTER_LLP_QUERY_INDEX: the pool named LLP. */
export function parseLighterLlp(json: unknown): PerpVault | null {
  const pools = (json as { public_pools?: unknown })?.public_pools;
  const p = Array.isArray(pools) ? (pools as Record<string, unknown>[]).find((x) => /\bLLP\b/.test(String(x?.name ?? ""))) : undefined;
  const apy = num(p?.annual_percentage_yield);
  if (!p || !saneApr(apy)) return null;
  return {
    id: "lighter-llp",
    protocol: "Lighter",
    name: "LLP",
    chain: "Lighter (Ethereum ZK rollup)",
    asset: "USDC",
    strategy: "Market making and liquidations on Lighter",
    aprPct: apy,
    tvlUsd: num(p.total_asset_value),
    method: "Lighter's annualised yield on the pool's share price",
    lock: "None stated",
    carriesTraderPnl: true,
    executable: false,
    url: "https://app.lighter.xyz/public-pools",
  };
}

/** Paradex's vault summary for the GigaVault: last month's return, which Paradex already annualises. */
export function parseParadexVault(json: unknown): PerpVault | null {
  const rows = (json as { results?: unknown })?.results;
  const d = Array.isArray(rows) ? (rows as Record<string, unknown>[]).find((r) => String(r?.address ?? "").toLowerCase() === PARADEX_GIGAVAULT_ADDRESS) : undefined;
  const month = num(d?.last_month_return);
  if (!d || month === null || !saneApr(month * 100)) return null;
  return {
    id: "paradex-gigavault",
    protocol: "Paradex",
    name: "GigaVault",
    chain: "Paradex (Starknet appchain)",
    asset: "USDC",
    strategy: "Market making across Paradex markets, liquidations, platform fees",
    aprPct: month * 100,
    tvlUsd: num(d.tvl),
    method: "Paradex's figure: last month's return, annualised",
    lock: "1 day",
    carriesTraderPnl: true,
    executable: false,
    url: "https://app.paradex.trade/vaults/" + PARADEX_GIGAVAULT_ADDRESS,
  };
}

/** Jupiter's JLP: Jupiter's APY and the pool's AUM. */
export function parseJlp(json: unknown): PerpVault | null {
  const d = (json ?? {}) as Record<string, unknown>;
  const apy = num(d.jlpApyPct);
  if (!saneApr(apy)) return null;
  return {
    id: "jlp",
    protocol: "Jupiter",
    name: "JLP",
    chain: "Solana",
    asset: "SOL, ETH, BTC, USDC, USDT basket",
    strategy: "Counterparty to Jupiter Perps traders: fees, borrow and trader losses",
    aprPct: apy,
    tvlUsd: num(d.aumUsdFormatted),
    method: "Jupiter's APY from the fees paid to the pool (excludes the basket's price moves)",
    lock: "None (swap in and out)",
    carriesTraderPnl: true,
    executable: false,
    url: "https://jup.ag/perps-earn",
  };
}

const GMX_USD_DECIMALS = 1e30;

/** GMX GLVs: APY from /apy, names and TVL (sum of market balances) from /glvs/info. Unlisted GLVs are left out. */
export function parseGmxGlvs(apyJson: unknown, infoJson: unknown, chain: string): PerpVault[] {
  const apy = ((apyJson as { glvs?: unknown })?.glvs ?? {}) as Record<string, { apy?: unknown }>;
  const glvs = (infoJson as { glvs?: unknown })?.glvs;
  if (!Array.isArray(glvs)) return [];
  const byToken = new Map(Object.entries(apy).map(([k, v]) => [k.toLowerCase(), num(v?.apy)]));
  const out: PerpVault[] = [];
  for (const g of glvs as { name?: unknown; glvToken?: unknown; isListed?: unknown; markets?: unknown }[]) {
    if (typeof g?.glvToken !== "string" || g.isListed === false) continue;
    const a = byToken.get(g.glvToken.toLowerCase());
    if (a === null || a === undefined || !saneApr(a * 100)) continue;
    const markets = Array.isArray(g.markets) ? (g.markets as { balanceUsd?: unknown }[]) : [];
    const tvl = markets.reduce((s, m) => s + (num(m?.balanceUsd) ?? 0), 0) / GMX_USD_DECIMALS;
    const name = typeof g.name === "string" ? g.name : "GLV";
    out.push({
      id: `gmx-${g.glvToken.toLowerCase()}`,
      protocol: "GMX",
      name,
      chain,
      asset: name.replace(/^GLV\s*\[|\]$/g, "").replace("-", " / "),
      strategy: "Liquidity for GMX markets, rebalanced across them: fees, borrow and trader losses",
      aprPct: a * 100,
      tvlUsd: tvl > 0 ? tvl : null,
      method: "GMX's 30-day APY (excludes the tokens' price moves)",
      lock: "None (withdraw any time, subject to liquidity)",
      carriesTraderPnl: true,
      executable: false,
      url: "https://app.gmx.io/#/pools",
    });
  }
  return out;
}

/** Gains Network's gUSDC vault on one chain: Gains' vault APR, TVL in USDC (6 decimals). */
export function parseGainsUsdc(json: unknown, chain: string): PerpVault | null {
  const rows = (json as { collateralRewards?: unknown })?.collateralRewards;
  const r = Array.isArray(rows) ? (rows as Record<string, unknown>[]).find((x) => x?.symbol === "USDC") : undefined;
  const apr = num(r?.vaultApr);
  if (!r || !saneApr(apr)) return null;
  const tvl = num(r.vaultTvl);
  return {
    id: `gains-usdc-${chain.toLowerCase()}`,
    protocol: "Gains Network",
    name: "gUSDC",
    chain,
    asset: "USDC",
    strategy: "Counterparty to gTrade traders: fees and trader losses",
    aprPct: apr,
    tvlUsd: tvl !== null ? tvl / 1e6 : null,
    method: "Gains' vault APR from the fees paid to the vault",
    lock: "Withdrawals requested an epoch ahead (1 to 3 epochs)",
    carriesTraderPnl: true,
    executable: false,
    url: "https://gains.trade/vaults",
  };
}

const DAY_MS = 86_400_000;

/** dYdX MegaVault: PnL of the last ~30 days (cumulative totalPnl) over the equity at the start, annualised. Null under 7 days of history. */
export function parseMegavault(json: unknown, now = Date.now()): PerpVault | null {
  const rows = (json as { megavaultPnl?: unknown })?.megavaultPnl;
  if (!Array.isArray(rows)) return null;
  const pts = (rows as Record<string, unknown>[])
    .map((r) => ({ t: Date.parse(String(r?.createdAt ?? "")), equity: num(r?.equity), pnl: num(r?.totalPnl) }))
    .filter((p): p is { t: number; equity: number; pnl: number } => Number.isFinite(p.t) && p.equity !== null && p.pnl !== null)
    .sort((a, b) => a.t - b.t);
  if (pts.length < 2) return null;
  const last = pts[pts.length - 1];
  const start = pts.find((p) => p.t >= now - 30 * DAY_MS) ?? pts[0];
  const days = (last.t - start.t) / DAY_MS;
  if (days < 7 || !(start.equity > 0)) return null;
  const aprPct = ((last.pnl - start.pnl) / start.equity) * (365 / days) * 100;
  if (!saneApr(aprPct)) return null;
  return {
    id: "dydx-megavault",
    protocol: "dYdX",
    name: "MegaVault",
    chain: "dYdX Chain",
    asset: "USDC",
    strategy: "Market making across dYdX markets",
    aprPct,
    tvlUsd: last.equity,
    method: "Meridian's figure: last 30 days' PnL over the equity at the start, annualised (dYdX publishes none)",
    lock: "None (withdrawals may pay a slippage fee)",
    carriesTraderPnl: true,
    executable: false,
    url: "https://dydx.trade/vaults",
  };
}

/** The vaults that answered, highest APR first. */
export function rankVaults(vaults: (PerpVault | null)[]): PerpVault[] {
  return vaults.filter((v): v is PerpVault => v !== null).sort((a, b) => b.aprPct - a.aprPct);
}
