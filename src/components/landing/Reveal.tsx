"use client";

import { useReveal } from "@/hooks/useReveal";

export function Reveal({
  children,
  delay = 0,
  style,
  className,
}: {
  children: React.ReactNode;
  delay?: number;
  style?: React.CSSProperties;
  className?: string;
}) {
  const { ref, visible } = useReveal<HTMLDivElement>();
  return (
    <div
      ref={ref}
      className={`reveal${visible ? " reveal-visible" : ""}${className ? ` ${className}` : ""}`}
      style={{ transitionDelay: visible ? `${delay}ms` : "0ms", ...style }}
    >
      {children}
    </div>
  );
}
