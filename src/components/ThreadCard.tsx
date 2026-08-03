"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { ThreadItem, fmtUsd } from "@/lib/data";
import { resolveOrderForLeg, protocolLabel } from "@/lib/assetMap";
import type { Order } from "@/lib/execution";
import type { TradeLeg } from "@/lib/tradePlan";
import { useExecute, explorerUrlFor } from "@/hooks/useExecute";
import { useHyperliquid } from "@/hooks/useHyperliquid";
import { ConfirmDialog } from "@/components/ConfirmDialog";

function UserBubble({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        alignSelf: "flex-end",
        maxWidth: "80%",
        background: "var(--color-surface)",
        border: "1px solid var(--color-divider)",
        borderRadius: "var(--radius-md)",
        padding: "var(--space-2) var(--space-3)",
      }}
    >
      <p style={{ margin: 0, fontSize: 14 }}>{children}</p>
    </div>
  );
}

function OrderRow({ label, value, valueColor }: { label: string; value: React.ReactNode; valueColor?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between" }}>
      <span className="text-muted">{label}</span>
      <span style={{ color: valueColor }}>{value}</span>
    </div>
  );
}

/** Honest "not wired yet" — never fakes a success for a venue the harness can't sign. */
function NotWired({ venue, reason }: { venue: string; reason: string }) {
  return (
    <div style={{ margin: "6px 0 0", fontSize: 12, color: "var(--color-neutral-500)", display: "flex", flexDirection: "column", gap: 2 }}>
      <span>Live execution not wired for {venue} yet</span>
      <span className="text-muted" style={{ fontSize: 11 }}>
        {reason}
      </span>
    </div>
  );
}

/**
 * Real Execute button. Uses the wagmi harness (`useExecute`): on click it builds
 * the order and asks the wallet to sign (Aave v3 supply/repay, native transfer).
 * Renders the true wallet state — idle / awaiting signature / confirmed (linked
 * to the block explorer by chainId) / error. Execution only ever happens on this
 * explicit click; the harness never auto-submits.
 */
function ExecuteButton({ order, label }: { order: Order; label: string }) {
  const { isConnected } = useAccount();
  const { status, data, error, execute, reset } = useExecute();
  const [confirming, setConfirming] = useState(false);

  if (status === "confirming") {
    return (
      <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--color-neutral-500)" }}>
        Awaiting wallet signature…
      </p>
    );
  }

  if (status === "confirmed" && data) {
    const url = explorerUrlFor(order.chainId, data);
    return (
      <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--color-accent-700)" }}>
        Signed onchain ·{" "}
        <a href={url} target="_blank" rel="noreferrer" style={{ color: "inherit", textDecoration: "underline" }}>
          view {data.slice(0, 10)}…
        </a>
        <button onClick={reset} style={{ marginLeft: 8, background: "none", border: "none", cursor: "pointer", color: "var(--color-neutral-500)", fontSize: 11 }}>
          clear
        </button>
      </p>
    );
  }

  if (status === "error") {
    const msg = error instanceof Error ? error.message : String(error);
    return (
      <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--risk-bad, #c0392b)" }}>
        {msg === "wallet not connected" ? "Connect a wallet to execute" : `Execution failed: ${msg}`}
        <button onClick={reset} style={{ marginLeft: 8, background: "none", border: "none", cursor: "pointer", color: "var(--color-neutral-500)", fontSize: 11 }}>
          clear
        </button>
      </p>
    );
  }

  return (
    <>
      <button
        className="btn btn-primary"
        style={{ fontSize: 13, marginTop: 6, cursor: "pointer" }}
        onClick={() => setConfirming(true)}
        title={isConnected ? undefined : "Connect a wallet first"}
      >
        {label}
      </button>
      <ConfirmDialog
        open={confirming}
        title="Confirm on-chain action"
        body={
          <div>
            Sign and broadcast <strong>{order.type}</strong> of {String(order.amount)}{" "}
            {order.symbol ?? ""} on {String(order.protocol)} (chain {order.chainId}).
          </div>
        }
        confirmLabel="Sign"
        warning="This moves real funds from your wallet."
        onConfirm={() => {
          setConfirming(false);
          execute(order);
        }}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}

/**
 * Live Hyperliquid perp execution (testnet by default). Fetches the live mid
 * price + asset index, signs the EIP-712 order with the wallet, submits to the
 * exchange API, and reports the real status. Honest: any failure surfaces as
 * error, never a fake success.
 */
