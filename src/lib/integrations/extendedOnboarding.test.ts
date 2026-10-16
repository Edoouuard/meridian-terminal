import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { getPublicKey, pedersen, Signature, verify } from "@scure/starknet";
import {
  accountRegistration,
  apiRequestMessage,
  extendedTimeString,
  keyDerivationTypedData,
  onboardExtended,
  onboardingPayload,
  registrationTypedData,
  starkKeyFromSignature,
} from "./extendedOnboarding";
import { extendedUpstreamUrl, forwardableExtendedHeaders } from "./extendedProxy";

// Reference values from Extended's python SDK 2.6.0 (x10/signing/onboarding.py +
// fast_stark_crypto.generate_keypair_from_eth_signature) for the wallet 0x11…11.
const PK = `0x${"11".repeat(32)}` as const;
const VECTORS = {
  mainnet: {
    starkPriv: "0x1dce08673c2727c826a05f44ddd2ae67e05569a4467fe0b2973d458b3772ae5",
    starkPub: "0x3caabae3dde17022b2a3ca0b76ee27e94a89c927becf6094847f1d96ff34eba",
    reg: "0x5606652431c819ef83034ecb0589128f5034a2e154c65ea4ce9a2177ee2fb22002f5ed0fabf0ba18bbb6ade9ce9eec5d7e271be05933e1567c75f1758b090b401c",
  },
  testnet: {
    starkPriv: "0x1ff5d1199c8543a1e9f7b29cf5a8e1360728227e89bcff71fc16ab77bc3664e",
    starkPub: "0xfd0dcdf142e21ec307ff99ac1f60e6fba6bbaec8bfd438c15f7414a6e3d0cd",
    reg: "0xa2234fb18fb7b72418b06fc878df8c6933e5bb0ac8908739a2a4b021cd05dc34519c1509c8268c66c1574181034f6a8aa73608bf0720036d9a9906fa259fc6231b",
  },
} as const;
const API_SIG = "0x7287dfdb77a862189ecab6d55f89ac19c849431317a7c5ab04db6c73c887d91a7d1bf5b5a9f3dbe73dd8c74ed3180005cdcbab93562ba9d97b7aa6356238541a1c";
const NOW = new Date("2026-10-16T12:00:00.123Z");

describe("Extended onboarding signatures match the official python SDK", () => {
  const wallet = privateKeyToAccount(PK);

  for (const network of ["mainnet", "testnet"] as const) {
    it(`${network}: Stark key derived from the AccountCreation signature`, async () => {
      const sig = await wallet.signTypedData(keyDerivationTypedData(wallet.address, network));
      const key = starkKeyFromSignature(sig);
      expect(BigInt(key.privateKey)).toBe(BigInt(VECTORS[network].starkPriv));
      expect(BigInt(key.publicKey)).toBe(BigInt(VECTORS[network].starkPub));
    });

    it(`${network}: AccountRegistration typed data`, async () => {
      const reg = accountRegistration(wallet.address, network, NOW);
      expect(reg.time).toBe("2026-10-16T12:00:00Z");
      expect(await wallet.signTypedData(registrationTypedData(reg, network))).toBe(VECTORS[network].reg);
    });
  }

  it("API-key request message", async () => {
    const msg = apiRequestMessage("/api/v1/user/account/api-key", extendedTimeString(NOW));
    expect(await wallet.signMessage({ message: msg })).toBe(API_SIG);
  });

  it("onboarding payload carries a valid Stark signature of pedersen(wallet, key)", () => {
    const reg = accountRegistration(wallet.address, "mainnet", NOW);
    const key = { privateKey: VECTORS.mainnet.starkPriv, publicKey: VECTORS.mainnet.starkPub } as const;
    const body = onboardingPayload(reg, "0xl1", key);
    expect(body.l2Key).toBe(key.publicKey);
    expect(body.accountCreation).toEqual(reg);
    const hash = pedersen(BigInt(wallet.address), BigInt(key.publicKey));
    const sig = new Signature(BigInt(body.l2Signature.r), BigInt(body.l2Signature.s));
    expect(verify(sig, hash, getPublicKey(key.privateKey.slice(2)))).toBe(true);
  });
});

