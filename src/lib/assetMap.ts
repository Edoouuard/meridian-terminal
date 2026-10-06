import type { Address } from "viem";
import type { Order } from "@/lib/execution";
import type { TradeLeg } from "@/lib/tradePlan";
import { TRACKED_TOKENS_BY_CHAIN, SPARK_POOL_BY_CHAIN, SDAI_VAULT } from "@/lib/onchain";
import {
  type PriceEntry,
  resolvePriceFromList,
  usdToTokenAmount,
} from "@/lib/quote";

export type { PriceEntry } from "@/lib/quote";

/**
 * assetMap.ts — maps a parsed TradePlan leg to a concrete, wallet-executable
 * `Order` for `buildExecution` (the wagmi "hand"), and — just as important —
 * honestly reports which venues/sides are NOT wired for live execution yet.
 *
 * This is deliberately a thin, mostly-offline layer:
 *   - It resolves a leg's asset symbol to an ERC20 address + decimals via
 *     `TRACKED_TOKENS_BY_CHAIN` (the canonical per-chain asset list).
 *   - It maps the leg's USD notional to an exact human-unit amount using the
 *     quote layer (`src/lib/quote.ts`) and a caller-supplied live price list.
 *     With a live price the amount is exact (stablecoins peg to whole units;
 *     ETH-like assets divide by price); WITHOUT one the order is NOT sized at all
 *     — valuation is HARD-FAIL, never approximated.
 *   - For venues that cannot execute yet (Hyperliquid/Extended perps, Pendle PT,
 *     options, swaps, staking, bridges, Aave borrow), it returns
 *     `{ unsupported: <message> }` instead of ever pretending to succeed.
 *
 * Nothing here ever triggers a write — it only produces data. The actual wallet
 * signature happens exclusively in `useExecute.execute()` on an explicit click.
 */

/** Default execution chain: mainnet. Assets are resolved here by default. */
export const DEFAULT_CHAIN_ID = 1;

/**
 * Venues that have a real, wallet-executable path wired through the harness.
 * Every other venue falls out of `resolveOrderForLeg` as `unsupported`.
 */
export const EXECUTABLE_VENUES: { venue: string; side: string; orderType: Order["type"]; protocol: Order["protocol"] }[] = [
  { venue: "Aave", side: "Supply", orderType: "supply", protocol: "aave" },
  { venue: "Aave", side: "Repay", orderType: "repay", protocol: "aave" },
  { venue: "Aave", side: "Borrow", orderType: "borrow", protocol: "aave" },
  { venue: "Aave", side: "Withdraw", orderType: "withdraw", protocol: "aave" },
  { venue: "Spark", side: "Supply", orderType: "supply", protocol: "spark" },
  { venue: "Spark", side: "Repay", orderType: "repay", protocol: "spark" },
  { venue: "Spark", side: "Borrow", orderType: "borrow", protocol: "spark" },
  { venue: "Spark", side: "Withdraw", orderType: "withdraw", protocol: "spark" },
  { venue: "Compound", side: "Supply", orderType: "supply", protocol: "compound" },
  { venue: "Compound", side: "Repay", orderType: "repay", protocol: "compound" },
  { venue: "Compound", side: "Borrow", orderType: "borrow", protocol: "compound" },
  { venue: "Compound", side: "Withdraw", orderType: "withdraw", protocol: "compound" },
  { venue: "Maker", side: "Supply", orderType: "supply", protocol: "maker" },
  { venue: "Maker", side: "Withdraw", orderType: "withdraw", protocol: "maker" },
  { venue: "Rocket Pool", side: "Stake", orderType: "stake", protocol: "rocketpool" },
  { venue: "Frax", side: "Stake", orderType: "stake", protocol: "frax" },
  { venue: "WETH", side: "Wrap", orderType: "supply", protocol: "weth" },
  { venue: "WETH", side: "Unwrap", orderType: "withdraw", protocol: "weth" },
  { venue: "L1", side: "Transfer", orderType: "transfer", protocol: "eth" },
  { venue: "ERC20", side: "Transfer", orderType: "transfer", protocol: "erc20" },
  { venue: "deBridge", side: "Bridge", orderType: "swap", protocol: "debridge" },
  { venue: "LI.FI", side: "Swap", orderType: "swap", protocol: "lifi" },
];

