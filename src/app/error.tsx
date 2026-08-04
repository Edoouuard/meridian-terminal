"use client";

/**
 * Next.js app-level error boundary (client component).
 *
 * When a route throws during rendering, Next unmounts the page and renders
 * this component instead of a blank white screen. It replaces the page's
 * subtree while keeping the root layout (nav, providers) intact.
 */

interface ErrorPageProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function ErrorPage({ error, reset }: ErrorPageProps) {
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "var(--space-3)",
        minHeight: "60vh",
        padding: "var(--space-8)",
        textAlign: "center",
        color: "var(--color-text)",
        background: "var(--color-bg)",
      }}
    >
      <h2 style={{ margin: 0, color: "var(--color-accent-900)" }}>Something went wrong</h2>
      <p className="text-muted" style={{ maxWidth: 480, margin: 0 }}>
        The terminal hit an unexpected error while rendering this page.
      </p>
      {error.digest && (
        <p className="text-muted" style={{ margin: 0, fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
          Reference: {error.digest}
        </p>
      )}
      <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
        <button type="button" className="btn btn-primary" onClick={reset}>
          Try again
        </button>
        <button type="button" className="btn btn-secondary" onClick={() => window.location.reload()}>
          Reload page
        </button>
      </div>
    </div>
  );
}
