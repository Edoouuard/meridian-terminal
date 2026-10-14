/**
 * The spot-only beta-neutral ETH carry on a Base fork, leg by leg, executed by
 * the real lib/orderRunner against the real Aave Pool and Uniswap contracts:
 *   1. supply USDC on Aave;
 *   2. borrow WETH on Aave (the short ETH side);
 *   3. swap the WETH to wstETH on Uniswap v3 (the long ETH side), with the
 *      same QuoterV2 quote + slippage floor SwapExecuteButton uses;
 *   4. supply the wstETH on Aave as extra collateral.
 * Then the account holds a WETH debt and a wstETH collateral of about the same
 * value, with a health factor far from 1 (see lib/neutralCarry.ts).
 *
 * Needs an anvil fork of Base at ANVIL_URL (CI starts one). Skipped without it.
 */
import { describe, expect, it } from "vitest";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  formatUnits,
  http,
  keccak256,
  pad,
  parseUnits,
  toHex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { AAVE_POOL_ABI, AAVE_V3_POOL_BY_CHAIN, ERC20_ABI } from "@/lib/onchain";
import { findToken } from "@/lib/assetMap";
import { QUOTER_V2_QUOTE_READ_ABI, QUOTE_FEE_TIERS, UNISWAP_QUOTER_V2_BY_CHAIN, applySlippage, pickBestFeeQuote } from "@/lib/integrations/uniswap";
import { executePreparedOrder, prepareOrder, type OrderRunnerClient, type OrderRunnerDeps, type WriteAsync } from "@/lib/orderRunner";
import type { Order } from "@/lib/execution";

const ANVIL_URL = process.env.ANVIL_URL;
// anvil's well-known default account #2 (local test key, holds no real funds). Its own
// account so its nonces never race the other Base fork tests running in parallel.
const account = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");

function withoutChainId(args: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...args };
  delete rest.chainId;
  return rest;
}

describe.skipIf(!ANVIL_URL)("Base fork — beta-neutral ETH carry (Aave + Uniswap, no perp)", () => {
  const transport = http(ANVIL_URL);
  const publicClient = createPublicClient({ chain: base, transport });
  const testClient = createTestClient({ chain: base, mode: "anvil", transport });
  const walletClient = createWalletClient({ chain: base, transport, account });
  const usdc = findToken("USDC", base.id)!;
  const weth = findToken("WETH", base.id)!;
  const wsteth = findToken("wstETH", base.id)!;
  const pool = AAVE_V3_POOL_BY_CHAIN[base.id];

  const deps = (): OrderRunnerDeps => ({
    address: account.address,
    connectedChainId: base.id,
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

  const balanceOf = (token: string) =>
    publicClient.readContract({ address: token as Address, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });

  it("supplies USDC, borrows WETH, swaps it to wstETH and supplies that: ETH-neutral, health factor far from 1", async () => {
    const usdcAmount = 2_000_000_000n; // 2,000 USDC
    try {
      await testClient.request({ method: "anvil_dealERC20" as never, params: [usdc.address, account.address, toHex(usdcAmount)] as never });
    } catch {
      const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [account.address, 9n]));
      await testClient.setStorageAt({ address: usdc.address as Address, index: slot, value: pad(toHex(usdcAmount)) });
    }
    expect(await balanceOf(usdc.address)).toBe(usdcAmount);

    // 1. Collateral.
    await run({ type: "supply", protocol: "aave", token: usdc.address, symbol: "USDC", amount: "2000", chainId: base.id, decimals: 6 }, "aave supply 2,000 USDC");

    // 2. Short ETH: 0.15 WETH is well under 45% of $2,000 at any recent ETH price.
    await run({ type: "borrow", protocol: "aave", token: weth.address, symbol: "WETH", amount: "0.15", chainId: base.id, decimals: 18 }, "aave borrow 0.15 WETH");
    const borrowed = await balanceOf(weth.address);
    expect(borrowed).toBe(parseUnits("0.15", 18));

    // 3. Long ETH: WETH → wstETH on Uniswap, best fee tier, same slippage floor as the app.
    const quoter = UNISWAP_QUOTER_V2_BY_CHAIN[base.id];
    const quotes = await Promise.all(
      QUOTE_FEE_TIERS.map(async (fee) => {
        try {
          const { result } = await publicClient.simulateContract({
            address: quoter,
            abi: QUOTER_V2_QUOTE_READ_ABI,
            functionName: "quoteExactInputSingle",
            args: [{ tokenIn: weth.address as Address, tokenOut: wsteth.address as Address, amountIn: borrowed, fee, sqrtPriceLimitX96: 0n }],
          });
          return { fee, amountOut: result[0] as bigint };
        } catch {
          return { fee, amountOut: undefined };
        }
      }),
    );
    const best = pickBestFeeQuote(quotes);
    expect(best, "no Uniswap WETH → wstETH pool quotes on Base").not.toBeNull();
    await run(
      {
        type: "swap",
        protocol: "uniswap",
        token: weth.address,
        tokenOut: wsteth.address,
        fee: best!.fee,
        amount: borrowed,
        amountOutMinimum: applySlippage(best!.amountOut),
        chainId: base.id,
        decimals: 18,
        symbol: "WETH",
      },
      `uniswap WETH → wstETH (fee ${best!.fee})`,
    );
    const held = await balanceOf(wsteth.address);
    expect(held).toBeGreaterThanOrEqual(applySlippage(best!.amountOut));
    expect(await balanceOf(weth.address)).toBe(0n);

    // 4. The wstETH joins the collateral.
    await run(
      { type: "supply", protocol: "aave", token: wsteth.address, symbol: "wstETH", amount: formatUnits(held, 18), chainId: base.id, decimals: 18 },
      "aave supply wstETH",
    );
    expect(await balanceOf(wsteth.address)).toBe(0n);

    const [collateral, debt, , , , healthFactor] = await publicClient.readContract({
      address: pool,
      abi: AAVE_POOL_ABI,
      functionName: "getUserAccountData",
      args: [account.address],
    });
    // Aave reports USD with 8 decimals and the health factor with 18.
    const debtUsd = Number(debt) / 1e8;
    const ethCollateralUsd = Number(collateral) / 1e8 - 2000;
    console.info(`carry: debt $${debtUsd.toFixed(2)} WETH vs ~$${ethCollateralUsd.toFixed(2)} wstETH, HF ${(Number(healthFactor) / 1e18).toFixed(2)}`);
    expect(debt).toBeGreaterThan(0n);
    // Long and short sides within 5% of each other: the position is ETH-neutral.
    expect(Math.abs(ethCollateralUsd - debtUsd) / debtUsd).toBeLessThan(0.05);
    expect(healthFactor).toBeGreaterThan(2n * 10n ** 18n);
  }, 180_000);
});
