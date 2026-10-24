/**
 * vaults.ts — the vaults perp exchanges run themselves (market making,
 * liquidations), side by side: TVL, the exchange's own APR, the 30-day
 * return when the feed gives one, the lock, and where to deposit.
 *
 * Each figure comes from the exchange's public API (fetched in
 * /api/perp-vaults); a vault whose API doesn't answer is listed with no
 * numbers rather than a guessed one. Read on 24 Oct 2026:
 *   - Hyperliquid HLP: POST /info {type: "vaultDetails"} → `apr` (fraction)
 *     and `portfolio` histories (account value, PnL by window);
 *   - Extended Vault: GET /api/v1/vault/public/summary → `equity`,
 *     `last30dApr` (fraction), `numberOfDepositors`;
 *   - Paradex GigaVault: GET /v1/vaults/summary?address=… → `tvl`,
 *     `roi_30d` (fraction, not annualised), `last_month_return` (already
 *     annualised: 0.206 next to a 30-day ROI of 0.0157), `num_depositors`.
 * Each exchange computes its APR its own way; the `aprMethod` line says how.
 */

export const HLP_ADDRESS = "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303";
export const PARADEX_GIGAVAULT_ADDRESS = "0x5f43c92dbe4e995115f351254407e7e84abf04cbe32a536345b9d6c36bc750f";

export interface PerpVault {
  id: "hlp" | "extended" | "paradex";
  name: string;
  venue: string;
  chain: string;
  asset: string;
  /** What earns the yield. */
  strategy: string;
  tvlUsd: number | null;
  /** The exchange's own APR, in %. */
  aprPct: number | null;
  /** How the exchange computes it. */
  aprMethod: string;
  /** Return over the last 30 days, in % (not annualised), when the feed gives it. */
  return30dPct: number | null;
  depositors: number | null;
  lock: string;
  /** Meridian deposits into it from the terminal (a prompt), else the exchange's page. */
  meridianPrompt?: string;
  url: string;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

const STATIC: Record<PerpVault["id"], Omit<PerpVault, "tvlUsd" | "aprPct" | "return30dPct" | "depositors">> = {
  hlp: {
    id: "hlp",
    name: "HLP",
    venue: "Hyperliquid",
    chain: "Hyperliquid L1",
    asset: "USDC",
    strategy: "Market making and liquidations",
    aprMethod: "Hyperliquid's figure, from the vault's recent PnL over its equity",
    lock: "4 days per deposit",
    meridianPrompt: "Deposit USDC into Hyperliquid's HLP vault",
    url: "https://app.hyperliquid.xyz/vaults/" + HLP_ADDRESS,
  },
  extended: {
    id: "extended",
    name: "Extended Vault",
    venue: "Extended",
    chain: "Starknet",
    asset: "USDC",
    strategy: "Liquidations, lending in Extended's money market, a share of fees",
    aprMethod: "Extended's last-30-day APR",
    lock: "24 hours",
    url: "https://app.extended.exchange/vault",
  },
  paradex: {
    id: "paradex",
    name: "GigaVault",
    venue: "Paradex",
    chain: "Paradex (Starknet appchain)",
    asset: "USDC",
    strategy: "Market making across Paradex markets, liquidations, platform fees",
    aprMethod: "Paradex's figure: last month's return, annualised",
    lock: "1 day",
    url: "https://app.paradex.trade/vaults/" + PARADEX_GIGAVAULT_ADDRESS,
  },
};

type HistoryPoint = [number, string | number];
type PortfolioWindow = { accountValueHistory?: HistoryPoint[]; pnlHistory?: HistoryPoint[] };

/** HLP from vaultDetails: APR, TVL (latest account value), 30-day PnL over the account value 30 days ago. */
export function parseHlp(json: unknown): PerpVault {
  const d = (json ?? {}) as { apr?: unknown; portfolio?: unknown; followers?: unknown };
  const apr = num(d.apr);
  const month = Array.isArray(d.portfolio) ? ((d.portfolio as [string, PortfolioWindow][]).find((w) => Array.isArray(w) && w[0] === "month")?.[1] ?? null) : null;
  const values = (month?.accountValueHistory ?? []).map((p) => num(p?.[1])).filter((v): v is number => v !== null);
  const pnls = (month?.pnlHistory ?? []).map((p) => num(p?.[1])).filter((v): v is number => v !== null);
  const tvl = values.length ? values[values.length - 1] : null;
  const start = values.length ? values[0] : null;
  const pnl = pnls.length >= 2 ? pnls[pnls.length - 1] - pnls[0] : null;
  return {
    ...STATIC.hlp,
    tvlUsd: tvl,
    aprPct: apr !== null ? apr * 100 : null,
    return30dPct: pnl !== null && start ? (pnl / start) * 100 : null,
    depositors: Array.isArray(d.followers) ? d.followers.length : null,
  };
}

/** Extended's vault summary: equity, last-30-day APR, depositors. */
export function parseExtendedVault(json: unknown): PerpVault {
  const d = ((json as { data?: unknown })?.data ?? {}) as Record<string, unknown>;
  const apr = num(d.last30dApr);
  return { ...STATIC.extended, tvlUsd: num(d.equity), aprPct: apr !== null ? apr * 100 : null, return30dPct: null, depositors: num(d.numberOfDepositors) };
}

/** Paradex's vault summary for the GigaVault: TVL, 30-day ROI, and last month's return (Paradex annualises it) as the APR. */
export function parseParadexVault(json: unknown): PerpVault {
  const rows = (json as { results?: unknown })?.results;
  const d = (Array.isArray(rows) ? (rows as Record<string, unknown>[]).find((r) => String(r?.address ?? "").toLowerCase() === PARADEX_GIGAVAULT_ADDRESS) : undefined) ?? {};
  const month = num(d.last_month_return);
  const roi30 = num(d.roi_30d);
  return { ...STATIC.paradex, tvlUsd: num(d.tvl), aprPct: month !== null ? month * 100 : null, return30dPct: roi30 !== null ? roi30 * 100 : null, depositors: num(d.num_depositors) };
}

/** A vault whose API didn't answer: listed, with no numbers. */
export function emptyVault(id: PerpVault["id"]): PerpVault {
  return { ...STATIC[id], tvlUsd: null, aprPct: null, return30dPct: null, depositors: null };
}

/** Highest APR first; vaults with no figure last. */
export function rankVaults(vaults: PerpVault[]): PerpVault[] {
  return [...vaults].sort((a, b) => (b.aprPct ?? -Infinity) - (a.aprPct ?? -Infinity));
}
