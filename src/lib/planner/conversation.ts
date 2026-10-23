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

/** A trade word right before "on ARB" means the ARB token ("long on ARB"); anything else means the chain. */
const TRADE_BEFORE = /\b(long|short|buy|sell|bet|bullish|bearish|achète|achete|vends?)\s*$/i;

/**
 * "on ARB", "sur ARB", "ARB chain": the Arbitrum chain, not the ARB token —
 * people name chains by their ticker ("I have stablecoins on ARB"). Rewritten
 * before anything reads the message, so no check mistakes it for an ARB trade.
 */
export function normalizeChainMentions(text: string): string {
  return text
    .replace(/\b(ARB|arb|Arb)\s+(chain|network|mainnet|one)\b/g, "Arbitrum")
    .replace(/\b(réseau|reseau|chain)\s+(ARB|arb|Arb)\b/g, "$1 Arbitrum")
    .replace(/\b(on|sur|in|from|to|vers|via|de)\s+(ARB|arb|Arb)\b(?!-USD|\s*perp)/g, (m, prep: string, _t: string, offset: number, whole: string) =>
      TRADE_BEFORE.test(whole.slice(0, offset)) ? m : `${prep} Arbitrum`,
    );
}

/** Words that ask for something to be done: a message without one only states a fact. */
const ACTION = /\b(deposit\w*|d[ée]pos\w*|swap\w*|buy|sell|long|short|supply|stake|staking|lend|borrow|emprunt\w*|bridge|send|envoie|transf[eè]r\w*|withdraw\w*|retir\w*|farm\w*|open|ouvr\w*|ach[eè]t\w*|vend\w*|put|mets?|invest\w*|place|hedge|couvr\w*|close|ferm\w*|find|trouve|cherche|show|montre|what|quel\w*|how|comment|why|pourquoi|yield|rendement|apy|apr|best|meilleur\w*|earn|gagn\w*|max\w*)\b/i;
/** "I have / I got / j'ai …": a statement about the user's own funds or accounts. */
const HOLDS = /\b(i(?:'ve| have)?\s+(?:got|have|hold|own)|i'm holding|j'ai|je poss[eè]de|je d[ée]tiens|je dispose|my|mes|mon)\b/i;

/** A message that only states a fact about the user's funds ("I got stablecoins on Arbitrum"): context for the last request, not a new one. */
export function isFundsStatement(text: string): boolean {
  return HOLDS.test(text) && !ACTION.test(text) && !text.includes("?");
}

/** Topics that make a message a request of its own even without a perp asset. */
const OWN_TOPIC = /\b(stable\w*|usdc|usdt|dai|yield|rendement|apy|apr|lend\w*|prêt|pret|borrow|emprunt|stake|staking|restak\w*|lido|aave|morpho|pendle|compound|spark|fluid|ethena|yearn|curve|crvusd|llamalend|gho|eigen\w*|vault|swap|bridge|send|envoie|transfer|withdraw|retire|deposit|dépos\w*|depos\w*|hlp|llp|portfolio|portefeuille|news|actu\w*)\b/i;

/** Does this message stand on its own (it names an asset or a topic)? */
export function standsAlone(text: string, markets: MarketSnapshot | undefined): boolean {
  return mentionedBases(text, markets).length > 0 || OWN_TOPIC.test(text);
}

/**
 * The request the server checks: the message itself when it stands alone,
 * otherwise the last earlier request that did, followed by the message.
 */
export function effectiveRequest(thesis: string, history: Turn[], markets: MarketSnapshot | undefined): string {
  if (!isFundsStatement(thesis) && standsAlone(thesis, markets)) return thesis;
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
    "A message that only states a fact about the user's funds or accounts (\"I have USDC on Arbitrum\", \"j'ai des stables sur ARB\") adds context to the last request: plan that request again using it. It never starts a new trade, and a chain named by its ticker (ARB, OP) is the chain, not the token.",
  ].join("\n");
}
