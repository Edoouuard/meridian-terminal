import { http, createConfig } from "wagmi";
import { arbitrum, avalanche, base, mainnet, optimism, polygon } from "wagmi/chains";
import { injected } from "wagmi/connectors";

export const wagmiConfig = createConfig({
  chains: [mainnet, base, arbitrum, optimism, polygon, avalanche],
  connectors: [injected()],
  transports: {
    [mainnet.id]: http(),
    [base.id]: http(),
    [arbitrum.id]: http(),
    [optimism.id]: http(),
    [polygon.id]: http(),
    [avalanche.id]: http(),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
