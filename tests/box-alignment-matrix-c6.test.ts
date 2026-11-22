// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// C6 — Box alignment matrix (DPI scaling, edge clamping, multi-line union).

import { describe, expect, it } from "vitest";
import { applyBoxes, scaleBox } from "../src/document-pipeline/render.js";
import { mergeOverlappingRects } from "../src/document-pipeline/spatial.js";

function makeTrackingCanvas(width: number, height: number) {
  const filled: { x: number; y: number; w: number; h: number }[] = [];
  const ctx = {
    fillStyle: "#000000",
    font: "",
    textAlign: "",
    textBaseline: "",
    save() {},
    restore() {},
    fillText() {},
    fillRect(x: number, y: number, w: number, h: number) {
      filled.push({ x, y, w, h });
    },
  };
  return {
    canvas: { width, height, getContext: () => ctx } as unknown as HTMLCanvasElement,
    filled,
  };
}

describe("C6 — Box alignment matrix", () => {
  it("scales boxes accurately across 1x, 1.5x, and 2x DPI factors", () => {
    const base = { x: 40, y: 80, width: 120, height: 24 };
    expect(scaleBox(base, 1, 1)).toEqual({ x: 40, y: 80, width: 120, height: 24 });
    expect(scaleBox(base, 1.5, 1.5)).toEqual({ x: 60, y: 120, width: 180, height: 36 });
    expect(scaleBox(base, 2, 2)).toEqual({ x: 80, y: 160, width: 240, height: 48 });
  });

  it("clamps padded boxes strictly within canvas bounds on all four edges", () => {
    const { canvas, filled } = makeTrackingCanvas(200, 100);
    applyBoxes(
      canvas,
      [
        { x: 0, y: 0, width: 10, height: 10 },
        { x: 192, y: 92, width: 8, height: 8 },
      ],
      6
    );
    expect(filled).toEqual([
      { x: 0, y: 0, w: 22, h: 22 },
      { x: 186, y: 86, w: 14, h: 14 },
    ]);
  });

  it("merges abutting/overlapping token boxes into contiguous blocks and drops zero-area rects", () => {
    const merged = mergeOverlappingRects([
      { x: 10, y: 10, width: 30, height: 12 },
      { x: 40, y: 10, width: 25, height: 12 },
      { x: 0, y: 0, width: 0, height: 10 },
    ]);
    expect(merged).toEqual([{ x: 10, y: 10, width: 55, height: 12 }]);
  });
});
