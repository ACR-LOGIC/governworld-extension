// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { discoverPageInventory } from "../src/content/normalization/pageInventory";
import { isRecordedClosedShadowHost } from "../src/content/normalization/shadow";
import { ALL_CATEGORIES } from "../src/shared/settings";

describe("Task C3 — Coverage warnings for unscannable regions", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("records closed shadow hosts via attachShadow({ mode: 'closed' }) and ignores GovernWorld's own injected overlays", () => {
    // 1. GovernWorld's own injected UI hosts must NOT trigger a closedShadowRootsBlocked count
    const gwOverlay = document.createElement("div");
    gwOverlay.setAttribute("data-gw-scan-overlay", "true");
    gwOverlay.attachShadow({ mode: "closed" });
    document.body.appendChild(gwOverlay);

    const gwToast = document.createElement("div");
    gwToast.setAttribute("data-gw-toast-host", "true");
    gwToast.attachShadow({ mode: "closed" });
    document.body.appendChild(gwToast);

    const cleanInv = discoverPageInventory(document);
    expect(cleanInv.closedShadowRootsAccessed).toBe(0);
    expect(cleanInv.closedShadowRootsBlocked ?? 0).toBe(0);

    // 2. A host page's closed shadow root MUST be recorded as blocked when chrome.dom is unavailable
    const pageHost = document.createElement("div");
    pageHost.id = "third-party-widget";
    const closedRoot = pageHost.attachShadow({ mode: "closed" });
    const secretSpan = document.createElement("span");
    secretSpan.textContent = "Hidden inside closed shadow";
    closedRoot.appendChild(secretSpan);
    document.body.appendChild(pageHost);

    expect(isRecordedClosedShadowHost(pageHost)).toBe(true);
    const invWithClosed = discoverPageInventory(document);
    expect(invWithClosed.closedShadowRootsBlocked).toBe(1);
  });

  it("emits structured coverageWarnings in SCAN_RESULT for incomplete windows, cross-origin iframes, closed shadow roots, and canvas-only pages, and none on a clean HTML page", async () => {
    delete (globalThis as Record<string, unknown>).__gwRedactionContentLoaded;
    vi.resetModules();

    const sentMessages: Array<Record<string, unknown>> = [];
    let messageListener: ((msg: unknown, sender: chrome.runtime.MessageSender, sendResponse: (res?: unknown) => void) => boolean | void) | null = null;

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
        sendMessage: vi.fn((msg: Record<string, unknown>) => {
          sentMessages.push(msg);
          return Promise.resolve({ ok: true });
        }),
        onMessage: {
          addListener: vi.fn((fn) => {
            messageListener = fn;
          }),
          removeListener: vi.fn(),
        },
      },
      storage: {
        local: { get: vi.fn().mockResolvedValue({}), set: vi.fn().mockResolvedValue(undefined) },
      },
    };

    try {
      await import("../src/content/content");
      expect(messageListener).toBeTypeOf("function");

      let seq = 0;
      const runScan = async (settingsOverride: Record<string, unknown> = {}) => {
        seq++;
        sentMessages.length = 0;
        await new Promise<void>((resolve) => {
          messageListener!(
            {
              type: "SCAN_PAGE",
              requestId: `req-c3-${seq}`,
              sessionId: `sess-c3-${seq}`,
              mode: "local",
              settings: {
                enabledCategories: [...ALL_CATEGORIES],
                maxVisibleChars: 250_000,
                maxNodeChars: 20_000,
                maskPlaceholders: false,
                sessionTimeoutMs: 900_000,
                ...settingsOverride,
              },
            },
            { id: "test-extension-id" } as chrome.runtime.MessageSender,
            () => resolve()
          );
        });
        const response = sentMessages.find((m) => m.type === "SCAN_RESULT") as {
          type: string;
          findings: unknown[];
          stats: {
            coverageStatus?: string;
            coverageWarnings?: Array<{ cause: string; count: number; detail?: string }>;
          };
        };
        expect(response).toBeDefined();
        return response;
      };

      // Case 1: Clean HTML page -> no coverageWarnings, green status
      document.body.innerHTML = "<main><p>Patient SSN 219-09-9999 on clean HTML page.</p></main>";
      const cleanResult = await runScan();
      expect(cleanResult.findings.length).toBeGreaterThanOrEqual(1);
      expect(cleanResult.stats.coverageWarnings ?? []).toEqual([]);
      expect(cleanResult.stats.coverageStatus).toBe("FULLY_SCANNED");

      // Case 2: Incomplete window ceiling -> incomplete_window warning + PARTIALLY_SCANNED
      const paragraphs: string[] = [];
      for (let i = 0; i < 40; i++) {
        paragraphs.push(`<p>${"Clinical observation record text. ".repeat(100)}SSN 219-09-${String(1000 + i)}</p>`);
      }
      document.body.innerHTML = `<main>${paragraphs.join("")}</main>`;
      const incompleteResult = await runScan({
        windowChars: 2000,
        windowOverlapChars: 100,
        maxTotalWindows: 2,
      });
      const incompleteWarnings = incompleteResult.stats.coverageWarnings ?? [];
      expect(incompleteWarnings.some((w) => w.cause === "incomplete_window")).toBe(true);
      expect(incompleteResult.stats.coverageStatus).toBe("PARTIALLY_SCANNED");

      // Case 3: Cross-origin iframe -> cross_origin_iframe warning + BLOCKED_BY_BROWSER_SECURITY
      document.body.innerHTML = "<main><p>Host text SSN 219-09-9999</p><iframe id='xframe'></iframe></main>";
      const iframeEl = document.getElementById("xframe") as HTMLIFrameElement;
      Object.defineProperty(iframeEl, "contentDocument", {
        get() {
          throw new DOMException("Blocked a frame with origin", "SecurityError");
        },
        configurable: true,
      });
      const iframeResult = await runScan();
      const iframeWarnings = iframeResult.stats.coverageWarnings ?? [];
      expect(iframeWarnings.some((w) => w.cause === "cross_origin_iframe" && w.count === 1)).toBe(true);
      expect(iframeResult.stats.coverageStatus).toBe("BLOCKED_BY_BROWSER_SECURITY");

      // Case 4: Closed shadow root -> closed_shadow_root warning + PARTIALLY_SCANNED
      document.body.innerHTML = "<main><p>Host text SSN 219-09-9999</p><div id='closed-host'></div></main>";
      const closedHost = document.getElementById("closed-host")!;
      const closedShadow = closedHost.attachShadow({ mode: "closed" });
      closedShadow.innerHTML = "<p>Closed shadow content</p>";
      const shadowResult = await runScan();
      const shadowWarnings = shadowResult.stats.coverageWarnings ?? [];
      expect(shadowWarnings.some((w) => w.cause === "closed_shadow_root" && w.count === 1)).toBe(true);
      expect(shadowResult.stats.coverageStatus).toBe("PARTIALLY_SCANNED");

      // Case 5: Canvas-only page (visible canvas with zero DOM text) -> canvas_only warning + PARTIALLY_SCANNED
      document.body.innerHTML = "<main><canvas id='chart-canvas' width='400' height='200'></canvas></main>";
      const canvasEl = document.getElementById("chart-canvas")!;
      canvasEl.getBoundingClientRect = () =>
        ({
          width: 400,
          height: 200,
          top: 0,
          left: 0,
          right: 400,
          bottom: 200,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect;
      const canvasResult = await runScan();
      const canvasWarnings = canvasResult.stats.coverageWarnings ?? [];
      expect(canvasWarnings.some((w) => w.cause === "canvas_only" && w.count === 1)).toBe(true);
      expect(canvasResult.stats.coverageStatus).toBe("PARTIALLY_SCANNED");
    } finally {
      Range.prototype.getClientRects = origGetClientRects;
      (globalThis as Record<string, unknown>).chrome = prevChrome;
      delete (globalThis as Record<string, unknown>).__gwRedactionContentLoaded;
    }
  });
});
