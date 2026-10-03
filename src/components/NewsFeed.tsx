"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AlphaEntry, AlphaTag } from "@/app/api/alpha/route";
import { ChainOverview } from "@/components/ChainOverview";

const ALPHA_TAG_CLASS: Record<AlphaTag, string> = {
  "New protocol": "tag-neutral",
  Momentum: "tag-accent",
};

/**
 * Ticks every 5s so a "live · updated Xs ago" line stays truthful between
 * refetches instead of freezing at whatever it read on mount — the fastest
 * way for someone staring at the tab to tell "genuinely live, just quiet"
 * apart from "actually stuck", without having to trust the label alone.
 */
function useNowTick(intervalMs = 5000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function fmtAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const s = Math.round(ms / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)}m ago`;
}

function useAlpha() {
  return useQuery<AlphaEntry[]>({
    queryKey: ["alpha"],
    queryFn: async () => {
      const res = await fetch("/api/alpha", { cache: "no-store" });
      if (!res.ok) throw new Error("alpha fetch failed");
      return res.json();
    },
    staleTime: 10 * 60_000,
  });
}

/**
 * The "Chains / Alpha" column — Meridian's pitch is being the overlay across
 * every DeFi protocol/chain it supports, so this slot leads with exactly
 * that live coverage (ChainOverview) rather than a Hyperliquid-only market
 * ticker. (This replaced an earlier "Market"/"News" tab that only ever
 * covered Hyperliquid perps — too narrow for what this column should show.)
 *   - Chains: live chain x protocol TVL coverage from DefiLlama (see
 *     ChainOverview / /api/chains).
 *   - Alpha: newly-listed protocols and 7-day TVL momentum, derived from
 *     DefiLlama's free /protocols API (see /api/alpha) — real `listedAt` and
 *     `change_7d` fields, not editorialized "points farm" / "airdrop rumor"
 *     content, since there is no honest free source for that.
 * When the Alpha feed is down, the tab says so instead of falling back to
 * stale content that looks live but isn't.
 */
export function NewsFeed() {
  const [tab, setTab] = useState<"chains" | "alpha">("chains");
  const now = useNowTick();

  const alpha = useAlpha();
  const alphaEntries = alpha.data ?? [];

  return (
    <>
      <div className="seg" style={{ marginBottom: "var(--space-2)" }}>
        <label className="seg-opt">
          <input type="radio" name="feed-tab" checked={tab === "chains"} onChange={() => setTab("chains")} />
          <span>Chains</span>
        </label>
        <label className="seg-opt">
          <input type="radio" name="feed-tab" checked={tab === "alpha"} onChange={() => setTab("alpha")} />
          <span>Alpha</span>
        </label>
      </div>

      {tab === "chains" ? (
        <ChainOverview hideDivider />
      ) : (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {alphaEntries.length > 0 ? (
            alphaEntries.map((a, i) => (
              <div key={i} style={{ padding: "var(--space-2) 0", borderBottom: "1px solid var(--color-divider)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <span className={`tag ${ALPHA_TAG_CLASS[a.tag]}`} style={{ marginBottom: 4 }}>
                    {a.protocol}
                  </span>
                  <span
                    style={{
                      fontSize: 12,
                      fontVariantNumeric: "tabular-nums",
                      color: a.metric.startsWith("-") ? "var(--risk-serious)" : "var(--color-accent-700)",
                    }}
                  >
                    {a.metric}
                  </span>
                </div>
                <p style={{ margin: "4px 0 0", fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase" }} className="text-muted">
                  {a.tag}
                </p>
                <p style={{ margin: "4px 0 0", fontSize: 13, lineHeight: 1.4 }}>{a.text}</p>
              </div>
            ))
          ) : (
            <p className="text-muted" style={{ fontSize: 12, margin: "var(--space-2) 0 0" }}>
              {alpha.isLoading ? "Fetching live protocol data…" : "No live alpha right now — DefiLlama's protocol feed is unreachable."}
            </p>
          )}
          <p className="text-muted" style={{ fontSize: 10, margin: "var(--space-2) 0 0" }}>
            New listings and 7-day TVL momentum from DefiLlama&apos;s free API — not editorial calls.
            {alphaEntries.length > 0 && ` · live · updated ${fmtAge(now - alpha.dataUpdatedAt)}`}
          </p>
        </div>
      )}
    </>
  );
}
