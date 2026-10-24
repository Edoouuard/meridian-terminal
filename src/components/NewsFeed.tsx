"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AlphaEntry, AlphaTag } from "@/app/api/alpha/route";
import { ChainOverview } from "@/components/ChainOverview";
import { AskButton } from "@/components/AskButton";
import { AirdropCalendar } from "@/components/AirdropCalendar";
import { newsPrompt, type NewsItem } from "@/lib/news";

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

interface NewsResponse {
  status: "ok" | "stale" | "unavailable" | "not_configured";
  items: NewsItem[];
  fetchedAt?: string;
}

function useNews(enabled: boolean) {
  return useQuery<NewsResponse>({
    queryKey: ["news"],
    queryFn: async () => {
      const res = await fetch("/api/news", { cache: "no-store" });
      if (!res.ok) throw new Error("news fetch failed");
      return res.json();
    },
    enabled,
    staleTime: 2 * 60_000,
    refetchInterval: enabled ? 5 * 60_000 : false,
  });
}

function fmtPublished(iso: string | undefined, now: number): string {
  if (!iso) return "";
  const m = Math.round((now - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(m) || m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

/** Crypto headlines (newsroom RSS feeds and NewsData.io via /api/news), each with an "Ask Meridian" about the user's positions. */
function NewsPanel({ now }: { now: number }) {
  const news = useNews(true);
  const items = news.data?.items ?? [];
  const status = news.data?.status;
  return (
    <section className="panel-card" style={{ gap: 0 }}>
      <div className="panel-card__head">
        <h6 className="panel-card__title">News</h6>
        <span className="text-muted" style={{ fontSize: 11 }}>
          {items.length > 0 ? `Live${status === "stale" ? " · delayed" : ""} · updated ${fmtAge(now - news.dataUpdatedAt)}` : ""}
        </span>
      </div>
      {items.length > 0 ? (
        items.map((n) => (
          <article key={n.id} className="news-item">
            <p className="news-item__meta text-muted">
              {n.source}
              {n.publishedAt ? ` · ${fmtPublished(n.publishedAt, now)}` : ""}
            </p>
            <a className="news-item__title" href={n.link} target="_blank" rel="noopener noreferrer">
              {n.title}
            </a>
            {n.coins.length > 0 && (
              <div className="news-item__coins">
                {n.coins.slice(0, 4).map((c) => (
                  <span key={c} className="tag tag-neutral">
                    {c}
                  </span>
                ))}
              </div>
            )}
            <AskButton label="Ask about this" prompt={newsPrompt(n)} />
          </article>
        ))
      ) : (
        <p className="text-muted" style={{ fontSize: 12, margin: "var(--space-2) 0 0" }}>
          {news.isLoading
            ? "Fetching headlines…"
            : "No headlines right now — the news sources are unreachable."}
        </p>
      )}
      <p className="text-muted" style={{ fontSize: 10, margin: "var(--space-2) 0 0" }}>
        Headlines from CoinDesk, Cointelegraph, Decrypt, The Block and Blockworks (plus NewsData.io), refreshed every 5 minutes. Not investment advice; links open the original article.
      </p>
    </section>
  );
}

/** Newly listed protocols and 7-day TVL momentum (DefiLlama via /api/alpha), then the points-program calendar. */
export function AlphaPanel({ now }: { now: number }) {
  const alpha = useAlpha();
  const alphaEntries = alpha.data ?? [];
  return (
    <>
      <section className="panel-card" style={{ gap: 0 }}>
        <div className="panel-card__head">
          <h6 className="panel-card__title">Alpha</h6>
          <span className="text-muted" style={{ fontSize: 11 }}>{alphaEntries.length > 0 ? `DefiLlama · ${fmtAge(now - alpha.dataUpdatedAt)}` : ""}</span>
        </div>
        {alphaEntries.length > 0 ? (
          alphaEntries.map((a, i) => (
            <div key={i} className="alpha-row">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span className={`tag ${ALPHA_TAG_CLASS[a.tag]}`} style={{ marginBottom: 4 }}>
                  {a.protocol}
                </span>
                <span style={{ fontSize: 12, fontVariantNumeric: "tabular-nums", color: a.metric.startsWith("-") ? "var(--risk-serious)" : "var(--risk-good)" }}>{a.metric}</span>
              </div>
              <p style={{ margin: "4px 0 0", fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase" }} className="text-muted">
                {a.tag}
              </p>
              <p style={{ margin: "4px 0 0", fontSize: 13, lineHeight: 1.4 }}>{a.text}</p>
              <AskButton label="Ask about this" prompt={`Tell me about ${a.protocol}: ${a.text} Is there a safe way to get exposure or yield from it with Meridian?`} />
            </div>
          ))
        ) : (
          <p className="text-muted" style={{ fontSize: 12, margin: "var(--space-2) 0 0" }}>
            {alpha.isLoading ? "Fetching live protocol data…" : "No new listings to show right now."}
          </p>
        )}
        <p className="text-muted" style={{ fontSize: 10, margin: "var(--space-2) 0 0" }}>
          New listings and 7-day TVL momentum from DefiLlama — data, not editorial calls.
        </p>
      </section>
      <AirdropCalendar now={now} />
    </>
  );
}

/** Chain x protocol coverage (DefiLlama via /api/chains). */
export function ChainsPanel() {
  return (
    <section className="panel-card">
      <ChainOverview hideDivider />
    </section>
  );
}

export { NewsPanel, useNowTick };
