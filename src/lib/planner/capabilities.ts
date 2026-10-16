/**
 * capabilities.ts — what Meridian can execute today, generated from the code
 * that executes it, so the planner never relies on a remembered rule. The
 * doctrine (STRATEGIST.md) says how to reason; this says what exists.
 */

import { HL_MIN_ORDER_USD } from "@/lib/integrations/hyperliquidTrade";
import { HL_WITHDRAW_FEE_USD } from "@/lib/integrations/hyperliquidExchange";
import { HL_SPOT_TAKER_FEE, TAKER_FEE } from "@/lib/perpVenues";
import { EXTENDED_MIN_DEPOSIT_USD } from "@/lib/integrations/extendedBridge";

export interface Capability {
  venue: string;
  operation: string;
  /** What must be true for it to run now (funding source, account state). */
  requires: string;
  constraints: string;
}

const pct = (x: number) => `${(x * 100).toFixed(3)}%`;

export const CAPABILITIES: Capability[] = [
  {
    venue: "Hyperliquid",
    operation: "Perp market or limit order (crypto; HIP-3 stocks, indices, commodities)",
    requires: "Free margin in the Hyperliquid account (see HYPERLIQUID ACCOUNT), or a Deposit leg from Arbitrum before it",
    constraints: `Minimum $${HL_MIN_ORDER_USD} notional per order. Taker fee ${pct(TAKER_FEE.Hyperliquid)} per side (base tier). Optional stop-loss / take-profit.`,
  },
  {
    venue: "Hyperliquid",
    operation: "Spot buy / sell UETH, UBTC, USOL",
    requires: "USDC in the Hyperliquid account (buy) or the token (sell)",
    constraints: `Minimum $${HL_MIN_ORDER_USD} per order. Taker fee ${pct(HL_SPOT_TAKER_FEE)} (base tier). On a non-unified account, USDC moves between perps and spot with one signature.`,
  },
  {
    venue: "Hyperliquid",
    operation: "Deposit USDC / withdraw USDC",
    requires: "Native USDC on Arbitrum (deposit); USDC in the account (withdraw)",
    constraints: `Deposit minimum $5 (smaller is lost). Withdrawal fee $${HL_WITHDRAW_FEE_USD}, lands on Arbitrum in ~5 minutes.`,
  },
  {
    venue: "Extended",
    operation: "Perp market order (crypto; RWA: stocks, indices, commodities)",
    requires: "Extended account connected on mainnet (see EXTENDED ACCOUNT) with free margin, or a Deposit leg to Extended before it; state unknown = not usable",
    constraints: `Market minimums vary (read the market). Taker fee ${pct(TAKER_FEE.Extended)} per side.`,
  },
  {
    venue: "Extended",
    operation: "Deposit USDC (side \"Deposit\", protocol \"Extended\", asset \"USDC\", chain \"Arbitrum\")",
    requires: "Extended account connected on mainnet, native USDC in the wallet on Arbitrum",
    constraints: `Minimum $${EXTENDED_MIN_DEPOSIT_USD}. Through Extended's bridge (Rhino.fi): a bridge fee shown on the quote before signing, credited in a few minutes. Put it before the Extended legs it funds.`,
  },
  {
    venue: "Spot DeFi",
    operation: "Lend, borrow, stake, swap, vault deposits, Pendle PT, bridges",
    requires: "Tokens in the wallet on the chain of the step (bridges added automatically between verified chains)",
    constraints: "See the technical reference for protocols, chains and minimums ($5 per step).",
  },
];

export function capabilitiesSection(): string {
  return [
    "# Capability registry (generated from Meridian's code — the only source of what can run)",
    "venue | operation | requires | constraints",
    ...CAPABILITIES.map((c) => `- ${c.venue} | ${c.operation} | ${c.requires} | ${c.constraints}`),
  ].join("\n");
}