describe("onboardExtended", () => {
  const wallet = privateKeyToAccount(PK);
  const deps = (responses: Array<[number, unknown]>, calls: Array<{ url: string; init?: RequestInit }>) => ({
    wallet: wallet.address,
    network: "testnet" as const,
    signTypedData: (d: Parameters<typeof wallet.signTypedData>[0]) => wallet.signTypedData(d),
    signMessage: (m: string) => wallet.signMessage({ message: m }),
    now: () => NOW,
    fetchImpl: (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const [status, body] = responses.shift()!;
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch,
  });

  it("opens the account then asks for an API key on that account, through the relay", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const out = await onboardExtended(
      deps(
        [
          [200, { data: { defaultAccount: { id: 3646, l2Vault: "500647", l2Key: VECTORS.testnet.starkPub } } }],
          [200, { status: "OK", data: { key: "k123" } }],
        ],
        calls,
      ) as never,
    );
    expect(out).toEqual({ apiKey: "k123", l2PrivateKey: VECTORS.testnet.starkPriv, vaultId: "500647", accountId: "3646" });
    expect(calls[0].url).toMatch(/\/api\/extended\/testnet\/auth\/onboard$/);
    expect(calls[1].url).toMatch(/\/api\/extended\/testnet\/api\/v1\/user\/account\/api-key$/);
    const h = calls[1].init!.headers as Record<string, string>;
    expect(h["X-X10-ACTIVE-ACCOUNT"]).toBe("3646");
    expect(h.L1_MESSAGE_TIME).toBe("2026-10-16T12:00:00Z");
    expect(h.L1_SIGNATURE).toBe(API_SIG);
  });

  it("refuses an existing account bound to another trading key", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    await expect(
      onboardExtended(deps([[200, { data: { defaultAccount: { id: 1, l2Vault: "2", l2Key: "0x1234" } } }]], calls) as never),
    ).rejects.toThrow(/different trading key/);
    expect(calls).toHaveLength(1);
  });

  it("names the failing step", async () => {
    await expect(
      onboardExtended(deps([[400, { error: { message: "Invalid signature" } }]], []) as never),
    ).rejects.toThrow("Extended account opening failed (400): Invalid signature");
  });
});

describe("Extended relay", () => {
  it("only maps the REST API and onboarding", () => {
    expect(extendedUpstreamUrl("mainnet", ["api", "v1", "user", "positions"], "?market=ETH-USD")).toBe(
      "https://api.starknet.extended.exchange/api/v1/user/positions?market=ETH-USD",
    );
    expect(extendedUpstreamUrl("testnet", ["auth", "onboard"])).toBe("https://api.starknet.sepolia.extended.exchange/auth/onboard");
    expect(extendedUpstreamUrl("devnet", ["api", "v1", "x"])).toBeNull();
    expect(extendedUpstreamUrl("mainnet", ["auth", "onboard", "subaccount"])).toBeNull();
    expect(extendedUpstreamUrl("mainnet", ["api", "v1", "..", "admin"])).toBeNull();
    expect(extendedUpstreamUrl("mainnet", ["internal"])).toBeNull();
  });

  it("forwards only Extended's headers and sets a User-Agent", () => {
    const h = forwardableExtendedHeaders(
      new Headers({ cookie: "meridian_beta=x", "x-api-key": "k", L1_SIGNATURE: "s", "X-X10-ACTIVE-ACCOUNT": "1", origin: "https://x" }),
    );
    expect(h.get("cookie")).toBeNull();
    expect(h.get("origin")).toBeNull();
    expect(h.get("x-api-key")).toBe("k");
    expect(h.get("l1_signature")).toBe("s");
    expect(h.get("x-x10-active-account")).toBe("1");
    expect(h.get("user-agent")).toBe("meridian-terminal");
  });
});
