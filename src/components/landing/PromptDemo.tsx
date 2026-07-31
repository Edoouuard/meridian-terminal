"use client";

import { useEffect, useRef, useState } from "react";
import { ThreadCard } from "@/components/ThreadCard";
import { ThreadItem } from "@/lib/data";
import { EXAMPLE_THESES, routeThesis } from "@/lib/routeThesis";

const QUICK_PROMPTS: { label: string; text: string }[] = [
  { label: "Lock a fixed yield", text: "Lock in a fixed rate on my stETH before it drops" },
  { label: "Beta neutral ETH", text: "Farm Hyperliquid points on ETH without directional risk" },
  { label: "Directional perp", text: "I think SOL outperforms this month" },
  { label: "Hedge my portfolio", text: "Hedge my portfolio against a correction" },
];

/** A rotating placeholder that types out example theses, inviting a visitor to try their own. */
function useTypingPlaceholder(active: boolean) {
  const [placeholder, setPlaceholder] = useState("");
  const indexRef = useRef(0);

  useEffect(() => {
    if (!active) return;
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const t = setTimeout(() => setPlaceholder(EXAMPLE_THESES[0]), 0);
      return () => clearTimeout(t);
    }
    let charTimer: ReturnType<typeof setTimeout>;
    let holdTimer: ReturnType<typeof setTimeout>;
    let cancelled = false;

    function typeNext() {
      const phrase = EXAMPLE_THESES[indexRef.current % EXAMPLE_THESES.length];
      let i = 0;
      function step() {
        if (cancelled) return;
        setPlaceholder(phrase.slice(0, i));
        if (i <= phrase.length) {
          i++;
          charTimer = setTimeout(step, 28);
        } else {
          holdTimer = setTimeout(() => {
            indexRef.current++;
            typeNext();
          }, 2200);
        }
      }
      step();
    }
    typeNext();
    return () => {
      cancelled = true;
      clearTimeout(charTimer);
      clearTimeout(holdTimer);
    };
  }, [active]);

  return placeholder;
}

export function PromptDemo() {
  const [thread, setThread] = useState<ThreadItem[]>([]);
  const [text, setText] = useState("");
  const [executed, setExecuted] = useState<Record<number, boolean>>({});
  const placeholder = useTypingPlaceholder(thread.length === 0);

  function send(raw?: string) {
    const value = (raw ?? text).trim();
    if (!value) return;
    setThread((cur) => [...cur, routeThesis(value)]);
    setText("");
  }

  return (
    <div>
      <div
        className="col-scroll"
        style={{
          minHeight: thread.length ? 180 : 0,
          maxHeight: 420,
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-3)",
          marginBottom: thread.length ? "var(--space-3)" : 0,
        }}
      >
        {thread.length === 0 && (
          <p className="text-muted" style={{ fontSize: 13, margin: 0 }}>
            Type a thesis below, or pick one — Meridian turns it into an order.
          </p>
        )}
        {thread.map((item, i) => (
          <ThreadCard key={i} item={item} executed={!!executed[i]} onExecute={() => setExecuted((cur) => ({ ...cur, [i]: true }))} />
        ))}
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: "var(--space-2)" }}>
        {QUICK_PROMPTS.map((q) => (
          <button key={q.label} className="btn btn-secondary" style={{ fontSize: 12 }} onClick={() => send(q.text)}>
            {q.label}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          className="input"
          placeholder={placeholder || "e.g. Lock in a fixed rate on my stETH before it drops"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") send();
          }}
          aria-label="Describe a trading thesis"
        />
        <button className="btn btn-primary btn-icon" aria-label="Send" onClick={() => send()}>
          →
        </button>
      </div>
      <p className="text-muted" style={{ fontSize: 11, margin: "var(--space-2) 0 0" }}>
        Simulated response for this preview — the terminal reads your real wallet and Aave position once connected.
      </p>
    </div>
  );
}
