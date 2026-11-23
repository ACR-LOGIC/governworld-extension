// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Verifies multi-format address detection (multiline, PO Box, Apt/Suite, no-comma,
// labeled street, card-overlap guard) and medical engine integration in pasteGuard.

import { describe, expect, it } from "vitest";
import { detect } from "../src/content/detect.js";
import { ALL_CATEGORIES } from "../src/shared/settings.js";
import { detectPasteFindings } from "../src/content/pasteGuard.js";
import { ensureMedicalDictionaryLoaded } from "../src/content/detectors/medicalDictionary.js";

describe("Address extraction audit (multiline, PO Box, units, labels, overlap guard)", () => {
  it("captures multiline addresses, PO Boxes, Apt/Suite, and no-comma city/state", () => {
    const samples = [
      "123 Main St\nSpringfield, IL 62701",
      "450 Oak Ave Apt 4B, Austin TX 78701",
      "P.O. Box 1234, Denver, CO 80202",
      "Address: 500 Training Plaza",
    ];
    for (const s of samples) {
      const hits = detect(s, ["address"]);
      expect(hits.length).toBeGreaterThanOrEqual(1);
      expect(hits[0].category).toBe("address");
    }
  });

  it("preserves the credit-card overlap guard on 5-digit ZIP lookahead", () => {
    const hits = detect("5 Ocean Rd 4111111111111111", ["address", "payment_card"]);
    expect(hits.some((h) => h.category === "payment_card" && h.value === "4111111111111111")).toBe(true);
  });

  it("includes medical Bloom/SymSpell matches in detectPasteFindings when enabled", async () => {
    await ensureMedicalDictionaryLoaded("general");
    const text = "Patient prescribed metformin 500mg BID for type 2 diabetes at 123 Main St\nSpringfield, IL 62701";
    const off = detectPasteFindings(text, ALL_CATEGORIES, [], { medicalDictionaryEnabled: false });
    expect(off.some((m) => m.category === "address")).toBe(true);
    expect(off.some((m) => m.entityType === "prescription")).toBe(false);

    const on = detectPasteFindings(text, ALL_CATEGORIES, [], { medicalDictionaryEnabled: true, clinicMode: "general" });
    expect(on.some((m) => m.category === "address")).toBe(true);
    expect(on.some((m) => m.entityType === "prescription")).toBe(true);
    expect(on.some((m) => m.entityType === "medical_condition")).toBe(true);
  });
});
