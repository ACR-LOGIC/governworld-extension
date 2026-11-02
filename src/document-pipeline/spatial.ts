// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
//
// Spatial indexing for page text boxes. Powered by rbush (an R-tree), so the
// pipeline can group boxes that share a region without an O(n^2) scan of every
// pair. Runs inside the offscreen document; pure JS, no DOM, no network.
import RBush from "rbush";
import type { OcrToken } from "./ocr.js";
import type { Rect } from "../shared/types.js";

const PAD = 1;

/** Bounding box in rbush's minX/minY/maxX/maxY form, padded so touching edges
 * count as hits (two boxes whose edges abut are treated as one block). */
interface SearchItem {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  index: number;
}

function item(rect: Rect, index: number): SearchItem {
  return {
    minX: rect.x - PAD,
    minY: rect.y - PAD,
    maxX: rect.x + rect.width + PAD,
    maxY: rect.y + rect.height + PAD,
    index,
  };
}

/**
 * Spatial index over page rectangles (OCR token boxes or detection rects).
 * Query with `intersectIndices(rect)` to learn which indexed rects overlap a
 * query rect, without scanning every pair.
 */
export class BoxIndex {
  private tree = new RBush<SearchItem>();
  build(rects: readonly Rect[]): this {
    this.tree.load(rects.map((r, i) => item(r, i)));
    return this;
  }
  /** Indexes of rects whose padded bounds intersect `rect`. */
  intersectIndices(rect: Rect): number[] {
    return this.tree.search(item(rect, -1)).map((i) => i.index).filter((i) => i >= 0);
  }
}

function unionRect(rects: readonly Rect[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Merge every pair of rects that overlap, iterating until stable.
 *
 * rectsForSpans previously ended with a comment saying overlapping rects would
 * be merged, but only filtered zero-area rects -- overlapping boxes from
 * adjacent OCR line groups were painted as separate slivers. This closes that
 * gap: any two rects whose padded bounds touch are unioned into one block, so
 * a multi-line match paints as contiguous blocks rather than staggered strips.
 */
export function mergeOverlappingRects(rects: readonly Rect[]): Rect[] {
  // Drop pathological zero-area rects first so they can't inflate a neighbour
  // when unioned (a zero-width rect still "touches" after padding).
  const work = rects.filter((r) => r.width > 0 && r.height > 0);
  if (work.length <= 1) return work;
  const index = new BoxIndex().build(work);
  const parent = work.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (let i = 0; i < work.length; i++) {
    for (const j of index.intersectIndices(work[i])) {
      if (j > i) {
        const a = find(i);
        const b = find(j);
        if (a !== b) parent[a] = b;
      }
    }
  }
  const groups = new Map<number, Rect[]>();
  for (let i = 0; i < work.length; i++) {
    const group = groups.get(find(i));
    if (group) group.push(work[i]);
    else groups.set(find(i), [work[i]]);
  }
  return [...groups.values()].map(unionRect);
}

/**
 * Sort tokens (or any objects exposing `.token.bbox`) in reading order:
 * top-to-bottom, then left-to-right. Tokens whose centers sit within
 * `lineTolerance` px vertically are treated as the same line and ordered by X,
 * so wrapped or skewed lines stay together and redaction boxes emit in a
 * deterministic order instead of OCR emission order.
 */
export function sortReadingOrder<T extends { token: OcrToken }>(
  items: readonly T[],
  lineTolerance = 4
): T[] {
  return [...items].sort((a, b) => {
    const ay = a.token.bbox.y + a.token.bbox.height / 2;
    const by = b.token.bbox.y + b.token.bbox.height / 2;
    if (Math.abs(ay - by) <= lineTolerance) {
      return (
        a.token.bbox.x + a.token.bbox.width / 2 -
        (b.token.bbox.x + b.token.bbox.width / 2)
      );
    }
    return ay - by;
  });
}
