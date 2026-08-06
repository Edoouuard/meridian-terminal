import type { ChainDef, ProtocolDef } from "./types";

/**
 * Robinhood (RHX) — Robinhood's EVM-compatible Layer-1.
 *
 * RHX mainnet only went live recently and the ecosystem is still taking root,
 * so per-chain coverage here is forming rather than complete. This registry is
 * deliberately conservative: every entry lists a protocol we strongly expect to
 * be live/prominent on RHX (or that has announced plans to deploy), but NOTHING
 * is asserted as a verified deployment, and no contract addresses are recorded
 * (we have not independently confirmed RHX addresses). Everything is tagged
 * "planned" — Meridian has not wired RHX execution yet.
 *
 * As RHX deployments are confirmed, replace expectations with verified facts
 * and add canonical addresses.
 */

export const RHX_PROTOCOLS: ProtocolDef[] = [
  {
    name: "Uniswap v3",
    category: "dex",
    status: "planned",
    note: "Canonical AMM DEX; expected to deploy to RHX as with other major EVM/Superchain networks. Not yet verified on RHX.",
  },
  {
    name: "Aave v3",
    category: "lending",
    status: "planned",
    note: "Largest multi-chain lending prime; strongly expected to bring money-market lending to RHX. Deployment not yet confirmed.",
  },
  {
    name: "Aerodrome Finance",
    category: "dex",
    status: "planned",
    note: "Superchain-native ve(3,3) DEX/liquidity hub; RHX sitting in the Superchain makes this a likely listing. Verify before wiring.",
  },
  {
    name: "Beefy Finance",
    category: "yield",
    status: "planned",
    note: "Yield auto-compounder that ships to nearly every EVM network; plausible early RHX presence. Status forming.",
  },
  {
    name: "USDC (native)",
    category: "stablecoin",
    status: "planned",
    note: "Circle's native USDC is expected on a U.S. consumer-focused L1; not yet independently verified on RHX.",
  },
  {
    name: "Squid Router",
    category: "aggregator",
    status: "planned",
    note: "Cross-chain asset-swap router native to the Optimism Superchain; a plausible bridging/aggregation entry point into RHX.",
  },
];

export const RHX_CHAIN: ChainDef = {
  id: "rhx",
  name: "Robinhood (RHX)",
  isEvm: true,
  sdk: "wagmi/viem",
  walletAdapter: "wagmi",
  status: "planned",
  protocols: RHX_PROTOCOLS,
};