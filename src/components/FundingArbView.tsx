"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AskButton } from "@/components/AskButton";
import { fundingArbPrompt, HOLD_DAYS, PER_LEG_USD, type FundingArb, type FundingLeg } from "@/lib/markets/fundingArb";

const pctYr = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(1)}%/yr`;
const usd = (x: number) => `${x >= 0 ? "+" : "−"}$${Math.abs(x).toFixed(0)}`;

function LegLine({ side, leg, earnsPct }: { side: "Long" | "Short"; leg: FundingLeg; earnsPct: number }) {
  // A long earns −rate, a short +rate: the 7-day figure flips the same way.
  const earns7d = leg.rate7dPct === null ? null : side === "Long" ? -leg.rate7dPct : leg.rate7dPct;
  return (
    <div className="farb-leg">
      <span className={`farb-leg__side farb-leg__side--${side.toLowerCase()}`}>{side}</span>
      <span className="farb-leg__venue">
        {leg.venue} <span className="text-muted">{leg.market}</span>
      </span>
      <span className={earnsPct >= 0 ? "farb-pos" : "farb-neg"}>
        {earnsPct >= 0 ? "receives" : "pays"} {Math.abs(earnsPct).toFixed(1)}%/yr
      </span>
      <span className="text-muted">7d {earns7d === null ? "n/a" : pctYr(earns7d)}</span>
    </div>
  );
}

/**
 * Funding-rate arbitrage across the venues Meridian trades: the same
 * quantity long on one venue and short on another, earning the funding
 * difference. Ranked on the last 7 days' realised funding, net of fees
 * (/api/funding-arb, lib/markets/fundingArb.ts).
 */
export function FundingArbView() {
  const [showAll, setShowAll] = useState(false);
  const { data, isLoading } = useQuery<{ fetchedAt: string; pairs: FundingArb[] }>({
    queryKey: ["funding-arb"],
    queryFn: async () => {
      const res = await fetch("/api/funding-arb");
      if (!res.ok) throw new Error("funding arb fetch failed");
      return res.json();
    },
    refetchInterval: 5 * 60_000,
    staleTime: 2 * 60_000,
  });
  const pairs = data?.pairs ?? [];
  const rows = pairs.slice(0, showAll ? 12 : 4);

  return (
    <section className="panel-card farb-card">
      <div className="panel-card__head">
        <h6 className="panel-card__title">Funding arbitrage</h6>
        <span className="text-muted" style={{ fontSize: 11 }}>{isLoading ? "reading…" : `${pairs.length} pairs`}</span>
      </div>
      <p className="text-muted farb-card__sub">
        Same quantity long on one venue, short on another: price moves cancel, you keep the funding the short receives minus what the long pays.
        Ranked on the last 7 days&apos; realised funding (today&apos;s rate alone often sits on a cap or spikes for an hour), net of taker fees to
        open and close both legs. Figures for ${PER_LEG_USD.toLocaleString("en-US")} per leg held {HOLD_DAYS} days.
      </p>

      {rows.length > 0 ? (
        <ul className="farb-list">
          {rows.map((a) => {
            const spread = a.spread7dPct ?? a.spreadNowPct;
            const fundingUsd = (spread / 100) * PER_LEG_USD * (HOLD_DAYS / 365);
            const feesUsd = (a.roundTripFeePct / 100) * PER_LEG_USD;
            return (
              <li key={`${a.base}-${a.long.venue}-${a.short.venue}`} className="farb-row">
                <div className="farb-row__head">
                  <span className="farb-row__base">{a.base}</span>
                  <span className={`farb-row__net ${a.netHoldPct >= 0 ? "farb-pos" : "farb-neg"}`}>
                    {usd(fundingUsd - feesUsd)} <span className="text-muted">net · {HOLD_DAYS}d</span>
                  </span>
                </div>
                <LegLine side="Long" leg={a.long} earnsPct={a.longEarnsPct} />
                <LegLine side="Short" leg={a.short} earnsPct={a.shortEarnsPct} />
                <div className="farb-row__meta">
                  <span>
                    Spread {pctYr(a.spreadNowPct)} now · {a.spread7dPct === null ? "no 7d history (TxFlow)" : `${pctYr(a.spread7dPct)} over 7d`}
                  </span>
                  <span>
                    Funding {usd(fundingUsd)} − fees ${feesUsd.toFixed(0)}
                    {a.breakEvenDays !== null ? ` · pays back in ${a.breakEvenDays < 1 ? "<1" : Math.ceil(a.breakEvenDays)} d` : ""}
                  </span>
                  <span title="Short's price minus long's. Positive: you also gain it if the two venues' prices converge; it can widen too.">
                    Price gap {a.priceGapPct >= 0 ? "+" : "−"}
                    {Math.abs(a.priceGapPct).toFixed(3)}%
                  </span>
                </div>
                <AskButton label="Open the pair" prompt={fundingArbPrompt(a)} />
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>
          {isLoading ? "Reading funding on Hyperliquid, Extended and TxFlow…" : "No pair pays after fees over the last 7 days right now."}
        </p>
      )}
      {pairs.length > 4 && (
        <button type="button" className="btn btn-secondary bot-mini" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Show fewer" : `Show ${Math.min(pairs.length, 12) - 4} more`}
        </button>
      )}
      <p className="text-muted" style={{ fontSize: 10, margin: 0 }}>
        Risks: the spread can flip (funding is reset every hour), the price gap between venues can widen, and a leg can be liquidated if the price runs
        while the other leg&apos;s profit sits on another venue. Keep leverage low and margin on both sides.
      </p>
    </section>
  );
}
