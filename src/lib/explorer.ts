import { mainnet, base, arbitrum, optimism, polygon, avalanche, bsc, gnosis, scroll, zkSync, linea, mantle, metis, fantom, sonic, celo } from "wagmi/chains";

/** Block-explorer link for a transaction hash. */
export function explorerUrlFor(chainId: number, hash: `0x${string}`): string {
  const baseUrl: Record<number, string> = {
    [mainnet.id]: "https://etherscan.io/tx/",
    [base.id]: "https://basescan.org/tx/",
    [arbitrum.id]: "https://arbiscan.io/tx/",
    [optimism.id]: "https://optimistic.etherscan.io/tx/",
    [polygon.id]: "https://polygonscan.com/tx/",
    [avalanche.id]: "https://snowtrace.io/tx/",
    [bsc.id]: "https://bscscan.com/tx/",
    [gnosis.id]: "https://gnosisscan.io/tx/",
    [scroll.id]: "https://scrollscan.com/tx/",
    [zkSync.id]: "https://era.zksync.network/tx/",
    [linea.id]: "https://lineascan.build/tx/",
    [mantle.id]: "https://mantlescan.xyz/tx/",
    [metis.id]: "https://andromeda-explorer.metis.io/tx/",
    [fantom.id]: "https://ftmscan.com/tx/",
    [sonic.id]: "https://sonicscan.org/tx/",
    [celo.id]: "https://celoscan.io/tx/",
  };
  return `${baseUrl[chainId] ?? `https://etherscan.io/tx/`}${hash}`;
}
