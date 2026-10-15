// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

const MARKUP = readFileSync("src/popup/index.html", "utf8");
const I18N_SRC = readFileSync("src/shared/i18n.ts", "utf8");

const COVERAGE_STATUSES = [
  "FULLY_SCANNED",
  "PARTIALLY_SCANNED",
  "UNSUPPORTED_CONTENT_PRESENT",
  "BLOCKED_BY_BROWSER_SECURITY",
  "NO_SENSITIVE_DATA_DETECTED",
  "SCAN_FAILED",
] as const;

/** The verdict the popup must be able to show for each worker status. */
const STATUS_KEY: Record<(typeof COVERAGE_STATUSES)[number], string> = {
  FULLY_SCANNED: "coverage_status_full",
  PARTIALLY_SCANNED: "coverage_status_partial",
  UNSUPPORTED_CONTENT_PRESENT: "coverage_status_unsupported",
  BLOCKED_BY_BROWSER_SECURITY: "coverage_status_blocked",
  NO_SENSITIVE_DATA_DETECTED: "coverage_status_clean",
  SCAN_FAILED: "coverage_status_failed",
};

const POPUP_TS = readFileSync("src/popup/popup.ts", "utf8");

describe("coverage panel honesty", () => {
  it("no longer ships hardcoded green ticks in the markup", () => {
    // The panel used to render five `coverage-icon--ok` spans that no code ever
    // changed, so every scan - including one that read nothing - displayed the
    // same all-clear. The icons are now neutral and the verdict is separate.
    expect(MARKUP).not.toContain("coverage-icon--ok");
    expect(MARKUP).not.toMatch(/coverage-icon--ok/);
  });

  it("provides the elements the coverage renderer owns", () => {
    expect(MARKUP).toContain('id="coverage-status"');
    expect(MARKUP).toContain('id="coverage-deferred"');
  });

  it("routes every worker coverage status to a translated verdict", () => {
    for (const status of COVERAGE_STATUSES) {
      const key = STATUS_KEY[status];
      expect(key, `no verdict key mapped for ${status}`).toBeTruthy();
      expect(POPUP_TS, `popup.ts does not handle ${status}`).toContain(key);
    }
  });

  it("defines every verdict key in all seven languages", () => {
    // i18n routing rule: t() reads only UI_TRANSLATIONS, so a key present in the
    // markup/TS but missing from a language silently falls back to English.
    const keys = [...new Set(Object.values(STATUS_KEY))].concat("coverage_deferred");
    const languageBlocks = I18N_SRC.split(/^\s{2}(en|es|fr|de|ja|pt|zh):\s*\{/m);
    // The first split element is the header; the rest alternate lang, body.
    const uiStart = I18N_SRC.indexOf("export const UI_TRANSLATIONS");
    const uiSrc = I18N_SRC.slice(uiStart);
    void languageBlocks;
    const langs = [...uiSrc.matchAll(/^  (en|es|fr|de|ja|pt|zh): \{/gm)].map((m) => m[1]);
    expect(langs.length, "UI_TRANSLATIONS must declare 7 languages").toBe(7);

    // Each language body runs until the next language key.
    const bodies = new Map<string, string>();
    for (const m of uiSrc.matchAll(/^  (en|es|fr|de|ja|pt|zh): \{/gm)) {
      const start = m.index! + m[0].length;
      const next = uiSrc.slice(start).search(/^  (en|es|fr|de|ja|pt|zh): \{/m);
      bodies.set(m[1], next === -1 ? uiSrc.slice(start) : uiSrc.slice(start, start + next));
    }

    for (const [lang, body] of bodies) {
      for (const key of keys) {
        expect(body, `${lang} is missing ${key}`).toContain(`"${key}"`);
      }
    }
  });

  it("only renders a green tone for a verdict that is genuinely a clean scan", () => {
    const ok = POPUP_TS.match(/tone:\s*"ok"/g) ?? [];
    // FULLY_SCANNED and NO_SENSITIVE_DATA_DETECTED are the only green outcomes.
    expect(ok.length).toBe(2);
    // Every other branch, plus the unknown fallback, must be warn or error.
    const green = [...POPUP_TS.matchAll(/case\s+"([A-Z_]+)":[\s\S]{0,220}?tone:\s*"(ok|warn|error)"/g)];
    expect(green.length).toBeGreaterThanOrEqual(6);
    for (const [, status, tone] of green) {
      if (status === "FULLY_SCANNED" || status === "NO_SENSITIVE_DATA_DETECTED") expect(tone).toBe("ok");
      else expect(tone, `${status} must not read as a clean scan`).not.toBe("ok");
    }
  });

  it("hides the verdict until a scan has actually completed", () => {
    // A panel that reads "Partially scanned" before any scan has run would be a
    // claim about nothing.
    expect(POPUP_TS).toMatch(/!state\.scanned[\s\S]{0,120}el\.hidden\s*=\s*true/);
  });

  it("treats truncated text as a partial scan rather than a clean one", () => {
    expect(POPUP_TS).toMatch(/state\.truncated[\s\S]{0,120}coverage_status_partial/);
  });

  it("carries the verdict through the session, not just the message", () => {
    const SW = readFileSync("src/service-worker/index.ts", "utf8");
    // MV3 terminates the worker between the scan and the popup opening. A
    // verdict held only in a message is gone by the time it is needed.
    expect(SW).toMatch(/stats:\s*\{[\s\S]{0,300}coverageStatus\?/);
  });

  it("validates a stored verdict instead of trusting it", () => {
    const SW = readFileSync("src/service-worker/index.ts", "utf8");
    // A session can be written by an older build or by anything else with
    // storage access; an unrecognised verdict must degrade to "not completed".
    const guard = SW.indexOf("function isSessionState");
    expect(guard, "isSessionState must exist").toBeGreaterThan(-1);
    const body = SW.slice(guard, SW.indexOf("async function readSession"));
    expect(body).toContain("SCAN_COVERAGE_STATUS_VALUES.has(v.stats.coverageStatus)");
    expect(body).toContain("v.stats.coverageStatus === undefined");
    // The set it checks against must enumerate the whole enum.
    const setStart = SW.indexOf("SCAN_COVERAGE_STATUS_VALUES: ReadonlySet");
    const setBody = SW.slice(setStart, setStart + 400);
    for (const status of COVERAGE_STATUSES) expect(setBody).toContain(`"${status}"`);
  });
});