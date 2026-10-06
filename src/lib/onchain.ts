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

/**
 * Spark (MakerDAO/Sky's Aave v3 fork) pool addresses. Same ABI as Aave v3 —
 * supply/repay/borrow/withdraw/getUserAccountData all use identical signatures.
 * Already present in LENDING_POOLS_BY_CHAIN for read-only portfolio health;
 * now also used for execution.
 */
export const SPARK_POOL_BY_CHAIN: Record<number, Address> = {
  [mainnet.id]: "0xC13e21B648A5Ee794902342038FF3aDAB66BE987",
  [gnosis.id]: "0x2Dae5307c5E3FD1CF5A72Cb6F698f915860607e0",
};

/**
 * Maker/Sky sDAI — ERC-4626 vault wrapping the DAI Savings Rate (DSR).
 * Deposit DAI → sDAI (accrues yield continuously). Withdraw sDAI → DAI.
 * Standard EIP-4626, same interface as Morpho vaults.
 */
export const SDAI_VAULT: Address = "0x83F20F44975D03b1b09e64809B757c47f942BEeA";

/**
 * Rocket Pool deposit contract — deposit ETH, receive rETH 1:1 (at the
 * current exchange rate). Mainnet only.
 */
export const ROCKET_DEPOSIT_POOL: Address = "0xDD9BC35aE942eF0cFa76930954a156B3fF30a4E1";

/**
 * Frax frxETHMinter — submitAndDeposit(recipient) payable: sends ETH,
 * mints frxETH, deposits frxETH into sfrxETH vault, sends sfrxETH to
 * recipient. Single-tx ETH → sfrxETH. Mainnet only.
 */
export const FRXETH_MINTER: Address = "0xbAFA44EFE7901E04E39Dad13167D089C559c1138";
export const SFRXETH_ADDRESS: Address = "0xac3E018457B222d93114458476f3E3416Abbe38F";

/**
 * Compound III (Comet) USDC-market proxy addresses. Compound has no single
 * pool like Aave — each Comet is its own base-asset market (USDC, WETH,
 * USDT, ...) with other assets usable only as collateral against it. The
 * USDC market is the most liquid and the only one wired here (same scoping
 * choice as Lido being ETH-only). Verified 2026-10-03 against
 * compound-finance/comet's own deployments/<network>/usdc/roots.json
 * (the "comet" field — this is Compound's own deployment registry, the
 * same one their tooling/frontend reads), cross-checked against a second
 * independent source for the mainnet address. Arbitrum has both a native-
 * USDC market ("usdc") and a bridged-USDC.e one ("usdc.e") — this is the
 * native one, matching TRACKED_TOKENS_BY_CHAIN's native USDC elsewhere in
 * this file. Wrong addresses here would silently misreport or misdirect
 * real money — double-check any change against a second source.
 */
