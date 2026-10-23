"use client";

import { useEffect, useState, type FormEvent } from "react";

interface Seat {
  id: string;
  createdAt: number;
  lastSeen: number;
}
interface State {
  configured?: boolean;
  signedIn?: boolean;
  storage?: boolean;
  limit?: number;
  used?: number;
  seats?: Seat[];
  error?: string;
}

const when = (t: number) => (t ? new Date(t).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");

async function call(body?: Record<string, unknown>): Promise<State> {
  const res = await fetch("/api/beta-admin", body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" });
  return (await res.json().catch(() => ({ error: "The server didn't answer." }))) as State;
}

/** The owner's early-access controls: seat limit, who holds a seat, free one or all. */
export function AdminSeats() {
  const [s, setS] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState("");

  const run = async (body?: Record<string, unknown>) => {
    setBusy(true);
    const next = await call(body);
    setS((prev) => (next.error ? { ...prev, error: next.error } : next));
    if (typeof next.limit === "number") setLimit(String(next.limit));
    setBusy(false);
  };
  useEffect(() => {
    let alive = true;
    void call().then((first) => {
      if (!alive) return;
      setS(first);
      if (typeof first.limit === "number") setLimit(String(first.limit));
    });
    return () => {
      alive = false;
    };
  }, []);

  const card = { width: "100%", maxWidth: 560, display: "flex", flexDirection: "column" as const, gap: 14 };
  if (!s) return <div style={card} className="text-muted">Loading…</div>;
  if (s.configured === false) {
    return (
      <div style={card}>
        <h1 style={{ fontSize: 18, margin: 0 }}>Early access admin</h1>
        <p className="text-muted" style={{ fontSize: 13 }}>
          Set <code>BETA_ADMIN_PASSWORD</code> in Vercel (Production), redeploy, then come back here.
        </p>
      </div>
    );
  }
  if (!s.signedIn) {
    const login = (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      void run({ action: "login", password: new FormData(e.currentTarget).get("password") });
    };
    return (
      <form onSubmit={login} style={{ ...card, maxWidth: 320 }}>
        <h1 style={{ fontSize: 18, margin: 0 }}>Early access admin</h1>
        <input type="password" name="password" required autoFocus placeholder="Admin password" style={{ fontSize: 14, padding: "8px 10px" }} />
        {s.error && <p style={{ fontSize: 12, margin: 0, color: "var(--risk-warning, #e0a030)" }}>{s.error}</p>}
        <button type="submit" className="btn btn-primary" disabled={busy} style={{ fontSize: 13, padding: "8px 10px" }}>
          Sign in
        </button>
      </form>
    );
  }

  const full = (s.used ?? 0) >= (s.limit ?? 0);
  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <h1 style={{ fontSize: 18, margin: 0 }}>Early access</h1>
        <button type="button" className="btn btn-secondary" style={{ fontSize: 11, padding: "3px 10px" }} onClick={() => void run({ action: "logout" })}>
          Sign out
        </button>
      </div>
      {!s.storage && (
        <p style={{ fontSize: 12, margin: 0, color: "var(--risk-warning, #e0a030)" }}>
          Upstash Redis isn&apos;t connected: anyone with the password gets in, with no limit.
        </p>
      )}
      <div className="panel-card" style={{ gap: 10 }}>
        <div style={{ fontSize: 28, fontVariantNumeric: "tabular-nums" }}>
          {s.used} <span className="text-muted" style={{ fontSize: 16 }}>/ {s.limit} seats taken</span>
        </div>
        <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>
          {full ? "Full: the next person with the password sees “Early access is full” and is sent to the waitlist." : `${(s.limit ?? 0) - (s.used ?? 0)} seat(s) left.`} One seat per browser: someone on a phone and a laptop takes two.
        </p>
        <form
          style={{ display: "flex", gap: 8, alignItems: "center" }}
          onSubmit={(e) => {
            e.preventDefault();
            void run({ action: "limit", value: Number(limit) });
          }}
        >
          <label className="text-muted" style={{ fontSize: 12 }}>
            Seat limit
          </label>
          <input type="number" min={0} step={1} value={limit} onChange={(e) => setLimit(e.target.value)} style={{ width: 90, fontSize: 14, padding: "6px 8px" }} />
          {[30, 50, 100].map((n) => (
            <button key={n} type="button" className="btn btn-secondary" style={{ fontSize: 11, padding: "3px 8px" }} onClick={() => setLimit(String(n))}>
              {n}
            </button>
          ))}
          <button type="submit" className="btn btn-primary" disabled={busy || !s.storage} style={{ fontSize: 12, padding: "5px 12px" }}>
            Save
          </button>
        </form>
        {s.error && <p style={{ fontSize: 12, margin: 0, color: "var(--risk-warning, #e0a030)" }}>{s.error}</p>}
      </div>
      <div className="panel-card" style={{ gap: 6 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <strong style={{ fontSize: 13 }}>Seats</strong>
          {(s.seats?.length ?? 0) > 0 && (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              style={{ fontSize: 11, padding: "3px 8px" }}
              onClick={() => {
                if (window.confirm("Free every seat? Everyone will be asked for the password again.")) void run({ action: "freeAll" });
              }}
            >
              Free all
            </button>
          )}
        </div>
        {(s.seats ?? []).length === 0 && <p className="text-muted" style={{ fontSize: 12, margin: 0 }}>No one has entered yet.</p>}
        {(s.seats ?? []).map((seat, i) => (
          <div key={seat.id} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12, padding: "4px 0", borderTop: i ? "1px solid var(--color-divider)" : undefined }}>
            <span style={{ fontFamily: "var(--font-mono, monospace)", minWidth: 70 }}>#{seat.id.slice(0, 6)}</span>
            <span className="text-muted" style={{ flex: 1 }}>
              joined {when(seat.createdAt)} · last seen {when(seat.lastSeen)}
            </span>
            <button type="button" className="btn btn-secondary" disabled={busy} style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => void run({ action: "free", id: seat.id })}>
              Free
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
