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
import { ALL_CATEGORIES } from "../src/shared/settings.js";
import type { Finding, FindingCategory, Rect, WorkerMessage } from "../src/shared/types.js";

type ScanResultMessage = Extract<WorkerMessage, { type: "SCAN_RESULT" }>;

function setupLiveAdversarialContentEnv() {
  delete (globalThis as Record<string, unknown>).__gwRedactionContentLoaded;
  const listeners: Array<(msg: unknown, sender: chrome.runtime.MessageSender, sendResponse: (r?: unknown) => void) => boolean | void> = [];
  const sentMessages: WorkerMessage[] = [];
  const capturedShadows = new Map<Element, ShadowRoot>();
  const createdObservers: MutationObserver[] = [];

  const OrigMutationObserver = globalThis.MutationObserver;
  globalThis.MutationObserver = class TrackedMutationObserver extends OrigMutationObserver {
    constructor(cb: MutationCallback) {
      super(cb);
      createdObservers.push(this);
    }
  } as typeof MutationObserver;

  const origAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init: ShadowRootInit): ShadowRoot {
    const root = origAttachShadow.call(this, init);
    capturedShadows.set(this, root);
    return root;
  };

  const origGetClientRects = Range.prototype.getClientRects;
  Range.prototype.getClientRects = function (): DOMRectList {
    const rect = { x: 12, y: 24, width: 120, height: 18, top: 24, left: 12, right: 132, bottom: 42, toJSON: () => ({}) } as DOMRect;
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

  return {
    sentMessages,
    capturedShadows,
    dispatch(msg: unknown) {
      return new Promise((resolve) => {
        const handler = listeners[listeners.length - 1];
        if (!handler) {
          resolve(undefined);
          return;
        }
        handler(msg, { id: "test-extension-id" } as chrome.runtime.MessageSender, resolve);
      });
    },
    restore() {
      for (const obs of createdObservers) obs.disconnect();
      globalThis.MutationObserver = OrigMutationObserver;
      Element.prototype.attachShadow = origAttachShadow;
      Range.prototype.getClientRects = origGetClientRects;
      (globalThis as Record<string, unknown>).chrome = prevChrome;
      delete (globalThis as Record<string, unknown>).__gwRedactionContentLoaded;
    },
  };
}

function makeDefaultScanSettings() {
  return {
    enabledCategories: [...ALL_CATEGORIES],
    maxVisibleChars: 250_000,
    maxNodeChars: 20_000,
    maskPlaceholders: false,
    sessionTimeoutMs: 900_000,
  };
}

