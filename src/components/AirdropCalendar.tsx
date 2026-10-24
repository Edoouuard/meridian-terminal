"use client";

import { AskButton } from "@/components/AskButton";
import { AIRDROPS_COMPILED, upcomingPrograms } from "@/lib/markets/airdrops";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function inLabel(next: Date, now: number): string {
  const h = Math.max(0, Math.round((next.getTime() - now) / 3_600_000));
  return h < 24 ? `in ${h} h` : `in ${Math.round(h / 24)} d`;
}

/**
 * Perp DEX points programs, soonest weekly drop first (lib/markets/airdrops.ts,
 * a curated list: no API publishes these). Venues Meridian trades say so.
 */
export function AirdropCalendar({ now }: { now: number }) {
  const rows = upcomingPrograms(new Date(now));
  return (
    <section className="panel-card" style={{ gap: 0 }}>
      <div className="panel-card__head">
        <h6 className="panel-card__title">Points programs</h6>
        <span className="text-muted" style={{ fontSize: 11 }}>curated · {AIRDROPS_COMPILED}</span>
      </div>
      {rows.map(({ program: p, next }) => (
        <div key={p.venue} className="drop-row">
          <div className="drop-row__head">
            <span className="drop-row__venue">
              {p.url ? (
                <a href={p.url} target="_blank" rel="noreferrer">
                  {p.venue}
                </a>
              ) : (
                p.venue
              )}
              {p.meridian && <span className="tag tag-accent drop-row__tag">On Meridian</span>}
            </span>
            <span className="drop-row__when">{next ? `${DAYS[next.getUTCDay()]} · ${inLabel(next, now)}` : p.endsOn ? `ends ${p.endsOn}` : "no fixed day"}</span>
          </div>
          <div className="drop-row__meta text-muted">
            {p.program} · {p.weeklyPool} pts/wk · earns {p.earns.join(", ")}
          </div>
          {p.note && <p className="drop-row__note text-muted">{p.note}</p>}
          {p.meridian && <AskButton label="Farm it neutral" prompt={`Farm ${p.venue}'s points with a delta-neutral position (volume and open interest) without taking price risk. What size and cost per week?`} />}
        </div>
      ))}
      <p className="text-muted" style={{ fontSize: 10, margin: "var(--space-2) 0 0" }}>
        Weekly drop days from each program&apos;s public pages (UTC). Programs change week to week, and points are not a promise of a token.
      </p>
    </section>
  );
}
