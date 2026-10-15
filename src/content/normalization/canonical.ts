// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import type { CanonicalDocument, CanonicalSegment, CanonicalBoundary, CoverageInfo, BoundaryInfo } from "./types.js";
import { extractVisibleText, buildScanText, type TextSegment } from "../extract.js";
import { getAccessibleShadowRoot } from "./shadow.js";
import { updateCoverageWithBoundaries } from "./coverage.js";

let boundaryCounter = 0;

function generateBoundaryId(): string {
  return `boundary_${++boundaryCounter}`;
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

  const boundaries: CanonicalBoundary[] = [];

  const { segments: rawSegments, truncated } = extractVisibleText(
    options.root,
    maxVisibleChars,
    maxNodeChars,
    options.nodeIds
  );

  const { combined, segmentStarts } = buildScanText(rawSegments);

  let textNodeCount = 0;
  for (const seg of rawSegments) {
    const node = options.nodeIds.get(seg.nodeId);
    if (node && node.nodeType === Node.TEXT_NODE) {
      textNodeCount++;
    }
  }

  // Boundary inventory only. This function extracts ONE document; it does not
  // descend into frames. traverseIframes owns frame extraction and reports its
  // own boundaries, so recording an "iframe/complete" boundary here would claim
  // coverage no code path in this function delivered.
  const shadowRoots = collectShadowRoots(options.root);
  for (const shadow of shadowRoots) {
    boundaries.push({
      // A root reached through chrome.dom.openOrClosedShadowRoot is closed, and
      // saying otherwise hides the fact that reading it needed a privilege.
      kind: shadow.mode === "closed" ? "closed-shadow-root" : "shadow-root",
      status: "complete",
      nodeId: generateBoundaryId(),
      shadowRootId: shadow.id,
    });
  }

  const iframeCount = countIframes(options.root);
  const shadowRootCount = shadowRoots.length;
  const tableCount = countTables(options.root);

  // Frames present, zero read: this function reads one document, so every
  // frame it found is still unread. The caller upgrades this once
  // traverseIframes has reported what it actually extracted.
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

  const canonicalSegments: CanonicalSegment[] = rawSegments.map((seg, i) => {
    const segStart = segmentStarts[i] ?? 0;
    const node = options.nodeIds.get(seg.nodeId);
    const isInput = node && (node.nodeName === "INPUT" || node.nodeName === "TEXTAREA");

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
      nodeCount: options.nodeIds.size,
      textNodeCount,
      shadowRootCount,
      iframeCount,
      tableCount,
      durationMs: Math.round(durationMs),
    },
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
