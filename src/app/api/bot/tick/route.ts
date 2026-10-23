/**
 * /api/bot/tick — one tick of every running server bot. Called every minute
 * by Upstash QStash (POST, signature checked) or a Vercel cron (GET with
 * `Authorization: Bearer $CRON_SECRET`). Bots tick in parallel, each under
 * its own lock (lib/neutralBot/serverBot.ts).
 */
import { NextResponse } from "next/server";
import { verifyQstash } from "@/lib/server/qstash";
import { activeBots, tickServerBot } from "@/lib/neutralBot/serverBot";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function runAll() {
  const addresses = await activeBots();
  const results = await Promise.allSettled(addresses.map((a) => tickServerBot(a)));
  return { bots: addresses.length, ticked: results.filter((r) => r.status === "fulfilled" && r.value).length };
}

export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifyQstash(req.headers.get("upstash-signature"), raw)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(await runAll());
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(await runAll());
}
