/**
 * fundingPlanner.ts — make a strategy executable with the funds the wallet
 * actually holds.
 *
 * The LLM picks the best venue and chain for each leg, but it doesn't
 * guarantee the wallet holds the leg's input token on that chain. Run after
 * the plan comes back, this walks the legs in order against the live
 * per-chain balances and, for each leg that spends a token:
 *
 *   - enough on the leg's chain → leave it;
 *   - short, but the same token sits on another verified routing chain →
 *     insert a Bridge leg first, unless staying put is the better deal: when
 *     the same protocol pays on the source chain too and the extra APY would
 *     take longer than BRIDGE_PAYBACK_DAYS to repay the live bridge cost,
 *     the leg moves to the source chain instead;
 *   - not available anywhere → size the leg down to what the chain holds, or
 *     say plainly that the wallet has none.
 *
 * Every change is explained in `plan.fundingNotes`. Network reads (bridge
 * quote, per-chain APY) are injected, so the logic itself is pure and tested.
 */

import { CHAIN_LABEL } from "@/lib/onchain";
import { chainIdFromName } from "@/lib/chains";
import { findToken } from "@/lib/assetMap";
import { isRoutingSupportedChain } from "@/lib/mcp/routerAllowlist";
import type { TradeLeg, TradePlan } from "@/lib/tradePlan";

/** A bridge has to pay for itself in extra yield within this many days. */
export const BRIDGE_PAYBACK_DAYS = 90;

/** Share of a bridged amount assumed lost to fees when sizing the leg it funds (live quotes run ~0.1–0.5%). */
const BRIDGE_FEE_BUFFER = 0.01;

/**
 * A leg sized to a balance keeps this share of it: the order converts USD to
 * tokens at the live price, so sizing to the exact balance can ask for a hair
 * more than the wallet holds (USDC at $0.9999) and fail the balance check.
 */
const BALANCE_MARGIN = 0.995;

/** Below this, a balance is dust: not worth a leg or a bridge. */
const DUST_USD = 1;

/** Tokens bridged between the verified routing chains (same symbol on both ends). */
const BRIDGEABLE = new Set(["USDC", "USDT", "DAI", "WETH"]);

export interface WalletAsset {
  symbol: string;
  chain: string;
  usd: number;
}

export interface FundingDeps {
  /** Live wallet holdings, one row per token per chain. */
  assets: WalletAsset[];
  /** Chain a leg runs on when the plan doesn't name one. */
  connectedChainId?: number;
  /** USD lost bridging `amountUsd` of `symbol` (fees + slippage), from a live route quote; null when no route. */
  bridgeCostUsd: (fromChainId: number, toChainId: number, symbol: string, amountUsd: number) => Promise<number | null>;
  /** Current APY (percent) of `protocol` for `symbol` on a chain, null when unknown there. */
  apyFor: (protocol: string, symbol: string, chainLabel: string) => Promise<number | null>;
}

/** Sides that spend a wallet token (the rest — borrow, withdraw, perps — don't need one up front). */
const SPENDING_SIDES = new Set(["supply", "stake", "swap", "buy", "repay", "transfer", "bridge", "restake"]);

const key = (chainId: number, symbol: string) => `${chainId}:${symbol.toUpperCase()}`;
const round2Down = (x: number) => Math.floor(x * 100) / 100;

/** The token a leg spends on its chain, by tracked-token symbol (ETH supplied to Aave is WETH; ETH staked on Lido is native ETH). */
export function spentSymbol(leg: TradeLeg, chainId: number): string | null {
  const side = leg.side.toLowerCase();
  if (!SPENDING_SIDES.has(side)) return null;
  const raw = (side === "swap" ? leg.asset.split("→")[0] : leg.asset).trim().replace(/\s*(PERP|PT)$/i, "");
  if (!raw) return null;
  if (side === "stake" && /lido/i.test(leg.protocol)) return "ETH";
  if (side === "transfer" && raw.toUpperCase() === "ETH") return "ETH";
  return (findToken(raw, chainId)?.symbol ?? raw).toUpperCase();
}

function legChain(leg: TradeLeg, connectedChainId?: number): number | undefined {
  return chainIdFromName(leg.chain) ?? connectedChainId;
}

/**
 * Rewrite a plan so every spending leg is funded from what the wallet holds,
 * adding bridge legs where that pays off. Returns the plan unchanged (minus a
 * note) when nothing needs to move.
 */
