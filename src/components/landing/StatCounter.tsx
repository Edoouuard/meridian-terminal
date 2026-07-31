"use client";

import { useEffect, useState } from "react";
import { useReveal } from "@/hooks/useReveal";

/** Counts up from 0 to a target value once the counter scrolls into view. */
export function StatCounter({
  to,
  prefix = "",
  suffix = "",
  decimals = 0,
  durationMs = 1100,
}: {
  to: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  durationMs?: number;
}) {
  const { ref, visible } = useReveal<HTMLSpanElement>();
  const [value, setValue] = useState(0);

  useEffect(() => {
    if (!visible) return;
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const raf = requestAnimationFrame(() => setValue(to));
      return () => cancelAnimationFrame(raf);
    }
    let raf: number;
    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(to * eased);
      if (progress < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [visible, to, durationMs]);

  return (
    <span ref={ref} style={{ fontVariantNumeric: "tabular-nums" }}>
      {prefix}
      {value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}
      {suffix}
    </span>
  );
}