function PerpExecuteButton({ leg }: { leg: TradeLeg }) {
  const { isConnected } = useAccount();
  const { status, result, error, execute, reset } = useHyperliquid();
  const [confirming, setConfirming] = useState(false);

  const symbol = (leg.asset || "HYPE").replace(/PERP$/i, "").trim() || "HYPE";
  const sizeUsd = leg.sizeUsd && leg.sizeUsd > 0 ? leg.sizeUsd : 1000;
  const side = (leg.side || "").toLowerCase();
  const isBuy = side.startsWith("long") || side === "buy";
  const leverage = leg.leverage;

  if (status === "preparing" || status === "signing" || status === "submitting") {
    return (
      <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--color-neutral-500)" }}>
        {status === "preparing"
          ? "Fetching Hyperliquid price…"
          : status === "signing"
            ? "Awaiting wallet signature…"
            : "Submitting order to Hyperliquid…"}
      </p>
    );
  }

  if (status === "confirmed" && result) {
    return (
      <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--color-accent-700)" }}>
        Order on Hyperliquid testnet: {result.marketPrice ? "$" + result.marketPrice.toFixed(4) : "n/a"} →{" "}
        {JSON.stringify(result.response)}
        <button onClick={reset} style={{ marginLeft: 8, background: "none", border: "none", cursor: "pointer", color: "var(--color-neutral-500)", fontSize: 11 }}>
          clear
        </button>
      </p>
    );
  }

  if (status === "error") {
    return (
      <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--risk-bad, #c0392b)" }}>
        {`HL: ${error ?? "execution failed"}`}
        <button onClick={reset} style={{ marginLeft: 8, background: "none", border: "none", cursor: "pointer", color: "var(--color-neutral-500)", fontSize: 11 }}>
          clear
        </button>
      </p>
    );
  }

  return (
    <>
      <button
        className="btn btn-primary"
        style={{ fontSize: 13, marginTop: 6, cursor: "pointer" }}
        onClick={() => setConfirming(true)}
        title={isConnected ? undefined : "Connect a wallet first"}
      >
        Open {side === "short" ? "short" : "long"} {symbol} on Hyperliquid →
      </button>
      <ConfirmDialog
        open={confirming}
        title={`Confirm ${isBuy ? "long" : "short"} ${symbol} on Hyperliquid`}
        body={
          <div>
            Market order: {isBuy ? "long" : "short"} {symbol.toUpperCase()} ({fmtUsd(sizeUsd)}
            {leverage ? ` at ${leverage}x` : ""}). A live mid price will be fetched, the order signed with your
            wallet, then submitted to Hyperliquid.
          </div>
        }
        confirmLabel="Sign & submit"
        warning="TESTNET by default — no real funds."
        onConfirm={() => {
          setConfirming(false);
          execute({ symbol, isBuy, sizeUsd, leverage, testnet: true });
        }}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}

function legRowValue(leg: { asset: string; protocol: string; sizeUsd?: number; leverage?: number }): string {
  return `${leg.asset} · ${leg.protocol}${leg.sizeUsd ? ` · ${fmtUsd(leg.sizeUsd)}` : ""}${leg.leverage ? ` · ${leg.leverage}x` : ""}`;
}

/**
 * Type predicate to disambiguate an unsupported result from an `Order`. `Order`
 * carries a `[k: string]: unknown` index signature, so a bare `"unsupported" in r`
 * check cannot narrow it — this predicate gives TS an explicit narrowing on both
 * branches (true → `{ unsupported: string }`, false → `Order`).
 */
function isUnsupported(r: Order | { unsupported: string }): r is { unsupported: string } {
  return "unsupported" in r && typeof r.unsupported === "string";
}

