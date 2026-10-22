"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount, useReadContract, useSignTypedData } from "wagmi";
import type { Address } from "viem";
import type { PerpVenueName } from "@/lib/planner/markets";
import type { PerpTrader } from "@/hooks/usePerpTrader";
import { useSharedHlEnv } from "@/hooks/useHyperliquidEnv";
import { ERC20_ABI } from "@/lib/onchain";
import { ARBITRUM_USDC } from "@/lib/integrations/hyperliquidDeposit";
import { fetchWithdrawable, hyperliquidEnv, moveSpotUsdcToPerps, type WalletSign } from "@/lib/integrations/hyperliquidTrade";
import { fetchHlHoldings } from "@/lib/integrations/hyperliquid-live";
import { EXTENDED_APP_URL } from "@/lib/integrations/extendedBridge";
import { VENUE_ANCHOR } from "@/components/PerpVenuesSummary";
import { openToolsAt } from "@/lib/neutralBot/bus";

const VENUES: PerpVenueName[] = ["Hyperliquid", "Extended", "TxFlow"];
export const VENUE_ANCHOR_OF: Record<PerpVenueName, string> = { Hyperliquid: VENUE_ANCHOR.hyperliquid, Extended: VENUE_ANCHOR.extended, TxFlow: VENUE_ANCHOR.txflow };
const usd = (n: number) => `$${n >= 1000 ? Math.round(n).toLocaleString("en-US") : n.toFixed(2)}`;

export interface VenueFunds {
  /** Margin the bot can trade with now, USD (null: not readable — not connected, or the read failed). */
  free: Record<PerpVenueName, number | null>;
  /** Hyperliquid: spot USDC a non-unified account must move to perps before trading. */
  hlIdleSpot: number;
  /** Hyperliquid: equity in vaults (HLP…), which can't margin a trade. */
  hlVaults: number;
}

/** The free margin on each venue, refreshed every 30 s; shared by the setup steps. */
export function useVenueFunds(trader: PerpTrader) {
  const envName = useSharedHlEnv();
  const env = hyperliquidEnv(envName === "testnet");
  const ready = VENUES.map((v) => trader.ready(v));
  return useQuery({
    queryKey: ["bot-funds", trader.address, envName, ...ready],
    enabled: !!trader.address,
    refetchInterval: 30_000,
    queryFn: async (): Promise<VenueFunds> => {
      const user = trader.address as Address;
      const safe = <T,>(p: Promise<T>) => p.catch(() => null);
      const [hl, holdings, ext, tx] = await Promise.all([
        safe(fetchWithdrawable(env, user)),
        safe(fetchHlHoldings(user, env)),
        trader.ready("Extended") ? safe(trader.freeMargin("Extended", "ETH-USD")) : Promise.resolve(null),
        safe(trader.freeMargin("TxFlow", "ETH-USDC")),
      ]);
      return {
        free: { Hyperliquid: hl ? (hl.unified ? Math.max(hl.perps, hl.spotUsdc) : hl.perps) : null, Extended: ext, TxFlow: tx },
        hlIdleSpot: hl && !hl.unified ? hl.spotUsdc : 0,
        hlVaults: (holdings?.vaults ?? []).reduce((s, v) => s + v.equity, 0),
      };
    },
  });
}

/**
 * Step 1 of the bot's setup: where the user's money is. The wallet's USDC on
 * Arbitrum (what deposits draw on), then each venue: connected or not, the
 * margin free there, and the one thing to do next (connect, deposit, move
 * Hyperliquid spot USDC to perps). The two venues of the chosen pair are
 * marked; each needs `neededUsd` free.
 */
