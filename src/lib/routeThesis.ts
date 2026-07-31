import { HEDGE_KEYWORDS, ThreadItem, ThreadType } from "@/lib/data";

/** Keyword routing shared by the terminal's live chat and the landing page demo. */
export function routeThesis(rawText: string): ThreadItem {
  const text = rawText.trim();
  const t = text.toLowerCase();
  if (t.includes("pendle") || t.includes("yield") || t.includes("fixed")) return { type: "pendle" };
  if (t.includes("beta") || t.includes("neutral") || t.includes("hyperliquid")) return { type: "betaneutral" };
  if (HEDGE_KEYWORDS.some((k) => t.includes(k))) return { type: "hedge", text };
  if (t.includes("perp") || t.includes("sol") || t.includes("long") || t.includes("short")) return { type: "perp" };
  if (t.includes("swap")) return { type: "swap" };
  return { type: "custom", text };
}

export const EXAMPLE_THESES = [
  "Lock in a fixed rate on my stETH before it drops",
  "Farm Hyperliquid points on ETH without directional risk",
  "I think SOL outperforms this month",
  "Hedge my portfolio against a correction",
  "Move my USDC into stETH",
];

export type { ThreadType };
