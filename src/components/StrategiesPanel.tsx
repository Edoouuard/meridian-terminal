"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import type { Opportunity } from "@/lib/protocols/opportunities";
import { explorerUrlFor } from "@/lib/explorer";
import { fmtPct } from "@/lib/strategyView";
import {
  deployedUsd,
  earningLeg,
  estimatedEarnedUsd,
  legState,
  liveSince,
  matchOpportunity,
  removeStrategy,
  useTrackedStrategies,
  type TrackedStrategy,
} from "@/lib/strategyTracker";
import { AskButton } from "@/components/AskButton";

function fmtUsd(v: number): string {
  if (Math.abs(v) >= 1000) return `$${Math.round(v).toLocaleString("en-US")}`;
  return `$${v.toFixed(2)}`;
}

function fmtAge(from: number, now: number): string {
  const mins = Math.max(0, Math.round((now - from) / 60000));
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** Live rates for every kind of asset a strategy can earn on (same feed as the Yields tab). */
function useAllOpportunities(enabled: boolean) {
  return useQuery<Opportunity[]>({
    queryKey: ["opportunities", "all-kinds"],
    queryFn: async () => {
      const kinds = ["stable", "eth", "hype"];
      const lists = await Promise.all(
        kinds.map((k) => fetch(`/api/opportunities?kind=${k}&limit=60`).then((r) => (r.ok ? (r.json() as Promise<Opportunity[]>) : []))),
      );
      return lists.flat();
    },
    enabled,
    staleTime: 10 * 60_000,
  });
}

function StrategyCard({ s, opps, now }: { s: TrackedStrategy; opps: Opportunity[]; now: number }) {
  const done = s.legs.filter((l) => l.status === "confirmed").length;
  const since = liveSince(s);
  const live = since !== undefined;
  const size = deployedUsd(s);
  const earned = estimatedEarnedUsd(s, now);
  const today = s.apyKind === "variable" ? matchOpportunity(s, opps) : undefined;
  const drift = today && s.apyPct !== undefined ? today.apy - s.apyPct : undefined;
  const leg = earningLeg(s);
  const reviewPrompt =
    `Review my live strategy "${s.title}": ${s.legs.map((l) => `${l.side} ${l.asset} on ${l.protocol}${l.chain ? ` (${l.chain})` : ""}`).join(", ")}` +
    `${size ? `, about $${Math.round(size)}` : ""}${s.apyPct !== undefined ? `, entered at ${fmtPct(s.apyPct)} APY` : ""}. Is it still the best option, and should I change anything?`;

  return (
    <article className={`strat-card${live ? " strat-card--live" : ""}`}>
      <header className="strat-card__head">
        <div>
          <h6 className="strat-card__title">{s.title}</h6>
          <span className="text-muted strat-card__sub">
            {leg ? `${leg.protocol}${leg.chain ? ` · ${leg.chain}` : ""} · ` : ""}
            {live ? `live since ${fmtAge(since as number, now)}` : `started ${fmtAge(s.createdAt, now)}`}
          </span>
        </div>
        <span className={`strat-chip${live ? " strat-chip--live" : ""}`}>
          {live ? (
            <>
              <span className="live-dot" aria-hidden="true" /> Live
            </>
          ) : (
            `${done}/${s.legs.length} steps`
          )}
        </span>
      </header>

      {!live && (
        <div className="strat-progress" aria-label={`${done} of ${s.legs.length} steps confirmed`}>
          <div style={{ width: `${(done / s.legs.length) * 100}%` }} />
        </div>
      )}

      <dl className="strat-metrics">
        {size !== undefined && (
          <div>
            <dt>Size</dt>
            <dd>{fmtUsd(size)}</dd>
          </div>
        )}
        {s.apyPct !== undefined && (
          <div>
            <dt>{s.apyKind === "fixed" ? "Fixed APY" : "Entry APY"}</dt>
            <dd>{fmtPct(s.apyPct)}</dd>
          </div>
        )}
        {today && (
          <div>
            <dt>Today</dt>
            <dd className={drift !== undefined && drift < -0.5 ? "strat-down" : drift !== undefined && drift > 0.5 ? "strat-up" : undefined}>
              {fmtPct(today.apy)}
            </dd>
          </div>
        )}
        {earned !== undefined && (
          <div>
            <dt>Earned (est.)</dt>
            <dd className="strat-up">+{fmtUsd(earned)}</dd>
          </div>
        )}
      </dl>

      {drift !== undefined && drift < -1 && (
        <p className="strat-alert">
          The rate dropped {Math.abs(drift).toFixed(1)} points since you entered. Worth a review.
        </p>
      )}

      <ol className="strat-legs">
        {s.legs.map((l, i) => {
          const state = legState(s, i);
          return (
          <li key={i} className={state === "confirmed" ? "is-done" : state === "skipped" ? "is-skipped" : undefined}>
            <span className="strat-legs__mark" aria-hidden="true">{state === "confirmed" ? "✓" : state === "skipped" ? "–" : i + 1}</span>
            <span className="strat-legs__label">
              {l.side} {l.asset} · {l.protocol}
              {l.chain ? ` · ${l.chain}` : ""}
            </span>
            {l.hash && l.chainId ? (
              <a href={explorerUrlFor(l.chainId, l.hash as `0x${string}`)} target="_blank" rel="noreferrer" className="strat-legs__tx">
                tx ↗
              </a>
            ) : (
              <span className="text-muted strat-legs__tx">{state === "skipped" ? "not needed" : state === "pending" ? "to do" : ""}</span>
            )}
          </li>
          );
        })}
      </ol>

      <footer className="strat-card__foot">
        <AskButton prompt={reviewPrompt} label={live ? "Review with Meridian" : "Finish with Meridian"} />
        <button
          type="button"
          className="strat-remove"
          onClick={() => {
            if (window.confirm("Stop tracking this strategy? Your positions on-chain are not affected.")) removeStrategy(s.id);
          }}
        >
          Stop tracking
        </button>
      </footer>
    </article>
  );
}

/**
 * Strategies tab: every strategy the user has put to work from the chat, with
 * its steps and transactions, today's rate against the entry rate, and a rough
 * estimate of what it has earned since it went live.
 */
export function StrategiesPanel() {
  const { address } = useAccount();
  const strategies = useTrackedStrategies(address);
  const { data: opps = [] } = useAllOpportunities(strategies.length > 0);
  const [now, setNow] = useState(() => Date.now());

  // Keep "earned" and ages ticking.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  if (strategies.length === 0) {
    return (
      <section className="panel-card">
        <h6 className="panel-card__title">Your strategies</h6>
        <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>
          Strategies you execute from the chat show up here, step by step, with their transactions, today&apos;s rate and what they&apos;ve earned so far.
        </p>
        <AskButton prompt="Find me the best yield for my stablecoins" label="Find a strategy" />
      </section>
    );
  }

  const live = strategies.filter((s) => liveSince(s) !== undefined);
  const totalSize = live.reduce((sum, s) => sum + (deployedUsd(s) ?? 0), 0);
  const totalYearly = live.reduce((sum, s) => sum + ((deployedUsd(s) ?? 0) * (s.apyPct ?? 0)) / 100, 0);

  return (
    <div className="strat-list">
      {live.length > 0 && (
        <section className="panel-card strat-summary">
          <div>
            <span className="strat-summary__label">Live</span>
            <span className="strat-summary__value">{live.length}</span>
          </div>
          {totalSize > 0 && (
            <div>
              <span className="strat-summary__label">Deployed</span>
              <span className="strat-summary__value">{fmtUsd(totalSize)}</span>
            </div>
          )}
          {totalYearly > 0 && (
            <div>
              <span className="strat-summary__label">Per year</span>
              <span className="strat-summary__value strat-up">{fmtUsd(totalYearly)}</span>
            </div>
          )}
        </section>
      )}
      {strategies.map((s) => (
        <StrategyCard key={s.id} s={s} opps={opps} now={now} />
      ))}
    </div>
  );
}
