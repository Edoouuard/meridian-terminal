/**
 * /api/bot/server — the neutral bot on Meridian's server (lib/neutralBot/serverBot.ts).
 *
 * GET ?address=0x…  the bot's state (settings, totals, log; never its keys),
 *                   or ?status=1 for what the server is missing to run bots.
 * POST { action, address, ts, signature, … }  start | pause | close | forget,
 *                   each signed by the wallet (botActionMessage). start carries
 *                   the settings, totals and trading keys.
 */
import { NextResponse, after } from "next/server";
import { isAddress, type Address, type Hex } from "viem";
import { kvConfigured } from "@/lib/server/kv";
import { boxProblem } from "@/lib/server/secretBox";
import { ensureTickSchedule, qstashConfigured } from "@/lib/server/qstash";
import { serverOrigin } from "@/lib/integrations/extendedProxy";
import { forgetServerBot, loadRecord, pauseServerBot, publicState, startServerBot, tickServerBot, verifyBotAction, type BotAction, type BotKeys } from "@/lib/neutralBot/serverBot";
import type { BotConfig, BotStats } from "@/lib/neutralBot/engine";
import type { BotLogLine } from "@/lib/neutralBot/tickState";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function missing(): string[] {
  return [
    !kvConfigured() && "Upstash Redis (KV_REST_API_URL, KV_REST_API_TOKEN)",
    !qstashConfigured() && "Upstash QStash (QSTASH_TOKEN, QSTASH_CURRENT_SIGNING_KEY, QSTASH_NEXT_SIGNING_KEY)",
    boxProblem(),
  ].filter((x): x is string => !!x);
}

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  if (q.get("status")) {
    const m = missing();
    return NextResponse.json({ configured: m.length === 0, missing: m });
  }
  const address = q.get("address") ?? "";
  if (!isAddress(address)) return NextResponse.json({ error: "address required" }, { status: 400 });
  if (!kvConfigured()) return NextResponse.json({ state: null });
  const r = await loadRecord(address);
  return NextResponse.json({ state: r ? publicState(r) : null }, { headers: { "cache-control": "no-store" } });
}

interface Body {
  action?: BotAction;
  address?: string;
  ts?: number;
  signature?: string;
  cfg?: BotConfig;
  stats?: BotStats;
  log?: BotLogLine[];
  keys?: BotKeys;
}

export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as Body;
  if (!b.action || !["start", "pause", "close", "forget"].includes(b.action)) return NextResponse.json({ error: "unknown action" }, { status: 400 });
  if (!b.address || !isAddress(b.address) || typeof b.ts !== "number" || typeof b.signature !== "string") return NextResponse.json({ error: "address, ts and signature required" }, { status: 400 });
  const m = missing();
  if (m.length) return NextResponse.json({ error: `The server isn't set up to run bots yet. Missing: ${m.join("; ")}.` }, { status: 503 });
  const address = b.address as Address;
  if (!(await verifyBotAction(b.action, address, b.ts, b.signature as Hex))) return NextResponse.json({ error: "The wallet signature doesn't match (or is older than 5 minutes)." }, { status: 401 });

  try {
    if (b.action === "start") {
      if (!b.cfg) return NextResponse.json({ error: "settings required" }, { status: 400 });
      const r = await startServerBot({ address, cfg: b.cfg, stats: b.stats, log: b.log, keys: b.keys });
      const sched = await ensureTickSchedule(`${serverOrigin()}/api/bot/tick`);
      // The first tick runs now, after the answer: the schedule takes over within a minute.
      after(() => tickServerBot(address).then(() => undefined));
      return NextResponse.json({ state: publicState(r), schedule: sched });
    }
    if (b.action === "pause") {
      const r = await pauseServerBot(address);
      return NextResponse.json({ state: r ? publicState(r) : null });
    }
    if (b.action === "close") {
      const r = await tickServerBot(address, { close: true });
      if (!r) return NextResponse.json({ error: "A tick is running for this bot: try again in a minute." }, { status: 409 });
      return NextResponse.json({ state: publicState(r) });
    }
    await forgetServerBot(address);
    return NextResponse.json({ state: null });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
