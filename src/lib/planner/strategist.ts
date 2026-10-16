import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The strategist doctrine (STRATEGIST.md): how the planner reads the data,
 * decodes intent, decides to ask or build, and ranks plans. It leads the
 * planner's system prompt; edit the markdown, not this loader. Read once per
 * server instance (next.config.ts ships the file with the route).
 */
let cached: string | null = null;

export function strategistDoctrine(): string {
  if (cached === null) {
    cached = readFileSync(path.join(process.cwd(), "src/lib/planner/STRATEGIST.md"), "utf8");
  }
  return cached;
}
