// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import type { CanonicalDocument, CanonicalSegment, CanonicalBoundary, CoverageInfo } from "./types.js";
import type { IncompleteWindowInfo } from "../../shared/types.js";
import {
  extractVisibleText,
  extractVisibleTextWindows,
  buildScanText,
  type TextSegment,
} from "../extract.js";
import { getAccessibleShadowRoot } from "./shadow.js";
import { updateCoverageWithBoundaries } from "./coverage.js";

let boundaryCounter = 0;

function generateBoundaryId(): string {
  return `boundary_${++boundaryCounter}`;
}

function toCanonicalSegments(
  rawSegments: TextSegment[],
  segmentStarts: number[],
  nodeIds: Map<string, Node>
): { canonicalSegments: CanonicalSegment[]; textNodeCount: number } {
  let textNodeCount = 0;
  const canonicalSegments: CanonicalSegment[] = rawSegments.map((seg, i) => {
    // eslint-disable-next-line security/detect-object-injection
    const segStart = segmentStarts[i] ?? 0;
    const node = nodeIds.get(seg.nodeId);
    const isInput = node && (node.nodeName === "INPUT" || node.nodeName === "TEXTAREA");
    if (node && node.nodeType === Node.TEXT_NODE) {
      textNodeCount++;
    }

    return {
      nodeId: seg.nodeId,
      startOffset: seg.startOffset,
      endOffset: seg.endOffset,
      text: seg.text,
      sourceNodeId: seg.nodeId,
      sourceType: isInput ? (node.nodeName === "TEXTAREA" ? "textarea" : "input") : "text",
      sourceStartOffset: seg.startOffset,
      sourceEndOffset: seg.endOffset,
      combinedStartOffset: segStart,
      combinedEndOffset: segStart + seg.text.length,
    };
  });
  return { canonicalSegments, textNodeCount };
}

function finalizeCanonicalDocument(
  root: Document | Element | ShadowRoot,
  sourceKind: CanonicalDocument["sourceKind"],
  rawSegments: TextSegment[],
  combined: string,
  segmentStarts: number[],
  truncated: boolean,
  nodeIds: Map<string, Node>,
  startTime: number
): CanonicalDocument {
  const { canonicalSegments, textNodeCount } = toCanonicalSegments(rawSegments, segmentStarts, nodeIds);
  const boundaries: CanonicalBoundary[] = [];

  const shadowRoots = collectShadowRoots(root);
  for (const shadow of shadowRoots) {
    boundaries.push({
      kind: shadow.mode === "closed" ? "closed-shadow-root" : "shadow-root",
      status: "complete",
      nodeId: generateBoundaryId(),
      shadowRootId: shadow.id,
    });
  }

  const iframeCount = countIframes(root);
  const shadowRootCount = shadowRoots.length;
  const tableCount = countTables(root);

  const coverage: CoverageInfo = updateCoverageWithBoundaries(
    {
      dom: "complete",
      shadowDom: "complete",
      sameOriginFrames: "complete",
      crossOriginFrames: "complete",
      dynamicContent: "monitored",
      virtualizedContent: "dom-visible-only",
      totalBoundaries: 0,
      inaccessibleBoundaries: 0,
      complete: true,
    },
    boundaries,
    { present: iframeCount, read: 0 },
    truncated
  );

  const durationMs = performance.now() - startTime;

  return {
    documentId: crypto.randomUUID(),
    sourceKind,
    combined,
    segments: canonicalSegments,
    segmentStarts,
    truncated,
    coverage,
    boundaries,
    metadata: {
      nodeCount: nodeIds.size,
      textNodeCount,
      shadowRootCount,
      iframeCount,
      tableCount,
      durationMs: Math.round(durationMs),
    },
  };
}

export interface CanonicalWindowSlice {
  windowIndex: number;
  combined: string;
  globalStartOffset: number;
  charCount: number;
  nodeTruncated: boolean;
}

export interface WindowedCanonicalDocument extends CanonicalDocument {
  windowSlices: CanonicalWindowSlice[];
  windowsTotal: number;
  incompleteWindows: IncompleteWindowInfo[];
  hardLimitReached: boolean;
}

export function buildCanonicalDocument(options: {
  root: Document | Element | ShadowRoot;
  sourceKind?: CanonicalDocument["sourceKind"];
  maxVisibleChars?: number;
  maxNodeChars?: number;
  nodeIds: Map<string, Node>;
}): CanonicalDocument {
  const startTime = performance.now();
  const maxVisibleChars = options.maxVisibleChars ?? 250_000;
  const maxNodeChars = options.maxNodeChars ?? 10_000;
  const sourceKind = options.sourceKind ?? "web-dom";

  const { segments: rawSegments, truncated } = extractVisibleText(
    options.root,
    maxVisibleChars,
    maxNodeChars,
    options.nodeIds
  );
  const { combined, segmentStarts } = buildScanText(rawSegments);
  return finalizeCanonicalDocument(
    options.root,
    sourceKind,
    rawSegments,
    combined,
    segmentStarts,
    truncated,
    options.nodeIds,
    startTime
  );
}

