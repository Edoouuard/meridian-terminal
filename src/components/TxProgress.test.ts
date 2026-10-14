import { describe, expect, it } from "vitest";
import { fmtElapsed, slowAfterSeconds, typicalWait } from "@/components/TxProgress";

describe("TxProgress timing copy", () => {
  it("states the usual wait per chain", () => {
    expect(typicalWait(1)).toBe("usually 15 s to 1 min");
    expect(typicalWait(8453)).toBe("usually 2–10 s");
    expect(typicalWait(12345)).toBe("usually under a minute");
  });
  it("calls a wait slow past twice the usual upper bound", () => {
    expect(slowAfterSeconds(1)).toBe(120);
    expect(slowAfterSeconds(42161)).toBe(16);
  });
  it("formats elapsed time", () => {
    expect(fmtElapsed(42)).toBe("42s");
    expect(fmtElapsed(125)).toBe("2m 05s");
  });
});
