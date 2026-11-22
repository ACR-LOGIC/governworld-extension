// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

/**
 * Service-worker routing harness. The worker's onMessage listener is registered
 * at module load against the `chrome` global, so we stub a minimal chrome mock
 * before dynamically importing it, then drive the captured listener directly.
 *
 * The security property under test: content-originated message types
 * (SCAN_RESULT, COPY_REDACTED_TEXT_RESULT, CONTENT_ERROR) must carry a genuine
 * sender.tab. A validated message that lacks sender.tab is dropped — never
 * persisted to a session and never forwarded to the popup.
 */

type MessageListener = (
  raw: unknown,
  sender: Record<string, unknown>,
  sendResponse: (response: unknown) => void
) => boolean | void;

const messageListeners: MessageListener[] = [];
const sessionStore = new Map<string, unknown>();
const runtimeSent: unknown[] = [];
const badgeTextCalls: Array<{ tabId?: number; text: string }> = [];

const chromeMock = {
  runtime: {
    id: "test",
    onMessage: { addListener: (fn: MessageListener) => messageListeners.push(fn) },
    onConnect: { addListener: () => undefined },
    sendMessage: (message: unknown) => {
      runtimeSent.push(message);
      return Promise.resolve();
    },
    connect: () => ({
      onMessage: { addListener: () => undefined },
      onDisconnect: { addListener: () => undefined },
      postMessage: () => undefined,
    }),
    getURL: (path: string) => `chrome-extension://test/${path}`,
  },
  storage: {
    session: {
      get: async (key: string | string[]) => {
        const keys = Array.isArray(key) ? key : [key];
        const out: Record<string, unknown> = {};
        for (const k of keys) out[k] = sessionStore.get(k);
        return out;
      },
      set: async (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) sessionStore.set(k, v);
      },
      remove: async () => undefined,
    },
    local: {
      get: async () => ({}),
      set: async () => undefined,
      remove: async () => undefined,
    },
  },
  tabs: {
    query: async () => [],
    get: async () => ({ id: 42, url: "https://example.com" }),
    sendMessage: async () => undefined,
    onRemoved: { addListener: () => undefined },
    onUpdated: { addListener: () => undefined },
  },
  scripting: { executeScript: async () => undefined },
  commands: { onCommand: { addListener: () => undefined } },
  offscreen: {
    closeDocument: async () => undefined,
    createDocument: async () => undefined,
  },
  downloads: { download: async () => undefined },
  action: {
    setBadgeText: async (details: { tabId?: number; text: string }) => {
      badgeTextCalls.push(details);
    },
    setBadgeBackgroundColor: async () => undefined,
  },
};

async function invoke(raw: unknown, sender: Record<string, unknown>): Promise<unknown> {
  const listener = messageListeners[0];
  if (!listener) throw new Error("service worker onMessage listener was never registered");
  return new Promise((resolve) => {
    const syncResponse = listener(raw, sender, (response) => resolve(response));
    if (syncResponse !== true) resolve(undefined);
  });
}

