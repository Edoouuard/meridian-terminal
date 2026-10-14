/**
 * errorText.ts — turn wallet / RPC / contract errors into sentences a user
 * can act on. viem's messages are multi-line dumps ("Request Arguments: …,
 * Contract Call: …, Docs: …, Version: viem@…"); the user needs what happened
 * and what to do. The short technical reason stays appended for support.
 */

export interface ExplainedError {
  /** Plain-language sentence: what happened and what to do. */
  text: string;
  /** Known cause, when recognised. */
  cause?: "gas" | "balance" | "allowance" | "slippage" | "pending-tx" | "network-mismatch" | "rpc" | "paused" | "cap" | "deadline" | "revert";
}

/** First meaningful line of a thrown error (viem's `shortMessage` when present). */
export function shortError(err: unknown): string {
  const e = err as { shortMessage?: unknown; message?: unknown } | null;
  const raw = typeof e?.shortMessage === "string" && e.shortMessage ? e.shortMessage : err instanceof Error ? err.message : String(err);
  const line = raw.split("\n").map((l) => l.trim()).find(Boolean) ?? raw;
  return line.length > 180 ? `${line.slice(0, 177)}…` : line;
}

const RULES: Array<{ re: RegExp; cause: ExplainedError["cause"]; text: string }> = [
  {
    re: /insufficient funds for (gas|intrinsic)|exceeds the balance of the account|insufficient funds for transfer/i,
    cause: "gas",
    text: "Not enough native token (ETH, POL, AVAX or BNB) on this chain to pay the network fee. Add a little and retry.",
  },
  {
    re: /transfer amount exceeds balance|exceeds balance|STF\b|insufficient balance|BALANCE_TOO_LOW|burn amount exceeds/i,
    cause: "balance",
    text: "Your token balance is lower than this amount (it may have changed since the quote). Lower the amount and retry.",
  },
  {
    re: /allowance|ERC20: insufficient allowance|transfer amount exceeds allowance/i,
    cause: "allowance",
    text: "The approval is lower than the amount. Approve again, then retry.",
  },
  {
    re: /too little received|slippage|INSUFFICIENT_OUTPUT_AMOUNT|Return amount is not enough|minimum amount|price impact/i,
    cause: "slippage",
    text: "The price moved beyond the allowed slippage. Get a fresh quote and retry.",
  },
  {
    re: /expired|deadline|Transaction too old|quote.*(stale|outdated)/i,
    cause: "deadline",
    text: "The quote expired before the transaction landed. Get a fresh quote and sign straight away.",
  },
  {
    re: /nonce too low|replacement transaction underpriced|already known|nonce has already been used/i,
    cause: "pending-tx",
    text: "Your wallet has a pending transaction. Wait for it to confirm (or speed it up in your wallet), then retry.",
  },
  {
    re: /chain mismatch|does not match the target chain|wrong network|chainId.*(mismatch|does not match)/i,
    cause: "network-mismatch",
    text: "Your wallet is on another network. Switch to the network shown on the order and retry.",
  },
  {
    re: /SUPPLY_CAP_EXCEEDED|supply cap|cap exceeded|DEPOSIT_LIMIT|max deposit/i,
    cause: "cap",
    text: "This market's deposit cap is reached. Try a smaller amount or another venue.",
  },
  {
    re: /paused|frozen|RESERVE_INACTIVE|not active/i,
    cause: "paused",
    text: "The protocol has paused or frozen this market for now. Pick another venue.",
  },
];

/** Infrastructure errors: checked after reverts, which RPCs often wrap in -32603. */
const RPC_RULE: { re: RegExp; cause: ExplainedError["cause"]; text: string } =
{
    re: /failed to fetch|HTTP request failed|fetch failed|network error|ECONNRESET|ETIMEDOUT|429|rate.?limit|Too Many Requests|503|502|internal error|-32603|-32005/i,
    cause: "rpc",
    text: "The network endpoint didn't answer. Nothing was sent; retry in a moment.",
  };

/** Explain an error for the user; falls back to a generic revert/failure sentence. */
export function explainError(err: unknown): ExplainedError {
  const full = err instanceof Error ? `${(err as { shortMessage?: string }).shortMessage ?? ""}\n${err.message}` : String(err);
  for (const r of RULES) if (r.re.test(full)) return { text: r.text, cause: r.cause };
  if (/revert/i.test(full)) {
    const reason = /reverted with (?:the following )?reason:\s*([^\n]+)/i.exec(full)?.[1] ?? /execution reverted:?\s*([^\n]*)/i.exec(full)?.[1];
    return {
      text: reason?.trim() ? `The contract refused the transaction: ${reason.trim().slice(0, 120)}.` : "The contract refused the transaction.",
      cause: "revert",
    };
  }
  if (RPC_RULE.re.test(full)) return { text: RPC_RULE.text, cause: RPC_RULE.cause };
  return { text: "Something went wrong talking to the chain." };
}

/** "<plain sentence> (details: <short technical reason>)" — what the UI and the journal show. */
export function userFacingError(err: unknown, prefix?: string): string {
  const { text } = explainError(err);
  const detail = shortError(err);
  const head = prefix ? `${prefix} ${text.charAt(0).toLowerCase()}${text.slice(1)}` : text;
  return detail && !text.includes(detail) ? `${head} (details: ${detail})` : head;
}
