"use client";

import { useRef } from "react";

/** Wraps the hero: a subtle gold glow that drifts toward the pointer, pure CSS-variable driven. */
export function HeroGlow({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  function handleMove(e: React.MouseEvent<HTMLDivElement>) {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    el.style.setProperty("--glow-x", `${x}%`);
    el.style.setProperty("--glow-y", `${y}%`);
  }

  return (
    <div ref={ref} className="hero-glow-zone" onMouseMove={handleMove}>
      <div className="hero-glow-layer" aria-hidden="true" />
      {children}
    </div>
  );
}
