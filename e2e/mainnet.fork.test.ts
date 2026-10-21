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
import { EIGENLAYER_SHARES_TO_UNDERLYING_ABI, EIGENLAYER_STAKER_SHARES_ABI, EIGENLAYER_STETH_STRATEGY, EIGENLAYER_STRATEGY_MANAGER } from "@/lib/integrations/eigenlayer";
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

  /**
   * Live Pendle routes go through an aggregator leg quoted against the live
   * chain, while the fork sits a few blocks behind it: a route can revert on
   * the fork for reasons that have nothing to do with Meridian (a moved pool,
   * an expired RFQ quote). So a revert is retried with a fresh quote and a
   * wider slippage, then on the next eligible market of the same kind. A run
   * still fails if no market can be bought at all.
   */
  const SLIPPAGES = [0.005, 0.01, 0.02];
  const MAX_MARKETS = 3;

  async function buyPt(spend: { address: string; symbol: string; decimals: number }, amount: bigint, kind: "USDC" | "ETH") {
    const markets = await fetchPendleMarkets(mainnet.id);
    console.info(`pendle: ${markets.length} eligible markets on Ethereum: ${markets.map((m) => `${m.name}${m.isPrime ? "*" : ""}${m.majorStable ? "$" : ""}`).join(", ")}`);
    expect(markets.every((m) => m.isPrime || m.majorStable)).toBe(true);
    const candidates: NonNullable<ReturnType<typeof pickPendleMarket>>[] = [];
    let rest = markets;
    while (candidates.length < MAX_MARKETS) {
      const next = pickPendleMarket(rest, kind);
      if (!next) break;
      candidates.push(next);
      rest = rest.filter((m) => m !== next);
    }
    expect(candidates.length, `no eligible Pendle ${kind} market on Ethereum`).toBeGreaterThan(0);
    // Same order as PendleExecuteButton: approve the router first, then quote
    // and sign straight away — the route's aggregator leg expires quickly.
    const token = spend.address as Address;
    await run(
      { type: "approve", protocol: "pendle", token, symbol: spend.symbol, amount, chainId: mainnet.id, decimals: spend.decimals, spender: PENDLE_ROUTER_V4 },
      `pendle approve ${spend.symbol}`,
    );

    const failures: string[] = [];
    for (const market of candidates) {
      for (const slippage of SLIPPAGES) {
        const quote = await fetchPendleBuyQuote({ chainId: mainnet.id, pt: market.pt, tokenIn: token, amountIn: amount.toString(), receiver: account.address, slippage });
        if (!quote) {
          failures.push(`PT-${market.name} @${slippage * 100}%: no quote`);
          continue;
        }
        try {
          await run(
            {
              type: "swap",
              protocol: "pendle",
              token,
              symbol: spend.symbol,
              amount,
              chainId: mainnet.id,
              decimals: spend.decimals,
              routerTx: { to: quote.tx.to, data: quote.tx.data, value: quote.tx.value ? BigInt(quote.tx.value) : undefined },
            },
            `pendle PT-${market.name} (${market.impliedApyPct.toFixed(2)}% fixed, ${market.isPrime ? "prime" : "major stable"}, slippage ${slippage * 100}%)`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          failures.push(`PT-${market.name} @${slippage * 100}%: ${msg.slice(0, 160)}`);
          console.warn(`pendle retry: ${failures[failures.length - 1]}`);
          continue;
        }
        const pt = await publicClient.readContract({ address: market.pt, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });
        expect(pt).toBeGreaterThan(0n);
        const left = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });
        expect(left).toBe(0n);
        return;
      }
    }
    throw new Error(`no Pendle ${kind} market could be bought on the fork:\n${failures.join("\n")}`);
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

  it("supplies USDC to SparkLend through a planned Spark leg", async () => {
    const usdc = findToken("USDC", mainnet.id)!;
    const amount = 100_000_000n; // 100 USDC
    try {
      await testClient.request({ method: "anvil_dealERC20" as never, params: [usdc.address, account.address, toHex(amount)] as never });
    } catch {
      const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [account.address, 9n]));
      await testClient.setStorageAt({ address: usdc.address as Address, index: slot, value: pad(toHex(amount)) });
    }
    const order = resolveOrderForLeg({ side: "Supply", asset: "USDC", protocol: "Spark", sizeUsd: 100 }, undefined, [{ symbol: "USDC", price: 1 }], 1) as Order;
    expect(order).toMatchObject({ protocol: "spark", type: "supply" });
    await run(order, "spark supply 100 USDC");
    const left = await publicClient.readContract({ address: usdc.address as Address, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });
    expect(left).toBe(0n);
  }, 120_000);

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
    // The portfolio values them with the strategy's own conversion: ~0.5 stETH back.
    const underlying = await publicClient.readContract({ address: EIGENLAYER_STETH_STRATEGY, abi: EIGENLAYER_SHARES_TO_UNDERLYING_ABI, functionName: "sharesToUnderlyingView", args: [shares] });
    expect(Number(underlying) / 1e18).toBeGreaterThan(0.49);
    expect(Number(underlying) / 1e18).toBeLessThan(0.51);
  }, 180_000);
});
