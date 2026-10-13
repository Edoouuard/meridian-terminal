import type { Address } from "viem";
import type { Order } from "@/lib/execution";
import type { RouteQuote } from "@/lib/mcp/router";

/**
 * Turn a router quote (deBridge or LI.FI, see lib/mcp/router.ts) into the
 * Order the validated execution path signs. The quote's `to` is re-checked
 * against routerAllowlist.ts when the order is built (execution.ts), and the
 * approval goes to that same verified entrypoint (assetMap.approveOrderFor).
 */
export function bridgeOrderFromQuote(
  quote: RouteQuote,
  fromToken: { address: Address; symbol: string; decimals: number },
  amountBase: bigint,
  fromChainId: number,
): Order {
  return {
    type: "swap",
    protocol: quote.provider,
    token: fromToken.address,
    symbol: fromToken.symbol,
    amount: amountBase,
    chainId: fromChainId,
    decimals: fromToken.decimals,
    routerTx: {
      to: quote.tx.to as Address,
      data: quote.tx.data as `0x${string}`,
      value: quote.tx.value !== undefined ? BigInt(quote.tx.value) : undefined,
    },
  };
}
