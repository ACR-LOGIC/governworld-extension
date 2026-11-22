// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ALL_CATEGORIES, DEFAULT_SETTINGS, normalizeSettings } from "../src/shared/settings";

describe("Task A1 (Decision D1) — Auto-mask single names setting (default OFF)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("defaults autoMaskSingleNames to false and normalizes boolean values cleanly", () => {
    expect(DEFAULT_SETTINGS.autoMaskSingleNames).toBe(false);
    expect(normalizeSettings({}).autoMaskSingleNames).toBe(false);
    expect(normalizeSettings({ autoMaskSingleNames: "yes" }).autoMaskSingleNames).toBe(false);
    expect(normalizeSettings({ autoMaskSingleNames: true }).autoMaskSingleNames).toBe(true);
  });

  it("with autoMaskSingleNames OFF, leaves 'Patient: Maria' unchecked (review-only) while auto-selecting 'Patient: Maria Gonzalez'; with ON, auto-selects both", async () => {
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

      document.body.innerHTML = `<main><p id="n1">Patient: Maria</p><p id="n2">Patient: Maria Gonzalez</p></main>`;

      const runScan = async (autoMaskSingleNames: boolean, seq: number) => {
        sentMessages.length = 0;
        await new Promise<void>((resolve) => {
          messageListener!(
            {
              type: "SCAN_PAGE",
              requestId: `req-a1-${seq}`,
              sessionId: `sess-a1-${seq}`,
              mode: "local",
              settings: {
                enabledCategories: [...ALL_CATEGORIES],
                maxVisibleChars: 250_000,
                maxNodeChars: 20_000,
                maskPlaceholders: false,
                sessionTimeoutMs: 900_000,
                autoMaskSingleNames,
              },
            },
            { id: "test-extension-id" } as chrome.runtime.MessageSender,
            () => resolve()
          );
        });
        const res = sentMessages.find((m) => m.type === "SCAN_RESULT") as {
          findings: Array<{
            id: string;
            category: string;
            selected: boolean;
            parsedName?: { first?: string; last?: string; raw?: string };
          }>;
        };
        expect(res).toBeDefined();
        return res.findings.filter((f) => f.category === "possible_name");
      };

      // 1. Default OFF (autoMaskSingleNames = false)
      const offNames = await runScan(false, 1);
      expect(offNames.length).toBe(2);
      const singleOff = offNames.find((f) => !f.parsedName?.last);
      const fullOff = offNames.find((f) => Boolean(f.parsedName?.first && f.parsedName?.last));
      expect(singleOff).toBeDefined();
      expect(fullOff).toBeDefined();
      expect(singleOff!.selected).toBe(false);
      expect(fullOff!.selected).toBe(true);

      // 2. Turned ON (autoMaskSingleNames = true)
      const onNames = await runScan(true, 2);
      expect(onNames.length).toBe(2);
      const singleOn = onNames.find((f) => !f.parsedName?.last);
      const fullOn = onNames.find((f) => Boolean(f.parsedName?.first && f.parsedName?.last));
      expect(singleOn).toBeDefined();
      expect(fullOn).toBeDefined();
      expect(singleOn!.selected).toBe(true);
      expect(fullOn!.selected).toBe(true);
    } finally {
      Range.prototype.getClientRects = origGetClientRects;
      (globalThis as Record<string, unknown>).chrome = prevChrome;
      delete (globalThis as Record<string, unknown>).__gwRedactionContentLoaded;
    }
  });
});
