/**
 * execLog.ts — server-side journal of every execution outcome.
 *
 * The order runner (lib/orderRunner.ts) reports each terminal state —
 * CONFIRMED or a failure with its reason — to /api/exec-log, which writes one
 * structured line to the server logs and, when Sentry is configured, a
 * Sentry log (durable, searchable) plus an issue for failures worth a look.
 *
 * Only plan metadata travels: never keys, signatures or raw provider payloads.
 * `sanitizeExecEvent` is the single gate on what the server accepts.
 */

import { isFailureState, type FailureState, type OrderFlowState } from "@/lib/executionPlan";

export interface ExecEvent {
  planId?: string;
  state: OrderFlowState;
  outcome: "success" | "failure";
  chainId?: number;
  protocol?: string;
  type?: string;
  symbol?: string;
  /** Human amount (decimal string), e.g. "100.5". */
  amount?: string;
  /** Wallet that signed (public). */
  address?: string;
  /** Public tx hash, once there is one. */
  hash?: string;
  /** Failure reason shown to the user. */
  reason?: string;
}

/**
 * Failures that point at Meridian, a venue or the infrastructure, worth an
 * alert. The rest are the user's own choices or inputs (rejected signature,
 * short balance, wrong chain, bad amount, plan left to expire).
 */
const ACTIONABLE: ReadonlySet<FailureState> = new Set<FailureState>([
  "SIMULATION_FAILED",
  "APPROVAL_FAILED",
  "TRANSACTION_REVERTED",
  "RPC_ERROR",
  "CONFIRMATION_TIMEOUT",
]);

export function isActionableFailure(state: OrderFlowState): boolean {
  return isFailureState(state) && ACTIONABLE.has(state);
}

const STATES = new Set<string>([
  "CONFIRMED",
  "WRONG_CHAIN",
  "INSUFFICIENT_BALANCE",
  "INVALID_AMOUNT",
  "PLAN_EXPIRED",
  "SIMULATION_FAILED",
  "APPROVAL_REJECTED",
  "APPROVAL_FAILED",
  "SIGNATURE_REJECTED",
  "TRANSACTION_REVERTED",
  "RPC_ERROR",
  "CONFIRMATION_TIMEOUT",
]);

const str = (v: unknown, max: number, re?: RegExp): string | undefined => {
  if (typeof v !== "string") return undefined;
  const s = v.trim().slice(0, max);
  if (!s || (re && !re.test(s))) return undefined;
  return s;
};

/** Validate an untrusted body into an ExecEvent, or null. Unknown fields are dropped. */
export function sanitizeExecEvent(body: unknown): ExecEvent | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const state = typeof b.state === "string" && STATES.has(b.state) ? (b.state as OrderFlowState) : null;
  if (!state) return null;
  const chainId = typeof b.chainId === "number" && Number.isInteger(b.chainId) && b.chainId > 0 && b.chainId < 1e10 ? b.chainId : undefined;
  return {
    state,
    outcome: state === "CONFIRMED" ? "success" : "failure",
    planId: str(b.planId, 64, /^[\w-]+$/),
    chainId,
    protocol: str(b.protocol, 32, /^[\w.-]+$/),
    type: str(b.type, 32, /^[\w-]+$/),
    symbol: str(b.symbol, 24, /^[\w.$+-]+$/),
    amount: str(b.amount, 40, /^\d+(\.\d+)?$/),
    address: str(b.address, 42, /^0x[0-9a-fA-F]{40}$/),
    hash: str(b.hash, 66, /^0x[0-9a-fA-F]{64}$/),
    // Reasons can quote revert data or RPC text: cap the length, strip control chars.
    reason: str(typeof b.reason === "string" ? b.reason.replace(/[\u0000-\u001f\u007f]+/g, " ") : undefined, 500),
  };
}

/**
 * Fire-and-forget report from the browser. No-op outside a browser (unit and
 * fork tests run the same runner in Node) and never throws: the journal must
 * not get in the way of an execution.
 */
export function reportExecution(event: Omit<ExecEvent, "outcome">): void {
  if (typeof window === "undefined" || typeof fetch !== "function") return;
  try {
    void fetch("/api/exec-log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* never block an execution on logging */
  }
}
