// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Comprehensive tests for expanded medical Bloom packs, 4-gram phrases,
// drug+dosage boost, abbreviations/context, SymSpell fuzzy typos, and clinic modes.

import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/shared/settings.js";
import {
  detectMedicalDictionaryTerms,
  ensureMedicalDictionaryLoaded,
  resetMedicalDictionaryForTests,
} from "../src/content/detectors/medicalDictionary.js";
import { BloomFilter } from "../src/content/detectors/bloom.js";
import { detectPhrases } from "../src/content/detectors/phrases.js";

describe("Medical terms expansion — Bloom packs, phrases, dosage, fuzzy, clinicMode", () => {
  afterEach(() => {
    resetMedicalDictionaryForTests(false);
  });

  it("normalizes clinicMode setting with general as default", () => {
    expect(DEFAULT_SETTINGS.clinicMode).toBe("general");
    expect(normalizeSettings({}).clinicMode).toBe("general");
    expect(normalizeSettings({ clinicMode: "pediatrics" }).clinicMode).toBe("pediatrics");
    expect(normalizeSettings({ clinicMode: "obgyn" }).clinicMode).toBe("obgyn");
    expect(normalizeSettings({ clinicMode: "invalid" as unknown }).clinicMode).toBe("general");
  });

  it("matches multi-word phrases up to 4 tokens keeping longest match", () => {
    const bloom = new BloomFilter(2048, 8);
    bloom.add("type 2 diabetes");
    bloom.add("high blood pressure");
    bloom.add("blood pressure");

    const hits = detectPhrases("Patient has type 2 diabetes and high blood pressure.", bloom, 4);
    expect(hits.map((h) => h.norm)).toEqual(["type 2 diabetes", "high blood pressure"]);
  });

  it("boosts drug + dosage + frequency to >= 0.95 and scores negative context lower", async () => {
    await ensureMedicalDictionaryLoaded("general");

    const rx = detectMedicalDictionaryTerms("Patient prescribed metformin 500mg BID for type 2 diabetes.");
    const medHit = rx.find((h) => h.entityType === "prescription");
    const condHit = rx.find((h) => h.entityType === "medical_condition");
    expect(medHit).toBeDefined();
    expect(medHit!.confidence).toBeGreaterThanOrEqual(0.95);
    expect(condHit?.value.toLowerCase()).toBe("type 2 diabetes");

    const ad = detectMedicalDictionaryTerms("Metformin side effects may include nausea (example).");
    const adMed = ad.find((h) => h.entityType === "medication");
    expect(adMed).toBeDefined();
    expect(adMed!.confidence).toBeLessThan(0.5);
  });

  it("detects exact medical abbreviations", async () => {
    await ensureMedicalDictionaryLoaded("general");
    const hits = detectMedicalDictionaryTerms("PMH: HTN, DM2, CKD, HbA1c 7.4%");
    const values = hits.map((h) => h.value);
    expect(values).toContain("HTN");
    expect(values).toContain("DM2");
    expect(values).toContain("CKD");
    expect(values).toContain("HbA1c");
  });

  it("catches misspelled drug names via gated SymSpell + Damerau while ignoring everyday words", async () => {
    await ensureMedicalDictionaryLoaded("general");
    const typoHits = detectMedicalDictionaryTerms(
      "Taking metfomin 500mg, lisinoprill, atorvastin 20mg, amoxacillin, and ozempik; metaphor meeting."
    );
    const suggestions = typoHits
      .filter((h) => h.entityType?.startsWith("medication:"))
      .map((h) => h.entityType);

    expect(suggestions).toEqual([
      "medication:metformin",
      "medication:lisinopril",
      "medication:atorvastatin",
      "medication:amoxicillin",
      "medication:ozempic",
    ]);
    expect(typoHits.some((h) => h.value.toLowerCase().includes("metaphor"))).toBe(false);
    expect(typoHits.some((h) => h.value.toLowerCase().includes("meeting"))).toBe(false);
  });

  it("applies pediatrics and obgyn clinicMode demographic boosts while preserving mismatched coverage", async () => {
    await ensureMedicalDictionaryLoaded("pediatrics");
    const pedHits = detectMedicalDictionaryTerms("2 year old with croup, on albuterol nebulizer", "pediatrics");
    const croupPed = pedHits.find((h) => h.value.toLowerCase() === "croup");
    expect(croupPed).toBeDefined();
    expect(croupPed!.confidence).toBeGreaterThanOrEqual(0.82);

    await ensureMedicalDictionaryLoaded("obgyn");
    const obHits = detectMedicalDictionaryTerms(
      "28 weeks pregnant with preeclampsia, on labetalol 200mg; also prostate cancer.",
      "obgyn"
    );
    const preecl = obHits.find((h) => h.value.toLowerCase() === "preeclampsia");
    const prostate = obHits.find((h) => h.value.toLowerCase() === "prostate cancer");
    expect(preecl).toBeDefined();
    expect(preecl!.confidence).toBeGreaterThanOrEqual(0.82);
    expect(prostate).toBeDefined();
    expect(prostate!.confidence).toBeLessThan(0.65);
  });
});
