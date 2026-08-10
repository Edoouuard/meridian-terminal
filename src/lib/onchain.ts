import type { Address } from "viem";
import {
  arbitrum,
  avalanche,
  base,
  bsc,
  celo,
  fantom,
  gnosis,
  linea,
  mainnet,
  mantle,
  metis,
  optimism,
  polygon,
  scroll,
  sonic,
  zkSync,
} from "wagmi/chains";

export const SUPPORTED_CHAINS = [
  mainnet,
  base,
  arbitrum,
  optimism,
  polygon,
  avalanche,
  bsc,
  gnosis,
  scroll,
  zkSync,
  linea,
  mantle,
  metis,
  fantom,
  sonic,
  celo,
] as const;

export const CHAIN_LABEL: Record<number, string> = {
  [mainnet.id]: "Ethereum",
  [base.id]: "Base",
  [arbitrum.id]: "Arbitrum",
  [optimism.id]: "Optimism",
  [polygon.id]: "Polygon",
  [avalanche.id]: "Avalanche",
  [bsc.id]: "BNB Chain",
  [gnosis.id]: "Gnosis",
  [scroll.id]: "Scroll",
  [zkSync.id]: "zkSync Era",
  [linea.id]: "Linea",
  [mantle.id]: "Mantle",
  [metis.id]: "Metis",
  [fantom.id]: "Fantom",
  [sonic.id]: "Sonic",
  [celo.id]: "Celo",
};

/**
 * Aave v3 Pool addresses. Verified 2026-07-30+ against aave-dao/aave-address-book
 * (src/AaveV3*.sol). Arbitrum/Optimism/Polygon/Avalanche/Fantom deliberately share
 * one address — Aave deployed those via the same deterministic (CREATE2) factory
 * and salt, confirmed by fetching each source file independently. Base and
 * Ethereum were deployed separately and have their own addresses. The BNB/Gnosis/
 * Scroll/zkSync/Linea/Mantle/Metis/Sonic/Celo pools each have their own distinct
 * universally-verified address. Wrong addresses here would silently misreport
 * real money — double-check any change against a second source.
 */
export const AAVE_V3_POOL_BY_CHAIN: Record<number, Address> = {
  [mainnet.id]: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
  [base.id]: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
  [arbitrum.id]: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  [optimism.id]: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  [polygon.id]: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  [avalanche.id]: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  [bsc.id]: "0x6807dc923806fE8Fd134338EABCA509979a7e0cB",
  [gnosis.id]: "0xb50201558B00496A145fE76f7424749556E326D8",
  [scroll.id]: "0x11fCfe756c05AD438e312a7fd934381537D3cFfe",
  [zkSync.id]: "0x78e30497a3c7527d953c6B1E3541b021A98Ac43c",
  [linea.id]: "0xc47b8C00b0f69a36fa203Ffeac0334874574a8Ac",
  [mantle.id]: "0x458F293454fE0d67EC0655f3672301301DD51422",
  [metis.id]: "0x90df02551bB792286e8D4f13E0e357b4Bf1D6a57",
  [fantom.id]: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
  [sonic.id]: "0x5362dBb1e601abF3a4c14c22ffEdA64042E5eAA3",
  [celo.id]: "0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402",
};

export const STETH_ADDRESS: Address = "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84";

export interface TrackedToken {
  symbol: string;
  address: Address;
  decimals: number;
  /** Which live-price symbol to value this token at (see src/app/api/prices/route.ts). */
  priceSymbol: string;
  venue: string;
}

/**
 * Curated set of major ERC20s per chain, scanned via one multicall per chain per
 * connected wallet. There is no free way to discover "every token this address
 * holds" from a plain RPC without a paid indexer, so this list — not full
 * auto-discovery — is the read-only v1 scope. Every address individually verified
 * 2026-07-30/07-31 against Etherscan/Basescan/Arbiscan/Optimistic Etherscan/
 * PolygonScan/Snowtrace token pages (or, for OP-stack WETH, the shared predeploy
 * spec at 0x4200...0006). Kept deliberately smaller on L2s than mainnet — only
 * tokens with one unambiguous canonical (not bridged-alias) address per chain.
 */
