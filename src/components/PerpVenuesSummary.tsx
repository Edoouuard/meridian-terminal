"use client";

import { useAccount } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { useExtendedAccount } from "@/hooks/useExtendedAccount";
import { useSharedHlEnv } from "@/hooks/useHyperliquidEnv";
import { hyperliquidEnv } from "@/lib/integrations/hyperliquid-live";
import { loadAgent } from "@/lib/integrations/hyperliquidTrade";
import { loadTxflowAgent } from "@/lib/integrations/txflowTrade";
import { TXFLOW_NETWORK, fetchTxflowAccount } from "@/lib/integrations/txflow-live";
import { fmtUsd } from "@/lib/data";

/** Anchors of the venue panels in Tools, so the summary can jump to each. */
export const VENUE_ANCHOR = { hyperliquid: "venue-hyperliquid", extended: "venue-extended", txflow: "venue-txflow", ondo: "venue-ondo", lighter: "venue-lighter" } as const;

type Status = { label: string; tone: "good" | "idle" };

function Row({ name, status, note, anchor }: { name: string; status: Status; note?: string; anchor: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, padding: "3px 0" }}>
      <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: status.tone === "good" ? "var(--risk-good, #27ae60)" : "var(--color-neutral-400, #999)" }} />
      <span style={{ fontWeight: 600, minWidth: 82 }}>{name}</span>
      <span className="text-muted" style={{ flex: 1 }}>
        {status.label}
        {note ? ` · ${note}` : ""}
      </span>
      <button
        type="button"
        className="btn btn-secondary"
        style={{ fontSize: 10, padding: "2px 8px" }}
        onClick={() => document.getElementById(anchor)?.scrollIntoView({ behavior: "smooth", block: "start" })}
      >
        {status.tone === "good" ? "Open" : "Connect"}
      </button>
    </div>
  );
}

/**
 * The perp venues at a glance, at the top of Tools: which ones this wallet
 * can trade on now (trading key approved, account connected) and a jump to
 * each panel to connect the others.
 */
export function PerpVenuesSummary() {
  const { address } = useAccount();
  const hlEnvName = useSharedHlEnv();
  const extended = useExtendedAccount();
  const tx = useQuery({ queryKey: ["txflow-account", TXFLOW_NETWORK, address], queryFn: () => fetchTxflowAccount(address as Address), enabled: !!address, staleTime: 30_000 });
  if (!address) return null;

  const hlKey = loadAgent(address, hyperliquidEnv(hlEnvName === "testnet"));
  const txKey = loadTxflowAgent(address);
  const connected = (on: boolean, yes: string, no: string): Status => (on ? { label: yes, tone: "good" } : { label: no, tone: "idle" });

  return (
    <section className="panel-card">
      <h6 className="panel-card__title">Perp venues</h6>
      <Row name="Hyperliquid" anchor={VENUE_ANCHOR.hyperliquid} status={connected(!!hlKey, "Connected", "Trading key not approved yet")} note={hlEnvName === "testnet" ? "testnet" : undefined} />
      <Row name="Extended" anchor={VENUE_ANCHOR.extended} status={connected(!!extended, `Connected · ${extended?.network ?? ""}`, "Not connected")} />
      <Row
        name="TxFlow"
        anchor={VENUE_ANCHOR.txflow}
        status={connected(!!txKey, "Connected", "Not connected")}
        note={tx.data ? `${fmtUsd(tx.data.withdrawable)} free` : undefined}
      />
      <Row name="Ondo" anchor={VENUE_ANCHOR.ondo} status={{ label: "Via LI.FI, set up below", tone: "idle" }} />
      <Row name="Lighter" anchor={VENUE_ANCHOR.lighter} status={{ label: "Via LI.FI, set up below", tone: "idle" }} />
    </section>
  );
}
