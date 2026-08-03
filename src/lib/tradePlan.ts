/**
 * tradePlan.ts — structured natural-language thesis → trade plan engine.
 *
 * parseThesis() is a lightweight, fully-offline parser (regex/lexer over a
 * keyword + amount + asset vocabulary). It turns a free-form conviction like
 * "short 5000 SOL on Hyperliquid" into a typed TradePlan with concrete legs,
 * which ThreadCard renders as dynamic order cards. It makes no network or LLM
 * calls and never throws: ambiguous or unparseable input degrades to a safe
 * default plan whose summary says so.
 *
 * We augment ThreadItem (declared in data.ts) with an optional `plan` field via
 * declaration merging so this whole feature stays additive and data.ts is
 * untouched — other agents depend on its existing exports.
 */

import { ThreadType, fmtUsd } from "@/lib/data";

export type TradeIntent = "lockYield" | "betaNeutral" | "directional" | "swap" | "hedge" | "unknown";

export interface TradeLeg {
  side: string;
  asset: string;
  protocol: string;
  sizeUsd?: number;
  leverage?: number;
  note?: string;
}

export interface TradePlan {
  intent: TradeIntent;
  asset?: string;
  direction?: "long" | "short";
  sizeUsd?: number;
  protocol?: string;
  legs: TradeLeg[];
  summary: string;
}

/** Augment ThreadItem with an optional parsed plan (keeps data.ts untouched). */
declare module "@/lib/data" {
  interface ThreadItem {
    plan?: TradePlan;
  }
}

/** Default notional size per intent, used when no dollar amount is given. */
export const DEFAULT_SIZES: Record<Exclude<TradeIntent, "unknown">, number> = {
  lockYield: 15000,
  betaNeutral: 20000,
  directional: 8000,
  swap: 10000,
  hedge: 13000,
};

/* Map a raw token back to its canonical symbol (longest-first matching). */
function canonAsset(token: string): string {
  const t = token.trim().toLowerCase().replace(/\s+/g, "");
  const map: Record<string, string> = {
    wsteth: "wstETH",
    steth: "stETH",
    weeth: "weETH",
    wbtc: "WBTC",
    susde: "sUSDe",
    weth: "WETH",
    usdc: "USDC",
    usdt: "USDT",
    btc: "BTC",
    eth: "ETH",
    sol: "SOL",
  };
  return map[t] ?? token.trim();
}

/* Recognised assets, longest token first so wstETH wins over ETH. */
const ASSET_PATTERNS: Array<[RegExp, string]> = [
  [/\bwst\s?eth\b/i, "wstETH"],
  [/\bst\s?eth\b/i, "stETH"],
  [/\bwe\s?eth\b/i, "weETH"],
  [/\bw\s?btc\b/i, "WBTC"],
  [/\bs\s?usde\b/i, "sUSDe"],
  [/\bweth\b/i, "WETH"],
  [/\busdc\b/i, "USDC"],
  [/\busdt\b/i, "USDT"],
  [/\bbtc\b|\bbitcoin\b/i, "BTC"],
  [/\beth\b|\bether\b/i, "ETH"],
  [/\bsol\b|\bsolana\b/i, "SOL"],
];

function parseAsset(text: string): string | undefined {
  for (const [re, canon] of ASSET_PATTERNS) {
    if (re.test(text)) return canon;
  }
  return undefined;
}

const SWAP_RE =
  /\b(wst ?eth|st ?eth|we ?eth|wbtc|susde|weth|usdc|usdt|btc|eth|sol)\s+(?:into|to|for)\s+(wst ?eth|st ?eth|we ?eth|wbtc|susde|weth|usdc|usdt|btc|eth|sol)\b/i;

function parseSwap(text: string): { from: string; to: string } | undefined {
  const m = text.match(SWAP_RE);
  if (!m) return undefined;
  return { from: canonAsset(m[1]), to: canonAsset(m[2]) };
}

/**
 * Extract a dollar notional. Prefers an explicit "$10,000" / "$5k"; otherwise a
 * bare number that reads as a position size (>= 1000, or with a k/m suffix) so
 * small incidental numbers like "3 months" or "2 signatures" are ignored.
 */
function parseAmount(text: string): number | undefined {
  const dollar = text.match(/\$\s*([0-9][0-9,]*\.?[0-9]*)\s*([km])?\b/i);
  if (dollar) {
    let v = parseFloat(dollar[1].replace(/,/g, ""));
    const s = (dollar[2] || "").toLowerCase();
    if (s === "k") v *= 1000;
    else if (s === "m") v *= 1_000_000;
    if (isFinite(v) && v > 0) return Math.round(v);
  }
  for (const m of text.matchAll(/\b([0-9][0-9,]*)\s*([km])?\b/gi)) {
    let v = parseFloat(m[1].replace(/,/g, ""));
    const s = (m[2] || "").toLowerCase();
    if (s) {
      if (s === "k") v *= 1000;
      else if (s === "m") v *= 1_000_000;
    } else if (v < 1000) {
      continue;
    }
    if (isFinite(v) && v > 0 && v <= 1_000_000_000) return Math.round(v);
  }
  return undefined;
}

const PROTOCOL_PATTERNS: Array<[RegExp, string]> = [
  [/\bpendle\b/i, "Pendle"],
  [/\bhyper ?liquid\b/i, "Hyperliquid"],
  [/\baave\b/i, "Aave"],
  [/\bmorpho\b/i, "Morpho"],
  [/\blido\b/i, "Lido"],
  [/\buniswap\b/i, "Uniswap"],
  [/\bextended\b/i, "Extended"],
  [/\bvariational\b/i, "Variational"],
];

