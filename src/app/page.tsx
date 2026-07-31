import Link from "next/link";
import { TickerBanner } from "@/components/TickerBanner";
import { Reveal } from "@/components/landing/Reveal";
import { StatCounter } from "@/components/landing/StatCounter";
import { PromptDemo } from "@/components/landing/PromptDemo";
import { ProtocolMarquee } from "@/components/landing/ProtocolMarquee";
import { HeroGlow } from "@/components/landing/HeroGlow";
import {
  ALPHA,
  HEALTH_FACTOR,
  HIGHLIGHT,
  NET_DELTA_ETH,
  NEWS,
  ROTATION_BARS,
  STAKING_CONCENTRATION_PCT,
  YIELD_CHART,
} from "@/lib/data";

export default function Landing() {
  return (
    <div style={{ background: "var(--color-bg)", color: "var(--color-text)" }}>
      <TickerBanner />
      <div className="nav" style={{ background: "var(--color-surface)" }}>
        <span className="nav-brand">Meridian</span>
        <a href="#demo" className="text-muted" style={{ fontSize: 13 }}>
          How it works
        </a>
        <Link href="/app" className="btn btn-primary" style={{ fontSize: 13 }}>
          Enter the terminal →
        </Link>
      </div>

      {/* Hero */}
      <HeroGlow>
        <section className="landing-container hero-section">
          <p className="card-kicker" style={{ marginBottom: "var(--space-3)" }}>
            AI-native DeFi terminal
          </p>
          <h1 className="hero-title">
            Speak your thesis.
            <br />
            Trade the terminal.
          </h1>
          <p className="hero-sub">
            Meridian reads your portfolio, the state of every major protocol, and a sentence of plain English —
            then proposes the exact order to express it, across Aave, Morpho, Lido, Pendle, Hyperliquid, Extended,
            Variational, and Uniswap.
          </p>
          <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap" }}>
            <Link href="/app" className="btn btn-primary" style={{ fontSize: 15, padding: "var(--space-3) var(--space-6)" }}>
              Enter the terminal →
            </Link>
            <a href="#demo" className="btn btn-secondary" style={{ fontSize: 15, padding: "var(--space-3) var(--space-6)" }}>
              Try a prompt below
            </a>
          </div>
          <a href="#demo" className="scroll-cue" aria-label="Scroll to demo">
            ↓
          </a>
        </section>
      </HeroGlow>

      {/* Interactive demo */}
      <section id="demo" className="landing-container" style={{ paddingTop: "var(--space-8)" }}>
        <Reveal>
          <h6 style={{ color: "var(--color-accent)" }}>Prompt to trade</h6>
          <h2 style={{ maxWidth: 640 }}>Describe a position. Watch it become an order.</h2>
          <p className="text-muted" style={{ maxWidth: 560, marginBottom: "var(--space-6)" }}>
            No wallet required to try it — this preview runs the same reasoning that ships in the terminal.
          </p>
        </Reveal>
        <Reveal delay={80}>
          <div className="card demo-card">
            <PromptDemo />
          </div>
        </Reveal>
      </section>

      {/* Market intelligence */}
      <section className="landing-container" style={{ paddingTop: "var(--space-8)" }}>
        <Reveal>
          <h6 style={{ color: "var(--color-accent)" }}>Always watching</h6>
          <h2 style={{ maxWidth: 640 }}>Every protocol&rsquo;s flows, in one glance.</h2>
        </Reveal>
        <div className="market-grid">
          <Reveal delay={80}>
            <div className="card" style={{ padding: "var(--space-4)", height: "100%" }}>
              <p style={{ margin: 0, fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 16 }}>Net TVL flows, 7 days</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: "var(--space-3)" }}>
                {ROTATION_BARS.map((rb) => (
                  <div key={rb.name} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                    <span style={{ width: 48, flex: "none" }}>{rb.name}</span>
                    <div style={{ flex: 1, height: 10, background: "var(--color-neutral-200)", borderRadius: 3, overflow: "hidden" }}>
                      <div className="bar-fill" style={{ width: rb.width, background: rb.color }} />
                    </div>
                    <span style={{ width: 56, flex: "none", textAlign: "right", fontVariantNumeric: "tabular-nums", color: rb.color }}>
                      {rb.value}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </Reveal>

          <Reveal delay={160}>
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)", height: "100%" }}>
              <div className="card" style={{ padding: "var(--space-4)" }}>
                <p style={{ margin: 0, fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 16 }}>
                  Fastest growing: {HIGHLIGHT.protocol}
                </p>
                <p style={{ margin: "4px 0 var(--space-2)", fontSize: 13 }} className="text-muted">
                  TVL <StatCounter to={2.5} decimals={1} prefix="$" suffix="B" /> {"→ "}
                  <strong style={{ color: "var(--color-text)" }}>
                    <StatCounter to={2.9} decimals={1} prefix="$" suffix="B" />
                  </strong>{" "}
                  in 30 days (<span style={{ color: "var(--color-accent-700)" }}>{HIGHLIGHT.chg}</span>)
                </p>
                <svg width="100%" height="34" viewBox="0 0 36 24" preserveAspectRatio="none">
                  <polyline points={HIGHLIGHT.points} fill="none" stroke="var(--color-accent)" strokeWidth={1.6} />
                </svg>
              </div>
              <div className="card" style={{ padding: "var(--space-4)", flex: 1 }}>
                <p style={{ margin: 0, fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 16 }}>Lock now, or wait?</p>
                <svg width="100%" height="40" viewBox="0 0 36 30" preserveAspectRatio="none" style={{ margin: "6px 0" }}>
                  <polyline points={YIELD_CHART.fixedPoints} fill="none" stroke="var(--color-accent)" strokeWidth={1.6} />
                  <polyline points={YIELD_CHART.varPoints} fill="none" stroke="var(--color-neutral-500)" strokeWidth={1.6} strokeDasharray="2,2" />
                </svg>
                <p style={{ margin: 0, fontSize: 13 }}>
                  <span style={{ color: "var(--color-accent-700)" }}>Pendle fixed, steady at 9.8%</span>
                </p>
                <p style={{ margin: 0, fontSize: 13 }} className="text-muted">
                  Aave variable, down from 6.8% to 5.2%
                </p>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* Risk teaser */}
      <section className="landing-container" style={{ paddingTop: "var(--space-8)" }}>
        <Reveal>
          <h6 style={{ color: "var(--color-accent)" }}>Risk, made legible</h6>
          <h2 style={{ maxWidth: 640 }}>See the whole book — and what to do about it.</h2>
        </Reveal>
        <Reveal delay={80}>
          <div className="card risk-teaser-card">
            <div className="risk-teaser-grid">
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                  <span className="text-muted">Health factor · Aave (example)</span>
                  <span style={{ color: "var(--risk-warning)", fontWeight: 600 }}>
                    <StatCounter to={HEALTH_FACTOR} decimals={2} />
                  </span>
                </div>
                <div style={{ height: 8, borderRadius: 4, background: "var(--color-neutral-200)", overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${(HEALTH_FACTOR / 2.5) * 100}%`, background: "var(--risk-warning)" }} />
                </div>
              </div>
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                  <span className="text-muted">Net ETH delta (example)</span>
                  <span style={{ color: "var(--risk-warning)", fontWeight: 600 }}>
                    +<StatCounter to={NET_DELTA_ETH} decimals={2} suffix=" ETH" />
                  </span>
                </div>
                <div style={{ height: 8, borderRadius: 4, background: "var(--color-neutral-200)", overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${NET_DELTA_ETH * 100}%`, background: "var(--risk-warning)" }} />
                </div>
              </div>
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                  <span className="text-muted">Staking concentration (example)</span>
                  <span style={{ color: "var(--risk-serious)", fontWeight: 600 }}>
                    <StatCounter to={STAKING_CONCENTRATION_PCT} suffix="%" />
                  </span>
                </div>
                <div style={{ height: 8, borderRadius: 4, background: "var(--color-neutral-200)", overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${STAKING_CONCENTRATION_PCT}%`, background: "var(--risk-serious)" }} />
                </div>
              </div>
            </div>
            <p style={{ margin: "var(--space-4) 0 0", fontSize: 14 }}>
              stETH plus PT weETH are <strong>42%</strong> of this example portfolio in one protocol risk. Meridian would suggest moving
              $6,000 into PT weETH — cutting that to 31% while locking in 9.8% fixed.
            </p>
          </div>
        </Reveal>
      </section>

      {/* News / Alpha teaser */}
      <section className="landing-container" style={{ paddingTop: "var(--space-8)" }}>
        <Reveal>
          <h6 style={{ color: "var(--color-accent)" }}>News and alpha</h6>
          <h2 style={{ maxWidth: 640 }}>What moved, and what&rsquo;s next — before it&rsquo;s consensus.</h2>
        </Reveal>
        <div className="feed-grid">
          {[...NEWS.slice(0, 2), ALPHA[1]].map((item, i) => (
            <Reveal key={item.protocol + i} delay={80 * i}>
              <div className="card" style={{ padding: "var(--space-3)", height: "100%" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <span className="tag tag-accent">{item.protocol}</span>
                  <span style={{ fontSize: 12, fontVariantNumeric: "tabular-nums", color: "var(--color-accent-700)" }}>{item.metric}</span>
                </div>
                <p style={{ margin: "var(--space-2) 0 0", fontSize: 14, lineHeight: 1.5 }}>{item.text}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* Protocols */}
      <Reveal className="landing-full" style={{ marginTop: "var(--space-8)" }}>
        <ProtocolMarquee />
      </Reveal>

      {/* Final CTA */}
      <section className="cta-band">
        <div className="landing-container" style={{ textAlign: "center", padding: "var(--space-8) var(--space-4)" }}>
          <h2 style={{ marginBottom: "var(--space-3)" }}>Onboard into DeFi. Manage it in one place.</h2>
          <p className="text-muted" style={{ maxWidth: 520, margin: "0 auto var(--space-4)" }}>
            Your portfolio, your convictions, and every protocol worth watching — one terminal, nothing else to open.
          </p>
          <Link href="/app" className="btn btn-primary" style={{ fontSize: 15, padding: "var(--space-3) var(--space-6)" }}>
            Enter the terminal →
          </Link>
        </div>
      </section>

      <footer style={{ borderTop: "1px solid var(--color-divider)", padding: "var(--space-4)" }}>
        <div className="landing-container" style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <span className="nav-brand" style={{ fontSize: 15 }}>
            Meridian
          </span>
          <span className="text-muted" style={{ fontSize: 12 }}>
            Prompt-to-trade DeFi terminal. Illustrative data unless a wallet is connected.
          </span>
        </div>
      </footer>
    </div>
  );
}
