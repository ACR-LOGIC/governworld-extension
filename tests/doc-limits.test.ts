// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, expect, it } from "vitest";
import {
  MAX_DOC_BYTES,
  MAX_DOC_BYTES_LABEL,
  MAX_DOC_PAGES,
  pageWindowLabel,
  resolvePageWindow,
} from "../src/shared/docLimits.js";

/**
 * The page-window contract.
 *
 * A 100-page document used to lose pages 21-100 silently: the preview rendered
 * the first 20 and the studio reported "20 pages" as if that were the document.
 * These tests pin the arithmetic that now lets the user choose the range, and
 * pin that no input can produce an empty or oversized window.
 */
describe("resolvePageWindow", () => {
  it("covers the whole document when it fits in one pass", () => {
    const w = resolvePageWindow(12, 1);
    expect(w).toEqual({ offset: 0, from: 1, to: 12, total: 12, windowed: false });
  });

  it("maps a requested 1-based range onto a 0-based offset", () => {
    // "Pages 21-40" is the user's words; the pipeline needs offset 20.
    const w = resolvePageWindow(100, 21);
    expect(w.offset).toBe(20);
    expect(w.from).toBe(21);
    expect(w.to).toBe(40);
    expect(w.windowed).toBe(true);
  });

  it("never exceeds the cap, and never runs past the last page", () => {
    // A window is *at most* the cap: starting at page 85 of a 100-page document
    // yields 85-100, because pages 101-120 do not exist.
    const w = resolvePageWindow(100, 85);
    expect(w.to - w.from + 1).toBe(16);
    expect(w.to).toBe(100);
    expect(w.offset).toBe(84);
  });

  it("clamps a start past the last page instead of producing an empty window", () => {
    const w = resolvePageWindow(30, 999);
    expect(w.from).toBe(30);
    expect(w.to).toBe(30);
    expect(w.offset).toBe(29);
    expect(w.windowed).toBe(true);
  });

  it("clamps a start below the first page", () => {
    const w = resolvePageWindow(50, -7);
    expect(w.from).toBe(1);
    expect(w.to).toBe(MAX_DOC_PAGES);
  });

  it("treats a nonsensical total as a single page rather than throwing", () => {
    for (const bad of [0, -5, Number.NaN, 12.5, Number.POSITIVE_INFINITY]) {
      const w = resolvePageWindow(bad, 1);
      expect(w.total).toBe(1);
      expect(w.from).toBe(1);
      expect(w.to).toBe(1);
    }
  });

  it("holds the cap at the document size when the document is smaller", () => {
    const w = resolvePageWindow(5, 1);
    expect(w.to).toBe(5);
    expect(w.windowed).toBe(false);
  });

  it("always returns at least one page", () => {
    for (let start = -2; start <= 25; start += 1) {
      const w = resolvePageWindow(20, start);
      expect(w.to).toBeGreaterThanOrEqual(w.from);
      expect(w.to - w.from + 1).toBeLessThanOrEqual(MAX_DOC_PAGES);
    }
  });
});

describe("pageWindowLabel", () => {
  it("is null for a full pass, so wording stays plain", () => {
    expect(pageWindowLabel(resolvePageWindow(7, 1))).toBeNull();
  });

  it("names the range for a partial pass", () => {
    expect(pageWindowLabel(resolvePageWindow(100, 21))).toBe("p21-40");
  });
});

describe("document limits", () => {
  it("pins the disclosed values", () => {
    expect(MAX_DOC_PAGES).toBe(20);
    expect(MAX_DOC_BYTES).toBe(20 * 1024 * 1024);
    expect(MAX_DOC_BYTES_LABEL).toBe("20 MB");
  });
});
