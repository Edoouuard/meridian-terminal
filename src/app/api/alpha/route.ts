import { NextResponse } from "next/server";

export const revalidate = 900;

/** Exclude centralized exchanges / wrapped-token placeholders (same list as /api/chains). */
const EXCLUDE_PROTOCOL = /CEX|Binance|Coinbase|OKX|Kraken|Bitfinex|Bybit|KuCoin|Crypto\.com|Gemini|Wrapped|WETH|WBTC| Staked ETH/i;

/** Floors keep this from surfacing zero-TVL/scam listings or noise on tiny protocols. */
const NEW_PROTOCOL_MIN_TVL_USD = 1_000_000;
const MOMENTUM_MIN_TVL_USD = 5_000_000;
const NEW_PROTOCOL_MAX_AGE_DAYS = 30;
/**
 * Cap on |change_7d|: DefiLlama computes this from the prior week's TVL, so
 * a pool that had near-zero TVL 7 days ago produces a nonsensical spike
 * (seen live: +50,709,206%) even though the current TVL is real and above
 * the floor above. 300% (quadrupling in a week) is already generous for
 * genuine momentum — beyond that it's a near-zero-base artifact, not signal.
 */
const MOMENTUM_MAX_ABS_PCT = 300;

export type AlphaTag = "New protocol" | "Momentum";

export interface AlphaEntry {
  tag: AlphaTag;
  protocol: string;
  metric: string;
  text: string;
  url?: string;
}

interface RawProtocol {
  name?: string;
  category?: string;
  tvl?: number;
  listedAt?: number;
  change_7d?: number;
  url?: string;
}

function fmtUsdCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${Math.round(n / 1e3)}k`;
  return `$${Math.round(n)}`;
}

/**
 * Server route backed entirely by DefiLlama's free `/protocols` API (no key):
 * derives two honest "alpha" signals from real fields rather than editorial
 * content — `listedAt` (when DefiLlama first tracked the protocol) for
 * genuinely new listings, and `change_7d` (7-day TVL % change) for real
 * momentum. No "points farm" / "airdrop rumor" categories: there is no free,
 * factual API for rumors, so this deliberately doesn't fabricate that
 * content. Always 200s with an array (empty on any upstream failure) so the
 * UI never has to special-case a route error — callers show an honest
 * "no live alpha right now" rather than falling back to stale demo content.
 */
export async function GET() {
  try {
    const res = await fetch("https://api.llama.fi/protocols", { next: { revalidate: 900 } });
    if (!res.ok) return NextResponse.json<AlphaEntry[]>([]);
    const data: RawProtocol[] = await res.json();

    const clean = data.filter(
      (p): p is Required<Pick<RawProtocol, "name" | "tvl">> & RawProtocol =>
        typeof p.name === "string" && !EXCLUDE_PROTOCOL.test(p.name) && typeof p.tvl === "number",
    );

    const now = Date.now() / 1000;

    const newProtocols: AlphaEntry[] = clean
      .filter((p) => typeof p.listedAt === "number" && now - p.listedAt < NEW_PROTOCOL_MAX_AGE_DAYS * 86400 && p.tvl > NEW_PROTOCOL_MIN_TVL_USD)
      .sort((a, b) => (b.listedAt ?? 0) - (a.listedAt ?? 0))
      .slice(0, 4)
      .map((p) => {
        const days = Math.max(0, Math.round((now - (p.listedAt ?? now)) / 86400));
        return {
          tag: "New protocol",
          protocol: p.name,
          metric: days === 0 ? "Listed today" : `Listed ${days}d ago`,
          text: `${p.category ?? "New protocol"} with ${fmtUsdCompact(p.tvl)} TVL${days === 0 ? " already on day one" : ` after ${days} days`}.`,
          url: p.url,
        };
      });

    const momentum: AlphaEntry[] = clean
      .filter(
        (p) =>
          typeof p.change_7d === "number" &&
          Number.isFinite(p.change_7d) &&
          Math.abs(p.change_7d) <= MOMENTUM_MAX_ABS_PCT &&
          p.tvl > MOMENTUM_MIN_TVL_USD,
      )
      .sort((a, b) => (b.change_7d ?? 0) - (a.change_7d ?? 0))
      .slice(0, 4)
      .map((p) => ({
        tag: "Momentum",
        protocol: p.name,
        metric: `${(p.change_7d ?? 0) > 0 ? "+" : ""}${(p.change_7d ?? 0).toFixed(1)}%`,
        text: `${p.category ?? "Protocol"} TVL ${(p.change_7d ?? 0) >= 0 ? "up" : "down"} ${Math.abs(p.change_7d ?? 0).toFixed(1)}% over 7 days, now ${fmtUsdCompact(p.tvl)}.`,
        url: p.url,
      }));

    return NextResponse.json<AlphaEntry[]>([...newProtocols, ...momentum]);
  } catch {
    return NextResponse.json<AlphaEntry[]>([]);
  }
}
