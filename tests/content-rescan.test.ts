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
});
