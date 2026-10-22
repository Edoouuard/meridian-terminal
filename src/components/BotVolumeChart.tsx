"use client";

import { useEffect, useRef, useState } from "react";

interface Point {
  t: number;
  volumeUsd: number;
  feesUsd: number;
}

const H = 160;
const PAD = { l: 44, r: 8, t: 8, b: 18 };

const money = (n: number) => (n >= 10_000 ? `$${(n / 1000).toFixed(0)}k` : n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(0)}`);
const time = (t: number) => new Date(t).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

/**
 * Cumulative volume the bot made, as a step line (volume only grows at a
 * trade), with a crosshair and a tooltip giving volume and fees at that
 * point. One series, one axis; the title names it, so no legend.
 */
export function BotVolumeChart({ history, now }: { history: Point[]; now: number }) {
  const [hover, setHover] = useState<number | null>(null);
  // Drawn at the container's real width, so text and strokes keep their size.
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(600);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={box}>
      {history.length === 0 ? (
        <div className="bot-chart bot-chart--empty">
          <span className="text-muted">The volume curve starts with the first trade.</span>
        </div>
      ) : (
        <Plot history={history} now={now} W={W} hover={hover} setHover={setHover} />
      )}
    </div>
  );
}

function Plot({ history, now, W, hover, setHover }: { history: Point[]; now: number; W: number; hover: number | null; setHover: (i: number | null) => void }) {
  const pts = [{ t: history[0].t - 60_000, volumeUsd: 0, feesUsd: 0 }, ...history, { ...history[history.length - 1], t: Math.max(now, history[history.length - 1].t + 60_000) }];
  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t;
  const vMax = Math.max(1, ...pts.map((p) => p.volumeUsd)) * 1.08;
  const x = (t: number) => PAD.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - PAD.l - PAD.r);
  const y = (v: number) => H - PAD.b - (v / vMax) * (H - PAD.t - PAD.b);
  // Step: volume holds flat until the next trade.
  let d = `M${x(pts[0].t)},${y(pts[0].volumeUsd)}`;
  for (let i = 1; i < pts.length; i++) d += ` H${x(pts[i].t)} V${y(pts[i].volumeUsd)}`;
  const area = `${d} V${y(0)} H${x(pts[0].t)} Z`;
  const ticks = [0, vMax / 2, vMax].map((v) => ({ v, yy: y(v) }));
  const hp = hover !== null ? pts[hover] : null;

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * (W - PAD.l - PAD.r) + PAD.l;
    const t = t0 + ((px - PAD.l) / (W - PAD.l - PAD.r)) * (t1 - t0);
    let idx = 0;
    for (let i = 0; i < pts.length; i++) if (pts[i].t <= t) idx = i;
    setHover(idx);
  };

  return (
    <div className="bot-chart">
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={`Cumulative volume: ${money(history[history.length - 1].volumeUsd)} since ${time(history[0].t)}`}>
        {ticks.map((tk) => (
          <g key={tk.v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={tk.yy} y2={tk.yy} className="bot-chart__grid" />
            <text x={PAD.l - 6} y={tk.yy + 3} textAnchor="end" className="bot-chart__axis">
              {money(tk.v)}
            </text>
          </g>
        ))}
        <text x={PAD.l} y={H - 4} className="bot-chart__axis">
          {time(t0)}
        </text>
        <text x={W - PAD.r} y={H - 4} textAnchor="end" className="bot-chart__axis">
          {time(t1)}
        </text>
        <path d={area} className="bot-chart__area" />
        <path d={d} className="bot-chart__line" />
        {hp && (
          <g>
            <line x1={x(hp.t)} x2={x(hp.t)} y1={PAD.t} y2={H - PAD.b} className="bot-chart__cross" />
            <circle cx={x(hp.t)} cy={y(hp.volumeUsd)} r={4} className="bot-chart__dot" />
          </g>
        )}
        <rect x={PAD.l} y={PAD.t} width={W - PAD.l - PAD.r} height={H - PAD.t - PAD.b} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
      </svg>
      {hp && (
        <div className="bot-chart__tip" style={{ left: `${(x(hp.t) / W) * 100}%` }}>
          <strong>{money(hp.volumeUsd)}</strong> volume · ${hp.feesUsd.toFixed(2)} fees
          <span className="text-muted"> · {time(hp.t)}</span>
        </div>
      )}
    </div>
  );
}
