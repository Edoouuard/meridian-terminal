import { describe, expect, it } from "vitest";
import { encode } from "@msgpack/msgpack";
import { bytesToHex, hashStruct, hashTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  isUnauthorizedAgent,
  parseTxflowResponse,
  priceOnTick,
  sizeToWire,
  txflowAgentTypedData,
  txflowApproveAgent,
  txflowConnectionId,
  txflowOrderAction,
  txflowOrderBody,
  txflowSignature,
  txflowWithdraw,
} from "@/lib/integrations/txflowExchange";

// Official vectors (docs.txflow.com/api/signing#test-vectors): key 0xabab…abab, testnet domain.
const KEY = `0x${"ab".repeat(32)}` as const;
const account = privateKeyToAccount(KEY);

describe("TxFlow signing (official test vectors)", () => {
  it("uses the documented throwaway address", () => {
    expect(account.address.toLowerCase()).toBe("0xe239cdc5fbe977a8a141b72194d3cf8c41bc5bc6");
  });

  const order = txflowOrderAction([txflowOrderBody({ asset: 1, isBuy: true, px: "50000.0", sz: "0.01", reduceOnly: false, tif: "Gtc" })]);

  it("encodes the order like the node and derives its connectionId", () => {
    const { type: _t, ...body } = order;
    void _t;
    expect(bytesToHex(encode(body))).toBe(
      "0x82a867726f7570696e67a26e61a66f72646572739186a16101a162c3a170a735303030302e30a173a4302e3031a172c2a17481a56c696d697481a3746966a3477463",
    );
    expect(txflowConnectionId(order, 1700000000000)).toBe("0x6546d1c3acf430a28a0b2552c66e985f6543646660874734732ae9e9daf4d806");
  });

  it("signs the order as the agent", async () => {
    const td = txflowAgentTypedData(order, 1700000000000, "testnet");
    expect(hashTypedData(td)).toBe("0xeae1ae63709636fb9567accd33bc5dd2717bfac4d97e9a853f91c7fb391e1cc6");
    const sig = txflowSignature(await account.signTypedData(td));
    expect(sig).toEqual({
      r: "0x4064848dd881985c52dacdc00f7046f1010f7f370e34620d36fcf3b2d1ecb3e0",
      s: "0x25c45ad67b9506ac653fc3658f47aa8b6002bfa86a31ae619b334d71aa8b4f6f",
      v: 27,
    });
  });

  it("signs approveAgent with the account key", async () => {
    const { action, typedData } = txflowApproveAgent({ network: "testnet", agentAddress: "0x0202020202020202020202020202020202020202", agentName: "my-trading-bot", nonce: 2000 });
    expect(action).toEqual({ type: "approveAgent", txflowNetwork: "TxFlow-Testnet", chainId: 2511, apiVersion: 1, agentAddress: "0x0202020202020202020202020202020202020202", agentName: "my-trading-bot", nonce: 2000 });
    expect(hashStruct({ data: typedData.message, primaryType: "ApproveAgent", types: typedData.types })).toBe("0xbb5293971660f3252f455b6debbda781841fb23bd45cbbf0199c4de5250573b9");
    expect(hashTypedData(typedData)).toBe("0x1df22801b48ae1402ad36b244aa245fd6e842fa5fef2c40819b1e6c661cd2212");
    expect(txflowSignature(await account.signTypedData(typedData))).toEqual({
      r: "0x4431d4afb9fcd0dcd619afd55a7044cc26cb0ee1d436a1b06d836da217842ead",
      s: "0x54a0755ee3d8c241235a1828a2be732d72e9c152b5de25fc7c169966de4210f7",
      v: 27,
    });
  });

  it("moves only the domain to the wallet's chain, never the struct", () => {
    const onArb = txflowApproveAgent({ network: "mainnet", agentAddress: account.address, agentName: "meridian", nonce: 1, walletChainId: 42161 });
    expect(onArb.typedData.domain.chainId).toBe(42161);
    expect(onArb.typedData.message.chainId).toBe(869);
    expect(onArb.signatureChainId).toBe(42161);
    const w = txflowWithdraw({ network: "mainnet", destination: account.address, amount: "10", nonce: 5, walletChainId: 42161 });
    expect(w.action).toMatchObject({ type: "withdraw3", txflowNetwork: "TxFlow-Mainnet", chainId: 869, signatureChainId: "a4b1", amount: "10", nonce: 5 });
    expect(w.typedData.message.signatureChainId).toBe("a4b1");
  });
});

describe("TxFlow wire values", () => {
  it("puts prices on the tick and sizes on szDecimals as strings", () => {
    expect(priceOnTick(3012.37, "0.1", "up")).toBe("3012.4");
    expect(priceOnTick(3012.37, "0.1", "down")).toBe("3012.3");
    expect(priceOnTick(65012.6, "1")).toBe("65013");
    expect(priceOnTick(0.123456, "0.0001", "down")).toBe("0.1234");
    expect(sizeToWire(0.123456, 4)).toBe("0.1234");
    expect(sizeToWire(1.5, 0)).toBe("1");
    expect(sizeToWire(0.5, 4)).toBe("0.5");
  });

  it("keeps the margin mode last in an order body", () => {
    expect(Object.keys(txflowOrderBody({ asset: 2, isBuy: false, px: "1", sz: "1", marginMode: "cross" }))).toEqual(["a", "b", "p", "s", "r", "t", "m"]);
  });
});

