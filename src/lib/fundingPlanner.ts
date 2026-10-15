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
 *   - a stablecoin leg with no such token anywhere → fund it from another
 *     stable: a Uniswap swap on the same chain, or a swapping bridge route
 *     (USDT on Arbitrum → USDC on Base in one transaction);
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
import { UNISWAP_SWAP_ROUTER02_BY_CHAIN } from "@/lib/integrations/uniswap";
import type { TradeLeg, TradePlan } from "@/lib/tradePlan";
import { HL_WITHDRAW_FEE_USD } from "@/lib/integrations/hyperliquidExchange";

const ARBITRUM_ID = 42161;

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

/** Native ETH left for gas when wrapping the rest: L1 gas costs more. */
const gasReserveUsd = (chainId: number) => (chainId === 1 ? 20 : 3);

/** Below this, a balance is dust: not worth a leg or a bridge. */
const DUST_USD = 1;

/** Tokens bridged between the verified routing chains (same symbol on both ends). */
const BRIDGEABLE = new Set(["USDC", "USDT", "DAI", "WETH"]);

/**
 * Stablecoins treated as interchangeable for funding: a USDC leg can be fed
 * from USDT or DAI through a swap (same chain) or a swapping bridge route
 * (cross-chain). Never volatile assets — that would change the user's exposure.
 */
const STABLES = new Set(["USDC", "USDT", "DAI"]);

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
const SPENDING_SIDES = new Set(["supply", "stake", "swap", "buy", "repay", "transfer", "bridge", "restake", "deposit"]);

const key = (chainId: number, symbol: string) => `${chainId}:${symbol.toUpperCase()}`;
const round2Down = (x: number) => Math.floor(x * 100) / 100;

/** The token a leg spends on its chain, by tracked-token symbol (ETH supplied to Aave is WETH; ETH staked on Lido is native ETH). */
export function spentSymbol(leg: TradeLeg, chainId: number): string | null {
  const side = leg.side.toLowerCase();
  if (!SPENDING_SIDES.has(side)) return null;
  const raw = (side === "swap" ? leg.asset.split("→")[0] : side === "bridge" ? (leg.fromAsset ?? leg.asset) : leg.asset)
    .trim()
    .replace(/\s*(PERP|PT)$/i, "");
  if (!raw) return null;
  if (side === "stake" && /lido/i.test(leg.protocol)) return "ETH";
  // Pendle PT is bought with USDC (or WETH for an ETH market) — see PendleExecuteButton.
  if (/pendle/i.test(leg.protocol)) return /eth/i.test(raw) ? "WETH" : "USDC";
  if (side === "transfer" && raw.toUpperCase() === "ETH") return "ETH";
  return (findToken(raw, chainId)?.symbol ?? raw).toUpperCase();
}

/** Share of a swap's notional assumed to arrive after fees and slippage, when crediting its output. */
const SWAP_KEEP = 0.995;

/**
 * The token a leg puts in the wallet on its own chain, if any: a borrow or a
 * withdrawal returns the asset, a swap its output, a Lido stake stETH.
 */
