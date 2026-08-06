/**
 * chains — Meridian's chain × protocol coverage registry.
 *
 * The vision is a unified multi-chain DeFi terminal. Not every chain runs EVM
 * (Solana uses its own VM/SDK), so we tag each chain with its runtime and
 * wallet adapter, and each protocol with an honest integration `status`:
 *   - "live"    = actually wired & executing in Meridian today,
 *   - "read"    = readable (balances/positions) with the current stack,
 *   - "planned" = inventoried with accurate data, to be wired next.
 * This registry is pure data (no React) — the terminal renders chain/protocol
 * coverage from it, and execution layers consume it later.
 */

export type IntegrationStatus = "live" | "read" | "planned";

export type ProtocolCategory =
  | "lending"
  | "dex"
  | "yield"
  | "lst"
  | "restaking"
  | "perps"
  | "options"
  | "bridge"
  | "aggregator"
  | "oracle"
  | "stablecoin"
  | "liquid-staking"
  | "money-market"
  | "other";

export interface ProtocolDef {
  /** Protocol name (display). */
  name: string;
  category: ProtocolCategory;
  /** Canonical address (contract / program) when known and verifiable. Optional. */
  address?: string;
  /** Primary token symbol it manages, if any (e.g. "USDC", "stETH"). Optional. */
  token?: string;
  /** Honest integration status in Meridian today. */
  status: IntegrationStatus;
  /** One-line note (TVL ballpark, role, or why planned). Optional. */
  note?: string;
}

/** Which wallet/runtime adapter a chain needs in Meridian. */
export type WalletAdapter = "wagmi" | "solana" | "hyperliquid-signature" | "api-key" | "none";

export interface ChainDef {
  id: string;
  name: string;
  isEvm: boolean;
  /** Runtime SDK used to talk to the chain. */
  sdk: string;
  /** Wallet/runtime adapter in Meridian. */
  walletAdapter: WalletAdapter;
  status: "supported" | "in-progress" | "planned";
  /** The ~10 largest / most relevant protocols on this chain. */
  protocols: ProtocolDef[];
}