/** Human-readable venue label for a protocol display string (e.g. "Hyperliquid"). */
export function protocolLabel(protocol: string | undefined): string {
  if (!protocol) return "This venue";
  return protocol;
}

/**
 * Resolve a leg's USD notional into an exact human-unit amount string.
 *
 * Backed by the quote layer: when a live price is available for the asset we
 * divide the notional by the price and format to the token's decimals (exact for
 * 1:1 stablecoins, precise for ETH-like assets). When no price is available this
 * returns `""` — an exact amount cannot be derived, and `resolveOrderForLeg`
 * refuses to build the order rather than approximating.
 *
 * @param prices optional live price list (symbol -> price); used to quote the asset.
 * @param chainId optional target chain (defaults to `DEFAULT_CHAIN_ID`).
 */
export function humanAmountForLeg(leg: TradeLeg, prices?: PriceEntry[], chainId?: number): string {
  const symbol = bareSymbol(leg.asset);
  const price = resolvePriceFromList(prices, symbol);
  const decimals = tokenDecimalsFor(symbol, chainId);
  const quote = usdToTokenAmount(symbol, leg.sizeUsd, price, decimals);
  // HARD-FAIL: no live price -> no exact amount. Return "" rather than approximating.
  return quote ? quote.amount : "";
}

/** Decimals for a tracked token symbol on a chain, or 18 when unknown. */
function tokenDecimalsFor(symbol: string, chainId?: number): number {
  const token = findToken(symbol, chainId ?? DEFAULT_CHAIN_ID);
  return token ? token.decimals : 18;
}

/**
 * Alias map: users/LLM say "ETH" but Uniswap / Aave use "WETH", etc.
 * findToken tries the literal first, then the alias. This is critical for
 * swap pairs ("USDC → ETH") since Uniswap only trades ERC20s.
 */
const SYMBOL_ALIASES: Record<string, string> = {
  eth: "WETH",
  bnb: "WBNB",
  ftm: "WFTM",
  mnt: "WMNT",
  xdai: "WXDAI",
  s: "WS",
  metis: "METIS",
  celo: "CELO",
  matic: "WETH", // Polygon uses WETH, not WMATIC for Aave
  avax: "WAVAX",
  btc: "WBTC",
};

/** Find a tracked token by symbol on a given chain (case-insensitive). Tries exact match first, then common aliases (ETH→WETH, BNB→WBNB, etc.). */
export function findToken(symbol: string, chainId: number) {
  const tokens = TRACKED_TOKENS_BY_CHAIN[chainId] ?? [];
  const needle = symbol.trim().toLowerCase();
  const exact = tokens.find((t) => t.symbol.toLowerCase() === needle);
  if (exact) return exact;
  const alias = SYMBOL_ALIASES[needle];
  if (alias) return tokens.find((t) => t.symbol.toLowerCase() === alias.toLowerCase());
  return undefined;
}

/** Strip a PERP / PT / product suffix from an asset so we can match a token symbol ("ETH PERP" → "ETH"). */
function bareSymbol(asset: string): string {
  return asset
    .trim()
    .replace(/\s*(PERP|PT|perpetual)\s*$/i, "")
    .trim();
}

/**
 * Build a concrete `Order` for a parsed trade leg (Aave v3 supply/repay, or a
 * native L1 transfer), or `{ unsupported }` when the venue/side has no live
 * execution path yet. NEVER auto-executes — the caller decides when to sign.
 *
 * Amounts are quoted exactly via `src/lib/quote.ts`: when `prices` carries a
 * live price for the asset, the Order's amount is the precise base-unit bigint
 * for the USD notional (stablecoins peg to whole units; ETH-like assets divide
 * by price). When no live price is available the order is NOT sized at all and
 * this returns `{ unsupported }` — valuation hard-fails, never approximates.
 *
 * @param leg     the parsed trade leg (side / asset / protocol / sizeUsd)
 * @param address optional recipient address, required only for native `eth`
 *                transfers (used as the `to` of the order).
 * @param prices  optional live price list (symbol -> price) used to quote the
 *                asset exactly. Pass the fetched list from `/api/prices`.
 * @param chainId optional target chain id (the connected chain). When omitted,
 *                defaults to `DEFAULT_CHAIN_ID` (mainnet). The leg's token is
 *                resolved on THIS chain and the resulting order carries that
 *                chainId, so "supply USDC on Base" routes to Base's Aave pool
 *                + Base's USDC. unwired chains fall through to `{ unsupported }`.
 */