export function BotFunds({ trader, funds, pair, neededUsd }: { trader: PerpTrader; funds: VenueFunds | undefined; pair: [PerpVenueName, PerpVenueName]; neededUsd: number }) {
  const { address, chainId } = useAccount();
  const wallet = useReadContract({
    address: ARBITRUM_USDC,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: 42161,
    query: { enabled: !!address, refetchInterval: 30_000 },
  });
  const walletUsdc = wallet.data !== undefined ? Number(wallet.data) / 1e6 : null;

  const { signTypedDataAsync } = useSignTypedData();
  const envName = useSharedHlEnv();
  const qc = useQueryClient();
  const [moving, setMoving] = useState<string | null>(null);
  const moveSpot = async (amount: number) => {
    if (!chainId) return;
    setMoving("Sign in your wallet…");
    try {
      const walletSign: WalletSign = (td) => signTypedDataAsync(td as Parameters<typeof signTypedDataAsync>[0]);
      const r = await moveSpotUsdcToPerps({ env: hyperliquidEnv(envName === "testnet"), walletSign, walletChainId: chainId, amount });
      setMoving(r.ok ? null : `Hyperliquid refused: ${r.error ?? "unknown error"}`);
      await qc.invalidateQueries({ queryKey: ["bot-funds"] });
    } catch (e) {
      setMoving(e instanceof Error ? e.message.split("\n")[0] : String(e));
    }
  };

  if (!address) return <p className="text-muted bot-empty">Connect a wallet: the bot trades your own accounts on these venues.</p>;

  return (
    <div className="bot-funds">
      <div className="bot-funds__row">
        <span className="bot-funds__name">Wallet</span>
        <span className="bot-funds__what text-muted">USDC on Arbitrum, for deposits</span>
        <span className="bot-funds__amt">{walletUsdc === null ? "…" : usd(walletUsdc)}</span>
        <span className="bot-funds__act" />
      </div>
      {VENUES.map((v) => {
        const inPair = pair.includes(v);
        const ready = trader.ready(v);
        const free = funds?.free[v] ?? null;
        const enough = free !== null && free >= neededUsd;
        const tone = !inPair ? "idle" : !ready ? "warn" : free === null ? "idle" : enough ? "good" : "warn";
        return (
          <div key={v} className={`bot-funds__row${inPair ? " is-pair" : ""}`}>
            <span className="bot-funds__name">
              <span className={`bot-funds__dot bot-funds__dot--${tone}`} aria-hidden />
              {v}
            </span>
            <span className="bot-funds__what text-muted">
              {!ready ? "not connected" : inPair ? (free === null ? "reading…" : enough ? "ready for this pair" : `needs ${usd(neededUsd)} free for this pair`) : "not used by this pair"}
            </span>
            <span className="bot-funds__amt">{ready && free !== null ? `${usd(free)} free` : "—"}</span>
            <span className="bot-funds__act">
              {(!ready || (inPair && !enough && free !== null)) && (
                <button type="button" className={`btn ${inPair ? "btn-primary" : "btn-secondary"} bot-mini`} onClick={() => openToolsAt(VENUE_ANCHOR_OF[v])}>
                  {!ready ? "Connect" : "Deposit"} →
                </button>
              )}
            </span>
          </div>
        );
      })}
      {funds && funds.hlIdleSpot >= 1 && (
        <div className="bot-funds__note">
          <span>
            {usd(funds.hlIdleSpot)} USDC sits in your Hyperliquid <strong>spot</strong> balance: perps can&apos;t use it until it moves over (free, one signature).
          </span>
          <button type="button" className="btn btn-primary bot-mini" disabled={moving === "Sign in your wallet…"} onClick={() => void moveSpot(funds.hlIdleSpot)}>
            Move {usd(funds.hlIdleSpot)} to perps
          </button>
        </div>
      )}
      {moving && <p className="bot-problem">{moving}</p>}
      {funds && funds.hlVaults >= 0.01 && <p className="text-muted bot-footnote">Also {usd(funds.hlVaults)} in Hyperliquid vaults (HLP…): it earns there, but can&apos;t margin a trade until you withdraw it from the vault.</p>}
      {pair.includes("Extended") && (
        <p className="text-muted bot-footnote">
          If the deposit from Meridian fails (Extended answers &quot;Internal Server Error&quot;), deposit once with this same wallet on{" "}
          <a href={EXTENDED_APP_URL} target="_blank" rel="noreferrer">
            app.extended.exchange
          </a>
          : the bot sees the balance as soon as it lands.
        </p>
      )}
    </div>
  );
}
