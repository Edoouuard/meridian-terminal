/**
 * Fixed yield and restaking on an Ethereum fork, executed by the real
 * lib/orderRunner against the real contracts:
 *   - Pendle: live eligible markets (prime or major stable) + a live router
 *     quote from Pendle's API: USDC → PT on a stable market, WETH → PT-wstETH;
 *   - EigenLayer: ETH → stETH through Lido, then stETH restaked into
 *     EigenLayer's stETH strategy.
 *
 * Needs an anvil fork of Ethereum at ANVIL_ETH_URL (CI starts one; locally:
 * `anvil --fork-url https://ethereum-rpc.publicnode.com --port 8547` then
 * `ANVIL_ETH_URL=http://127.0.0.1:8547 npm run test:fork`) and network access
 * to Pendle's API. Skipped without ANVIL_ETH_URL.
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
import { mainnet } from "viem/chains";
import { ERC20_ABI } from "@/lib/onchain";
import { findToken, resolveOrderForLeg } from "@/lib/assetMap";
import type { Order } from "@/lib/execution";
import { PENDLE_ROUTER_V4, fetchPendleBuyQuote, fetchPendleMarkets, pickPendleMarket } from "@/lib/integrations/pendle";
import { EIGENLAYER_STAKER_SHARES_ABI, EIGENLAYER_STETH_STRATEGY, EIGENLAYER_STRATEGY_MANAGER } from "@/lib/integrations/eigenlayer";
import { executePreparedOrder, prepareOrder, type OrderRunnerClient, type OrderRunnerDeps, type WriteAsync } from "@/lib/orderRunner";

const ANVIL_ETH_URL = process.env.ANVIL_ETH_URL;
// anvil's well-known default account #0 (local test key, holds no real funds).
const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");

function withoutChainId(args: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...args };
  delete rest.chainId;
  return rest;
}

describe.skipIf(!ANVIL_ETH_URL)("Ethereum fork — Pendle PT and EigenLayer restaking", () => {
  const transport = http(ANVIL_ETH_URL);
  const publicClient = createPublicClient({ chain: mainnet, transport });
  const testClient = createTestClient({ chain: mainnet, mode: "anvil", transport });
  const walletClient = createWalletClient({ chain: mainnet, transport, account });

  const deps = (): OrderRunnerDeps => ({
    address: account.address,
    connectedChainId: mainnet.id,
    client: publicClient as unknown as OrderRunnerClient,
    writeContract: ((args: Record<string, unknown>) => walletClient.writeContract(withoutChainId(args) as never)) as WriteAsync,
    sendTransaction: ((args: Record<string, unknown>) => walletClient.sendTransaction(withoutChainId(args) as never)) as WriteAsync,
  });

  async function run(order: Order, label: string) {
    const prepared = await prepareOrder(deps(), order);
    if (!prepared.ok) throw new Error(`${label}: prepare failed: ${prepared.state} — ${prepared.message}`);
    const result = await executePreparedOrder(deps(), prepared);
    if (!result.ok) throw new Error(`${label}: execute failed: ${result.state} — ${result.message}`);
    console.info(`${label} → CONFIRMED (tx ${result.hash})`);
  }

  async function buyPt(spend: { address: string; symbol: string; decimals: number }, amount: bigint, kind: "USDC" | "ETH") {
    const markets = await fetchPendleMarkets(mainnet.id);
    console.info(`pendle: ${markets.length} eligible markets on Ethereum: ${markets.map((m) => `${m.name}${m.isPrime ? "*" : ""}${m.majorStable ? "$" : ""}`).join(", ")}`);
    expect(markets.every((m) => m.isPrime || m.majorStable)).toBe(true);
    const market = pickPendleMarket(markets, kind);
    expect(market, `no eligible Pendle ${kind} market on Ethereum`).toBeDefined();
    // Same order as PendleExecuteButton: approve the router first, then quote
    // and sign straight away — the route's aggregator leg expires quickly.
    const token = spend.address as Address;
    await run(
      { type: "approve", protocol: "pendle", token, symbol: spend.symbol, amount, chainId: mainnet.id, decimals: spend.decimals, spender: PENDLE_ROUTER_V4 },
      `pendle approve ${spend.symbol}`,
    );
    const quote = await fetchPendleBuyQuote({ chainId: mainnet.id, pt: market!.pt, tokenIn: token, amountIn: amount.toString(), receiver: account.address });
    expect(quote, `no Pendle quote for PT-${market!.name}`).not.toBeNull();
    await run(
      {
        type: "swap",
        protocol: "pendle",
        token,
        symbol: spend.symbol,
        amount,
        chainId: mainnet.id,
        decimals: spend.decimals,
        routerTx: { to: quote!.tx.to, data: quote!.tx.data, value: quote!.tx.value ? BigInt(quote!.tx.value) : undefined },
      },
      `pendle PT-${market!.name} (${market!.impliedApyPct.toFixed(2)}% fixed, ${market!.isPrime ? "prime" : "major stable"})`,
    );
    const pt = await publicClient.readContract({ address: market!.pt, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });
    expect(pt).toBeGreaterThan(0n);
    const left = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });
    expect(left).toBe(0n);
  }

  it("buys PT on the best live Pendle stablecoin market (prime or major stable) with USDC", async () => {
    const usdc = findToken("USDC", mainnet.id)!;
    const amount = 100_000_000n; // 100 USDC
    try {
      await testClient.request({ method: "anvil_dealERC20" as never, params: [usdc.address, account.address, toHex(amount)] as never });
    } catch {
      const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [account.address, 9n]));
      await testClient.setStorageAt({ address: usdc.address as Address, index: slot, value: pad(toHex(amount)) });
    }
    await buyPt(usdc, amount, "USDC");
  }, 180_000);

  it("buys PT on the best live Pendle ETH market with WETH", async () => {
    const weth = findToken("WETH", mainnet.id)!;
    const amount = 50_000_000_000_000_000n; // 0.05 WETH
    const wrap = await walletClient.sendTransaction({ to: weth.address as Address, value: amount }); // WETH9 fallback = deposit
    await publicClient.waitForTransactionReceipt({ hash: wrap });
    await buyPt(weth, amount, "ETH");
  }, 180_000);

  it("stakes ETH on Lido, then restakes the stETH into EigenLayer", async () => {
    const prices = [{ symbol: "ETH", price: 2500 }];
    const stake = resolveOrderForLeg({ side: "Stake", asset: "ETH", protocol: "Lido", sizeUsd: 2500 }, undefined, prices, 1) as Order;
    await run(stake, "lido stake 1 ETH");

    const restake = resolveOrderForLeg({ side: "Restake", asset: "stETH", protocol: "EigenLayer", sizeUsd: 1250 }, undefined, prices, 1) as Order;
    expect(restake).toMatchObject({ protocol: "eigenlayer", type: "stake" });
    await run(restake, "eigenlayer restake 0.5 stETH");

    const shares = await publicClient.readContract({
      address: EIGENLAYER_STRATEGY_MANAGER,
      abi: EIGENLAYER_STAKER_SHARES_ABI,
      functionName: "stakerDepositShares",
      args: [account.address, EIGENLAYER_STETH_STRATEGY],
    });
    expect(shares).toBeGreaterThan(0n);
  }, 180_000);
});
