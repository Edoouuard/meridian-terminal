"use client";

import { useEffect, useRef, useState } from "react";
import { HERO_BACKGROUND_IMAGE, HERO_IMAGE_HEIGHT, HERO_IMAGE_WIDTH } from "@/lib/heroArt";

// Normalized (0 to 1) position of the building's main entrance in the source photo. The
// scroll zoom converges on this point and the door overlay is centered on it.
const DOOR_X = 0.5;
const DOOR_Y = 0.74;
const DOOR_WIDTH = 0.09;
const DOOR_HEIGHT = 0.16;

/** How the full image is scaled and centered to cover a container without distorting it. */
function computeCoverFit(containerW: number, containerH: number) {
  const scale = Math.max(containerW / HERO_IMAGE_WIDTH, containerH / HERO_IMAGE_HEIGHT);
  const width = HERO_IMAGE_WIDTH * scale;
  const height = HERO_IMAGE_HEIGHT * scale;
  return { width, height, x: (containerW - width) / 2, y: (containerH - height) / 2 };
}

export function ApproachHero({ children, doorOpen }: { children: React.ReactNode; doorOpen: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stickyRef = useRef<HTMLDivElement>(null);
  const doorOpenRef = useRef(doorOpen);
  const progressRef = useRef(0);
  const [size, setSize] = useState({ width: 1920, height: 1080 });

  useEffect(() => {
    doorOpenRef.current = doorOpen;
  }, [doorOpen]);

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
      if (doorOpenRef.current) {
        // Ease toward "fully arrived" instead of snapping, so opening the door from any
        // scroll position still feels like one continuous approach.
        progressRef.current += (1 - progressRef.current) * 0.08;
      } else {
        const rect = el.getBoundingClientRect();
        progressRef.current = rect.height > 0 ? Math.min(1, Math.max(0, -rect.top / rect.height)) : 0;
      }
      sticky.style.setProperty("--progress", String(progressRef.current));
      raf = requestAnimationFrame(update);
    }
    raf = requestAnimationFrame(update);
    return () => cancelAnimationFrame(raf);
  }, []);

  const fit = computeCoverFit(size.width, size.height);

  return (
    <div ref={containerRef} className="approach-container">
      <div ref={stickyRef} className={`approach-sticky${doorOpen ? " approach-sticky--open" : ""}`}>
        <div className="approach-zoom" style={{ transformOrigin: `${DOOR_X * 100}% ${DOOR_Y * 100}%` }} aria-hidden="true">
          <div
            className="approach-image"
            style={{
              backgroundImage: HERO_BACKGROUND_IMAGE,
              backgroundSize: `${fit.width}px ${fit.height}px`,
              backgroundPosition: `${fit.x}px ${fit.y}px`,
            }}
          />
          <div className="approach-glow-fade">
            <div className="approach-glow" />
          </div>
          <div
            className={`approach-door${doorOpen ? " is-open" : ""}`}
            style={{
              left: `${(DOOR_X - DOOR_WIDTH / 2) * 100}%`,
              top: `${(DOOR_Y - DOOR_HEIGHT / 2) * 100}%`,
              width: `${DOOR_WIDTH * 100}%`,
              height: `${DOOR_HEIGHT * 100}%`,
            }}
          >
            <div className="approach-door-glow" />
            <div className="approach-door-panel approach-door-panel--left" />
            <div className="approach-door-panel approach-door-panel--right" />
          </div>
        </div>
        <div className="approach-scrim" aria-hidden="true" />
        <div className="approach-content">{children}</div>
      </div>
    </div>
  );
}
