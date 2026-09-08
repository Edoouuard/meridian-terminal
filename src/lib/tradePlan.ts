/**
 * tradePlan.ts — structured natural-language thesis → trade plan engine.
 *
 * parseThesis() is a lightweight, fully-offline parser (regex/lexer over a
 * keyword + amount + asset + leverage vocabulary). It turns a free-form DeFi
 * conviction — directional perps ("short 5000 SOL on Hyperliquid", "long HYPE,
 * size 6k, leverage 6"), lending ("borrow 10k USDC on Aave"), staking
 * ("stake 2 ETH for Lido yield"), fixed yield ("lock the current rate"),
 * beta-neutral points farming, options, swaps, hedges, bridges — into a typed
 * TradePlan with concrete legs, which ThreadCard renders as dynamic order
 * cards. It makes no network or LLM calls and never throws: ambiguous or
 * unparseable input degrades to a safe default plan whose summary says so.
 *
 * ThreadItem (declared in data.ts) is augmented with an optional `plan` field
 * via declaration merging, so this whole feature stays additive.
 */

import { ThreadType, fmtUsd } from "@/lib/data";

export type TradeIntent =
  | "lockYield"
  | "betaNeutral"
  | "directional"
  | "swap"
  | "hedge"
  | "supply"
  | "borrow"
  | "repay"
  | "stake"
  | "restake"
  | "options"
  | "bridge"
  | "transfer"
  | "withdraw"
  | "unknown";

export interface TradeLeg {
  side: string;
  asset: string;
  protocol: string;
  sizeUsd?: number;
  leverage?: number;
  note?: string;
  /** Recipient address, only set for a "transfer" leg (parsed from the thesis text itself). */
  to?: string;
  /**
   * A literal, exact token-unit quantity (e.g. "0.5" for "send 0.5 ETH") as a
   * decimal string — set only for a "transfer" leg when the thesis gave a
   * unit amount rather than a dollar figure. sizeUsd's amount is otherwise
   * always in USD, which parseThesis has no live price to convert a literal
   * unit quantity into; this field carries the exact amount through
   * unconverted instead of silently reinterpreting or dropping it.
   */
  sizeToken?: string;
}

