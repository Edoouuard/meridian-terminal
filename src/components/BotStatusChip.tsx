"use client";

import { useEffect, useState } from "react";
import { useBotState } from "@/lib/neutralBot/store";
import { botHealth } from "@/lib/neutralBot/health";

const short = (n: number) => (n >= 10_000 ? `$${(n / 1000).toFixed(0)}k` : n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(0)}`);

/**
 * The neutral bot in the top bar, while it runs or holds a pair: its state
 * and the volume it made, one click from its view, wherever the user is.
 */
export function BotStatusChip({ onOpen }: { onOpen: () => void }) {
  const s = useBotState();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);
  if (!s.running && !s.stats.openedAt && !s.stats.stopReason) return null;
  const h = botHealth(s, now);
  return (
    <button type="button" className={`bot-chip bot-chip--${h.tone}`} onClick={onOpen} title={h.detail}>
      <span className="bot-pill__dot" aria-hidden />
      Bot · {h.label} · {s.cfg.base} · {short(s.stats.volumeUsd)} vol
    </button>
  );
}
