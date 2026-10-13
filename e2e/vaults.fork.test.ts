/**
 * Verified ERC-4626 savings vaults on forks, executed end to end by the real
 * lib/orderRunner: each leg goes through resolveOrderForLeg (what a strategy
 * produces) → approve → deposit, and the wallet ends up holding vault shares.
 *
 *   - Base (ANVIL_URL): Fluid fUSDC, Spark Savings sUSDC
 *   - Arbitrum (ANVIL_ARB_URL): Fluid fUSDT
 *   - Ethereum (ANVIL_ETH_URL): Sky sUSDS, Ethena sUSDe
 *
 * Each block is skipped without its fork URL (CI starts all three).
 */
import { describe, expect, it } from "vitest";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  keccak256,
  pad,
  toHex,
  type Address,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum, base, mainnet } from "viem/chains";
import { ERC20_ABI } from "@/lib/onchain";
import { resolveOrderForLeg } from "@/lib/assetMap";
import type { Order } from "@/lib/execution";
import { findVault } from "@/lib/protocols/vaults";
import { executePreparedOrder, prepareOrder, type OrderRunnerClient, type OrderRunnerDeps, type WriteAsync } from "@/lib/orderRunner";

// anvil's well-known default account #0 (local test key, holds no real funds).
const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const PRICES = ["USDC", "USDT", "USDS", "USDE"].map((symbol) => ({ symbol, price: 1 }));

function withoutChainId(args: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...args };
  delete rest.chainId;
  return rest;
}

function forkKit(url: string, chain: Chain) {
  const transport = http(url);
  const publicClient = createPublicClient({ chain, transport });
  const testClient = createTestClient({ chain, mode: "anvil", transport });
  const walletClient = createWalletClient({ chain, transport, account });
  const balanceOf = (token: Address) =>
    publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });

  /** Fund the test account: anvil_dealERC20, else find the balance mapping slot (Solidity, then Vyper layout). */
  async function deal(token: Address, amount: bigint) {
    try {
      await testClient.request({ method: "anvil_dealERC20" as never, params: [token, account.address, toHex(amount)] as never });
      if ((await balanceOf(token)) === amount) return;
    } catch {
      /* fall through to slot search */
    }
    for (let slot = 0n; slot < 64n; slot++) {
      for (const key of [
        keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [account.address, slot])),
        keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "address" }], [slot, account.address])),
      ]) {
        const before = await publicClient.getStorageAt({ address: token, slot: key });
        await testClient.setStorageAt({ address: token, index: key, value: pad(toHex(amount)) });
        if ((await balanceOf(token)) === amount) return;
        await testClient.setStorageAt({ address: token, index: key, value: before ?? pad("0x0") });
      }
    }
    throw new Error(`could not fund ${token}`);
  }

  const deps = (): OrderRunnerDeps => ({
    address: account.address,
    connectedChainId: chain.id,
    client: publicClient as unknown as OrderRunnerClient,
    writeContract: ((args: Record<string, unknown>) => walletClient.writeContract(withoutChainId(args) as never)) as WriteAsync,
    sendTransaction: ((args: Record<string, unknown>) => walletClient.sendTransaction(withoutChainId(args) as never)) as WriteAsync,
  });

  /** Resolve a strategy leg exactly as the UI does, then approve + deposit through the order runner. */
  async function depositLeg(protocol: string, asset: string, chainName: string, usd: number) {
    const vault = findVault(protocol, asset, chain.id);
    if (!vault) throw new Error(`no vault for ${protocol} ${asset} on ${chainName}`);
    const order = resolveOrderForLeg({ side: "Supply", asset, protocol, chain: chainName, sizeUsd: usd }, undefined, PRICES, chain.id) as Order;
    expect(order).toMatchObject({ protocol: "vault", vaultAddress: vault.vault });
    await deal(vault.assetAddress, order.amount as bigint);

    const sharesBefore = await balanceOf(vault.vault);
    const prepared = await prepareOrder(deps(), order);
    if (!prepared.ok) throw new Error(`${protocol} prepare failed: ${prepared.state} — ${prepared.message}`);
    expect(prepared.built.address?.toLowerCase()).toBe(vault.vault.toLowerCase());
    const result = await executePreparedOrder(deps(), prepared);
    if (!result.ok) throw new Error(`${protocol} execute failed: ${result.state} — ${result.message}`);

    const shares = (await balanceOf(vault.vault)) - sharesBefore;
    console.info(`${protocol} ${vault.shareSymbol} on ${chainName}: deposited ${usd} ${vault.assetSymbol} → ${shares} share units (tx ${result.hash})`);
    expect(shares).toBeGreaterThan(0n);
    expect(await balanceOf(vault.assetAddress)).toBe(0n);
  }

  return { depositLeg };
}

const BASE_URL = process.env.ANVIL_URL;
const ARB_URL = process.env.ANVIL_ARB_URL;
const ETH_URL = process.env.ANVIL_ETH_URL;

describe.skipIf(!BASE_URL)("vaults on a Base fork", () => {
  const kit = BASE_URL ? forkKit(BASE_URL, base) : null;
  it("deposits USDC into Fluid fUSDC", () => kit!.depositLeg("Fluid", "USDC", "Base", 100), 120_000);
  it("deposits USDC into Spark Savings sUSDC", () => kit!.depositLeg("Spark Savings", "USDC", "Base", 100), 120_000);
});

describe.skipIf(!ARB_URL)("vaults on an Arbitrum fork", () => {
  const kit = ARB_URL ? forkKit(ARB_URL, arbitrum) : null;
  it("deposits USDT into Fluid fUSDT", () => kit!.depositLeg("Fluid", "USDT", "Arbitrum", 100), 120_000);
});

describe.skipIf(!ETH_URL)("vaults on an Ethereum fork", () => {
  const kit = ETH_URL ? forkKit(ETH_URL, mainnet) : null;
  it("deposits USDS into Sky sUSDS", () => kit!.depositLeg("Sky", "USDS", "Ethereum", 100), 120_000);
  it("deposits USDe into Ethena sUSDe", () => kit!.depositLeg("Ethena", "USDe", "Ethereum", 100), 120_000);
});
