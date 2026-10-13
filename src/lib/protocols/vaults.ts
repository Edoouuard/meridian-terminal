/**
 * protocols/vaults.ts — ERC-4626 savings vaults Meridian deposits into.
 *
 * One generic flow covers them all (approve the underlying to the vault, then
 * `deposit(assets, receiver)`), so adding a protocol is adding a verified row
 * here, never new signing code. Each row was checked on-chain before being
 * added: `asset()` returns exactly `assetAddress`, decimals match and the vault
 * holds real assets (e2e/onchain.audit.test.ts re-checks every row on each
 * run). Rates come from DefiLlama's pools API, matched by `llamaProject` +
 * chain + symbol (see lib/protocols/registry.ts).
 */

import type { Address } from "viem";

export interface VaultEntry {
  /** Protocol name as the planner and the UI write it. */
  protocol: "Fluid" | "Sky" | "Spark Savings" | "Ethena";
  /** DefiLlama project slug, for live rates. */
  llamaProject: string;
  /** DefiLlama pool symbol for this vault (the underlying for Fluid/Spark, the share token for sUSDS/sUSDe). */
  llamaSymbol: string;
  chainId: number;
  vault: Address;
  /** Share token symbol (fUSDC, sUSDS…). */
  shareSymbol: string;
  /** Underlying asset the user deposits. */
  assetSymbol: string;
  assetAddress: Address;
  assetDecimals: number;
  /** How the user gets out. */
  exit: string;
  /** Whether `withdraw` works directly (false: a cooldown or a separate flow). */
  instantWithdraw: boolean;
}

