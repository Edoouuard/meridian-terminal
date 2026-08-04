"use client";

import { useState } from "react";

/**
 * BetaGate — a soft beta-tester password gate in front of the terminal.
 *
 * When `NEXT_PUBLIC_BETA_PASSWORD` is set (production), visitors must enter the
 * shared beta password once (persisted in sessionStorage) before the wallet
 * connect / terminal is usable. When the env var is empty (local dev), the gate
 * is open so development isn't blocked.
 *
 * NOTE (honest): without a backend this is a convenience gate, not real
 * security — the env value ships in the client bundle. Treat it as a beta
 * access gate, not a credential boundary.
 */
export function BetaGate({ children }: { children: React.ReactNode }) {
  const betaPassword = (process.env.NEXT_PUBLIC_BETA_PASSWORD ?? "").trim();
  const [input, setInput] = useState("");
  const [unlocked, setUnlocked] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return (
        betaPassword === "" ||
        window.sessionStorage.getItem("meridian:beta:unlocked") === "1"
      );
    } catch {
      return false;
    }
  });
  const [error, setError] = useState(false);

  if (unlocked) return <>{children}</>;

  function tryUnlock() {
    if (betaPassword !== "" && input === betaPassword) {
      try {
        window.sessionStorage.setItem("meridian:beta:unlocked", "1");
      } catch {
        /* ignore */
      }
      setUnlocked(true);
    } else {
      setError(true);
    }
  }

  return (
    <div
      style={{
        height: "100vh",
        width: "100%",
        background: "var(--color-bg)",
        color: "var(--color-text)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "var(--space-4)",
        fontFamily: "var(--font-body)",
      }}
    >
      <div className="card" style={{ maxWidth: 360, width: "100%", gap: "var(--space-2)", padding: "var(--space-4)" }}>
        <h6 style={{ margin: 0, color: "var(--color-accent)" }}>Meridian — beta access</h6>
        <p style={{ margin: 0, fontSize: 13 }} className="text-muted">
          This terminal is in private beta. Enter the invite password to continue.
        </p>
        <input
          className="input"
          type="password"
          autoFocus
          placeholder="Beta password"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setError(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") tryUnlock();
          }}
        />
        {error && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--risk-serious)" }}>
            Invalid password. Try again.
          </p>
        )}
        <button className="btn btn-primary" style={{ width: "100%" }} onClick={tryUnlock}>
          Unlock
        </button>
      </div>
    </div>
  );
}