export interface TradePlan {
  intent: TradeIntent;
  asset?: string;
  direction?: "long" | "short";
  sizeUsd?: number;
  leverage?: number;
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
export const DEFAULT_SIZES: Record<TradeIntent, number> = {
  lockYield: 15000,
  betaNeutral: 20000,
  directional: 8000,
  swap: 10000,
  hedge: 13000,
  supply: 10000,
  borrow: 10000,
  repay: 5000,
  stake: 10000,
  restake: 10000,
  options: 5000,
  bridge: 10000,
  transfer: 1000,
  withdraw: 5000,
  unknown: 0,
};

/* Map a raw token back to its canonical symbol. */
function canonAsset(token: string): string {
  const t = token.trim().toLowerCase().replace(/\s+/g, "");
  const map: Record<string, string> = {
    wsteth: "wstETH",
    steth: "stETH",
    weeth: "weETH",
    wbtc: "WBTC",
    susde: "sUSDe",
    weth: "WETH",
    wbnb: "WBNB",
    wxdai: "WXDAI",
    usdc: "USDC",
    usdt: "USDT",
    dai: "DAI",
    btc: "BTC",
    eth: "ETH",
    sol: "SOL",
    bnb: "BNB",
    xdai: "XDAI",
  };
  return map[t] ?? token.trim();
}

/*
 * Recognised assets, longest token first so wstETH wins over ETH. Overlaps the
 * terminal's TOP_CRYPTO_SYMBOLS ticker. \b word boundaries avoid matching inside words.
 */
const ASSET_PATTERNS: Array<[RegExp, string]> = [
  [/\bwst\s?eth\b/i, "wstETH"],
  [/\bst\s?eth\b/i, "stETH"],
  [/\bwe\s?eth\b/i, "weETH"],
  [/\bw\s?btc\b/i, "WBTC"],
  [/\bs\s?usde\b/i, "sUSDe"],
  [/\bweth\b/i, "WETH"],
  [/\bw\s?bnb\b/i, "WBNB"],
  [/\bw\s?xdai\b/i, "WXDAI"],
  [/\$?usdc\b/i, "USDC"],
  [/\$?usdt\b/i, "USDT"],
  [/\bdai\b/i, "DAI"],
  [/\bbtc\b|\bbitcoin\b/i, "BTC"],
  [/\beth\b|\bether\b/i, "ETH"],
  [/\bsol\b|\bsolana\b/i, "SOL"],
  [/\$?bnb\b/i, "BNB"],
  [/\bxda?\bi\b/i, "XDAI"],
  [/\$?hype\b/i, "HYPE"],
  [/\$?xrp\b/i, "XRP"],
  [/\bdoge\b|\bdogecoin\b/i, "DOGE"],
  [/\blink\b|\bchainlink\b/i, "LINK"],
  [/\bavax\b|\bavalanche\b/i, "AVAX"],
  [/\bsui\b/i, "SUI"],
  [/\bdot\b/i, "DOT"],
  [/\bada\b|\bcardano\b/i, "ADA"],
  [/\bltc\b|\blitecoin\b/i, "LTC"],
  [/\bbnb\b/i, "BNB"],
  [/\bnear\b/i, "NEAR"],
  [/\bapt\b/i, "APT"],
  [/\buni\b|\buniswap\b/i, "UNI"],
  [/\bpepe\b/i, "PEPE"],
  [/\btrx\b|\btron\b/i, "TRX"],
  [/\bton\b/i, "TON"],
  [/\bshib\b|\bshiba\b/i, "SHIB"],
  [/\bhbar\b|\bhedera\b/i, "HBAR"],
  [/\bxlm\b|\bstellar\b/i, "XLM"],
];

/** Collect every distinct matched asset in pattern order. */
function parseAssets(text: string): string[] {
  const found: string[] = [];
  for (const [re, canon] of ASSET_PATTERNS) {
    if (re.test(text) && !found.includes(canon)) found.push(canon);
  }
  return found;
}

const SWAP_RE =
  /\b(wst ?eth|st ?eth|we ?eth|wbtc|susde|weth|usdc|usdt|btc|eth|sol)\s+(?:into|to|for)\s+(wst ?eth|st ?eth|we ?eth|wbtc|susde|weth|usdc|usdt|btc|eth|sol)\b/i;

function parseSwap(text: string): { from: string; to: string } | undefined {
  const m = text.match(SWAP_RE);
  if (!m) return undefined;
  return { from: canonAsset(m[1]), to: canonAsset(m[2]) };
}

/** A raw EVM address (checksum case preserved — matched against the original, non-lowercased text). */
const ADDRESS_RE = /0x[a-fA-F0-9]{40}/;

function parseRecipient(text: string): string | undefined {
  const m = text.match(ADDRESS_RE);
  return m ? m[0] : undefined;
}

/**
 * A literal "N ETH" quantity — e.g. "0.5" from "send 0.5 ETH to 0x...".
 * Deliberately narrow (ETH only): native-transfer execution only supports
 * ETH today (see assetMap.ts), and parseAmount's dollar reading already
 * treats a plain number as USD, so this only fires for the unambiguous
 * "<number> ETH" shape, never one already prefixed with "$".
 */
function parseEthQuantity(text: string): string | undefined {
  const m = text.match(/\$?\s*([0-9]+(?:\.[0-9]+)?)\s*eth\b/i);
  if (!m || m[0].trim().startsWith("$")) return undefined;
  return m[1];
}

/**
 * Extract a dollar notional. Prefers an explicit "$10,000" / "$5k"; otherwise a
 * bare number that reads as a position size (>= 1000, or with a k/m suffix) so
 * small incidental numbers like "3 months" or "2 signatures" are ignored.
 * Labels like "size", "notional" or "position of" are also honoured.
 */
function parseAmount(text: string): number | undefined {
  const labelled = text.match(/(?:size|notional|position(?: of)?|puts?\s*down|worth)\s*(?:of\s*)?(\$?\s*[0-9][0-9,]*\.?[0-9]*)\s*([km])?\b/i);
  if (labelled) {
    let v = parseFloat(labelled[1].replace(/[$,\s]/g, ""));
    const s = (labelled[2] || "").toLowerCase();
    if (s === "k") v *= 1000;
    else if (s === "m") v *= 1_000_000;
    if (isFinite(v) && v > 0) return Math.round(v);
  }
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

/** Extract leverage ("leverage 6", "6x", "x6", "3x leverage"), clamped 1..100. */
function parseLeverage(text: string): number | undefined {
  const t = text.toLowerCase();
  const m = t.match(
    /(?:\b(?:leverage|lev|leveraged|margin)\b\s*(?:of\s*|=)?\s*(\d+(?:\.\d+)?)\s*x?)|(?:\bx\s*(\d+(?:\.\d+)?)\b)|(?:(\d+(?:\.\d+)?)\s*x\b)/,
  );
  if (!m) return undefined;
  const raw = parseFloat(m[1] ?? m[2] ?? m[3] ?? "");
  if (!isFinite(raw) || raw <= 0) return undefined;
  return Math.min(100, Math.max(1, raw));
}

const PROTOCOL_PATTERNS: Array<[RegExp, string]> = [
  [/\bpendle\b/i, "Pendle"],
  [/\bhyper ?liquid\b/i, "Hyperliquid"],
  [/\baave\b/i, "Aave"],
  [/\bmorpho\b/i, "Morpho"],
  [/\blido\b|\bwsteth\b|\bsteth\b/i, "Lido"],
  [/\buniswap\b/i, "Uniswap"],
  [/\bextended\b/i, "Extended"],
  [/\bvariational\b|\boptions\b/i, "Variational"],
  [/\bondo\b/i, "Ondo"],
  [/\blighter\b/i, "Lighter"],
  [/\bperp\b|\bperpetual\b|\bhl\b/i, "Hyperliquid"],
  // Expanded DeFi protocol vocabulary (routing breadth; live execution still opt-in).
  [/\bcompound\b|\bcomp\b/i, "Compound"],
  [/\bcurve\b/i, "Curve"],
  [/\bdydx\b|\bdydx\b/i, "dYdX"],
  [/\bgmx\b/i, "GMX"],
  [/\bjupiter\b/i, "Jupiter"],
  [/\bmaker\b|\bdsr\b/i, "Maker"],
  [/\bfluid\b/i, "Fluid"],
  [/\bsilo\b/i, "Silo"],
  [/\bspark\b/i, "Spark"],
  [/\bexpress\b/i, "Express"],
  [/\bsolana\b/i, "Solana"],
];

function parseProtocol(text: string): string | undefined {
  for (const [re, name] of PROTOCOL_PATTERNS) {
    if (re.test(text)) return name;
  }
  return undefined;
}

/*
 * Direction: explicit long/short plus directional conviction, French + English,
 * accented forms included. "ETH seems undervalued / sous-évalué" ⇒ long;
 * "BNB is overvalued / surévalué" ⇒ short.
 */
function parseDirection(text: string): "long" | "short" | undefined {
  const t = text.toLowerCase();
  const long = /(\b(long|buy|bullish|outperform\w*|rally|rise|accumulate|cheap|potential|upside|strong)\b|under[- ]?value\w*|sous[\s-]*[eé]valu[ée]?\w*|sous[\s-]*[eé]stim[ée]?\w*|[eé]valu[ée]?|pas cher|a du potentiel|va monte\w*|will (rally|rise|pop|outperform))/.test(
    t,
  );
  const short = /(\b(short|sell|bearish|underperform\w*|selloff|expensive|weak)\b|over[- ]?value\w*|sur[\s-]*[eé]valu[ée]?\w*|trop cher|overpriced|va baiss\w*|will (fall|drop|dump)|a fini de monter)/.test(
    t,
  );
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
  recipient: string | undefined,
): TradeIntent {
  // Checked first and unambiguously: an explicit send/transfer verb next to a
  // real address is never something else (a hedge, a swap, ...).
  if (recipient && /\b(send|transfer)\b/i.test(t)) return "transfer";
  if (/hedge|protect|downside|drawdown|crash|correction|bear market|dump|insure/i.test(t)) return "hedge";
  if (/beta ?neutral|delta ?neutral|no directional risk|without directional risk|farm .*points|points (farm|season)|basis neutral/i.test(t))
    return "betaNeutral";
  if (/lock|fixed rate|fixed apy|fixed yield|pendle|compression|before it drops|maturity|\bpt\b/i.test(t)) return "lockYield";
  if ((/swap|convert|bridge|switch/i.test(t) && swap) || /move .* into/i.test(t)) return "swap";
  if (/option|buy a call|buy a put|sell a call|sell a put|write a call|write a put|\bcall\b option|\bput\b option/i.test(t)) return "options";
  if (/buy a put|buy puts|buy calls|buy a call/i.test(t)) return "options";
  if (/restake|re[- ]?stake|eigenlayer|points\/vault/i.test(t)) return "restake";
  if (/repay|rembourser|remboursement|reduce.*debt|pay back/i.test(t)) return "repay";
  if (/\bwithdraw\b|\bunstake\b|\bredeem\b|retirer|retrait/i.test(t)) return "withdraw";
  if (/\bborrow\b|emprunt|emprunter|leverage (up|against)|pull (liquidity|margin)/i.test(t)) return "borrow";
  if (/\bsupply\b|\blend\b|\bdeposit\b|pr[eè]ter|\bmargin\b/i.test(t)) return "supply";
  if (/\bstake\b|staked|stake (to|in)|yield (farm|vault)|lido/i.test(t)) return "stake";
  if (/bridge|cross[- ]chain|move .* (to|onto) (arbitrum|base|optimism|polygon|avalanche|solana)/i.test(t)) return "bridge";
  if (direction || /\b(long|short|buy|sell|bullish|bearish|outperform\w*|underperform\w*)\b/i.test(t)) return "directional";
  if (/swap|convert|bridge/i.test(t)) return "swap";
  if (protocol === "Pendle") return "lockYield";
  if (protocol === "Aave") return direction ? "directional" : "supply";
  if (protocol === "Lido") return "stake";
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
    case "options":
    case "directional":
      return "perp";
    case "swap":
    case "supply":
    case "bridge":
      return "swap";
    case "hedge":
    case "repay":
      return "hedge";
    case "stake":
    case "restake":
      return "pendle";
    case "borrow":
    case "withdraw":
      return "custom";
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

  const assets = parseAssets(text);
  const base = assets[0] ?? "ETH";
  const amount = parseAmount(text);
  const protocol = parseProtocol(text);
  const direction = parseDirection(t);
  const swap = parseSwap(text);
  const leverage = parseLeverage(text);
  const recipient = parseRecipient(text);
  const intent = resolveIntent(t, swap, protocol, direction, recipient);

  const size = amount ?? (intent !== "unknown" ? DEFAULT_SIZES[intent] : undefined);
  let legs: TradeLeg[] = [];
  let summary = "";

  switch (intent) {
    case "lockYield": {
      legs = [{ side: "Buy", asset: `PT ${base}`, protocol: protocol ?? "Pendle", sizeUsd: size, note: "Fixed APY" }];
      summary = `Lock the current fixed rate on ${base} through a Pendle Principal Token (PT) for ${fmtUsd(
        size ?? 0,
      )}, capturing the fixed vs variable spread before it compresses.`;
      break;
    }
    case "betaNeutral": {
      const lev = leverage ?? 3;
      legs = [
        { side: "Long", asset: `${base} PERP`, protocol: "Hyperliquid", sizeUsd: size, leverage: lev, note: "Collect points" },
        { side: "Short", asset: `${base} PERP`, protocol: "Extended", sizeUsd: size, leverage: lev },
      ];
      summary = `Farm ${base} points with a long on Hyperliquid paired against an offsetting short on Extended — net delta near zero while keeping the volume eligible for points.`;
      break;
    }
    case "directional": {
      const dir = direction ?? "long";
      const list = assets.length > 0 ? assets : ["ETH"];
      const venue = protocol ?? "Hyperliquid";
      const lev = leverage ?? 4;
      legs = list.map((a) => ({
        side: dir === "long" ? "Long" : "Short",
        asset: `${a} PERP`,
        protocol: venue,
        sizeUsd: size,
        leverage: lev,
      }));
      summary =
        list.length > 1
          ? `Open a ${dir} ${list.join(" and ")} position on ${venue}, ~${fmtUsd(size ?? 0)} notional per leg at ${lev}x leverage (${list.length} legs).`
          : `Open a ${dir} ${list[0]} position on ${venue} for ~${fmtUsd(size ?? 0)} notional at ${lev}x leverage.`;
      break;
    }
    case "swap": {
      const from = swap?.from ?? assets[0] ?? "USDC";
      const to = swap?.to ?? "stETH";
      legs = [{ side: "Swap", asset: `${from} → ${to}`, protocol: protocol ?? "Uniswap", sizeUsd: size }];
      summary = `Swap ~${fmtUsd(size ?? 0)} ${from} into ${to} via ${protocol ?? "Uniswap"} at minimal estimated slippage.`;
      break;
    }
    case "hedge": {
      legs = [
        { side: "Short", asset: `${base} PERP`, protocol: protocol ?? "Hyperliquid", sizeUsd: size, leverage: leverage ?? 1, note: "Delta hedge" },
      ];
      summary = `Short ~${fmtUsd(size ?? 0)} ${base} on ${protocol ?? "Hyperliquid"} to bring the portfolio net delta toward flat without touching the yield legs.`;
      break;
    }
    case "supply": {
      legs = [{ side: "Supply", asset: base, protocol: protocol ?? "Aave", sizeUsd: size, note: "Earn yield" }];
      summary = `Supply ~${fmtUsd(size ?? 0)} ${base} as collateral on ${protocol ?? "Aave"} to earn yield while keeping it ready to borrow against.`;
      break;
    }
    case "borrow": {
      legs = [{ side: "Borrow", asset: base, protocol: protocol ?? "Aave", sizeUsd: size, note: "Variable rate" }];
      summary = `Borrow ~${fmtUsd(size ?? 0)} ${base} against your collateral on ${protocol ?? "Aave"} (variable rate).`;
      break;
    }
    case "repay": {
      legs = [{ side: "Repay", asset: base, protocol: protocol ?? "Aave", sizeUsd: size, note: "Reduce debt" }];
      summary = `Repay ~${fmtUsd(size ?? 0)} ${base} on ${protocol ?? "Aave"} to lower your debt and raise the health factor.`;
      break;
    }
    case "withdraw": {
      legs = [{ side: "Withdraw", asset: base, protocol: protocol ?? "Aave", sizeUsd: size, note: "Exit position" }];
      summary = `Withdraw ~${fmtUsd(size ?? 0)} ${base} from ${protocol ?? "Aave"}${amount ? "" : " (or your full position if smaller)"}.`;
      break;
    }
    case "stake": {
      legs = [{ side: "Stake", asset: base === "ETH" ? "stETH" : base, protocol: protocol ?? "Lido", sizeUsd: size, note: "Liquid staking yield" }];
      summary = `Stake ~${fmtUsd(size ?? 0)} ${base} on ${protocol ?? "Lido"} for liquid staking yield (${base === "ETH" ? "stETH" : base} in return).`;
      break;
    }
    case "restake": {
      legs = [{ side: "Restake", asset: base, protocol: protocol ?? "EigenLayer", sizeUsd: size, note: "Points / extra yield" }];
      summary = `Restake ~${fmtUsd(size ?? 0)} ${base} on ${protocol ?? "EigenLayer"} to stack points and additional yield on top of the base position.`;
      break;
    }
    case "options": {
      const dir = direction ?? (/\bput\b/.test(t) ? "short" : "long");
      const kind = dir === "short" ? "put" : "call";
      legs = [{ side: "Open", asset: `${base} ${kind}`, protocol: protocol ?? "Variational", sizeUsd: size, leverage }];
      summary = `Open a ${kind === "call" ? "call" : "put"} on ${base} via ${protocol ?? "Variational"} for ~${fmtUsd(size ?? 0)} notional${leverage ? ` at ${leverage}x` : ""}.`;
      break;
    }
    case "bridge": {
      legs = [{ side: "Bridge", asset: base, protocol: protocol ?? "Cross-chain", sizeUsd: size }];
      summary = `Bridge ~${fmtUsd(size ?? 0)} ${base}${protocol ? ` via ${protocol}` : " to another chain"}.`;
      break;
    }
    case "transfer": {
      // resolveIntent only ever returns "transfer" when a recipient was found.
      const tokenQty = base === "ETH" ? parseEthQuantity(text) : undefined;
      legs = [
        {
          side: "Transfer",
          asset: base,
          protocol: "Wallet",
          sizeUsd: tokenQty ? undefined : size,
          sizeToken: tokenQty,
          to: recipient,
          note: "Direct send",
        },
      ];
      summary = tokenQty
        ? `Send ${tokenQty} ${base} directly to ${recipient}.`
        : `Send ~${fmtUsd(size ?? 0)} ${base} directly to ${recipient}.`;
      break;
    }
    default: {
      summary = `I could not confidently parse a tradeable plan from "${text}". Rephrase with an asset (ETH, SOL, USDC, ...), a direction (long/short), an intent (lock yield, supply, borrow, stake, hedge, swap, farm points), a size such as $10,000, and optional leverage like 6x.`;
    }
  }

  return { intent, asset: base, direction, sizeUsd: size, leverage, protocol, legs, summary };
}
