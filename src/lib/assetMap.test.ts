import { describe, expect, it } from "vitest";
import {
  approveOrderFor,
  humanAmountForLeg,
  resolveOrderForLeg,
  type PriceEntry,
} from "@/lib/assetMap";
import type { Order } from "@/lib/execution";
import type { TradeLeg } from "@/lib/tradePlan";

const BASE_CHAIN_ID = 8453;
const BASE_AARCHING = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // Base USDC
const USDC_PRICE: PriceEntry[] = [{ symbol: "USDC", price: 1 }];

function leg(partial: Partial<TradeLeg> = {}): TradeLeg {
  return { side: "Supply", asset: "USDC", protocol: "Aave", sizeUsd: 1000, ...partial };
}

describe("assetMap — resolveOrderForLeg (Aave supply on Base)", () => {
  it("routes 'supply USDC on base' to Base's Aave order", () => {
    const order = resolveOrderForLeg(leg(), undefined, USDC_PRICE, BASE_CHAIN_ID) as Order;
    expect(order.type).toBe("supply");
    expect(order.protocol).toBe("aave");
    expect(order.symbol).toBe("USDC");
    expect(order.token).toBe(BASE_AARCHING);
    expect(order.chainId).toBe(BASE_CHAIN_ID);
    expect(order.decimals).toBe(6);
    // $1000 at $1 with 6 decimals → exactly 1_000_000_000 base units
    expect(order.amount).toBe(1_000_000_000n);
  });

  it("defaults to mainnet chain when chainId is omitted", () => {
    const order = resolveOrderForLeg(leg(), undefined, USDC_PRICE) as Order;
    expect(order.chainId).toBe(1);
    expect(order.token).toBe("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"); // mainnet USDC
  });

  it("hard-fails with an unsupported flag when no live price is provided", () => {
    const res = resolveOrderForLeg(leg(), undefined, undefined, BASE_CHAIN_ID);
    expect("unsupported" in res).toBe(true);
    expect(res.unsupported).toContain("No live price for USDC");
  });

  it("rejects an asset with no tracked address on the given chain", () => {
    const res = resolveOrderForLeg(leg({ asset: "DOGE" }), undefined, USDC_PRICE, BASE_CHAIN_ID);
    expect("unsupported" in res).toBe(true);
    expect(res.unsupported).toContain('"DOGE" has no tracked');
  });

  it("returns unsupported for non-wired venues (Hyperliquid long)", () => {
    const res = resolveOrderForLeg(
      { side: "Long", asset: "HYPE PERP", protocol: "Hyperliquid", sizeUsd: 6000 },
      undefined,
      USDC_PRICE,
      BASE_CHAIN_ID,
    );
    expect("unsupported" in res).toBe(true);
    expect(res.unsupported).toContain("perps not wired");
  });

  it("returns unsupported for an unwired Aave side", () => {
    const res = resolveOrderForLeg(leg({ side: "Stake" }), undefined, USDC_PRICE, BASE_CHAIN_ID);
    expect("unsupported" in res).toBe(true);
    expect(res.unsupported).toContain("not wired");
  });
});

describe("assetMap — approveOrderFor", () => {
  const supply: Order = {
    type: "supply",
    protocol: "aave",
    symbol: "USDC",
    token: BASE_AARCHING,
    amount: 1_000_000_000n,
    chainId: BASE_CHAIN_ID,
    decimals: 6,
  };

  it("derives an approve order from an Aave supply order", () => {
    const approve = approveOrderFor(supply);
    expect(approve).not.toBeNull();
    expect(approve!.type).toBe("approve");
    expect(approve!.protocol).toBe("aave");
    expect(approve!.token).toBe(BASE_AARCHING);
    expect(approve!.amount).toBe(1_000_000_000n);
    expect(approve!.chainId).toBe(BASE_CHAIN_ID);
  });

  it("returns null for non-supply or non-token orders", () => {
    expect(approveOrderFor({ ...supply, type: "repay" })).toBeNull();
    expect(approveOrderFor({ ...supply, token: undefined })).toBeNull();
  });
});

describe("assetMap — humanAmountForLeg", () => {
  it("returns exact human unit for a 1:1 stablecoin", () => {
    expect(humanAmountForLeg(leg(), USDC_PRICE, BASE_CHAIN_ID)).toBe("1000");
  });

  it("returns empty string when no price is available (hard-fail)", () => {
    expect(humanAmountForLeg(leg(), undefined, BASE_CHAIN_ID)).toBe("");
  });
});