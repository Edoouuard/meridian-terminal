import { createConfig, fallback, http } from "wagmi";
import { RPC_URLS } from "@/lib/rpc";
import {
  arbitrum,
  avalanche,
  base,
  bsc,
  hyperEvm,
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
import { injected, walletConnect } from "wagmi/connectors";

/**
 * WalletConnect lets phone wallets connect (QR code on desktop, deep link on
 * mobile). It needs a free Reown project id: set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID.
 * Without it, only browser-extension / in-app-browser wallets connect.
 */
const WC_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
export const WALLETCONNECT_ENABLED = !!WC_PROJECT_ID;

export const wagmiConfig = createConfig({
  chains: [
    mainnet,
    base,
    arbitrum,
    optimism,
    polygon,
    avalanche,
    bsc,
    hyperEvm,
    gnosis,
    scroll,
    zkSync,
    linea,
    mantle,
    metis,
    fantom,
    sonic,
    celo,
  ],
  connectors: [
    injected(),
    ...(WC_PROJECT_ID
      ? [walletConnect({ projectId: WC_PROJECT_ID, showQrModal: true, metadata: { name: "Meridian", description: "DeFi strategies from plain words", url: "https://meridian-terminal-liart.vercel.app", icons: [] } })]
      : []),
  ],
  transports: {
    [mainnet.id]: fallback(RPC_URLS[mainnet.id].map((url) => http(url))),
    [base.id]: fallback(RPC_URLS[base.id].map((url) => http(url))),
    [arbitrum.id]: fallback(RPC_URLS[arbitrum.id].map((url) => http(url))),
    [optimism.id]: fallback(RPC_URLS[optimism.id].map((url) => http(url))),
    [polygon.id]: fallback(RPC_URLS[polygon.id].map((url) => http(url))),
    [avalanche.id]: fallback(RPC_URLS[avalanche.id].map((url) => http(url))),
    [bsc.id]: fallback(RPC_URLS[bsc.id].map((url) => http(url))),
    [hyperEvm.id]: fallback(RPC_URLS[hyperEvm.id].map((url) => http(url))),
    [gnosis.id]: http(),
    [scroll.id]: http(),
    [zkSync.id]: http(),
    [linea.id]: http(),
    [mantle.id]: http(),
    [metis.id]: http(),
    [fantom.id]: http(),
    [sonic.id]: http(),
    [celo.id]: http(),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
