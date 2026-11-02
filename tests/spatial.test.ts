// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
//
// Spatial index over page text boxes (rbush R-tree): overlap queries and
// reading-order sorting used by the document pipeline to organize detection
// boxes into correct reading order and merge overlapping slivers.
import { describe, expect, it } from "vitest";
import { BoxIndex, mergeOverlappingRects, sortReadingOrder } from "../src/document-pipeline/spatial.js";
import type { OcrToken } from "../src/document-pipeline/ocr.js";
import type { Rect } from "../src/shared/types.js";

function token(
  x: number,
  y: number,
  width: number,
  height: number,
  lineIndex = 0,
  text = "x"
): OcrToken {
  return { text, confidence: 1, lineIndex, bbox: { x, y, width, height } };
}

function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height };
}

describe("BoxIndex", () => {
  it("finds indexes of rects intersecting a query rect", () => {
    const index = new BoxIndex().build([
      rect(0, 0, 10, 10),
      rect(20, 0, 10, 10),
      rect(5, 5, 10, 10), // overlaps the first two at their shared edge area
    ]);
    // Query rect covering x 8..12, y 8..12 touches index 0 (at 8..10) and 2 (at 5..15).
    const hits = index.intersectIndices(rect(8, 8, 4, 4));
    expect(hits.sort((a, b) => a - b)).toEqual([0, 2]);
    expect(hits).not.toContain(1);
  });

  it("treats touching edges as overlapping (1px pad)", () => {
    const index = new BoxIndex().build([rect(0, 0, 10, 10), rect(10, 0, 10, 10)]);
    expect(index.intersectIndices(rect(0, 0, 10, 10)).sort((a, b) => a - b)).toEqual([0, 1]);
  });

  it("returns empty when nothing intersects", () => {
    const index = new BoxIndex().build([rect(0, 0, 10, 10)]);
    expect(index.intersectIndices(rect(100, 100, 5, 5))).toEqual([]);
  });
});

describe("mergeOverlappingRects", () => {
  it("merges overlapping rects into one block", () => {
    const rects = [rect(0, 0, 10, 10), rect(8, 8, 10, 10), rect(40, 40, 5, 5)];
    const out = mergeOverlappingRects(rects);
    expect(out).toHaveLength(2);
    expect(out).toContainEqual(rect(0, 0, 18, 18)); // union of the first two
    expect(out).toContainEqual(rect(40, 40, 5, 5));
  });

  it("keeps separated rects separate", () => {
    const rects = [rect(0, 0, 5, 5), rect(20, 20, 5, 5), rect(40, 40, 5, 5)];
    expect(mergeOverlappingRects(rects)).toHaveLength(3);
  });

  it("chains overlaps through a middle rect", () => {
    const rects = [rect(0, 0, 10, 10), rect(8, 0, 10, 10), rect(16, 0, 10, 10)];
    const out = mergeOverlappingRects(rects);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(rect(0, 0, 26, 10));
  });

  it("drops zero-area rects", () => {
    expect(mergeOverlappingRects([rect(0, 0, 0, 5), rect(2, 2, 3, 3)])).toEqual([rect(2, 2, 3, 3)]);
  });

  it("handles empty input", () => {
    expect(mergeOverlappingRects([])).toEqual([]);
  });
});

describe("sortReadingOrder", () => {
  it("sorts top-to-bottom, then left-to-right", () => {
    const items = [
      { token: token(0, 100, 5, 5) }, // bottom-left
      { token: token(0, 0, 5, 5) }, // top-left
      { token: token(10, 0, 5, 5) }, // top-right
      { token: token(10, 100, 5, 5) }, // bottom-right
    ];
    const out = sortReadingOrder(items).map((t) => t.token.bbox.x + t.token.bbox.y * 1000);
    expect(out).toEqual([0, 10, 100000, 100010]);
  });

  it("treats near-equal Y as the same line and orders by X", () => {
    const items = [
      { token: token(50, 10, 5, 5) }, // right, slight Y jitter
      { token: token(0, 14, 5, 5) }, // left, within tolerance of line
    ];
    const out = sortReadingOrder(items).map((t) => t.token.bbox.x);
    expect(out).toEqual([0, 50]);
  });

  it("separates genuinely different lines by Y even if X overlaps", () => {
    const items = [
      { token: token(0, 0, 5, 5) },
      { token: token(0, 50, 5, 5) },
    ];
    const out = sortReadingOrder(items).map((t) => t.token.bbox.y);
    expect(out).toEqual([0, 50]);
  });
});