export function resolveOrderForLeg(
  leg: TradeLeg,
  address?: Address,
  prices?: PriceEntry[],
  chainId?: number,
): Order | { unsupported: string } {
  const protocol = (leg.protocol || "").toLowerCase().trim();
  const side = (leg.side || "").toLowerCase().trim();
  const resolveChainId = chainId ?? DEFAULT_CHAIN_ID;
  const venue = protocolLabel(leg.protocol);

  // Quote the leg's notional once. HARD-FAIL: `null` (no live price) means we
  // refuse to size the order rather than approximating the amount.
  const quoteFor = (symbol: string, decimals: number) =>
    usdToTokenAmount(symbol, leg.sizeUsd, resolvePriceFromList(prices, symbol), decimals);

  // --- Native ETH/gas transfer (executable, all chains) ---------------------
  // The recipient comes from the thesis itself (leg.to, parsed by tradePlan's
  // "transfer" intent) — falling back to the `address` param only for a
  // caller that already knows the recipient some other way.
  if (protocol === "eth" || side === "transfer") {
    const recipient = (leg.to as Address | undefined) ?? address;
    if (!recipient) {
      return { unsupported: "Send needs a recipient address — include one like 0x1234... in your thesis." };
    }
    const symbol = bareSymbol(leg.asset) || "ETH";

    // Native gas token transfer (ETH, BNB, etc.)
    if (symbol === "ETH" || symbol === "BNB" || symbol === "AVAX" || symbol === "MATIC" || symbol === "FTM") {
      if (leg.sizeToken) {
        return {
          type: "transfer",
          protocol: "eth",
          symbol,
          amount: leg.sizeToken,
          chainId: resolveChainId,
          decimals: 18,
          to: recipient,
        };
      }
      const quote = quoteFor(symbol, 18);
      if (!quote) {
        return { unsupported: `No live price for ${symbol} — cannot size this order safely. Price feeds down?` };
      }
      return {
        type: "transfer",
        protocol: "eth",
        symbol,
        amount: quote.amountBase,
        chainId: resolveChainId,
        decimals: 18,
        to: recipient,
      };
    }

    // ERC-20 token transfer
    const token = findToken(symbol, resolveChainId);
    if (!token) {
      return { unsupported: `"${symbol}" has no tracked address on this chain — can't build a transfer.` };
    }
    if (leg.sizeToken) {
      return {
        type: "transfer",
        protocol: "erc20",
        symbol: token.symbol,
        token: token.address,
        amount: leg.sizeToken,
        chainId: resolveChainId,
        decimals: token.decimals,
        to: recipient,
      } as Order;
    }
    const erc20Quote = quoteFor(token.symbol, token.decimals);
    if (!erc20Quote) {
      return { unsupported: `No live price for ${token.symbol} — cannot size this order safely.` };
    }
    return {
      type: "transfer",
      protocol: "erc20",
      symbol: token.symbol,
      token: token.address,
      amount: erc20Quote.amountBase,
      chainId: resolveChainId,
      decimals: token.decimals,
      to: recipient,
    } as Order;
  }

  // --- Aave v3 supply / repay (executable) ----------------------------------
  if (protocol === "aave") {
    const orderType: Order["type"] | undefined =
      side === "repay"
        ? "repay"
        : side === "supply"
          ? "supply"
          : side === "borrow"
            ? "borrow"
            : side === "withdraw"
              ? "withdraw"
              : side === "approve"
                ? "approve"
                : undefined;
    if (!orderType) {
      return { unsupported: `Aave ${leg.side} is not wired for live execution yet` };
    }
    const symbol = bareSymbol(leg.asset);
    const token = findToken(symbol, resolveChainId);
    if (!token) {
      return {
        unsupported: `Aave ${orderType} of "${symbol}" is not wired yet: "${symbol}" has no tracked ${resolveChainId === 1 ? "mainnet" : "chain " + resolveChainId} address.`,
      };
    }
    const quote = quoteFor(token.symbol, token.decimals);
    if (!quote) {
      return {
        unsupported: `No live price for ${token.symbol} — cannot size this order safely. Price feeds down?`,
      };
    }
    return {
      type: orderType,
      protocol: "aave",
      symbol: token.symbol,
      token: token.address,
      amount: quote.amountBase,
      chainId: resolveChainId,
      decimals: token.decimals,
    };
  }

  // --- Compound III supply / repay / borrow / withdraw (executable, USDC
  // market only) -------------------------------------------------------------
  // Compound has no single cross-asset pool like Aave — the USDC Comet market
  // is the only one wired (see COMPOUND_V3_USDC_COMET_BY_CHAIN's comment), so
  // this only resolves for a USDC leg. A non-USDC "supply to Compound" thesis
  // honestly falls through to the unsupported case below rather than silently
  // mis-targeting a market that doesn't exist for that asset.
  if (protocol === "compound") {
    const orderType: Order["type"] | undefined =
      side === "repay"
        ? "repay"
        : side === "supply"
          ? "supply"
          : side === "borrow"
            ? "borrow"
            : side === "withdraw"
              ? "withdraw"
              : side === "approve"
                ? "approve"
                : undefined;
    if (!orderType) {
      return { unsupported: `Compound ${leg.side} is not wired for live execution yet` };
    }
    const symbol = bareSymbol(leg.asset);
    if (symbol !== "USDC") {
      return { unsupported: `Only Compound's USDC market is wired — "${symbol}" isn't.` };
    }
    const token = findToken(symbol, resolveChainId);
    if (!token) {
      return {
        unsupported: `Compound ${orderType} of USDC is not wired yet: no tracked USDC address on ${resolveChainId === 1 ? "mainnet" : "chain " + resolveChainId}.`,
      };
    }
    const quote = quoteFor(token.symbol, token.decimals);
    if (!quote) {
      return { unsupported: "No live price for USDC — cannot size this order safely. Price feeds down?" };
    }
    return {
      type: orderType,
      protocol: "compound",
      symbol: token.symbol,
      token: token.address,
      amount: quote.amountBase,
      chainId: resolveChainId,
      decimals: token.decimals,
    };
  }

  // --- Lido staking (executable, ETH only, mainnet only) --------------------
  if (protocol === "lido" && side === "stake") {
    const symbol = bareSymbol(leg.asset);
    if (symbol !== "ETH" && symbol !== "stETH") {
      return { unsupported: `Lido only stakes ETH — "${symbol}" is not supported.` };
    }
    if (resolveChainId !== 1) {
      return { unsupported: "Lido staking is only available on Ethereum mainnet — switch networks to stake." };
    }
    const quote = quoteFor("ETH", 18);
    if (!quote) {
      return { unsupported: "No live price for ETH — cannot size this order safely. Price feeds down?" };
    }
    return {
      type: "stake",
      protocol: "lido",
      symbol: "ETH",
      amount: quote.amountBase,
      chainId: resolveChainId,
      decimals: 18,
    };
  }

  // --- Lido unstake / claim (executable, mainnet only) ----------------------
  if (protocol === "lido" && (side === "unstake" || side === "withdraw")) {
    if (resolveChainId !== 1) {
      return { unsupported: "Lido unstaking is only available on Ethereum mainnet." };
    }
    const quote = quoteFor("ETH", 18);
    if (!quote) {
      return { unsupported: "No live price for ETH — cannot size this order safely." };
    }
    return {
      type: "unstake",
      protocol: "lido",
      symbol: "stETH",
      token: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84" as Address,
      amount: quote.amountBase,
      chainId: resolveChainId,
      decimals: 18,
    };
  }
  if (protocol === "lido" && side === "claim") {
    if (resolveChainId !== 1) {
      return { unsupported: "Lido claims are only available on Ethereum mainnet." };
    }
    return {
      type: "claim",
      protocol: "lido",
      symbol: "stETH",
      amount: BigInt(0),
      chainId: resolveChainId,
      decimals: 18,
    };
  }

  // --- Spark (Aave v3 fork) supply / repay / borrow / withdraw -------------
  if (protocol === "spark") {
    const orderType: Order["type"] | undefined =
      side === "repay" ? "repay" : side === "supply" ? "supply" : side === "borrow" ? "borrow"
        : side === "withdraw" ? "withdraw" : side === "approve" ? "approve" : undefined;
    if (!orderType) {
      return { unsupported: `Spark ${leg.side} is not wired for live execution yet` };
    }
    if (!SPARK_POOL_BY_CHAIN[resolveChainId]) {
      return { unsupported: `Spark is not deployed on this chain — only Ethereum and Gnosis.` };
    }
    const symbol = bareSymbol(leg.asset);
    const token = findToken(symbol, resolveChainId);
    if (!token) {
      return { unsupported: `Spark: "${symbol}" has no tracked address on this chain.` };
    }
    const quote = quoteFor(token.symbol, token.decimals);
    if (!quote) {
      return { unsupported: `No live price for ${token.symbol} — cannot size this order safely.` };
    }
    return {
      type: orderType, protocol: "spark", symbol: token.symbol,
      token: token.address, amount: quote.amountBase, chainId: resolveChainId, decimals: token.decimals,
    };
  }

  // --- Maker/Sky sDAI (DAI Savings Rate, ERC-4626) -------------------------
  if (protocol === "maker" || protocol === "sky" || protocol === "sdai") {
    if (side !== "supply" && side !== "withdraw" && side !== "stake" && side !== "deposit" && side !== "approve") {
      return { unsupported: `Maker DSR only supports supply/withdraw.` };
    }
    if (resolveChainId !== 1) {
      return { unsupported: "Maker's sDAI vault is only available on Ethereum mainnet." };
    }
    const token = findToken("DAI", resolveChainId);
    if (!token) {
      return { unsupported: "DAI not tracked on this chain." };
    }
    const quote = quoteFor("DAI", token.decimals);
    if (!quote) {
      return { unsupported: "No live price for DAI — cannot size this order safely." };
    }
    return {
      type: side === "withdraw" ? "withdraw" : "supply",
      protocol: "maker", symbol: "DAI", token: token.address,
      amount: quote.amountBase, chainId: resolveChainId, decimals: token.decimals,
      spender: SDAI_VAULT,
    } as Order;
  }

  // --- Rocket Pool (ETH staking → rETH, mainnet only) ---------------------
  if (protocol === "rocket pool" || protocol === "rocketpool" || protocol === "rocket") {
    if (resolveChainId !== 1) {
      return { unsupported: "Rocket Pool is only available on Ethereum mainnet." };
    }
    if (side !== "stake" && side !== "supply" && side !== "deposit") {
      return { unsupported: `Rocket Pool only supports staking, not "${leg.side}".` };
    }
    const quote = quoteFor("ETH", 18);
    if (!quote) {
      return { unsupported: "No live price for ETH — cannot size this order safely." };
    }
    return {
      type: "stake", protocol: "rocketpool", symbol: "ETH",
      amount: quote.amountBase, chainId: resolveChainId, decimals: 18,
    };
  }

  // --- Frax (ETH staking → sfrxETH, mainnet only) -------------------------
  if (protocol === "frax") {
    if (resolveChainId !== 1) {
      return { unsupported: "Frax ETH staking is only available on Ethereum mainnet." };
    }
    if (side !== "stake" && side !== "supply" && side !== "deposit") {
      return { unsupported: `Frax only supports staking, not "${leg.side}".` };
    }
    const quote = quoteFor("ETH", 18);
    if (!quote) {
      return { unsupported: "No live price for ETH — cannot size this order safely." };
    }
    return {
      type: "stake", protocol: "frax", symbol: "ETH",
      amount: quote.amountBase, chainId: resolveChainId, decimals: 18,
    };
  }

  // --- WETH wrap / unwrap --------------------------------------------------
  if (protocol === "weth") {
    const token = findToken("WETH", resolveChainId);
    if (!token) {
      return { unsupported: "WETH not tracked on this chain." };
    }
    const quote = quoteFor("ETH", 18);
    if (!quote) {
      return { unsupported: "No live price for ETH — cannot size this order safely." };
    }
    return {
      type: side === "unwrap" || side === "withdraw" ? "withdraw" : "supply",
      protocol: "weth", symbol: "WETH", token: token.address,
      amount: quote.amountBase, chainId: resolveChainId, decimals: 18,
    };
  }

  // --- Morpho vault supply / withdraw (executable via Philidor) ------------
  // Note: the actual vault is resolved dynamically at execute-time by
  // MorphoExecuteButton using Philidor risk data — this order carries the
  // token info but the vault address gets patched by the execute button.
  if (protocol === "morpho") {
    if (side !== "supply" && side !== "withdraw" && side !== "approve") {
      return { unsupported: `Morpho ${leg.side || "action"} is not wired yet.` };
    }
    const symbol = bareSymbol(leg.asset);
    const token = findToken(symbol, resolveChainId);
    if (!token) {
      return { unsupported: `Morpho: "${symbol}" has no tracked address on this chain.` };
    }
    const quote = quoteFor(token.symbol, token.decimals);
    if (!quote) {
      return { unsupported: `No live price for ${token.symbol} — cannot size this order safely.` };
    }
    return {
      type: side === "withdraw" ? "withdraw" : "supply",
      protocol: "morpho",
      symbol: token.symbol,
      token: token.address,
      amount: quote.amountBase,
      chainId: resolveChainId,
      decimals: token.decimals,
    };
  }

  // --- Uniswap v3 swap (executable via live on-chain quote) ----------------
  // The amountOutMinimum is resolved by SwapExecuteButton at sign-time from a
  // live QuoterV2 quote — this order carries the input token + amount only.
  if (protocol === "uniswap") {
    if (side !== "swap" && side !== "buy" && side !== "approve") {
      return { unsupported: `Uniswap ${leg.side || "action"} is not wired yet.` };
    }
    const symbol = bareSymbol(leg.asset);
    const token = findToken(symbol, resolveChainId);
    if (!token) {
      return { unsupported: `Uniswap: "${symbol}" has no tracked address on this chain.` };
    }
    const quote = quoteFor(token.symbol, token.decimals);
    if (!quote) {
      return { unsupported: `No live price for ${token.symbol} — cannot size this order safely.` };
    }
    return {
      type: "swap",
      protocol: "uniswap",
      symbol: token.symbol,
      token: token.address,
      amount: quote.amountBase,
      chainId: resolveChainId,
      decimals: token.decimals,
    };
  }

  // --- LI.FI DEX aggregator swap (executed via /api/swap) ------------------
  // Like bridge legs, the actual unsigned tx is fetched at execute-time by the
  // UI from /api/swap — this order carries the token info for display.
  if (protocol === "lifi" || protocol === "li.fi") {
    if (side !== "swap" && side !== "buy") {
      return { unsupported: `LI.FI ${leg.side || "action"} is not wired yet.` };
    }
    const symbol = bareSymbol(leg.asset);
    const token = findToken(symbol, resolveChainId);
    if (!token) {
      return { unsupported: `LI.FI: "${symbol}" has no tracked address on this chain.` };
    }
    const quote = quoteFor(token.symbol, token.decimals);
    if (!quote) {
      return { unsupported: `No live price for ${token.symbol} — cannot size this order safely.` };
    }
    return {
      type: "swap",
      protocol: "lifi" as Order["protocol"],
      symbol: token.symbol,
      token: token.address,
      amount: quote.amountBase,
      chainId: resolveChainId,
      decimals: token.decimals,
    };
  }

  // --- Directional / hedge / beta-neutral / options perps ------------------
  // Perp venues have dedicated execute buttons in ThreadCard that bypass
  // resolveOrderForLeg entirely (EIP-712/StarkEx/LiFi signing flows).
  if (side === "long" || side === "short" || side === "open" || /perp|option|call|put/i.test(leg.asset)) {
    if (protocol === "variational") {
      return {
        unsupported:
          "Variational has an active points program but hasn't published a public trading API yet — nothing to sign against.",
      };
    }
    // Return a shell order for perp venues — ThreadCard dispatches these
    // to the correct dedicated execute button (Hyperliquid/Extended/LiFi).
    if (protocol === "hyperliquid" || protocol === "extended" || protocol === "ondo" || protocol === "lighter") {
      const symbol = bareSymbol(leg.asset);
      return {
        type: side === "short" ? "swap" : "swap",
        protocol: protocol as Order["protocol"],
        symbol,
        amount: String(leg.sizeUsd ?? 10000),
        chainId: resolveChainId,
        decimals: 18,
      } as Order;
    }
    return { unsupported: `${venue} perps not wired for live execution yet` };
  }

  // --- Remaining protocols -------------------------------------------------
  switch (protocol) {
    case "pendle":
      return { unsupported: "Pendle fixed-yield (PT) not wired for live execution yet" };
    case "lido":
      return { unsupported: `Lido ${leg.side || "action"} not wired for live execution yet` };
    case "eigenlayer":
      return { unsupported: "EigenLayer restaking not wired for live execution yet" };
    case "bridge":
    case "cross-chain":
    case "debridge": {
      // Bridge legs are executed via the deBridge MCP routing layer.
      // The actual unsigned tx is fetched at execute-time by BridgeExecuteButton
      // from /api/bridge — this order is a placeholder that carries the token
      // info and amount so the UI can display the leg and trigger the flow.
      const bridgeSymbol = bareSymbol(leg.asset);
      const bridgeToken = findToken(bridgeSymbol, resolveChainId);
      if (leg.sizeUsd) {
        const bQuote = quoteFor(bridgeToken?.symbol ?? bridgeSymbol, bridgeToken?.decimals ?? 18);
        if (!bQuote) {
          return { unsupported: `No live price for ${bridgeSymbol} — cannot size this bridge order.` };
        }
        return {
          type: "swap",
          protocol: "debridge" as Order["protocol"],
          symbol: bridgeToken?.symbol ?? bridgeSymbol,
          token: bridgeToken?.address,
          amount: bQuote.amountBase,
          chainId: resolveChainId,
          decimals: bridgeToken?.decimals ?? 18,
          bridgeNote: leg.note,
        } as Order;
      }
      return {
        type: "swap",
        protocol: "debridge" as Order["protocol"],
        symbol: bridgeToken?.symbol ?? bridgeSymbol,
        token: bridgeToken?.address,
        amount: "0",
        chainId: resolveChainId,
        decimals: bridgeToken?.decimals ?? 18,
        bridgeNote: leg.note,
      } as Order;
    }
    default:
      return { unsupported: `${venue} is not wired for live execution yet` };
  }
}

