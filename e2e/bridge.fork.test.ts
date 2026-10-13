/**
 * Second golden path on an Arbitrum fork: "bridge 5 USDC Arbitrum → Base".
 * Live deBridge + LI.FI quotes (lib/mcp/router.ts, same as /api/route-quote)
 * are turned into orders by the same builder the bridge button uses, then
 * executed by the real lib/orderRunner against the real USDC and router
 * contracts. Proves the source side — exact approval to the verified
 * entrypoint, quoted calldata accepted on-chain, funds leave the wallet.
 * Delivery on Base is the bridge's own off-chain fill and can't be shown on
 * a single-chain fork.
 *
 * Needs an anvil fork of Arbitrum at ANVIL_ARB_URL (CI starts one; locally:
 * `anvil --fork-url https://arb1.arbitrum.io/rpc --port 8546` then
 * `ANVIL_ARB_URL=http://127.0.0.1:8546 npm run test:fork`) and network access
 * to the deBridge / LI.FI APIs. Skipped without ANVIL_ARB_URL.
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
import { arbitrum, base } from "viem/chains";
import { ERC20_ABI, ERC20_ALLOWANCE_ABI } from "@/lib/onchain";
import { findToken } from "@/lib/assetMap";
import { bridgeOrderFromQuote } from "@/lib/bridgeOrder";
import { getBestRoute, isSignableQuote } from "@/lib/mcp/router";
import { executePreparedOrder, prepareOrder, type OrderRunnerClient, type OrderRunnerDeps, type WriteAsync } from "@/lib/orderRunner";

const ANVIL_ARB_URL = process.env.ANVIL_ARB_URL;
// anvil's well-known default account #0 (local test key, holds no real funds).
const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const AMOUNT = 5_000_000n; // 5 USDC (6 decimals)

function withoutChainId(args: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...args };
  delete rest.chainId;
  return rest;
}

describe.skipIf(!ANVIL_ARB_URL)("golden path on an Arbitrum fork — bridge 5 USDC to Base", () => {
  const transport = http(ANVIL_ARB_URL);
  const publicClient = createPublicClient({ chain: arbitrum, transport });
  const testClient = createTestClient({ chain: arbitrum, mode: "anvil", transport });
  const walletClient = createWalletClient({ chain: arbitrum, transport, account });
  const usdcArb = findToken("USDC", arbitrum.id)!;
  const usdcBase = findToken("USDC", base.id)!;

  const balanceOf = (who: Address) =>
    publicClient.readContract({ address: usdcArb.address as Address, abi: ERC20_ABI, functionName: "balanceOf", args: [who] });

  /** Give the test account USDC: anvil_dealERC20 when available, else write FiatToken's balance slot (9). */
  async function dealUsdc(to: Address, amount: bigint) {
    try {
      await testClient.request({ method: "anvil_dealERC20" as never, params: [usdcArb.address, to, toHex(amount)] as never });
    } catch {
      const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [to, 9n]));
      await testClient.setStorageAt({ address: usdcArb.address as Address, index: slot, value: pad(toHex(amount)) });
    }
    expect(await balanceOf(to)).toBe(amount);
  }

  const deps = (): OrderRunnerDeps => ({
    address: account.address,
    connectedChainId: arbitrum.id,
    client: publicClient as unknown as OrderRunnerClient,
    writeContract: ((args: Record<string, unknown>) => walletClient.writeContract(withoutChainId(args) as never)) as WriteAsync,
    sendTransaction: ((args: Record<string, unknown>) => walletClient.sendTransaction(withoutChainId(args) as never)) as WriteAsync,
  });

  it("executes every signable live quote: exact approval to the verified router, funds leave the wallet", async () => {
    const { best, alternatives } = await getBestRoute({
      fromChainId: arbitrum.id,
      toChainId: base.id,
      fromTokenAddress: usdcArb.address,
      toTokenAddress: usdcBase.address,
      fromAmount: AMOUNT.toString(),
      fromAddress: account.address,
    });
    const quotes = [best, ...alternatives].filter((q) => q !== null && isSignableQuote(q));
    expect(quotes.length, "no signable deBridge/LI.FI quote for Arbitrum → Base").toBeGreaterThan(0);

    for (const quote of quotes) {
      const snapshot = await testClient.snapshot();
      await dealUsdc(account.address, AMOUNT);
      const order = bridgeOrderFromQuote(quote!, { ...usdcArb, address: usdcArb.address as Address }, AMOUNT, arbitrum.id);

      const prepared = await prepareOrder(deps(), order);
      if (!prepared.ok) throw new Error(`${quote!.provider}: prepare failed: ${prepared.state} — ${prepared.message}`);
      expect(prepared.needsApproval).toBe(true);

      const result = await executePreparedOrder(deps(), prepared);
      if (!result.ok) throw new Error(`${quote!.provider}: execute failed: ${result.state} — ${result.message}`);

      expect(await balanceOf(account.address), `${quote!.provider}: USDC left in wallet`).toBe(0n);
      const allowanceLeft = await publicClient.readContract({
        address: usdcArb.address as Address,
        abi: ERC20_ALLOWANCE_ABI,
        functionName: "allowance",
        args: [account.address, quote!.tx.to as Address],
      });
      expect(allowanceLeft, `${quote!.provider}: allowance left`).toBe(0n);
      await testClient.revert({ id: snapshot });
    }
  }, 180_000);
});
