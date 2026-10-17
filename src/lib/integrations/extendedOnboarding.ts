/**
 * extendedOnboarding.ts — open (or recover) an Extended account from the
 * connected wallet, without copying any key from Extended's site.
 *
 * Same flow as Extended's own front-end and its python SDK
 * (`x10/signing/onboarding.py`, `clients/onboarding`):
 *   1. the wallet signs `AccountCreation` (EIP-712); the Stark trading key is
 *      derived from that signature, so the same wallet always gets the same
 *      key — the account Extended's site opens for this wallet is this one;
 *   2. the wallet signs `AccountRegistration` and POST /auth/onboard opens the
 *      account (an existing account is returned unchanged);
 *   3. the wallet signs `"/api/v1/user/account/api-key@<time>"` and Extended
 *      issues an API key for that account.
 * Checked end to end on Extended's testnet on 2026-10-16 (account opened,
 * onboarding repeated → same account, API key issued, limit order placed and
 * cancelled with the derived key). Key derivation matches the python SDK's
 * `generate_keypair_from_eth_signature` bit for bit (see the unit test).
 *
 * The Stark private key stays in the browser (localStorage, like the pasted
 * key before); it can trade and withdraw on Extended, never touch the wallet.
 */

import { l2KeyFromEthSignature } from "@blackcube/extended-sdk";
import { pedersen, sign as starkSign } from "@scure/starknet";
import { EXTENDED_HOSTS, extendedRelayBase, type ExtendedNetworkName } from "@/lib/integrations/extendedProxy";

/** EIP-712 domain name per network (python SDK `signing_domain`). */
export const EXTENDED_SIGNING_DOMAIN: Record<ExtendedNetworkName, string> = {
  mainnet: "extended.exchange",
  testnet: "starknet.sepolia.extended.exchange",
};

type Address = `0x${string}`;

const ACCOUNT_CREATION_TYPES = {
  AccountCreation: [
    { name: "accountIndex", type: "int8" },
    { name: "wallet", type: "address" },
    { name: "tosAccepted", type: "bool" },
  ],
} as const;

const ACCOUNT_REGISTRATION_TYPES = {
  AccountRegistration: [
    { name: "accountIndex", type: "int8" },
    { name: "wallet", type: "address" },
    { name: "tosAccepted", type: "bool" },
    { name: "time", type: "string" },
    { name: "action", type: "string" },
    { name: "host", type: "string" },
  ],
} as const;

