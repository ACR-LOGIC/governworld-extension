// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import type { CanonicalDocument, CanonicalSegment, BoundaryInfo } from "./types.js";
import { buildCanonicalDocument } from "./canonical.js";
import { getAccessibleShadowRoot } from "./shadow.js";

export interface IframeTraversalResult {
  frameDocuments: CanonicalDocument[];
  boundaries: BoundaryInfo[];
  /**
   * Every frame element reached, including cross-origin and not-yet-navigated
   * ones. Coverage needs the total to know what went unread; a page whose
   * framesPresent exceeds the readable count must not report complete.
   */
  framesSeen: number;
}

/**
 * Depth cap for frame recursion. Frames nest arbitrarily deep in principle; the
 * cap is what stops a self-referencing or pathological frame tree from
 * hanging the scan.
 */
const MAX_FRAME_DEPTH = 10;

/**
 * Every IFRAME/FRAME in this tree, descending into open *and* closed shadow
 * roots. A frame hosted by a web component is not in `querySelectorAll`, and
 * a frame inside another frame is not in the caller's tree at all — both were
 * invisible to the previous implementation, which read only the top level.
 */
function collectFrames(node: Node, out: HTMLIFrameElement[], depth = 0): void {
  if (depth > MAX_FRAME_DEPTH) return;

  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as Element;
      if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
        out.push(el as HTMLIFrameElement);
      }
      const shadow = getAccessibleShadowRoot(el);
      if (shadow) collectFrames(shadow, out, depth + 1);
    }
    collectFrames(child, out, depth + 1);
  }
}

/**
 * Extract every same-origin frame reachable from `root`, at any nesting depth
 * and through shadow roots, into a flat list.
 *
 * Flat rather than a tree: the caller concatenates each entry's `combined`
 * into one scan string, so a frame inside a frame is just another entry. Each
 * document therefore carries only its own text and its own fully-qualified
 * segment ids, which is what makes the concatenation offsets correct.
 */
export function traverseIframes(
  root: Document | Element | ShadowRoot,
  options: {
    maxVisibleChars?: number;
    maxNodeChars?: number;
    nodeIds: Map<string, Node>;
  }
): IframeTraversalResult {
  const frameDocuments: CanonicalDocument[] = [];
  const boundaries: BoundaryInfo[] = [];

  // A frame can be reachable twice (a SPA reusing a node, or the same document
  // hosted under two elements). Extracting it twice would duplicate its text
  // and double every finding inside it.
  const visited = new Set<Document>();
  let framesSeen = 0;

  const walk = (container: Document | Element | ShadowRoot, depth: number, idPrefix: string): void => {
    if (depth > MAX_FRAME_DEPTH) return;

    const frames: HTMLIFrameElement[] = [];
    collectFrames(container, frames, depth);

    for (const el of frames) {
      framesSeen++;
      let frameDoc: Document | null = null;
      try {
        frameDoc = el.contentDocument;
      } catch {
        frameDoc = null;
      }

      // `contentDocument` is null for a cross-origin frame and for a frame that
      // has not navigated yet. Both are honestly unread from here; the page
      // inventory offers a screen-capture + OCR path for them instead.
      if (!frameDoc) {
        boundaries.push({
          kind: "cross-origin-frame",
          status: "inaccessible",
          nodeId: `iframe_boundary_${boundaries.length}`,
          frameId: `${idPrefix}frame_${frameDocuments.length}`,
        });
        continue;
      }
      if (visited.has(frameDoc)) continue;
      visited.add(frameDoc);

      const frameId = `${idPrefix}frame_${frameDocuments.length}`;
      const segmentPrefix = `${frameId}_`;
      const frameNodeIds = new Map<string, Node>();

      const canonical = buildCanonicalDocument({
        root: frameDoc,
        sourceKind: "web-dom",
        maxVisibleChars: options.maxVisibleChars,
        maxNodeChars: options.maxNodeChars,
        nodeIds: frameNodeIds,
      });

      frameNodeIds.forEach((node, id) => {
        options.nodeIds.set(`${segmentPrefix}${id}`, node);
      });

      const segments: CanonicalSegment[] = canonical.segments.map((seg) => ({
        ...seg,
        frameId,
        nodeId: `${segmentPrefix}${seg.nodeId}`,
      }));

      boundaries.push({
        kind: "iframe",
        status: "complete",
        nodeId: `iframe_boundary_${boundaries.length}`,
        frameId,
      });

      frameDocuments.push({
        ...canonical,
        segments,
        boundaries: [],
      });

      // Nested frames follow this one in the flat list, so the caller sees a
      // consistent depth-first order and each entry stays independently
      // extractable.
      walk(frameDoc, depth + 1, segmentPrefix);
    }
  };

  walk(root instanceof Document ? root : root.ownerDocument ?? root, 0, "");

  return { frameDocuments, boundaries, framesSeen };
}

export function isFrameAccessible(iframe: HTMLIFrameElement): boolean {
  try {
    return iframe.contentDocument !== null;
  } catch {
    return false;
  }
}