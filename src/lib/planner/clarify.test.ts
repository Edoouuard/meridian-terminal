import { describe, expect, it } from "vitest";
import { cleanClarify } from "./clarify";

describe("cleanClarify", () => {
  it("keeps a question with 2 to 4 options", () => {
    expect(cleanClarify({ question: " Fund Extended first? ", why: "Extended is empty", options: ["Yes", " No ", 3, "Both", "x", "y"] })).toEqual({
      question: "Fund Extended first?",
      why: "Extended is empty",
      options: ["Yes", "No", "Both", "x"],
    });
  });
  it("drops malformed questions", () => {
    expect(cleanClarify(null)).toBeNull();
    expect(cleanClarify({ question: "Which?", options: ["only one"] })).toBeNull();
    expect(cleanClarify({ options: ["a", "b"] })).toBeNull();
  });
});
