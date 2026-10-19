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
  protocol: "Fluid" | "Sky" | "Spark Savings" | "Ethena" | "Yearn" | "Curve Savings" | "Curve LlamaLend";
  /** DefiLlama project slug, for live rates. */
  llamaProject: string;
  /** DefiLlama pool symbol for this vault (the underlying for Fluid/Spark, the share token for sUSDS/sUSDe). */
  llamaSymbol: string;
  /**
   * DefiLlama pool id, when the project lists several pools for the same
   * asset on a chain (Euler, Gearbox…): only that pool's rate is this
   * vault's, so only that row is marked executable.
   */
  llamaPool?: string;
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
  // GHO on Ethereum (2026-10-19: asset() = GHO, 24.1M GHO in the vault = DefiLlama's $24.1M row; deposit open to anyone).
  { protocol: "Fluid", llamaProject: "fluid-lending", llamaSymbol: "GHO", llamaPool: "578cffd4-1470-44d0-8c5d-e9d4bd403651", chainId: 1, vault: "0x6A29A46E21C730DcA1d8b23d637c101cec605C5B", shareSymbol: "fGHO", assetSymbol: "GHO", assetAddress: "0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f", assetDecimals: 18, exit: "Instant (pool liquidity permitting)", instantWithdraw: true },
  { protocol: "Fluid", llamaProject: "fluid-lending", llamaSymbol: "USDC", chainId: 8453, vault: "0xf42f5795D9ac7e9D757dB633D693cD548Cfd9169", shareSymbol: "fUSDC", assetSymbol: "USDC", assetAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", assetDecimals: 6, exit: "Instant (pool liquidity permitting)", instantWithdraw: true },

  // Sky Savings Rate (sUSDS) — USDS earns the Sky Savings Rate.
  { protocol: "Sky", llamaProject: "sky-lending", llamaSymbol: "SUSDS", llamaPool: "d8c4eff5-c8a9-46fc-a888-057c4c668e72", chainId: 1, vault: "0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD", shareSymbol: "sUSDS", assetSymbol: "USDS", assetAddress: "0xdC035D45d973E3EC169d2276DDab16f1e407384F", assetDecimals: 18, exit: "Instant", instantWithdraw: true },

  // Sky sDAI (DAI Savings Rate). Deposits are signed by the dedicated sDAI path (lib/execution.ts "maker");
  // this row marks DefiLlama's sDAI pool executable. On-chain 164M DAI vs DefiLlama $200M (DefiLlama lags; the only sDAI vault).
  { protocol: "Sky", llamaProject: "sky-lending", llamaSymbol: "SDAI", llamaPool: "c8a24fee-ec00-4f38-86c0-9f6daebc4225", chainId: 1, vault: "0x83F20F44975D03b1b09e64809B757c47f942BEeA", shareSymbol: "sDAI", assetSymbol: "DAI", assetAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F", assetDecimals: 18, exit: "Instant", instantWithdraw: true },

  // Spark Savings v2 on Ethereum (spUSDC, spUSDT, spETH) — the vaults DefiLlama's
  // spark-savings Ethereum rows track (TVL matched on-chain: $307M, $740M, 20k ETH).
  { protocol: "Spark Savings", llamaProject: "spark-savings", llamaSymbol: "USDC", chainId: 1, vault: "0x28B3a8fb53B741A8Fd78c0fb9A6B2393d896a43d", shareSymbol: "spUSDC", assetSymbol: "USDC", assetAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", assetDecimals: 6, exit: "Instant (vault liquidity permitting)", instantWithdraw: true },
  { protocol: "Spark Savings", llamaProject: "spark-savings", llamaSymbol: "USDT", chainId: 1, vault: "0xe2e7a17dFf93280dec073C995595155283e3C372", shareSymbol: "spUSDT", assetSymbol: "USDT", assetAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7", assetDecimals: 6, exit: "Instant (vault liquidity permitting)", instantWithdraw: true },
  { protocol: "Spark Savings", llamaProject: "spark-savings", llamaSymbol: "ETH", chainId: 1, vault: "0xfE6eb3b609a7C8352A241f7F3A21CEA4e9209B8f", shareSymbol: "spETH", assetSymbol: "WETH", assetAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", assetDecimals: 18, exit: "Instant (vault liquidity permitting)", instantWithdraw: true },
  // On Base and Arbitrum DefiLlama lists Spark Savings under USDS; sUSDC earns the same Sky Savings Rate.
  { protocol: "Spark Savings", llamaProject: "spark-savings", llamaSymbol: "USDS", chainId: 8453, vault: "0x3128a0F7f0ea68E7B7c9B00AFa7E41045828e858", shareSymbol: "sUSDC", assetSymbol: "USDC", assetAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", assetDecimals: 6, exit: "Instant", instantWithdraw: true },
  { protocol: "Spark Savings", llamaProject: "spark-savings", llamaSymbol: "USDS", chainId: 42161, vault: "0x940098b108fB7D0a7E374f6eDED7760787464609", shareSymbol: "sUSDC", assetSymbol: "USDC", assetAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", assetDecimals: 6, exit: "Instant", instantWithdraw: true },

  // Ethena staked USDe — deposits are open; withdrawals go through a cooldown.
  { protocol: "Ethena", llamaProject: "ethena-usde", llamaSymbol: "SUSDE", chainId: 1, vault: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497", shareSymbol: "sUSDe", assetSymbol: "USDe", assetAddress: "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3", assetDecimals: 18, exit: "7-day cooldown (or sell sUSDe on market)", instantWithdraw: false },

  // Yearn v3 multi-strategy vaults on Ethereum (TVL matched on-chain to DefiLlama's
  // deepest yearn-finance row per asset: $19M USDC, 7.3k WETH, $9.8M USDS).
  { protocol: "Yearn", llamaProject: "yearn-finance", llamaSymbol: "USDC", chainId: 1, vault: "0xBe53A109B494E5c9f97b9Cd39Fe969BE68BF6204", shareSymbol: "yvUSDC-1", assetSymbol: "USDC", assetAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", assetDecimals: 6, exit: "Instant (vault liquidity permitting)", instantWithdraw: true },
  { protocol: "Yearn", llamaProject: "yearn-finance", llamaSymbol: "WETH", chainId: 1, vault: "0xc56413869c6CDf96496f2b1eF801fEDBdFA7dDB0", shareSymbol: "yvWETH-1", assetSymbol: "WETH", assetAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", assetDecimals: 18, exit: "Instant (vault liquidity permitting)", instantWithdraw: true },
  { protocol: "Yearn", llamaProject: "yearn-finance", llamaSymbol: "USDS", chainId: 1, vault: "0x182863131F9a4630fF9E27830d945B1413e347E8", shareSymbol: "yvUSDS-1", assetSymbol: "USDS", assetAddress: "0xdC035D45d973E3EC169d2276DDab16f1e407384F", assetDecimals: 18, exit: "Instant (vault liquidity permitting)", instantWithdraw: true },

  // Curve Savings (scrvUSD): crvUSD earns a share of crvUSD borrow fees. A Yearn v3 vault with no deposit limit
  // (2026-10-19: asset() = crvUSD, 14.76M crvUSD = DefiLlama's $14.76M).
  { protocol: "Curve Savings", llamaProject: "crvusd", llamaSymbol: "SCRVUSD", llamaPool: "5fd328af-4203-471b-bd16-1705c726d926", chainId: 1, vault: "0x0655977FEb2f289A4aB78af67BAB0d17aAb84367", shareSymbol: "scrvUSD", assetSymbol: "crvUSD", assetAddress: "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E", assetDecimals: 18, exit: "Instant", instantWithdraw: true },

  // Curve LlamaLend: lend crvUSD to borrowers posting sfrxUSD (one market; DefiLlama lists one pool per
  // collateral, hence the pool id). Vault.vy, deposit open to anyone; 20.1M crvUSD = DefiLlama's $20.1M (2026-10-19).
  // CRV rewards need gauge staking: a deposit earns the base rate.
  { protocol: "Curve LlamaLend", llamaProject: "curve-llamalend", llamaSymbol: "CRVUSD", llamaPool: "27af094e-e18f-5eb2-bfbf-1cf24be73057", chainId: 1, vault: "0x3Da0F110079012387F47C6Fc6e878F10262E300a", shareSymbol: "cvcrvUSD (sfrxUSD market)", assetSymbol: "crvUSD", assetAddress: "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E", assetDecimals: 18, exit: "Instant while the market has unborrowed crvUSD", instantWithdraw: true },
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
  yearn: "Yearn",
  "yearn v3": "Yearn",
  "yearn finance": "Yearn",
  "curve savings": "Curve Savings",
  "curve savings crvusd": "Curve Savings",
  scrvusd: "Curve Savings",
  "savings crvusd": "Curve Savings",
  "curve llamalend": "Curve LlamaLend",
  llamalend: "Curve LlamaLend",
  "curve lend": "Curve LlamaLend",
  "curve lending": "Curve LlamaLend",
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
  const raw = asset.trim().toLowerCase().replace(/^pt[-\s]/, "");
  // ETH vaults take WETH: "Supply ETH on Yearn" is the WETH vault.
  const a = raw === "eth" ? "weth" : raw;
  return VAULTS.find(
    (v) => v.protocol === p && v.chainId === chainId && (v.assetSymbol.toLowerCase() === a || v.shareSymbol.toLowerCase() === a),
  ) ?? VAULTS.find((v) => v.protocol === p && v.chainId === chainId && VAULTS.filter((x) => x.protocol === p && x.chainId === chainId).length === 1);
}

export function isTrustedVault(chainId: number, address: string): VaultEntry | undefined {
  return VAULTS.find((v) => v.chainId === chainId && v.vault.toLowerCase() === address.toLowerCase());
}
