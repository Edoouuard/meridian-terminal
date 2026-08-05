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
import { injected } from "wagmi/connectors";

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
  connectors: [injected()],
  transports: {
    [mainnet.id]: http(),
    [base.id]: http(),
    [arbitrum.id]: http(),
    [optimism.id]: http(),
    [polygon.id]: http(),
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
