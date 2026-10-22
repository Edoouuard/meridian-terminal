/**
 * bus.ts — "Run it as a bot" from a plan: hands the pair to the neutral bot
 * panel in Tools (prefilled, not started) and opens that tab.
 */

import type { BotConfig } from "@/lib/neutralBot/engine";

export const OPEN_BOT_EVENT = "meridian:open-neutral-bot";
export const BOT_ANCHOR = "neutral-bot";

export type BotPrefill = Partial<BotConfig> & Pick<BotConfig, "base" | "venues">;

// Held until the panel mounts: Tools may be closed when a plan asks for the bot.
let pending: BotPrefill | null = null;

/** The prefill a plan left for the panel, once. */
export function takePendingBot(): BotPrefill | null {
  const p = pending;
  pending = null;
  return p;
}

/** Show the bot's view, without changing its settings. */
export const SHOW_BOT_EVENT = "meridian:show-neutral-bot";
export function openNeutralBotView(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(SHOW_BOT_EVENT));
}

export function openNeutralBot(prefill: BotPrefill): void {
  if (typeof window === "undefined") return;
  pending = prefill;
  window.dispatchEvent(new CustomEvent<BotPrefill>(OPEN_BOT_EVENT, { detail: prefill }));
}

export function onOpenNeutralBot(handler: (prefill: BotPrefill) => void): () => void {
  const listener = (e: Event) => {
    const d = (e as CustomEvent<unknown>).detail as BotPrefill | undefined;
    if (d && typeof d.base === "string" && Array.isArray(d.venues) && d.venues.length === 2) {
      pending = null;
      handler(d);
    }
  };
  window.addEventListener(OPEN_BOT_EVENT, listener);
  return () => window.removeEventListener(OPEN_BOT_EVENT, listener);
}

/** "Deposit on Extended" from the bot: the page opens Tools at that venue's panel. */
export const OPEN_TOOLS_EVENT = "meridian:open-tools";

export function openToolsAt(anchor: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<string>(OPEN_TOOLS_EVENT, { detail: anchor }));
}
