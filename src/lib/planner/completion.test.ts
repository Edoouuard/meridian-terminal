import { describe, expect, it } from "vitest";
import { completionText } from "./completion";

describe("completionText", () => {
  it("reads a string, text parts, and nothing else", () => {
    expect(completionText({ choices: [{ message: { content: "{}" } }] })).toBe("{}");
    expect(completionText({ choices: [{ message: { content: [{ type: "text", text: "{\"a\"" }, { type: "text", text: ":1}" }] } }] })).toBe('{"a":1}');
    expect(completionText({ error: { message: "Provider returned error" } })).toBe("");
    expect(completionText(null)).toBe("");
  });
});
