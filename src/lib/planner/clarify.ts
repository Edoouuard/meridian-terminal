/** A clarifying question the planner asks instead of proposing plans (STRATEGIST.md section 3). */
export interface PlannerClarify {
  question: string;
  /** What in the data made the question necessary. */
  why?: string;
  /** 2 to 4 complete answers the user can click; the recommended one first. */
  options: string[];
}

/** A clarifying question from the model, kept only when well formed (a question and 2 to 4 options). */
export function cleanClarify(v: unknown): PlannerClarify | null {
  if (!v || typeof v !== "object") return null;
  const c = v as { question?: unknown; why?: unknown; options?: unknown };
  if (typeof c.question !== "string" || !c.question.trim()) return null;
  const options = Array.isArray(c.options)
    ? c.options.filter((o): o is string => typeof o === "string" && !!o.trim()).map((o) => o.trim().slice(0, 160)).slice(0, 4)
    : [];
  if (options.length < 2) return null;
  return { question: c.question.trim().slice(0, 300), why: typeof c.why === "string" ? c.why.trim().slice(0, 240) : undefined, options };
}

