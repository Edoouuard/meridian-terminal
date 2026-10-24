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
  const rows = pairs.slice(0, showAll ? 12 : 6);

  return (
    <section className="farb">
      <div className="farb__intro">
        <p className="farb__lead">Earn the gap in funding between two exchanges, without betting on the price.</p>
        <p className="text-muted farb__sub">
          Estimated profit for ${PER_LEG_USD.toLocaleString("en-US")} on each side over {HOLD_DAYS} days, after fees, from the last 7 days.
        </p>
      </div>

      {rows.length > 0 ? (
        <ul className="farb-grid">
          {rows.map((a) => {
            const spread = a.spread7dPct ?? a.spreadNowPct;
            const fundingUsd = (spread / 100) * PER_LEG_USD * (HOLD_DAYS / 365);
            const feesUsd = (a.roundTripFeePct / 100) * PER_LEG_USD;
            return (
              <li key={`${a.base}-${a.long.venue}-${a.short.venue}`} className="farb-card2">
                <div className="farb-card2__top">
                  <span className="farb-card2__base">{a.base}</span>
                  <span className={`farb-card2__badge${a.basis === "7d" ? "" : " farb-card2__badge--warn"}`}>{a.basis === "7d" ? "7-day track record" : "No history yet"}</span>
                </div>
                <p className={`farb-card2__net ${a.netHoldPct >= 0 ? "farb-pos" : "farb-neg"}`}>{usd(fundingUsd - feesUsd)}</p>
                <p className="farb-card2__per">a month, on ${PER_LEG_USD.toLocaleString("en-US")} each side</p>
                <p className="farb-card2__how">
                  Buy on <strong>{a.long.venue}</strong>, short on <strong>{a.short.venue}</strong>
                </p>
                <AskButton label="Open the pair" prompt={fundingArbPrompt(a)} />
                <details className="farb-card2__details">
                  <summary>Details</summary>
                  <LegLine side="Long" leg={a.long} earnsPct={a.longEarnsPct} />
                  <LegLine side="Short" leg={a.short} earnsPct={a.shortEarnsPct} />
                  <div className="farb-row__meta">
                    <span>
                      Spread {pctYr(a.spreadNowPct)} now · {a.spread7dPct === null ? "no 7-day history (TxFlow)" : `${pctYr(a.spread7dPct)} over 7 days`}
                    </span>
                    <span>
                      Funding {usd(fundingUsd)} − fees ${feesUsd.toFixed(0)}
                      {a.breakEvenDays !== null ? ` · fees paid back in ${a.breakEvenDays < 1 ? "<1" : Math.ceil(a.breakEvenDays)} days` : ""}
                    </span>
                    <span title="Short's price minus long's. Positive: you also gain it if the two venues' prices converge; it can widen too.">
                      Price gap between venues {a.priceGapPct >= 0 ? "+" : "−"}
                      {Math.abs(a.priceGapPct).toFixed(3)}%
                    </span>
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-muted" style={{ fontSize: 14, margin: 0 }}>
          {isLoading ? "Reading funding on Hyperliquid, Extended and TxFlow…" : "No pair pays after fees over the last 7 days right now. Check back later."}
        </p>
      )}
      {pairs.length > 6 && (
        <button type="button" className="btn btn-secondary" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Show fewer" : `Show ${Math.min(pairs.length, 12) - 6} more`}
        </button>
      )}
      <details className="how-computed farb__how">
        <summary>How it works and the risks</summary>
        <p className="text-muted">
          You hold the same amount long on one exchange and short on another. When the price moves, one side gains what the other loses, so the
          price doesn&apos;t matter; what you keep is the funding the short side receives minus what the long side pays. Pairs are ranked on the last
          7 days of real funding (today&apos;s rate alone often sits on a cap or spikes for an hour), after the trading fees to open and close both
          sides. Risks: the gap can flip (funding resets every hour), the two exchanges&apos; prices can drift apart, and one side can be liquidated if
          the price runs while the other side&apos;s profit sits on the other exchange. Keep leverage low and margin on both sides.
        </p>
      </details>
    </section>
  );
}
