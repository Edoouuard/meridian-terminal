export type ThreadType = "pendle" | "betaneutral" | "perp" | "swap" | "custom";

export interface ThreadItem {
  type: ThreadType;
  text?: string;
}

export const TX_HASHES: Record<Exclude<ThreadType, "custom">, string> = {
  pendle: "0x4f2a9e1b...9c31",
  betaneutral: "0x8b71c02f...2e04",
  perp: "0x1a9d5b83...77f0",
  swap: "0x62c4f710...b0a9",
};

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

export const RISK_SUGGESTIONS = [
  { text: "Repaying $4,200 USDC on Aave brings the health factor from 1.32 to 1.81." },
  { text: "Shorting an extra $1,860 on Extended brings the ETH net delta from +0.62 to about 0." },
  {
    text: "stETH plus wstETH are 42% of the portfolio in one protocol risk. Moving $6,000 into PT weETH cuts that to 31% while locking 9.8% fixed.",
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

export const YIELD_CHART = {
  fixedPoints: "4,4 8,4 12,5 16,4 20,5 24,4 28,5 32,4",
  varPoints: "4,10 8,13 12,16 16,18 20,21 24,23 28,25 32,26",
};

export interface NewsItem {
  protocol: string;
  metric: string;
  text: string;
  action?: ThreadType;
}

export const NEWS: NewsItem[] = [
  {
    protocol: "Hyperliquid",
    metric: "+14.6%",
    text: "TVL up this week, with $65M of net inflows. The most active protocol right now.",
    action: "betaneutral",
  },
  {
    protocol: "Pendle",
    metric: "+340 bps",
    text: "The fixed/variable spread on weETH is at its widest: 9.8% fixed (June 2027), worth locking in before it compresses.",
    action: "pendle",
  },
  {
    protocol: "Morpho",
    metric: "+6.4%",
    text: "TVL up, with the best yield right now at 8.9% on USDC (Steakhouse vault).",
  },
  {
    protocol: "Aave",
    metric: "-$22M",
    text: "Net outflows this week, total TVL steady at $38.2B.",
  },
  {
    protocol: "Lido",
    metric: "+0.9%",
    text: "TVL at $41.5B, stETH still yielding 3.1% variable.",
  },
  {
    protocol: "Uniswap",
    metric: "-3.2%",
    text: "TVL down, with $9M of net outflows this week on the ETH/USDC pools.",
  },
];

export const WALLET_ADDRESS = "0x7A3f…9B2c";
export const PORTFOLIO_VALUE = 128400;
