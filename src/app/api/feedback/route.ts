/**
 * POST /api/feedback — bug reports from beta testers (components/FeedbackButton).
 *
 * One JSON line per report in the server logs (Vercel Logs: search
 * "[feedback]"), and a Sentry message when Sentry is configured.
 */
import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";

const clip = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : undefined);

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const message = clip(body.message, 4000);
  if (!message) return NextResponse.json({ error: "Describe what happened." }, { status: 400 });

  const entry = {
    ts: new Date().toISOString(),
    message,
    contact: clip(body.contact, 200),
    page: clip(body.page, 300),
    lastRequest: clip(body.lastRequest, 2000),
    wallet: clip(body.wallet, 64),
    chainId: typeof body.chainId === "number" ? body.chainId : undefined,
    userAgent: clip(req.headers.get("user-agent"), 300),
  };
  console.info("[feedback]", JSON.stringify(entry));
  Sentry.withScope((scope) => {
    scope.setTag("kind", "beta-feedback");
    scope.setContext("feedback", entry);
    Sentry.captureMessage(`Beta feedback: ${message.slice(0, 80)}`, "info");
  });
  return NextResponse.json({ ok: true });
}
