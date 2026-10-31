import { evidenceHistoricalView } from "./evidence-legacy-projection.js";
// Preserve historical whole-snapshot fixtures while checking every unrelated field.
// Changed allowance behavior has focused tests; assert its new guarantees before
// applying only the documented compatibility transforms for old receipt-less data.
import { expect } from "vitest";
import type { Snapshot } from "../src/dashboard/types.js";
export function allowanceHistoricalView(snapshot: Snapshot): Snapshot {
  const copy = structuredClone(snapshot);
  expect(copy.allowance.policyText).toContain("when this dashboard opened");
  delete copy.allowance.policyText;
  for (const p of copy.allowance.providers) {
    expect(p.uncertainty).toContain("Allowance could not be confirmed");
    expect(p.pill.state).not.toBe("plenty");
    delete p.uncertainty;
    if (p.pill.state === "no_reading" && p.windows.length > 0) {
      expect(p.pill.word).toBe("Allowance unconfirmed");
      p.pill = { state: "plenty", word: "Plenty" };
    }
    for (const w of p.windows) {
      expect(w.text).toMatch(/^Retained restriction: .+; latest observation unconfirmed$/);
      w.text = w.text.replace(/^Retained restriction: /, "").replace(/; latest observation unconfirmed$/, "");
    }
    if (p.limitedText !== null) {
      expect(p.limitedText).toContain("A new allowance check can be made");
      p.limitedText = p.limitedText.replace("A new allowance check can be made", "Work resumes");
    }
  }
  return evidenceHistoricalView(copy);
}
