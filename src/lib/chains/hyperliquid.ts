import type { ChainDef, ProtocolDef } from "./types";

/**
 * Hyperliquid — Meridian chain × protocol registry.
 *
 * Hyperliquid is treated as a first-class, non-EVM venue/chain. Its flagship
 * perpetuals exchange is an off-chain order book whose orders are signed with
 * EIP-712 signatures and submitted over its HTTP API — not a classic onchain
 * AMM. Meridian is already integrated for perp execution: we place and close
 * testnet orders today, so Hyperliquid Perps is honestly `live` (testnet-first).
 *
 * Everything else (spot, the HyperCore L1, HyperEVM, HLP/ALP vaults, Hyperlend)
 * is accurately inventoried and marked `planned` to be wired next. Pure data
 * (no React). Order is roughly by relevance to Meridian.
 */

export const HYPERLIQUID_PROTOCOLS: ProtocolDef[] = [
  {
    name: "Hyperliquid Perps",
    category: "perps",
    token: "HYPE",
    status: "live",
    note: "Orderbook perpetuals DEX; Meridian places/closes orders via EIP-712-signed HTTP API — live on testnet, mainnet planned.",
  },
  {
    name: "Hyperliquid Spot",
    category: "dex",
    status: "planned",
    note: "Native spot orderbook + AMM on Hyperliquid. Same signing path as perps; to be wired for spot execution next.",
  },
  {
    name: "HLP (Hyperliquid Liquidator)",
    category: "yield",
    token: "HLP",
    status: "planned",
    note: "Core vault: acts as the exchange's liquidator, earns yield and perp fees. Readable via API once wired.",
  },
  {
    name: "HyperCore",
    category: "other",
    status: "planned",
    note: "Hyperliquid's bespoke L1 consensus layer (HyperBFT); not EVM. Registry entry for the chain/runtime itself.",
  },
  {
    name: "HyperEVM",
    category: "other",
    status: "planned",
    note: "Hyperliquid's EVM-compatible environment; would enable standard wagmi-based contracts on the chain.",
  },
  {
    name: "Hyperlend",
    category: "lending",
    status: "planned",
    note: "Borrowing/lending money market building on the Hyperliquid ecosystem. Planned read integration.",
  },
  {
    name: "Hyperliquidity (ALP)",
    category: "yield",
    token: "ALP",
    status: "planned",
    note: "Automated liquidity provisioning vault that markets spot/perps and earns fees + funding. Planned.",
  },
  {
    name: "HYPE",
    category: "other",
    token: "HYPE",
    status: "planned",
    note: "Hyperliquid's native token (staking/chain gas + perp collateral). Inventory for balances once read layer lands.",
  },
  {
    name: "Hyperliquid Bridge",
    category: "bridge",
    status: "planned",
    note: "Native bridging of USDC/ETH onto Hyperliquid (via the API's deposit/withdraw flow). Planned.",
  },
];

export const HYPERLIQUID_CHAIN: ChainDef = {
  id: "hyperliquid",
  name: "Hyperliquid",
  isEvm: false,
  sdk: "hyperliquid EIP-712 + REST",
  walletAdapter: "hyperliquid-signature",
  status: "supported",
  protocols: HYPERLIQUID_PROTOCOLS,
};