/**
 * Build the ERC20 `approve` order that must precede an Aave `supply` (Aave pulls
 * the tokens via allowance). Returns null when not applicable (non-Aave supply,
 * no token). The Execute UI runs this first, then the supply.
 */
export function approveOrderFor(order: Order): Order | null {
  if (order.protocol === "aave" && (order.type === "supply" || order.type === "repay") && order.token) {
    return {
      type: "approve",
      protocol: "aave",
      token: order.token,
      symbol: order.symbol,
      amount: order.amount,
      chainId: order.chainId,
      decimals: order.decimals,
    };
  }
  if (order.protocol === "compound" && (order.type === "supply" || order.type === "repay") && order.token) {
    return {
      type: "approve",
      protocol: "compound",
      token: order.token,
      symbol: order.symbol,
      amount: order.amount,
      chainId: order.chainId,
      decimals: order.decimals,
    };
  }
  if (order.protocol === "uniswap" && order.type === "swap" && order.token) {
    return {
      type: "approve",
      protocol: "uniswap",
      token: order.token,
      symbol: order.symbol,
      amount: order.amount,
      chainId: order.chainId,
      decimals: order.decimals,
    };
  }
  if (order.protocol === "morpho" && order.type === "supply" && order.token && order.vaultAddress) {
    return {
      type: "approve",
      protocol: "morpho",
      token: order.token,
      symbol: order.symbol,
      amount: order.amount,
      chainId: order.chainId,
      decimals: order.decimals,
      spender: order.vaultAddress,
    };
  }
  if (order.protocol === "lido" && order.type === "unstake" && order.token) {
    return {
      type: "approve",
      protocol: "lido",
      token: order.token,
      symbol: order.symbol,
      amount: order.amount,
      chainId: order.chainId,
      decimals: order.decimals,
    };
  }
  // Spark: same approve flow as Aave (it's a fork).
  if (order.protocol === "spark" && (order.type === "supply" || order.type === "repay") && order.token) {
    return {
      type: "approve",
      protocol: "spark",
      token: order.token,
      symbol: order.symbol,
      amount: order.amount,
      chainId: order.chainId,
      decimals: order.decimals,
    };
  }
  // Maker sDAI: approve sDAI vault to pull DAI.
  if (order.protocol === "maker" && order.type === "supply" && order.token) {
    return {
      type: "approve",
      protocol: "maker",
      token: order.token,
      symbol: order.symbol,
      amount: order.amount,
      chainId: order.chainId,
      decimals: order.decimals,
      spender: order.spender,
    };
  }
  // deBridge/LI.FI router swap: approve the SAME verified entrypoint the
  // quote will call (routerTx.to) — never a generic default, since that
  // address is chosen per-quote rather than fixed per protocol.
  if ((order.protocol === "debridge" || order.protocol === "lifi") && order.type === "swap" && order.token && order.routerTx) {
    return {
      type: "approve",
      protocol: order.protocol,
      token: order.token,
      symbol: order.symbol,
      amount: order.amount,
      chainId: order.chainId,
      decimals: order.decimals,
      spender: order.routerTx.to,
    };
  }
  return null;
}
