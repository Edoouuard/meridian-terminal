import { describe, expect, it } from "vitest";
import { hedgesSpot } from "@/components/thread/StrategyLegs";
import type { TradeLeg } from "@/lib/tradePlan";

const short: TradeLeg = { side: "Short", asset: "ETH PERP", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd: 200, leverage: 2 };

describe("hedgesSpot", () => {
  it("sees a short against an LST bought in the same plan as a hedge", () => {
    const swap: TradeLeg = { side: "Swap", asset: "USDC → wstETH", protocol: "Uniswap", chain: "Arbitrum", sizeUsd: 200 };
    expect(hedgesSpot(short, [swap, short])).toBe(true);
  });

  it("sees a lone short, or a long, as a directional bet", () => {
    const deposit: TradeLeg = { side: "Deposit", asset: "USDC", protocol: "Hyperliquid", chain: "Arbitrum", sizeUsd: 100 };
    expect(hedgesSpot(short, [deposit, short])).toBe(false);
    expect(hedgesSpot({ ...short, side: "Long" }, [{ side: "Swap", asset: "USDC → WETH", protocol: "Uniswap", chain: "Arbitrum", sizeUsd: 1 }])).toBe(false);
  });
});
