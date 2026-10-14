"use client";

import { useEffect, useMemo, useState } from "react";
import { CELEBRATE_EVENT, deployedUsd, isMoveLeg, openStrategies, type CelebrateDetail } from "@/lib/strategyTracker";
import { fmtPct } from "@/lib/strategyView";

const CONFETTI_COLORS = ["#b68235", "#e1ad66", "#facb8d", "#27ae60", "#5a3b0a", "#ffe3bf"];
const PIECES = 42;

function fmtUsd(v: number): string {
  return v >= 1000 ? `$${Math.round(v).toLocaleString("en-US")}` : `$${v.toFixed(2)}`;
}

/** A burst of confetti from the centre of the screen (pure CSS; skipped when the user prefers reduced motion). */
function Confetti() {
  const pieces = useMemo(
    () =>
      Array.from({ length: PIECES }, (_, i) => {
        const angle = (i / PIECES) * Math.PI * 2 + (i % 3) * 0.2;
        const dist = 140 + ((i * 37) % 160);
        return {
          dx: Math.cos(angle) * dist,
          dy: Math.sin(angle) * dist - 60,
          rot: (i * 47) % 360,
          color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
          delay: (i % 6) * 25,
          round: i % 4 === 0,
        };
      }),
    [],
  );
  return (
    <div className="confetti" aria-hidden="true">
      {pieces.map((p, i) => (
        <span
          key={i}
          className={`confetti__piece${p.round ? " confetti__piece--round" : ""}`}
          style={
            {
              background: p.color,
              animationDelay: `${p.delay}ms`,
              "--dx": `${p.dx}px`,
              "--dy": `${p.dy}px`,
              "--rot": `${p.rot}deg`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}

/**
 * The reaction to a strategy being put to work: a toast for each confirmed
 * step, and a full celebration (confetti + summary card) when the last step
 * confirms, with a shortcut to the Strategies monitor.
 */
export function Celebration() {
  const [step, setStep] = useState<CelebrateDetail | null>(null);
  const [done, setDone] = useState<CelebrateDetail | null>(null);

  useEffect(() => {
    const onCelebrate = (e: Event) => {
      const detail = (e as CustomEvent<CelebrateDetail>).detail;
      if (!detail?.strategy) return;
      if (detail.kind === "strategy") {
        setStep(null);
        setDone(detail);
      } else {
        setStep(detail);
      }
    };
    window.addEventListener(CELEBRATE_EVENT, onCelebrate);
    return () => window.removeEventListener(CELEBRATE_EVENT, onCelebrate);
  }, []);

  // Step toasts fade on their own.
  useEffect(() => {
    if (!step) return;
    const t = setTimeout(() => setStep(null), 4200);
    return () => clearTimeout(t);
  }, [step]);

  // Close the celebration with Escape.
  useEffect(() => {
    if (!done) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDone(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [done]);

  const stepLeg = step ? step.strategy.legs[step.legIndex] : undefined;
  const confirmedSteps = step ? step.strategy.legs.filter((l) => l.status === "confirmed").length : 0;
  const s = done?.strategy;
  const size = s ? deployedUsd(s) : undefined;
  const yearly = s?.apyPct && size ? (size * s.apyPct) / 100 : undefined;
  const confirmedCount = s ? s.legs.filter((l) => l.status === "confirmed").length : 0;
  const skippedMoves = s ? s.legs.filter((l) => l.status !== "confirmed" && isMoveLeg(l)).length : 0;

  return (
    <>
      {step && stepLeg && (
        <div className="step-toast" role="status" aria-live="polite">
          <span className="step-toast__check" aria-hidden="true">✓</span>
          <div>
            <strong>
              Step {step.legIndex + 1} of {step.strategy.legs.length} confirmed
            </strong>
            <span className="text-muted">
              {stepLeg.side} {stepLeg.asset} · {stepLeg.protocol}
              {stepLeg.chain ? ` · ${stepLeg.chain}` : ""} — {confirmedSteps}/{step.strategy.legs.length} done
            </span>
          </div>
        </div>
      )}

      {done && s && (
        <div className="celebrate" role="dialog" aria-modal="true" aria-label="Strategy live" onClick={() => setDone(null)}>
          <Confetti />
          <div className="celebrate__card" onClick={(e) => e.stopPropagation()}>
            <div className="celebrate__badge" aria-hidden="true">✓</div>
            <span className="celebrate__kicker">Strategy live</span>
            <h3 className="celebrate__title">{s.title}</h3>
            {s.apyPct !== undefined && (
              <p className="celebrate__apy">
                {fmtPct(s.apyPct)} <span>{s.apyKind === "fixed" ? "fixed APY" : "APY"}</span>
              </p>
            )}
            {yearly !== undefined && <p className="celebrate__earn">≈ {fmtUsd(yearly)} a year on {fmtUsd(size as number)}</p>}
            <p className="celebrate__text text-muted">
              {skippedMoves > 0
                ? `${confirmedCount} step${confirmedCount > 1 ? "s" : ""} confirmed on-chain — the ${skippedMoves > 1 ? "other moves weren't" : "other move wasn't"} needed.`
                : `All ${s.legs.length} step${s.legs.length > 1 ? "s" : ""} confirmed on-chain.`}{" "}
              Follow it in the Strategies tab: rate today vs entry, earnings so far and every transaction.
            </p>
            <div className="celebrate__actions">
              <button
                className="btn btn-primary"
                onClick={() => {
                  setDone(null);
                  openStrategies();
                }}
                autoFocus
              >
                Monitor it →
              </button>
              <button className="btn" onClick={() => setDone(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
