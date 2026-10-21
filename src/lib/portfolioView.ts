/**
 * portfolioView.ts — group the live portfolio into what a user reads at a
 * glance: crypto (with amounts and live prices), stablecoins, staking &
 * savings, lending, and Hyperliquid. Same token on several chains is merged
 * into one row. Pure and unit-tested; the panel only renders it.
 */

export type HoldingGroup = "crypto" | "stable" | "staking" | "defi" | "hyperliquid";

/** Venues of money put to work in a protocol (lib/defiPositions): vault shares, Pendle PT, EigenLayer, Lido withdrawals. */
const DEFI_VENUE = /\b(vault|pendle|eigenlayer|withdrawal)\b/i;

export interface AssetLike {
  symbol: string;
  venue: string;
  chain: string;
  balance: number;
  usd: number;
}

export interface LendingLike {
  chain: string;
  protocol: string;
  collateralUsd: number;
  debtUsd: number;
  healthFactor: number | null;
}

export interface Holding {
  symbol: string;
  group: HoldingGroup;
  balance: number;
  usd: number;
  /** Live USD price per unit (usd / balance), when the balance is non-zero. */
  price?: number;
  /** 24h price change in percent, when known. */
  change24h?: number;
  chains: string[];
  venues: string[];
  /** USD held on each chain. */
  usdByChain: Record<string, number>;
}

export interface PortfolioView {
  groups: { group: HoldingGroup | "lending"; label: string; usd: number; holdings: Holding[] }[];
  lending: LendingLike[];
  totalUsd: number;
}

const STABLES = new Set([
  "USDC", "USDT", "USDT0", "USD₮0", "USDC.E", "USDBC", "DAI", "USDS", "USDE", "GHO", "PYUSD", "FRAX", "LUSD", "CRVUSD",
  "RLUSD", "USD1", "FDUSD", "USDH", "FEUSD", "USDHL", "EURC",
]);
/** Liquid-staking, restaking and yield-bearing savings tokens: they earn just by being held. */
const STAKING = new Set([
  "STETH", "WSTETH", "RETH", "CBETH", "WEETH", "EZETH", "RSETH", "METH", "WBETH", "OSETH", "LSETH", "ETHX", "SFRXETH",
  "KHYPE", "STHYPE", "WSTHYPE", "LHYPE", "BEHYPE",
  "SUSDS", "SUSDE", "SDAI", "SUSDC", "FUSDC", "FUSDT", "FWETH",
]);

export function holdingGroup(a: Pick<AssetLike, "symbol" | "venue">): HoldingGroup {
  const s = a.symbol.toUpperCase();
  const v = a.venue.toLowerCase();
  if (v.includes("hyperliquid") && !v.includes("spot") && !v.includes("staking")) return "hyperliquid";
  if (DEFI_VENUE.test(a.venue)) return "defi";
  if (v.includes("staking") || STAKING.has(s)) return "staking";
  if (STABLES.has(s)) return "stable";
  return "crypto";
}

const LABEL: Record<HoldingGroup | "lending", string> = {
  crypto: "Crypto",
  stable: "Stablecoins",
  staking: "Staking & savings",
  defi: "DeFi positions",
  lending: "Lending",
  hyperliquid: "Hyperliquid",
};

