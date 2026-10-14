/**
 * POST /api/exec-log — server journal of execution outcomes (lib/execLog.ts).
 *
 * One JSON line per outcome in the server logs (Vercel Logs: search
 * "[exec-log]"). With Sentry configured, also a Sentry log for every outcome
 * and an issue for actionable failures, tagged by protocol, chain and state.
 */
import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import { isActionableFailure, sanitizeExecEvent } from "@/lib/execLog";

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const event = sanitizeExecEvent(body);
  if (!event) return NextResponse.json({ error: "invalid event" }, { status: 400 });

  const entry = { ts: new Date().toISOString(), ...event };
  console.info("[exec-log]", JSON.stringify(entry));

  const attrs = Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined)) as Record<string, string | number>;
  const label = `${event.protocol ?? "?"} ${event.type ?? "?"} ${event.symbol ?? ""} on chain ${event.chainId ?? "?"}`.replace(/\s+/g, " ");
  if (event.outcome === "success") {
    Sentry.logger.info(`execution confirmed: ${label}`, attrs);
  } else {
    Sentry.logger.warn(`execution ${event.state}: ${label}`, attrs);
    if (isActionableFailure(event.state)) {
      Sentry.withScope((scope) => {
        scope.setTags({ state: event.state, protocol: event.protocol, chainId: event.chainId, type: event.type });
        scope.setContext("execution", attrs);
        // One issue per (state, protocol, chain): the reason varies per run.
        scope.setFingerprint(["execution", event.state, event.protocol ?? "?", String(event.chainId ?? "?")]);
        Sentry.captureMessage(`Execution ${event.state}: ${label}`, "error");
      });
    }
  }
  return new NextResponse(null, { status: 204 });
}