/**
 * Windowed canonical extraction for whole-page scanning (Decision D4 / Task P6).
 * Keeps `maxVisibleChars` as a per-window memory safeguard rather than a whole-page cut-off.
 */
export function buildCanonicalDocumentWindows(options: {
  root: Document | Element | ShadowRoot;
  sourceKind?: CanonicalDocument["sourceKind"];
  maxVisibleChars?: number;
  maxNodeChars?: number;
  windowChars?: number;
  windowOverlapChars?: number;
  maxTotalWindows?: number;
  nodeIds: Map<string, Node>;
}): WindowedCanonicalDocument {
  const startTime = performance.now();
  const maxVisibleChars = options.windowChars ?? options.maxVisibleChars ?? 250_000;
  const maxNodeChars = options.maxNodeChars ?? 10_000;
  const sourceKind = options.sourceKind ?? "web-dom";

  const extracted = extractVisibleTextWindows(
    options.root,
    maxVisibleChars,
    maxNodeChars,
    options.nodeIds,
    { maxTotalWindows: options.maxTotalWindows }
  );

  const rawSegments: TextSegment[] = [];
  const windowSlices: CanonicalWindowSlice[] = [];
  let globalOffset = 0;

  for (const win of extracted.windows) {
    const winBuilt = buildScanText(win.segments);
    windowSlices.push({
      windowIndex: win.windowIndex,
      combined: winBuilt.combined,
      globalStartOffset: globalOffset,
      charCount: win.charCount,
      nodeTruncated: win.nodeTruncated,
    });
    if (winBuilt.combined.length > 0 || win.segments.length > 0) {
      globalOffset += winBuilt.combined.length + 1;
    }
    for (const seg of win.segments) {
      rawSegments.push(seg);
    }
  }

  const { combined, segmentStarts } = buildScanText(rawSegments);
  const base = finalizeCanonicalDocument(
    options.root,
    sourceKind,
    rawSegments,
    combined,
    segmentStarts,
    extracted.truncated,
    options.nodeIds,
    startTime
  );

  return {
    ...base,
    windowSlices,
    windowsTotal: extracted.windowsTotal,
    incompleteWindows: extracted.incompleteWindows,
    hardLimitReached: extracted.hardLimitReached,
  };
}

function countShadowRoots(root: Document | Element | ShadowRoot): number {
  let count = 0;
  const doc = root instanceof Document ? root : root.ownerDocument ?? root;
  const walk = (node: Node) => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const sr = getAccessibleShadowRoot(node as Element);
      if (sr) {
        count++;
        walk(sr);
      }
    }
    for (let child = node.firstChild; child; child = child.nextSibling) {
      walk(child);
    }
  };
  walk(doc);
  return count;
}

/**
 * Counts frames at every depth, through shadow roots included — the same
 * reach traverseIframes has, so the count and the coverage it produces cannot
 * disagree about whether the page has frames.
 */
function countIframes(root: Document | Element | ShadowRoot): number {
  let count = 0;
  const doc = root instanceof Document ? root : root.ownerDocument ?? root;
  const walk = (node: Node, depth: number) => {
    if (depth > 10) return;
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      if (el.tagName === "IFRAME" || el.tagName === "FRAME") count++;
      const sr = getAccessibleShadowRoot(el);
      if (sr) walk(sr, depth + 1);
    }
    for (let child = node.firstChild; child; child = child.nextSibling) {
      walk(child, depth + 1);
    }
  };
  walk(doc, 0);
  return count;
}

function countTables(root: Document | Element | ShadowRoot): number {
  let count = 0;
  const doc = root instanceof Document ? root : root.ownerDocument ?? root;
  const walk = (node: Node, depth: number) => {
    if (depth > 10) return;
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      if (el.tagName === "TABLE") count++;
      const sr = getAccessibleShadowRoot(el);
      if (sr) walk(sr, depth + 1);
    }
    for (let child = node.firstChild; child; child = child.nextSibling) {
      walk(child, depth + 1);
    }
  };
  walk(doc, 0);
  return count;
}

interface ShadowRootInfo {
  id: string;
  mode: ShadowRootMode;
}

function collectShadowRoots(root: Document | Element | ShadowRoot): ShadowRootInfo[] {
  const roots: ShadowRootInfo[] = [];
  const doc = root instanceof Document ? root : root.ownerDocument ?? root;
  const walk = (node: Node, depth: number) => {
    if (depth > 10) return;
    if (node.nodeType === Node.ELEMENT_NODE) {
      const sr = getAccessibleShadowRoot(node as Element);
      if (sr) {
        // `mode` is the honest label: a root we reached only through
        // chrome.dom.openOrClosedShadowRoot is "closed", and reporting it as
        // open hides the fact that reading it needed an extension privilege.
        roots.push({ id: `shadow_${roots.length}`, mode: sr.mode });
        walk(sr, depth + 1);
      }
    }
    for (let child = node.firstChild; child; child = child.nextSibling) {
      walk(child, depth + 1);
    }
  };
  walk(doc, 0);
  return roots;
}
