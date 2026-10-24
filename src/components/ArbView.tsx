"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import type { Address } from "viem";
import { usePerpTrader } from "@/hooks/usePerpTrader";
import { ValidatedExecuteButton } from "@/components/ValidatedExecuteButton";
import { CHAIN_LABEL } from "@/lib/onchain";
import { findToken } from "@/lib/assetMap";
import { bridgeOrderFromQuote } from "@/lib/bridgeOrder";
import type { RouteQuote } from "@/lib/mcp/router";
import { DEX_FEE_PCT, executablePrice, impactPct, type ArbOpportunity } from "@/lib/arb/scan";
import { arbPnlUsd, entryGapPct, loadArbPositions, saveArbPositions, type ArbPosition } from "@/lib/arb/positions";

export interface ArbScan {
  fetchedAt: string;
  sizeUsd: number;
  dexCount: number;
  opportunities: ArbOpportunity[];
}

/** The scan, refreshed every 30 s; shared by the view and the tab's badge. */
export function useArbScan(sizeUsd: number, enabled = true) {
  return useQuery({
    queryKey: ["arb-scan", sizeUsd],
    enabled,
    queryFn: async () => (await (await fetch(`/api/arb-scan?size=${sizeUsd}`)).json()) as ArbScan,
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
}

/** Opportunities worth a look: net of costs above `minNetPct`. */
export const ARB_MIN_NET_PCT = 0.15;

const usd = (n: number, signed = false) => `${n < 0 ? "−" : signed && n > 0 ? "+" : ""}$${Math.abs(n) >= 1000 ? Math.round(Math.abs(n)).toLocaleString("en-US") : Math.abs(n).toFixed(2)}`;
const pct = (x: number, d = 2) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)}%`;
const px = (n: number) => (n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : n >= 1 ? n.toFixed(4) : n.toPrecision(5));
const chainName = (id: number) => CHAIN_LABEL[id] ?? `chain ${id}`;
const keyOf = (o: Pick<ArbOpportunity, "base" | "venue"> & { dex: { chainId: number } }) => `${o.base}-${o.dex.chainId}-${o.venue}`;
const plainDirection = (o: ArbOpportunity) =>
  o.direction === "buy-onchain-short-perp"
    ? `Buy ${o.dex.symbol} on ${chainName(o.dex.chainId)} and short ${o.base} on ${o.venue}`
    : `Sell ${o.dex.symbol} on ${chainName(o.dex.chainId)} (from your wallet) and long ${o.base} on ${o.venue}`;

/**
 * Arbitrage between a token's price on-chain (DEX) and its perp on
 * Hyperliquid, Extended and TxFlow: a live scanner of the gaps net of what
 * trading them costs, a two-step trade (the on-chain swap, signed in the
 * wallet, then the perp hedge sent automatically for what the swap
 * delivered), and the open trades with their gap and PnL, closed the same
 * way when the gap has converged. The perp legs trade by themselves; every
 * on-chain swap asks the wallet.
 */
export function ArbView() {
  const { address } = useAccount();
  const [size, setSize] = useState(1000);
  const [minNet, setMinNet] = useState(ARB_MIN_NET_PCT);
  const scan = useArbScan(size);
  const [selected, setSelected] = useState<string | null>(null);
  const [positions, setPositions] = useState<ArbPosition[]>([]);
  useEffect(() => {
    // Reading this browser's saved trades for the wallet: external storage, read once per wallet.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPositions(loadArbPositions(address));
  }, [address]);
  const update = (next: ArbPosition[]) => {
    setPositions(next);
    if (address) saveArbPositions(address, next);
  };

  // Detection log: an opportunity entering the threshold is noted once (and notified when allowed).
  const seen = useRef<Set<string>>(new Set());
  const [detections, setDetections] = useState<{ at: number; text: string }[]>([]);
  const opps = scan.data?.opportunities ?? [];
  const live = opps.filter((o) => o.netPct >= minNet);
  useEffect(() => {
    const fresh = live.filter((o) => !seen.current.has(keyOf(o)));
    if (fresh.length === 0) return;
    for (const o of fresh) seen.current.add(keyOf(o));
    const lines = fresh.map((o) => ({ at: Date.now(), text: `${o.base}: ${pct(o.gapPct)} between ${chainName(o.dex.chainId)} and ${o.venue}, ${pct(o.netPct)} after costs (~${usd(o.netUsd)} on ${usd(o.sizeUsd)}).` }));
    setDetections((d) => [...lines, ...d].slice(0, 50));
    try {
      if (typeof Notification !== "undefined" && Notification.permission === "granted") for (const l of lines) new Notification("Meridian arbitrage", { body: l.text });
    } catch {
      /* notifications unavailable */
    }
  }, [live]);

  const sel = opps.find((o) => keyOf(o) === selected) ?? null;

  const [showAll, setShowAll] = useState(false);
  const rows = opps.slice(0, showAll ? 15 : 4);

  return (
    <section className="panel-card arb-card">
      <div className="panel-card__head">
        <h6 className="panel-card__title">Price arbitrage · DEX ↔ perp</h6>
        <span className={`bot-pill bot-pill--${live.length ? "good" : "idle"}`}>
          <span className="bot-pill__dot" aria-hidden />
          {scan.isLoading ? "Scanning…" : live.length ? `${live.length} live` : "none now"}
        </span>
      </div>
      <p className="text-muted arb-card__sub">
        Token price on-chain (DEX) vs its perp on Hyperliquid, Extended, TxFlow, net of the round trip&apos;s costs, every 30 s.{" "}
        <label className="arb-card__size">
          Size $
          <input type="number" min={10} value={size} onChange={(e) => setSize(Math.max(10, Number(e.target.value) || 10))} />
        </label>
      </p>

      {positions.length > 0 && (
        <div className="arb-card__open">
          {positions.map((p) => (
            <OpenArb key={p.id} p={p} now={opps.find((o) => o.base === p.base && o.dex.chainId === p.chainId && o.venue === p.venue) ?? null} onClosed={() => update(positions.filter((x) => x.id !== p.id))} />
          ))}
        </div>
      )}

      {scan.isError ? (
        <p className="bot-problem">The scan failed: {String(scan.error)}</p>
      ) : opps.length === 0 ? (
        <p className="text-muted bot-empty">{scan.isLoading ? "Reading on-chain and perp prices…" : "No token is priced on both sides right now."}</p>
      ) : (
        <div className="arb-rows">
          {rows.map((o) => (
            <button key={keyOf(o)} type="button" className={`arb-row${o.netPct >= minNet ? " is-hot" : ""}${selected === keyOf(o) ? " is-on" : ""}`} onClick={() => setSelected(selected === keyOf(o) ? null : keyOf(o))} title={`On-chain $${px(o.dex.priceUsd)} (${o.dex.dex}) · ${o.venue} $${px(o.perpPx)} · costs ${o.costPct.toFixed(2)}% · funding ${pct(o.fundingPctPerDay, 3)}/day`}>
              <span className="arb-row__name">
                <strong>{o.base}</strong> <span className="text-muted">{chainName(o.dex.chainId)} ↔ {o.venue}</span>
              </span>
              <span className="arb-row__gap">{pct(o.gapPct)}</span>
              <span className="arb-row__net" style={{ color: o.netPct > 0 ? "var(--risk-good)" : undefined }}>
                {pct(o.netPct)} net
              </span>
            </button>
          ))}
          {opps.length > 4 && (
            <button type="button" className="btn btn-secondary bot-mini" onClick={() => setShowAll((x) => !x)}>
              {showAll ? "Fewer" : `All ${Math.min(15, opps.length)}`}
            </button>
          )}
        </div>
      )}

      {sel && <ArbTrade o={sel} onClose={() => setSelected(null)} onOpened={(p) => update([p, ...positions])} />}

      <details className="arb-card__more">
        <summary className="text-muted">Alerts{detections.length ? ` · ${detections.length} detected` : ""}</summary>
        <div className="arb-card__alerts">
          <label className="arb-card__size">
            Alert above
            <input type="number" step={0.05} value={minNet} onChange={(e) => setMinNet(Number(e.target.value) || 0)} />% net
          </label>
          <button
            type="button"
            className="btn btn-secondary bot-mini"
            onClick={() => {
              try {
                void Notification.requestPermission();
              } catch {
                /* unsupported */
              }
            }}
          >
            Notify me
          </button>
        </div>
        {detections.map((d, i) => (
          <p key={`${d.at}-${i}`} className="bot-hint">
            {new Date(d.at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })} · {d.text}
          </p>
        ))}
        <p className="text-muted bot-footnote">
          On-chain prices are pool mid prices and costs are estimates: a trade gets the exact on-chain price first. The perp leg trades by itself; every on-chain swap asks your wallet. A perp can stay above or below spot while funding pays for it.
        </p>
      </details>
    </section>
  );
}

async function routeQuote(body: { chainId: number; from: string; to: string; amount: bigint; wallet: string }): Promise<RouteQuote | null> {
  const res = await fetch("/api/route-quote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fromChainId: body.chainId, toChainId: body.chainId, fromTokenAddress: body.from, toTokenAddress: body.to, fromAmount: body.amount.toString(), fromAddress: body.wallet }),
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `route quote failed (${res.status})`);
  return ((await res.json()) as { best: RouteQuote | null }).best;
}

/** One opportunity, traded in two steps: the exact on-chain price, then the swap (wallet) and the perp hedge (automatic). */
function ArbTrade({ o, onClose, onOpened }: { o: ArbOpportunity; onClose: () => void; onOpened: (p: ArbPosition) => void }) {
  const { address } = useAccount();
  const trader = usePerpTrader();
  const [quote, setQuote] = useState<{ q: RouteQuote; dexPx: number; tokens: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const buy = o.direction === "buy-onchain-short-perp";
  const usdc = findToken("USDC", o.dex.chainId);
  const qtyGuess = o.sizeUsd / o.dex.priceUsd;

  const getQuote = async () => {
    if (!address || !usdc) return;
    setBusy(true);
    setMsg(null);
    try {
      const amount = buy ? BigInt(Math.floor(o.sizeUsd * 1e6)) : BigInt(Math.floor(qtyGuess * 10 ** Math.min(o.dex.decimals, 12))) * 10n ** BigInt(Math.max(0, o.dex.decimals - 12));
      const q = await routeQuote({ chainId: o.dex.chainId, from: buy ? usdc.address : o.dex.address, to: buy ? o.dex.address : usdc.address, amount, wallet: address });
      if (!q?.toAmountEstimate) throw new Error("no signable route for this size");
      const out = BigInt(q.toAmountEstimate);
      const tokens = buy ? Number(out) / 10 ** o.dex.decimals : qtyGuess;
      const dexPx = buy ? executablePrice(o.sizeUsd, out, o.dex.decimals) : Number(out) / 1e6 / qtyGuess;
      if (!dexPx) throw new Error("the route returned nothing");
      setQuote({ q, dexPx, tokens });
    } catch (e) {
      setMsg(`Couldn't price it on-chain: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // The gap at the exact on-chain price: the entry's DEX cost is in it; the exit, gas and perp fees are still costs.
  const exactGap = quote ? (o.perpPx / quote.dexPx - 1) * 100 : null;
  const remainingCost = o.costPct - (DEX_FEE_PCT + impactPct(o.sizeUsd, o.dex.liquidityUsd));
  const exactNet = exactGap !== null ? Math.abs(exactGap) - remainingCost : null;
  const hedgeReady = trader.ready(o.venue);

  const hedge = async (hash: string) => {
    if (!quote || !address) return;
    setMsg(`Swap confirmed. Hedging ${quote.tokens.toPrecision(4)} ${o.base} on ${o.venue}…`);
    // A little under the estimate: the swap may deliver slightly less than quoted.
    const qty = quote.tokens * 0.995;
    const fill = await trader.order(o.venue, { market: o.market, isBuy: !buy, qty, leverage: 2, reduceOnly: false });
    if (!fill.ok || !fill.filledQty) {
      setMsg(`The swap went through but the ${o.venue} hedge failed (${fill.error ?? "no fill"}): you hold ${o.base} unhedged. Short it on ${o.venue} (Tools) or swap it back.`);
      return;
    }
    onOpened({
      id: `${Date.now()}`,
      base: o.base,
      chainId: o.dex.chainId,
      symbol: o.dex.symbol,
      address: o.dex.address,
      decimals: o.dex.decimals,
      direction: o.direction,
      qty: fill.filledQty,
      venue: o.venue,
      market: o.market,
      entryDexPx: quote.dexPx,
      entryPerpPx: fill.avgPx ?? o.perpPx,
      openedAt: Date.now(),
      swapTx: hash,
    });
    setMsg(`Open: ${fill.filledQty} ${o.base} ${buy ? "bought on-chain, short" : "sold on-chain, long"} on ${o.venue}. Close it below when the gap has closed.`);
    setQuote(null);
  };

  const fromToken = buy ? usdc : { address: o.dex.address as Address, symbol: o.dex.symbol, decimals: o.dex.decimals };
  const order = quote && fromToken ? bridgeOrderFromQuote(quote.q, { address: fromToken.address as Address, symbol: fromToken.symbol, decimals: fromToken.decimals }, buy ? BigInt(Math.floor(o.sizeUsd * 1e6)) : BigInt(Math.floor(quote.tokens * 10 ** Math.min(o.dex.decimals, 12))) * 10n ** BigInt(Math.max(0, o.dex.decimals - 12)), o.dex.chainId) : null;

  return (
    <div className="arb-trade">
      <div className="bot-card__head">
        <h6>{plainDirection(o)}</h6>
        <button type="button" className="btn btn-secondary bot-mini" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="bot-hint">
        Gap {pct(o.gapPct)} (on-chain ${px(o.dex.priceUsd)} on {o.dex.dex}, {o.venue} ${px(o.perpPx)}); estimated costs {o.costPct.toFixed(2)}%, net {pct(o.netPct)} ({usd(o.netUsd, true)} on {usd(o.sizeUsd)}). Funding on the perp leg: {pct(o.fundingPctPerDay, 3)} a day.
      </p>
      {!address ? (
        <p className="bot-problem">Connect a wallet.</p>
      ) : !hedgeReady ? (
        <p className="bot-problem">Connect {o.venue} first (Tools → Perp venues): the hedge goes there.</p>
      ) : !usdc ? (
        <p className="bot-problem">No USDC tracked on {chainName(o.dex.chainId)}.</p>
      ) : (
        <ol className="arb-steps">
          <li>
            <button type="button" className="btn btn-secondary bot-mini" disabled={busy} onClick={() => void getQuote()}>
              {busy ? "Pricing…" : quote ? "Price again" : "1. Get the exact on-chain price"}
            </button>
            {quote && exactGap !== null && exactNet !== null && (
              <span className="bot-hint">
                {" "}
                {buy ? "Buys" : "Sells"} {quote.tokens.toPrecision(5)} {o.dex.symbol} at ${px(quote.dexPx)} ({quote.q.provider === "lifi" ? "LI.FI" : "deBridge"}): gap {pct(exactGap)}, net of the remaining costs {pct(exactNet)}.
                {exactNet <= 0 && " Not worth it at this size: the gap is gone once the swap's real price is in."}
              </span>
            )}
          </li>
          <li>
            {order ? (
              <ValidatedExecuteButton order={order} label={`2. ${buy ? "Buy" : "Sell"} ${o.dex.symbol} on ${chainName(o.dex.chainId)}, then ${buy ? "short" : "long"} on ${o.venue} →`} onConfirmed={(h) => void hedge(h)} />
            ) : (
              <span className="text-muted bot-hint">2. Swap in your wallet, then the {o.venue} hedge is sent automatically for what the swap delivered.</span>
            )}
          </li>
        </ol>
      )}
      {msg && <p className="bot-hint">{msg}</p>}
    </div>
  );
}

