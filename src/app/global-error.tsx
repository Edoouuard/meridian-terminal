"use client";

/**
 * Top-level Next.js error UI for truly fatal errors.
 *
 * Unlike `error.tsx`, this is rendered when the root layout itself fails, so
 * it must declare its own `<html>`/`<body>` and cannot rely on CSS modules.
 * It uses inline styles with the app's design tokens so it still looks native.
 */

interface GlobalErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "var(--color-bg)", color: "var(--color-text)" }}>
        <div
          role="alert"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "var(--space-3)",
            minHeight: "100vh",
            padding: "var(--space-8)",
            textAlign: "center",
            background: "var(--color-bg)",
            color: "var(--color-text)",
            fontFamily: "var(--font-body)",
          }}
        >
          <h2 style={{ fontFamily: "var(--font-heading)", margin: 0, color: "var(--color-accent-900)" }}>
            Something went wrong
          </h2>
          <p style={{ maxWidth: 480, margin: 0, color: "color-mix(in srgb, var(--color-text) 55%, transparent)" }}>
            A fatal error occurred. Reload the page to try again.
          </p>
          {error.digest && (
            <p style={{ margin: 0, fontSize: 12 }}>
              Reference: {error.digest}
            </p>
          )}
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: "var(--space-2)",
              padding: "var(--space-2) calc(var(--space-3) * 1.2)",
              borderRadius: "var(--radius-md)",
              background: "transparent",
              border: "1px solid var(--color-accent)",
              color: "var(--color-accent)",
              fontFamily: "var(--font-heading)",
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
