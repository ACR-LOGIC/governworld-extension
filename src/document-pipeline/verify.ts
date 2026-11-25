// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
//
// Post-redaction verification.
//
// Producing bytes is not the same as redacting. A painter can silently no-op, a
// coordinate can be scaled wrong, an encoder can drop a layer - and the user
// receives a file that still shows the sensitive value while the UI reports
// success. That is precisely the kind of claim the audit chain exists to make
// trustworthy, so "we produced a file" and "we checked the file" are tracked as
// separate states.
//
// Runs inside the offscreen document: it needs DOM canvas access.

import type { Rect, RedactionOptions } from "../shared/types.js";

/**
 * A pixel counts as covered when its Rec.709 luminance is below this. Pure black
 * is 0; the threshold leaves room for encoder ringing on the box edges without
 * admitting partially-redacted text.
 */
export const REDACTION_DARK_LUMINANCE = 40;
export const REDACTION_WHITE_LUMINANCE = 215;

/**
 * Fraction of a redaction box that must be dark for the box to count as applied.
 * A box that is only mostly covered still has legible edges.
 */
export const REDACTION_MIN_DARK_FRACTION = 0.85;
export const REDACTION_MIN_STAMP_FRACTION = 0.70;

/**
 * Strict coverage required for the *interior* of a redaction box (the unpadded
 * rect shrunk past anti-aliased edges). applyBoxes paints solid fill, so the
 * interior of a correctly applied box is uniformly covered; anything below this
 * means content is showing through, even when the padded-box average still
 * clears REDACTION_MIN_DARK_FRACTION. Stamp style is exempt — its interior
 * intentionally carries the stamp text.
 */
export const REDACTION_MIN_INTERIOR_DARK_FRACTION = 0.99;
const INTERIOR_INSET_PX = 2;

/**
 * Luminance tolerance around the expected fill color. Encoder ringing on box
 * edges is why a small band is allowed; anything further is a sign the fill
 * was not actually applied.
 */
const COVERAGE_TOLERANCE = 8;

/**
 * Luminance of the fill color the painter will actually use, from the
 * configured `RedactionOptions.fillColor` (validated as `#rrggbb`). Falls back
 * to the historical thresholds when no color is configured.
 *
 * Without this, a custom fill color was rejected by the default dark-luminance
 * rule even when the painter applied it correctly, and whiteout boxes counted
 * as covered merely because the page area was already white.
 */
function configuredFillLuminance(options: RedactionOptions | undefined, isWhiteout: boolean): number {
  const color = options?.fillColor;
  if (typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color)) {
    const hex = color.slice(1);
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
  }
  return isWhiteout ? REDACTION_WHITE_LUMINANCE : REDACTION_DARK_LUMINANCE;
}

export type RedactionVerifyMethod = "pixel" | "page-pixels";

export interface RedactionVerification {
  /** True only when every checked region was confirmed covered. */
  verified: boolean;
  /**
   * How the check was performed, so the UI never implies more than was done.
   * - `pixel`: the encoded output was re-decoded and inspected.
   * - `page-pixels`: the page bitmaps that were flattened into the output were
   *   inspected. True for PDF output, where re-decoding the finished file would
   *   mean rendering it again.
   */
  method: RedactionVerifyMethod;
  checkedRegions: number;
  darkRegions: number;
  failures: string[];
}

/**
 * Identity of a redaction region within its page, from the absolute page index
 * plus the rect. Callers can match expectations against verification by this
 * key instead of trusting counts: a match that reported "1 checked, 1 dark"
 * while one of two expected regions was never verified fails the check.
 */
export function regionKey(pageIndex: number, rect: Rect): string {
  return `${pageIndex}:${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`;
}

export interface VerifiedRegion {
  key: string;
  pageIndex: number;
  rect: Rect;
  /** False when the region fell outside the page or its pixels could not be read. */
  checked: boolean;
  /** True only when the coverage checks passed for this region. */
  passed: boolean;
}

export interface RegionCoverage {
  checked: number;
  dark: number;
  failures: string[];
  regions: VerifiedRegion[];
}