export const TRACKED_TOKENS_BY_CHAIN: Record<number, TrackedToken[]> = {
  [mainnet.id]: [
    { symbol: "stETH", address: STETH_ADDRESS, decimals: 18, priceSymbol: "ETH", venue: "Lido" },
    { symbol: "wstETH", address: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", decimals: 18, priceSymbol: "WSTETH", venue: "Lido" },
    { symbol: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18, priceSymbol: "ETH", venue: "Wallet" },
    { symbol: "WBTC", address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", decimals: 8, priceSymbol: "WBTC", venue: "Wallet" },
    { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, priceSymbol: "USDC", venue: "Wallet" },
    { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6, priceSymbol: "USDT", venue: "Wallet" },
    { symbol: "DAI", address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18, priceSymbol: "DAI", venue: "Wallet" },
    { symbol: "LINK", address: "0x514910771AF9Ca656af840dff83E8264EcF986CA", decimals: 18, priceSymbol: "LINK", venue: "Wallet" },
    { symbol: "UNI", address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", decimals: 18, priceSymbol: "UNI", venue: "Wallet" },
  ],
  [base.id]: [
    { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, priceSymbol: "USDC", venue: "Wallet" },
    { symbol: "WETH", address: "0x4200000000000000000000000000000000000006", decimals: 18, priceSymbol: "ETH", venue: "Wallet" },
    // Aave v3 Base canonical assets: wstETH (Lido) and cbBTC (Coinbase) are the
    // chain's ETH-staking / BTC collateral markets. Base has no canonical WBTC.
    { symbol: "wstETH", address: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", decimals: 18, priceSymbol: "WSTETH", venue: "Lido" },
    { symbol: "cbBTC", address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8, priceSymbol: "WBTC", venue: "Wallet" },
  ],
  [arbitrum.id]: [
    { symbol: "USDC", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6, priceSymbol: "USDC", venue: "Wallet" },
    { symbol: "USDT", address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6, priceSymbol: "USDT", venue: "Wallet" },
    { symbol: "WETH", address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", decimals: 18, priceSymbol: "ETH", venue: "Wallet" },
    // Aave v3 Arbitrum major-asset markets:
    { symbol: "WBTC", address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", decimals: 8, priceSymbol: "WBTC", venue: "Wallet" },
    { symbol: "wstETH", address: "0x5979D7b546E38E414f7E9822514be443A4800529", decimals: 18, priceSymbol: "WSTETH", venue: "Lido" },
  ],
  [optimism.id]: [
    { symbol: "USDC", address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", decimals: 6, priceSymbol: "USDC", venue: "Wallet" },
    { symbol: "USDT", address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", decimals: 6, priceSymbol: "USDT", venue: "Wallet" },
    { symbol: "WETH", address: "0x4200000000000000000000000000000000000006", decimals: 18, priceSymbol: "ETH", venue: "Wallet" },
    // Aave v3 Optimism major-asset markets:
    { symbol: "WBTC", address: "0x68f180fcCe6836688e9084f035309E29Bf0A2095", decimals: 8, priceSymbol: "WBTC", venue: "Wallet" },
    { symbol: "wstETH", address: "0x1F32b1c2345538c0c6f582fCB022739c4AbeEfa8", decimals: 18, priceSymbol: "WSTETH", venue: "Lido" },
  ],
  [polygon.id]: [
    { symbol: "USDC", address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6, priceSymbol: "USDC", venue: "Wallet" },
    { symbol: "USDT", address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6, priceSymbol: "USDT", venue: "Wallet" },
    // Aave v3 Polygon major-asset markets:
    { symbol: "WETH", address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18, priceSymbol: "ETH", venue: "Wallet" },
    { symbol: "WBTC", address: "0x1bfd67037b42cf73acF2047067bd4F2C47D9BfD6", decimals: 8, priceSymbol: "WBTC", venue: "Wallet" },
    { symbol: "wstETH", address: "0x03b54A6e9a984069379fae1a4fC4dBAE93B3bCCD", decimals: 18, priceSymbol: "WSTETH", venue: "Lido" },
  ],
  [bsc.id]: [
    { symbol: "USDT", address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18, priceSymbol: "USDT", venue: "Wallet" },
    { symbol: "USDC", address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18, priceSymbol: "USDC", venue: "Wallet" },
    { symbol: "WBNB", address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", decimals: 18, priceSymbol: "BNB", venue: "Wallet" },
  ],
  [gnosis.id]: [
    { symbol: "USDC", address: "0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83", decimals: 6, priceSymbol: "USDC", venue: "Wallet" },
  ],
  [scroll.id]: [
    { symbol: "WETH", address: "0x5300000000000000000000000000000000000004", decimals: 18, priceSymbol: "ETH", venue: "Wallet" },
    { symbol: "USDC", address: "0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4", decimals: 6, priceSymbol: "USDC", venue: "Wallet" },
  ],
  [zkSync.id]: [
    { symbol: "USDC", address: "0x3355df6d4c9c3035724fd0e3914de96a5a83aaf4", decimals: 6, priceSymbol: "USDC", venue: "Wallet" },
    { symbol: "USDT", address: "0x493257fD37EDB34451f62EDf8D2a0C418852bA4C", decimals: 6, priceSymbol: "USDT", venue: "Wallet" },
    { symbol: "WETH", address: "0x5aeA5775959fbc2557Cc8789bC1bf90A239D9a91", decimals: 18, priceSymbol: "ETH", venue: "Wallet" },
  ],
  [linea.id]: [
    { symbol: "USDC", address: "0x176211869cA2b568f2A7D4EE941E073a821EE1ff", decimals: 6, priceSymbol: "USDC", venue: "Wallet" },
    { symbol: "USDT", address: "0xA219439258ca9da29E9Cc4cE5596924745e12B93", decimals: 6, priceSymbol: "USDT", venue: "Wallet" },
    { symbol: "WETH", address: "0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f", decimals: 18, priceSymbol: "ETH", venue: "Wallet" },
  ],
  [avalanche.id]: [
    { symbol: "USDC", address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", decimals: 6, priceSymbol: "USDC", venue: "Wallet" },
    { symbol: "USDT", address: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", decimals: 6, priceSymbol: "USDT", venue: "Wallet" },
    // Aave v3 Avalanche markets. Native AVAX lives as wAVAX in Aave and needs the
    // WrappedTokenGatewayV3 (wrap+supply) the harness doesn't wire, so it is left
    // out rather than risking a broken plain-pool supply. WETH.e / WBTC.e are the
    // canonical Aave v3 Avalanche markets and work directly via pool.supply.
    { symbol: "WETH", address: "0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB", decimals: 18, priceSymbol: "ETH", venue: "Wallet" },
    { symbol: "WBTC", address: "0x50b7545627a5162F82A992c33b87aDc75187B218", decimals: 8, priceSymbol: "WBTC", venue: "Wallet" },
  ],
};

export const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** Aave v3 Pool.getUserAccountData — base-currency amounts are USD with 8 decimals on every chain listed above. */
export const AAVE_POOL_ABI = [
  {
    type: "function",
    name: "getUserAccountData",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [
      { name: "totalCollateralBase", type: "uint256" },
      { name: "totalDebtBase", type: "uint256" },
      { name: "availableBorrowsBase", type: "uint256" },
      { name: "currentLiquidationThreshold", type: "uint256" },
      { name: "ltv", type: "uint256" },
      { name: "healthFactor", type: "uint256" },
    ],
  },
] as const;

/** Aave returns this sentinel (uint256 max) for healthFactor when the user has no debt. */
export const AAVE_NO_DEBT_HEALTH_FACTOR = BigInt(2) ** BigInt(256) - BigInt(1);

/**
 * Ordered lending pools whose account data is read via the Aave-v3-style
 * `getUserAccountData(address)` ABI (6 values, base-currency USD with 8 decimals,
 * sentinel MAX_HEALTH_FACTOR when there is no debt).
 *
 * Aave v3 pools verified against aave-dao/aave-address-book. SparkLend is an
 * Aave-v3 fork on Ethereum whose pool returns the identical shape (confirmed by a
 * live eth_call); address from its verified deployment. Wrong addresses silently
 * misreport real money — double-check any change against a second source.
 */
export interface LendingPool {
  protocol: string;
  pool: Address;
}
export const LENDING_POOLS_BY_CHAIN: Record<number, LendingPool[]> = {
  [mainnet.id]: [
    { protocol: "Aave v3", pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2" },
    { protocol: "SparkLend", pool: "0xC13e21B648A5Ee794902342038FF3aDAB66BE987" },
  ],
  [base.id]: [{ protocol: "Aave v3", pool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5" }],
  [arbitrum.id]: [{ protocol: "Aave v3", pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD" }],
  [optimism.id]: [{ protocol: "Aave v3", pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD" }],
  [polygon.id]: [{ protocol: "Aave v3", pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD" }],
  [avalanche.id]: [{ protocol: "Aave v3", pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD" }],
  [bsc.id]: [{ protocol: "Aave v3", pool: "0x6807dc923806fE8Fd134338EABCA509979a7e0cB" }],
  [gnosis.id]: [{ protocol: "Aave v3", pool: "0xb50201558B00496A145fE76f7424749556E326D8" }],
  [scroll.id]: [{ protocol: "Aave v3", pool: "0x11fCfe756c05AD438e312a7fd934381537D3cFfe" }],
  [zkSync.id]: [{ protocol: "Aave v3", pool: "0x78e30497a3c7527d953c6B1E3541b021A98Ac43c" }],
  [linea.id]: [{ protocol: "Aave v3", pool: "0xc47b8C00b0f69a36fa203Ffeac0334874574a8Ac" }],
  [mantle.id]: [{ protocol: "Aave v3", pool: "0x458F293454fE0d67EC0655f3672301301DD51422" }],
  [metis.id]: [{ protocol: "Aave v3", pool: "0x90df02551bB792286e8D4f13E0e357b4Bf1D6a57" }],
  [fantom.id]: [{ protocol: "Aave v3", pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD" }],
  [sonic.id]: [{ protocol: "Aave v3", pool: "0x5362dBb1e601abF3a4c14c22ffEdA64042E5eAA3" }],
  [celo.id]: [{ protocol: "Aave v3", pool: "0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402" }],
};

/**
 * Compound V3 (Comet) markets whose supply/borrow we read per asset. baseToken()
 * returns the base (denominated) asset; balances are denominated in that base
 * token's smallest unit. Addresses verified as live contracts on mainnet; the
 * USDC Comet baseToken() confirmed as USDC via eth_call.
 */
export interface CometMarket {
  protocol: string;
  market: Address;
  baseToken: Address;
  baseDecimals: number;
  baseSymbol: string;
}
export const COMET_MARKETS: CometMarket[] = [
  {
    protocol: "Compound V3",
    market: "0xc3d688B66703497DAA19211EEdFF47f25384cdc3",
    baseToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    baseDecimals: 6,
    baseSymbol: "USDC",
  },
];

/** Aave-v3 style getUserAccountData ABI (used for Aave v3 + SparkLend). */
export const LENDING_POOL_ABI = AAVE_POOL_ABI;

/** Compound v3 Comet read ABI (supply/borrow per asset). */
export const COMET_ABI = [
  {
    type: "function",
    name: "baseToken",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "getSupplyBalance",
    stateMutability: "view",
    inputs: [
      { name: "asset", type: "address" },
      { name: "user", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getBorrowBalance",
    stateMutability: "view",
    inputs: [
      { name: "asset", type: "address" },
      { name: "user", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/**
 * Perp coins on Hyperliquid whose signed position size is treated as ETH delta
 * for the cross-venue net-delta / flatten metrics. Mirrors riskModel's
 * ETH_TRACKING_SYMBOLS, normalised to the uppercase, `-PERP`-stripped coin
 * strings the Hyperliquid API returns (e.g. "ETH", "ETH-PERP", "wstETH").
 */
export const PERP_ETH_COIN_SET: ReadonlySet<string> = new Set(["ETH", "WETH", "STETH", "WSTETH"]);

/** True if a Hyperliquid perp coin maps to ETH delta (long + / short - in coin units). */
export function perpCoinIsEth(coin: string): boolean {
  const base = (coin || "").toUpperCase().replace(/-PERP$/, "");
  return PERP_ETH_COIN_SET.has(base);
}
