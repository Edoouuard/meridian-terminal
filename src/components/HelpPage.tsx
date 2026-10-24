"use client";

import { AskButton } from "@/components/AskButton";
import { FeedbackButton } from "@/components/FeedbackButton";
import { startTour } from "@/components/ProductTour";
import { ACTIVE_CHAIN_IDS, CHAIN_LABEL } from "@/lib/onchain";

const CHAINS = ACTIVE_CHAIN_IDS.map((id) => CHAIN_LABEL[id]).join(", ");

const FAQ: { q: string; a: string }[] = [
  {
    q: "What is Meridian?",
    a: "A terminal where you say what you want in plain words (“earn yield on my USDC”, “stake my ETH”) and Meridian builds the steps for you, across the major DeFi protocols. You review each step before anything happens.",
  },
  {
    q: "Does Meridian hold my money?",
    a: "No. Your funds stay in your own wallet and your own accounts. Every transaction is signed by you in your wallet, and nothing moves without your approval. On perp exchanges (Hyperliquid, Extended, TxFlow) you approve a trading key once so orders can be placed on your account.",
  },
  {
    q: "How do I start?",
    a: "Connect a wallet (top right). Then type what you want in the bar at the bottom, or pick one of the suggestions. Meridian proposes a plan sized to what you hold; open it, check the steps, and sign them one by one.",
  },
  {
    q: "Which chains and wallets work?",
    a: `Meridian executes on ${CHAINS}. Browser wallets such as MetaMask or Rabby work; on a phone, open Meridian in your wallet app\u2019s browser.`,
  },
  {
    q: "What does it cost?",
    a: "You pay the network fees (gas) and the fees of the protocols you use, such as a swap fee or a bridge fee. Every plan shows its costs before you sign.",
  },
  {
    q: "What do APY, health factor and delta-neutral mean?",
    a: "APY is the yearly return, including compounding. The health factor measures how safe a loan is: below 1, the collateral gets sold (liquidation). Delta-neutral means a long and a short of the same size, so price moves cancel and only the yield or funding remains.",
  },
  {
    q: "What are the risks?",
    a: "Rates change, smart contracts can have bugs, borrowed positions can be liquidated if prices move against them, and perp positions can be closed if margin runs out. Each plan lists its own risks; ask “explain the risks” in the terminal for a plain-words version.",
  },
  {
    q: "A transaction is stuck or something looks wrong.",
    a: "Check Portfolio → History for the status of each order and a link to the explorer. A pending transaction can take a few minutes when the network is busy. If something still looks off, report it with the button below and we will look at it.",
  },
  {
    q: "Can I change how Meridian looks?",
    a: "Yes: Settings has day and night mode, larger text, the page Meridian opens on, and a switch to hide the advanced perp tools.",
  },
];

/** Plain-words answers for someone who's lost, plus the tour and a way to reach us. */
export function HelpPage() {
  return (
    <div className="page__narrow help">
      <div className="help__actions">
        <button type="button" className="btn btn-primary" onClick={startTour}>
          Take the 1-minute tour
        </button>
        <FeedbackButton className="btn btn-secondary" />
      </div>
      <section className="panel-card help__faq">
        <h2 className="settings__section">Questions</h2>
        {FAQ.map((f, i) => (
          <details key={f.q} className="faq" open={i === 0}>
            <summary className="faq__q">{f.q}</summary>
            <p className="faq__a">{f.a}</p>
          </details>
        ))}
      </section>
      <section className="panel-card">
        <h2 className="settings__section">Not sure what to ask?</h2>
        <p className="text-muted" style={{ margin: 0, fontSize: 14 }}>
          Try one of these in the terminal:
        </p>
        <div className="help__prompts">
          <AskButton label="Best yield on my stablecoins" prompt="Find the best yield on my stablecoins across all chains. Bridge or swap only if it pays off." />
          <AskButton label="Explain DeFi lending simply" prompt="Explain in simple words how lending on Aave works, what I earn and what the risks are." />
          <AskButton label="What can I do with my wallet?" prompt="Look at my wallet and suggest two or three safe ways to put it to work, in plain words." />
        </div>
      </section>
    </div>
  );
}