/** Expands a rect by the padding the painter used, clipped to the canvas. */
function paddedBounds(rect: Rect, padding: number, width: number, height: number) {
  const x = Math.max(0, Math.floor(rect.x - padding));
  const y = Math.max(0, Math.floor(rect.y - padding));
  const right = Math.min(width, Math.ceil(rect.x + rect.width + padding));
  const bottom = Math.min(height, Math.ceil(rect.y + rect.height + padding));
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

/**
 * Confirms that each rect really is covered in the supplied canvas.
 *
 * Only the boxed regions are read back, never the whole bitmap: a 24-megapixel
 * page is ~96MB of RGBA and reading all of it to check a few hundred boxes would
 * be both slow and a good way to get the tab killed.
 *
 * Two checks run per rect. The padded-box check (85%) tolerates anti-aliased
 * edges and catches gross misplacement. The interior check (99% over the
 * unpadded rect shrunk past the edges) catches the dangerous middle case: a box
 * that is mostly painted yet leaves a legible strip of content visible.
 */
export function verifyCanvasRegions(
  canvas: HTMLCanvasElement,
  rects: Rect[],
  padding: number,
  label: string,
  options?: RedactionOptions,
  pageIndex = 0
): RegionCoverage {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return { checked: 0, dark: 0, failures: [`${label}: canvas is unreadable`], regions: [] };

  let checked = 0;
  let dark = 0;
  const failures: string[] = [];
  const regions: VerifiedRegion[] = [];
  const isWhiteout = options?.style === "whiteout";
  const isStamp = options?.style === "stamp" || Boolean(options?.stampText);
  const minFraction = isStamp ? REDACTION_MIN_STAMP_FRACTION : REDACTION_MIN_DARK_FRACTION;
  const fillLum = configuredFillLuminance(options, isWhiteout);

  const coveredFraction = (data: Uint8ClampedArray): number => {
    const pixels = data.length / 4;
    if (pixels === 0) return 0;
    let covered = 0;
    for (let i = 0; i < data.length; i += 4) {
      // eslint-disable-next-line security/detect-object-injection
      const luminance = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      // Coverage is established against the configured fill color: blackouts
      // count pixels at or below it, whiteouts count pixels at or above it.
      if (isWhiteout) {
        if (luminance >= fillLum - COVERAGE_TOLERANCE) covered += 1;
      } else if (luminance <= fillLum + COVERAGE_TOLERANCE) {
        covered += 1;
      }
    }
    return covered / pixels;
  };

  for (const rect of rects) {
    const region: VerifiedRegion = {
      key: regionKey(pageIndex, rect),
      pageIndex,
      rect,
      checked: false,
      passed: false,
    };
    regions.push(region);
    const box = paddedBounds(rect, padding, canvas.width, canvas.height);
    if (box.width === 0 || box.height === 0) {
      failures.push(`${label}: region at ${rect.x},${rect.y} falls outside the page`);
      continue;
    }
    let data: Uint8ClampedArray;
    try {
      data = ctx.getImageData(box.x, box.y, box.width, box.height).data;
    } catch (error) {
      failures.push(`${label}: could not read region at ${rect.x},${rect.y}`);
      continue;
    }
    region.checked = true;
    const fraction = coveredFraction(data);
    checked += 1;
    if (fraction < minFraction) {
      failures.push(
        `${label}: region at ${rect.x},${rect.y} is only ${(fraction * 100).toFixed(1)}% covered`
      );
      continue;
    }
    // Interior strict check (blackout/whiteout only): the painted fill is solid,
    // so a sub-99% interior means content is showing through the box.
    if (!isStamp) {
      const ix = Math.max(0, Math.ceil(rect.x + INTERIOR_INSET_PX));
      const iy = Math.max(0, Math.ceil(rect.y + INTERIOR_INSET_PX));
      const iright = Math.min(canvas.width, Math.floor(rect.x + rect.width - INTERIOR_INSET_PX));
      const ibottom = Math.min(canvas.height, Math.floor(rect.y + rect.height - INTERIOR_INSET_PX));
      const iwidth = Math.max(0, iright - ix);
      const iheight = Math.max(0, ibottom - iy);
      if (iwidth > 0 && iheight > 0) {
        try {
          const interiorData = ctx.getImageData(ix, iy, iwidth, iheight).data;
          const interiorFraction = coveredFraction(interiorData);
          if (interiorFraction < REDACTION_MIN_INTERIOR_DARK_FRACTION) {
            failures.push(
              `${label}: interior of region at ${rect.x},${rect.y} is only ${(interiorFraction * 100).toFixed(1)}% covered — content may be visible`
            );
            continue;
          }
        } catch (error) {
          failures.push(`${label}: could not read interior of region at ${rect.x},${rect.y}`);
          continue;
        }
      }
    }
    dark += 1;
    region.passed = true;
  }
  return { checked, dark, failures, regions };
}

/**
 * Re-decodes the finished PNG and verifies it.
 *
 * This is the strongest check available: it inspects the exact bytes that will be
 * handed to the browser, so an encoder that dropped or rescaled the redaction
 * layer cannot pass.
 */
export async function verifyEncodedPng(
  outputBytes: Uint8Array,
  rects: Rect[],
  padding: number,
  options?: RedactionOptions
): Promise<RedactionVerification> {
  const copy = new Uint8Array(outputBytes);
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(new Blob([copy], { type: "image/png" }));
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      return { verified: false, method: "pixel", checkedRegions: 0, darkRegions: 0, failures: ["canvas is unreadable"] };
    }
    ctx.drawImage(bitmap, 0, 0);
    const coverage = verifyCanvasRegions(canvas, rects, padding, "output", options);
    return {
      verified: coverage.failures.length === 0 && coverage.checked > 0,
      method: "pixel",
      checkedRegions: coverage.checked,
      darkRegions: coverage.dark,
      failures: coverage.failures
    };
  } catch (error) {
    return {
      verified: false,
      method: "pixel",
      checkedRegions: 0,
      darkRegions: 0,
      failures: [`output could not be re-decoded: ${error instanceof Error ? error.message : String(error)}`]
    };
  } finally {
    bitmap?.close();
  }
}

/** Verification result for output that was verified on its page bitmaps. */
export function pagePixelVerification(coverage: RegionCoverage): RedactionVerification {
  return {
    verified: coverage.failures.length === 0 && coverage.checked > 0,
    method: "page-pixels",
    checkedRegions: coverage.checked,
    darkRegions: coverage.dark,
    failures: coverage.failures
  };
}
