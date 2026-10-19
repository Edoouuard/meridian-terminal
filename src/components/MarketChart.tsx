"use client";

import { useRef, useState } from "react";
import { fmtUsdShort, type MarketChart as Chart } from "@/lib/planner/marketCharts";

/**
 * The charts under a market answer, drawn in plain SVG:
 *   - line: a series over time (DeFi TVL, stablecoin supply, DEX volume),
 *     area under a 2px line, crosshair + tooltip on hover;
 *   - bars: magnitudes by category (TVL by chain), one hue, values written;
 *   - diverging: signed changes (24h price moves), green up / red down
 *     around a zero line, every bar labelled with its sign.
 * Each chart has a table view for screen readers and exact values.
 */

const fmt = (c: Chart, v: number) => (c.unit === "pct" ? `${v >= 0 ? "+" : ""}${v.toFixed(1)}%` : fmtUsdShort(v));

function LineChart({ chart }: { chart: Chart }) {
  const W = 480;
  const H = 150;
  const pad = { l: 4, r: 4, t: 10, b: 18 };
  const vals = chart.points.map((p) => p.value);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  // A little headroom so the line never touches the frame; the axis isn't from zero (a trend, not a magnitude), and the labels say so.
  const lo = min - (max - min) * 0.08;
  const hi = max + (max - min) * 0.08 || max + 1;
  const x = (i: number) => pad.l + (i / (chart.points.length - 1)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  const line = chart.points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join("");
  const area = `${line}L${x(chart.points.length - 1).toFixed(1)},${H - pad.b}L${x(0).toFixed(1)},${H - pad.b}Z`;
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return;
    const fx = ((e.clientX - r.left) / r.width) * W;
    const i = Math.round(((fx - pad.l) / (W - pad.l - pad.r)) * (chart.points.length - 1));
    setHover(Math.max(0, Math.min(chart.points.length - 1, i)));
  };
  const gid = `mc-grad-${chart.id}`;
  const h = hover !== null ? chart.points[hover] : null;
  return (
    <div className="mchart__plot">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="mchart__svg"
        role="img"
        aria-label={`${chart.title}: from ${fmt(chart, vals[0])} to ${fmt(chart, vals[vals.length - 1])}`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-series)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--chart-series)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} className="mchart__axis" />
        <path d={area} fill={`url(#${gid})`} className="mchart__area" />
        <path d={line} className="mchart__line" pathLength={1} />
        <circle cx={x(vals.length - 1)} cy={y(vals[vals.length - 1])} r={4} className="mchart__end" />
        <text x={pad.l} y={H - 4} className="mchart__tick">{chart.points[0].label}</text>
        <text x={W - pad.r} y={H - 4} className="mchart__tick" textAnchor="end">{chart.points[chart.points.length - 1].label}</text>
        {hover !== null && h && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} className="mchart__cross" />
            <circle cx={x(hover)} cy={y(h.value)} r={4.5} className="mchart__dot" />
          </g>
        )}
      </svg>
      {hover !== null && h && (
        <div className="mchart__tip" style={{ left: `${(x(hover) / W) * 100}%` }}>
          <strong>{fmt(chart, h.value)}</strong>
          <span>{h.label}</span>
        </div>
      )}
    </div>
  );
}

function BarChart({ chart }: { chart: Chart }) {
  const max = Math.max(...chart.points.map((p) => Math.abs(p.value)), 1e-9);
  const diverging = chart.kind === "diverging";
  return (
    <ul className={`mchart__bars${diverging ? " mchart__bars--div" : ""}`} aria-label={chart.title}>
      {chart.points.map((p, i) => {
        const w = (Math.abs(p.value) / max) * (diverging ? 50 : 100);
        const up = p.value >= 0;
        return (
          <li key={p.label} title={`${p.label}: ${fmt(chart, p.value)}`} style={{ animationDelay: `${i * 45}ms` }}>
            <span className="mchart__bar-label">{p.label}</span>
            <span className="mchart__bar-track">
              {diverging && <span className="mchart__zero" aria-hidden="true" />}
              <span
                className={`mchart__bar${diverging ? (up ? " is-up" : " is-down") : ""}`}
                style={diverging ? { width: `${w}%`, [up ? "left" : "right"]: "50%" } : { width: `${Math.max(w, 1.5)}%` }}
              />
            </span>
            <span className="mchart__bar-value">{fmt(chart, p.value)}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function MarketChart({ chart }: { chart: Chart }) {
  return (
    <figure className="mchart">
      <figcaption className="mchart__head">
        <span className="mchart__title">{chart.title}</span>
        {chart.caption && <span className="mchart__caption">{chart.caption}</span>}
      </figcaption>
      {chart.kind === "line" ? <LineChart chart={chart} /> : <BarChart chart={chart} />}
      <details className="mchart__table">
        <summary>
          Data · {chart.source}
        </summary>
        <table>
          <tbody>
            {(chart.kind === "line" ? chart.points.filter((_, i, a) => i === a.length - 1 || i % Math.ceil(a.length / 12) === 0) : chart.points).map((p) => (
              <tr key={p.label}>
                <th scope="row">{p.label}</th>
                <td>{fmt(chart, p.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
