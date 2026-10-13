/**
 * Golden path on a Base fork: "supply 100 USDC to Aave on Base", executed by
 * the real lib/orderRunner against the real Aave Pool and USDC contracts.
 *
 * Needs an anvil fork of Base at ANVIL_URL (CI starts one; locally:
 * `anvil --fork-url https://mainnet.base.org` then
 * `ANVIL_URL=http://127.0.0.1:8545 npm run test:fork`). Skipped without it.
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
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { AAVE_POOL_ABI, AAVE_V3_POOL_BY_CHAIN, ERC20_ABI, ERC20_ALLOWANCE_ABI } from "@/lib/onchain";
import { findToken } from "@/lib/assetMap";
import { executePreparedOrder, prepareOrder, type OrderRunnerClient, type OrderRunnerDeps, type WriteAsync } from "@/lib/orderRunner";
import type { Order } from "@/lib/execution";

const ANVIL_URL = process.env.ANVIL_URL;
// anvil's well-known default account #0 (local test key, holds no real funds).
const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const AMOUNT = 100_000_000n; // 100 USDC (6 decimals)

function withoutChainId(args: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...args };
  delete rest.chainId;
  return rest;
}

describe.skipIf(!ANVIL_URL)("golden path on a Base fork — Aave v3 USDC supply", () => {
  const transport = http(ANVIL_URL);
  const publicClient = createPublicClient({ chain: base, transport });
  const testClient = createTestClient({ chain: base, mode: "anvil", transport });
  const walletClient = createWalletClient({ chain: base, transport, account });
  const usdc = findToken("USDC", base.id)!.address as Address;
  const pool = AAVE_V3_POOL_BY_CHAIN[base.id];

  /** Give the test account USDC: anvil_dealERC20 when available, else write FiatToken's balance slot (9). */
  async function dealUsdc(to: Address, amount: bigint) {
    try {
      await testClient.request({ method: "anvil_dealERC20" as never, params: [usdc, to, toHex(amount)] as never });
    } catch {
      const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [to, 9n]));
      await testClient.setStorageAt({ address: usdc, index: slot, value: pad(toHex(amount)) });
    }
    const balance = await publicClient.readContract({ address: usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [to] });
    expect(balance).toBe(amount);
  }

  const deps = (): OrderRunnerDeps => ({
    address: account.address,
    connectedChainId: base.id,
    client: publicClient as unknown as OrderRunnerClient,
    // wagmi-style args carry chainId; the viem wallet client is already bound to Base.
    writeContract: ((args: Record<string, unknown>) => walletClient.writeContract(withoutChainId(args) as never)) as WriteAsync,
    sendTransaction: ((args: Record<string, unknown>) => walletClient.sendTransaction(withoutChainId(args) as never)) as WriteAsync,
  });

  it("approves exactly the amount, supplies, and the position appears on Aave", async () => {
    await dealUsdc(account.address, AMOUNT);
    const order: Order = { type: "supply", protocol: "aave", token: usdc, symbol: "USDC", amount: "100", chainId: base.id, decimals: 6 };

    const prepared = await prepareOrder(deps(), order);
    if (!prepared.ok) throw new Error(`prepare failed: ${prepared.state} — ${prepared.message}`);
    expect(prepared.needsApproval).toBe(true);
    expect(prepared.built.address?.toLowerCase()).toBe(pool.toLowerCase());

    const result = await executePreparedOrder(deps(), prepared);
    if (!result.ok) throw new Error(`execute failed: ${result.state} — ${result.message}`);
    expect(result.approvalHash).toBeDefined();

    const usdcLeft = await publicClient.readContract({ address: usdc, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });
    expect(usdcLeft).toBe(0n);
    const allowanceLeft = await publicClient.readContract({
      address: usdc,
      abi: ERC20_ALLOWANCE_ABI,
      functionName: "allowance",
      args: [account.address, pool],
    });
    expect(allowanceLeft).toBe(0n); // exact approval, fully consumed
    const [totalCollateralBase] = await publicClient.readContract({
      address: pool,
      abi: AAVE_POOL_ABI,
      functionName: "getUserAccountData",
      args: [account.address],
    });
    expect(totalCollateralBase).toBeGreaterThan(90n * 10n ** 8n); // ≈ $100 in Aave's 8-decimal USD base
  }, 120_000);

  it("refuses before signing when the wallet doesn't hold the amount", async () => {
    const order: Order = { type: "supply", protocol: "aave", token: usdc, symbol: "USDC", amount: "1000000", chainId: base.id, decimals: 6 };
    const prepared = await prepareOrder(deps(), order);
    expect(prepared).toMatchObject({ ok: false, state: "INSUFFICIENT_BALANCE" });
  });
});
