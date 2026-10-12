import { http, createConfig } from "wagmi";
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
import { injected, walletConnect } from "wagmi/connectors";

// Next.js only inlines NEXT_PUBLIC_* values into the browser bundle when they
// are written out literally (process.env.NEXT_PUBLIC_X) — a dynamic lookup
// like process.env[key] is undefined client-side. Keep these literal.
// An unset value falls back to the chain's public RPC.
const rpc = (url: string | undefined) => http(url || undefined);

const connectors = [
  injected(),
  ...(process.env.NEXT_PUBLIC_WC_PROJECT_ID
    ? [walletConnect({ projectId: process.env.NEXT_PUBLIC_WC_PROJECT_ID })]
    : []),
];

export const wagmiConfig = createConfig({
  chains: [
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
  ],
  connectors,
  transports: {
    [mainnet.id]: rpc(process.env.NEXT_PUBLIC_RPC_ETHEREUM),
    [base.id]: rpc(process.env.NEXT_PUBLIC_RPC_BASE),
    [arbitrum.id]: rpc(process.env.NEXT_PUBLIC_RPC_ARBITRUM),
    [optimism.id]: rpc(process.env.NEXT_PUBLIC_RPC_OPTIMISM),
    [polygon.id]: rpc(process.env.NEXT_PUBLIC_RPC_POLYGON),
    [avalanche.id]: http(),
    [bsc.id]: http(),
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
