// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import type { CoverageInfo, CanonicalBoundary } from "./types.js";

export function createInitialCoverage(): CoverageInfo {
  return {
    dom: "complete",
    shadowDom: "complete",
    sameOriginFrames: "complete",
    crossOriginFrames: "complete",
    dynamicContent: "unmonitored",
    virtualizedContent: "unknown",
    totalBoundaries: 0,
    inaccessibleBoundaries: 0,
    complete: true,
  };
}

export interface FrameReadReport {
  /** Frames found anywhere in the tree, at any depth, through shadow roots. */
  present: number;
  /** Frames whose document this pass actually extracted. */
  read: number;
}

/**
 * The single implementation of boundary-driven coverage. Every caller derives
 * frame and shadow status from here rather than assembling its own object, so
 * "complete" cannot mean two different things in two places.
 *
 * `frames` is required because a boundary list alone cannot tell "this page has
 * no frames" from "this page has frames and this pass read none of them" — the
 * second is the case that produced a clean bill of health for a document
 * nobody read. `extraIncomplete` refuses completeness for a reason no boundary
 * expresses, such as truncated text.
 */
export function updateCoverageWithBoundaries(
  coverage: CoverageInfo,
  boundaries: CanonicalBoundary[],
  frames: FrameReadReport,
  extraIncomplete = false
): CoverageInfo {
  let inaccessible = 0;
  let inaccessibleShadow = 0;
  let inaccessibleCrossOrigin = 0;
  let hasShadow = false;
  let hasCrossOrigin = false;

  for (const b of boundaries) {
    const blocked = b.status !== "complete";
    if (blocked) inaccessible++;
    if (b.kind === "shadow-root" || b.kind === "closed-shadow-root") {
      hasShadow = true;
      if (blocked) inaccessibleShadow++;
    }
    if (b.kind === "cross-origin-frame") {
      hasCrossOrigin = true;
      if (blocked) inaccessibleCrossOrigin++;
    }
  }

  const framesRead = boundaries.filter((b) => b.kind === "iframe" && b.status === "complete").length;
  const framesUnread = frames.present - framesRead;

  return {
    ...coverage,
    shadowDom: !hasShadow ? "complete" : inaccessibleShadow > 0 ? "partial" : "complete",
    // No frames is trivially complete. Frames present but unread are partial.
    sameOriginFrames: framesUnread > 0 ? "partial" : "complete",
    crossOriginFrames: inaccessibleCrossOrigin > 0 ? "inaccessible" : "complete",
    totalBoundaries: boundaries.length,
    inaccessibleBoundaries: inaccessible,
    complete: inaccessible === 0 && framesUnread === 0 && !extraIncomplete,
  };
}

export function setDynamicContentMonitored(coverage: CoverageInfo): CoverageInfo {
  return { ...coverage, dynamicContent: "monitored" };
}

export function setVirtualizedContentStatus(
  coverage: CoverageInfo,
  status: "dom-visible-only" | "unknown"
): CoverageInfo {
  return { ...coverage, virtualizedContent: status };
}

export function formatCoverageSummary(coverage: CoverageInfo): string {
  const parts: string[] = [];
  parts.push(`DOM: ${coverage.dom}`);
  if (coverage.shadowDom !== "complete") parts.push(`Shadow DOM: ${coverage.shadowDom}`);
  if (coverage.sameOriginFrames !== "complete") parts.push(`Frames: ${coverage.sameOriginFrames}`);
  if (coverage.crossOriginFrames !== "complete") parts.push(`Cross-origin: ${coverage.crossOriginFrames}`);
  if (coverage.inaccessibleBoundaries > 0) {
    parts.push(`${coverage.inaccessibleBoundaries} inaccessible boundary(ies)`);
  }
  return parts.join(", ");
}
