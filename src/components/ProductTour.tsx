"use client";

import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { useAccount } from "wagmi";
import { FEATURES } from "@/lib/features";
import { askMeridian } from "@/lib/askBus";

/** Bumped when the tour gains steps, so testers who finished the old one see the new one once. */
export const TOUR_DONE_KEY = "meridian:tourDone:v2";
const START_EVENT = "meridian:start-tour";
/** The page opens this side tab when a step points inside it (detail: tab id). */
export const TOUR_OPEN_TAB_EVENT = "meridian:tour-open-tab";

export interface TourPrompt {
  label: string;
  prompt: string;
  /** Needs perps enabled. */
  perps?: boolean;
}

interface TourStep {
  /** data-tour anchor; none = a centred card. */
  target?: string;
  title: string;
  body: string;
  /** Side tab to open before highlighting the target. */
  tab?: "risk" | "strategies" | "venues" | "activity";
  /** Prompts the user can send straight from the card. */
  prompts?: TourPrompt[];
  /** Only shown when perps are enabled. */
  perps?: boolean;
}

/** Prompts that work end to end today, one per use case. */
export const TOUR_PROMPTS: TourPrompt[] = [
  { label: "Earn on stablecoins", prompt: "Best yield for my USDC, no lock-up" },
  { label: "Stake ETH", prompt: "Stake my ETH with the best liquid staking rate" },
  { label: "Fixed rate", prompt: "Lock a fixed rate on my USDC with Pendle" },
  { label: "Trade a perp", prompt: "Short ETH 2x on Hyperliquid, stop-loss 20%", perps: true },
  { label: "Stocks on Extended", prompt: "Short AMD on Extended", perps: true },
  { label: "Neutral across venues", prompt: "Beta-neutral ETH between Extended and Hyperliquid to farm volume", perps: true },
  { label: "Hedge", prompt: "Hedge my ETH exposure without selling it", perps: true },
];

const ALL_STEPS: TourStep[] = [
  {
    title: "Welcome to Meridian",
    body: "Your wallet is connected. In under a minute, here is how to go from an idea to a position — every step signed by you, nothing moves without your approval.",
  },
  {
    target: "portfolio",
    title: "Your portfolio, live",
    body: "Balances across 8 chains, your lending, staking, Hyperliquid and Extended accounts, valued at live prices. It refreshes on its own after each transaction.",
  },
  {
    target: "composer",
    title: "Ask in plain words",
    body: "Meridian reads live rates, funding and your balances, then proposes plans sized to what you really hold. If your request is ambiguous it asks one question. A plan it can't run yet says what blocks it; anything that changes your request is labelled as an alternative.",
  },
  {
    title: "Try a use case",
    body: "Pick one to send it now, or type your own. Numbers are computed from live market data, and you review every order before signing.",
    prompts: TOUR_PROMPTS,
  },
  {
    target: "markets",
    title: "Live rates and markets",
    body: "Yields by asset, crypto news, chain overview and alpha. Every row has an “Ask Meridian” button that turns it into a strategy.",
  },
  {
    target: "extended",
    tab: "venues",
    perps: true,
    title: "Trade on Extended",
    body: "Stocks, indices and crypto perps on Extended. Connect with three wallet signatures (no keys to paste), deposit USDC on extended.exchange, then ask Meridian: it compares funding with Hyperliquid and builds pairs across both venues.",
  },
  {
    target: "tabs",
    title: "Risk, strategies, tools, history",
    body: "Perp positions on Hyperliquid and Extended with PnL, funding and liquidation distance; every strategy you put to work (a pair with one leg filled is flagged); bridges and venue connections in Tools; every transaction in History.",
  },
  {
    target: "status",
    title: "You're set",
    body: "Each transaction shows its steps and the usual wait for its chain. Replay this tour any time with the “Tour” button.",
  },
];

/** The tour for this build: perps steps and prompts only when perps are enabled. */
export function tourSteps(perps: boolean): TourStep[] {
  return ALL_STEPS.filter((s) => perps || !s.perps).map((s) => (s.prompts ? { ...s, prompts: s.prompts.filter((p) => perps || !p.perps) } : s));
}

export const TOUR_STEPS = tourSteps(FEATURES.perps);

export function startTour(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(START_EVENT));
}

function readDone(): boolean {
  try {
    return window.localStorage.getItem(TOUR_DONE_KEY) === "1";
  } catch {
    return true;
  }
}

function markDone(): void {
  try {
    window.localStorage.setItem(TOUR_DONE_KEY, "1");
  } catch {
    /* private mode: the tour may show again, harmless */
  }
}

