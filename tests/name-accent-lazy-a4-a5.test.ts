// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parseName, isStandaloneName, isNameToken } from "../src/content/detectors/nameParser.js";
import {
  ensureNameDictionariesLoaded,
  isNameDictionariesLoaded,
  resetNameDictionariesForTests,
} from "../src/content/detectors/nameDictionaries.js";
import { detectNames } from "../src/content/detectors/names.js";

describe("A4 / P10 — accent folding, lazy-load, measured trim", () => {
  afterEach(() => {
    resetNameDictionariesForTests(false);
  });

  it("folds diacritics and Ł/ł so Dr. Hernández parses as last name and accented names match", () => {
    const drH = parseName("Dr. Hernández");
    expect(drH.prefix).toBe("Dr");
    expect(drH.last).toBe("Hernández");
    expect(drH.first).toBeNull();

    const h = parseName("Hernández");
    expect(h.first ?? h.last).toBe("Hernández");

    const jh = parseName("José Hernández");
    expect(jh.first).toBe("José");
    expect(jh.last).toBe("Hernández");

    const drAlvarez = parseName("Dr. Álvarez");
    expect(drAlvarez.last).toBe("Álvarez");
    expect(drAlvarez.first).toBeNull();

    expect(isStandaloneName("Hernández")).toBe(true);
    expect(isStandaloneName("Peña")).toBe(true);
    expect(isNameToken("José")).toBe(true);
    expect(isNameToken("Müller")).toBe(true);
    expect(isNameToken("François")).toBe(true);
    expect(isNameToken("Łukasz")).toBe(true);
  });

  it("lazy-loads dictionaries via chrome.runtime.sendMessage when not already loaded", async () => {
    resetNameDictionariesForTests(true);
    expect(isNameDictionariesLoaded()).toBe(false);

    const origChrome = (globalThis as { chrome?: unknown }).chrome;
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        sendMessage: async (msg: { type: string }) => {
          expect(msg.type).toBe("CONTENT_GET_NAME_DICTIONARIES");
          return { ok: true, first: "JOSE\nMARIA", last: "HERNANDEZ\nPENA" };
        },
      },
    };
    try {
      const loaded = await ensureNameDictionariesLoaded();
      expect(loaded).toBe(true);
      expect(isNameDictionariesLoaded()).toBe(true);
      expect(isStandaloneName("Hernández")).toBe(true);
      expect(isNameToken("José")).toBe(true);
    } finally {
      (globalThis as { chrome?: unknown }).chrome = origChrome;
    }
  });

  it("excludes the ~2 MB census dictionaries from dist/content.js and ships assets/name-dictionaries.json", () => {
    const contentJs = resolve(process.cwd(), "dist", "content.js");
    const dictJson = resolve(process.cwd(), "dist", "assets", "name-dictionaries.json");
    expect(existsSync(contentJs)).toBe(true);
    expect(existsSync(dictJson)).toBe(true);
    expect(statSync(contentJs).size).toBeLessThan(350_000);
    expect(statSync(dictJson).size).toBeLessThan(2_000_000);
  });
});

describe("A5 — boost-only rule, never a detection gate", () => {
  afterEach(() => {
    resetNameDictionariesForTests(false);
  });

  it("detects novel/unlisted names identically whether dictionaries are unloaded or loaded", () => {
    const sample =
      "Patient: Xylophoria Zzyzx\nName: Qwertyuiop\nDr. José Hernández\nŚrīnivāsa Rāmānujan (DOB 01/02/1980)";

    resetNameDictionariesForTests(true);
    const unloaded = detectNames(sample);

    resetNameDictionariesForTests(false);
    isNameToken("José"); // triggers sync node load
    const loaded = detectNames(sample);

    expect(unloaded).toEqual(loaded);
    expect(unloaded.map((m) => m.value)).toEqual([
      "Xylophoria Zzyzx",
      "Qwertyuiop",
      "Śrīnivāsa Rāmānujan",
    ]);
  });
});
