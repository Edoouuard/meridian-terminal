"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { FEATURES } from "@/lib/features";
import { askMeridian } from "@/lib/askBus";

/** Bumped when the tour gains steps, so testers who finished the old one see the new one once. */
export const TOUR_DONE_KEY = "meridian:tourDone:v3";
/** Delay before the tour opens on a first visit, so the page has painted its panels. */
const AUTO_START_MS = 900;
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
  /** Page to open before highlighting the target. */
  tab?: "terminal" | "perps-accounts";
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
    tab: "terminal",
    title: "Your portfolio, live",
    body: "Balances across 8 chains, your lending, staking, Hyperliquid and Extended accounts, valued at live prices. It refreshes on its own after each transaction.",
  },
  {
    target: "composer",
    title: "Ask in plain words",
    body: "Meridian reads live rates, funding and your balances, then proposes plans sized to what you really hold. If your request is ambiguous it asks one question. A plan it can't run yet says what blocks it; anything that changes your request is labelled as an alternative.",
  },
  {
    target: "markets",
    title: "Live rates and markets",
    body: "Earn lists live yields by asset and the perp DEX vaults; Discover has crypto news, alpha, points programs and the chain overview. Every row has an “Ask Meridian” button that turns it into a strategy.",
  },
  {
    target: "extended",
    tab: "perps-accounts",
    perps: true,
    title: "Trade on Extended",
    body: "Stocks, indices and crypto perps on Extended. Before connecting: open your account on extended.exchange with this same wallet and fund it with USDC (or deposit from Arbitrum in Perps → Accounts → Extended). Then click “Connect Extended with my wallet” here: three signatures, no keys to paste. Meridian finds your account, compares funding with Hyperliquid and builds pairs across both venues.",
  },
  {
    target: "nav",
    title: "Everything one click away",
    body: "Terminal is where you ask. Portfolio has your holdings, risk, the strategies you put to work, bridges and history. Earn ranks yields and vaults; Perps holds the neutral bot, funding and price arbitrage and your venue accounts; Discover has news, alpha and points. The ask bar stays at the bottom of every page.",
  },
  {
    title: "Try a strategy now",
    body: "Pick one to send it to Meridian, or type your own. Plans are sized on your real balances and live rates, and you review every order before signing. Replay this tour any time with the “Tour” button.",
    prompts: TOUR_PROMPTS,
  },
];

/** The welcome text for a visitor who hasn't connected a wallet yet. */
export const WELCOME_DISCONNECTED =
  "In under a minute, here is how to go from an idea to a position. Connect a wallet (top right) whenever you're ready: every step is signed by you, nothing moves without your approval.";

/** The tour for this build: perps steps and prompts only when perps are enabled. */
export function tourSteps(perps: boolean): TourStep[] {
  return ALL_STEPS.filter((s) => perps || !s.perps).map((s) => (s.prompts ? { ...s, prompts: s.prompts.filter((p) => perps || !p.perps) } : s));
}

export const TOUR_STEPS = tourSteps(FEATURES.perps);

export function startTour(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(START_EVENT));
}

/** Wallets that have seen the tour in this browser (lowercased addresses). */
const TOUR_WALLETS_KEY = "meridian:tourWallets:v1";

/**
 * Has this visitor seen the tour? Without a wallet: once per browser. With a
 * wallet: once per wallet, so a newly connected wallet gets it even after the
 * visitor skipped it before connecting.
 */
export function tourSeen(storage: Pick<Storage, "getItem">, address: string | undefined): boolean {
  if (!address) return storage.getItem(TOUR_DONE_KEY) === "1";
  try {
    const seen = JSON.parse(storage.getItem(TOUR_WALLETS_KEY) ?? "[]") as unknown;
    return Array.isArray(seen) && seen.includes(address.toLowerCase());
  } catch {
    return false;
  }
}

function readDone(address: string | undefined): boolean {
  try {
    return tourSeen(window.localStorage, address);
  } catch {
    return true;
  }
}

