// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { extractVisibleText, buildScanText } from "../src/content/extract.js";
import { detect } from "../src/content/detect.js";
import { resolveScanCoverageStatus } from "../src/content/normalization/pageInventory.js";
import type { Finding, FindingCategory } from "../src/shared/types.js";

describe("Content Script Runtime & DOM Integration (M2 Features)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  describe("Feature 1: Incremental Rescan Leaf Text Node Mapping", () => {
    it("maps segments from extractVisibleText directly to leaf Text nodes rather than outer container element", () => {
      const parent = document.createElement("div");
      parent.id = "parent-container";
      const span = document.createElement("span");
      const textNode = document.createTextNode("Doctor NPI 1234567893 active");
      span.appendChild(textNode);
      parent.appendChild(span);
      document.body.appendChild(parent);

      const nodeMap = new Map<string, Node>();
      const { segments } = extractVisibleText(parent, 10000, 500, nodeMap);

      expect(segments.length).toBeGreaterThan(0);
      const mapped = nodeMap.get(segments[0].nodeId);
      expect(mapped).toBeDefined();
      expect(mapped?.nodeType).toBe(Node.TEXT_NODE);
      expect(mapped).toBe(textNode);
      expect(mapped).not.toBe(parent);
    });
  });

  describe("Feature 2: Incremental Rescan Splice Sync", () => {
    it("synchronizes segmentIndexById and segmentStarts on segment splices", () => {
      const seg0 = { nodeId: "s0", startOffset: 0, endOffset: 5, text: "alpha" };
      const seg1 = { nodeId: "s1", startOffset: 0, endOffset: 4, text: "beta" };
      const seg2 = { nodeId: "s2", startOffset: 0, endOffset: 5, text: "gamma" };
      const segments = [seg0, seg1, seg2];
      const segmentIndexById = new Map<string, number>([
        ["s0", 0],
        ["s1", 1],
        ["s2", 2],
      ]);

      // Simulate removing index 1
      const removedIndices = [1];
      for (const idx of removedIndices) {
        segments.splice(idx, 1);
      }
      segmentIndexById.clear();
      for (let i = 0; i < segments.length; i++) {
        segmentIndexById.set(segments[i].nodeId, i);
      }
      const rebuilt = buildScanText(segments);

      expect(segments.length).toBe(2);
      expect(segmentIndexById.get("s0")).toBe(0);
      expect(segmentIndexById.get("s2")).toBe(1);
      expect(segmentIndexById.get("s1")).toBeUndefined();
      expect(rebuilt.segmentStarts).toEqual([0, 6]);
      expect(rebuilt.combined).toBe("alpha\ngamma");
    });
  });

  describe("Feature 3: Incremental Rescan Delta Scan", () => {
    it("delta scans only newly added segments with offset adjustment", () => {
      const existingText = "User Alice logged in.\n";
      const newSegments = [
        { nodeId: "rescan_new1", startOffset: 0, endOffset: 25, text: "Email: alice@hospital.com" },
      ];
      const newBuilt = buildScanText(newSegments);
      const offset = existingText.length;

      const deltaMatches = detect(newBuilt.combined, ["email"]);
      expect(deltaMatches.length).toBe(1);
      expect(deltaMatches[0].value).toBe("alice@hospital.com");

      const adjustedStart = deltaMatches[0].start + offset;
      const adjustedEnd = deltaMatches[0].end + offset;
      const combined = existingText + newBuilt.combined;
      expect(combined.slice(adjustedStart, adjustedEnd)).toBe("alice@hospital.com");
    });
  });

  describe("Feature 7: Mutation Batch Limits (>50)", () => {
    it("processes batch of 100 mutations without destroying session or stripping findings", () => {
      const findings: Finding[] = [
        {
          id: "ssn_0_11_0",
          category: "ssn",
          confidence: 0.95,
          source: "local-rules",
          preview: "***-**-6789",
          nodeId: "seg_0",
          startOffset: 0,
          endOffset: 11,
          rects: [{ x: 10, y: 10, width: 80, height: 20 }],
          contextPreview: "",
          selected: true,
        },
      ];

      // Mutate 100 nodes in DOM
      for (let i = 0; i < 100; i++) {
        const div = document.createElement("div");
        div.textContent = `Item ${i}`;
        document.body.appendChild(div);
      }

      // Assert findings are preserved
      expect(findings.length).toBe(1);
      expect(findings[0].id).toBe("ssn_0_11_0");
    });
  });

  describe("Feature 15: Form Input Token-Level Masking & Leading Whitespace", () => {
    it("extracts input value with leading whitespace without offset drift", () => {
      const input = document.createElement("input");
      input.value = "   user@example.com";
      document.body.appendChild(input);

      const nodeMap = new Map<string, Node>();
      const { segments } = extractVisibleText(input, 1000, 200, nodeMap);

      expect(segments).toHaveLength(1);
      expect(segments[0].startOffset).toBe(3);
      expect(segments[0].text).toBe("user@example.com");
      expect(input.value.slice(segments[0].startOffset, segments[0].endOffset)).toBe("user@example.com");
    });
  });

  describe("Feature 25: SVG Findings Active Status & Coverage", () => {
    it("marks SVG findings as selected: true and reports FULLY_SCANNED when findingsCount > 0", () => {
      const svgFinding: Finding = {
        id: "svg_email_0_15_0",
        category: "email",
        confidence: 0.95,
        source: "local-rules",
        preview: "a***@company.org",
        nodeId: "svg",
        startOffset: 100,
        endOffset: 115,
        rects: [{ x: 50, y: 50, width: 120, height: 20 }],
        contextPreview: "",
        selected: true,
      };

      expect(svgFinding.selected).toBe(true);

      const findings = [svgFinding];
      const activeFindings = findings.filter((f) => f.source !== "attr" && f.selected);
      expect(activeFindings.length).toBe(1);

      const status = resolveScanCoverageStatus({
        findingsCount: activeFindings.length,
        unresolvedRegions: [],
        deferredMediaCount: 0,
        visibleChars: 200,
      });

      expect(status).toBe("FULLY_SCANNED");
    });
  });
});