/** Where the tooltip goes relative to the highlighted element, kept inside the viewport. */
export function placeTooltip(
  rect: { top: number; left: number; width: number; height: number } | null,
  viewport: { width: number; height: number },
  card: { width: number; height: number },
): { top: number; left: number } {
  const margin = 12;
  if (!rect) return { top: Math.max(margin, (viewport.height - card.height) / 2), left: Math.max(margin, (viewport.width - card.width) / 2) };
  const below = rect.top + rect.height + margin;
  const above = rect.top - margin - card.height;
  const top = below + card.height <= viewport.height - margin ? below : above >= margin ? above : Math.max(margin, viewport.height - card.height - margin);
  const left = Math.min(Math.max(margin, rect.left + rect.width / 2 - card.width / 2), viewport.width - card.width - margin);
  return { top, left };
}

/**
 * First-connection product tour: once a wallet connects for the first time in
 * this browser, a short guided pass highlights the portfolio, the composer,
 * live markets and the side tabs. Skippable at any point (Escape too), never
 * shown again once finished or skipped, and replayable from the top bar.
 */
export function ProductTour() {
  const { isConnected } = useAccount();
  const [index, setIndex] = useState<number | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [viewport, setViewport] = useState({ width: 1280, height: 800 });

  // First connection in this browser starts the tour once.
  useEffect(() => {
    if (!isConnected || readDone()) return;
    const t = setTimeout(() => setIndex((i) => (i === null ? 0 : i)), 900);
    return () => clearTimeout(t);
  }, [isConnected]);

  useEffect(() => {
    const start = () => setIndex(0);
    window.addEventListener(START_EVENT, start);
    return () => window.removeEventListener(START_EVENT, start);
  }, []);

  const step = index !== null ? TOUR_STEPS[index] : undefined;

  // Track the highlighted element (scroll into view, follow resizes and scrolls).
  useLayoutEffect(() => {
    if (!step) return;
    if (step.tab) window.dispatchEvent(new CustomEvent(TOUR_OPEN_TAB_EVENT, { detail: step.tab }));
    // Re-query on each measure: a step that opens a side tab renders its target a moment later.
    const find = () => {
      const el = step.target ? (document.querySelector(`[data-tour="${step.target}"]`) as HTMLElement | null) : null;
      return el && el.getClientRects().length > 0 ? el : null;
    };
    let scrolled = false;
    const measure = () => {
      const el = find();
      if (el && !scrolled) {
        el.scrollIntoView({ block: "nearest", behavior: "smooth" });
        scrolled = true;
      }
      setViewport({ width: window.innerWidth, height: window.innerHeight });
      setRect(el ? el.getBoundingClientRect() : null);
    };
    measure();
    const t0 = setTimeout(measure, 50);
    const t = setTimeout(measure, 350);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      clearTimeout(t0);
      clearTimeout(t);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [step]);

  const close = useCallback(() => {
    markDone();
    setIndex(null);
  }, []);
  const next = useCallback(() => setIndex((i) => (i === null ? null : i + 1 < TOUR_STEPS.length ? i + 1 : (markDone(), null))), []);
  const send = useCallback(
    (prompt: string) => {
      close();
      askMeridian(prompt);
    },
    [close],
  );
  const back = useCallback(() => setIndex((i) => (i === null || i === 0 ? i : i - 1)), []);

  useEffect(() => {
    if (index === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight" || e.key === "Enter") next();
      else if (e.key === "ArrowLeft") back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, close, next, back]);

  if (!step || index === null) return null;
  const cardSize = { width: Math.min(step.prompts ? 400 : 340, viewport.width - 24), height: step.prompts ? 340 : 190 };
  const pos = placeTooltip(rect, viewport, cardSize);
  const pad = 6;
  const last = index === TOUR_STEPS.length - 1;

  return (
    <div className="tour" role="dialog" aria-modal="true" aria-label={`Product tour, step ${index + 1} of ${TOUR_STEPS.length}`}>
      {rect ? (
        <div
          className="tour__spot"
          style={{ top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }}
        />
      ) : (
        <div className="tour__dim" />
      )}
      <div className="tour__card" key={index} style={{ top: pos.top, left: pos.left, width: cardSize.width }}>
        <div className="tour__progress" aria-hidden="true">
          {TOUR_STEPS.map((_, i) => (
            <span key={i} className={i <= index ? "is-on" : undefined} />
          ))}
        </div>
        <h4 className="tour__title">{step.title}</h4>
        <p className="tour__body">{step.body}</p>
        {step.prompts && (
          <div className="tour__prompts">
            {step.prompts.map((p) => (
              <button key={p.prompt} type="button" className="tour__prompt" onClick={() => send(p.prompt)}>
                <span className="tour__prompt-label">{p.label}</span>
                <span className="tour__prompt-text">“{p.prompt}”</span>
              </button>
            ))}
          </div>
        )}
        <div className="tour__actions">
          {!last && (
            <button type="button" className="tour__skip" onClick={close}>
              Skip tour
            </button>
          )}
          <span style={{ flex: 1 }} />
          {index > 0 && (
            <button type="button" className="btn" onClick={back}>
              Back
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={next} autoFocus>
            {last ? "Start exploring" : index === 0 ? "Show me" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
