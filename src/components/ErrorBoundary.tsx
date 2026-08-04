"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Application-level React error boundary.
 *
 * Catches render errors thrown anywhere in its children (the app shell /
 * providers) and renders a small, styled fallback instead of a blank white
 * screen. It is deliberately defensive so that it can never itself throw:
 *  - `getDerivedStateFromError` only stores the error (no side effects),
 *  - `componentDidCatch` swallows logging failures,
 *  - the fallback UI uses plain elements + existing design tokens.
 */

interface ErrorBoundaryProps {
  children?: ReactNode;
  /** Optional custom fallback UI. Defaults to the built-in styled message. */
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Best-effort visibility into what broke; must never throw.
    try {
      console.error("[Meridian] Render error caught by ErrorBoundary:", error, info);
    } catch {
      /* ignore logging failures */
    }
  }

  handleReload = (): void => {
    // Reset the captured error so the subtree re-renders (best-effort recovery).
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div
          className="error-boundary"
          role="alert"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "var(--space-3)",
            minHeight: "40vh",
            padding: "var(--space-8)",
            textAlign: "center",
            color: "var(--color-text)",
            background: "var(--color-bg)",
          }}
        >
          <h2 style={{ margin: 0, color: "var(--color-accent-900)" }}>Something went wrong</h2>
          <p className="text-muted" style={{ maxWidth: 480, margin: 0 }}>
            An unexpected error occurred while rendering this view. The rest of the app is still
            available.
          </p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={this.handleReload}
            style={{ marginTop: "var(--space-2)" }}
          >
            Reload
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
