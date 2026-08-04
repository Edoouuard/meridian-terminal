"use client";

import { useState } from "react";
import { ALPHA, NEWS, type AlphaTag, type NewsItem, type ThreadType } from "@/lib/data";
import type { LiveFeedState } from "@/hooks/useLiveFeed";

const ALPHA_TAG_CLASS: Record<AlphaTag, string> = {
  "New protocol": "tag-neutral",
  "Points farm": "tag-accent",
  "Airdrop rumor": "tag-outline",
};

function fmtUsdCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtPct(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

/**
 * The "DeFi news / Alpha" column. When a live feed is available it renders a
 * funding-rate strip plus a top-movers market brief derived from Hyperliquid's
 * metaAndAssetCtxs (markPx/prevDayPx change, dayNtlVlm as flow proxy). When the
 * feed is unavailable (loading or errored), it falls back to the static
 * NEWS / ALPHA demo data so the UI never breaks.
 */
export function NewsFeed({ feed, onAddThread }: { feed: LiveFeedState; onAddThread: (type: ThreadType) => void }) {
  const [tab, setTab] = useState<"news" | "alpha">("news");

  const isLive = !feed.loading && !!feed.data && feed.data.funding.length > 0;

  const liveNews: NewsItem[] = feed.data?.highlights?.movers.map((m) => ({
    protocol: m.coin,
    metric: fmtPct(m.changePct),
    text: `${m.coin} is ${Math.abs(m.changePct).toFixed(1)}% on the 24h with ${fmtUsdCompact(m.dayNtlVlm)} in traded notional — Hyperliquid perp feed.`,
  })) ?? [];

  return (
    <>
      <h6 style={{ color: "var(--color-accent)" }}>{tab === "news" ? "DeFi news" : "Alpha"}</h6>
      <div className="seg" style={{ marginBottom: "var(--space-2)" }}>
        <label className="seg-opt">
          <input type="radio" name="feed-tab" checked={tab === "news"} onChange={() => setTab("news")} />
          <span>News</span>
        </label>
        <label className="seg-opt">
          <input type="radio" name="feed-tab" checked={tab === "alpha"} onChange={() => setTab("alpha")} />
          <span>Alpha</span>
        </label>
      </div>

      {tab === "news" ? (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {/* Live funding-rate strip (only when the funding feed is up). */}
          {isLive && feed.data?.funding && feed.data.funding.length > 0 && (
            <div className="card" style={{ gap: 4, padding: "var(--space-2)", marginBottom: "var(--space-2)" }}>
              <p style={{ margin: 0, fontSize: 11, fontWeight: 600, fontFamily: "var(--font-heading)" }}>
                Funding rates (annualized)
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                {feed.data.funding.slice(0, 6).map((f) => (
                  <div key={f.coin} style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                    <span className="text-muted">{f.coin}</span>
                    <span style={{ fontVariantNumeric: "tabular-nums", color: f.annualizedPct >= 0 ? "var(--color-accent-700)" : "var(--risk-serious)" }}>
                      {fmtPct(f.annualizedPct)}
                    </span>
                  </div>
                ))}
              </div>
              <p style={{ margin: "4px 0 0", fontSize: 10 }} className="text-muted">
                live · refreshes every 60s
              </p>
            </div>
          )}

          {/* Live top movers when the feed is up, else static NEWS. */}
          {isLive && liveNews.length > 0
            ? liveNews.map((n, i) => <NewsRow key={i} n={n} onDiscuss={onAddThread} />)
            : NEWS.map((n, i) => <NewsRow key={i} n={n} onDiscuss={onAddThread} />)}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {ALPHA.map((a, i) => (
            <div key={i} style={{ padding: "var(--space-2) 0", borderBottom: "1px solid var(--color-divider)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span className={`tag ${ALPHA_TAG_CLASS[a.tag]}`} style={{ marginBottom: 4 }}>
                  {a.protocol}
                </span>
                <span style={{ fontSize: 12, fontVariantNumeric: "tabular-nums", color: "var(--color-accent-700)" }}>{a.metric}</span>
              </div>
              <p style={{ margin: "4px 0 0", fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase" }} className="text-muted">
                {a.tag}
              </p>
              <p style={{ margin: "4px 0 0", fontSize: 13, lineHeight: 1.4 }}>{a.text}</p>
              {a.action && (
                <a
                  href="#"
                  style={{ textDecoration: "none", fontSize: 12 }}
                  onClick={(e) => {
                    e.preventDefault();
                    onAddThread(a.action as ThreadType);
                  }}
                >
                  Add to thread →
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function NewsRow({ n, onDiscuss }: { n: NewsItem; onDiscuss: (type: ThreadType) => void }) {
  return (
    <div style={{ padding: "var(--space-2) 0", borderBottom: "1px solid var(--color-divider)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span className="tag tag-accent" style={{ marginBottom: 4 }}>
          {n.protocol}
        </span>
        <span style={{ fontSize: 12, fontVariantNumeric: "tabular-nums", color: "var(--color-accent-700)" }}>{n.metric}</span>
      </div>
      <p style={{ margin: "4px 0 0", fontSize: 13, lineHeight: 1.4 }}>{n.text}</p>
      {n.action && (
        <a
          href="#"
          style={{ textDecoration: "none", fontSize: 12 }}
          onClick={(e) => {
            e.preventDefault();
            onDiscuss(n.action as ThreadType);
          }}
        >
          Discuss →
        </a>
      )}
    </div>
  );
}