export function producedToken(leg: TradeLeg, chainId: number): { symbol: string; keep: number } | null {
  const side = leg.side.toLowerCase();
  const tracked = (raw: string) => (findToken(raw.trim(), chainId)?.symbol ?? raw.trim()).toUpperCase();
  if (side === "borrow" || side === "withdraw") return { symbol: tracked(leg.asset), keep: 1 };
  if (side === "swap" || side === "buy") {
    const parts = leg.asset.split("→");
    return parts.length === 2 && parts[1].trim() ? { symbol: tracked(parts[1]), keep: SWAP_KEEP } : null;
  }
  if (side === "stake" && /lido/i.test(leg.protocol)) return { symbol: "STETH", keep: 1 };
  if (side === "wrap") return { symbol: "WETH", keep: 1 };
  return null;
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
  // The part of a balance that earlier legs produce: sized by the same live
  // price as the leg that spends it, so it needs no rounding margin.
  const produced = new Map<string, number>();

  const legs: TradeLeg[] = [];
  const notes: string[] = [];

  for (const original of plan.legs) {
    const leg = { ...original };
    const chainId = legChain(leg, deps.connectedChainId);
    // What this leg leaves in the wallet (borrowed WETH, the swap's output,
    // stETH from Lido) funds the legs after it, so a chain like "borrow WETH →
    // swap to wstETH → supply wstETH" isn't mistaken for a wallet shortfall.
    let funded = true;
    try {
      const symbol = chainId !== undefined ? spentSymbol(leg, chainId) : null;
      const size = leg.sizeUsd ?? 0;
      if (chainId === undefined || !symbol || !(size > 0)) {
        legs.push(leg);
        continue;
      }
      const chainLabel = CHAIN_LABEL[chainId] ?? `chain ${chainId}`;
      const isBridge = leg.side.toLowerCase() === "bridge";
      const have = bal(chainId, symbol);

      const fromSteps = Math.min(produced.get(key(chainId, symbol)) ?? 0, have);
      if ((have - fromSteps) * BALANCE_MARGIN + fromSteps >= size) {
        add(chainId, symbol, -size);
        produced.set(key(chainId, symbol), Math.max(0, fromSteps - size));
        if (isBridge) creditBridge(leg, symbol, size);
        legs.push(leg);
        continue;
      }

      // WETH short but native ETH on this chain: wrap it first (WETH.deposit),
      // keeping some ETH for gas. Aave, Uniswap and the rest spend WETH.
      if (symbol === "WETH" && !isBridge) {
        const spare = bal(chainId, "ETH") - gasReserveUsd(chainId);
        const need = round2Down(size - have * BALANCE_MARGIN);
        if (spare >= DUST_USD && need > 0) {
          const wrapUsd = round2Down(Math.min(need, spare));
          legs.push({
            side: "Wrap",
            asset: "ETH",
            protocol: "WETH",
            chain: chainLabel,
            sizeUsd: wrapUsd,
            note: `Added by Meridian: wraps your native ETH into WETH for the next step (1:1, reversible).`,
          });
          add(chainId, "ETH", -wrapUsd);
          const funded = round2Down(Math.min(size, have * BALANCE_MARGIN + wrapUsd));
          if (funded < size) leg.sizeUsd = funded;
          add(chainId, "WETH", wrapUsd - funded);
          legs.push(leg);
          notes.push(
            `Your ETH on ${chainLabel} is native: a $${wrapUsd} wrap into WETH was added first` +
              (funded < size ? `, and the ${leg.side.toLowerCase()} is sized to $${funded}, keeping some ETH for gas.` : "."),
          );
          continue;
        }
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

      // No same-token funds elsewhere: a stablecoin leg can still be fed from
      // another stable — swapped on this chain (Uniswap), or swapped and bridged
      // in one route from a verified chain.
      const alt = !isBridge && STABLES.has(symbol) ? bestStableSource(symbol, chainId) : undefined;
      if (alt) {
        const altLabel = CHAIN_LABEL[alt.chainId] ?? `chain ${alt.chainId}`;
        const convertUsd = round2Down(Math.min(shortfall, alt.usd * BALANCE_MARGIN));
        const sameChain = alt.chainId === chainId;
        legs.push(
          sameChain
            ? {
                side: "Swap",
                asset: `${alt.symbol} → ${symbol}`,
                protocol: "Uniswap",
                chain: chainLabel,
                sizeUsd: convertUsd,
                note: `Added by Meridian: swaps your ${alt.symbol} into ${symbol} for the next step.`,
              }
            : {
                side: "Bridge",
                asset: symbol,
                fromAsset: alt.symbol,
                protocol: "deBridge",
                chain: altLabel,
                toChain: chainLabel,
                sizeUsd: convertUsd,
                note: `Added by Meridian: moves your ${alt.symbol} from ${altLabel} and delivers ${symbol} on ${chainLabel} in one route.`,
              },
        );
        add(alt.chainId, alt.symbol, -convertUsd);
        const arriving = convertUsd * (1 - BRIDGE_FEE_BUFFER);
        const funded = round2Down(Math.min(size, (have + arriving) * BALANCE_MARGIN));
        if (funded < size) leg.sizeUsd = funded;
        add(chainId, symbol, arriving - funded);
        legs.push(leg);
        notes.push(
          (sameChain
            ? `Your stables on ${chainLabel} are ${alt.symbol}, not ${symbol}: a $${convertUsd} swap was added first`
            : `Your ${alt.symbol} on ${altLabel} funds this: a $${convertUsd} route was added that swaps it to ${symbol} and bridges it to ${chainLabel}`) +
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
        funded = false;
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
    } finally {
      if (funded && chainId !== undefined) creditOutput(leg, chainId);
    }
  }

  function creditOutput(leg: TradeLeg, chainId: number) {
    if (/hyperliquid/i.test(leg.protocol) && leg.side.toLowerCase() === "withdraw") {
      // A withdrawal from the Hyperliquid account lands as native USDC on Arbitrum, minus Hyperliquid's fee.
      const usd = Math.max(0, (leg.sizeUsd ?? 0) - HL_WITHDRAW_FEE_USD);
      add(ARBITRUM_ID, "USDC", usd);
      produced.set(key(ARBITRUM_ID, "USDC"), (produced.get(key(ARBITRUM_ID, "USDC")) ?? 0) + usd);
      return;
    }
    const out = producedToken(leg, chainId);
    const usd = leg.sizeUsd ?? 0;
    if (!out || !(usd > 0)) return;
    add(chainId, out.symbol, usd * out.keep);
    produced.set(key(chainId, out.symbol), (produced.get(key(chainId, out.symbol)) ?? 0) + usd * out.keep);
  }

  function creditBridge(leg: TradeLeg, spent: string, usd: number) {
    const to = chainIdFromName(leg.toChain);
    if (to === undefined) return;
    const delivered = leg.fromAsset ? (findToken(leg.asset, to)?.symbol ?? leg.asset).toUpperCase() : spent;
    add(to, delivered, usd * (1 - BRIDGE_FEE_BUFFER));
  }

  /** Another stable that can fund `symbol` on `targetChainId`: on that chain if Uniswap can swap there, else the largest holding on a verified routing chain. */
  function bestStableSource(symbol: string, targetChainId: number): { chainId: number; symbol: string; usd: number } | undefined {
    let sameChain: { chainId: number; symbol: string; usd: number } | undefined;
    let remote: { chainId: number; symbol: string; usd: number } | undefined;
    for (const [k, usd] of balances) {
      const [idStr, sym] = k.split(":");
      const id = Number(idStr);
      if (sym === symbol || !STABLES.has(sym) || usd < DUST_USD || !findToken(sym, id)) continue;
      if (id === targetChainId) {
        if (UNISWAP_SWAP_ROUTER02_BY_CHAIN[id] && (!sameChain || usd > sameChain.usd)) sameChain = { chainId: id, symbol: sym, usd };
      } else if (isRoutingSupportedChain(id) && isRoutingSupportedChain(targetChainId) && (!remote || usd > remote.usd)) {
        remote = { chainId: id, symbol: sym, usd };
      }
    }
    return sameChain ?? remote;
  }

  function bestSource(symbol: string, targetChainId: number): { chainId: number; usd: number } | undefined {
    let best: { chainId: number; usd: number } | undefined;
    for (const [k, usd] of balances) {
      const [idStr, sym] = k.split(":");
      const id = Number(idStr);
      if (sym !== symbol || id === targetChainId || usd < DUST_USD || !isRoutingSupportedChain(id)) continue;
      // Only a token Meridian tracks on that chain can be bridged from it.
      if (!findToken(symbol, id)) continue;
      if (!best || usd > best.usd) best = { chainId: id, usd };
    }
    return best;
  }

  return notes.length ? { ...plan, legs, fundingNotes: [...(plan.fundingNotes ?? []), ...notes] } : plan;
}