/** An open trade: its gap now against entry, its PnL, and the close (swap back in the wallet, then the perp leg closed automatically). */
function OpenArb({ p, now, onClosed }: { p: ArbPosition; now: ArbOpportunity | null; onClosed: () => void }) {
  const { address } = useAccount();
  const trader = usePerpTrader();
  const [quote, setQuote] = useState<RouteQuote | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const buy = p.direction === "buy-onchain-short-perp";
  const usdc = findToken("USDC", p.chainId);
  const gapNow = now ? now.gapPct : null;
  const pnl = now ? arbPnlUsd(p, now.dex.priceUsd, now.perpPx) : null;
  const tokenUnits = BigInt(Math.floor(p.qty * 10 ** Math.min(p.decimals, 12))) * 10n ** BigInt(Math.max(0, p.decimals - 12));
  const usdBack = BigInt(Math.floor(p.qty * (now?.dex.priceUsd ?? p.entryDexPx) * 1.003 * 1e6));

  const prepare = async () => {
    if (!address || !usdc) return;
    try {
      // Unwind on-chain: sell what was bought, or buy back what was sold.
      const q = await routeQuote({ chainId: p.chainId, from: buy ? p.address : usdc.address, to: buy ? usdc.address : p.address, amount: buy ? tokenUnits : usdBack, wallet: address });
      if (!q) throw new Error("no signable route");
      setQuote(q);
    } catch (e) {
      setMsg(`Couldn't price the unwind: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const closePerp = async () => {
    setMsg(`Swap confirmed. Closing the ${p.venue} leg…`);
    const out = await trader.order(p.venue, { market: p.market, isBuy: buy, qty: p.qty, leverage: 2, reduceOnly: true });
    if (!out.ok) {
      setMsg(`The swap went through but closing on ${p.venue} failed (${out.error}): close the ${p.base} position there (Risk → Perp positions).`);
      return;
    }
    onClosed();
  };
  const order = quote && usdc ? bridgeOrderFromQuote(quote, buy ? { address: p.address as Address, symbol: p.symbol, decimals: p.decimals } : { address: usdc.address as Address, symbol: usdc.symbol, decimals: usdc.decimals }, buy ? tokenUnits : usdBack, p.chainId) : null;

  return (
    <div className="arb-open">
      <div className="arb-open__line">
        <strong>{p.base}</strong>
        <span className="text-muted">
          {p.qty} {p.symbol} {buy ? "bought" : "sold"} on {chainName(p.chainId)} · {buy ? "short" : "long"} {p.venue}
        </span>
        <span>
          gap {gapNow === null ? "—" : pct(gapNow)} <span className="text-muted">(entry {pct(entryGapPct(p))})</span>
        </span>
        <span style={{ color: pnl === null ? undefined : pnl >= 0 ? "var(--risk-good)" : "var(--risk-serious)", fontWeight: 600 }}>{pnl === null ? "—" : usd(pnl, true)}</span>
        {order ? (
          <ValidatedExecuteButton order={order} label={`${buy ? "Sell" : "Buy back"} ${p.symbol}, then close ${p.venue} →`} onConfirmed={() => void closePerp()} />
        ) : (
          <button type="button" className="btn btn-secondary bot-mini" onClick={() => void prepare()}>
            Close both legs
          </button>
        )}
      </div>
      {gapNow !== null && Math.abs(gapNow) < Math.abs(entryGapPct(p)) / 4 && <p className="bot-hint" style={{ color: "var(--risk-good)" }}>The gap has mostly closed: a good time to close.</p>}
      {msg && <p className="bot-hint">{msg}</p>}
    </div>
  );
}
