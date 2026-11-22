// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from "vitest";
import { extractVisibleTextWindows } from "../src/content/extract.js";
import { chunkFindingsByByteBudget, validateMessage } from "../src/shared/messages.js";
import { ALL_CATEGORIES } from "../src/shared/settings.js";
import { MAX_MESSAGE_BYTES, type Finding, type WorkerMessage } from "../src/shared/types.js";

function buildSyntheticDom(nodeCount: number): void {
  document.body.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (let i = 0; i < nodeCount; i++) {
    const p = document.createElement("p");
    const hasSecret = i % 100 < 3;
    p.textContent = hasSecret
      ? `Synthetic patient intake node ${i}: SSN 219-09-9999 recorded for chart verification.`
      : `Synthetic clinical progress note ${i}: general non-identifying review observation line.`;
    frag.appendChild(p);
  }
  document.body.appendChild(frag);
}

describe("P6 / D4 — Chunked Windowed Full-Page Scanning", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__gwRedactionContentLoaded;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("extractVisibleTextWindows partitions a 10,000-node DOM across multiple windows without dropping trailing nodes", () => {
    buildSyntheticDom(10_000);
    const nodeIds = new Map<string, Node>();
    const result = extractVisibleTextWindows(document, 250_000, 10_000, nodeIds);

    expect(result.windowsTotal).toBeGreaterThanOrEqual(3);
    expect(result.windows).toHaveLength(result.windowsTotal);
    expect(result.incompleteWindows).toEqual([]);
    expect(result.hardLimitReached).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.totalChars).toBeGreaterThan(750_000);
    const totalSegments = result.windows.reduce((acc, w) => acc + w.segments.length, 0);
    expect(totalSegments).toBe(10_000);
  });

  it("reports hardLimitReached and names the skipped window when maxTotalWindows ceiling is hit", () => {
    buildSyntheticDom(250);
    const nodeIds = new Map<string, Node>();
    // Force ~100-char windows with a 20-window ceiling so window 21 cannot be scanned
    const result = extractVisibleTextWindows(document, 100, 10_000, nodeIds, { maxTotalWindows: 20 });

    expect(result.hardLimitReached).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.windowsTotal).toBe(20);
    expect(result.incompleteWindows).toEqual([
      {
        windowIndex: 21,
        reason: "Technical window ceiling reached (20 windows)",
      },
    ]);
  });

  it("scans all 10,000 nodes end-to-end in content.ts, emits SCAN_PROGRESS, and delivers all 300 findings inside <= 64 KB chunks", async () => {
    vi.resetModules();
    delete (globalThis as Record<string, unknown>).__gwRedactionContentLoaded;
    buildSyntheticDom(10_000);

    const listeners: Array<(msg: unknown, sender: chrome.runtime.MessageSender, sendResponse: (r?: unknown) => void) => boolean | void> = [];
    const sentMessages: WorkerMessage[] = [];

    (globalThis as Record<string, unknown>).chrome = {
      runtime: {
        id: "test-extension-id",
        onMessage: {
          addListener(fn: (typeof listeners)[number]) {
            listeners.push(fn);
          },
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
        local: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
        },
      },
    };

    await import("../src/content/content.js");
    const handler = listeners[listeners.length - 1]!;
    await new Promise<void>((resolve) => {
      handler(
        {
          type: "SCAN_PAGE",
          requestId: "req-p6-10k",
          sessionId: "sess-p6-10k",
          mode: "local",
          settings: {
            enabledCategories: [...ALL_CATEGORIES],
            maxVisibleChars: 250_000,
            maxNodeChars: 10_000,
            maskPlaceholders: false,
            sessionTimeoutMs: 900_000,
          },
        },
        { id: "test-extension-id" } as chrome.runtime.MessageSender,
        () => resolve()
      );
    });

    const progress = sentMessages.filter((m): m is Extract<WorkerMessage, { type: "SCAN_PROGRESS" }> => m.type === "SCAN_PROGRESS");
    const chunks = sentMessages.filter((m): m is Extract<WorkerMessage, { type: "SCAN_RESULT_CHUNK" }> => m.type === "SCAN_RESULT_CHUNK");
    const finals = sentMessages.filter((m): m is Extract<WorkerMessage, { type: "SCAN_RESULT" }> => m.type === "SCAN_RESULT");

    expect(progress.length).toBeGreaterThanOrEqual(4);
    expect(progress[progress.length - 1]).toMatchObject({
      windowsCompleted: finals[0]!.stats.windowsTotal,
      windowsTotal: finals[0]!.stats.windowsTotal,
      findingsSoFar: 300,
    });

    expect(finals).toHaveLength(1);
    const finalMsg = finals[0]!;
    expect(finalMsg.stats.truncated).toBe(false);
    expect(finalMsg.stats.findingsTruncated).toBe(false);
    expect(finalMsg.stats.totalFindings).toBe(300);
    expect(finalMsg.stats.windowsScanned).toBe(finalMsg.stats.windowsTotal);
    expect(finalMsg.stats.windowsTotal).toBeGreaterThanOrEqual(3);
    expect(finalMsg.stats.coverageStatus).toBe("FULLY_SCANNED");

    const delivered: Finding[] = [];
    for (const c of chunks) {
      expect(JSON.stringify(c).length).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
      expect(validateMessage(c).ok).toBe(true);
      delivered.push(...c.findings);
    }
    expect(JSON.stringify(finalMsg).length).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    expect(validateMessage(finalMsg).ok).toBe(true);
    delivered.push(...finalMsg.findings);
    expect(delivered).toHaveLength(300);
  });

  it("chunkFindingsByByteBudget keeps every serialized chunk within 64 KB MAX_MESSAGE_BYTES", () => {
    const sample: Finding[] = Array.from({ length: 300 }, (_, i) => ({
      id: `ssn_${i * 100}_${i * 100 + 11}_${i}`,
      category: "ssn",
      confidence: 0.96,
      source: "local-rules",
      preview: "***-**-9999",
      nodeId: `seg_${i}`,
      startOffset: 10,
      endOffset: 21,
      rects: [{ x: 10, y: 20, width: 100, height: 18 }],
      contextPreview: "**** **** **** ****",
      selected: true,
    }));
    const chunks = chunkFindingsByByteBudget(sample);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toHaveLength(300);
    for (const c of chunks) {
      expect(JSON.stringify(c).length).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    }
  });
});
