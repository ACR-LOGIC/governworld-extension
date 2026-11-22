// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ALL_CATEGORIES } from "../src/shared/settings.js";
import type { WorkerMessage } from "../src/shared/types.js";

interface RecordedRuntime {
  listeners: Array<(msg: unknown, sender: chrome.runtime.MessageSender, sendResponse: (r?: unknown) => void) => boolean | void>;
  sentMessages: WorkerMessage[];
  capturedShadows: Map<Element, ShadowRoot>;
  restore: () => void;
  dispatchMessage: (msg: unknown) => Promise<unknown>;
}

function setupContentEnvironment(): RecordedRuntime {
  delete (globalThis as Record<string, unknown>).__gwRedactionContentLoaded;

  const listeners: RecordedRuntime["listeners"] = [];
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
    const rect = {
      x: 12,
      y: 24,
      width: 120,
      height: 18,
      top: 24,
      left: 12,
      right: 132,
      bottom: 42,
      toJSON: () => ({}),
    } as DOMRect;
    const list = [rect] as unknown as DOMRectList & { item: (i: number) => DOMRect | null };
    (list as { item: (i: number) => DOMRect | null }).item = (i: number) => (i === 0 ? rect : null);
    return list;
  };

  const prevChrome = (globalThis as Record<string, unknown>).chrome;
  (globalThis as Record<string, unknown>).chrome = {
    runtime: {
      id: "test-extension-id",
      onMessage: {
        addListener(fn: RecordedRuntime["listeners"][number]) {
          listeners.push(fn);
        },
        removeListener(fn: RecordedRuntime["listeners"][number]) {
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

  return {
    listeners,
    sentMessages,
    capturedShadows,
    restore() {
      for (const obs of createdObservers) obs.disconnect();
      globalThis.MutationObserver = OrigMutationObserver;
      Element.prototype.attachShadow = origAttachShadow;
      Range.prototype.getClientRects = origGetClientRects;
      (globalThis as Record<string, unknown>).chrome = prevChrome;
      delete (globalThis as Record<string, unknown>).__gwRedactionContentLoaded;
    },
    dispatchMessage(msg: unknown) {
      return new Promise((resolve) => {
        const handler = listeners[listeners.length - 1];
        if (!handler) {
          resolve(undefined);
          return;
        }
        handler(msg, { id: "test-extension-id" } as chrome.runtime.MessageSender, (res) => resolve(res));
      });
    },
  };
}

function defaultSettings() {
  return {
    enabledCategories: [...ALL_CATEGORIES],
    maxVisibleChars: 250_000,
    maxNodeChars: 20_000,
    maskPlaceholders: false,
    sessionTimeoutMs: 900_000,
  };
}

function getOverlayMaskLabels(env: RecordedRuntime): string[] {
  const host = document.querySelector("[data-gw-scan-overlay]");
  if (!host) return [];
  const shadow = env.capturedShadows.get(host);
  if (!shadow) return [];
  return Array.from(shadow.querySelectorAll('[data-kind="mask"]')).map(
    (el) => el.getAttribute("data-label") || ""
  );
}

describe("Content Script Live Incremental Rescan (P1 / P2 / P3)", () => {
  let env: RecordedRuntime | null = null;

  beforeEach(() => {
    document.body.innerHTML = "";
    vi.resetModules();
  });

  afterEach(() => {
    env?.restore();
    env = null;
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("P1: re-extracts and masks SSN introduced via in-place characterData mutation while keeping surviving masks aligned", async () => {
    document.body.innerHTML =
      '<p id="seed">Seed: test.user@example.test</p><p id="editable">Initial clean clinical status line.</p>';
    env = setupContentEnvironment();
    await import("../src/content/content.js");

    const scanRes = await env.dispatchMessage({
      type: "SCAN_PAGE",
      requestId: "req-p1-1",
      sessionId: "sess-p1-1",
      mode: "local",
      settings: defaultSettings(),
    });
    expect((scanRes as { ok: boolean }).ok).toBe(true);

    const initialResult = env.sentMessages.find((m) => m.type === "SCAN_RESULT");
    expect(initialResult?.type).toBe("SCAN_RESULT");
    if (initialResult?.type !== "SCAN_RESULT") throw new Error("Missing SCAN_RESULT");
    expect(initialResult.findings.map((f) => f.category)).toEqual(["email"]);

    await env.dispatchMessage({
      type: "APPLY_MASKS",
      requestId: "req-p1-apply",
      sessionId: "sess-p1-1",
      findingIds: initialResult.findings.map((f) => f.id),
    });
    await new Promise((r) => setTimeout(r, 40));

    const beforeLabels = getOverlayMaskLabels(env);
    expect(beforeLabels.some((l) => l.startsWith("email:"))).toBe(true);
    expect(beforeLabels.some((l) => l.startsWith("ssn:"))).toBe(false);

    // Trigger genuine characterData mutation on existing Text node
    const editableP = document.getElementById("editable")!;
    const textNode = editableP.firstChild as Text;
    textNode.data = "Patient SSN 219-09-9999 updated in place.";

    // Wait past mutation debounce (150 ms) + content debounce (500 ms)
    await new Promise((r) => setTimeout(r, 850));

    const afterLabels = getOverlayMaskLabels(env);
    expect(afterLabels.some((l) => l.startsWith("email:"))).toBe(true);
    expect(afterLabels.some((l) => l.startsWith("ssn:") && l.includes("9999"))).toBe(true);

    // Verify surviving email finding offsets remain accurately aligned for copy redaction
    await env.dispatchMessage({
      type: "COPY_REDACTED_TEXT",
      requestId: "req-p1-copy",
      sessionId: "sess-p1-1",
      findingIds: initialResult.findings.map((f) => f.id),
    });
    const copyMsg = env.sentMessages.find((m) => m.type === "COPY_REDACTED_TEXT_RESULT");
    expect(copyMsg?.type).toBe("COPY_REDACTED_TEXT_RESULT");
    if (copyMsg?.type === "COPY_REDACTED_TEXT_RESULT") {
      expect(copyMsg.text).toContain("Seed: ");
      expect(copyMsg.text).not.toContain("test.user@example.test");
    }
  });

  it("P1: creates overlay and masks SSN edited in-place on a page that had zero initial findings", async () => {
    document.body.innerHTML = '<p id="editable">Routine status OK.</p>';
    env = setupContentEnvironment();
    await import("../src/content/content.js");

    await env.dispatchMessage({
      type: "SCAN_PAGE",
      requestId: "req-p1-clean",
      sessionId: "sess-p1-clean",
      mode: "local",
      settings: defaultSettings(),
    });
    expect(getOverlayMaskLabels(env)).toEqual([]);

    (document.getElementById("editable")!.firstChild as Text).data = "Emergency SSN 219-09-7777";
    await new Promise((r) => setTimeout(r, 850));

    const labels = getOverlayMaskLabels(env);
    expect(labels.length).toBe(1);
    expect(labels[0]).toContain("ssn:");
    expect(labels[0]).toContain("7777");
  });

  it("P1: removes stale finding and draws replacement mask when a secret is replaced in-place via characterData", async () => {
    document.body.innerHTML = '<p id="editable">Contact old.secret@example.test immediately.</p>';
    env = setupContentEnvironment();
    await import("../src/content/content.js");

    await env.dispatchMessage({
      type: "SCAN_PAGE",
      requestId: "req-p1-replace",
      sessionId: "sess-p1-replace",
      mode: "local",
      settings: defaultSettings(),
    });
    const initScan = env.sentMessages.find((m) => m.type === "SCAN_RESULT");
    if (initScan?.type !== "SCAN_RESULT") throw new Error("Missing SCAN_RESULT");
    await env.dispatchMessage({
      type: "APPLY_MASKS",
      requestId: "req-p1-replace-apply",
      sessionId: "sess-p1-replace",
      findingIds: initScan.findings.map((f) => f.id),
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(getOverlayMaskLabels(env).some((l) => l.startsWith("email:"))).toBe(true);

    (document.getElementById("editable")!.firstChild as Text).data = "Cleared email; SSN 219-09-8888";
    await new Promise((r) => setTimeout(r, 850));

    const afterLabels = getOverlayMaskLabels(env);
    expect(afterLabels.some((l) => l.startsWith("email:"))).toBe(false);
    expect(afterLabels.some((l) => l.startsWith("ssn:") && l.includes("8888"))).toBe(true);
  });

  it("P2: assigns unique session-scoped segment IDs across multi-node batches so removing node 1 leaves zero ghost masks and keeps survivors masked", async () => {
    document.body.innerHTML = '<div id="batch-container"></div>';
    env = setupContentEnvironment();
    await import("../src/content/content.js");

    await env.dispatchMessage({
      type: "SCAN_PAGE",
      requestId: "req-p2-init",
      sessionId: "sess-p2-1",
      mode: "local",
      settings: defaultSettings(),
    });

    // Append a 3-node batch simultaneously (NPI, email, SSN)
    const container = document.getElementById("batch-container")!;
    const n1 = document.createElement("p");
    n1.id = "b-npi";
    n1.textContent = "Provider NPI: 1234567893";
    const n2 = document.createElement("p");
    n2.id = "b-email";
    n2.textContent = "Email: batch.user@example.test";
    const n3 = document.createElement("p");
    n3.id = "b-ssn";
    n3.textContent = "SSN: 219-09-9999";
    container.append(n1, n2, n3);

    await new Promise((r) => setTimeout(r, 850));

    const batchLabels = getOverlayMaskLabels(env);
    expect(batchLabels.length).toBe(3);
    expect(batchLabels.some((l) => l.startsWith("npi:"))).toBe(true);
    expect(batchLabels.some((l) => l.startsWith("email:"))).toBe(true);
    expect(batchLabels.some((l) => l.startsWith("ssn:"))).toBe(true);

    // Remove first batch node -> only its NPI mask must disappear; email & SSN must remain
    n1.remove();
    await new Promise((r) => setTimeout(r, 850));

    const afterRemoveLabels = getOverlayMaskLabels(env);
    expect(afterRemoveLabels.length).toBe(2);
    expect(afterRemoveLabels.some((l) => l.startsWith("npi:"))).toBe(false);
    expect(afterRemoveLabels.some((l) => l.startsWith("email:"))).toBe(true);
    expect(afterRemoveLabels.some((l) => l.startsWith("ssn:"))).toBe(true);

    // In-place edit on the second node (email -> clean) must also remove only the email mask
    (n2.firstChild as Text).data = "Email cleared cleanly.";
    await new Promise((r) => setTimeout(r, 850));

    const afterEditLabels = getOverlayMaskLabels(env);
    expect(afterEditLabels.length).toBe(1);
    expect(afterEditLabels.some((l) => l.startsWith("email:"))).toBe(false);
    expect(afterEditLabels.some((l) => l.startsWith("ssn:"))).toBe(true);
  });

  it("emits updated SCAN_RESULT messages on added-node and characterData mutations (P3)", async () => {
    document.body.innerHTML = '<div id="p3-host"><p id="p3-char">clean initial text</p></div>';
    env = setupContentEnvironment();
    await import("../src/content/content.js");

    await env.dispatchMessage({
      type: "SCAN_PAGE",
      requestId: "req-p3-init",
      sessionId: "sess-p3-1",
      mode: "local",
      settings: defaultSettings(),
    });

    const initialResults = env.sentMessages.filter((m) => m.type === "SCAN_RESULT");
    expect(initialResults).toHaveLength(1);
    expect(initialResults[0]).toMatchObject({
      type: "SCAN_RESULT",
      requestId: "req-p3-init",
      sessionId: "sess-p3-1",
    });
    expect((initialResults[0] as { findings: unknown[] }).findings).toHaveLength(0);

    // 1. Added-node mutation containing SSN -> emits SCAN_RESULT with count 1
    env.sentMessages.length = 0;
    const host = document.getElementById("p3-host")!;
    const added = document.createElement("p");
    added.textContent = "Patient SSN: 219-09-9999";
    host.appendChild(added);

    await new Promise((r) => setTimeout(r, 850));

    const afterAddResults = env.sentMessages.filter((m) => m.type === "SCAN_RESULT") as Array<{
      requestId: string;
      sessionId: string;
      findings: Array<{ category: string }>;
    }>;
    expect(afterAddResults.length).toBeGreaterThanOrEqual(1);
    const latestAfterAdd = afterAddResults[afterAddResults.length - 1]!;
    expect(latestAfterAdd.sessionId).toBe("sess-p3-1");
    expect(latestAfterAdd.requestId.startsWith("rescan_")).toBe(true);
    expect(latestAfterAdd.findings.length).toBe(1);
    expect(latestAfterAdd.findings[0]?.category).toBe("ssn");

    // 2. characterData mutation on existing text node -> emits SCAN_RESULT with count 2
    env.sentMessages.length = 0;
    const charNode = document.getElementById("p3-char")!.firstChild as Text;
    charNode.data = "Updated contact: p3.char@example.test";

    await new Promise((r) => setTimeout(r, 850));

    const afterCharResults = env.sentMessages.filter((m) => m.type === "SCAN_RESULT") as Array<{
      requestId: string;
      sessionId: string;
      findings: Array<{ category: string }>;
    }>;
    expect(afterCharResults.length).toBeGreaterThanOrEqual(1);
    const latestAfterChar = afterCharResults[afterCharResults.length - 1]!;
    expect(latestAfterChar.sessionId).toBe("sess-p3-1");
    expect(latestAfterChar.requestId.startsWith("rescan_")).toBe(true);
    expect(latestAfterChar.findings.map((f) => f.category).sort()).toEqual(["email", "ssn"]);
  });

  it("uses adaptive debounce: fast path (< 150ms) for 1-node edit while coalescing 25-node bursts over 500ms (P7)", async () => {
    document.body.innerHTML = '<div id="p7-host"><p id="p7-single">Clean editable text.</p></div>';
    env = setupContentEnvironment();
    await import("../src/content/content.js");

    await env.dispatchMessage({
      type: "SCAN_PAGE",
      requestId: "req-p7-init",
      sessionId: "sess-p7-1",
      mode: "local",
      settings: defaultSettings(),
    });
    expect(getOverlayMaskLabels(env)).toHaveLength(0);

    // 1. Small single-node characterData edit -> masked fast (< 160ms)
    env.sentMessages.length = 0;
    const textNode = document.getElementById("p7-single")!.firstChild as Text;
    textNode.data = "Updated SSN: 219-09-9999";

    await new Promise((r) => setTimeout(r, 160));
    const afterSmallLabels = getOverlayMaskLabels(env);
    expect(afterSmallLabels.some((l) => l.startsWith("ssn:"))).toBe(true);

    // 2. Large burst (> 10 nodes) must NOT fire early during the burst debounce window
    env.sentMessages.length = 0;
    const host = document.getElementById("p7-host")!;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 25; i++) {
      const p = document.createElement("p");
      p.textContent = i === 12 ? "Burst SSN: 219-09-9997" : `Routine burst entry ${i}`;
      frag.appendChild(p);
    }
    host.appendChild(frag);

    await new Promise((r) => setTimeout(r, 250));
    // Still inside 150ms + 500ms burst window: no extra burst SCAN_RESULT emitted yet
    expect(env.sentMessages.filter((m) => m.type === "SCAN_RESULT")).toHaveLength(0);

    await new Promise((r) => setTimeout(r, 600));
    const burstResults = env.sentMessages.filter((m) => m.type === "SCAN_RESULT");
    expect(burstResults).toHaveLength(1);
    expect(getOverlayMaskLabels(env).filter((l) => l.startsWith("ssn:")).length).toBe(2);
  });
});
