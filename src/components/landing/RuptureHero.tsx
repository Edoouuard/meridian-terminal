"use client";

import { useEffect, useRef, useState } from "react";
import { HERO_BACKGROUND_IMAGE, HERO_IMAGE_HEIGHT, HERO_IMAGE_WIDTH } from "@/lib/heroArt";

const COLS = 4;
const ROWS = 3;

/** How the full image is scaled and centered to cover a container without distorting it. */
function computeCoverFit(containerW: number, containerH: number) {
  const scale = Math.max(containerW / HERO_IMAGE_WIDTH, containerH / HERO_IMAGE_HEIGHT);
  const width = HERO_IMAGE_WIDTH * scale;
  const height = HERO_IMAGE_HEIGHT * scale;
  return { width, height, x: (containerW - width) / 2, y: (containerH - height) / 2 };
}

function buildShards(containerW: number, containerH: number) {
  const fit = computeCoverFit(containerW, containerH);
  const shards: { key: string; style: React.CSSProperties }[] = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const colCenter = col - (COLS - 1) / 2;
      const rowCenter = row - (ROWS - 1) / 2;
      const dx = colCenter * 210;
      const dy = rowCenter * 140 + 50;
      const rot = colCenter * 14 - rowCenter * 6;
      const shardLeft = (col / COLS) * containerW;
      const shardTop = (row / ROWS) * containerH;
      shards.push({
        key: `${row}_${col}`,
        style: {
          left: `${(col / COLS) * 100}%`,
          top: `${(row / ROWS) * 100}%`,
          width: `${100 / COLS}%`,
          height: `${100 / ROWS}%`,
          backgroundImage: HERO_BACKGROUND_IMAGE,
          backgroundSize: `${fit.width}px ${fit.height}px`,
          backgroundPosition: `${fit.x - shardLeft}px ${fit.y - shardTop}px`,
          ["--dx" as string]: `${dx}px`,
          ["--dy" as string]: `${dy}px`,
          ["--rot" as string]: `${rot}deg`,
        },
      });
    }
  }
  return shards;
}

export function RuptureHero({ children }: { children: React.ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stickyRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 1920, height: 1080 });

  useEffect(() => {
    function measure() {
      const el = stickyRef.current;
      if (!el) return;
      setSize({ width: el.clientWidth, height: el.clientHeight });
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    function update() {
      const el = containerRef.current;
      const sticky = stickyRef.current;
      if (!el || !sticky) return;
      const rect = el.getBoundingClientRect();
      // Progress spans the container's whole scroll-through distance (not just the pinned
      // portion before it releases), so the fade finishes exactly as the box scrolls out of
      // view instead of freezing at "fully faded" for a whole extra viewport height first.
      const progress = rect.height > 0 ? Math.min(1, Math.max(0, -rect.top / rect.height)) : 0;
      sticky.style.setProperty("--progress", String(progress));
      raf = requestAnimationFrame(update);
    }
    raf = requestAnimationFrame(update);
    return () => cancelAnimationFrame(raf);
  }, []);

  const shards = buildShards(size.width, size.height);

  return (
    <div ref={containerRef} className="rupture-container">
      <div ref={stickyRef} className="rupture-sticky">
        <div className="rupture-shatter" aria-hidden="true">
          {shards.map((s) => (
            <div key={s.key} className="shard" style={s.style} />
          ))}
          <div className="rupture-glow-fade" aria-hidden="true">
            <div className="rupture-glow" />
          </div>
        </div>
        <div className="rupture-scrim" aria-hidden="true" />
        <div className="rupture-content">{children}</div>
      </div>
    </div>
  );
}