export const COMPOUND_V3_USDC_COMET_BY_CHAIN: Record<number, Address> = {
  [mainnet.id]: "0xc3d688B66703497DAA19211EEdff47f25384cdc3",
  [base.id]: "0xb125E6687d4313864e53df431d5425969c15Eb2F",
  [arbitrum.id]: "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf",
  [optimism.id]: "0x2e44e174f7D53F0212823acC11C01A11d58c5bCB",
  [polygon.id]: "0xF25212E676D1F7F89Cd72fFEe66158f541246445",
  [scroll.id]: "0xB2f97c1Bd3bf02f5e74d13f02E3e26F93D77CE44",
};

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
    { symbol: "AAVE", address: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9", decimals: 18, priceSymbol: "AAVE", venue: "Wallet" },
    { symbol: "CRV", address: "0xD533a949740bb3306d119CC777fa900bA034cd52", decimals: 18, priceSymbol: "CRV", venue: "Wallet" },
    { symbol: "MKR", address: "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2", decimals: 18, priceSymbol: "MKR", venue: "Wallet" },
    { symbol: "SNX", address: "0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F", decimals: 18, priceSymbol: "SNX", venue: "Wallet" },
    { symbol: "LDO", address: "0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32", decimals: 18, priceSymbol: "LDO", venue: "Wallet" },
    { symbol: "COMP", address: "0xc00e94Cb662C3520282E6f5717214004A7f26888", decimals: 18, priceSymbol: "COMP", venue: "Wallet" },
    { symbol: "sUSDe", address: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497", decimals: 18, priceSymbol: "SUSDE", venue: "Wallet" },
    { symbol: "weETH", address: "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee", decimals: 18, priceSymbol: "WEETH", venue: "Wallet" },
    { symbol: "rETH", address: "0xae78736Cd615f374D3085123A210448E74Fc6393", decimals: 18, priceSymbol: "RETH", venue: "Wallet" },
    { symbol: "cbETH", address: "0xBe9895146f7AF43049ca1c1AE358B0541Ea49704", decimals: 18, priceSymbol: "CBETH", venue: "Wallet" },
    { symbol: "GHO", address: "0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f", decimals: 18, priceSymbol: "GHO", venue: "Wallet" },
  ],
  [base.id]: [
    { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, priceSymbol: "USDC", venue: "Wallet" },
    { symbol: "WETH", address: "0x4200000000000000000000000000000000000006", decimals: 18, priceSymbol: "ETH", venue: "Wallet" },
    { symbol: "wstETH", address: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", decimals: 18, priceSymbol: "WSTETH", venue: "Lido" },
    { symbol: "cbBTC", address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8, priceSymbol: "WBTC", venue: "Wallet" },
    { symbol: "USDbC", address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", decimals: 6, priceSymbol: "USDC", venue: "Wallet" },
    { symbol: "DAI", address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", decimals: 18, priceSymbol: "DAI", venue: "Wallet" },
    { symbol: "AERO", address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631", decimals: 18, priceSymbol: "AERO", venue: "Wallet" },
    { symbol: "cbETH", address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", decimals: 18, priceSymbol: "CBETH", venue: "Wallet" },
    { symbol: "weETH", address: "0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A", decimals: 18, priceSymbol: "WEETH", venue: "Wallet" },
    { symbol: "USDT", address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", decimals: 6, priceSymbol: "USDT", venue: "Wallet" },
  ],
  [arbitrum.id]: [
    { symbol: "USDC", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6, priceSymbol: "USDC", venue: "Wallet" },
    { symbol: "USDT", address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6, priceSymbol: "USDT", venue: "Wallet" },
    { symbol: "WETH", address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", decimals: 18, priceSymbol: "ETH", venue: "Wallet" },
    { symbol: "WBTC", address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", decimals: 8, priceSymbol: "WBTC", venue: "Wallet" },
    { symbol: "wstETH", address: "0x5979D7b546E38E414f7E9822514be443A4800529", decimals: 18, priceSymbol: "WSTETH", venue: "Lido" },
    { symbol: "DAI", address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", decimals: 18, priceSymbol: "DAI", venue: "Wallet" },
    { symbol: "ARB", address: "0x912CE59144191C1204E64559FE8253a0e49E6548", decimals: 18, priceSymbol: "ARB", venue: "Wallet" },
    { symbol: "GMX", address: "0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a", decimals: 18, priceSymbol: "GMX", venue: "Wallet" },
    { symbol: "LINK", address: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4", decimals: 18, priceSymbol: "LINK", venue: "Wallet" },
    { symbol: "UNI", address: "0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0", decimals: 18, priceSymbol: "UNI", venue: "Wallet" },
    { symbol: "AAVE", address: "0xba5DdD1f9d7F570dc94a51479a000E3BCE967196", decimals: 18, priceSymbol: "AAVE", venue: "Wallet" },
    { symbol: "weETH", address: "0x35751007a407ca6FEFfE80b3cB397736D2cf4dbe", decimals: 18, priceSymbol: "WEETH", venue: "Wallet" },
    { symbol: "rETH", address: "0xEC70Dcb4A1EFa46b8F2D97C310C9c4790ba5ffA8", decimals: 18, priceSymbol: "RETH", venue: "Wallet" },
    { symbol: "GHO", address: "0x7dfF72693f6A4149b17e7C6314655f6A9F7c8B33", decimals: 18, priceSymbol: "GHO", venue: "Wallet" },
  ],
  [optimism.id]: [
    { symbol: "USDC", address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", decimals: 6, priceSymbol: "USDC", venue: "Wallet" },
    { symbol: "USDT", address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", decimals: 6, priceSymbol: "USDT", venue: "Wallet" },
    { symbol: "WETH", address: "0x4200000000000000000000000000000000000006", decimals: 18, priceSymbol: "ETH", venue: "Wallet" },
    { symbol: "WBTC", address: "0x68f180fcCe6836688e9084f035309E29Bf0A2095", decimals: 8, priceSymbol: "WBTC", venue: "Wallet" },
    { symbol: "wstETH", address: "0x1F32b1c2345538c0c6f582fCB022739c4AbeEfa8", decimals: 18, priceSymbol: "WSTETH", venue: "Lido" },
    { symbol: "DAI", address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", decimals: 18, priceSymbol: "DAI", venue: "Wallet" },
    { symbol: "OP", address: "0x4200000000000000000000000000000000000042", decimals: 18, priceSymbol: "OP", venue: "Wallet" },
    { symbol: "LINK", address: "0x350a791Bfc2C21F9Ed5d10980Dad2e2638ffa7f6", decimals: 18, priceSymbol: "LINK", venue: "Wallet" },
    { symbol: "AAVE", address: "0x76FB31fb4af56892A25e32cFC43De717950c9278", decimals: 18, priceSymbol: "AAVE", venue: "Wallet" },
    { symbol: "SNX", address: "0x8700dAec35aF8Ff88c16BdF0418774CB3D7599B4", decimals: 18, priceSymbol: "SNX", venue: "Wallet" },
    { symbol: "rETH", address: "0x9Bcef72be871e61ED4fBbc7630889beE758eb81D", decimals: 18, priceSymbol: "RETH", venue: "Wallet" },
    { symbol: "UNI", address: "0x6fd9d7AD17242c41f7131d257212c54A0e816691", decimals: 18, priceSymbol: "UNI", venue: "Wallet" },
  ],
  [polygon.id]: [
    { symbol: "USDC", address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6, priceSymbol: "USDC", venue: "Wallet" },
    { symbol: "USDT", address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6, priceSymbol: "USDT", venue: "Wallet" },
    { symbol: "WETH", address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18, priceSymbol: "ETH", venue: "Wallet" },
    { symbol: "WBTC", address: "0x1bfd67037b42cf73acF2047067bd4F2C47D9BfD6", decimals: 8, priceSymbol: "WBTC", venue: "Wallet" },
    { symbol: "wstETH", address: "0x03b54A6e9a984069379fae1a4fC4dBAE93B3bCCD", decimals: 18, priceSymbol: "WSTETH", venue: "Lido" },
    { symbol: "DAI", address: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", decimals: 18, priceSymbol: "DAI", venue: "Wallet" },
    { symbol: "LINK", address: "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39", decimals: 18, priceSymbol: "LINK", venue: "Wallet" },
    { symbol: "AAVE", address: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B", decimals: 18, priceSymbol: "AAVE", venue: "Wallet" },
    { symbol: "UNI", address: "0xb33EaAd8d922B1083446DC23f610c2567fB5180f", decimals: 18, priceSymbol: "UNI", venue: "Wallet" },
    { symbol: "CRV", address: "0x172370d5Cd63279eFa6d502DAB29171933a610AF", decimals: 18, priceSymbol: "CRV", venue: "Wallet" },
    { symbol: "WMATIC", address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", decimals: 18, priceSymbol: "MATIC", venue: "Wallet" },
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
    { symbol: "WETH", address: "0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB", decimals: 18, priceSymbol: "ETH", venue: "Wallet" },
    { symbol: "WBTC", address: "0x50b7545627a5162F82A992c33b87aDc75187B218", decimals: 8, priceSymbol: "WBTC", venue: "Wallet" },
    { symbol: "WAVAX", address: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7", decimals: 18, priceSymbol: "AVAX", venue: "Wallet" },
    { symbol: "DAI", address: "0xd586E7F844cEa2F87f50152665BCbc2C279D8d70", decimals: 18, priceSymbol: "DAI", venue: "Wallet" },
    { symbol: "LINK", address: "0x5947BB275c521040051D82396192181b413227A3", decimals: 18, priceSymbol: "LINK", venue: "Wallet" },
    { symbol: "AAVE", address: "0x63a72806098Bd3D9520cC43356dD56502289c344", decimals: 18, priceSymbol: "AAVE", venue: "Wallet" },
  ],
  // ─── Chains that were missing tracked tokens ────────────────────────
  // Verified 2026-10 against each chain's block explorer + Aave v3 market list.
  [mantle.id]: [
    { symbol: "USDC", address: "0x09Bc4E0D10E52d373fa6186b9a2f9AAD4bd9bF3e", decimals: 6, priceSymbol: "USDC", venue: "Wallet" },
    { symbol: "USDT", address: "0x201EBa5CC46D216Ce6DC03F6a759e8E766e956aE", decimals: 6, priceSymbol: "USDT", venue: "Wallet" },
    { symbol: "WETH", address: "0xdEAddEaDdeadDEadDEADDEAddEADDEAddead1111", decimals: 18, priceSymbol: "ETH", venue: "Wallet" },
    { symbol: "WMNT", address: "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8", decimals: 18, priceSymbol: "MNT", venue: "Wallet" },
  ],
  [metis.id]: [
    { symbol: "USDC", address: "0xEA32A96608495e54156Ae48931A7c20f0dcc1a21", decimals: 6, priceSymbol: "USDC", venue: "Wallet" },
    { symbol: "USDT", address: "0xbB06DCA3AE6887fAbF931640f67cab3e3a16F4dC", decimals: 6, priceSymbol: "USDT", venue: "Wallet" },
    { symbol: "WETH", address: "0x420000000000000000000000000000000000000A", decimals: 18, priceSymbol: "ETH", venue: "Wallet" },
    { symbol: "METIS", address: "0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000", decimals: 18, priceSymbol: "METIS", venue: "Wallet" },
  ],
  [fantom.id]: [
    { symbol: "USDC", address: "0x04068DA6C83AFCFA0e13ba15A6696662335D5B75", decimals: 6, priceSymbol: "USDC", venue: "Wallet" },
    { symbol: "WETH", address: "0x74b23882a30290451A17c44f4F05243b6b58C76d", decimals: 18, priceSymbol: "ETH", venue: "Wallet" },
    { symbol: "WBTC", address: "0x321162Cd933E2Be498Cd2267a90534A804051b11", decimals: 8, priceSymbol: "WBTC", venue: "Wallet" },
    { symbol: "WFTM", address: "0x21be370D5312f44cB42ce377BC9b8a0cEF1A4C83", decimals: 18, priceSymbol: "FTM", venue: "Wallet" },
  ],
  [sonic.id]: [
    { symbol: "USDC", address: "0x29219dd400f2Bf60E5a23d13Be72B486D4038894", decimals: 6, priceSymbol: "USDC", venue: "Wallet" },
    { symbol: "WETH", address: "0x50c42dEAcD8Fc9773493ED674b675bE577f2634b", decimals: 18, priceSymbol: "ETH", venue: "Wallet" },
    { symbol: "WS", address: "0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38", decimals: 18, priceSymbol: "S", venue: "Wallet" },
  ],
  [celo.id]: [
    { symbol: "USDC", address: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C", decimals: 6, priceSymbol: "USDC", venue: "Wallet" },
    { symbol: "USDT", address: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", decimals: 6, priceSymbol: "USDT", venue: "Wallet" },
    { symbol: "WETH", address: "0x66803FB87aBd4aaC3cbB3fAd7C3aa01f6F3FB207", decimals: 18, priceSymbol: "ETH", venue: "Wallet" },
    { symbol: "CELO", address: "0x471EcE3750Da237f93B8E339c536989b8978a438", decimals: 18, priceSymbol: "CELO", venue: "Wallet" },
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

export const ERC20_ALLOWANCE_ABI = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
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
