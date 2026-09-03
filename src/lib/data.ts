export type ThreadType = "pendle" | "betaneutral" | "perp" | "swap" | "hedge" | "custom";

export interface ThreadItem {
  type: ThreadType;
  text?: string;
}

export function fmtUsd(n: number): string {
  return (n < 0 ? "-" : "") + "$" + Math.abs(Math.round(n)).toLocaleString("en-US");
}

export const POSITIONS = [
  { asset: "ETH PERP long", venue: "Hyperliquid", amount: "$20,000 · +$340" },
  { asset: "ETH PERP short", venue: "Extended", amount: "$20,000 · -$298" },
  { asset: "USDC supply", venue: "Aave", amount: "$35,000" },
  { asset: "USDC borrow", venue: "Aave", amount: "-$18,200" },
  { asset: "stETH", venue: "Lido", amount: "$22,400" },
  { asset: "PT weETH", venue: "Pendle", amount: "$15,000" },
];

export const ALLOCATION = [
  { label: "USDC · Aave", pct: 35, color: "var(--color-accent-700)" },
  { label: "stETH · Lido", pct: 22, color: "var(--color-accent-500)" },
  { label: "PT weETH · Pendle", pct: 15, color: "var(--color-accent-300)" },
  { label: "Perp margin", pct: 13, color: "var(--color-neutral-500)" },
  { label: "Other", pct: 15, color: "var(--color-neutral-300)" },
];

/** Headline risk figures — also referenced by the hedge suggestion in the trade chat. */
export const HEALTH_FACTOR = 1.32;
export const NET_DELTA_ETH = 0.62;
export const STAKING_CONCENTRATION_PCT = 42;

export type RiskSuggestionKind = "healthFactor" | "delta" | "concentration";

export interface RiskSuggestion {
  kind: RiskSuggestionKind;
  text: string;
  before: number;
  after: number;
  max: number;
}

export const RISK_SUGGESTIONS: RiskSuggestion[] = [
  {
    kind: "healthFactor",
    text: "Repaying $4,200 USDC on Aave brings the health factor from 1.32 to 1.81.",
    before: 1.32,
    after: 1.81,
    max: 2.5,
  },
  {
    kind: "delta",
    text: "Shorting an extra $1,860 on Extended brings the ETH net delta from +0.62 to about 0.",
    before: 0.62,
    after: 0.02,
    max: 1.0,
  },
  {
    kind: "concentration",
    text: "stETH plus wstETH are 42% of the portfolio in one protocol risk. Moving $6,000 into PT weETH cuts that to 31% while locking 9.8% fixed.",
    before: 42,
    after: 31,
    max: 100,
  },
];

export const ROTATION_BARS = [
  { name: "HL", width: "100%", color: "var(--color-accent-700)", value: "+$65M" },
  { name: "PEN", width: "65%", color: "var(--color-accent-600)", value: "+$42M" },
  { name: "MOR", width: "28%", color: "var(--color-accent-400)", value: "+$18M" },
  { name: "LDO", width: "5%", color: "var(--color-accent-300)", value: "+$3M" },
  { name: "UNI", width: "14%", color: "var(--color-neutral-500)", value: "-$9M" },
  { name: "AAVE", width: "34%", color: "var(--color-neutral-600)", value: "-$22M" },
];

export const HIGHLIGHT = {
  protocol: "Hyperliquid",
  chg: "+14.6%",
  tvlStart: "$2.5B",
  tvlEnd: "$2.9B",
  points: "4,25 8,22 12,19 16,15 20,12 24,8 28,5 32,2",
};

/**
 * Symbols shown in the ticker, in display order — nothing more. There are no
 * hardcoded prices/changes here on purpose: TickerBanner only ever renders a
 * symbol once /api/prices (CoinGecko, live) actually returns it, so this list
 * can never silently stand in for real data going stale.
 */
export const TOP_CRYPTO_SYMBOLS = [
  "BTC",
  "ETH",
  "USDT",
  "XRP",
  "BNB",
  "SOL",
  "USDC",
  "DOGE",
  "TRX",
  "ADA",
  "HYPE",
  "LINK",
  "AVAX",
  "SUI",
  "XLM",
  "TON",
  "SHIB",
  "LTC",
  "DOT",
  "BCH",
  "HBAR",
  "UNI",
  "PEPE",
  "NEAR",
  "APT",
];

export const PORTFOLIO_VALUE = 128400;
