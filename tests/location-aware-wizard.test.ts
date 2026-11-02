// Deterministic tests for the location-aware wizard module.
// Synthetic fixtures only: no document contents or selected text are stored.
import { describe, expect, it } from "vitest";
import {
  inferLocationRule,
  matchLocation,
  type SelectionSample,
} from "../src/shared/locationAwareWizard.js";

function sample(
  pageNumber: number,
  pageWidth: number,
  pageHeight: number,
  rect: { x: number; y: number; width: number; height: number }
): SelectionSample {
  return { pageNumber, pageWidth, pageHeight, rect };
}

const SAME_REGION = { x: 100, y: 200, width: 80, height: 40 };

describe("inferLocationRule", () => {
  it("accepts three selections at the same normalized location", () => {
    const samples = [
      sample(1, 1000, 1000, SAME_REGION),
      sample(2, 1000, 1000, { x: 102, y: 201, width: 79, height: 41 }),
      sample(3, 1000, 1000, { x: 99, y: 199, width: 81, height: 39 }),
    ];
    const result = inferLocationRule(samples);
    expect(result.eligible).toBe(true);
    expect(result.rule).toBeDefined();
    expect(result.rule!.sampleCount).toBe(3);
    expect(result.rule!.requiresReview).toBe(true);
    expect(result.rule!.strategy).toBe("location");
  });

  it("rejects selections at different locations", () => {
    const samples = [
      sample(1, 1000, 1000, { x: 100, y: 200, width: 80, height: 40 }),
      sample(2, 1000, 1000, { x: 500, y: 600, width: 80, height: 40 }),
      sample(3, 1000, 1000, { x: 100, y: 800, width: 80, height: 40 }),
    ];
    const result = inferLocationRule(samples);
    expect(result.eligible).toBe(false);
    expect(result.rule).toBeUndefined();
    expect(result.reasons.join(" ")).toMatch(/consistent page location/i);
  });

  it("accepts pages with different dimensions but identical proportions", () => {
    const samples = [
      sample(1, 1000, 1000, { x: 100, y: 200, width: 80, height: 40 }),
      sample(2, 500, 500, { x: 50, y: 100, width: 40, height: 20 }),
      sample(3, 2000, 2000, { x: 200, y: 400, width: 160, height: 80 }),
    ];
    const result = inferLocationRule(samples);
    expect(result.eligible).toBe(true);
  });

  it("rejects pages with incompatible aspect ratios", () => {
    const samples = [
      sample(1, 1000, 1000, { x: 100, y: 200, width: 80, height: 40 }),
      sample(2, 800, 600, { x: 80, y: 120, width: 64, height: 24 }),
      sample(3, 600, 800, { x: 60, y: 160, width: 48, height: 32 }),
    ];
    const result = inferLocationRule(samples);
    expect(result.eligible).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/proportions/i);
  });

  it("rejects selections with inconsistent dimensions", () => {
    const samples = [
      sample(1, 1000, 1000, { x: 100, y: 200, width: 80, height: 40 }),
      sample(2, 1000, 1000, { x: 100, y: 200, width: 200, height: 200 }),
      sample(3, 1000, 1000, { x: 100, y: 200, width: 10, height: 10 }),
    ];
    const result = inferLocationRule(samples);
    expect(result.eligible).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/vary too much/i);
  });

  it("requires at least three distinct pages", () => {
    const samples = [
      sample(1, 1000, 1000, SAME_REGION),
      sample(1, 1000, 1000, SAME_REGION),
      sample(1, 1000, 1000, SAME_REGION),
    ];
    const result = inferLocationRule(samples);
    expect(result.eligible).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/distinct pages/i);
  });

  it("requires at least three samples", () => {
    const samples = [
      sample(1, 1000, 1000, SAME_REGION),
      sample(2, 1000, 1000, SAME_REGION),
    ];
    const result = inferLocationRule(samples);
    expect(result.eligible).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/at least 3/i);
  });

  it("rejects invalid dimensions", () => {
    const samples = [
      sample(1, 0, 1000, SAME_REGION),
      sample(2, 1000, 1000, SAME_REGION),
      sample(3, 1000, 1000, SAME_REGION),
    ];
    const result = inferLocationRule(samples);
    expect(result.eligible).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/invalid dimensions/i);
  });

  it("marks the rule as requiring review", () => {
    const samples = [
      sample(1, 1000, 1000, SAME_REGION),
      sample(2, 1000, 1000, SAME_REGION),
      sample(3, 1000, 1000, SAME_REGION),
    ];
    const result = inferLocationRule(samples);
    expect(result.eligible).toBe(true);
    expect(result.rule!.requiresReview).toBe(true);
    expect(result.rule!.confidence).toBeGreaterThan(0);
    expect(result.rule!.confidence).toBeLessThanOrEqual(1);
  });

  it("does not persist raw selected text in the rule", () => {
    const samples = [
      sample(1, 1000, 1000, SAME_REGION),
      sample(2, 1000, 1000, SAME_REGION),
      sample(3, 1000, 1000, SAME_REGION),
    ];
    const result = inferLocationRule(samples);
    const rule = result.rule!;
    // LocationRule has no text fields by contract.
    expect(Object.keys(rule)).not.toContain("text");
    expect(Object.keys(rule)).not.toContain("selectedText");
    expect(Object.keys(rule)).not.toContain("value");
    expect(JSON.stringify(rule)).not.toMatch(/SAME_REGION/);
  });
});

describe("matchLocation", () => {
  it("returns a candidate, never a redaction instruction", () => {
    const samples = [
      sample(1, 1000, 1000, SAME_REGION),
      sample(2, 1000, 1000, SAME_REGION),
      sample(3, 1000, 1000, SAME_REGION),
    ];
    const rule = inferLocationRule(samples).rule!;
    const candidate = matchLocation(rule, 1000, 1000);
    expect(candidate.matched).toBe(true);
    expect(candidate.candidateRect).toBeDefined();
    expect(typeof candidate.reason).toBe("string");
    // No auto-redact flag exists on the candidate.
    expect(Object.keys(candidate)).not.toContain("redact");
    expect(Object.keys(candidate)).not.toContain("apply");
  });

  it("rejects pages with incompatible aspect ratios", () => {
    const samples = [
      sample(1, 1000, 1000, SAME_REGION),
      sample(2, 1000, 1000, SAME_REGION),
      sample(3, 1000, 1000, SAME_REGION),
    ];
    const rule = inferLocationRule(samples).rule!;
    const candidate = matchLocation(rule, 800, 600);
    expect(candidate.matched).toBe(false);
    expect(candidate.confidence).toBe(0);
  });

  it("scales the candidate rect to the target page", () => {
    const samples = [
      sample(1, 1000, 1000, SAME_REGION),
      sample(2, 1000, 1000, SAME_REGION),
      sample(3, 1000, 1000, SAME_REGION),
    ];
    const rule = inferLocationRule(samples).rule!;
    const candidate = matchLocation(rule, 2000, 2000);
    expect(candidate.candidateRect.x).toBeGreaterThan(0);
    expect(candidate.candidateRect.width).toBeGreaterThan(0);
    expect(candidate.matched).toBe(true);
  });

  it("throws on invalid target dimensions", () => {
    const samples = [
      sample(1, 1000, 1000, SAME_REGION),
      sample(2, 1000, 1000, SAME_REGION),
      sample(3, 1000, 1000, SAME_REGION),
    ];
    const rule = inferLocationRule(samples).rule!;
    expect(() => matchLocation(rule, 0, 1000)).toThrow();
    expect(() => matchLocation(rule, 1000, -1)).toThrow();
  });
});
