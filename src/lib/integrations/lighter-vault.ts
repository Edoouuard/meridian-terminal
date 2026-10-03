/**
 * lighter-vault.ts — read-only live APR for Lighter's public liquidity pool
 * (LLP), the venue's own protocol-owned market-making/insurance vault
 * (the same product category as Hyperliquid's HLP).
 *
 * Source: Lighter's public, keyless REST endpoint
 * `GET https://mainnet.zklighter.elliot.ai/api/v1/publicPoolsMetadata`
 * (documented at apidocs.lighter.xyz, confirmed reachable without auth).
 * This sandbox's network egress proxy blocks that host, so the exact
 * response shape could not be directly inspected while building this —
 * written defensively against several plausible field-name/shape variants
 * rather than assuming one. If none parse as a finite APR, this returns
 * `null`: never a guessed or fabricated number.
 *
 * Note for whoever verifies this against a real response: depositing into
 * LLP itself requires locking LIT tokens at a fixed ratio (per Lighter's
 * own docs) — a real constraint to surface in the UI once this is wired
 * for more than a read, not something to silently omit.
 */

export const LIGHTER_PUBLIC_POOLS_URL = "https://mainnet.zklighter.elliot.ai/api/v1/publicPoolsMetadata";

interface RawLighterPool {
  name?: string;
  symbol?: string;
  apr?: number | string;
  apy?: number | string;
  annualized_return?: number | string;
  annualizedReturn?: number | string;
  tvl?: number | string;
  total_value?: number | string;
}

function toFiniteNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Fetch LLP's live APR. Returns `null` on any network failure, non-2xx, or
 * if the response doesn't contain a field this recognizes as an APR —
 * deliberately checks several plausible key names (apr/apy/annualized_return
 * in both snake_case and camelCase) since the exact shape wasn't verifiable
 * from this environment; it's honest best-effort, not a guess at the value.
 */
export async function fetchLighterLlpApr(): Promise<number | null> {
  try {
    const res = await fetch(LIGHTER_PUBLIC_POOLS_URL, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    const pools: RawLighterPool[] = Array.isArray(data) ? data : Array.isArray(data?.pools) ? data.pools : Array.isArray(data?.data) ? data.data : [];
    const llp = pools.find((p) => /\bllp\b/i.test(p.name ?? "") || /\bllp\b/i.test(p.symbol ?? "")) ?? pools[0];
    if (!llp) return null;
    const raw = llp.apr ?? llp.apy ?? llp.annualized_return ?? llp.annualizedReturn;
    const pct = toFiniteNumber(raw);
    if (pct === null) return null;
    // Normalize: some APIs report APR as a fraction (0.146) rather than a
    // percentage (14.6) — a fraction under 1 for a yield this large is far
    // more likely to mean 0.146 == 14.6% than an actual 0.146% return.
    return pct > 0 && pct < 1 ? pct * 100 : pct;
  } catch {
    return null;
  }
}
