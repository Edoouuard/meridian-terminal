/**
 * explain.ts — pipeline step 4: the model writes the text of plans the
 * server already validated, sized and ranked, without changing them. Every
 * number in its text must appear in the validated plan; a text that brings
 * a number of its own is replaced by a deterministic summary built here.
 */

import type { PlannerStrategy } from "@/lib/planner/schema";

export const EXPLAIN_SYSTEM = `You explain trading plans that Meridian's server has already validated, sized, priced and ranked.
Rules:
- Never change, add or recompute a number. Use only figures present in the JSON (economics, legs, figures, blockers, changes). Round only as they are shown.
- Keep each plan's kind, status, order and the recommendation exactly as given.
- A "requested" plan answers the user's request; an "alternative" changes it: say what it changes, and that choosing it is the user's call.
- A "blocked" plan: say what blocks it and what unblocks it. Never present it as ready.
- Projections at today's rates are not promises; say "at today's rates".
- Write in English only, whatever language the user writes in.
Return ONLY JSON: {"understanding": "...", "plans": [{"index": 0, "summary": "2-3 sentences", "fit": "one line", "risks": ["2 to 4 short items"], "variantNote": "the main caveat"}]}`;

/** What the explainer sees: the validated plans, without anything it could be tempted to alter silently. */
export function explainPayload(thesis: string, understanding: string | undefined, plans: PlannerStrategy[], recommended: number | undefined) {
  return {
    request: thesis,
    draftUnderstanding: understanding ?? "",
    recommended: recommended ?? null,
    plans: plans.map((p, index) => ({
      index,
      name: p.name,
      kind: p.kind,
      status: p.status,
      blockers: p.blockers ?? [],
      changes: p.changes ?? [],
      legs: p.legs.map((l) => ({ side: l.side, asset: l.asset, protocol: l.protocol, chain: l.chain, sizeUsd: l.sizeUsd ?? null, leverage: l.leverage ?? null, stopLossPct: l.stopLossPct ?? null })),
      economics: p.economics ?? null,
      figures: p.figures ?? [],
      execution: p.execution ?? null,
    })),
  };
}

const NUMBER = /-?\d[\d,]*(?:\.\d+)?/g;

/** Numbers a text states, as plain values (commas dropped). Small integers (counts, "2 legs", "1x") are ignored. */
export function statedNumbers(text: string): number[] {
  return (text.match(NUMBER) ?? [])
    .map((n) => Number(n.replace(/,/g, "")))
    .filter((n) => Number.isFinite(n) && !(Number.isInteger(n) && Math.abs(n) <= 3));
}

/** Units of time and percent a text may use without them being plan figures. */
const CONVENTIONS = [24, 100, 365, 8760];

/** Every number the validated plan (and the request) contains, with the roundings a text may show. */
function knownNumbers(plan: PlannerStrategy, thesis: string): number[] {
  const out: number[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "number" && Number.isFinite(v)) out.push(v);
    else if (typeof v === "string") (v.match(NUMBER) ?? []).forEach((n) => out.push(Number(n.replace(/,/g, ""))));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk({ legs: plan.legs, economics: plan.economics, figures: plan.figures, blockers: plan.blockers, changes: plan.changes, execution: plan.execution });
  walk(thesis);
  return [...out, ...CONVENTIONS];
}

/** A stated number matches a known one when it is that number rounded (to 0-4 decimals) or its absolute value. */
export function numberIsGrounded(n: number, known: number[]): boolean {
  return known.some((k) => [0, 1, 2, 3, 4].some((d) => Math.abs(Number(Math.abs(k).toFixed(d)) - Math.abs(n)) < 1e-9) || Math.abs(k - n) < 1e-9);
}

const usd = (n: number | null | undefined) => (n === null || n === undefined ? "unknown" : `$${n.toFixed(2)}`);

/** The deterministic summary of a validated plan, used when the explainer can't be trusted or didn't answer. */
export function templateSummary(p: PlannerStrategy): string {
  const parts: string[] = [];
  if (p.kind === "alternative") parts.push(`Alternative: changes your request (${(p.changes ?? []).join("; ")}).`);
  if (p.status === "blocked") parts.push(`Blocked for now: ${(p.blockers ?? []).join(" ")}`);
  const e = p.economics;
  if (e?.legs?.length) {
    parts.push(
      e.legs
        .map((l) => `${l.side} ${l.baseQuantity ?? "?"} ${l.market} on ${l.venue} (${usd(l.notionalUsd)}; ${l.legCarryAnnualPct >= 0 ? "earns" : "pays"} ${Math.abs(l.legCarryAnnualPct).toFixed(2)}%/yr funding)`)
        .join(", ") + ".",
    );
  }
  if (e) {
    const ret = e.annualizedReturnOnCapitalPct === null ? `net return not computable (${e.returnUnavailableReason})` : `${e.annualizedReturnOnCapitalPct.toFixed(2)}% per year on capital`;
    parts.push(
      `At today's rates: carry ${usd(e.annualizedGrossCarryUsd)}/yr, fees ${usd(e.entryExitCostUsd)} to enter and exit, ${ret} (capital ${usd(e.capitalCommittedUsd)}, ${e.holdingDays}-day holding assumed).`,
    );
  }
  return parts.join(" ") || p.summary;
}

export interface Explanation {
  index: number;
  summary?: string;
  fit?: string;
  risks?: string[];
  variantNote?: string;
}

/**
 * Put the explainer's text on the validated plans. A plan's text is used
 * only if every number in it is grounded in that plan; otherwise (or with no
 * explanation) the deterministic summary is used and its own text cleared.
 */
export function mergeExplanations(plans: PlannerStrategy[], explanations: Explanation[] | undefined, thesis: string): { plans: PlannerStrategy[]; rejected: number[] } {
  const rejected: number[] = [];
  const out = plans.map((p, i) => {
    const x = explanations?.find((e) => e && e.index === i);
    const texts = [x?.summary, x?.fit, x?.variantNote, ...(Array.isArray(x?.risks) ? x!.risks : [])].filter((t): t is string => typeof t === "string");
    const known = knownNumbers(p, thesis);
    const grounded = x && typeof x.summary === "string" && x.summary.trim() && texts.every((t) => statedNumbers(t).every((n) => numberIsGrounded(n, known)));
    if (!grounded) {
      if (x) rejected.push(i);
      return { ...p, summary: templateSummary(p), fit: undefined, variantNote: p.status === "blocked" ? (p.blockers ?? [])[0] ?? "" : "", risks: p.risks };
    }
    return {
      ...p,
      summary: x!.summary!.trim(),
      fit: typeof x!.fit === "string" ? x!.fit.trim() : p.fit,
      variantNote: typeof x!.variantNote === "string" ? x!.variantNote.trim() : p.variantNote,
      risks: Array.isArray(x!.risks) ? x!.risks.filter((r) => typeof r === "string").slice(0, 4) : p.risks,
    };
  });
  return { plans: out, rejected };
}
