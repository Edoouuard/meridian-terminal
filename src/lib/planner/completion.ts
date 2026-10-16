/**
 * completion.ts — reading an OpenRouter chat completion. The text is usually
 * a string; some providers answer with an array of text parts.
 */
export function completionText(completion: unknown): string {
  const content = (completion as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : "")).join("");
  return "";
}
