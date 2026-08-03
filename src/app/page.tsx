"use client";

import { useState } from "react";
import Link from "next/link";
import { Reveal } from "@/components/landing/Reveal";
import { PromptDemo } from "@/components/landing/PromptDemo";
import { ProtocolMarquee } from "@/components/landing/ProtocolMarquee";
import { ApproachHero } from "@/components/landing/ApproachHero";
import { WaitlistForm } from "@/components/landing/WaitlistForm";

export default function Landing() {
  const [doorOpen, setDoorOpen] = useState(false);

  return (
    <div style={{ background: "var(--color-bg)", color: "var(--color-text)" }}>
      <div className="nav" style={{ background: "var(--color-surface)", position: "relative", zIndex: 3 }}>
        <span className="nav-brand">Meridian</span>
        <a href="#demo" className="text-muted" style={{ fontSize: 13 }}>
          See it work
        </a>
        <Link href="/app" className="text-muted" style={{ fontSize: 13 }}>
          Preview the terminal
        </Link>
      </div>

      <ApproachHero doorOpen={doorOpen}>
        <p className="card-kicker" style={{ marginBottom: "var(--space-3)" }}>
          Early access
        </p>
        <h1 className="hero-title">
          Speak your thesis.
          <br />
          Trade the terminal.
        </h1>
        <p className="hero-sub">
          Meridian turns a sentence of plain English into an executable order across every major protocol. Join the
          waitlist to be first in when it opens.
        </p>
        <div style={{ marginTop: "var(--space-4)", display: "flex", justifyContent: "center" }}>
          <WaitlistForm align="center" onSuccess={() => setDoorOpen(true)} />
        </div>
        {!doorOpen && (
          <a href="#demo" className="scroll-cue" aria-label="Scroll to see it work">
            ↓
          </a>
        )}
      </ApproachHero>

      {/* The one feature */}
      <section id="demo" className="landing-container" style={{ paddingTop: "var(--space-8)" }}>
        <Reveal style={{ textAlign: "center", maxWidth: 640, margin: "0 auto" }}>
          <h6 style={{ color: "var(--color-accent)" }}>Prompt to trade</h6>
          <h2>Describe a position. Watch it become an order.</h2>
          <p className="text-muted" style={{ marginBottom: "var(--space-6)" }}>
            Type a thesis below. Meridian reads it against Aave, Morpho, Lido, Pendle, Hyperliquid, Extended,
            Variational, and Uniswap, then proposes the exact trade to express it. No wallet needed to try it now.
          </p>
        </Reveal>
        <Reveal delay={80}>
          <div className="card demo-card">
            <PromptDemo />
          </div>
        </Reveal>
      </section>

      {/* Protocols, ambient */}
      <Reveal className="landing-full" style={{ marginTop: "var(--space-8)" }}>
        <ProtocolMarquee />
      </Reveal>

      {/* Final waitlist CTA */}
      <section className="cta-band">
        <div className="landing-container" style={{ textAlign: "center", padding: "var(--space-8) var(--space-4)" }}>
          <h2 style={{ marginBottom: "var(--space-3)" }}>Be first when Meridian opens.</h2>
          <p className="text-muted" style={{ maxWidth: 480, margin: "0 auto var(--space-4)" }}>
            Join the waitlist and we will email you the moment early access opens. No spam, just one message when it
            is your turn.
          </p>
          <div style={{ display: "flex", justifyContent: "center" }}>
            <WaitlistForm align="center" />
          </div>
        </div>
      </section>

      <footer style={{ borderTop: "1px solid var(--color-divider)", padding: "var(--space-4)" }}>
        <div className="landing-container" style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <span className="nav-brand" style={{ fontSize: 15 }}>
            Meridian
          </span>
          <span className="text-muted" style={{ fontSize: 12 }}>
            Prompt to trade DeFi terminal. Early access opening soon.
          </span>
        </div>
      </footer>
    </div>
  );
}