/** Merge the same token across chains/venues within a group; biggest first. */
export function buildPortfolioView(
  assets: AssetLike[],
  lending: LendingLike[],
  change24h: (symbol: string) => number | undefined = () => undefined,
): PortfolioView {
  const byKey = new Map<string, Holding>();
  for (const a of assets) {
    if (!(a.usd > 0.5) && !(a.balance > 0)) continue;
    const group = holdingGroup(a);
    // Staked HYPE and spot HYPE are different holdings even with the same symbol; a DeFi position is one per venue
    // (stETH restaked on EigenLayer and stETH in Lido's queue are two rows).
    const key = `${group}|${a.symbol.toUpperCase()}${group === "defi" ? `|${a.venue}` : ""}`;
    const h = byKey.get(key) ?? { symbol: a.symbol, group, balance: 0, usd: 0, chains: [], venues: [], usdByChain: {} };
    h.balance += a.balance;
    h.usd += a.usd;
    h.usdByChain[a.chain] = (h.usdByChain[a.chain] ?? 0) + a.usd;
    if (!h.chains.includes(a.chain)) h.chains.push(a.chain);
    if (!h.venues.includes(a.venue)) h.venues.push(a.venue);
    byKey.set(key, h);
  }
  for (const h of byKey.values()) {
    if (h.balance > 0 && h.usd > 0) h.price = h.usd / h.balance;
    const ch = change24h(h.symbol);
    if (typeof ch === "number" && Number.isFinite(ch)) h.change24h = ch;
  }

  const order: HoldingGroup[] = ["crypto", "stable", "staking", "defi", "hyperliquid"];
  const groups: PortfolioView["groups"] = order
    .map((g) => {
      const holdings = [...byKey.values()].filter((h) => h.group === g).sort((a, b) => b.usd - a.usd);
      return { group: g, label: LABEL[g], usd: holdings.reduce((s, h) => s + h.usd, 0), holdings };
    })
    .filter((g) => g.holdings.length > 0);

  const activeLending = lending.filter((l) => l.collateralUsd > 0.5 || l.debtUsd > 0.5);
  const lendingNet = activeLending.reduce((s, l) => s + l.collateralUsd - l.debtUsd, 0);
  if (activeLending.length > 0) {
    // Lending sits after staking, before Hyperliquid.
    const at = groups.findIndex((g) => g.group === "hyperliquid");
    const entry = { group: "lending" as const, label: LABEL.lending, usd: lendingNet, holdings: [] };
    if (at === -1) groups.push(entry);
    else groups.splice(at, 0, entry);
  }

  const totalUsd = groups.reduce((s, g) => s + g.usd, 0);
  return { groups, lending: activeLending, totalUsd };
}

/** Amount with sensible precision: 0.004321 BTC, 1.2345 ETH, 12,345.6 USDC. */
export function fmtAmount(v: number): string {
  const a = Math.abs(v);
  const digits = a >= 1000 ? 1 : a >= 1 ? 4 : a >= 0.01 ? 4 : 6;
  return v.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

/** Price with precision that suits the asset: $98,450 BTC, $25.50 LINK, $0.4521 ARB. */
export function fmtPrice(v: number): string {
  if (v >= 1000) return `$${Math.round(v).toLocaleString("en-US")}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(4)}`;
}

/** USD change over 24h from the holdings that have a 24h price change (stablecoins count as flat). */
export function dayChangeUsd(view: PortfolioView): { usd: number; pct: number } | null {
  let change = 0;
  let base = 0;
  let any = false;
  for (const g of view.groups) {
    for (const h of g.holdings) {
      if (h.change24h === undefined || h.group === "stable") continue;
      any = true;
      const before = h.usd / (1 + h.change24h / 100);
      change += h.usd - before;
      base += before;
    }
  }
  if (!any || base <= 0) return null;
  return { usd: change, pct: (change / view.totalUsd) * 100 };
}

export interface Slice {
  key: string;
  label: string;
  usd: number;
  /** Share of the positive total, 0–1. */
  share: number;
}

/**
 * Part-to-whole slices for the allocation donut, biggest first: by holding
 * type (the view's groups) or by chain (wallet + lending, net). Negative or
 * dust values are left out; past `max` slices, the rest fold into "Other" so
 * a colour is never cycled.
 */
export function allocationSlices(view: PortfolioView, by: "type" | "chain", max = 5): Slice[] {
  const raw: { key: string; label: string; usd: number }[] = [];
  if (by === "type") {
    for (const g of view.groups) raw.push({ key: g.group, label: g.label, usd: g.usd });
  } else {
    const byChain = new Map<string, number>();
    for (const g of view.groups) for (const h of g.holdings) {
      for (const [c, usd] of Object.entries(h.usdByChain)) byChain.set(c, (byChain.get(c) ?? 0) + usd);
    }
    for (const l of view.lending) byChain.set(l.chain, (byChain.get(l.chain) ?? 0) + l.collateralUsd - l.debtUsd);
    for (const [chain, usd] of byChain) raw.push({ key: chain, label: chain, usd });
  }
  const positive = raw.filter((r) => r.usd > 0.5).sort((a, b) => b.usd - a.usd);
  const total = positive.reduce((s, r) => s + r.usd, 0);
  if (total <= 0) return [];
  // By type the groups are already few and have fixed colours; by chain, fold the tail.
  const kept = by === "chain" && positive.length > max ? positive.slice(0, max - 1) : positive;
  const rest = by === "chain" && positive.length > max ? positive.slice(max - 1).reduce((s, r) => s + r.usd, 0) : 0;
  const slices = kept.map((r) => ({ ...r, share: r.usd / total }));
  if (rest > 0) slices.push({ key: "other", label: "Other", usd: rest, share: rest / total });
  return slices;
}
