import { ThreadItem } from "@/lib/data";
import { parseThesis, planToThreadType } from "@/lib/tradePlan";

/**
 * Route a raw thesis string to a ThreadItem. The heavyweight parsing lives in
 * tradePlan.parseThesis(); here we just run it and stamp the resulting plan
 * (plus a backward-compatible ThreadType) onto the ThreadItem so the card
 * renderer can build dynamic order rows from it.
 */
export function routeThesis(rawText: string): ThreadItem {
  const text = (rawText ?? "").trim();
  const plan = parseThesis(text);
  return { type: planToThreadType(plan), text, plan };
}

export { planToThreadType } from "@/lib/tradePlan";
export type { TradePlan } from "@/lib/tradePlan";
