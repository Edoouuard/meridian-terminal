"use client";

import { useQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import { useSharedHlEnv } from "@/hooks/useHyperliquidEnv";
import { useExtendedAccount } from "@/hooks/useExtendedAccount";
import { fetchClearinghouseState, fetchOpenOrders, HIP3_MAIN_DEX, hyperliquidEnv } from "@/lib/integrations/hyperliquid-live";
import { fetchExtendedPositionViews } from "@/lib/integrations/extended-live";
import {
  liqDistancePct,
  roePct,
  rowsFromExtended,
  rowsFromHyperliquid,
  summarize,
  type PerpPositionRow,
} from "@/lib/perpPositions";

/** Signed USD with cents under $1k: +$0.79, −$12.40, $1,204. */
function fmtMoney(n: number, signed = false): string {
  const sign = n < 0 ? "−" : signed && n > 0 ? "+" : "";
  const abs = Math.abs(n);
  const body = abs >= 100 ? Math.round(abs).toLocaleString("en-US") : abs.toFixed(2);
  return `${sign}$${body}`;
}

function fmtPx(n: number): string {
  if (!(n > 0)) return "—";
  if (n >= 1000) return Math.round(n).toLocaleString("en-US");
  return n >= 100 ? n.toFixed(1) : n >= 1 ? n.toFixed(2) : n.toPrecision(4);
}

const pnlColor = (n: number) => (n > 0 ? "var(--risk-good)" : n < 0 ? "var(--risk-serious)" : undefined);

function liqColor(d: number | null): string | undefined {
  if (d === null) return undefined;
  if (d < 10) return "var(--risk-serious)";
  if (d < 25) return "var(--risk-warning)";
  return undefined;
}

const VENUE_SHORT: Record<PerpPositionRow["venue"], string> = {
  Hyperliquid: "HL",
  "Hyperliquid stocks": "HL · stocks",
  Extended: "Extended",
};

function Stat({ label, value, color, hint }: { label: string; value: string; color?: string; hint?: string }) {
  return (
    <div style={{ minWidth: 0 }} title={hint}>
      <div className="text-muted" style={{ fontSize: 10 }}>
        {label}
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, fontVariantNumeric: "tabular-nums", color }}>{value}</div>
    </div>
  );
}