export async function fundPlan(plan: TradePlan, deps: FundingDeps): Promise<TradePlan> {
  const balances = new Map<string, number>();
  for (const a of deps.assets) {
    const id = chainIdFromName(a.chain);
    if (id === undefined || !(a.usd > 0)) continue;
    balances.set(key(id, a.symbol), (balances.get(key(id, a.symbol)) ?? 0) + a.usd);
  }
  const bal = (chainId: number, symbol: string) => balances.get(key(chainId, symbol)) ?? 0;
  const add = (chainId: number, symbol: string, usd: number) => balances.set(key(chainId, symbol), bal(chainId, symbol) + usd);

  const legs: TradeLeg[] = [];
  const notes: string[] = [];

  for (const original of plan.legs) {
    const leg = { ...original };
    const chainId = legChain(leg, deps.connectedChainId);
    const symbol = chainId !== undefined ? spentSymbol(leg, chainId) : null;
    const size = leg.sizeUsd ?? 0;
    if (chainId === undefined || !symbol || !(size > 0)) {
      legs.push(leg);
      continue;
    }
    const chainLabel = CHAIN_LABEL[chainId] ?? `chain ${chainId}`;
    const isBridge = leg.side.toLowerCase() === "bridge";
    const have = bal(chainId, symbol);

    if (have * BALANCE_MARGIN >= size) {
      add(chainId, symbol, -size);
      if (isBridge) creditBridge(leg, symbol, size);
      legs.push(leg);
      continue;
    }

    // Short on this chain: look for the same token on another verified routing chain.
    const shortfall = size - have;
    const source =
      !isBridge && BRIDGEABLE.has(symbol) && isRoutingSupportedChain(chainId)
        ? bestSource(symbol, chainId)
        : undefined;

    if (source) {
      const sourceLabel = CHAIN_LABEL[source.chainId] ?? `chain ${source.chainId}`;
      const bridgeUsd = round2Down(Math.min(shortfall, source.usd * BALANCE_MARGIN));

      // Staying put beats bridging when the source chain can fund the whole
      // leg, the same protocol pays there too, and the extra yield on the
      // target wouldn't repay the bridge within the payback window.
      if (have < DUST_USD && source.usd * BALANCE_MARGIN >= size) {
        const [targetApy, sourceApy, cost] = await Promise.all([
          deps.apyFor(leg.protocol, symbol, chainLabel),
          deps.apyFor(leg.protocol, symbol, sourceLabel),
          deps.bridgeCostUsd(source.chainId, chainId, symbol, bridgeUsd),
        ]);
        if (targetApy !== null && sourceApy !== null && cost !== null) {
          const extraPerDay = (size * (targetApy - sourceApy)) / 100 / 365;
          const paybackDays = extraPerDay > 0 ? cost / extraPerDay : Infinity;
          if (paybackDays > BRIDGE_PAYBACK_DAYS) {
            leg.chain = sourceLabel;
            add(source.chainId, symbol, -size);
            legs.push(leg);
            notes.push(
              `${leg.side} ${symbol} on ${leg.protocol} moved to ${sourceLabel}, where your ${symbol} is: bridging to ${chainLabel} costs ~$${cost.toFixed(2)}` +
                (extraPerDay > 0
                  ? ` and its extra ${(targetApy - sourceApy).toFixed(2)}% APY would take ${Math.ceil(paybackDays)} days to pay that back.`
                  : ` for no better yield (${sourceApy.toFixed(2)}% on ${sourceLabel} vs ${targetApy.toFixed(2)}%).`),
            );
            continue;
          }
        }
      }

      const bridgeLeg: TradeLeg = {
        side: "Bridge",
        asset: symbol,
        protocol: "deBridge",
        chain: sourceLabel,
        toChain: chainLabel,
        sizeUsd: bridgeUsd,
        note: `Added by Meridian: moves your ${symbol} from ${sourceLabel} to fund the next step on ${chainLabel}.`,
      };
      legs.push(bridgeLeg);
      add(source.chainId, symbol, -bridgeUsd);
      const arriving = bridgeUsd * (1 - BRIDGE_FEE_BUFFER);
      const funded = round2Down(Math.min(size, (have + arriving) * BALANCE_MARGIN));
      if (funded < size) leg.sizeUsd = funded;
      add(chainId, symbol, arriving - funded);
      legs.push(leg);
      notes.push(
        `Your ${symbol} is on ${sourceLabel}, not ${chainLabel}: a $${bridgeUsd} bridge was added first` +
          (funded < size ? `, and the ${leg.side.toLowerCase()} is sized to $${funded} (what arrives after fees).` : "."),
      );
      continue;
    }

    // Nothing to bridge from: use what this chain holds, or say there's none.
    if (have >= DUST_USD) {
      leg.sizeUsd = round2Down(have * BALANCE_MARGIN);
      add(chainId, symbol, -have);
      if (isBridge) creditBridge(leg, symbol, leg.sizeUsd);
      notes.push(`${leg.side} ${symbol} on ${chainLabel} sized down to $${leg.sizeUsd}: that's all the ${symbol} your wallet holds there.`);
    } else {
      notes.push(
        `Your wallet holds no ${symbol} on ${chainLabel}` +
          (BRIDGEABLE.has(symbol)
            ? isRoutingSupportedChain(chainId)
              ? " or on any chain Meridian can bridge from"
              : ` (and Meridian can't bridge into ${chainLabel})`
            : "") +
          ` — the ${leg.side.toLowerCase()} step can't be funded as planned.`,
      );
    }
    legs.push(leg);
  }

  function creditBridge(leg: TradeLeg, symbol: string, usd: number) {
    const to = chainIdFromName(leg.toChain);
    if (to !== undefined) add(to, symbol, usd * (1 - BRIDGE_FEE_BUFFER));
  }

  function bestSource(symbol: string, targetChainId: number): { chainId: number; usd: number } | undefined {
    let best: { chainId: number; usd: number } | undefined;
    for (const [k, usd] of balances) {
      const [idStr, sym] = k.split(":");
      const id = Number(idStr);
      if (sym !== symbol || id === targetChainId || usd < DUST_USD || !isRoutingSupportedChain(id)) continue;
      if (!best || usd > best.usd) best = { chainId: id, usd };
    }
    return best;
  }

  return notes.length ? { ...plan, legs, fundingNotes: notes } : plan;
}
