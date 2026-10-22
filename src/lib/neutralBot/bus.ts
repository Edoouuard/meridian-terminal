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
