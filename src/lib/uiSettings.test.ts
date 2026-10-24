import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, parseSettings, resolveTheme } from "./uiSettings";

describe("UI settings", () => {
  it("nothing stored, or broken JSON: the defaults (night, normal text, terminal, advanced tools on)", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("{oops")).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps valid choices and drops unknown values one by one", () => {
    expect(parseSettings(JSON.stringify({ theme: "light", textSize: "huge", startPage: "earn", showAdvanced: false }))).toEqual({
      theme: "light",
      textSize: "normal",
      startPage: "earn",
      showAdvanced: false,
    });
  });

  it("match device follows the device; night and day are fixed", () => {
    expect(resolveTheme("system", true)).toBe("light");
    expect(resolveTheme("system", false)).toBe("dark");
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("light", false)).toBe("light");
  });
});
