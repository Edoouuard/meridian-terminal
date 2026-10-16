/**
 * conversation.ts — the planner reads a message in the context of the
 * conversation. A follow-up ("why not long Hyperliquid and short
 * Extended?", "et en 5x ?") names no asset or topic of its own: it applies
 * to the last request that did, so the server's checks and the model both
 * see the two together.
 */

import type { MarketSnapshot } from "@/lib/planner/markets";
import { mentionedBases } from "@/lib/planner/pair";

export interface Turn {
  /** What the user typed (with the answer to a question appended). */
  request: string;
  /** What Meridian answered: the plan shown or the question asked. */
  answer?: string;
}

const MAX_TURNS = 4;
const MAX_CHARS = 500;

/** The history the client sent, kept to a few short turns of plain text. */
export function cleanHistory(v: unknown): Turn[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((t): t is { request: unknown; answer?: unknown } => !!t && typeof t === "object" && typeof (t as { request?: unknown }).request === "string")
    .map((t) => ({ request: (t.request as string).trim().slice(0, MAX_CHARS), answer: typeof t.answer === "string" ? t.answer.trim().slice(0, MAX_CHARS) : undefined }))
    .filter((t) => t.request)
    .slice(-MAX_TURNS);
}

/** Topics that make a message a request of its own even without a perp asset. */
const OWN_TOPIC = /\b(stable\w*|usdc|usdt|dai|yield|rendement|apy|apr|lend\w*|prêt|pret|borrow|emprunt|stake|staking|restak\w*|lido|aave|morpho|pendle|compound|spark|fluid|ethena|yearn|eigen\w*|vault|swap|bridge|send|envoie|transfer|withdraw|retire|deposit|dépos\w*|depos\w*|hlp|llp|portfolio|portefeuille|news|actu\w*)\b/i;

/** Does this message stand on its own (it names an asset or a topic)? */
export function standsAlone(text: string, markets: MarketSnapshot | undefined): boolean {
  return mentionedBases(text, markets).length > 0 || OWN_TOPIC.test(text);
}

/**
 * The request the server checks: the message itself when it stands alone,
 * otherwise the last earlier request that did, followed by the message.
 */
export function effectiveRequest(thesis: string, history: Turn[], markets: MarketSnapshot | undefined): string {
  if (standsAlone(thesis, markets)) return thesis;
  const prior = [...history].reverse().find((t) => standsAlone(t.request, markets));
  return prior ? `${prior.request} — ${thesis}` : thesis;
}

/** The conversation as the model reads it. */
export function conversationSection(history: Turn[]): string {
  if (history.length === 0) return "";
  const lines = history.map((t, i) => `${i + 1}. User: ${t.request}${t.answer ? `\n   Meridian: ${t.answer}` : ""}`);
  return [
    "## CONVERSATION SO FAR (oldest first)",
    ...lines,
    "The new message may refer to these turns (\"why not…\", \"and at 5x?\", \"the other way round\"): apply it to the request it refers to, keeping that request's asset, venues, leverage and size unless the new message changes them.",
  ].join("\n");
}