describe("parseTxflowResponse", () => {
  it("reads success, an execution error, a rejection and a pending execution", () => {
    expect(parseTxflowResponse({ status: "ok", code: 0, data: { type: "PlaceOrder", data: { statuses: ["success"] } } })).toEqual({ ok: true });
    expect(parseTxflowResponse({ status: "ok", data: { data: { statuses: [{ error: "Insufficient margin in account" }] } } })).toEqual({ ok: false, error: "Insufficient margin in account" });
    expect(parseTxflowResponse({ status: "err", code: 10000, message: "Price precision does not match the tick size: 0.1" })).toEqual({ ok: false, error: "Price precision does not match the tick size: 0.1" });
    expect(parseTxflowResponse({ status: "pending", txHash: "0x1" }, 202)).toMatchObject({ ok: false, pending: true });
  });

  it("recognizes an agent the node doesn't know", () => {
    expect(isUnauthorizedAgent("Agent 0xabc is not authorized by any account")).toBe(true);
    expect(isUnauthorizedAgent("Insufficient margin in account")).toBe(false);
  });
});

describe("TxFlow position stop-loss / take-profit", () => {
  it("builds reduce-only market triggers on the closing side, stop-loss first, in the node's key order", async () => {
    const { txflowPositionTpslAction } = await import("@/lib/integrations/txflowExchange");
    const a = txflowPositionTpslAction({ asset: 2, isLong: true, sl: "2850.00", tp: "3300.00", marginMode: "cross" });
    expect(a.grouping).toBe("positionTpsl");
    expect(a.orders.map((o) => o.t.trigger.tpsl)).toEqual(["sl", "tp"]);
    expect(a.orders[0]).toEqual({ a: 2, b: false, p: "2850.00", s: "0", r: true, t: { trigger: { isMarket: true, triggerPx: "2850.00", tpsl: "sl" } }, m: "cross" });
    expect(Object.keys(a.orders[0])).toEqual(["a", "b", "p", "s", "r", "t", "m"]);
    expect(Object.keys(a.orders[0].t.trigger)).toEqual(["isMarket", "triggerPx", "tpsl"]);
    // A short closes by buying; only the legs asked for are sent.
    const short = txflowPositionTpslAction({ asset: 2, isLong: false, tp: "2700.00" });
    expect(short.orders).toEqual([{ a: 2, b: true, p: "2700.00", s: "0", r: true, t: { trigger: { isMarket: true, triggerPx: "2700.00", tpsl: "tp" } } }]);
  });

  it("prices the stop against the position and the target with it, on the tick", async () => {
    const { txflowProtectionPrices } = await import("@/lib/integrations/txflowTrade");
    expect(txflowProtectionPrices(3000, true, "0.01", { stopLossPct: 5, takeProfitPct: 10 })).toEqual({ sl: "2850.00", tp: "3300.00" });
    expect(txflowProtectionPrices(3000, false, "0.1", { stopLossPct: 5 })).toEqual({ sl: "3150.0", tp: undefined });
    expect(txflowProtectionPrices(3000, true, "0.1", {})).toEqual({ sl: undefined, tp: undefined });
  });
});

describe("TxFlow builder approval", () => {
  it("signs ApproveBuilderFee with the documented type, on the wallet's chain, for Meridian's builder", async () => {
    const { txflowApproveBuilderFee, TXFLOW_BUILDER, TXFLOW_BUILDER_MAX_FEE } = await import("@/lib/integrations/txflowExchange");
    expect(TXFLOW_BUILDER).toBe("0xD69Fb18e83F0691D13D9B27D50E7D589eAAcc4E2");
    expect(TXFLOW_BUILDER_MAX_FEE).toBe("0.001%");
    const { action, typedData, signatureChainId } = txflowApproveBuilderFee({ network: "mainnet", builder: TXFLOW_BUILDER, maxFeeRate: TXFLOW_BUILDER_MAX_FEE, nonce: 7, walletChainId: 42161 });
    expect(action).toEqual({ type: "approveBuilderFee", txflowNetwork: "TxFlow-Mainnet", chainId: 869, apiVersion: 1, builder: TXFLOW_BUILDER, maxFeeRate: "0.001%", nonce: 7 });
    expect(typedData.types.ApproveBuilderFee.map((f) => `${f.type} ${f.name}`).join(",")).toBe(
      "string txflowNetwork,uint32 chainId,uint32 apiVersion,address builder,string maxFeeRate,uint64 nonce",
    );
    expect(typedData.domain.chainId).toBe(42161);
    expect(typedData.message.chainId).toBe(869);
    expect(signatureChainId).toBe(42161);
    // The digest is computable (a malformed type would throw here).
    expect(hashTypedData(typedData)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
