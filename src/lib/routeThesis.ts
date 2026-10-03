import { ThreadItem, ThreadType } from "@/lib/data";
import { parseThesisVariants, planToThreadType, type TradePlan } from "@/lib/tradePlan";

/**
 * Route a raw thesis string to a ThreadItem. The heavyweight parsing lives in
 * tradePlan.parseThesisVariants(); here we pick which candidate is active by
 * default and stamp it (plus every alternative, plus a backward-compatible
 * ThreadType) onto the ThreadItem so the card renderer can build dynamic
 * order rows from it.
 *
 * The active `plan` is always the variant matching parseThesis()'s own
 * pre-existing default (the "Balanced" leverage tier for a directional perp,
 * or variants[0] otherwise, which parseThesisVariants() already orders to
 * match the old single-plan default) — so a thesis that now has alternatives
 * still renders exactly as it did before anyone picks a different one.
 */
export function routeThesis(rawText: string): ThreadItem {
  const text = (rawText ?? "").trim();
  const variants = parseThesisVariants(text);
  const plan: TradePlan = variants.find((v) => v.variantLabel?.startsWith("Balanced")) ?? variants[0];
  return { type: planToThreadType(plan), text, plan, variants: variants.length > 1 ? variants : undefined };
}

/**
 * Representative example thesis per "quick prompt" ThreadType, so the quick
 * prompt buttons and news/alpha "discuss" links run through the same real
 * parsing/execution engine as a typed-in thesis, instead of separate static
 * demo content that can silently go stale (e.g. claiming a venue "isn't
 * wired" after it actually gets wired). Each sentence is chosen to reliably
 * round-trip back to its own key through planToThreadType.
 */
export const EXAMPLE_THESIS_FOR_TYPE: Record<Exclude<ThreadType, "custom">, string> = {
  pendle: "Lock in a fixed rate on my ETH yield via Pendle before it drops",
  betaneutral: "Farm Hyperliquid points on ETH without directional risk",
  perp: "I think SOL outperforms this month",
  swap: "Swap 10,000 USDC for WETH",
  hedge: "Hedge my portfolio against a correction",
};

export { planToThreadType } from "@/lib/tradePlan";
export type { TradePlan } from "@/lib/tradePlan";
