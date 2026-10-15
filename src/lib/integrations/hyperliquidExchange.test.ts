import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { planSpotSell } from "@/lib/integrations/hyperliquidTrade";
import { isHyperCoreSystemAddress } from "@/lib/execution";
import {
  approveAgentAction,
  firstOrderError,
  floatToWire,
  l1TypedData,
  orderAction,
  orderWire,
  parseExchangeResponse,
  roundPrice,
  roundSize,
  splitSignature,
  usdClassTransferAction,
  withdrawAction,
  systemAddressForToken,
  triggerOrderWire,
  updateLeverageAction,
} from "@/lib/integrations/hyperliquidExchange";

// Test key and expected signatures from hyperliquid-python-sdk (signing.sign_l1_action /
// sign_agent), run on the same inputs: the first is the SDK's own published test vector.
const wallet = privateKeyToAccount("0x0123456789012345678901234567890123456789012345678901234567890123");

async function l1(action: unknown, nonce: number, mainnet: boolean) {
  return splitSignature(await wallet.signTypedData(l1TypedData(action, nonce, mainnet) as never));
}

describe("hyperliquidExchange — signatures match the official SDK", () => {
  it("signs an order (mainnet and testnet)", async () => {
    const order = orderAction([orderWire({ asset: 1, isBuy: true, px: 100, sz: 100, tif: "Gtc" })]);
    expect(await l1(order, 0, true)).toEqual({
      r: "0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e",
      s: "0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e",
      v: 28,
    });
    expect((await l1(order, 0, false)).r).toBe("0x82b2ba28e76b3d761093aaded1b1cdad4960b3af30212b343fb2e6cdfa4e3d54");
  });

  it("signs a stop-loss and a take-profit (trigger orders)", async () => {
    const action = orderAction([
      triggerOrderWire({ asset: 1, isBuy: false, px: 1800, sz: 0.05, triggerPx: 2000, tpsl: "sl" }),
      triggerOrderWire({ asset: 1, isBuy: false, px: 2475, sz: 0.05, triggerPx: 2750, tpsl: "tp" }),
    ]);
    expect(action.orders[0]).toEqual({ a: 1, b: false, p: "1800", s: "0.05", r: true, t: { trigger: { isMarket: true, triggerPx: "2000", tpsl: "sl" } } });
    const sig = await l1(action, 1700000000123, true);
    expect(BigInt(sig.r)).toBe(BigInt("0x2ef9312aafd4858e8dfee8eb0ed74102111c5d5cf337f1909ae5f46b401ee2b"));
    expect(BigInt(sig.s)).toBe(BigInt("0x157aadf4e03e9fd0aa46cbaa381c15ef362a6c6edf4901d7f1c4272a1d084a7d"));
    expect(sig.v).toBe(27);
  });

  it("reads the first error of a multi-order response", () => {
    expect(firstOrderError({ status: "ok", response: { type: "order", data: { statuses: ["waitingForTrigger", { error: "Invalid TP/SL price." }] } } })).toBe("Invalid TP/SL price.");
    expect(firstOrderError({ status: "ok", response: { type: "order", data: { statuses: ["waitingForTrigger", "waitingForTrigger"] } } })).toBeUndefined();
  });

  it("signs a leverage update and a spot IOC sell", async () => {
    expect((await l1(updateLeverageAction(1, 5), 1700000000000, true)).r).toBe("0xb6d73e1e08b1e33aa259c4437c352cc6ada4484c0b7739c576ba273c0836d24a");
    const spot = orderAction([orderWire({ asset: 10107, isBuy: false, px: 2405.3, sz: 0.0198, tif: "Ioc" })]);
    expect(await l1(spot, 1700000000123, true)).toEqual({
      r: "0x3611b162db83ade87c0e5ce01d120979a6d21cae614556f51b8beafc16e6d969",
      s: "0x6b285e32dd85220a227f5a075560ed34e381e1317f0a00383bbab60512bed5a1",
      v: 27,
    });
  });

  it("builds and signs approveAgent like sign_agent", async () => {
    const { action, typedData } = approveAgentAction({
      agentAddress: "0x1111111111111111111111111111111111111111",
      agentName: "meridian",
      nonce: 1700000000000,
      isMainnet: true,
      signatureChainId: 0x66eee,
    });
    expect(action).toMatchObject({ type: "approveAgent", signatureChainId: "0x66eee", hyperliquidChain: "Mainnet" });
    expect(splitSignature(await wallet.signTypedData(typedData as never))).toEqual({
      r: "0x4f683cdc7861518335b391234cea347e36eb72f3af58e03b8450c6895bbc5dd4",
      s: "0x5849db364d0f3851aa5e7373d62cc7420e0251ebbaa3df56ecc04b6351e9670b",
      v: 27,
    });
  });
});

