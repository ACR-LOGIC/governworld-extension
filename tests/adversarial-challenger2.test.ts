import { describe, it, expect } from "vitest";
import { detect } from "../src/content/detect.js";
import { normalizeUnicodeWithMapping, mapNormalizedToOriginalOffset } from "../src/content/normalization/unicode.js";
import { isSafeRegex, testPattern } from "../src/shared/wizardAnalyzer.js";
import { runCustomPatterns } from "../src/content/detect.js";

describe("Adversarial Unicode & Astral Surrogate Stress Tests", () => {
  it("tests emoji + Plane 1 math digits SSN (exposes offset truncation bug)", () => {
    // 👤 is \uD83D\uDC64 (astral plane U+1F464, 2 UTF-16 code units)
    // 𝟚𝟙𝟡-𝟘𝟡-𝟡𝟡𝟡𝟡 are mathematical double-struck digits
    const text = "👤 ID: 𝟚𝟙𝟡-𝟘𝟡-𝟡𝟡𝟡𝟡";
    const matches = detect(text, ["ssn"], []);
    expect(matches).toHaveLength(1);
    expect(matches[0].value).toBe("𝟚𝟙𝟡-𝟘𝟡-𝟡𝟡𝟡𝟡");
    expect(text.slice(matches[0].start, matches[0].end)).toBe("𝟚𝟙𝟡-𝟘𝟡-𝟡𝟡𝟡𝟡");
  });

  it("tests Plane 1 math digits followed by emoji", () => {
    const text = "SSN: 𝟚𝟙𝟡-𝟘𝟡-𝟡𝟡𝟡𝟡 👤";
    const matches = detect(text, ["ssn"], []);
    expect(matches).toHaveLength(1);
    expect(matches[0].value).toBe("𝟚𝟙𝟡-𝟘𝟡-𝟡𝟡𝟡𝟡");
    expect(text.slice(matches[0].start, matches[0].end)).toBe("𝟚𝟙𝟡-𝟘𝟡-𝟡𝟡𝟡𝟡");
  });

  it("tests multiple emojis before standard SSN without normalization change", () => {
    const text = "👤🚀 SSN: 219-09-9999";
    const matches = detect(text, ["ssn"], []);
    expect(matches).toHaveLength(1);
    expect(matches[0].value).toBe("219-09-9999");
    expect(text.slice(matches[0].start, matches[0].end)).toBe("219-09-9999");
  });

  it("tests 2 emojis + Plane 1 math digits SSN (exposes multi-unit drift bug)", () => {
    const text = "👤🚀 SSN: 𝟚𝟙𝟡-𝟘𝟡-𝟡𝟡𝟡𝟡";
    const matches = detect(text, ["ssn"], []);
    expect(matches).toHaveLength(1);
    expect(matches[0].value).toBe("𝟚𝟙𝟡-𝟘𝟡-𝟡𝟡𝟡𝟡");
    expect(text.slice(matches[0].start, matches[0].end)).toBe("𝟚𝟙𝟡-𝟘𝟡-𝟡𝟡𝟡𝟡");
  });

  it("tests emoji + ZWSP + standard ASCII SSN (exposes drift with zero-width removal)", () => {
    const text = "👤\u200B SSN: 219-09-9999";
    const matches = detect(text, ["ssn"], []);
    expect(matches).toHaveLength(1);
    expect(matches[0].value).toBe("219-09-9999");
    expect(text.slice(matches[0].start, matches[0].end)).toBe("219-09-9999");
  });

  it("directly exposes off-by-one in mapNormalizedToOriginalOffset with astral emoji", () => {
    const text = "👤XYZ  "; // double space triggers normalization changed=true
    const norm = normalizeUnicodeWithMapping(text);
    expect(norm.changed).toBe(true);

    const xNormalizedIndex = norm.normalized.indexOf("X");
    expect(xNormalizedIndex).toBe(2);

    const xOriginalIndex = text.indexOf("X");
    expect(xOriginalIndex).toBe(2);

    const mapped = mapNormalizedToOriginalOffset(norm.mappings, xNormalizedIndex);
    expect(mapped).toBe(xOriginalIndex);
  });

  it("tests each of the 5 Plane 1 math digit blocks in isolation", () => {
    // Bold: U+1D7CE..U+1D7D7
    const boldSSN = "SSN: 𝟐𝟏𝟗-𝟎𝟗-𝟗𝟗𝟗𝟗";
    const boldMatches = detect(boldSSN, ["ssn"], []);
    expect(boldMatches).toHaveLength(1);
    expect(boldMatches[0].value).toBe("𝟐𝟏𝟗-𝟎𝟗-𝟗𝟗𝟗𝟗");
    expect(boldSSN.slice(boldMatches[0].start, boldMatches[0].end)).toBe("𝟐𝟏𝟗-𝟎𝟗-𝟗𝟗𝟗𝟗");

    // Double-struck: U+1D7D8..U+1D7E1
    const dsSSN = "SSN: 𝟚𝟙𝟡-𝟘𝟡-𝟡𝟡𝟡𝟡";
    const dsMatches = detect(dsSSN, ["ssn"], []);
    expect(dsMatches).toHaveLength(1);
    expect(dsMatches[0].value).toBe("𝟚𝟙𝟡-𝟘𝟡-𝟡𝟡𝟡𝟡");
    expect(dsSSN.slice(dsMatches[0].start, dsMatches[0].end)).toBe("𝟚𝟙𝟡-𝟘𝟡-𝟡𝟡𝟡𝟡");

    // Sans-serif: U+1D7E2..U+1D7EB
    const ssSSN = "SSN: 𝟤𝟣𝟫-𝟢𝟫-𝟫𝟫𝟫𝟫";
    const ssMatches = detect(ssSSN, ["ssn"], []);
    expect(ssMatches).toHaveLength(1);
    expect(ssMatches[0].value).toBe("𝟤𝟣𝟫-𝟢𝟫-𝟫𝟫𝟫𝟫");
    expect(ssSSN.slice(ssMatches[0].start, ssMatches[0].end)).toBe("𝟤𝟣𝟫-𝟢𝟫-𝟫𝟫𝟫𝟫");

    // Sans-serif bold: U+1D7EC..U+1D7F5
    const ssbSSN = "SSN: 𝟮𝟭𝟵-𝟬𝟵-𝟵𝟵𝟵𝟵";
    const ssbMatches = detect(ssbSSN, ["ssn"], []);
    expect(ssbMatches).toHaveLength(1);
    expect(ssbMatches[0].value).toBe("𝟮𝟭𝟵-𝟬𝟵-𝟵𝟵𝟵𝟵");
    expect(ssbSSN.slice(ssbMatches[0].start, ssbMatches[0].end)).toBe("𝟮𝟭𝟵-𝟬𝟵-𝟵𝟵𝟵𝟵");

    // Monospace: U+1D7F6..U+1D7FF
    const monoSSN = "SSN: 𝟸𝟷𝟿-𝟶𝟿-𝟿𝟿𝟿𝟿";
    const monoMatches = detect(monoSSN, ["ssn"], []);
    expect(monoMatches).toHaveLength(1);
    expect(monoMatches[0].value).toBe("𝟸𝟷𝟿-𝟶𝟿-𝟿𝟿𝟿𝟿");
    expect(monoSSN.slice(monoMatches[0].start, monoMatches[0].end)).toBe("𝟸𝟷𝟿-𝟶𝟿-𝟿𝟿𝟿𝟿");
  });

  it("tests payment card written in Plane 1 mathematical bold digits", () => {
    // Visa: 4111111111111111 in mathematical bold: 𝟒𝟏𝟏𝟏𝟏𝟏𝟏𝟏𝟏𝟏𝟏𝟏𝟏𝟏𝟏𝟏
    const boldVisa = "Payment card: 𝟒𝟏𝟏𝟏𝟏𝟏𝟏𝟏𝟏𝟏𝟏𝟏𝟏𝟏𝟏𝟏";
    const matches = detect(boldVisa, ["payment_card"], []);
    expect(matches).toHaveLength(1);
    expect(matches[0].value).toBe("𝟒𝟏𝟏𝟏𝟏𝟏𝟏𝟏𝟏𝟏𝟏𝟏𝟏𝟏𝟏𝟏");
    expect(boldVisa.slice(matches[0].start, matches[0].end)).toBe("𝟒𝟏𝟏𝟏𝟏𝟏𝟏𝟏𝟏𝟏𝟏𝟏𝟏𝟏𝟏𝟏");
  });

  it("tests mixed ASCII and Plane 1 math digits in SSN", () => {
    const mixedSSN = "SSN: 219-0𝟡-9999";
    const matches = detect(mixedSSN, ["ssn"], []);
    expect(matches).toHaveLength(1);
    expect(matches[0].value).toBe("219-0𝟡-9999");
    expect(mixedSSN.slice(matches[0].start, matches[0].end)).toBe("219-0𝟡-9999");
  });

  it("tests math digit at start and end of SSN", () => {
    const startMathSSN = "SSN: 𝟚19-09-9999";
    const matches1 = detect(startMathSSN, ["ssn"], []);
    expect(matches1).toHaveLength(1);
    expect(matches1[0].value).toBe("𝟚19-09-9999");
    expect(startMathSSN.slice(matches1[0].start, matches1[0].end)).toBe("𝟚19-09-9999");

    const endMathSSN = "SSN: 219-09-999𝟡";
    const matches2 = detect(endMathSSN, ["ssn"], []);
    expect(matches2).toHaveLength(1);
    expect(matches2[0].value).toBe("219-09-999𝟡");
    expect(endMathSSN.slice(matches2[0].start, matches2[0].end)).toBe("219-09-999𝟡");
  });
});

