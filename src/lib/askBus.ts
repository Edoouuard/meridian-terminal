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