/** Order card rendered from a parsed TradePlan when item.plan is present. */
function PlanCard({ item }: { item: ThreadItem }) {
  const plan = item.plan!;
  const orderStyle: React.CSSProperties = {
    borderLeft: "2px solid var(--color-accent)",
    paddingLeft: "var(--space-2)",
    fontSize: 13,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      <UserBubble>{item.text || "Describe your thesis."}</UserBubble>
      <div style={{ maxWidth: "90%" }}>
        <p style={{ margin: "0 0 6px", fontSize: 14 }}>{plan.summary}</p>
        {plan.legs.length > 0 && (
          <div style={orderStyle}>
            {plan.legs.map((leg, i) => {
              const resolved = resolveOrderForLeg(leg);
              return (
                <div key={i} style={{ marginTop: i === 0 ? 0 : "var(--space-2)" }}>
                  <OrderRow label={leg.side} value={legRowValue(leg)} />
                  {isUnsupported(resolved) ? (
                    /hyperliquid/i.test(leg.protocol || "") ? (
                      <PerpExecuteButton leg={leg} />
                    ) : (
                      <NotWired venue={protocolLabel(leg.protocol)} reason={resolved.unsupported} />
                    )
                  ) : (
                    <ExecuteButton order={resolved} label={`Execute on ${leg.protocol} →`} />
                  )}
                </div>
              );
            })}
            {plan.legs.some((l) => l.note) && (
              <OrderRow label="Note" value={plan.legs.map((l) => l.note).filter(Boolean).join(" · ")} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function ThreadCard({
  item,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- backward-compat placeholder, ignored by the real harness
  executed,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- backward-compat placeholder, ignored by the real harness
  onExecute,
}: {
  item: ThreadItem;
  /** Backward-compat placeholders kept so legacy callers (landing PromptDemo) still type-check. Ignored by the real harness. */
  executed?: boolean;
  onExecute?: () => void;
}) {
  const orderStyle: React.CSSProperties = {
    borderLeft: "2px solid var(--color-accent)",
    paddingLeft: "var(--space-2)",
    fontSize: 13,
  };

  // Dynamic plan-driven card takes priority over the canned fallbacks.
  if (item.plan) {
    return <PlanCard item={item} />;
  }

  if (item.type === "pendle") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
        <UserBubble>
          Liquid restaking yield on ETH is going to compress over the next 3 months. How do I lock in the current
          rate?
        </UserBubble>
        <div style={{ maxWidth: "90%" }}>
          <p style={{ margin: "0 0 6px", fontSize: 14 }}>
            The implied PT weETH June 2027 rate is <strong>9.8% fixed</strong>, versus 6.4% average variable yield on
            weETH. The spread has widened by 140bps this week.
          </p>
          <div style={orderStyle}>
            <OrderRow label="Buy" value="PT weETH · Pendle · June 26, 2027" />
            <OrderRow label="Amount" value="$15,000" />
            <OrderRow label="Fixed APY" value="9.8%" valueColor="var(--color-accent-700)" />
            <NotWired venue="Pendle" reason="Pendle fixed-yield (PT) not wired for live execution yet" />
          </div>
        </div>
      </div>
    );
  }

  if (item.type === "betaneutral") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
        <UserBubble>I want to farm Hyperliquid points on ETH without directional risk.</UserBubble>
        <div style={{ maxWidth: "90%" }}>
          <p style={{ margin: "0 0 6px", fontSize: 14 }}>
            A long on Hyperliquid paired with an equivalent short on Extended cancels the delta while keeping 100% of
            the volume eligible for points. Net funding: +2.7% annualized in your favor.
          </p>
          <div style={orderStyle}>
            <OrderRow label="Long" value="ETH PERP · Hyperliquid · $20,000 · 3.0x" />
            <OrderRow label="Short" value="ETH PERP · Extended · $20,000 · 3.0x" />
            <OrderRow label="Net delta" value="0.00 ETH" valueColor="var(--color-accent-700)" />
            <NotWired venue="Hyperliquid / Extended" reason="Perp venues not wired for live execution yet" />
          </div>
        </div>
      </div>
    );
  }

  if (item.type === "perp") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
        <UserBubble>I think SOL will outperform ETH this month.</UserBubble>
        <div style={{ maxWidth: "90%" }}>
          <p style={{ margin: "0 0 6px", fontSize: 14 }}>
            Momentum on SOL is positive, and Hyperliquid funding is close to neutral (+0.3% annualized), so there is
            no meaningful carry cost for a directional long.
          </p>
          <div style={orderStyle}>
            <OrderRow label="Long" value="SOL PERP · Hyperliquid · $8,000 · 4.0x" />
            <OrderRow label="Est. liquidation" value="$131" />
            <NotWired venue="Hyperliquid" reason="Hyperliquid perps not wired for live execution yet" />
          </div>
        </div>
      </div>
    );
  }

  if (item.type === "swap") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
        <UserBubble>I want to move out of USDC into stETH.</UserBubble>
        <div style={{ maxWidth: "90%" }}>
          <p style={{ margin: "0 0 6px", fontSize: 14 }}>
            The most efficient route is a direct USDC to wstETH swap through an aggregator, with an estimated 0.04%
            slippage on $10,000.
          </p>
          <div style={orderStyle}>
            <OrderRow label="Swap" value="$10,000 USDC → wstETH" />
            <OrderRow label="Est. received" value="2.94 wstETH" />
            <NotWired venue="Uniswap" reason="Uniswap swaps not wired for live execution yet" />
          </div>
        </div>
      </div>
    );
  }

  if (item.type === "hedge") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
        <UserBubble>{item.text || "How do I hedge my portfolio against a broader market downturn?"}</UserBubble>
        <div style={{ maxWidth: "90%" }}>
          <p style={{ margin: "0 0 6px", fontSize: 14 }}>
            Your book currently carries <strong>+0.62 ETH</strong> of net directional delta, and stETH plus PT weETH
            make up <strong>42%</strong> of the portfolio in liquid staking and restaking risk. A partial short on
            Hyperliquid brings the delta close to flat without touching either yield leg.
          </p>
          <div style={orderStyle}>
            <OrderRow label="Short" value="ETH PERP · Hyperliquid · $13,000 · 1.0x" />
            <OrderRow label="Resulting net delta" value="≈0.02 ETH" valueColor="var(--risk-good)" />
            <OrderRow label="Est. cost of carry" value="-1.1% annualized" />
            <NotWired venue="Hyperliquid" reason="Hyperliquid perps not wired for live execution yet" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      <UserBubble>{item.text}</UserBubble>
      <div style={{ maxWidth: "90%" }}>
        <p style={{ margin: 0, fontSize: 14 }}>
          I can be most precise on fixed yield locks, beta neutral pairs, directional perps, swaps, and portfolio
          hedges. Try one of the quick prompts below, or rephrase your thesis with one of those in mind.
        </p>
      </div>
    </div>
  );
}
