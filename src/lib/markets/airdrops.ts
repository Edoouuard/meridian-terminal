/**
 * airdrops.ts — the perp DEX points programs running now: when each drops
 * its weekly points, the size of the pool, what earns points, and whether
 * Meridian trades the venue (then the neutral bot can farm it).
 *
 * There is no API for this: it is a curated list, compiled on 24 Oct 2026
 * from the programs' public pages as collected by arb.sh/airdrops. Programs
 * change week to week, so the view shows the compile date and links each
 * venue; a points program is not a promise of a token.
 */

export const AIRDROPS_COMPILED = "2026-10-24";

export type Earns = "volume" | "open interest" | "maker" | "deposit" | "referral" | "boosts" | "social";

export interface PointsProgram {
  venue: string;
  program: string;
  /** Points distributed per week ("≤ 950,000" when the pool scales). */
  weeklyPool: string;
  /** UTC weekday the weekly points drop (0 = Sunday); null when there is no fixed day. */
  dropDay: number | null;
  /** UTC hour of the drop when the program publishes one. */
  dropHourUtc?: number;
  earns: Earns[];
  /** Season end from the program's docs (YYYY-MM-DD). */
  endsOn?: string;
  note?: string;
  /** Meridian trades this venue: the neutral bot farms its volume and open interest. */
  meridian?: boolean;
  url?: string;
}

export const POINTS_PROGRAMS: PointsProgram[] = [
  { venue: "Hibachi", program: "Hibachi Points", weeklyPool: "1,000,000", dropDay: 1, dropHourUtc: 3, earns: ["volume", "referral", "deposit", "boosts"], note: "Half to trading activity, half to The Hibachi Open since Oct 6" },
  { venue: "Ondo Perps", program: "Ondo Points", weeklyPool: "5,000,000", dropDay: 2, earns: ["volume", "open interest"], url: "https://app.ondoperps.xyz/" },
  { venue: "RISEx", program: "RISEx Points · season 1", weeklyPool: "200,000", dropDay: 2, earns: ["volume", "open interest", "referral"], endsOn: "2027-06-30" },
  { venue: "Arcus", program: "Arcus Points · season 1", weeklyPool: "250,000", dropDay: 3, earns: ["volume", "maker", "deposit", "referral", "boosts"], endsOn: "2027-06-30", url: "https://app.arcus.xyz/" },
  { venue: "Paradex", program: "Paradex XP · season 3", weeklyPool: "4,000,000", dropDay: 3, earns: ["volume", "referral", "social"], note: "XP transferable between addresses since Oct 5", url: "https://app.paradex.trade/" },
  { venue: "Perpl", program: "Perpl Points · season 1", weeklyPool: "50,000", dropDay: 3, earns: ["volume", "referral"], note: "Wednesday snapshot, points within 48 hours" },
  { venue: "Pacifica", program: "Pacifica Points", weeklyPool: "10,000,000", dropDay: 4, earns: ["volume"], url: "https://app.pacifica.fi/" },
  { venue: "Variational Omni", program: "Omni Points", weeklyPool: "150,000", dropDay: 5, earns: ["referral", "boosts"], endsOn: "2026-12-31", note: "Covers the week through Thursday 00:00 UTC", url: "https://omni.variational.io/" },
  { venue: "Lighter (Robinhood Chain)", program: "Lighter RH Points", weeklyPool: "115,000", dropDay: 5, earns: ["volume"], note: "Points also accrue in real time", url: "https://robinhoodchain.lighter.xyz/" },
  { venue: "Nado", program: "Nado Points · season 2", weeklyPool: "≤ 950,000", dropDay: 5, earns: ["volume", "deposit", "referral", "boosts"], note: "Pool scales with the week's volume: 300k floor, 950k cap", url: "https://app.nado.xyz/" },
  {
    venue: "Extended",
    program: "Extended Points · The Final Arc",
    weeklyPool: "750,000 for the season",
    dropDay: null,
    earns: ["volume", "referral"],
    endsOn: "2026-11-02",
    note: "Weekly epochs have ended: the last points go out through The Final Arc competition (Oct 6 – Nov 2), with 250,000 USDC",
    meridian: true,
    url: "https://app.extended.exchange/",
  },
  { venue: "TxFlow", program: "No token yet", weeklyPool: "—", dropDay: null, earns: ["volume", "open interest"], note: "No weekly program published; volume and open interest are what perp programs reward", meridian: true, url: "https://app.txflow.com/" },
];

const DAY_MS = 86_400_000;

/** The next drop at or after `now` (UTC), or null for a program with no fixed day. */
export function nextDrop(p: PointsProgram, now: Date): Date | null {
  if (p.dropDay === null) return null;
  const hour = p.dropHourUtc ?? 0;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour);
  let delta = (p.dropDay - now.getUTCDay() + 7) % 7;
  if (delta === 0 && today < now.getTime()) delta = 7;
  return new Date(today + delta * DAY_MS);
}

/** Has the season's end date passed? */
export function hasEnded(p: PointsProgram, now: Date): boolean {
  return !!p.endsOn && Date.parse(`${p.endsOn}T23:59:59Z`) < now.getTime();
}

/** Programs still running, soonest drop first; those with no fixed day last. */
export function upcomingPrograms(now: Date, programs = POINTS_PROGRAMS): { program: PointsProgram; next: Date | null }[] {
  return programs
    .filter((p) => !hasEnded(p, now))
    .map((program) => ({ program, next: nextDrop(program, now) }))
    .sort((a, b) => (a.next?.getTime() ?? Infinity) - (b.next?.getTime() ?? Infinity));
}