describe("hyperliquidExchange — wire formats", () => {
  it("formats numbers like float_to_wire", () => {
    expect(floatToWire(100)).toBe("100");
    expect(floatToWire(0.0198)).toBe("0.0198");
    expect(floatToWire(-0)).toBe("0");
  });

  it("rounds prices to 5 significant figures and the asset's decimals", () => {
    expect(roundPrice(2405.3456, 4, false)).toBe(2405.3);
    expect(roundPrice(0.123456789, 0, true)).toBe(0.12346);
    expect(roundSize(0.019876, 4, true)).toBe(0.0198);
  });

  it("derives a token's HyperCore system address", () => {
    expect(systemAddressForToken(221)).toBe("0x20000000000000000000000000000000000000dd");
  });

  it("reads fills and errors from /exchange responses", () => {
    expect(parseExchangeResponse({ status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: "0.0198", avgPx: "2401.1", oid: 1 } }] } } })).toEqual({
      ok: true,
      filled: { totalSz: 0.0198, avgPx: 2401.1 },
    });
    expect(parseExchangeResponse({ status: "ok", response: { type: "order", data: { statuses: [{ error: "Insufficient margin" }] } } })).toEqual({ ok: false, error: "Insufficient margin" });
    expect(parseExchangeResponse({ status: "err", response: "User or API Wallet 0xabc does not exist." }).error).toMatch(/does not exist/);
  });
});

describe("planSpotSell", () => {
  it("moves only what the spot balance lacks, floored to the size step", () => {
    expect(planSpotSell({ target: 0.01, core: 0.004, evm: 0.02, szDecimals: 4 })).toEqual({ move: 0.006, sell: 0.01 });
  });
  it("sells the whole holding when the target is within 3% of it", () => {
    expect(planSpotSell({ target: 0.0195, core: 0, evm: 0.019873, szDecimals: 4 })).toEqual({ move: 0.0198, sell: 0.0198 });
    expect(planSpotSell({ core: 0.5, evm: 0, szDecimals: 4 })).toEqual({ move: 0, sell: 0.5 });
  });
  it("never moves or sells more than is held", () => {
    expect(planSpotSell({ target: 5, core: 0.1, evm: 0.2, szDecimals: 4 })).toEqual({ move: 0.2, sell: 0.3 });
    expect(planSpotSell({ target: 1, core: 0, evm: 0, szDecimals: 4 })).toEqual({ move: 0, sell: 0 });
  });
});

describe("isHyperCoreSystemAddress", () => {
  it("matches 0x20…{index} on HyperEVM only", () => {
    expect(isHyperCoreSystemAddress(999, systemAddressForToken(221))).toBe(true);
    expect(isHyperCoreSystemAddress(42161, systemAddressForToken(221))).toBe(false);
    expect(isHyperCoreSystemAddress(999, "0x2222222222222222222222222222222222222222")).toBe(false);
  });
});

describe("user-signed transfers (hyperliquid-python-sdk vectors, chain 0x66eee)", () => {
  const wallet = privateKeyToAccount("0x0123456789012345678901234567890123456789012345678901234567890123");
  it("signs withdraw3 like sign_withdraw_from_bridge_action", async () => {
    const { action, typedData } = withdrawAction({ destination: "0x5e9ee1089755c3435139848e47e6635505d5a13a", amount: "68", time: 1700000000123, isMainnet: true, signatureChainId: 0x66eee });
    expect(action).toMatchObject({ type: "withdraw3", hyperliquidChain: "Mainnet", signatureChainId: "0x66eee", amount: "68", time: 1700000000123 });
    const sig = splitSignature(await wallet.signTypedData(typedData as never));
    expect(sig).toEqual({ r: "0x5ccb4175a94f1ca529146b2b7afa1295f606481fb254ad8c5848671670163e63", s: "0x7b6ee53bc65c7a97d4ff4e1a3317371bb182032a1d40fa2789754f04de17ec66", v: 28 });
  });
  it("signs usdClassTransfer like sign_usd_class_transfer_action", async () => {
    const { typedData } = usdClassTransferAction({ amount: "68", toPerp: true, nonce: 1700000000123, isMainnet: true, signatureChainId: 0x66eee });
    const sig = splitSignature(await wallet.signTypedData(typedData as never));
    expect(sig).toEqual({ r: "0x70bd432f1f53d219fbcd9b6345ab83eb28b19fbbc95f13390c59c97480beb123", s: "0x5bb489d6949b8671b597d597e978732bb461c76bbf4b2eb978c63d3475836fa1", v: 27 });
  });
});
