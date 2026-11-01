// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  extractVisibleText,
  buildScanText,
  segmentIndexAt,
  mapRange,
  type TextSegment,
} from "../src/content/extract.js";
import { detect } from "../src/content/detect.js";
import { createOverlay, type OverlayRect } from "../src/content/overlay.js";
import {
  observeMutations,
  getAffectedNodeIds,
  type MutationBatch,
} from "../src/content/normalization/mutation.js";
import type { Finding, FindingCategory, Rect } from "../src/shared/types.js";

describe("Adversarial M2 Rescan & DOM Traversal Stress Suite", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  // =========================================================================
  // Challenge 1: Multi-Node Rescan Node ID Collision (Features 1 & 2)
  // Stress-test: When multiple nodes are added in a single batch or across rapid batches,
  // do their segment IDs collide, overwriting nodeIds and segmentIndexById?
  // =========================================================================
  describe("Challenge 1: Multi-Node Rescan Node ID Collision & Node Mapping", () => {
    it("empirically reproduces node ID collision when multiple nodes are processed in rescan", () => {
      // Simulate the exact logic in content.ts lines 872-898
      const nodeIds = new Map<string, Node>();
      const segments: any[] = [];
      const segmentIndexById = new Map<string, number>();
      let combined = "";
      const segmentStarts: number[] = [];

      // Create 3 separate container nodes added in a batch
      const div1 = document.createElement("div");
      const text1 = document.createTextNode("Provider NPI 1234567893 active");
      div1.appendChild(text1);

      const div2 = document.createElement("div");
      const text2 = document.createTextNode("Emergency contact: alice@hospital.com");
      div2.appendChild(text2);

      const div3 = document.createElement("div");
      const text3 = document.createTextNode("Billing SSN: 123-45-6789 verified");
      div3.appendChild(text3);

      document.body.appendChild(div1);
      document.body.appendChild(div2);
      document.body.appendChild(div3);

      const addedNodes = [div1, div2, div3];

      // Execute rescan logic as implemented in content.ts
      for (const node of addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) {
          const newNodeIds = new Map<string, Node>();
          const extracted = extractVisibleText(node as Element, 10000, 500, newNodeIds);
          if (extracted.segments.length > 0) {
            const newBuilt = buildScanText(extracted.segments);
            const offset = combined.length > 0 ? combined.length + 1 : 0;
            for (let i = 0; i < extracted.segments.length; i++) {
              const seg = extracted.segments[i];
              // This is the verbatim line from content.ts line 887:
              const newSeg = {
                nodeId: `rescan_${seg.nodeId}`,
                startOffset: seg.startOffset,
                endOffset: seg.endOffset,
                text: seg.text,
                combinedStartOffset: offset + newBuilt.segmentStarts[i],
                combinedEndOffset: offset + newBuilt.segmentStarts[i] + seg.text.length,
              };
              segments.push(newSeg);
              const targetNode = newNodeIds.get(seg.nodeId) ?? (node as Node);
              nodeIds.set(newSeg.nodeId, targetNode);
              segmentIndexById.set(newSeg.nodeId, segments.length - 1);
            }
            combined += (combined.length > 0 ? "\n" : "") + newBuilt.combined;
            segmentStarts.push(...newBuilt.segmentStarts.map((s) => s + offset));
          }
        }
      }

      // Check for node ID collision
      const uniqueSegmentIds = new Set(segments.map((s) => s.nodeId));

      // CRITICAL ASSERTION:
      // Each segment MUST have a globally unique nodeId.
      // If uniqueSegmentIds.size < segments.length, there is an ID collision bug.
      const hasCollision = uniqueSegmentIds.size < segments.length;
      expect(hasCollision, "VULNERABILITY CONFIRMED: Multiple added nodes all received identical nodeId 'rescan_seg_0'").toBe(true);

      // Verify that nodeIds was corrupted by the collision:
      // nodeIds should hold 3 mappings, but because of collision, earlier nodes were overwritten:
      expect(nodeIds.size).toBe(1);
      expect(nodeIds.get("rescan_seg_0")).toBe(text3); // text1 and text2 are lost!

      // Verify that segmentIndexById was corrupted:
      // segmentIndexById should map 3 segments, but only index 2 survives:
      expect(segmentIndexById.size).toBe(1);
      expect(segmentIndexById.get("rescan_seg_0")).toBe(2); // indices 0 and 1 are lost!
    });
  });

  // =========================================================================
  // Challenge 2: Earlier Segment Removal & Offset Desynchronization (Features 2 & 3)
  // Stress-test: When an earlier node is removed, does rebuilding combined and
  // segmentStarts cause surviving findings to desynchronize or black out wrong text?
  // =========================================================================
  describe("Challenge 2: Splicing Earlier Segments & Surviving Findings Desynchronization", () => {
    it("empirically demonstrates finding offset desynchronization when an earlier segment is removed", () => {
      // Setup initial scan with 3 nodes
      const seg0: TextSegment = { nodeId: "seg_0", startOffset: 0, endOffset: 15, text: "Header banner 1" };
      const seg1: TextSegment = { nodeId: "seg_1", startOffset: 0, endOffset: 16, text: "SSN: 999-99-9999" };
      const seg2: TextSegment = { nodeId: "seg_2", startOffset: 0, endOffset: 25, text: "Email: doctor@clinic.org" };
      const segments = [seg0, seg1, seg2];
      const segmentIndexById = new Map<string, number>([
        ["seg_0", 0],
        ["seg_1", 1],
        ["seg_2", 2],
      ]);

      const initialBuilt = buildScanText(segments);
      let combined = initialBuilt.combined;
      let segmentStarts = initialBuilt.segmentStarts;

      expect(combined).toBe("Header banner 1\nSSN: 999-99-9999\nEmail: doctor@clinic.org");
      expect(segmentStarts).toEqual([0, 16, 33]);

      // Detect findings on initial combined text
      const matches = detect(combined, ["ssn", "email"]);
      expect(matches).toHaveLength(2);

      const ssnMatch = matches.find((m) => m.category === "ssn")!;
      const emailMatch = matches.find((m) => m.category === "email")!;

      expect(ssnMatch.value).toBe("999-99-9999");
      expect(ssnMatch.start).toBe(21);
      expect(ssnMatch.end).toBe(32);

      expect(emailMatch.value).toBe("doctor@clinic.org");
      expect(emailMatch.start).toBe(40);
      expect(emailMatch.end).toBe(57);

      // Verify initial mapRange maps SSN correctly to seg_1
      const initialSsnRange = mapRange(segments, segmentStarts, combined.length, ssnMatch.start, ssnMatch.end);
      expect(initialSsnRange).toHaveLength(1);
      expect(initialSsnRange[0].nodeId).toBe("seg_1");
      expect(initialSsnRange[0].startOffset).toBe(5);
      expect(initialSsnRange[0].endOffset).toBe(16);
      expect(seg1.text.slice(initialSsnRange[0].startOffset, initialSsnRange[0].endOffset)).toBe("999-99-9999");

      // NOW: Simulate removing seg_0 (the header banner)
      // Execute the splice logic from content.ts lines 849-870:
      const removedIndices = [0];
      for (const idx of removedIndices) {
        segments.splice(idx, 1);
      }
      segmentIndexById.clear();
      for (let i = 0; i < segments.length; i++) {
        segmentIndexById.set(segments[i].nodeId, i);
      }
      const rebuilt = buildScanText(segments);
      segmentStarts = rebuilt.segmentStarts;
      combined = rebuilt.combined;

      expect(combined).toBe("SSN: 999-99-9999\nEmail: doctor@clinic.org");
      expect(segmentStarts).toEqual([0, 17]);
      expect(combined.length).toBe(41);

      // Now, test what mapRange produces for the SURVIVING findings whose offsets were NOT shifted:
      // In content.ts, ssnMatch.start is STILL 21, and emailMatch.start is STILL 40!
      const postSsnRange = mapRange(segments, segmentStarts, combined.length, ssnMatch.start, ssnMatch.end);
      
      // CRITICAL OBSERVATION:
      // In new combined, offset 21 is inside Seg 2 ("Email: doctor@clinic.org"), NOT Seg 1!
      expect(postSsnRange).toHaveLength(1);
      expect(postSsnRange[0].nodeId).toBe("seg_2"); // WRONG NODE! Mapped to email node!
      expect(postSsnRange[0].startOffset).toBe(4);
      expect(postSsnRange[0].endOffset).toBe(15);
      // It now masks characters inside the EMAIL text!
      expect(seg2.text.slice(postSsnRange[0].startOffset, postSsnRange[0].endOffset)).toBe("l: doctor@c");

      // And for emailMatch (start: 40, end: 57):
      // In new combined, length is 41! end (57) exceeds combined length!
      // mapRange clamps or fails:
      const postEmailRange = mapRange(segments, segmentStarts, combined.length, emailMatch.start, emailMatch.end);
      expect(postEmailRange[0]?.endOffset).toBe(seg2.text.length); // Clamped, partial coverage
    });
  });

  // =========================================================================
  // Challenge 3: Delta Scan Finding Offset and Deduplication Accuracy (Feature 3)
  // Stress-test: Verify that delta findings have exact global offsets and
  // deduplicate against existing IDs.
  // =========================================================================
  describe("Challenge 3: Delta Scan Finding Offset and Deduplication", () => {
    it("accurately computes global offsets for delta scan matches and prevents duplicates", () => {
      const existingText = "Medical Records System v2\nAuthorized Personnel Only\n";
      const baseOffset = existingText.length;

      const newSegmentText = "Patient John Doe, NPI: 1234567893, email: jdoe@health.org";
      const newSegments: TextSegment[] = [
        { nodeId: "rescan_new_seg_0", startOffset: 0, endOffset: newSegmentText.length, text: newSegmentText },
      ];
      const newBuilt = buildScanText(newSegments);

      const deltaMatches = detect(newBuilt.combined, ["npi", "email"]);
      expect(deltaMatches.length).toBe(2);

      const adjustedMatches = deltaMatches.map((m) => ({
        ...m,
        start: m.start + baseOffset,
        end: m.end + baseOffset,
      }));

      const fullCombined = existingText + newBuilt.combined;

      for (const m of adjustedMatches) {
        const extracted = fullCombined.slice(m.start, m.end);
        expect(extracted).toBe(m.value);
      }

      // Test deduplication logic
      const existingFindings: Finding[] = [
        {
          id: `npi_${adjustedMatches[0].start}_${adjustedMatches[0].end}_0`,
          category: "npi",
          confidence: 0.95,
          source: "local-rules",
          preview: "1234567893",
          nodeId: "rescan_new_seg_0",
          startOffset: adjustedMatches[0].start,
          endOffset: adjustedMatches[0].end,
          rects: [],
          selected: true,
        },
      ];

      const existingIds = new Set(existingFindings.map((f) => f.id));
      const filtered = adjustedMatches.filter(
        (m, i) => !existingIds.has(`${m.category}_${m.start}_${m.end}_${i}`)
      );

      // Only the email match should be accepted; NPI is deduplicated
      expect(filtered).toHaveLength(1);
      expect(filtered[0].category).toBe("email");
    });
  });

  // =========================================================================
  // Challenge 4: Floating Redaction Masks Dynamic Tracking (Feature 4)
  // Stress-test: Verify scroll and resize handlers recalculate client rects
  // and handle detached nodes safely.
  // =========================================================================
  describe("Challenge 4: Floating Redaction Masks Live Dynamic Tracking", () => {
    it("dynamically updates mask rect coordinates on scroll and resize", async () => {
      let scrollY = 0;
      const targetElement = document.createElement("div");
      targetElement.textContent = "Sensitive Token";
      document.body.appendChild(targetElement);

      const recalculate = vi.fn((): OverlayRect[] => {
        // Simulate dynamic DOMRect changing with scrollY
        return [
          {
            kind: "mask",
            label: "ssn: ***",
            x: 50,
            y: 100 - scrollY,
            width: 120,
            height: 25,
            placeholder: "[SSN]",
          },
        ];
      });

      const overlay = createOverlay(document, recalculate);
      overlay.render(recalculate());

      // Initial position
      expect(recalculate).toHaveBeenCalledTimes(1);

      // Simulate scroll event
      scrollY = 40;
      window.dispatchEvent(new Event("scroll"));
      expect(recalculate).toHaveBeenCalledTimes(2);

      // Simulate resize event
      window.dispatchEvent(new Event("resize"));
      expect(recalculate).toHaveBeenCalledTimes(3);

      // Detach element and verify graceful handling
      targetElement.remove();
      window.dispatchEvent(new Event("scroll"));
      expect(recalculate).toHaveBeenCalledTimes(4);

      overlay.destroy();
    });
  });

  // =========================================================================
  // Challenge 5: Mutation Batch Limit > 100 Nodes (Feature 7)
  // Stress-test: Batch of 150 added nodes, 20 removed nodes, and 10 mutated text nodes
  // does not throw, does not clear session, and is processed by observeMutations.
  // =========================================================================
  describe("Challenge 5: Mutation Batch Limit > 100 Nodes", () => {
    it("successfully collects and flushes batches exceeding 100 mutations without throwing", async () => {
      vi.useFakeTimers();

      let receivedBatch: MutationBatch | null = null;
      const handle = observeMutations(document.body, (batch) => {
        receivedBatch = batch;
      });

      // Inject 120 nodes into document.body
      const added: Node[] = [];
      for (let i = 0; i < 120; i++) {
        const p = document.createElement("p");
        p.textContent = `Paragraph ${i}`;
        document.body.appendChild(p);
        added.push(p);
      }

      // Remove 20 nodes
      for (let i = 0; i < 20; i++) {
        const toRemove = added[i];
        toRemove.parentNode?.removeChild(toRemove);
      }

      // Allow happy-dom MutationObserver microtask to fire
      await vi.runAllTimersAsync();

      expect(receivedBatch).not.toBeNull();
      expect(receivedBatch!.addedNodes.length).toBe(120);
      expect(receivedBatch!.removedNodes.length).toBe(20);

      handle.disconnect();
      vi.useRealTimers();
    });

    it("empirically demonstrates mutation batch overwrite risk when mutations arrive in rapid succession", () => {
      // Trace content.ts lines 941-949:
      // pendingMutationBatch = batch;
      // if (mutationDebounceTimer !== null) clearTimeout(mutationDebounceTimer);
      // mutationDebounceTimer = setTimeout(..., 500);

      let pendingMutationBatch: MutationBatch | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const processedBatches: MutationBatch[] = [];

      function onMutationBatch(batch: MutationBatch) {
        pendingMutationBatch = batch; // Non-merging overwrite
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => {
          if (pendingMutationBatch) {
            processedBatches.push(pendingMutationBatch);
            pendingMutationBatch = null;
          }
        }, 500);
      }

      const batch1: MutationBatch = {
        addedNodes: [document.createElement("div")],
        removedNodes: [],
        mutatedTextNodes: [],
        timestamp: 1000,
      };

      const batch2: MutationBatch = {
        addedNodes: [document.createElement("span")],
        removedNodes: [],
        mutatedTextNodes: [],
        timestamp: 1200,
      };

      onMutationBatch(batch1);
      // 200ms later, before 500ms debounce fires, batch2 arrives:
      onMutationBatch(batch2);

      // Trigger timer:
      if (timer) {
        // Fast forward
        processedBatches.push(pendingMutationBatch!);
      }

      // Batch 1 was completely dropped and never processed
      expect(processedBatches).toHaveLength(1);
      expect(processedBatches[0]).toBe(batch2);
      expect(processedBatches[0].addedNodes[0]).toBe(batch2.addedNodes[0]);
    });
  });

  // =========================================================================
  // Challenge 6: Form Input Token Masking with Tabs, Whitespace & Multi-Word (Feature 15)
  // Stress-test: Verify startOffset accuracy, leading whitespace isolation,
  // and token bounding box calculation.
  // =========================================================================
  describe("Challenge 6: Form Input Token Masking Precision", () => {
    it("handles leading tabs and mixed whitespace without offset drift", () => {
      const input = document.createElement("input");
      input.value = "\t\t   user.name@sub.domain.org   ";
      document.body.appendChild(input);

      const nodeMap = new Map<string, Node>();
      const { segments } = extractVisibleText(input, 5000, 500, nodeMap);

      expect(segments).toHaveLength(1);
      const seg = segments[0];

      // Leading: 2 tabs + 3 spaces = 5 characters
      expect(seg.startOffset).toBe(5);
      expect(seg.text).toBe("user.name@sub.domain.org");
      expect(input.value.slice(seg.startOffset, seg.endOffset)).toBe("user.name@sub.domain.org");
    });

    it("handles multi-word input values and isolates sensitive token offset accurately", () => {
      const input = document.createElement("input");
      input.value = "  Provider Name: Dr. Alice, NPI: 1234567893, Department: Oncology  ";
      document.body.appendChild(input);

      const nodeMap = new Map<string, Node>();
      const { segments } = extractVisibleText(input, 5000, 500, nodeMap);

      expect(segments).toHaveLength(1);
      const seg = segments[0];

      // 2 leading spaces
      expect(seg.startOffset).toBe(2);
      expect(seg.text).toBe("Provider Name: Dr. Alice, NPI: 1234567893, Department: Oncology");

      // Detect NPI on segment text
      const matches = detect(seg.text, ["npi"]);
      expect(matches).toHaveLength(1);
      expect(matches[0].value).toBe("1234567893");

      // Calculate absolute token offset in input element
      const tokenStartInInput = seg.startOffset + matches[0].start;
      const tokenEndInInput = seg.startOffset + matches[0].end;

      expect(input.value.slice(tokenStartInInput, tokenEndInInput)).toBe("1234567893");
    });

    it("handles multi-line textarea values with leading whitespace on each line", () => {
      const textarea = document.createElement("textarea");
      textarea.value = "   First Line\n   SSN: 123-45-6789\n   Third Line";
      document.body.appendChild(textarea);

      const nodeMap = new Map<string, Node>();
      const { segments } = extractVisibleText(textarea, 5000, 500, nodeMap);

      expect(segments).toHaveLength(1);
      const seg = segments[0];

      expect(seg.startOffset).toBe(3); // 3 leading spaces before "First Line"
      expect(textarea.value.slice(seg.startOffset, seg.endOffset)).toBe(
        "First Line\n   SSN: 123-45-6789\n   Third Line"
      );

      const matches = detect(seg.text, ["ssn"]);
      expect(matches).toHaveLength(1);
      expect(matches[0].value).toBe("123-45-6789");

      const tokenStart = seg.startOffset + matches[0].start;
      const tokenEnd = seg.startOffset + matches[0].end;
      expect(textarea.value.slice(tokenStart, tokenEnd)).toBe("123-45-6789");
    });
  });
});
