import { describe, expect, it, vi } from "vitest";
import {
  EXTENDED_DEPOSIT_TOKEN,
  RHINO_ARBITRUM_BRIDGE,
  arbitrumBridgeFromConfig,
  commitQuote,
  commitmentIdFromQuote,
  depositCall,
  depositForTx,
  parseQuote,
  quoteArbitrumDeposit,
  usdcUnits,
} from "./extendedBridge";
import { orderPathFor } from "./extendedProxy";

const signer = { apiKey: "k", l2PrivateKey: "0x1", l2PublicKey: "0x2", vaultId: "1", network: "mainnet" } as never;
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("Extended deposit bridge", () => {
  it("accepts only the known Rhino.fi contract on Arbitrum", () => {
    expect(arbitrumBridgeFromConfig({ chains: [{ chain: "ARB", contractAddress: RHINO_ARBITRUM_BRIDGE.toLowerCase() }] })).toBe(RHINO_ARBITRUM_BRIDGE);
    expect(() => arbitrumBridgeFromConfig({ chains: [{ chain: "ARB", contractAddress: "0x0000000000000000000000000000000000000001" }] })).toThrow(/changed/);
    expect(() => arbitrumBridgeFromConfig({ chains: [{ chain: "ETH", contractAddress: RHINO_ARBITRUM_BRIDGE }] })).toThrow(/doesn't list/);
  });

  it("turns the hex quote id into the uint256 commitment id, and refuses anything else", () => {
    expect(commitmentIdFromQuote("68aaa")).toBe(0x68aaan);
    expect(commitmentIdFromQuote("0x68AAA")).toBe(0x68aaan);
    expect(() => commitmentIdFromQuote("68a-aa")).toThrow(/Unexpected/);
    expect(() => commitmentIdFromQuote("")).toThrow();
  });

  it("sizes USDC in base units, down to the cent", () => {
    expect(usdcUnits(25)).toBe(25_000_000n);
    expect(usdcUnits(10.019)).toBe(10_010_000n);
  });

  it("builds depositWithId with the same id, amount and native USDC", () => {
    const call = depositCall(RHINO_ARBITRUM_BRIDGE, parseQuote({ id: "68aaa", fee: "0.1" }, 25));
    expect(call).toMatchObject({ chainId: 42161, address: RHINO_ARBITRUM_BRIDGE, functionName: "depositWithId" });
    expect(call.args).toEqual([EXTENDED_DEPOSIT_TOKEN, 25_000_000n, 0x68aaan]);
  });

  it("quotes Arbitrum → Starknet in USD through the relay with the API key, and commits by id", async () => {
    const fetchImpl = vi.fn(async () => ok({ status: "OK", data: { id: "68aaa", fee: "0.1" } }));
    const q = await quoteArbitrumDeposit(signer, 25.009, fetchImpl as never);
    expect(q).toEqual({ id: "68aaa", feeUsd: 0.1, amountUsd: 25 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/api\/extended\/mainnet\/api\/v1\/user\/bridge\/quote\?chainIn=ARB&chainOut=STRK&amount=25\.00&asset=USD$/);
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("k");

    const commit = vi.fn(async () => ok({ status: "OK" }));
    await commitQuote(signer, "68aaa", commit as never);
    expect((commit.mock.calls[0] as unknown as [string, RequestInit])[1].method).toBe("POST");
  });

  it("refuses a deposit under the minimum before calling Extended", async () => {
    const fetchImpl = vi.fn();
    await expect(quoteArbitrumDeposit(signer, 5, fetchImpl as never)).rejects.toThrow(/start at \$10/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces Extended's error message (e.g. the geo-restriction)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: "ERROR", error: { message: "Country is geoblocked." } }), { status: 451 }));
    await expect(quoteArbitrumDeposit(signer, 25, fetchImpl as never)).rejects.toThrow("Country is geoblocked.");
  });

  it("finds the deposit of a transaction", () => {
    const d = [{ id: "0x1", status: "IN_PROGRESS", amountUsd: 24.9, transactionHash: "0xABC", time: 1 }];
    expect(depositForTx(d, "0xabc")?.status).toBe("IN_PROGRESS");
    expect(depositForTx(d, "0xdef")).toBeUndefined();
  });
});

describe("Extended relay — orders on RFQ markets (SPCX-USD, 2026-10-16)", () => {
  const rfq = (m: string) => m === "SPCX-USD";
  const body = (market: string) => JSON.stringify({ market, type: "MARKET", side: "SELL" });
  it("sends an order on an RFQ market to /user/order/rfq, others unchanged", () => {
    expect(orderPathFor(["api", "v1", "user", "order"], "POST", body("SPCX-USD"), rfq)).toEqual(["api", "v1", "user", "order", "rfq"]);
    expect(orderPathFor(["api", "v1", "user", "order"], "POST", body("ETH-USD"), rfq)).toEqual(["api", "v1", "user", "order"]);
    expect(orderPathFor(["api", "v1", "user", "leverage"], "PATCH", body("SPCX-USD"), rfq)).toEqual(["api", "v1", "user", "leverage"]);
    expect(orderPathFor(["api", "v1", "user", "order"], "POST", "{bad", rfq)).toEqual(["api", "v1", "user", "order"]);
  });
});

describe("Extended relay — refused order log", () => {
  it("logs the order's fields but never its settlement", async () => {
    const { orderForLog } = await import("./extendedProxy");
    const line = orderForLog(JSON.stringify({ market: "SPCX-USD", qty: "1.35", settlement: { signature: { r: "0xsecret", s: "0xsecret" }, starkKey: "0xkey" } }));
    expect(line).toContain('"market":"SPCX-USD"');
    expect(line).toContain('"settlement":"present"');
    expect(line).not.toContain("secret");
    expect(line).not.toContain("0xkey");
    expect(orderForLog("{bad")).toBe("(not JSON, 4 chars)");
  });
});

describe("bridge quote when Extended's server fails (owner report: HTTP 500, code 1006)", () => {
  const signer = { network: "mainnet", apiKey: "k" } as never;
  const err500 = () => new Response(JSON.stringify({ status: "ERROR", error: { code: 1006, message: "Internal Server Error" } }), { status: 500 });
  const okQuote = () => new Response(JSON.stringify({ status: "OK", data: { id: "68aaa", fee: "0.1" } }), { status: 200 });

  it("tries the other documented forms and quotes the amount of the form that answered", async () => {
    const { quoteArbitrumDeposit } = await import("./extendedBridge");
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      return urls.length < 3 ? err500() : okQuote();
    });
    const q = await quoteArbitrumDeposit(signer, 20.5, fetchImpl as never);
    expect(urls.map((u) => u.split("quote?")[1])).toEqual([
      "chainIn=ARB&chainOut=STRK&amount=20.50&asset=USD",
      "chainIn=ARB&chainOut=STRK&amount=20.50",
      "chainIn=ARB&chainOut=STRK&amount=20&asset=USD",
    ]);
    expect(q).toEqual({ id: "68aaa", feeUsd: 0.1, amountUsd: 20 });
  });

  it("says what to do when every form fails, and never retries a refusal", async () => {
    const { quoteArbitrumDeposit } = await import("./extendedBridge");
    const all500 = vi.fn(async () => err500());
    await expect(quoteArbitrumDeposit(signer, 20, all500 as never)).rejects.toThrow(/failing on its side .*Nothing was sent.*app\.extended\.exchange/);
    expect(all500).toHaveBeenCalledTimes(3);
    const refused = vi.fn(async () => new Response(JSON.stringify({ status: "ERROR", error: { message: "AssetIsNotSupported" } }), { status: 400 }));
    await expect(quoteArbitrumDeposit(signer, 20, refused as never)).rejects.toThrow("AssetIsNotSupported");
    expect(refused).toHaveBeenCalledTimes(1);
  });
});

describe("a refusal after Extended's server error (owner report: 'Asset not found' shown)", () => {
  it("reports Extended's outage, not the later refusal", async () => {
    const { quoteArbitrumDeposit } = await import("./extendedBridge");
    let n = 0;
    const fetchImpl = vi.fn(async () =>
      ++n === 1
        ? new Response(JSON.stringify({ status: "ERROR", error: { code: 1006, message: "Internal Server Error" } }), { status: 500 })
        : new Response(JSON.stringify({ status: "ERROR", error: { code: 1000, message: "Asset not found" } }), { status: 400 }),
    );
    await expect(quoteArbitrumDeposit({ network: "mainnet", apiKey: "k" } as never, 20, fetchImpl as never)).rejects.toThrow(/Internal Server Error/);
  });
});
