/**
 * maker.ts — one leg of the neutral pair as a post-only (maker) order, the
 * other hedged at taker as the maker order fills: the maker side pays the
 * maker fee (Hyperliquid 0.015% against 0.045% taker), so a pair costs
 * about 40% less than two taker legs.
 *
 * The maker order joins the best price on its side of the book and only
 * ever adds liquidity (post-only: the venue refuses it rather than let it
 * take). Every `pollMs` the maker venue's position is read; what filled
 * since the last hedge is hedged on the other venue at taker, as soon as it
 * reaches that venue's minimum. When the book moves away by more than
 * `repostBps`, the order is cancelled and posted again at the new best
 * price. After `timeoutMs`:
 *   - opening: the order is cancelled and whatever filled stays as a
 *     (smaller) pair; a fill too small to hedge is closed again at taker;
 *   - closing: the remainder of both legs is closed at taker, so a close
 *     never waits on the book.
 * Between a maker fill and its hedge, that slice is exposed to the price
 * for at most one poll.
 *
 * Pure orchestration: the venues come in as `MakerVenues`, so it is tested
 * with fakes.
 */

export interface MakerFill {
  qty: number;
  px: number;
}

export interface MakerVenues {
  /** Best bid and ask on the maker venue. */
  book: () => Promise<{ bid: number; ask: number } | null>;
  /** Post-only limit order on the maker venue; `oid` when it rests. */
  post: (o: { isBuy: boolean; qty: number; px: number; reduceOnly: boolean }) => Promise<{ ok: boolean; oid?: number; error?: string }>;
  cancel: (oid: number) => Promise<void>;
  /** Signed position on the maker venue. */
  makerPosition: () => Promise<number>;
  /** Taker order on the maker venue (a close's remainder, or an unhedgeable fill). */
  makerTaker: (o: { isBuy: boolean; qty: number; reduceOnly: boolean }) => Promise<{ ok: boolean; filledQty?: number; avgPx?: number; error?: string }>;
  /** Taker order on the hedge venue. */
  hedge: (o: { isBuy: boolean; qty: number; reduceOnly: boolean }) => Promise<{ ok: boolean; filledQty?: number; avgPx?: number; error?: string }>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface MakerLegPlan {
  /** Side of the maker order (the hedge takes the other side). */
  isBuy: boolean;
  /** Base quantity to trade on each venue. */
  qty: number;
  reduceOnly: boolean;
  /** Smallest quantity the hedge venue takes in one order. */
  hedgeMinQty: number;
  /** Quantity step of the maker venue (to round what is posted). */
  makerStep: number;
  timeoutMs: number;
  pollMs: number;
  repostBps: number;
}

export interface MakerLegResult {
  maker: MakerFill[];
  makerTaker: MakerFill[];
  hedge: MakerFill[];
  /** Base quantity now held (opening) or closed (closing) on each venue, matched. */
  matchedQty: number;
  error?: string;
}

const clean = (x: number) => Math.round(x * 1e10) / 1e10;
const floorTo = (x: number, step: number) => (step > 0 ? clean(Math.floor(x / step + 1e-9) * step) : x);

export async function runMakerLeg(v: MakerVenues, p: MakerLegPlan): Promise<MakerLegResult> {
  const out: MakerLegResult = { maker: [], makerTaker: [], hedge: [], matchedQty: 0 };
  const dir = p.isBuy ? 1 : -1;
  const start = await v.makerPosition();
  const filledNow = async () => Math.max(0, ((await v.makerPosition()) - start) * dir);
  let filled = 0;
  let hedged = 0;
  let resting: { oid: number; px: number } | null = null;
  const deadline = v.now() + p.timeoutMs;

  const hedgeUpTo = async (qty: number) => {
    const delta = clean(qty - hedged);
    if (delta <= 0) return;
    const r = await v.hedge({ isBuy: !p.isBuy, qty: delta, reduceOnly: p.reduceOnly });
    if (!r.ok || !r.filledQty) {
      out.error = r.error ?? "the hedge didn't fill";
      return;
    }
    hedged = clean(hedged + r.filledQty);
    out.hedge.push({ qty: r.filledQty, px: r.avgPx ?? 0 });
  };
  const credit = (prev: number, px: number) => {
    if (filled > prev) out.maker.push({ qty: clean(filled - prev), px });
  };

  while (v.now() < deadline && filled < p.qty - p.makerStep / 2 && !out.error) {
    const book = await v.book();
    if (book) {
      const best = p.isBuy ? book.bid : book.ask;
      if (resting && Math.abs(best / resting.px - 1) * 10_000 > p.repostBps) {
        await v.cancel(resting.oid);
        const prev = filled;
        filled = await filledNow();
        credit(prev, resting.px);
        resting = null;
      }
      if (!resting) {
        const qty = floorTo(p.qty - filled, p.makerStep);
        if (qty <= 0) break;
        const r = await v.post({ isBuy: p.isBuy, qty, px: best, reduceOnly: p.reduceOnly });
        if (r.ok && r.oid !== undefined) resting = { oid: r.oid, px: best };
      }
    }
    await v.sleep(p.pollMs);
    const prev = filled;
    filled = await filledNow();
    if (resting) credit(prev, resting.px);
    // Fully filled: nothing rests any more.
    if (filled >= p.qty - p.makerStep / 2) resting = null;
    if (filled - hedged >= p.hedgeMinQty) await hedgeUpTo(filled);
  }

  if (resting) {
    await v.cancel(resting.oid);
    const prev = filled;
    filled = await filledNow();
    credit(prev, resting.px);
  }

  if (p.reduceOnly) {
    // A close never waits on the book: finish both legs at taker.
    const rest = clean(p.qty - filled);
    if (rest > 0) {
      const r = await v.makerTaker({ isBuy: p.isBuy, qty: rest, reduceOnly: true });
      if (r.ok && r.filledQty) {
        out.makerTaker.push({ qty: r.filledQty, px: r.avgPx ?? 0 });
        filled = clean(filled + r.filledQty);
      } else out.error = out.error ?? r.error ?? "closing the rest didn't fill";
    }
    if (!out.error || hedged < filled) await hedgeUpTo(filled);
  } else if (filled - hedged > 0) {
    if (filled - hedged >= p.hedgeMinQty) await hedgeUpTo(filled);
    // What can't be hedged is closed again: the pair never keeps an unhedged slice.
    const extra = clean(filled - hedged);
    if (extra > 0) {
      const r = await v.makerTaker({ isBuy: !p.isBuy, qty: extra, reduceOnly: true });
      if (r.ok && r.filledQty) {
        out.makerTaker.push({ qty: r.filledQty, px: r.avgPx ?? 0 });
        filled = clean(filled - r.filledQty);
      } else out.error = out.error ?? `an unhedged ${extra} was left on the maker venue (${r.error ?? "close failed"})`;
    }
  }
  out.matchedQty = Math.min(filled, hedged);
  return out;
}
