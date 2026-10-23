/**
 * extendedProxy.ts — the same-origin relay to Extended's API.
 *
 * Extended's API answers no CORS preflight (405, no Access-Control-* headers;
 * checked 2026-10-16 on mainnet and testnet), so the browser talks to
 * `/api/extended/<network>/…` and the route in `app/api/extended` forwards to
 * Extended. These helpers are shared by that route (what may be forwarded)
 * and by the browser code (where the SDK should send its requests).
 */

export type ExtendedNetworkName = "mainnet" | "testnet";

/** Extended's own hosts (python SDK `x10/config.py`). Onboarding and REST share the host. */
export const EXTENDED_HOSTS: Record<ExtendedNetworkName, string> = {
  mainnet: "https://api.starknet.extended.exchange",
  testnet: "https://api.starknet.sepolia.extended.exchange",
};

const SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * The Extended URL a relayed request maps to, or null when the request is not
 * one Meridian makes: only the REST API (`api/v1/…`) and account onboarding
 * (`auth/onboard`) are reachable, never arbitrary paths on the host.
 */
export function extendedUpstreamUrl(network: string, path: string[], search = ""): string | null {
  if (network !== "mainnet" && network !== "testnet") return null;
  if (path.length === 0 || path.some((s) => !SEGMENT.test(s) || s === "." || s === "..")) return null;
  const isRest = path[0] === "api" && path[1] === "v1" && path.length > 2;
  const isOnboard = path.length === 2 && path[0] === "auth" && path[1] === "onboard";
  if (!isRest && !isOnboard) return null;
  return `${EXTENDED_HOSTS[network]}/${path.join("/")}${search}`;
}

/** Request headers Extended needs; everything else (cookies, origin…) stays here. */
const FORWARDED = ["content-type", "accept", "x-api-key", "l1_signature", "l1_message_time", "x-x10-active-account"];

export function forwardableExtendedHeaders(incoming: Headers): Headers {
  const out = new Headers();
  for (const name of FORWARDED) {
    const v = incoming.get(name);
    if (v) out.set(name, v);
  }
  // Extended rejects requests without a User-Agent; browsers won't let a page set one.
  out.set("user-agent", "meridian-terminal");
  return out;
}

/**
 * Meridian's own origin when code runs on the server (the server bot): the
 * relay is called over HTTPS like the browser does, so RFQ routing and
 * headers stay in one place.
 */
export function serverOrigin(): string {
  const host = process.env.MERIDIAN_ORIGIN ?? process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
  return host ? (host.startsWith("http") ? host : `https://${host}`) : "";
}

/** The server bot's relay (set by lib/neutralBot/serverBot.ts): the token-guarded twin of /api/extended. */
let serverRelay: string | null = null;
export function setServerRelayBase(base: string | null): void {
  serverRelay = base;
}

/** Base path of the relay for a network, as seen from the browser (or from the server bot, through its own relay). */
export function extendedRelayBase(network: ExtendedNetworkName, origin = typeof window === "undefined" ? serverOrigin() : window.location.origin): string {
  if (typeof window === "undefined" && serverRelay) return `${serverRelay}/${network}`;
  return `${origin}/api/extended/${network}`;
}

/** SDK `restUrls` pointing at the relay (the SDK appends paths like `/user/positions`). */
export function extendedRestUrls(origin?: string): Record<ExtendedNetworkName, string> {
  return {
    mainnet: `${extendedRelayBase("mainnet", origin)}/api/v1`,
    testnet: `${extendedRelayBase("testnet", origin)}/api/v1`,
  };
}

/**
 * Extended routes orders on RFQ markets (market makers fill them; isRfq in
 * GET /info/markets — most stock and many crypto markets) to a separate
 * endpoint, POST /api/v1/user/order/rfq, with the same body and signature;
 * the standard endpoint rejects them. The SDK always posts to /user/order,
 * so the relay picks the path from the order's market.
 */
export function orderPathFor(path: string[], method: string, body: string | undefined, isRfq: (market: string) => boolean | undefined): string[] {
  if (method !== "POST" || path.join("/") !== "api/v1/user/order" || !body) return path;
  let market: unknown;
  try {
    market = (JSON.parse(body) as { market?: unknown }).market;
  } catch {
    return path;
  }
  return typeof market === "string" && isRfq(market) ? [...path, "rfq"] : path;
}

/**
 * What an order looked like, for the logs when Extended refuses it: every
 * field but the settlement (signature, Stark key, position), which is never
 * logged. Extended answers a body it can't read with an empty 400, so the
 * fields are the only clue.
 */
export function orderForLog(body: string | undefined): string {
  if (!body) return "(no body)";
  try {
    const o = JSON.parse(body) as Record<string, unknown>;
    const { settlement: _s, ...rest } = o;
    return JSON.stringify({ ...rest, settlement: _s === undefined ? "MISSING" : "present" }).slice(0, 600);
  } catch {
    return `(not JSON, ${body.length} chars)`;
  }
}
