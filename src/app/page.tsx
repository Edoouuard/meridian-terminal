import Link from "next/link";
import { PromptDemo } from "@/components/landing/PromptDemo";
import { ProtocolMarquee } from "@/components/landing/ProtocolMarquee";
import { WaitlistForm } from "@/components/landing/WaitlistForm";

const FEATURES = [
  {
    title: "Prompt to trade",
    body: "Describe a thesis — 'long HYPE, size 6k, leverage 6' — and Meridian turns it into an executable order across Aave, Morpho, Lido, Pendle, Hyperliquid, Extended, Variational and Uniswap.",
  },
  {
    title: "Real execution",
    body: "Sign with your wallet from the terminal: Aave supply & repay, native transfers, and Hyperliquid perps. Every action is confirmed on-chain before it fires.",
  },
  {
    title: "Risk, live",
    body: "Net delta across venues, staking concentration, Aave health factor — with optimizations sized to your real portfolio, not demo figures.",
  },
  {
    title: "Live market data",
    body: "Funding rates, top movers and flow pulled from public feeds, with a graceful fallback so the terminal never breaks.",
  },
];

export default function Landing() {
  return (
    <div style={{ background: "var(--color-bg)", color: "var(--color-text)", minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      {/* Nav */}
      <div className="nav" style={{ background: "var(--color-surface)", position: "relative", zIndex: 3 }}>
        <span className="nav-brand" style={{ color: "var(--color-text)" }}>
          Meridian
        </span>
        <span className="text-muted" style={{ fontSize: 13, marginLeft: "auto", marginRight: "var(--space-3)" }}>
          Private beta
        </span>
        <Link href="/app" className="btn btn-primary" style={{ textDecoration: "none" }}>
          Open terminal →
        </Link>
      </div>

      {/* Hero */}
      <section style={{ padding: "var(--space-8) var(--space-6)", maxWidth: 1080, width: "100%", margin: "0 auto", boxSizing: "border-box" }}>
        <h1 style={{ fontFamily: "var(--font-heading)", fontSize: 60, lineHeight: 1.02, margin: "0 0 var(--space-3)", letterSpacing: "-0.02em" }}>
          Turn a conviction into{" "}
          <span style={{ color: "var(--color-accent)" }}>an executed DeFi position.</span>
        </h1>
        <p style={{ fontSize: 19, lineHeight: 1.5, maxWidth: 640, margin: "0 0 var(--space-4)", color: "color-mix(in srgb, var(--color-text) 72%, transparent)" }}>
          Meridian is a unified terminal for DeFi: describe a thesis in plain words, let it size and
          route the order across the protocols you already use, and execute with your own wallet —
          while risk is optimized in real time.
        </p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: "var(--space-5)" }}>
          <Link href="/app" className="btn btn-primary btn-large" style={{ textDecoration: "none", fontSize: 15 }}>
            Open the terminal
          </Link>
          <a href="#demo" className="btn btn-secondary btn-large" style={{ fontSize: 15 }}>
            See it work
          </a>
        </div>

        <div id="demo" className="card" style={{ padding: "var(--space-4)", maxWidth: 720, gap: "var(--space-2)", background: "var(--color-surface)" }}>
          <p className="card-kicker" style={{ margin: 0 }}>
            Live prompt preview
          </p>
          <PromptDemo />
        </div>
      </section>

      {/* Features */}
      <section style={{ padding: "var(--space-6)", maxWidth: 1080, width: "100%", margin: "0 auto", boxSizing: "border-box" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "var(--space-4)" }}>
          {FEATURES.map((f) => (
            <div key={f.title} className="card" style={{ gap: 6, padding: "var(--space-4)" }}>
              <h3 style={{ margin: 0, color: "var(--color-accent)", fontFamily: "var(--font-heading)" }}>{f.title}</h3>
              <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: "color-mix(in srgb, var(--color-text) 78%, transparent)" }}>{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <ProtocolMarquee />

      {/* Beta CTA */}
      <section style={{ padding: "var(--space-8) var(--space-6)", textAlign: "center", maxWidth: 600, width: "100%", margin: "0 auto", boxSizing: "border-box" }}>
        <h2 style={{ fontFamily: "var(--font-heading)", fontSize: 32, margin: "0 0 var(--space-2)" }}>
          Meridian is opening in private beta.
        </h2>
        <p style={{ fontSize: 15, lineHeight: 1.5, margin: "0 auto var(--space-3)", color: "color-mix(in srgb, var(--color-text) 72%, transparent)" }}>
          Join the waitlist to get early access — beta testers get in with an invite password.
        </p>
        <WaitlistForm align="center" />
      </section>

      {/* Footer */}
      <footer className="text-muted" style={{ padding: "var(--space-4)", borderTop: "1px solid var(--color-divider)", fontSize: 12, marginTop: "auto", textAlign: "center" }}>
        Meridian — a unified DeFi terminal. Not financial advice.
      </footer>
    </div>
  );
}