/** UTC time to the second, as Extended signs it: "2026-10-16T12:00:00Z". */
export function extendedTimeString(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Typed data whose signature the Stark key is derived from (step 1). */
export function keyDerivationTypedData(wallet: Address, network: ExtendedNetworkName) {
  return {
    domain: { name: EXTENDED_SIGNING_DOMAIN[network] },
    types: ACCOUNT_CREATION_TYPES,
    primaryType: "AccountCreation" as const,
    message: { accountIndex: 0, wallet, tosAccepted: true },
  };
}

export interface AccountRegistration {
  accountIndex: number;
  wallet: Address;
  tosAccepted: boolean;
  time: string;
  action: "REGISTER";
  host: string;
}

/** The registration the wallet signs (step 2). `host` is Extended's real host, not the relay. */
export function accountRegistration(wallet: Address, network: ExtendedNetworkName, now: Date): AccountRegistration {
  return { accountIndex: 0, wallet, tosAccepted: true, time: extendedTimeString(now), action: "REGISTER", host: EXTENDED_HOSTS[network] };
}

export function registrationTypedData(reg: AccountRegistration, network: ExtendedNetworkName) {
  return {
    domain: { name: EXTENDED_SIGNING_DOMAIN[network] },
    types: ACCOUNT_REGISTRATION_TYPES,
    primaryType: "AccountRegistration" as const,
    message: reg,
  };
}

export interface StarkKeyPair {
  privateKey: `0x${string}`;
  publicKey: `0x${string}`;
}

function hex0x(v: string): `0x${string}` {
  return (v.startsWith("0x") ? v : `0x${v}`) as `0x${string}`;
}

export function starkKeyFromSignature(ethSignature: string): StarkKeyPair {
  const { privateKey, publicKey } = l2KeyFromEthSignature(ethSignature);
  return { privateKey: hex0x(privateKey), publicKey: hex0x(publicKey) };
}

/** Body of POST /auth/onboard: the L1 signature plus the Stark key signing pedersen(wallet, starkKey). */
export function onboardingPayload(reg: AccountRegistration, l1Signature: string, key: StarkKeyPair) {
  const sig = starkSign(pedersen(BigInt(reg.wallet), BigInt(key.publicKey)), key.privateKey.slice(2));
  return {
    l1Signature,
    l2Key: key.publicKey,
    l2Signature: { r: `0x${sig.r.toString(16)}`, s: `0x${sig.s.toString(16)}` },
    accountCreation: reg,
    referralCode: null,
  };
}

/** Message the wallet signs to authenticate a private onboarding call (python `sign_api_request`). */
export function apiRequestMessage(path: string, time: string): string {
  return `${path}@${time}`;
}

export interface ExtendedOnboardResult {
  apiKey: string;
  l2PrivateKey: `0x${string}`;
  vaultId: string;
  accountId: string;
}

export interface OnboardDeps {
  wallet: Address;
  network: ExtendedNetworkName;
  signTypedData: (data: ReturnType<typeof keyDerivationTypedData> | ReturnType<typeof registrationTypedData>) => Promise<string>;
  signMessage: (message: string) => Promise<string>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

async function readJson(res: Response): Promise<{ data?: unknown; error?: { message?: string } } | null> {
  const text = await res.text();
  try {
    return JSON.parse(text.replace(/("(?:id|accountId)"\s*:\s*)(\d{16,})/g, '$1"$2"'));
  } catch {
    return null;
  }
}

function fail(step: string, res: Response, body: { error?: { message?: string } } | null): never {
  throw new Error(`Extended ${step} failed (${res.status})${body?.error?.message ? `: ${body.error.message}` : ""}`);
}

/**
 * Run the three wallet signatures and return what trading needs. Throws with
 * the failing step named; nothing is stored here (the caller saves the signer).
 */
export async function onboardExtended(deps: OnboardDeps): Promise<ExtendedOnboardResult> {
  const f = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());
  const base = extendedRelayBase(deps.network);

  const key = starkKeyFromSignature(await deps.signTypedData(keyDerivationTypedData(deps.wallet, deps.network)));

  const reg = accountRegistration(deps.wallet, deps.network, now());
  const l1Signature = await deps.signTypedData(registrationTypedData(reg, deps.network));
  const onboardRes = await f(`${base}/auth/onboard`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(onboardingPayload(reg, l1Signature, key)),
  });
  const onboard = await readJson(onboardRes);
  if (!onboardRes.ok) fail("account opening", onboardRes, onboard);
  const account = (onboard?.data as { defaultAccount?: { id?: string | number; l2Vault?: string | number; l2Key?: string } } | undefined)?.defaultAccount;
  if (account?.id === undefined || account.l2Vault === undefined) throw new Error("Extended did not return the account it opened.");
  if (account.l2Key && BigInt(account.l2Key) !== BigInt(key.publicKey)) {
    throw new Error("Extended's account for this wallet uses a different trading key. Connect it with its API keys instead.");
  }

  const path = "/api/v1/user/account/api-key";
  const time = extendedTimeString(now());
  const reqSig = await deps.signMessage(apiRequestMessage(path, time));
  const keyRes = await f(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      L1_SIGNATURE: reqSig,
      L1_MESSAGE_TIME: time,
      "X-X10-ACTIVE-ACCOUNT": String(account.id),
    },
    body: JSON.stringify({ description: "Meridian" }),
  });
  const keyBody = await readJson(keyRes);
  if (!keyRes.ok) fail("API key", keyRes, keyBody);
  const apiKey = (keyBody?.data as { key?: string } | undefined)?.key;
  if (!apiKey) throw new Error("Extended did not return an API key.");

  // Orders sign with the decimal position id; read it from the account when onboarding returned something else.
  let vaultId = String(account.l2Vault).trim();
  if (!/^\d+$/.test(vaultId)) {
    const infoRes = await f(`${base}/api/v1/user/account/info`, { headers: { "x-api-key": apiKey } });
    const info = (await readJson(infoRes))?.data as { l2Vault?: unknown } | undefined;
    vaultId = info?.l2Vault === undefined ? "" : String(info.l2Vault).trim();
    if (!/^\d+$/.test(vaultId)) throw new Error("Extended did not return the account's position id.");
  }

  return { apiKey, l2PrivateKey: key.privateKey, vaultId, accountId: String(account.id) };
}
