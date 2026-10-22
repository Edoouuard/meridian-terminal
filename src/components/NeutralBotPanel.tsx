"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { useBotState } from "@/lib/neutralBot/store";
import { botHealth } from "@/lib/neutralBot/health";
import { openNeutralBotView } from "@/lib/neutralBot/bus";

const usd = (n: number) => `$${n >= 1000 ? Math.round(n).toLocaleString("en-US") : n.toFixed(2)}`;

/**
 * The neutral bot in Tools: its status at a glance and the way to its own
 * view (components/NeutralBotView), where it is configured and monitored.
 */
export function NeutralBotPanel() {
  const { address } = useAccount();
  const s = useBotState();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);
  if (!address) return null;
  const h = botHealth(s, now);
  return (
    <section className="panel-card bot-tools-card">
      <div className="panel-card__head">
        <h6 className="panel-card__title">Neutral bot</h6>
        <span className={`bot-pill bot-pill--${h.tone}`}>
          <span className="bot-pill__dot" aria-hidden />
          {h.label}
        </span>
      </div>
      <p className="text-muted" style={{ fontSize: 11, margin: "4px 0 0" }}>
        Delta-neutral volume and open interest for points and airdrops, or the funding spread, on autopilot.
        {s.stats.volumeUsd > 0 && ` ${usd(s.stats.volumeUsd)} of volume so far, ${usd(s.stats.feesUsd)} of fees.`}
      </p>
      <button type="button" className="btn btn-primary" style={{ fontSize: 12, marginTop: 8, width: "100%" }} onClick={() => openNeutralBotView()}>
        Open the neutral bot →
      </button>
    </section>
  );
}
