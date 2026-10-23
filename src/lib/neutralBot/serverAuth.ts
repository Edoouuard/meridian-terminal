/**
 * serverAuth.ts — the message a wallet signs to start, pause, close or forget
 * its neutral bot on Meridian's server (shared by the browser, which signs it,
 * and lib/neutralBot/serverBot.ts, which checks it).
 */

export type BotAction = "start" | "pause" | "close" | "forget";

/** The message the wallet signs for an action (personal_sign), valid five minutes. */
export function botActionMessage(action: BotAction, address: string, ts: number): string {
  return `Meridian neutral bot\nAction: ${action}\nWallet: ${address.toLowerCase()}\nTime: ${ts}`;
}
