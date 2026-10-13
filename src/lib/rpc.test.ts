import { describe, expect, it } from "vitest";
import { ACTIVE_CHAIN_IDS } from "@/lib/onchain";
import { rpcUrlsFor } from "@/lib/rpc";

describe("rpc — endpoint order", () => {
  it("uses public endpoints only when no key is set", () => {
    const urls = rpcUrlsFor(8453, {});
    expect(urls[0]).toBe("https://mainnet.base.org");
    expect(urls.some((u) => /alchemy|infura/.test(u))).toBe(false);
  });

  it("puts an explicit URL first, then Alchemy, then Infura, then public", () => {
    const urls = rpcUrlsFor(1, { NEXT_PUBLIC_RPC_ETHEREUM: "https://my.node", NEXT_PUBLIC_ALCHEMY_API_KEY: "ak", NEXT_PUBLIC_INFURA_API_KEY: "ik" });
    expect(urls.slice(0, 3)).toEqual(["https://my.node", "https://eth-mainnet.g.alchemy.com/v2/ak", "https://mainnet.infura.io/v3/ik"]);
    expect(urls[3]).toBe("https://ethereum-rpc.publicnode.com");
  });

  it("covers every active chain with both providers", () => {
    for (const id of ACTIVE_CHAIN_IDS) {
      const urls = rpcUrlsFor(id, { NEXT_PUBLIC_ALCHEMY_API_KEY: "ak", NEXT_PUBLIC_INFURA_API_KEY: "ik" });
      expect(urls.filter((u) => u.includes(".g.alchemy.com/v2/ak")), `alchemy on ${id}`).toHaveLength(1);
      expect(urls.filter((u) => u.includes(".infura.io/v3/ik")), `infura on ${id}`).toHaveLength(1);
      expect(urls.length).toBeGreaterThanOrEqual(4);
    }
  });

  it("ignores blank keys", () => {
    expect(rpcUrlsFor(56, { NEXT_PUBLIC_ALCHEMY_API_KEY: "  " }).some((u) => u.includes("alchemy"))).toBe(false);
  });
});
