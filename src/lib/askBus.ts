/**
 * askBus.ts — lets any panel hand a prompt to the chat ("Ask Meridian").
 *
 * The side panels (risk suggestions, chains, alpha) show something worth
 * acting on; instead of leaving the user to retype it, they dispatch it here
 * and the terminal page submits it as a thesis. A window event keeps the
 * panels free of any prop drilling or shared context.
 */

export const ASK_EVENT = "meridian:ask";

export function askMeridian(prompt: string): void {
  const text = prompt.trim();
  if (!text || typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<string>(ASK_EVENT, { detail: text }));
}

/** Subscribe to prompts sent from panels; returns the unsubscribe function. */
export function onAsk(handler: (prompt: string) => void): () => void {
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<unknown>).detail;
    if (typeof detail === "string" && detail.trim()) handler(detail.trim());
  };
  window.addEventListener(ASK_EVENT, listener);
  return () => window.removeEventListener(ASK_EVENT, listener);
}

/** A ready-made plan to show in the chat (e.g. a strategy's exit), run through the usual execution flow. */
export interface PlanForChat {
  text: string;
  plan: import("@/lib/tradePlan").TradePlan;
  understanding?: string;
}

export const SHOW_PLAN_EVENT = "meridian:show-plan";

export function showPlanInChat(item: PlanForChat): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<PlanForChat>(SHOW_PLAN_EVENT, { detail: item }));
}

/** Subscribe to plans sent to the chat; returns the unsubscribe function. */
export function onShowPlan(handler: (item: PlanForChat) => void): () => void {
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<unknown>).detail as PlanForChat | undefined;
    if (detail && typeof detail.text === "string" && detail.plan && Array.isArray(detail.plan.legs)) handler(detail);
  };
  window.addEventListener(SHOW_PLAN_EVENT, listener);
  return () => window.removeEventListener(SHOW_PLAN_EVENT, listener);
}