describe("service-worker message routing (content-originated types require sender.tab)", () => {
  beforeAll(async () => {
    vi.stubGlobal("chrome", chromeMock);
    await import("../src/service-worker/index.js");
  });

  beforeEach(() => {
    sessionStore.clear();
    badgeTextCalls.length = 0;
    runtimeSent.length = 0;
  });

  it("denies SCAN_RESULT / COPY_REDACTED_TEXT_RESULT / CONTENT_ERROR when sender.tab is absent", async () => {
    const base = { requestId: "req-deny", sessionId: "sess-deny" };
    const cases = [
      { type: "SCAN_PROGRESS", requestId: "req-deny", sessionId: "sess-deny", windowsCompleted: 1, windowsTotal: 2, charsScanned: 100, charsTotal: 200, findingsSoFar: 1 },
      { type: "SCAN_RESULT_CHUNK", requestId: "req-deny", sessionId: "sess-deny", chunkIndex: 0, totalChunks: 2, findings: [] },
      { type: "SCAN_RESULT", ...base, findings: [], stats: { visibleChars: 0, truncated: false } },
      { type: "COPY_REDACTED_TEXT_RESULT", ...base, text: "redacted text" },
      { type: "CONTENT_ERROR", ...base, code: "DOC_ERROR", userMessage: "boom" },
    ];
    for (const msg of cases) {
       const response = await invoke(msg, { url: "https://example.com", id: "test" });
       expect(response).toEqual({ ok: false, error: "Unauthorized sender" });
    }
    // Denied: no session row was written and nothing reached the popup.
    expect([...sessionStore.keys()].some((k) => k.startsWith("scan:"))).toBe(false);
    expect(runtimeSent).toEqual([]);
  });

  it("denies privileged messages from an untrusted extension sender", async () => {
    const response = await invoke(
      { type: "POPUP_GET_STATE", requestId: "req-unauthorized" },
      { id: "other-extension", url: "chrome-extension://other-extension/popup.html" }
    );
    expect(response).toEqual({ ok: false, error: "Unauthorized sender" });
  });

  it("processes a tab-bearing SCAN_RESULT (control, proves the guard is what denies)", async () => {
    (chromeMock.tabs.query as unknown) = async () => [{ id: 42, url: "https://example.com" }];
    await invoke(
      { type: "POPUP_SCAN", requestId: "req-pending", mode: "local" },
      { id: "test", url: "chrome-extension://test/popup.html" }
    );
    const sessionStoreKeys = [...sessionStore.keys()];
    const scanSession = sessionStore.get(sessionStoreKeys.find((k) => k.startsWith("scan:")) as string) as {
      sessionId: string;
    };
    const msg = {
      type: "SCAN_RESULT",
      requestId: "req-pending",
      sessionId: scanSession.sessionId,
      findings: [],
      stats: { visibleChars: 0, truncated: false },
    };
     const response = await invoke(msg, {
        id: "test",
        url: "https://example.com/page",
        tab: { id: 42, url: "https://example.com" },
      });
    expect(response).toEqual({ ok: true });
    const stored = sessionStore.get("scan:42") as { sessionId: string } | undefined;
    expect(stored?.sessionId).toBe(scanSession.sessionId);
    expect(runtimeSent).toHaveLength(1);
    expect(runtimeSent[0]).toMatchObject({ type: "POPUP_STATE" });
  });

  it("drops a SCAN_RESULT whose sessionId does not match the pending scan", async () => {
    // Give the worker an active tab so POPUP_SCAN registers a pending scan.
    (chromeMock.tabs.query as unknown) = async () => [{ id: 42, url: "https://example.com" }];
    await invoke(
      { type: "POPUP_SCAN", requestId: "req-pending", mode: "local" },
       { id: "test", url: "chrome-extension://test/popup.html" }
    );

    const stale = {
      type: "SCAN_RESULT",
      requestId: "req-pending",
      sessionId: "sess-stale",
      findings: [],
      stats: { visibleChars: 0, truncated: false },
    };
     const response = await invoke(stale, {
       id: "test",
       url: "https://example.com/page",
       tab: { id: 42, url: "https://example.com" },
     });
    expect(response).toEqual({ ok: true });
    // Mismatched result is dropped fail-closed: the stored session must NOT be
    // overwritten with the stale sessionId, and nothing reaches the popup.
    const stored = sessionStore.get("scan:42") as { sessionId: string } | undefined;
    expect(stored?.sessionId).toBeTruthy();
    expect(stored?.sessionId).not.toBe("sess-stale");
    expect(runtimeSent).toEqual([]);
  });

  it("forwards SCAN_PROGRESS and reassembles SCAN_RESULT_CHUNK into chunked POPUP_STATE under 64 KB (P6)", async () => {
    (chromeMock.tabs.query as unknown) = async () => [{ id: 42, url: "https://example.com" }];
    await invoke(
      { type: "POPUP_SCAN", requestId: "req-p6-sw", mode: "local" },
      { id: "test", url: "chrome-extension://test/popup.html" }
    );
    const scanSession = sessionStore.get("scan:42") as { sessionId: string };
    runtimeSent.length = 0;

    await invoke(
      {
        type: "SCAN_PROGRESS",
        requestId: "req-p6-sw",
        sessionId: scanSession.sessionId,
        windowsCompleted: 1,
        windowsTotal: 4,
        charsScanned: 250_000,
        charsTotal: 870_000,
        findingsSoFar: 87,
      },
      { id: "test", url: "https://example.com/page", tab: { id: 42, url: "https://example.com" } }
    );
    expect(runtimeSent.some((m) => (m as { type?: string }).type === "POPUP_SCAN_PROGRESS")).toBe(true);

    const makeFinding = (i: number) => ({
      id: `ssn_${i * 100}_${i * 100 + 11}_${i}`,
      category: "ssn" as const,
      confidence: 0.96,
      source: "local-rules" as const,
      preview: "***-**-9999",
      nodeId: `seg_${i}`,
      startOffset: 10,
      endOffset: 21,
      rects: [{ x: 10, y: 20, width: 100, height: 18 }],
      contextPreview: "**** **** **** ****",
      selected: true,
    });
    const all300 = Array.from({ length: 300 }, (_, i) => makeFinding(i));
    const firstHalf = all300.slice(0, 150);
    const secondHalf = all300.slice(150);

    await invoke(
      {
        type: "SCAN_RESULT_CHUNK",
        requestId: "req-p6-sw",
        sessionId: scanSession.sessionId,
        chunkIndex: 0,
        totalChunks: 2,
        findings: firstHalf,
      },
      { id: "test", url: "https://example.com/page", tab: { id: 42, url: "https://example.com" } }
    );

    runtimeSent.length = 0;
    await invoke(
      {
        type: "SCAN_RESULT",
        requestId: "req-p6-sw",
        sessionId: scanSession.sessionId,
        chunkIndex: 1,
        totalChunks: 2,
        findings: secondHalf,
        stats: {
          visibleChars: 870_000,
          truncated: false,
          findingsTruncated: false,
          totalFindings: 300,
          windowsScanned: 4,
          windowsTotal: 4,
          coverageStatus: "FULLY_SCANNED",
        },
      },
      { id: "test", url: "https://example.com/page", tab: { id: 42, url: "https://example.com" } }
    );
    await new Promise((r) => setTimeout(r, 40));

    const stored = sessionStore.get("scan:42") as { findings: unknown[]; stats: { windowsScanned: number; windowsTotal: number } };
    expect(stored.findings).toHaveLength(300);
    expect(stored.stats.windowsScanned).toBe(4);
    expect(stored.stats.windowsTotal).toBe(4);

    const stateChunks = runtimeSent.filter((m) => (m as { type?: string }).type === "POPUP_STATE_CHUNK") as Array<{ findings: unknown[]; totalChunks: number }>;
    const finalPopupStates = runtimeSent.filter((m) => (m as { type?: string }).type === "POPUP_STATE") as Array<{ totalChunks?: number; state: { findings: unknown[]; windowsScanned?: number; windowsTotal?: number } }>;
    expect(stateChunks.length).toBeGreaterThanOrEqual(1);
    expect(finalPopupStates).toHaveLength(1);
    const totalDelivered = stateChunks.reduce((acc, c) => acc + c.findings.length, 0) + finalPopupStates[0]!.state.findings.length;
    expect(totalDelivered).toBe(300);
    for (const msg of runtimeSent) {
      expect(JSON.stringify(msg).length).toBeLessThanOrEqual(64 * 1024);
    }
  });

  it("updates session, popup state, and badge on incremental SCAN_RESULT when no pending scan exists (P3)", async () => {
    (chromeMock.tabs.query as unknown) = async () => [{ id: 42, url: "https://example.com" }];
    await invoke(
      { type: "POPUP_SCAN", requestId: "req-p3-init", mode: "local" },
      { id: "test", url: "chrome-extension://test/popup.html" }
    );
    const scanSession = sessionStore.get("scan:42") as { sessionId: string };
    expect(scanSession?.sessionId).toBeTruthy();

    await invoke(
      {
        type: "SCAN_RESULT",
        requestId: "req-p3-init",
        sessionId: scanSession.sessionId,
        findings: [],
        stats: { visibleChars: 24, truncated: false },
      },
      { id: "test", url: "https://example.com/page", tab: { id: 42, url: "https://example.com" } }
    );

    runtimeSent.length = 0;
    badgeTextCalls.length = 0;

    // Wrong sessionId incremental message must be ignored when no pending scan exists
    const staleRes = await invoke(
      {
        type: "SCAN_RESULT",
        requestId: "rescan_stale",
        sessionId: "sess-wrong",
        findings: [
          {
            id: "rescan_ssn_0",
            category: "ssn",
            confidence: 0.96,
            source: "local-rules",
            preview: "***-**-9999",
            nodeId: "rescan_seg_0",
            startOffset: 0,
            endOffset: 11,
            rects: [{ x: 10, y: 10, width: 100, height: 16 }],
            selected: true,
          },
        ],
        stats: { visibleChars: 36, truncated: false },
      },
      { id: "test", url: "https://example.com/page", tab: { id: 42, url: "https://example.com" } }
    );
    expect(staleRes).toEqual({ ok: true });
    expect((sessionStore.get("scan:42") as { findings: unknown[] }).findings).toHaveLength(0);
    expect(runtimeSent).toHaveLength(0);

    // Matching sessionId incremental SCAN_RESULT (no POPUP_SCAN pending) updates session, POPUP_STATE, and badge
    const incRes = await invoke(
      {
        type: "SCAN_RESULT",
        requestId: "rescan_1001",
        sessionId: scanSession.sessionId,
        findings: [
          {
            id: "rescan_ssn_1",
            category: "ssn",
            confidence: 0.96,
            source: "local-rules",
            preview: "***-**-9999",
            nodeId: "rescan_seg_1",
            startOffset: 5,
            endOffset: 16,
            rects: [{ x: 12, y: 24, width: 120, height: 18 }],
            selected: true,
          },
        ],
        stats: { visibleChars: 42, truncated: false },
      },
      { id: "test", url: "https://example.com/page", tab: { id: 42, url: "https://example.com" } }
    );
    expect(incRes).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 30));

    const updated = sessionStore.get("scan:42") as { findings: unknown[]; stats: { visibleChars: number } };
    expect(updated.findings).toHaveLength(1);
    expect(updated.stats.visibleChars).toBe(42);
    expect(runtimeSent).toHaveLength(1);
    expect(runtimeSent[0]).toMatchObject({ type: "POPUP_STATE" });
    expect(badgeTextCalls).toContainEqual({ tabId: 42, text: "1" });
  });

  it("accepts a SCAN_RESULT whose sessionId matches the pending scan", async () => {
    (chromeMock.tabs.query as unknown) = async () => [{ id: 42, url: "https://example.com" }];
    await invoke(
      { type: "POPUP_SCAN", requestId: "req-pending", mode: "local" },
       { id: "test", url: "chrome-extension://test/popup.html" }
    );
    const sessionStoreKeys = [...sessionStore.keys()];
    const scanSession = sessionStore.get(sessionStoreKeys.find((k) => k.startsWith("scan:")) as string) as {
      sessionId: string;
    };

    const matching = {
      type: "SCAN_RESULT",
      requestId: "req-pending",
      sessionId: scanSession.sessionId,
      findings: [],
      stats: { visibleChars: 0, truncated: false },
    };
     const response = await invoke(matching, {
       id: "test",
       url: "https://example.com/page",
       tab: { id: 42, url: "https://example.com" },
     });
    expect(response).toEqual({ ok: true });
    expect(runtimeSent).toHaveLength(1);
    expect(runtimeSent[0]).toMatchObject({ type: "POPUP_STATE" });
  });
});