// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// A detection rule the user wrote must actually run.
//
// `detect()` only executes custom patterns whose category is enabled, and
// `custom` is deliberately NOT in DEFAULT_SETTINGS — it is not a detector, it is
// the bucket authored rules land in. The wizard's default category is `custom`,
// so every rule created through the advertised path was saved, listed in the UI,
// and then silently discarded at scan time until the user independently found the
// Detection settings checkbox and ticked it.
//
// That is the worst shape of bug for this product: the feature looks like it
// works, because the rule is saved and listed, and the user is relying on it to
// catch something their other rules miss.
//
// These assert the end-to-end contract — save a wizard-shaped rule, then detect
// with DEFAULT_SETTINGS — because testing the filter in isolation would pass while
// the feature stayed broken.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { detect } from "../src/content/detect.js";
import { DEFAULT_SETTINGS, isCategoryEnabled } from "../src/shared/settings.js";
import type { CustomPattern } from "../src/shared/customPatterns.js";

const extRoot = process.cwd();
const workerSrc = readFileSync(join(extRoot, "src/service-worker/index.ts"), "utf8");

/** An internal employee id, the shape a user would build a rule for. */
const EMPLOYEE_ID = "EMP-88213";

const wizardPattern: CustomPattern = {
  id: "pattern-1",
  name: "Employee ID",
  category: "custom",
  pattern: String.raw`EMP-\d{5}`,
  flags: "gi",
  captureGroup: 0,
  confidence: 0.9,
  createdAt: "2026-01-01T00:00:00.000Z",
  source: "local",
  contributionStatus: "local_only",
};

describe("a rule written through the wizard runs without further setup", () => {
  it("is skipped under default settings — the defect this fixes", () => {
    // Pinned deliberately. Under DEFAULT_SETTINGS the rule produces nothing,
    // which is exactly why saving it has to enable its category. If a future
    // change makes `custom` enabled by default, this fails and the fix in
    // enableCategoryForPattern can be reconsidered as redundant.
    const findings = detect(`Employee ${EMPLOYEE_ID} reported.`, DEFAULT_SETTINGS.enabledCategories, [
      wizardPattern,
    ]);
    expect(findings.filter((f) => f.category === "custom")).toHaveLength(0);
  });

  it("runs once its category is enabled — which saving now does", () => {
    // The behaviour the user actually gets after saving a rule through the
    // wizard: the category is on, so the rule fires.
    const enabled = [...DEFAULT_SETTINGS.enabledCategories, "custom" as const];
    const findings = detect(`Employee ${EMPLOYEE_ID} reported.`, enabled, [wizardPattern]);
    expect(findings.map((f) => f.category)).toContain("custom");
  });

  it("is skipped when its category is disabled — the mechanism it relied on", () => {
    // Pin the root cause so the fix cannot be undone by "simplifying" the filter.
    const findings = detect(
      `Employee ${EMPLOYEE_ID} reported.`,
      DEFAULT_SETTINGS.enabledCategories.filter((c) => c !== "custom"),
      [wizardPattern]
    );
    expect(findings.filter((f) => f.category === "custom")).toHaveLength(0);
  });

  it("is not enabled by default, which is why saving must enable it", () => {
    expect(isCategoryEnabled(DEFAULT_SETTINGS, "custom")).toBe(false);
  });

  it("saving a rule enables the category it targets", () => {
    // The behavioural half: saving IS the user opting in, so the worker turns the
    // category on rather than leaving the rule inert.
    expect(workerSrc).toContain("async function enableCategoryForPattern");
    const saveCase = workerSrc.slice(workerSrc.indexOf('case "POPUP_CUSTOM_PATTERN_SAVE"'));
    expect(saveCase.slice(0, 400)).toContain("enableCategoryForPattern(msg.pattern.category)");
  });

  it("only ever adds a category, never narrows a mandated set", () => {
    // Enterprise policy can mandate a category set; saving a rule must not be a
    // way to remove one.
    const fn = workerSrc.slice(workerSrc.indexOf("async function enableCategoryForPattern"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).toContain("enabledCategories.includes(category)");
    expect(body).toContain("[...settings.enabledCategories, category]");
    // No filtering or replacing of the existing list.
    expect(body).not.toMatch(/\.filter\(/);
    expect(body).not.toMatch(/enabledCategories:\s*\[\s*category\s*\]/);
  });
});