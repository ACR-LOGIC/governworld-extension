// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { extractVisibleText, buildScanText, mapRange, segmentIndexAt } from "../src/content/extract.js";
import { createOverlay } from "../src/content/overlay.js";
import { collectAttrRecords } from "../src/content/attrs.js";
import { extractSvgText } from "../src/content/svgExtract.js";
import { buildMediaQueue, extractVideoCaptions } from "../src/content/mediaQueue.js";
import { detect } from "../src/content/detect.js";
import type { Finding } from "../src/shared/types.js";
import type { PageInventory } from "../src/content/normalization/pageInventory.js";

function makeInventory(): PageInventory {
  return {
    domTextRegions: 0,
    formControls: 0,
    openShadowRoots: 0,
    closedShadowRootsAccessed: 0,
    sameOriginIframes: 0,
    crossOriginIframes: 0,
    images: { total: 0, visible: 0, dataOrBlob: 0, cssBackgrounds: 0, inlineSvgs: 0 },
    canvases: 0,
    videos: { total: 0, withTracks: 0, visible: 0 },
    audios: 0,
    pdfs: { embedded: 0, isTopLevelPdfViewer: false },
    unscannableRegions: [],
  };
}

describe("Adversarial Stress Suite: Milestone M2 Runtime & Rendering", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  describe("Dimension 1: Deep Nested Leaf Text Node Mapping (Feature 1)", () => {
    it("maps deeply nested leaf text nodes through 10-level hierarchy to exact Text node", () => {
      let current: HTMLElement = document.createElement("div");
      current.id = "root-container";
      document.body.appendChild(current);

      for (let i = 0; i < 10; i++) {
        const next = document.createElement("div");
        next.className = `level-${i}`;
        current.appendChild(next);
        current = next;
      }

      const textNode = document.createTextNode("Patient SSN 123-45-6789 confidential");
      current.appendChild(textNode);

      const nodeMap = new Map<string, Node>();
      const { segments } = extractVisibleText(document.body, 10000, 500, nodeMap);

      expect(segments.length).toBe(1);
      const mappedNode = nodeMap.get(segments[0].nodeId);
      expect(mappedNode).toBe(textNode);
      expect(mappedNode?.nodeType).toBe(Node.TEXT_NODE);
      expect(mappedNode).not.toBe(document.getElementById("root-container"));
    });

    it("correctly distinguishes multiple sibling leaf text nodes within the same container", () => {
      const container = document.createElement("p");
      const text1 = document.createTextNode("Call 555-0100");
      const span = document.createElement("span");
      const text2 = document.createTextNode(" or email user@test.com");
      span.appendChild(text2);
      const text3 = document.createTextNode(" for help.");
      container.appendChild(text1);
      container.appendChild(span);
      container.appendChild(text3);
      document.body.appendChild(container);

      const nodeMap = new Map<string, Node>();
      const { segments } = extractVisibleText(container, 10000, 500, nodeMap);

      expect(segments.length).toBe(3);
      expect(nodeMap.get(segments[0].nodeId)).toBe(text1);
      expect(nodeMap.get(segments[1].nodeId)).toBe(text2);
      expect(nodeMap.get(segments[2].nodeId)).toBe(text3);
    });
  });

  describe("Dimension 2: Splice Synchronization & Offset Integrity (Feature 2)", () => {
    it("maintains strict segmentIndexById and segmentStarts alignment across multi-node removals", () => {
      const segments = [
        { nodeId: "s0", startOffset: 0, endOffset: 5, text: "first" },
        { nodeId: "s1", startOffset: 0, endOffset: 6, text: "second" },
        { nodeId: "s2", startOffset: 0, endOffset: 5, text: "third" },
        { nodeId: "s3", startOffset: 0, endOffset: 6, text: "fourth" },
        { nodeId: "s4", startOffset: 0, endOffset: 5, text: "fifth" },
      ];

      const segmentIndexById = new Map<string, number>();
      segments.forEach((s, i) => segmentIndexById.set(s.nodeId, i));

      // Remove indices 0, 2, and 4
      const removedIndices = [0, 2, 4];
      removedIndices.sort((a, b) => b - a);
      for (const idx of removedIndices) {
        segments.splice(idx, 1);
      }
      segmentIndexById.clear();
      for (let i = 0; i < segments.length; i++) {
        segmentIndexById.set(segments[i].nodeId, i);
      }
      const rebuilt = buildScanText(segments);

      expect(segments.length).toBe(2);
      expect(segments[0].nodeId).toBe("s1");
      expect(segments[1].nodeId).toBe("s3");
      expect(segmentIndexById.get("s1")).toBe(0);
      expect(segmentIndexById.get("s3")).toBe(1);
      expect(rebuilt.combined).toBe("second\nfourth");
      expect(rebuilt.segmentStarts).toEqual([0, 7]);

      // Check binary search mapping on remaining segments
      expect(segmentIndexAt(rebuilt.segmentStarts, rebuilt.combined.length, 3)).toBe(0);
      expect(segmentIndexAt(rebuilt.segmentStarts, rebuilt.combined.length, 7)).toBe(1);
      expect(segmentIndexAt(rebuilt.segmentStarts, rebuilt.combined.length, 10)).toBe(1);
    });
  });

  describe("Dimension 3: Delta Scan Offset Math & Finding Isolation (Feature 3)", () => {
    it("accurately shifts delta matches when prior combined text is non-empty", () => {
      const priorCombined = "Prior document header\nSecond line of document";
      const newSegments = [
        { nodeId: "new_1", startOffset: 0, endOffset: 24, text: "Secret token: 123-45-6789" },
      ];
      const newBuilt = buildScanText(newSegments);
      const offset = priorCombined.length + 1;

      const deltaMatches = detect(newBuilt.combined, ["ssn"]);
      expect(deltaMatches.length).toBe(1);
      expect(deltaMatches[0].value).toBe("123-45-6789");

      const adjustedStart = deltaMatches[0].start + offset;
      const adjustedEnd = deltaMatches[0].end + offset;

      const updatedCombined = priorCombined + "\n" + newBuilt.combined;
      expect(updatedCombined.slice(adjustedStart, adjustedEnd)).toBe("123-45-6789");
    });
  });

  describe("Dimension 4: Floating Mask Tracking Stress & Resiliency (Feature 4)", () => {
    it("handles detached elements and throwing recalculator gracefully without crashing", () => {
      let callCount = 0;
      const recalculate = vi.fn(() => {
        callCount++;
        if (callCount === 2) {
          throw new Error("Detached node access failure");
        }
        return [{ kind: "mask" as const, label: "ssn", x: 10, y: 10, width: 80, height: 20 }];
      });

      const overlay = createOverlay(document, recalculate);
      overlay.render([{ kind: "mask", label: "ssn", x: 10, y: 10, width: 80, height: 20 }]);

      // First scroll succeeds
      window.dispatchEvent(new Event("scroll"));
      expect(recalculate).toHaveBeenCalledTimes(1);

      // Second scroll throws internally inside recalculator, should not reject or crash
      expect(() => {
        window.dispatchEvent(new Event("scroll"));
      }).not.toThrow();

      overlay.destroy();
    });
  });

  describe("Dimension 5: Form Input Leading Whitespace & Canvas Metrics (Feature 15)", () => {
    it("preserves exact character offsets across multiple leading whitespace characters (tabs, spaces, non-breaking spaces)", () => {
      const input = document.createElement("input");
      // \u00a0 is non-breaking space, \t is tab, standard spaces
      input.value = "  \t\u00a0user@domain.com   ";
      document.body.appendChild(input);

      const nodeMap = new Map<string, Node>();
      const { segments } = extractVisibleText(input, 1000, 200, nodeMap);

      expect(segments).toHaveLength(1);
      expect(segments[0].startOffset).toBe(4);
      expect(segments[0].text).toBe("user@domain.com");
      expect(input.value.slice(segments[0].startOffset, segments[0].endOffset)).toBe("user@domain.com");
    });

    it("handles textarea with multi-line content correctly", () => {
      const textarea = document.createElement("textarea");
      textarea.value = "Line 1: Hello\nLine 2: 123-45-6789\nLine 3: End";
      document.body.appendChild(textarea);

      const nodeMap = new Map<string, Node>();
      const { segments } = extractVisibleText(textarea, 1000, 200, nodeMap);

      expect(segments).toHaveLength(1);
      expect(segments[0].startOffset).toBe(0);
      expect(segments[0].text).toBe("Line 1: Hello\nLine 2: 123-45-6789\nLine 3: End");
    });
  });

  describe("Dimension 6: Visual OCR Queue Area Prioritization (Feature 26)", () => {
    it("sorts visual candidates with identical visibility strictly by descending surface area", () => {
      const img1 = document.createElement("img");
      img1.src = "https://example.com/tiny.png";
      img1.getBoundingClientRect = () => ({ x: 0, y: 0, width: 40, height: 40, top: 0, left: 0, right: 40, bottom: 40, toJSON: () => {} }) as any;
      document.body.appendChild(img1);

      const img2 = document.createElement("img");
      img2.src = "https://example.com/medium.png";
      img2.getBoundingClientRect = () => ({ x: 0, y: 0, width: 300, height: 200, top: 0, left: 0, right: 300, bottom: 200, toJSON: () => {} }) as any;
      document.body.appendChild(img2);

      const img3 = document.createElement("img");
      img3.src = "https://example.com/huge.png";
      img3.getBoundingClientRect = () => ({ x: 0, y: 0, width: 1200, height: 800, top: 0, left: 0, right: 1200, bottom: 800, toJSON: () => {} }) as any;
      document.body.appendChild(img3);

      const inv = makeInventory();
      const result = buildMediaQueue(document, inv, 10, "https://example.com");

      expect(result.visualQueue).toHaveLength(3);
      expect(result.visualQueue[0].resourceUrl).toBe("https://example.com/huge.png");
      expect(result.visualQueue[1].resourceUrl).toBe("https://example.com/medium.png");
      expect(result.visualQueue[2].resourceUrl).toBe("https://example.com/tiny.png");
    });
  });

  describe("Dimension 7: Cross-Origin Video SecurityError Isolation (Feature 27)", () => {
    it("creates an explicit UnscannableRegion with reason cross-origin-isolation on canvas SecurityError", () => {
      const video = document.createElement("video");
      video.src = "https://cdn.external.com/stream.mp4";
      video.getBoundingClientRect = () => ({ x: 0, y: 0, width: 640, height: 360, top: 0, left: 0, right: 640, bottom: 360, toJSON: () => {} }) as any;
      Object.defineProperty(video, "readyState", { value: 4, configurable: true });
      document.body.appendChild(video);

      const origCreateElement = document.createElement.bind(document);
      vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
        const el = origCreateElement(tagName);
        if (tagName.toLowerCase() === "canvas") {
          (el as any).getContext = () => ({
            drawImage: () => {
              throw new DOMException("Failed to execute 'drawImage' on 'CanvasRenderingContext2D': The HTMLVideoElement provided is tainted by cross-origin data.", "SecurityError");
            },
            toDataURL: () => "data:,",
          });
        }
        return el;
      });

      const inv = makeInventory();
      const result = buildMediaQueue(document, inv, 5, "https://example.com");

      expect(result.visualQueue).toHaveLength(0);
      expect(result.newUnscannableRegions).toHaveLength(1);
      expect(result.newUnscannableRegions[0].reason).toBe("cross-origin-isolation");
      expect(result.newUnscannableRegions[0].sourceType).toBe("video");
      expect(result.newUnscannableRegions[0].resourceUrl).toBe("https://cdn.external.com/stream.mp4");
    });
  });
});
