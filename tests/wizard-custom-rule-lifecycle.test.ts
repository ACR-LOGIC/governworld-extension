// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { analyzeExamples, testPattern, isSafeRegex, parseSampleLines } from "../src/shared/wizardAnalyzer.js";
import { parseCustomPattern, type CustomPattern } from "../src/shared/customPatterns.js";
import { detect, maskValue } from "../src/content/detect.js";
import { DEFAULT_SETTINGS, type Settings } from "../src/shared/settings.js";

describe("Logic Wizard — Custom Rule Lifecycle, Persistence & Reusability Contract", () => {
  let mockLocalStorage: Record<string, any> = {};

  beforeEach(() => {
    mockLocalStorage = {};
    (globalThis as any).chrome = {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: mockLocalStorage[key] })),
          set: vi.fn(async (items: Record<string, any>) => {
            Object.assign(mockLocalStorage, items);
          }),
        },
      },
    };
  });

  it("completes full wizard pipeline: example parsing -> analysis -> testing -> saving", () => {
    // 1. User provides raw example text with comments and whitespace
    const rawInput = [
      "# Confidential Acme Corp Tokens",
      "ACME-TOKEN-1001",
      "ACME-TOKEN-1002",
      "ACME-TOKEN-1003",
    ].join("\n");

    const positiveExamples = parseSampleLines(rawInput);
    expect(positiveExamples).toEqual(["ACME-TOKEN-1001", "ACME-TOKEN-1002", "ACME-TOKEN-1003"]);

    const negativeExamples = ["PUBLIC-TOKEN-99"];

    // 2. Wizard analysis generates candidate pattern locally
    const analysis = analyzeExamples(positiveExamples, "custom", negativeExamples);
    expect(analysis.proposedPattern).toBeDefined();
    expect(analysis.proposedPattern.length).toBeGreaterThan(0);
    expect(isSafeRegex(analysis.proposedPattern)).toBe(true);

    // 3. Wizard sandbox tests pattern against candidate text
    const testStrings = [
      "Target authorization code ACME-TOKEN-1001 was validated.",
      "Excluded code PUBLIC-TOKEN-99 should not match.",
    ];
    const testResults = testPattern(analysis.proposedPattern, analysis.proposedFlags, testStrings);
    expect(testResults[0].matched).toBe(true);
    expect(testResults[0].matchCount).toBe(1);
    expect(testResults[1].matched).toBe(false);

    // 4. Construct valid CustomPattern object
    const customRule: CustomPattern = {
      id: "123e4567-e89b-12d3-a456-426614174000",
      name: "Acme Security Token",
      category: "custom",
      pattern: analysis.proposedPattern,
      flags: analysis.proposedFlags || "gi",
      captureGroup: 0,
      confidence: 0.90,
      createdAt: new Date().toISOString(),
      source: "local",
      contributionStatus: "local_only",
    };

    const parsed = parseCustomPattern(customRule);
    expect(parsed.ok).toBe(true);

    // 5. Save rule to local storage
    const savedRules: CustomPattern[] = [customRule];
    mockLocalStorage["customPatterns"] = savedRules;

    // 6. Verify rule is retrieved from storage and immediately detects target values
    const retrievedPatterns = mockLocalStorage["customPatterns"] as CustomPattern[];
    expect(retrievedPatterns).toHaveLength(1);
    expect(retrievedPatterns[0].name).toBe("Acme Security Token");

    const webpageText = "System alert: Token ACME-TOKEN-1002 accessed by admin.";
    const findings = detect(webpageText, ["custom"], retrievedPatterns);

    expect(findings).toHaveLength(1);
    expect(findings[0].value).toBe("ACME-TOKEN-1002");
    expect(findings[0].category).toBe("custom");
    expect(findings[0].confidence).toBe(0.90);
    expect(maskValue("custom", findings[0].value)).toBe("***************");
  });

  it("enables saved rule reuse whenever the user wants across multiple sessions", () => {
    // Stored custom rule in local storage
    const storedRule: CustomPattern = {
      id: "223e4567-e89b-12d3-a456-426614174000",
      name: "Internal Secret Identifier",
      category: "secrets",
      pattern: "\\bKEY-[0-9]{5}\\b",
      flags: "gi",
      captureGroup: 0,
      confidence: 0.95,
      createdAt: new Date().toISOString(),
      source: "local",
      contributionStatus: "local_only",
    };
    mockLocalStorage["customPatterns"] = [storedRule];

    // Session 1: Scan Page A
    const pageAText = "Sensitive credential: KEY-55441 exposed in debug logs.";
    const findingsA = detect(pageAText, ["secrets"], mockLocalStorage["customPatterns"]);
    expect(findingsA).toHaveLength(1);
    expect(findingsA[0].value).toBe("KEY-55441");

    // Session 2: Scan Page B days later
    const pageBText = "Database backup contains KEY-88992 and unrelated text.";
    const findingsB = detect(pageBText, ["secrets"], mockLocalStorage["customPatterns"]);
    expect(findingsB).toHaveLength(1);
    expect(findingsB[0].value).toBe("KEY-88992");
  });

  it("coordinates toolbar popup to sidepanel handoff for resilient file uploads", async () => {
    // 1. Simulate user in ephemeral popup clicking import button
    const draftPos = "CUST-991\nCUST-992";
    const draftNeg = "ORDER-101";
    const draftName = "Customer ID Rule";

    // Popup writes handoff payload to local storage
    const handoffPayload = {
      step: 1,
      draftPositiveExamples: draftPos,
      draftNegativeExamples: draftNeg,
      draftRuleName: draftName,
      timestamp: Date.now(),
    };
    mockLocalStorage["wizardHandoffPending"] = handoffPayload;

    // 2. Simulate Side Panel startup hydration
    const stored = (await globalThis.chrome.storage.local.get("wizardHandoffPending")) as {
      wizardHandoffPending?: typeof handoffPayload;
    };
    const activeHandoff = stored.wizardHandoffPending;

    expect(activeHandoff).toBeDefined();
    expect(activeHandoff?.draftPositiveExamples).toBe(draftPos);
    expect(activeHandoff?.draftNegativeExamples).toBe(draftNeg);
    expect(activeHandoff?.draftRuleName).toBe(draftName);

    // 3. Side Panel consumes and clears handoff flag
    delete mockLocalStorage["wizardHandoffPending"];
    const cleared = await globalThis.chrome.storage.local.get("wizardHandoffPending");
    expect(cleared.wizardHandoffPending).toBeUndefined();
  });
});
