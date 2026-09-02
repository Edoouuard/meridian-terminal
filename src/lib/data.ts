export type ThreadType = "pendle" | "betaneutral" | "perp" | "swap" | "hedge" | "custom";

export interface ThreadItem {
  type: ThreadType;
  text?: string;
}

export const TX_HASHES: Record<Exclude<ThreadType, "custom">, string> = {
  pendle: "0x4f2a9e1b...9c31",
  betaneutral: "0x8b71c02f...2e04",
  perp: "0x1a9d5b83...77f0",
  swap: "0x62c4f710...b0a9",
  hedge: "0x9de731a4...5f88",
};

export const HEDGE_KEYWORDS = [
  "hedge",
  "protect",
  "downside",
  "insure",
  "drawdown",
  "crash",
  "bear market",
  "dump",
  "correction",
];

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

export interface CryptoTicker {
  symbol: string;
  price: string;
  change: number;
}

export const TOP_CRYPTOS: CryptoTicker[] = [
  { symbol: "BTC", price: "$118,420", change: 1.8 },
  { symbol: "ETH", price: "$4,180", change: 2.4 },
  { symbol: "USDT", price: "$1.00", change: 0.0 },
  { symbol: "XRP", price: "$2.86", change: -0.6 },
  { symbol: "BNB", price: "$842", change: 1.1 },
  { symbol: "SOL", price: "$214", change: 3.7 },
  { symbol: "USDC", price: "$1.00", change: 0.0 },
  { symbol: "DOGE", price: "$0.284", change: -1.2 },
  { symbol: "TRX", price: "$0.318", change: 0.4 },
  { symbol: "ADA", price: "$0.812", change: -0.9 },
  { symbol: "HYPE", price: "$38.40", change: 6.2 },
  { symbol: "LINK", price: "$24.15", change: 2.1 },
  { symbol: "AVAX", price: "$42.80", change: 1.5 },
  { symbol: "SUI", price: "$4.62", change: 4.3 },
  { symbol: "XLM", price: "$0.412", change: -0.3 },
  { symbol: "TON", price: "$6.28", change: 0.8 },
  { symbol: "SHIB", price: "$0.0000228", change: -1.5 },
  { symbol: "LTC", price: "$118.60", change: 0.6 },
  { symbol: "DOT", price: "$6.94", change: -0.4 },
  { symbol: "BCH", price: "$612", change: 1.9 },
  { symbol: "HBAR", price: "$0.284", change: 0.2 },
  { symbol: "UNI", price: "$12.85", change: 1.3 },
  { symbol: "PEPE", price: "$0.0000214", change: 5.8 },
  { symbol: "NEAR", price: "$6.12", change: 2.6 },
  { symbol: "APT", price: "$9.84", change: -1.1 },
];

export const WALLET_ADDRESS = "0x7A3f…9B2c";
export const PORTFOLIO_VALUE = 128400;