export const VAULTS: VaultEntry[] = [
  // Fluid lending fTokens — supply-side of Fluid's liquidity layer.
  { protocol: "Fluid", llamaProject: "fluid-lending", llamaSymbol: "USDC", chainId: 1, vault: "0x9Fb7b4477576Fe5B32be4C1843aFB1e55F251B33", shareSymbol: "fUSDC", assetSymbol: "USDC", assetAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", assetDecimals: 6, exit: "Instant (pool liquidity permitting)", instantWithdraw: true },
  { protocol: "Fluid", llamaProject: "fluid-lending", llamaSymbol: "USDT", chainId: 1, vault: "0x5C20B550819128074FD538Edf79791733ccEdd18", shareSymbol: "fUSDT", assetSymbol: "USDT", assetAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7", assetDecimals: 6, exit: "Instant (pool liquidity permitting)", instantWithdraw: true },
  { protocol: "Fluid", llamaProject: "fluid-lending", llamaSymbol: "WETH", chainId: 1, vault: "0x90551c1795392094FE6D29B758EcCD233cFAa260", shareSymbol: "fWETH", assetSymbol: "WETH", assetAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", assetDecimals: 18, exit: "Instant (pool liquidity permitting)", instantWithdraw: true },
  { protocol: "Fluid", llamaProject: "fluid-lending", llamaSymbol: "USDC", chainId: 42161, vault: "0x1A996cb54bb95462040408C06122D45D6Cdb6096", shareSymbol: "fUSDC", assetSymbol: "USDC", assetAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", assetDecimals: 6, exit: "Instant (pool liquidity permitting)", instantWithdraw: true },
  { protocol: "Fluid", llamaProject: "fluid-lending", llamaSymbol: "USD₮0", chainId: 42161, vault: "0x4A03F37e7d3fC243e3f99341d36f4b829BEe5E03", shareSymbol: "fUSDT", assetSymbol: "USDT", assetAddress: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", assetDecimals: 6, exit: "Instant (pool liquidity permitting)", instantWithdraw: true },
  { protocol: "Fluid", llamaProject: "fluid-lending", llamaSymbol: "USDC", chainId: 8453, vault: "0xf42f5795D9ac7e9D757dB633D693cD548Cfd9169", shareSymbol: "fUSDC", assetSymbol: "USDC", assetAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", assetDecimals: 6, exit: "Instant (pool liquidity permitting)", instantWithdraw: true },

  // Sky Savings Rate (sUSDS) — USDS earns the Sky Savings Rate.
  { protocol: "Sky", llamaProject: "sky-lending", llamaSymbol: "SUSDS", chainId: 1, vault: "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD", shareSymbol: "sUSDS", assetSymbol: "USDS", assetAddress: "0xdC035D45d973E3EC169d2276DDab16f1e407384F", assetDecimals: 18, exit: "Instant", instantWithdraw: true },

  // Spark Savings sUSDC — USDC routed into the Sky Savings Rate by Spark.
  { protocol: "Spark Savings", llamaProject: "spark-savings", llamaSymbol: "USDC", chainId: 1, vault: "0xBc65ad17c5C0a2A4D159fa5a503f4992c7B545FE", shareSymbol: "sUSDC", assetSymbol: "USDC", assetAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", assetDecimals: 6, exit: "Instant", instantWithdraw: true },
  // On Base and Arbitrum DefiLlama lists Spark Savings under USDS; sUSDC earns the same Sky Savings Rate.
  { protocol: "Spark Savings", llamaProject: "spark-savings", llamaSymbol: "USDS", chainId: 8453, vault: "0x3128a0F7f0ea68E7B7c9B00AFa7E41045828e858", shareSymbol: "sUSDC", assetSymbol: "USDC", assetAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", assetDecimals: 6, exit: "Instant", instantWithdraw: true },
  { protocol: "Spark Savings", llamaProject: "spark-savings", llamaSymbol: "USDS", chainId: 42161, vault: "0x940098b108fB7D0a7E374f6eDED7760787464609", shareSymbol: "sUSDC", assetSymbol: "USDC", assetAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", assetDecimals: 6, exit: "Instant", instantWithdraw: true },

  // Ethena staked USDe — deposits are open; withdrawals go through a cooldown.
  { protocol: "Ethena", llamaProject: "ethena-usde", llamaSymbol: "SUSDE", chainId: 1, vault: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497", shareSymbol: "sUSDe", assetSymbol: "USDe", assetAddress: "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3", assetDecimals: 18, exit: "7-day cooldown (or sell sUSDe on market)", instantWithdraw: false },
];

const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_-]+/g, " ");

/** Protocol names the planner may write for a vault venue. */
const PROTOCOL_ALIASES: Record<string, VaultEntry["protocol"]> = {
  fluid: "Fluid",
  "fluid lending": "Fluid",
  sky: "Sky",
  "sky savings": "Sky",
  "sky savings rate": "Sky",
  ssr: "Sky",
  "spark savings": "Spark Savings",
  ethena: "Ethena",
};

export function vaultProtocolFor(protocol: string | undefined): VaultEntry["protocol"] | undefined {
  return protocol ? PROTOCOL_ALIASES[norm(protocol)] : undefined;
}

/**
 * The vault for a leg: protocol + the asset the user deposits (or the share
 * token the plan names, e.g. "sUSDS") on a chain.
 */
export function findVault(protocol: string | undefined, asset: string, chainId: number): VaultEntry | undefined {
  const p = vaultProtocolFor(protocol);
  if (!p) return undefined;
  const a = asset.trim().toLowerCase().replace(/^pt[-\s]/, "");
  return VAULTS.find(
    (v) => v.protocol === p && v.chainId === chainId && (v.assetSymbol.toLowerCase() === a || v.shareSymbol.toLowerCase() === a),
  ) ?? VAULTS.find((v) => v.protocol === p && v.chainId === chainId && VAULTS.filter((x) => x.protocol === p && x.chainId === chainId).length === 1);
}

export function isTrustedVault(chainId: number, address: string): VaultEntry | undefined {
  return VAULTS.find((v) => v.chainId === chainId && v.vault.toLowerCase() === address.toLowerCase());
}