function markDone(address: string | undefined): void {
  try {
    window.localStorage.setItem(TOUR_DONE_KEY, "1");
    if (address) {
      const raw = JSON.parse(window.localStorage.getItem(TOUR_WALLETS_KEY) ?? "[]") as unknown;
      const seen = Array.isArray(raw) ? (raw as string[]) : [];
      if (!seen.includes(address.toLowerCase())) window.localStorage.setItem(TOUR_WALLETS_KEY, JSON.stringify([...seen, address.toLowerCase()].slice(-50)));
    }
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
  card = { width: card.width, height: Math.min(card.height, viewport.height - margin * 2) };
  if (!rect) return { top: Math.max(margin, (viewport.height - card.height) / 2), left: Math.max(margin, (viewport.width - card.width) / 2) };
  const below = rect.top + rect.height + margin;
  const above = rect.top - margin - card.height;
  const top = below + card.height <= viewport.height - margin ? below : above >= margin ? above : Math.max(margin, viewport.height - card.height - margin);
  const left = Math.min(Math.max(margin, rect.left + rect.width / 2 - card.width / 2), viewport.width - card.width - margin);
  return { top, left };
}

/**
 * First-visit product tour: every new visitor (wallet connected or not) gets a
 * short guided pass highlights the portfolio, the composer,
 * live markets and the side tabs. Skippable at any point (Escape too), never
 * shown again once finished or skipped, and replayable from the top bar.
 */
export function ProductTour() {
  const { isConnected, address } = useAccount();
  const [index, setIndex] = useState<number | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [viewport, setViewport] = useState({ width: 1280, height: 800 });
  const cardRef = useRef<HTMLDivElement>(null);
  /** The card's rendered height, so it is placed by its real size (the last step is tall). */
  const [cardHeight, setCardHeight] = useState<number | null>(null);

  // Starts on its own on the first visit, and again for each wallet that connects for the first time.
  useEffect(() => {
    if (readDone(address)) return;
    const t = setTimeout(() => setIndex((i) => (i === null ? 0 : i)), AUTO_START_MS);
    return () => clearTimeout(t);
  }, [address]);

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

  // Follow the card's real height (content, fonts, viewport width).
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const read = () => setCardHeight(el.offsetHeight);
    read();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(read) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [index]);

  const close = useCallback(() => {
    markDone(address);
    setIndex(null);
  }, [address]);
  const next = useCallback(() => setIndex((i) => (i === null ? null : i + 1 < TOUR_STEPS.length ? i + 1 : (markDone(address), null))), [address]);
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
  const cardSize = { width: Math.min(step.prompts ? 420 : 340, viewport.width - 24), height: cardHeight ?? (step.prompts ? 520 : 200) };
  const pos = placeTooltip(rect, viewport, cardSize);
  const pad = 6;
  const last = index === TOUR_STEPS.length - 1;

  return (
    <div className="tour" role="dialog" aria-modal="true" aria-label={`Product tour, step ${index + 1} of ${TOUR_STEPS.length}`}>
      {rect ? (
        <div
          className="tour__spot"
          key={`spot-${index}`}
          style={{ top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }}
        />
      ) : (
        <div className="tour__dim" />
      )}
      <div
        ref={cardRef}
        className={`tour__card${step.prompts ? " tour__card--final" : ""}`}
        key={index}
        style={{ top: pos.top, left: pos.left, width: cardSize.width, maxHeight: viewport.height - 24 }}
      >
        <div className="tour__progress" aria-hidden="true">
          {TOUR_STEPS.map((_, i) => (
            <span key={i} className={i < index ? "is-on" : i === index ? "is-on is-current" : undefined} />
          ))}
        </div>
        <h4 className="tour__title">{step.title}</h4>
        <p className="tour__body">{index === 0 && !isConnected ? WELCOME_DISCONNECTED : step.body}</p>
        {step.prompts && (
          <div className="tour__prompts">
            {step.prompts.map((p, i) => (
              <button key={p.prompt} type="button" className="tour__prompt" style={{ animationDelay: `${180 + i * 55}ms` }} onClick={() => send(p.prompt)}>
                <span className="tour__prompt-label">{p.label}</span>
                <span className="tour__prompt-text">“{p.prompt}”</span>
                <span className="tour__prompt-go" aria-hidden="true">→</span>
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
