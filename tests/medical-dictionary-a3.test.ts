// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// A3 (D3) — Medical dictionary, separate toggle, lazy-loaded.

import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/shared/settings.js";
import {
  detectMedicalDictionaryTerms,
  ensureMedicalDictionaryLoaded,
  isMedicalDictionaryLoaded,
  resetMedicalDictionaryForTests,
} from "../src/content/detectors/medicalDictionary.js";

describe("A3 (D3) — Medical dictionary separate toggle & lazy load", () => {
  afterEach(() => {
    resetMedicalDictionaryForTests(false);
  });

  it("defaults medicalDictionaryEnabled to false and normalizes boolean values", () => {
    expect(DEFAULT_SETTINGS.medicalDictionaryEnabled).toBe(false);
    expect(normalizeSettings({}).medicalDictionaryEnabled).toBe(false);
    expect(normalizeSettings({ medicalDictionaryEnabled: true }).medicalDictionaryEnabled).toBe(true);
  });

  it("remains unloaded until explicitly requested and lazy-loads via chrome.runtime.sendMessage", async () => {
    resetMedicalDictionaryForTests(true);
    expect(isMedicalDictionaryLoaded()).toBe(false);
    expect(detectMedicalDictionaryTerms("Diagnosis: hypertension, prescribed metformin.")).toEqual([]);

    const origChrome = (globalThis as { chrome?: unknown }).chrome;
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        sendMessage: async (msg: { type: string }) => {
          expect(msg.type).toBe("CONTENT_GET_MEDICAL_DICTIONARY");
          return { ok: true, terms: ["hypertension", "metformin"] };
        },
      },
    };
    try {
      const ok = await ensureMedicalDictionaryLoaded();
      expect(ok).toBe(true);
      expect(isMedicalDictionaryLoaded()).toBe(true);

      const hits = detectMedicalDictionaryTerms("Diagnosis: hypertension, prescribed metformin.");
      expect(hits.map((h) => h.value)).toEqual(["hypertension", "metformin"]);
      expect(hits.every((h) => h.category === "medical_record_number" && h.entityType === "medical_term")).toBe(true);
    } finally {
      (globalThis as { chrome?: unknown }).chrome = origChrome;
    }
  });
});