describe("Adversarial ReDoS Stress Tests", () => {
  const redosPatterns = [
    "(a+)+",
    "(a|ab)+",
    "([0-9]|\\d)+",
    "(a*)*",
    "(a+)*",
    "(a*)+",
    "(\\d+)+",
    "([a-z]+)+",
    "(a|a?)+",
  ];

  it.each(redosPatterns)("isSafeRegex must reject %s", (pattern) => {
    expect(isSafeRegex(pattern)).toBe(false);
  });

  it("tests group patterns in isSafeRegex", () => {
    expect(isSafeRegex("(abc)")).toBe(true);
    expect(isSafeRegex("(abc)+")).toBe(true);
    expect(isSafeRegex("(abc)*")).toBe(false); // matches empty string
  });

  it("tests advanced ReDoS patterns against isSafeRegex", () => {
    const advancedPatterns = [
      "(a+b+)+",
      "(a*b*)+",
      "(a|b|c)+",
      "(a?)+",
      "(?:a+)+",
      "((a)+)+",
      "(a+)+$",
      "(\\w+)+",
      "([a-zA-Z0-9]+)*",
      "(a|a)+",
      "(ab|a)+",
      "(a|[a-z])+",
      "(a|.)+",
    ];
    for (const pat of advancedPatterns) {
      expect(isSafeRegex(pat)).toBe(false);
    }
  });

  it("returns a result for every case within the time budget", () => {
    // A safe pattern on simple input should evaluate every case well within
    // the 50ms budget on any machine. Asserting result count (not timing)
    // keeps this deterministic across fast and slow CI runners.
    const manyCases = Array.from({ length: 5000 }, (_, i) => `Case test number ${i} with 123456 and padding`);
    const results = testPattern("\\d+", "g", manyCases);
    expect(results).toHaveLength(manyCases.length);
    expect(results.every((r) => r.matched)).toBe(true);
  });

  it("rejects an unsafe pattern immediately without evaluating cases", () => {
    // isSafeRegex is the primary safety net; testPattern must short-circuit
    // rejected patterns instead of evaluating them case by case.
    const results = testPattern("(a+)+", "g", ["aaaaaaaaaaaaaaaaaaaaa!"]);
    expect(results).toEqual([{ caseIndex: 0, matched: false, matchCount: 0 }]);
  });

  it("enforces safety and 50ms budget in runCustomPatterns", () => {
    // 1. Rejected pattern is skipped safely
    const customMatches = runCustomPatterns("aaaaaaaaaaaaaaaaaaaaa!", [
      {
        id: "p1",
        name: "ReDoS Test",
        category: "custom",
        pattern: "(a+)+",
        flags: "g",
        confidence: 0.9,
        createdAt: "2026-01-01",
        source: "local",
        contributionStatus: "local_only",
      },
    ]);
    expect(customMatches).toEqual([]);

    // 2. Many patterns against text with 50ms cap
    const patterns = Array.from({ length: 200 }, (_, i) => ({
      id: `p-${i}`,
      name: `Pattern ${i}`,
      category: "custom" as const,
      pattern: `TOKEN${i}-\\d{4}`,
      flags: "g",
      confidence: 0.8,
      createdAt: "2026-01-01",
      source: "local" as const,
      contributionStatus: "local_only" as const,
    }));
    const longText = "TOKEN1-1234 other text ".repeat(1000);
    const start = Date.now();
    const results = runCustomPatterns(longText, patterns);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(200);
  });
});
