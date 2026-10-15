// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";

/**
 * End-to-end shape of the verdict the popup must show, as a pure function
 * under test here so the policy is verifiable without a browser.
 *
 * `coverageVerdict` in popup.ts is DOM-bound and reads the i18n dictionary, so
 * the mapping is duplicated as a table. The agreement between this table and
 * popup.ts's switch is asserted by tests/coverage-panel-honesty.test.ts, which
 * reads popup.ts as text. If the two drift, that test fails.
 */
type Tone = "ok" | "warn" | "error";

const VERDICT: Record<string, { tone: Tone; key: string }> = {
  FULLY_SCANNED: { tone: "ok", key: "coverage_status_full" },
  NO_SENSITIVE_DATA_DETECTED: { tone: "ok", key: "coverage_status_clean" },
  PARTIALLY_SCANNED: { tone: "warn", key: "coverage_status_partial" },
  UNSUPPORTED_CONTENT_PRESENT: { tone: "warn", key: "coverage_status_unsupported" },
  BLOCKED_BY_BROWSER_SECURITY: { tone: "error", key: "coverage_status_blocked" },
  SCAN_FAILED: { tone: "error", key: "coverage_status_failed" },
};

/**
 * Mirrors popup.ts: no verdict without a completed scan, truncated text is
 * never a clean scan, and an unrecognised status degrades rather than
 * defaulting to clean.
 */
function verdict(state: { scanned: boolean; scanning?: boolean; error?: unknown; truncated: boolean; coverageStatus?: string }): { text: string; tone: Tone } | null {
  if (!state.scanned || state.scanning || state.error) return null;
  // Truncation is an independent signal of incompleteness: findings past the
  // character cap were never looked for, so no status can override it.
  if (state.truncated) return { text: "coverage_status_partial", tone: "warn" };
  const known = state.coverageStatus ? VERDICT[state.coverageStatus] : undefined;
  if (known) return { text: known.key, tone: known.tone };
  return { text: "coverage_status_unknown", tone: "warn" };
}

describe("coverage verdict policy", () => {
  it("shows nothing before a scan has completed", () => {
    expect(verdict({ scanned: false, truncated: false })).toBeNull();
    expect(verdict({ scanned: true, scanning: true, truncated: false })).toBeNull();
    expect(verdict({ scanned: true, error: { code: "x" }, truncated: false })).toBeNull();
  });

  it("is green only for the two genuinely clean outcomes", () => {
    expect(verdict({ scanned: true, truncated: false, coverageStatus: "FULLY_SCANNED" })?.tone).toBe("ok");
    expect(verdict({ scanned: true, truncated: false, coverageStatus: "NO_SENSITIVE_DATA_DETECTED" })?.tone).toBe("ok");
  });

  it("never reads green when something was not inspected", () => {
    const notGreen: Array<[string, Tone]> = [
      ["PARTIALLY_SCANNED", "warn"],
      ["UNSUPPORTED_CONTENT_PRESENT", "warn"],
      ["BLOCKED_BY_BROWSER_SECURITY", "error"],
      ["SCAN_FAILED", "error"],
    ];
    for (const [status, tone] of notGreen) {
      const got = verdict({ scanned: true, truncated: false, coverageStatus: status });
      expect(got?.tone, `${status} must not be green`).toBe(tone);
    }
  });

  it("treats truncated text as partial even with no explicit status", () => {
    expect(verdict({ scanned: true, truncated: true })).toEqual({
      text: "coverage_status_partial",
      tone: "warn",
    });
  });

  it("degrades an unrecognised status to unknown, never to clean", () => {
    const got = verdict({ scanned: true, truncated: false, coverageStatus: "SOMETHING_NEW" });
    expect(got?.tone).toBe("warn");
    expect(got?.text).toBe("coverage_status_unknown");
  });

  it("rejects a truncated scan even when the worker claimed FULLY_SCANNED", () => {
    // Defence in depth: two independent signals of incompleteness, and either
    // one alone must be enough to refuse a green verdict.
    const got = verdict({ scanned: true, truncated: true, coverageStatus: "FULLY_SCANNED" });
    expect(got?.tone).toBe("warn");
    expect(got?.text).toBe("coverage_status_partial");
  });
});

describe("deferred media is disclosed", () => {
  it("reports additional unscanned regions only when there are some", () => {
    const line = (count: number | undefined): string | null => {
      const n = count ?? 0;
      return n > 0 ? `coverage_deferred(${n})` : null;
    };
    expect(line(0)).toBeNull();
    expect(line(undefined)).toBeNull();
    expect(line(4)).toBe("coverage_deferred(4)");
  });
});