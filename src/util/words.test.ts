import { describe, expect, it } from "vitest";
import { featuresDone, plural } from "./words.js";

describe("plural", () => {
  it("adds an s except for one", () => {
    expect(plural(0, "feature")).toBe("0 features");
    expect(plural(1, "feature")).toBe("1 feature");
    expect(plural(2, "feature")).toBe("2 features");
  });
});

describe("featuresDone", () => {
  it("follows the total, so one feature reads as one feature", () => {
    expect(featuresDone(1, 1)).toBe("1 of 1 feature done");
    expect(featuresDone(0, 1)).toBe("0 of 1 feature done");
    expect(featuresDone(0, 0)).toBe("0 of 0 features done");
    expect(featuresDone(1, 3)).toBe("1 of 3 features done");
    expect(featuresDone(4, 6)).toBe("4 of 6 features done");
    expect(featuresDone(2, 2)).toBe("2 of 2 features done");
  });
});
