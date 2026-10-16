/**
 * Liquid restaking tokens bought the way the app buys them: WETH → token on
 * Uniswap v3 through lib/orderRunner, best fee tier from QuoterV2, same
 * slippage floor as SwapExecuteButton.
 *   - Base fork: Renzo ezETH, Kelp wrsETH, ether.fi weETH;
 *   - Arbitrum fork: Kelp rsETH.
 * Needs anvil forks at ANVIL_URL (Base) and ANVIL_ARB_URL (Arbitrum); skipped without them.
 */
import { describe, expect, it } from "vitest";
import { createPublicClient, createWalletClient, http, parseEther, type Address, type Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum, base } from "viem/chains";
import { ERC20_ABI } from "@/lib/onchain";
import { findToken } from "@/lib/assetMap";
import { QUOTER_V2_QUOTE_READ_ABI, QUOTE_FEE_TIERS, UNISWAP_QUOTER_V2_BY_CHAIN, applySlippage, pickBestFeeQuote } from "@/lib/integrations/uniswap";
import type { Order } from "@/lib/execution";
import { executePreparedOrder, prepareOrder, type OrderRunnerClient, type OrderRunnerDeps, type WriteAsync } from "@/lib/orderRunner";

// anvil's default account #3 (local test key, no real funds): its own nonces, apart from the other fork tests.
const account = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
const WETH_DEPOSIT_ABI = [{ type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] }] as const;

function withoutChainId(args: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...args };
  delete rest.chainId;
  return rest;
}

function kit(url: string, chain: Chain) {
  const transport = http(url);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ chain, transport, account });
  const deps = (): OrderRunnerDeps => ({
    address: account.address,
    connectedChainId: chain.id,
    client: publicClient as unknown as OrderRunnerClient,
    writeContract: ((args: Record<string, unknown>) => walletClient.writeContract(withoutChainId(args) as never)) as WriteAsync,
    sendTransaction: ((args: Record<string, unknown>) => walletClient.sendTransaction(withoutChainId(args) as never)) as WriteAsync,
  });
  const balanceOf = (token: string) => publicClient.readContract({ address: token as Address, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });

  /** Wrap 0.1 ETH and swap it for `symbol`, exactly as a "Swap WETH → symbol" leg does. */
  async function buy(symbol: string) {
    const weth = findToken("WETH", chain.id)!;
    const out = findToken(symbol, chain.id);
    expect(out, `${symbol} isn't tracked on ${chain.name}`).toBeTruthy();
    const amount = parseEther("0.1");
    const hash = await walletClient.writeContract({ address: weth.address as Address, abi: WETH_DEPOSIT_ABI, functionName: "deposit", value: amount });
    await publicClient.waitForTransactionReceipt({ hash });

    const quotes = await Promise.all(
      QUOTE_FEE_TIERS.map(async (fee) => {
        try {
          const { result } = await publicClient.simulateContract({
            address: UNISWAP_QUOTER_V2_BY_CHAIN[chain.id],
            abi: QUOTER_V2_QUOTE_READ_ABI,
            functionName: "quoteExactInputSingle",
            args: [{ tokenIn: weth.address as Address, tokenOut: out!.address as Address, amountIn: amount, fee, sqrtPriceLimitX96: 0n }],
          });
          return { fee, amountOut: result[0] as bigint };
        } catch {
          return { fee, amountOut: undefined };
        }
      }),
    );
    const best = pickBestFeeQuote(quotes);
    expect(best, `no Uniswap WETH → ${symbol} pool on ${chain.name}`).not.toBeNull();
    // A deep pool: 0.1 WETH buys at least 0.088 of a token worth 1.0-1.12 ETH.
    expect(best!.amountOut).toBeGreaterThan(parseEther("0.088"));

    const before = await balanceOf(out!.address);
    const order: Order = {
      type: "swap",
      protocol: "uniswap",
      token: weth.address,
      tokenOut: out!.address,
      fee: best!.fee,
      amount,
      amountOutMinimum: applySlippage(best!.amountOut),
      chainId: chain.id,
      decimals: 18,
      symbol: "WETH",
    };
    const prepared = await prepareOrder(deps(), order);
    if (!prepared.ok) throw new Error(`prepare WETH → ${symbol}: ${prepared.state} — ${prepared.message}`);
    const result = await executePreparedOrder(deps(), prepared);
    if (!result.ok) throw new Error(`execute WETH → ${symbol}: ${result.state} — ${result.message}`);
    const got = (await balanceOf(out!.address)) - before;
    expect(got).toBeGreaterThanOrEqual(applySlippage(best!.amountOut));
    console.info(`uniswap WETH → ${symbol} on ${chain.name} (fee ${best!.fee}) → ${Number(got) / 1e18}`);
  }

  return { buy };
}

const BASE_URL = process.env.ANVIL_URL;
const ARB_URL = process.env.ANVIL_ARB_URL;

describe.skipIf(!BASE_URL)("liquid restaking on a Base fork", () => {
  const k = BASE_URL ? kit(BASE_URL, base) : null;
  it("buys Renzo ezETH with WETH on Uniswap", () => k!.buy("ezETH"), 120_000);
  it("buys Kelp rsETH (wrsETH on Base) with WETH on Uniswap", () => k!.buy("rsETH"), 120_000);
  it("buys ether.fi weETH with WETH on Uniswap", () => k!.buy("weETH"), 120_000);
});

describe.skipIf(!ARB_URL)("liquid restaking on an Arbitrum fork", () => {
  const k = ARB_URL ? kit(ARB_URL, arbitrum) : null;
  it("buys Kelp rsETH with WETH on Uniswap", () => k!.buy("rsETH"), 120_000);
});
