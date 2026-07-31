"use client";

import { useEffect, useRef } from "react";
import { HERO_BACKGROUND_IMAGE } from "@/lib/heroArt";

const COLS = 4;
const ROWS = 3;

function buildShards() {
  const shards: { key: string; style: React.CSSProperties }[] = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const colCenter = col - (COLS - 1) / 2;
      const rowCenter = row - (ROWS - 1) / 2;
      const dx = colCenter * 320;
      const dy = rowCenter * 220 + 80;
      const rot = colCenter * 14 - rowCenter * 6;
      shards.push({
        key: `${row}_${col}`,
        style: {
          left: `${(col / COLS) * 100}%`,
          top: `${(row / ROWS) * 100}%`,
          width: `${100 / COLS}%`,
          height: `${100 / ROWS}%`,
          ["--dx" as string]: `${dx}px`,
          ["--dy" as string]: `${dy}px`,
          ["--rot" as string]: `${rot}deg`,
          ["--bg-pos" as string]: `${(col / (COLS - 1)) * 100}% ${(row / (ROWS - 1)) * 100}%`,
        },
      });
    }
  }
  return shards;
}

const SHARDS = buildShards();

export function RuptureHero({ children }: { children: React.ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stickyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    function update() {
      const el = containerRef.current;
      const sticky = stickyRef.current;
      if (!el || !sticky) return;
      const rect = el.getBoundingClientRect();
      const scrollable = rect.height - window.innerHeight;
      const progress = scrollable > 0 ? Math.min(1, Math.max(0, -rect.top / scrollable)) : 0;
      sticky.style.setProperty("--progress", String(progress));
      raf = requestAnimationFrame(update);
    }
    raf = requestAnimationFrame(update);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div ref={containerRef} className="rupture-container" style={{ ["--hero-image" as string]: HERO_BACKGROUND_IMAGE }}>
      <div ref={stickyRef} className="rupture-sticky">
        <div className="rupture-shatter" aria-hidden="true">
          {SHARDS.map((s) => (
            <div key={s.key} className="shard" style={s.style} />
          ))}
        </div>
        <div className="rupture-content">{children}</div>
      </div>
    </div>
  );
}
