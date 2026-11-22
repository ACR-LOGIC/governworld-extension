// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// C4 — Label-free name recall measurement (and precision/trade-off record).

import { describe, expect, it } from "vitest";
import { detectNames } from "../src/content/detectors/names.js";

describe("C4 — Label-free name recall measurement", () => {
  it("detects label-free names followed by clinical/identity parentheticals", () => {
    const cases = [
      { text: "José Hernández (DOB 04/22/1990; MRN 12345)", expected: "José Hernández" },
      { text: "Maria Gonzalez (SSN 219-09-9999)", expected: "Maria Gonzalez" },
      { text: "Dr. Robert Miller (NPI 1234567893)", expected: "Robert Miller" },
      { text: "José Peña (Member ID MEM-998877)", expected: "José Peña" },
    ];
    let matched = 0;
    for (const c of cases) {
      const hits = detectNames(c.text);
      if (hits.some((h) => h.value === c.expected)) matched += 1;
    }
    expect(matched).toBe(cases.length);
  });

  it("documents current recall on bare unlabeled prose names without clinical qualifiers (0% by design to avoid prose FPs)", () => {
    const bareProse = [
      "Maria Gonzalez arrived at 9am.",
      "Please send the chart to Robert Miller.",
    ];
    const hits = bareProse.flatMap((t) => detectNames(t));
    // Bare unlabeled prose names without labels or parenthetical qualifiers are
    // intentionally not matched by regex-only detectNames() to preserve 0 prose FPs.
    expect(hits).toEqual([]);
  });
});
