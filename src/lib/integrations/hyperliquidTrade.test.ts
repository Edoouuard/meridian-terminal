import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { hyperliquidEnv, withdrawUsdcToArbitrum, withdrawableUsd, type WalletSign } from "@/lib/integrations/hyperliquidTrade";

const wallet = privateKeyToAccount("0x0123456789012345678901234567890123456789012345678901234567890123");
const walletSign: WalletSign = (td) => wallet.signTypedData(td as never);
const env = hyperliquidEnv(false);

/** Answers Hyperliquid's info calls from `state`, records exchange calls and answers them from `exchange`. */
function mockHyperliquid(state: { withdrawable: string; spotUsdc: string; abstraction: string | null }, exchange: (action: { type: string }) => unknown) {
  const sent: { type: string; amount?: string }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    const json = (v: unknown) => ({ ok: true, status: 200, json: async () => v });
    if (url.endsWith("/exchange")) {
      sent.push(body.action);
      return json(exchange(body.action));
    }
    if (body.type === "clearinghouseState") return json({ withdrawable: state.withdrawable });
    if (body.type === "spotClearinghouseState") return json({ balances: [{ coin: "USDC", total: state.spotUsdc, hold: "0" }] });
    if (body.type === "userAbstraction") return json(state.abstraction);
    return json(null);
  }));
  return sent;
}

afterEach(() => vi.unstubAllGlobals());

describe("withdrawableUsd", () => {
  it("counts one shared balance in a unified account, perps + spot otherwise", () => {
    expect(withdrawableUsd({ perps: 0, spotUsdc: 69, unified: true })).toBe(69);
    expect(withdrawableUsd({ perps: 60, spotUsdc: 69, unified: true })).toBe(69);
    expect(withdrawableUsd({ perps: 10, spotUsdc: 20, unified: false })).toBe(30);
  });
});

describe("withdrawUsdcToArbitrum", () => {
  const user = wallet.address;

  it("withdraws straight from a unified account, with no spot → perps transfer", async () => {
    const sent = mockHyperliquid({ withdrawable: "0", spotUsdc: "69.02", abstraction: "unifiedAccount" }, () => ({ status: "ok", response: { type: "default" } }));
    const out = await withdrawUsdcToArbitrum({ user, env, walletSign, walletChainId: 42161, amount: 69 });
    expect(out).toEqual({ ok: true, amount: 69 });
    expect(sent.map((a) => a.type)).toEqual(["withdraw3"]);
    expect(sent[0].amount).toBe("69.00");
  });

  it("falls back to a direct withdrawal when Hyperliquid refuses the transfer for a unified account", async () => {
    const sent = mockHyperliquid({ withdrawable: "0", spotUsdc: "69", abstraction: null }, (a) =>
      a.type === "usdClassTransfer" ? { status: "err", response: "Action disabled when unified account is active" } : { status: "ok", response: { type: "default" } },
    );
    const out = await withdrawUsdcToArbitrum({ user, env, walletSign, walletChainId: 42161, amount: 69 });
    expect(out).toEqual({ ok: true, amount: 69 });
    expect(sent.map((a) => a.type)).toEqual(["usdClassTransfer", "withdraw3"]);
  });

  it("moves spot USDC to perps first in a classic account", async () => {
    const sent = mockHyperliquid({ withdrawable: "10", spotUsdc: "59", abstraction: "default" }, () => ({ status: "ok", response: { type: "default" } }));
    const out = await withdrawUsdcToArbitrum({ user, env, walletSign, walletChainId: 42161, amount: 69 });
    expect(out.ok).toBe(true);
    expect(sent.map((a) => `${a.type}:${a.amount}`)).toEqual(["usdClassTransfer:59.00", "withdraw3:69.00"]);
  });
});