function PositionRow({ row }: { row: PerpPositionRow }) {
  const roe = roePct(row);
  const liq = liqDistancePct(row);
  return (
    <div style={{ padding: "7px 0", borderBottom: "1px solid var(--color-divider)", fontSize: 12, display: "flex", flexDirection: "column", gap: 2 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 6 }}>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          <strong style={{ fontFamily: "var(--font-heading)" }}>{row.symbol}</strong>{" "}
          <span style={{ color: row.side === "long" ? "var(--risk-good)" : "var(--risk-serious)", fontWeight: 600, fontSize: 11 }}>
            {row.side.toUpperCase()} {row.leverage}x
          </span>{" "}
          <span className="text-muted" style={{ fontSize: 10 }}>
            {VENUE_SHORT[row.venue]}
          </span>
        </span>
        <span style={{ flex: "none", fontVariantNumeric: "tabular-nums", color: pnlColor(row.unrealizedPnl), fontWeight: 600 }}>
          {fmtMoney(row.unrealizedPnl, true)}
          {roe !== null && <span style={{ fontWeight: 400, fontSize: 11 }}> ({roe >= 0 ? "+" : ""}{roe.toFixed(1)}%)</span>}
        </span>
      </div>
      <div className="text-muted" style={{ fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
        {fmtMoney(row.notional)} · {fmtPx(row.entry)} → {fmtPx(row.mark)}
      </div>
      <div className="text-muted" style={{ display: "flex", justifyContent: "space-between", gap: 6, fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
        <span style={{ color: liqColor(liq) }}>
          liq {fmtPx(row.liq)}
          {liq !== null && ` (${liq.toFixed(0)}% away)`}
        </span>
        <span>
          funding{" "}
          {row.funding === null ? "—" : <span style={{ color: pnlColor(row.funding) }}>{fmtMoney(row.funding, true)}</span>}
        </span>
      </div>
      {(row.stopLoss || row.takeProfit) && (
        <div className="text-muted" style={{ fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
          {row.stopLoss ? `SL ${fmtPx(row.stopLoss)}` : "no SL"} · {row.takeProfit ? `TP ${fmtPx(row.takeProfit)}` : "no TP"}
        </div>
      )}
    </div>
  );
}

/**
 * Perp positions across venues (Hyperliquid, its HIP-3 stocks dex, Extended)
 * with open PnL, funding since open, liquidation distance and SL/TP, so a
 * trader sees how every position is doing without opening each venue.
 * Read-only; closing and order edits live in Tools → each venue's panel.
 */
export function PerpPositionsPanel() {
  const { address, isConnected } = useAccount();
  const hlEnvName = useSharedHlEnv();
  const extended = useExtendedAccount();

  const hl = useQuery({
    queryKey: ["perp-panel-hl", address, hlEnvName],
    enabled: !!address,
    refetchInterval: 15_000,
    queryFn: async () => {
      const env = hyperliquidEnv(hlEnvName === "testnet");
      const [main, mainOrders, stocks, stockOrders] = await Promise.all([
        fetchClearinghouseState(address!, env),
        fetchOpenOrders(address!, env),
        fetchClearinghouseState(address!, env, HIP3_MAIN_DEX).catch(() => null),
        fetchOpenOrders(address!, env, HIP3_MAIN_DEX).catch(() => []),
      ]);
      return [...rowsFromHyperliquid(main, mainOrders, "Hyperliquid"), ...rowsFromHyperliquid(stocks, stockOrders, "Hyperliquid stocks")];
    },
  });

  const ext = useQuery({
    queryKey: ["perp-panel-extended", extended?.apiKey, extended?.network],
    enabled: !!extended,
    refetchInterval: 15_000,
    queryFn: async () => rowsFromExtended(await fetchExtendedPositionViews(extended!)),
  });

  const rows = [...(hl.data ?? []), ...(ext.data ?? [])].sort((a, b) => b.notional - a.notional);
  const s = summarize(rows);
  const loading = (hl.isLoading && !!address) || (ext.isLoading && !!extended);
  const errors = [hl.error && "Hyperliquid", ext.error && "Extended"].filter(Boolean);

  return (
    <section className="panel-card">
      <div className="panel-card__head">
        <h6 className="panel-card__title">Perp positions</h6>
        <span className="text-muted" style={{ fontSize: 11 }}>
          {loading ? "loading…" : rows.length > 0 ? `${rows.length} open · live` : ""}
        </span>
      </div>

      {!isConnected ? (
        <p className="text-muted" style={{ fontSize: 12, margin: "var(--space-2) 0 0" }}>
          Connect a wallet to follow your perp positions.
        </p>
      ) : rows.length === 0 && !loading ? (
        <p className="text-muted" style={{ fontSize: 12, margin: "var(--space-2) 0 0" }}>
          No open perp position on Hyperliquid{extended ? " or Extended" : ""}. Try &ldquo;short ETH 2x with a 20% stop&rdquo;.
        </p>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-2) var(--space-3)", marginTop: "var(--space-2)" }}>
            <Stat label="Open PnL" value={fmtMoney(s.unrealizedPnl, true)} color={pnlColor(s.unrealizedPnl)} />
            <Stat
              label="Funding"
              value={s.fundingKnown ? fmtMoney(s.funding, true) : "—"}
              color={pnlColor(s.funding)}
              hint="Funding received (+) or paid (−) since each position opened."
            />
            <Stat label="Margin" value={fmtMoney(s.margin)} hint={`Exposure ${fmtMoney(s.notional)}`} />
            <Stat
              label="Closest to liquidation"
              value={s.closestLiqPct === null ? "—" : `${s.closestLiqPct.toFixed(0)}%`}
              color={liqColor(s.closestLiqPct)}
              hint="How far the price can move against your riskiest position before liquidation."
            />
          </div>
          <div style={{ marginTop: "var(--space-2)" }}>
            {rows.map((r) => (
              <PositionRow key={r.key} row={r} />
            ))}
          </div>
        </>
      )}

      {errors.length > 0 && (
        <p style={{ fontSize: 11, margin: "6px 0 0", color: "var(--risk-warning)" }}>Couldn&apos;t read {errors.join(" and ")} just now; retrying.</p>
      )}
      {hlEnvName === "testnet" && (
        <p className="text-muted" style={{ fontSize: 10, margin: "6px 0 0" }}>
          Hyperliquid testnet
        </p>
      )}
    </section>
  );
}
