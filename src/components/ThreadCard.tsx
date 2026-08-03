import { NET_DELTA_ETH, STAKING_CONCENTRATION_PCT, ThreadItem, TX_HASHES, fmtUsd } from "@/lib/data";
import { planToThreadType } from "@/lib/tradePlan";

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

function ExecuteAction({
  executed,
  txHash,
  label,
  onExecute,
}: {
  executed: boolean;
  txHash: string;
  label: string;
  onExecute: () => void;
}) {
  if (executed) {
    return (
      <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--color-accent-700)" }}>
        Signed onchain · tx {txHash}
      </p>
    );
  }
  return (
    <a
      href="#"
      style={{ textDecoration: "none", fontSize: 13 }}
      onClick={(e) => {
        e.preventDefault();
        onExecute();
      }}
    >
      {label}
    </a>
  );
}

/** Order card rendered from a parsed TradePlan when item.plan is present. */
function PlanCard({
  item,
  executed,
  onExecute,
}: {
  item: ThreadItem;
  executed: boolean;
  onExecute: () => void;
}) {
  const plan = item.plan!;
  const orderStyle: React.CSSProperties = {
    borderLeft: "2px solid var(--color-accent)",
    paddingLeft: "var(--space-2)",
    fontSize: 13,
  };
  const type = planToThreadType(plan);
  const txHash = type !== "custom" ? TX_HASHES[type] : undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      <UserBubble>{item.text || "Describe your thesis."}</UserBubble>
      <div style={{ maxWidth: "90%" }}>
        <p style={{ margin: "0 0 6px", fontSize: 14 }}>{plan.summary}</p>
        {plan.legs.length > 0 && (
          <div style={orderStyle}>
            {plan.legs.map((leg, i) => (
              <OrderRow
                key={i}
                label={leg.side}
                value={`${leg.asset} · ${leg.protocol}${leg.sizeUsd ? ` · ${fmtUsd(leg.sizeUsd)}` : ""}${
                  leg.leverage ? ` · ${leg.leverage}x` : ""
                }`}
              />
            ))}
            {plan.legs.some((l) => l.note) && (
              <OrderRow label="Note" value={plan.legs.map((l) => l.note).filter(Boolean).join(" · ")} />
            )}
            {txHash && (
              <ExecuteAction
                executed={executed}
                txHash={txHash}
                label={`Execute on ${plan.protocol ?? "chain"} →`}
                onExecute={onExecute}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function ThreadCard({
  item,
  executed,
  onExecute,
}: {
  item: ThreadItem;
  executed: boolean;
  onExecute: () => void;
}) {
  const orderStyle: React.CSSProperties = {
    borderLeft: "2px solid var(--color-accent)",
    paddingLeft: "var(--space-2)",
    fontSize: 13,
  };

  // Dynamic plan-driven card takes priority over the canned fallbacks.
  if (item.plan) {
    return <PlanCard item={item} executed={executed} onExecute={onExecute} />;
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
            <ExecuteAction
              executed={executed}
              txHash={TX_HASHES.pendle}
              label="Execute on Pendle →"
              onExecute={onExecute}
            />
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
            <ExecuteAction
              executed={executed}
              txHash={TX_HASHES.betaneutral}
              label="Open the pair · 2 signatures →"
              onExecute={onExecute}
            />
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
            <ExecuteAction
              executed={executed}
              txHash={TX_HASHES.perp}
              label="Open the position →"
              onExecute={onExecute}
            />
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
            <ExecuteAction
              executed={executed}
              txHash={TX_HASHES.swap}
              label="Execute the swap →"
              onExecute={onExecute}
            />
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
            Your book currently carries <strong>+{NET_DELTA_ETH.toFixed(2)} ETH</strong> of net directional delta,
            and stETH plus PT weETH make up <strong>{STAKING_CONCENTRATION_PCT}%</strong> of the portfolio in
            liquid staking and restaking risk. A partial short on Hyperliquid brings the delta close to flat without
            touching either yield leg.
          </p>
          <div style={orderStyle}>
            <OrderRow label="Short" value="ETH PERP · Hyperliquid · $13,000 · 1.0x" />
            <OrderRow label="Resulting net delta" value="≈0.02 ETH" valueColor="var(--risk-good)" />
            <OrderRow label="Est. cost of carry" value="-1.1% annualized" />
            <ExecuteAction executed={executed} txHash={TX_HASHES.hedge} label="Open the hedge →" onExecute={onExecute} />
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
