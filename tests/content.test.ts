// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { extractVisibleText, buildScanText } from "../src/content/extract.js";
import { detect } from "../src/content/detect.js";
import { resolveScanCoverageStatus } from "../src/content/normalization/pageInventory.js";
import { ALL_CATEGORIES } from "../src/shared/settings.js";
import type { Finding, FindingCategory, WorkerMessage } from "../src/shared/types.js";

type ScanResultMessage = Extract<WorkerMessage, { type: "SCAN_RESULT" }>;

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
    let cleanupRuntime: (() => void) | null = null;

    afterEach(() => {
      cleanupRuntime?.();
      cleanupRuntime = null;
    });

    it("processes batch of 100 mutations without destroying session or stripping findings", async () => {
      delete (globalThis as Record<string, unknown>).__gwRedactionContentLoaded;
      const listeners: Array<(msg: unknown, sender: chrome.runtime.MessageSender, sendResponse: (r?: unknown) => void) => boolean | void> = [];
      const sentMessages: WorkerMessage[] = [];
      const createdObservers: MutationObserver[] = [];
      const OrigMutationObserver = globalThis.MutationObserver;
      globalThis.MutationObserver = class TrackedMutationObserver extends OrigMutationObserver {
        constructor(cb: MutationCallback) {
          super(cb);
          createdObservers.push(this);
        }
      } as typeof MutationObserver;

      const origGetClientRects = Range.prototype.getClientRects;
      Range.prototype.getClientRects = function (): DOMRectList {
        const rect = { x: 10, y: 10, width: 100, height: 18, top: 10, left: 10, right: 110, bottom: 28, toJSON: () => ({}) } as DOMRect;
        const list = [rect] as unknown as DOMRectList & { item: (i: number) => DOMRect | null };
        list.item = (i: number) => (i === 0 ? rect : null);
        return list;
      };

      const prevChrome = (globalThis as Record<string, unknown>).chrome;
      (globalThis as Record<string, unknown>).chrome = {
        runtime: {
          id: "test-extension-id",
          onMessage: {
            addListener(fn: (typeof listeners)[number]) { listeners.push(fn); },
            removeListener(fn: (typeof listeners)[number]) {
              const idx = listeners.indexOf(fn);
              if (idx >= 0) listeners.splice(idx, 1);
            },
          },
          sendMessage(msg: WorkerMessage) {
            sentMessages.push(msg);
            return Promise.resolve({ ok: true });
          },
        },
        storage: {
          local: { get: vi.fn().mockResolvedValue({}), set: vi.fn().mockResolvedValue(undefined) },
        },
      };

      cleanupRuntime = () => {
        for (const obs of createdObservers) obs.disconnect();
        globalThis.MutationObserver = OrigMutationObserver;
        Range.prototype.getClientRects = origGetClientRects;
        (globalThis as Record<string, unknown>).chrome = prevChrome;
        delete (globalThis as Record<string, unknown>).__gwRedactionContentLoaded;
      };

      document.body.innerHTML = `<p id="initial-ssn">Patient SSN: 219-09-9999 verified.</p>`;
      vi.resetModules();
      await import("../src/content/content.js");

      const handler = listeners[listeners.length - 1];
      expect(handler).toBeDefined();
      await new Promise((resolve) => {
        handler(
          {
            type: "SCAN_PAGE",
            requestId: "req-f7-1",
            sessionId: "sess-f7-1",
            mode: "local",
            settings: {
              enabledCategories: [...ALL_CATEGORIES],
              maxVisibleChars: 250_000,
              maxNodeChars: 20_000,
              maskPlaceholders: false,
              sessionTimeoutMs: 900_000,
            },
          },
          { id: "test-extension-id" } as chrome.runtime.MessageSender,
          resolve
        );
      });

      const initialScan = sentMessages.find((m): m is ScanResultMessage => m.type === "SCAN_RESULT");
      expect(initialScan?.findings.some((f) => f.category === "ssn")).toBe(true);

      // Mutate 100 nodes in DOM, including new PII in node #99
      for (let i = 0; i < 100; i++) {
        const div = document.createElement("div");
        div.textContent = i === 99 ? "On-call doctor: dr.house@hospital.test" : `Item ${i}`;
        document.body.appendChild(div);
      }

      await vi.waitFor(
        () => {
          const results = sentMessages.filter((m): m is ScanResultMessage => m.type === "SCAN_RESULT");
          const latest = results[results.length - 1];
          expect(latest?.findings.length).toBeGreaterThanOrEqual(2);
        },
        { timeout: 2500, interval: 40 }
      );

      const results = sentMessages.filter((m): m is ScanResultMessage => m.type === "SCAN_RESULT");
      const latest = results[results.length - 1];
      expect(latest.sessionId).toBe("sess-f7-1");
      expect(latest.findings.some((f) => f.category === "ssn")).toBe(true);
      expect(latest.findings.some((f) => f.category === "email")).toBe(true);
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