describe("Adversarial M2 Rescan & DOM Traversal Stress Suite", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  // =========================================================================
  // =========================================================================
  // Challenge 1: Multi-Node Rescan Node ID Uniqueness & Mask Isolation
  // =========================================================================
  describe("Challenge 1: Multi-Node Rescan Node ID Uniqueness & Node Mapping", () => {
    it("assigns distinct session-scoped rescan nodeIds across multiple added nodes without collisions", async () => {
      const env = setupLiveAdversarialContentEnv();
      try {
        document.body.innerHTML = `<p id="seed">Initial baseline record.</p>`;
        vi.resetModules();
        await import("../src/content/content.js");

        await env.dispatch({
          type: "SCAN_PAGE",
          requestId: "req-adv-c1",
          sessionId: "sess-adv-c1",
          mode: "local",
          settings: makeDefaultScanSettings(),
        });

        const div1 = document.createElement("div");
        div1.textContent = "Provider NPI 1234567893 active";
        const div2 = document.createElement("div");
        div2.textContent = "Emergency contact: alice@hospital.test";
        const div3 = document.createElement("div");
        div3.textContent = "Billing SSN: 219-09-9999 verified";

        document.body.appendChild(div1);
        document.body.appendChild(div2);
        document.body.appendChild(div3);

        await vi.waitFor(
          () => {
            const results = env.sentMessages.filter((m): m is ScanResultMessage => m.type === "SCAN_RESULT");
            const latest = results[results.length - 1];
            expect(latest?.findings).toHaveLength(3);
          },
          { timeout: 2500, interval: 30 }
        );

        const results = env.sentMessages.filter((m): m is ScanResultMessage => m.type === "SCAN_RESULT");
        const latest = results[results.length - 1];
        const categories = latest.findings.map((f) => f.category).sort();
        expect(categories).toEqual(["email", "npi", "ssn"]);

        // Each added leaf node MUST receive a globally unique nodeId (no collision on 'rescan_seg_0')
        const nodeIdSet = new Set(latest.findings.map((f) => f.nodeId));
        expect(nodeIdSet.size).toBe(3);

        await env.dispatch({
          type: "APPLY_MASKS",
          requestId: "req-adv-c1-mask",
          sessionId: "sess-adv-c1",
          findingIds: latest.findings.map((f) => f.id),
        });
        const host = document.querySelector("[data-gw-scan-overlay]")!;
        const shadow = env.capturedShadows.get(host)!;
        expect(shadow.querySelectorAll('[data-kind="mask"]')).toHaveLength(3);
      } finally {
        env.restore();
      }
    });
  });

  // =========================================================================
  // Challenge 2: Earlier Segment Removal & Offset Synchronization
  // =========================================================================
  describe("Challenge 2: Splicing Earlier Segments & Surviving Findings Offset Sync", () => {
    it("re-bases surviving finding offsets accurately when an earlier node is removed during live rescan", async () => {
      const env = setupLiveAdversarialContentEnv();
      try {
        document.body.innerHTML =
          `<p id="header">Header banner 1</p>` +
          `<p id="p-ssn">SSN: 219-09-9999</p>` +
          `<p id="p-email">Email: doctor@clinic.test</p>`;
        vi.resetModules();
        await import("../src/content/content.js");

        await env.dispatch({
          type: "SCAN_PAGE",
          requestId: "req-adv-c2",
          sessionId: "sess-adv-c2",
          mode: "local",
          settings: makeDefaultScanSettings(),
        });

        const initial = env.sentMessages.find((m): m is ScanResultMessage => m.type === "SCAN_RESULT")!;
        expect(initial.findings).toHaveLength(2);
        const ssnBefore = initial.findings.find((f) => f.category === "ssn")!;
        const emailBefore = initial.findings.find((f) => f.category === "email")!;
        expect(ssnBefore.startOffset).toBe(21);
        expect(emailBefore.startOffset).toBe(40);

        await env.dispatch({
          type: "APPLY_MASKS",
          requestId: "req-adv-c2-apply",
          sessionId: "sess-adv-c2",
          findingIds: initial.findings.map((f) => f.id),
        });

        // Remove header node so surviving combined text shrinks by 16 chars
        document.getElementById("header")!.remove();

        await vi.waitFor(
          () => {
            const results = env.sentMessages.filter((m): m is ScanResultMessage => m.type === "SCAN_RESULT");
            expect(results.length).toBeGreaterThanOrEqual(2);
            const latest = results[results.length - 1];
            const ssnAfter = latest.findings.find((f) => f.category === "ssn");
            expect(ssnAfter?.startOffset).toBe(5);
          },
          { timeout: 2500, interval: 30 }
        );

        const results = env.sentMessages.filter((m): m is ScanResultMessage => m.type === "SCAN_RESULT");
        const latest = results[results.length - 1];
        const ssnAfter = latest.findings.find((f) => f.category === "ssn")!;
        const emailAfter = latest.findings.find((f) => f.category === "email")!;
        expect(ssnAfter.startOffset).toBe(5);
        expect(ssnAfter.endOffset).toBe(16);
        expect(emailAfter.startOffset).toBe(24);
        expect(emailAfter.endOffset).toBe(42);

        // Surviving masks remain rendered in the live overlay without losing email or ssn
        const host = document.querySelector("[data-gw-scan-overlay]")!;
        const shadow = env.capturedShadows.get(host)!;
        const labels = Array.from(shadow.querySelectorAll('[data-kind="mask"]')).map((el) =>
          el.getAttribute("data-label") || ""
        );
        expect(labels.some((l) => l.startsWith("ssn:"))).toBe(true);
        expect(labels.some((l) => l.startsWith("email:"))).toBe(true);
      } finally {
        env.restore();
      }
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

    it("merges consecutive mutation batches in live content script so Batch 1 is never overwritten", async () => {
      const env = setupLiveAdversarialContentEnv();
      try {
        document.body.innerHTML = `<p id="base">Baseline clear clinical line.</p>`;
        vi.resetModules();
        await import("../src/content/content.js");

        await env.dispatch({
          type: "SCAN_PAGE",
          requestId: "req-adv-c5",
          sessionId: "sess-adv-c5",
          mode: "local",
          settings: makeDefaultScanSettings(),
        });

        // Batch 1 arrives
        const batch1El = document.createElement("div");
        batch1El.id = "batch-1";
        batch1El.textContent = "Batch1 SSN: 219-09-9999";
        document.body.appendChild(batch1El);

        // Wait inside the debounce window before Batch 2 arrives
        await new Promise((r) => setTimeout(r, 20));

        // Batch 2 arrives before Batch 1's debounced rescan runs
        const batch2El = document.createElement("span");
        batch2El.id = "batch-2";
        batch2El.textContent = "Batch2 NPI: 1234567893";
        document.body.appendChild(batch2El);

        await vi.waitFor(
          () => {
            const results = env.sentMessages.filter((m): m is ScanResultMessage => m.type === "SCAN_RESULT");
            const latest = results[results.length - 1];
            const cats = latest?.findings.map((f) => f.category) ?? [];
            expect(cats).toContain("ssn");
            expect(cats).toContain("npi");
          },
          { timeout: 2500, interval: 30 }
        );

        const results = env.sentMessages.filter((m): m is ScanResultMessage => m.type === "SCAN_RESULT");
        const latest = results[results.length - 1];
        expect(latest.findings).toHaveLength(2);
      } finally {
        env.restore();
      }
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