function parseProtocol(text: string): string | undefined {
  for (const [re, name] of PROTOCOL_PATTERNS) {
    if (re.test(text)) return name;
  }
  return undefined;
}

function parseDirection(text: string): "long" | "short" | undefined {
  const t = text.toLowerCase();
  const long = /\b(long|buy|bullish|outperform\w*|up|rally|rise)\b/.test(t);
  const short = /\b(short|sell|bearish|underperform\w*|down|selloff)\b/.test(t);
  if (short && !long) return "short";
  if (long) return "long";
  return undefined;
}

/** Resolve the dominant intent from the raw thesis text. */
function resolveIntent(
  t: string,
  swap: { from: string; to: string } | undefined,
  protocol: string | undefined,
  direction: "long" | "short" | undefined,
): TradeIntent {
  if (/hedge|protect|downside|drawdown|crash|correction|bear market|dump|insure/i.test(t)) return "hedge";
  if (/beta ?neutral|delta ?neutral|no directional risk|without directional risk|farm .*points|points (farm|season)|basis neutral/i.test(t))
    return "betaNeutral";
  if (/lock|fixed rate|fixed apy|fixed yield|pendle|compression|before it drops|maturity|\bpt\b/i.test(t)) return "lockYield";
  if ((/swap|convert|bridge|switch/i.test(t) && swap) || /move .* into/i.test(t)) return "swap";
  if (direction || /\b(long|short|buy|sell|bullish|bearish|outperform\w*|underperform\w*)\b/i.test(t)) return "directional";
  if (/swap|convert|bridge/i.test(t)) return "swap";
  if (protocol === "Pendle") return "lockYield";
  if (protocol) return direction ? "directional" : "betaNeutral";
  return "unknown";
}

/** Translate a TradePlan back to the legacy ThreadType for backward compat. */
export function planToThreadType(plan: TradePlan): ThreadType {
  switch (plan.intent) {
    case "lockYield":
      return "pendle";
    case "betaNeutral":
      return "betaneutral";
    case "directional":
      return "perp";
    case "swap":
      return "swap";
    case "hedge":
      return "hedge";
    default:
      return "custom";
  }
}

/**
 * Parse a free-form thesis into a structured TradePlan. Pure, offline, and
 * total: any input (including garbage) resolves to a TradePlan.
 */
export function parseThesis(rawText: string): TradePlan {
  const text = (rawText || "").trim();
  const t = text.toLowerCase();

  const asset = parseAsset(text);
  const amount = parseAmount(text);
  const protocol = parseProtocol(text);
  const direction = parseDirection(t);
  const swap = parseSwap(text);
  const intent = resolveIntent(t, swap, protocol, direction);

  const size = amount ?? (intent !== "unknown" ? DEFAULT_SIZES[intent] : undefined);
  const base = asset ?? "ETH";
  let legs: TradeLeg[] = [];
  let summary = "";

  switch (intent) {
    case "lockYield": {
      legs = [
        { side: "Buy", asset: `PT ${base}`, protocol: protocol ?? "Pendle", sizeUsd: size, note: "Fixed APY" },
      ];
      summary = `Lock the current fixed rate on ${base} through a Pendle Principal Token (PT) for ${fmtUsd(size ?? 0)}, capturing the fixed vs variable spread before it compresses.`;
      break;
    }
    case "betaNeutral": {
      legs = [
        { side: "Long", asset: `${base} PERP`, protocol: "Hyperliquid", sizeUsd: size, leverage: 3, note: "Collect points" },
        { side: "Short", asset: `${base} PERP`, protocol: "Extended", sizeUsd: size, leverage: 3 },
      ];
      summary = `Farm ${base} points with a long on Hyperliquid paired against an offsetting short on Extended — net delta near zero while keeping the volume eligible for points.`;
      break;
    }
    case "directional": {
      const dir = direction ?? "long";
      legs = [
        { side: dir === "long" ? "Long" : "Short", asset: `${base} PERP`, protocol: protocol ?? "Hyperliquid", sizeUsd: size, leverage: 4 },
      ];
      summary = `Open a ${dir} ${base} position on ${protocol ?? "Hyperliquid"} for ~${fmtUsd(size ?? 0)} notional.`;
      break;
    }
    case "swap": {
      const from = swap?.from ?? asset ?? "USDC";
      const to = swap?.to ?? "stETH";
      legs = [{ side: "Swap", asset: `${from} → ${to}`, protocol: protocol ?? "Uniswap", sizeUsd: size }];
      summary = `Swap ~${fmtUsd(size ?? 0)} ${from} into ${to} via ${protocol ?? "Uniswap"} at minimal estimated slippage.`;
      break;
    }
    case "hedge": {
      legs = [
        { side: "Short", asset: `${base} PERP`, protocol: protocol ?? "Hyperliquid", sizeUsd: size, leverage: 1, note: "Delta hedge" },
      ];
      summary = `Short ~${fmtUsd(size ?? 0)} ${base} on ${protocol ?? "Hyperliquid"} to bring the portfolio net delta toward flat without touching the yield legs.`;
      break;
    }
    default: {
      summary = `I could not confidently parse a tradeable plan from "${text}". Rephrase with an asset (ETH, SOL, USDC, ...), a direction (long/short) or an intent (lock yield, farm points, hedge, swap), plus an optional dollar size such as $10,000.`;
    }
  }

  return { intent, asset, direction, sizeUsd: size, protocol, legs, summary };
}
