import type { Address } from "viem";
import { mainnet, base, arbitrum, optimism, polygon, avalanche } from "wagmi/chains";

/**
 * uniswap.ts — Uniswap v3 SwapRouter02 + QuoterV2 integration.
 *
 * Addresses verified 2026-09 against Uniswap's own docs repo
 * (github.com/Uniswap/docs, content/protocols/v3/deployments/*) — the
 * canonical source Uniswap Labs itself publishes, cross-checked against the
 * on-chain interfaces in github.com/Uniswap/v3-periphery (IQuoterV2.sol) and
 * github.com/Uniswap/swap-router-contracts (IV3SwapRouter.sol). Wrong
 * addresses here would silently misroute real money — double-check any
 * change against a second source.
 *
 * SwapRouter02 (not the newer UniversalRouter) is used deliberately: it is a
 * single-purpose, immutable router — plain ERC20 approve + one call, no
 * Permit2 signature flow — matching this codebase's existing Aave-style
 * execution pattern (see execution.ts). It remains live and fully
 * functional; Uniswap's docs note UniversalRouter is now the *recommended*
 * entrypoint, not that SwapRouter02 is deprecated/disabled.
 *
 * Everything here is pure (no network I/O) — the live on-chain quote
 * (QuoterV2.quoteExactInputSingle) is a `nonpayable` function meant to be
 * called via eth_call/simulate, which only makes sense from a component
 * with a wagmi client, not from this pure module.
 */

/** SwapRouter02, same address on every chain except Base and Avalanche (separate deployments). */
export const UNISWAP_SWAP_ROUTER02_BY_CHAIN: Record<number, Address> = {
  [mainnet.id]: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
  [base.id]: "0x2626664c2603336E57B271c5C0b26F421741e481",
  [arbitrum.id]: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
  [optimism.id]: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
  [polygon.id]: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
  [avalanche.id]: "0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE",
};

/** QuoterV2, same address on every chain except Base and Avalanche (separate deployments). */
export const UNISWAP_QUOTER_V2_BY_CHAIN: Record<number, Address> = {
  [mainnet.id]: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  [base.id]: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
  [arbitrum.id]: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  [optimism.id]: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  [polygon.id]: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  [avalanche.id]: "0xbe0F5544EC67e9B3b2D979aaA43f18Fd87E6257F",
};

/**
 * QuoterV2.quoteExactInputSingle — declared `nonpayable` (not `view`) by
 * Uniswap because it internally simulates the swap, but unlike QuoterV1 it
 * returns its result normally rather than via a caught revert, so a plain
 * eth_call / wagmi `simulateContract` decodes it like any other read.
 */
export const QUOTER_V2_QUOTE_EXACT_INPUT_SINGLE_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

/** SwapRouter02.exactInputSingle — single-hop exact-input swap, payable, no `deadline` param (SwapRouter02 dropped it vs v1 SwapRouter). */
export const SWAP_ROUTER02_EXACT_INPUT_SINGLE_ABI = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

/** Uniswap v3 fee tiers, in hundredths of a bip (500 = 0.05%, 3000 = 0.3%, 10000 = 1%). */
export const FEE_TIER_STABLE = 500;
export const FEE_TIER_STANDARD = 3000;

const STABLE_SYMBOLS = new Set(["USDC", "USDT", "DAI"]);

/**
 * Pick a sensible default v3 fee tier: 0.05% for stable-to-stable pairs
 * (deepest, tightest-spread pools), 0.3% for everything else. Deliberately a
 * single-tier heuristic, not multi-pool liquidity probing — v1 scope, same
 * "curated, not auto-discovered" tradeoff already made for tracked tokens
 * (see onchain.ts).
 */
export function defaultFeeTier(tokenInSymbol: string, tokenOutSymbol: string): number {
  const a = tokenInSymbol.trim().toUpperCase();
  const b = tokenOutSymbol.trim().toUpperCase();
  return STABLE_SYMBOLS.has(a) && STABLE_SYMBOLS.has(b) ? FEE_TIER_STABLE : FEE_TIER_STANDARD;
}

/** Default slippage tolerance applied to a live quote: 0.5%. */
export const DEFAULT_SLIPPAGE_BPS = 50;

/**
 * Apply a slippage tolerance (basis points, 10_000 = 100%) to a quoted output
 * amount, producing the `amountOutMinimum` a swap is signed with. Pure —
 * rounds down (floor) so the minimum is never overstated.
 */
export function applySlippage(amountOut: bigint, slippageBps: number = DEFAULT_SLIPPAGE_BPS): bigint {
  if (amountOut <= BigInt(0)) return BigInt(0);
  const bps =
    Number.isFinite(slippageBps) && slippageBps >= 0 && slippageBps < 10_000
      ? Math.round(slippageBps)
      : DEFAULT_SLIPPAGE_BPS;
  return (amountOut * BigInt(10_000 - bps)) / BigInt(10_000);
}

/**
 * Parse a tradePlan "swap" leg's `asset` field (e.g. "USDC → wstETH", as
 * produced by tradePlan.ts's swap intent) into a { from, to } pair. Returns
 * null when the leg doesn't carry that arrow-separated shape.
 */
export function parseSwapAsset(asset: string): { from: string; to: string } | null {
  const m = /^(.+?)\s*→\s*(.+)$/.exec(asset || "");
  if (!m) return null;
  const from = m[1].trim();
  const to = m[2].trim();
  if (!from || !to) return null;
  return { from, to };
}
