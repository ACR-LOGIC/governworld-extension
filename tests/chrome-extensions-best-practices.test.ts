// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Window } from "happy-dom";
import { OFFSCREEN_CHANNEL } from "../src/document-pipeline/contract.js";
import { createOverlay } from "../src/content/overlay.js";

type MessageListener = (
  raw: unknown,
  sender: Record<string, unknown>,
  sendResponse: (response: unknown) => void
) => boolean | void;

type ContextMenuClickListener = (
  info: { menuItemId: string; selectionText?: string },
  tab?: { id?: number; windowId?: number; url?: string }
) => void;

type ConnectListener = (port: {
  name: string;
  sender?: { id?: string; url?: string };
  onMessage: { addListener: (fn: (msg: unknown) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
  postMessage: (msg: unknown) => void;
  disconnect: () => void;
}) => void;

describe("Chrome Extensions MV3 Best Practices", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("preserves the UI user gesture by calling chrome.permissions.request synchronously before any await", async () => {
    const messageListeners: MessageListener[] = [];
    const localStore: Record<string, unknown> = {};
    const runtimeSent: unknown[] = [];

    const permissionsRequest = vi.fn(async () => true);
    const permissionsContains = vi.fn(async () => false);
    const permissionsRemove = vi.fn(async () => true);

    vi.stubGlobal("chrome", {
      runtime: {
        id: "test-ext",
        onMessage: { addListener: (fn: MessageListener) => messageListeners.push(fn) },
        onConnect: { addListener: () => undefined },
        onInstalled: { addListener: () => undefined },
        onSuspend: { addListener: () => undefined },
        sendMessage: vi.fn(async (msg: unknown) => {
          runtimeSent.push(msg);
          return undefined;
        }),
        getURL: (p: string) => `chrome-extension://test-ext/${p}`,
        setUninstallURL: vi.fn(async () => undefined),
      },
      storage: {
        local: {
          get: vi.fn(async (key?: string | string[] | null) => {
            if (typeof key === "string") return { [key]: localStore[key] };
            return { ...localStore };
          }),
          set: vi.fn(async (items: Record<string, unknown>) => {
            Object.assign(localStore, items);
          }),
          remove: vi.fn(async () => undefined),
        },
        session: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined),
          remove: vi.fn(async () => undefined),
        },
      },
      permissions: {
        request: permissionsRequest,
        contains: permissionsContains,
        remove: permissionsRemove,
        onAdded: { addListener: () => undefined },
        onRemoved: { addListener: () => undefined },
      },
      tabs: {
        query: vi.fn(async () => []),
        get: vi.fn(async () => ({ id: 10, url: "https://example.com" })),
        sendMessage: vi.fn(async () => undefined),
        onRemoved: { addListener: () => undefined },
        onUpdated: { addListener: () => undefined },
      },
      windows: {
        getCurrent: vi.fn(async () => ({ id: 1 })),
        onRemoved: { addListener: () => undefined },
      },
      scripting: { executeScript: vi.fn(async () => undefined) },
      commands: { onCommand: { addListener: () => undefined } },
      contextMenus: {
        create: vi.fn(),
        removeAll: vi.fn((cb?: () => void) => cb?.()),
        onClicked: { addListener: () => undefined },
      },
      sidePanel: { open: vi.fn(async () => undefined) },
      offscreen: { closeDocument: vi.fn(async () => undefined), createDocument: vi.fn(async () => undefined) },
      downloads: { download: vi.fn(async () => undefined) },
      notifications: { create: vi.fn(async () => "notif-1") },
      alarms: { create: vi.fn(), clear: vi.fn(), onAlarm: { addListener: () => undefined } },
      action: { setBadgeText: vi.fn(async () => undefined), setBadgeBackgroundColor: vi.fn(async () => undefined) },
    });

    await import("../src/service-worker/index.js");
    const onMessage = messageListeners[0];
    expect(onMessage).toBeDefined();

    const trustedSender = { id: "test-ext", url: "chrome-extension://test-ext/popup.html" };

    // 1. Trigger POPUP_SET_NOTIFICATION_PREFS with systemEnabled: true and verify
    //    permissions.request runs synchronously BEFORE awaiting any storage/microtask.
    const ack1 = vi.fn();
    onMessage?.(
      {
        type: "POPUP_SET_NOTIFICATION_PREFS",
        requestId: "req-prefs-1",
        prefs: { systemEnabled: true, toastEnabled: true },
      },
      trustedSender,
      ack1
    );
    expect(permissionsRequest).toHaveBeenCalledTimes(1);
    expect(permissionsRequest).toHaveBeenCalledWith({ permissions: ["notifications"] });
    await vi.waitFor(() => {
      expect(
        runtimeSent.some(
          (m) => typeof m === "object" && m !== null && (m as { type?: string }).type === "POPUP_NOTIFICATION_PREFS_STATE"
        )
      ).toBe(true);
    });

    // 2. Trigger POPUP_SET_NOTIFICATIONS with enabled: true and verify synchronous invocation.
    permissionsRequest.mockClear();
    const ack2 = vi.fn();
    onMessage?.(
      {
        type: "POPUP_SET_NOTIFICATIONS",
        requestId: "req-notif-2",
        enabled: true,
      },
      trustedSender,
      ack2
    );
    expect(permissionsRequest).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(
        runtimeSent.some(
          (m) => typeof m === "object" && m !== null && (m as { type?: string }).type === "POPUP_NOTIFICATIONS_STATE"
        )
      ).toBe(true);
    });
  });

  it("opens the side panel synchronously from contextMenus and confirms redact/mask selection with toast feedback", async () => {
    const installedListeners: Array<() => void> = [];
    const contextMenuClickListeners: ContextMenuClickListener[] = [];
    const createdMenus: Array<Record<string, unknown>> = [];
    const localStore: Record<string, unknown> = {};

    const sidePanelOpen = vi.fn(async () => undefined);
    const tabsSendMessage = vi.fn(async (_tabId: number, msg: { type: string }) => {
      if (msg.type === "CONTEXT_REDACT_SELECTION") {
        return { ok: true, counts: { ssn: 1 } };
      }
      if (msg.type === "CONTEXT_MASK_SELECTION") {
        return { ok: true };
      }
      return undefined;
    });

    vi.stubGlobal("chrome", {
      runtime: {
        id: "test-ext",
        onMessage: { addListener: () => undefined },
        onConnect: { addListener: () => undefined },
        onInstalled: { addListener: (fn: () => void) => installedListeners.push(fn) },
        onSuspend: { addListener: () => undefined },
        sendMessage: vi.fn(async () => undefined),
        getURL: (p: string) => `chrome-extension://test-ext/${p}`,
        setUninstallURL: vi.fn(async () => undefined),
      },
      storage: {
        local: {
          get: vi.fn(async (key?: string | string[] | null) => {
            if (typeof key === "string") return { [key]: localStore[key] };
            return { ...localStore };
          }),
          set: vi.fn(async (items: Record<string, unknown>) => {
            Object.assign(localStore, items);
          }),
          remove: vi.fn(async () => undefined),
        },
        session: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined),
          remove: vi.fn(async () => undefined),
        },
      },
      permissions: {
        contains: vi.fn(async () => false),
        onAdded: { addListener: () => undefined },
        onRemoved: { addListener: () => undefined },
      },
      tabs: {
        query: vi.fn(async () => []),
        get: vi.fn(async () => ({ id: 42, url: "https://example.com" })),
        sendMessage: tabsSendMessage,
        onRemoved: { addListener: () => undefined },
        onUpdated: { addListener: () => undefined },
      },
      windows: {
        getCurrent: vi.fn(async () => ({ id: 7 })),
        onRemoved: { addListener: () => undefined },
      },
      scripting: { executeScript: vi.fn(async () => undefined) },
      commands: { onCommand: { addListener: () => undefined } },
      contextMenus: {
        create: vi.fn((item: Record<string, unknown>) => createdMenus.push(item)),
        removeAll: vi.fn((cb?: () => void) => {
          createdMenus.length = 0;
          cb?.();
        }),
        onClicked: { addListener: (fn: ContextMenuClickListener) => contextMenuClickListeners.push(fn) },
      },
      sidePanel: { open: sidePanelOpen },
      offscreen: { closeDocument: vi.fn(async () => undefined), createDocument: vi.fn(async () => undefined) },
      downloads: { download: vi.fn(async () => undefined) },
      notifications: { create: vi.fn(async () => "notif-1") },
      alarms: { create: vi.fn(), clear: vi.fn(), onAlarm: { addListener: () => undefined } },
      action: { setBadgeText: vi.fn(async () => undefined), setBadgeBackgroundColor: vi.fn(async () => undefined) },
    });

    await import("../src/service-worker/index.js");

    // Populate context menus via onInstalled (invoke all registered listeners)
    for (const fn of installedListeners) {
      fn();
    }
    await vi.waitFor(() => {
      expect(createdMenus.some((m) => m.id === "open_side_panel")).toBe(true);
      expect(createdMenus.some((m) => m.id === "scan_page")).toBe(true);
      expect(createdMenus.some((m) => m.id === "redact_selection")).toBe(true);
      expect(createdMenus.some((m) => m.id === "mask_selection")).toBe(true);
    });

    const onClicked = contextMenuClickListeners[0];
    expect(onClicked).toBeDefined();

    // Synchronous sidePanel.open preserves user gesture
    onClicked?.({ menuItemId: "open_side_panel" }, { id: 42, windowId: 7 });
    expect(sidePanelOpen).toHaveBeenCalledTimes(1);
    expect(sidePanelOpen).toHaveBeenCalledWith({ windowId: 7 });

    // Redact selection confirmation toast (without raw sensitive text)
    onClicked?.({ menuItemId: "redact_selection", selectionText: "123-45-6789" }, { id: 42, url: "https://example.com" });
    await vi.waitFor(() => {
      const toastAfterRedact = tabsSendMessage.mock.calls.find(
        ([, payload]) => (payload as { type?: string }).type === "CONTENT_SHOW_TOAST"
      )?.[1] as { title?: string; message?: string } | undefined;
      expect(toastAfterRedact).toBeDefined();
      expect(toastAfterRedact?.title).toContain("Selection Redacted");
      expect(toastAfterRedact?.message).toContain("1 item masked");
      expect(toastAfterRedact?.message).not.toContain("123-45-6789");
    });

    // Mask selection confirmation toast
    tabsSendMessage.mockClear();
    onClicked?.({ menuItemId: "mask_selection", selectionText: "sensitive value" }, { id: 42, url: "https://example.com" });
    await vi.waitFor(() => {
      const toastAfterMask = tabsSendMessage.mock.calls.find(
        ([, payload]) => (payload as { type?: string }).type === "CONTENT_SHOW_TOAST"
      )?.[1] as { title?: string; message?: string } | undefined;
      expect(toastAfterMask).toBeDefined();
      expect(toastAfterMask?.title).toContain("Selection Masked");
    });
  });

  it("serializes concurrent offscreen document creation behind a single-flight lock", async () => {
    const connectListeners = new Set<ConnectListener>();
    const closeDocument = vi.fn(async () => undefined);
    const getContexts = vi.fn(async () => []);

    const createDocument = vi.fn(async () => {
      await Promise.resolve();
      let portMessageListener: ((msg: unknown) => void) | null = null;
      const port = {
        name: OFFSCREEN_CHANNEL,
        sender: { id: "test-ext", url: "chrome-extension://test-ext/offscreen.html" },
        onMessage: {
          addListener: (fn: (msg: unknown) => void) => {
            portMessageListener = fn;
          },
        },
        onDisconnect: { addListener: () => undefined },
        postMessage: (req: unknown) => {
          const r = req as { jobId: string; op: string };
          queueMicrotask(() => {
            portMessageListener?.({
              channel: OFFSCREEN_CHANNEL,
              ok: true,
              op: "count",
              jobId: r.jobId,
              totalPages: 4,
            });
          });
        },
        disconnect: () => undefined,
      };
      for (const listener of [...connectListeners]) {
        listener(port);
      }
    });

    vi.stubGlobal("chrome", {
      runtime: {
        id: "test-ext",
        onConnect: {
          addListener: (fn: ConnectListener) => connectListeners.add(fn),
          removeListener: (fn: ConnectListener) => connectListeners.delete(fn),
        },
        getURL: (p: string) => `chrome-extension://test-ext/${p}`,
        getContexts,
      },
      offscreen: {
        Reason: { WORKERS: "WORKERS" },
        closeDocument,
        createDocument,
      },
    });

    const { BrowserDocumentPipeline } = await import("../src/document-pipeline/browser.js");
    const pipeline = new BrowserDocumentPipeline();

    const [p1, p2] = await Promise.all([
      pipeline.count({ kind: "pdf", name: "a.pdf", mimeType: "application/pdf", bytes: new ArrayBuffer(0), documentKey: "doc-a" }, "doc-a"),
      pipeline.count({ kind: "pdf", name: "b.pdf", mimeType: "application/pdf", bytes: new ArrayBuffer(0), documentKey: "doc-b" }, "doc-b"),
    ]);

    expect(p1).toBe(4);
    expect(p2).toBe(4);
    expect(createDocument).toHaveBeenCalledTimes(1);
    expect(closeDocument).toHaveBeenCalledTimes(0);
    expect(getContexts).toHaveBeenCalledTimes(1);
  });

  it("batches overlay rectangle elements into a DocumentFragment and skips off-viewport rects", () => {
    const win = new Window();
    const doc = win.document as unknown as Document;
    const fragSpy = vi.spyOn(doc, "createDocumentFragment");

    const overlay = createOverlay(doc);
    overlay.render([
      { kind: "highlight", label: "ssn", x: 10, y: 20, width: 80, height: 18 },
      { kind: "mask", label: "email", x: 40, y: 80, width: 120, height: 20, placeholder: "[EMAIL]" },
      { kind: "mask", label: "offscreen", x: 99999, y: 99999, width: 50, height: 20 },
    ]);

    expect(fragSpy).toHaveBeenCalledTimes(1);
    expect(overlay.getRenderedCount?.()).toBe(2);
    overlay.destroy();
  });

  it("refuses POPUP_MANAGEMENT_UNENROLL fail-closed while paired in MANAGE mode", async () => {
    const messageListeners: MessageListener[] = [];
    const runtimeSent: Array<Record<string, unknown>> = [];
    const enrollmentRecord = {
      organization_id: "org_locked",
      organization_name: "Locked Org",
      employee_id: "emp-01",
      device_id: "dev-lock-1",
      enrolled_at: "2026-11-28T00:00:00Z",
      management_mode: "MANAGE",
    };
    const localStore: Record<string, unknown> = {
      gw_management_enrollment: enrollmentRecord,
    };

    vi.stubGlobal("chrome", {
      runtime: {
        id: "test-ext",
        onMessage: { addListener: (fn: MessageListener) => messageListeners.push(fn) },
        onConnect: { addListener: () => undefined },
        onInstalled: { addListener: () => undefined },
        onSuspend: { addListener: () => undefined },
        sendMessage: vi.fn(async (msg: Record<string, unknown>) => {
          runtimeSent.push(msg);
          return undefined;
        }),
        getURL: (p: string) => `chrome-extension://test-ext/${p}`,
        setUninstallURL: vi.fn(async () => undefined),
      },
      storage: {
        local: {
          get: vi.fn(async (key?: string | string[] | null) => {
            if (typeof key === "string") return { [key]: localStore[key] };
            if (Array.isArray(key)) {
              const out: Record<string, unknown> = {};
              for (const k of key) out[k] = localStore[k];
              return out;
            }
            return { ...localStore };
          }),
          set: vi.fn(async (items: Record<string, unknown>) => {
            Object.assign(localStore, items);
          }),
          remove: vi.fn(async (keys: string | string[]) => {
            for (const k of Array.isArray(keys) ? keys : [keys]) {
              delete localStore[k];
            }
          }),
        },
        session: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined),
          remove: vi.fn(async () => undefined),
        },
      },
      permissions: {
        contains: vi.fn(async () => false),
        onAdded: { addListener: () => undefined },
        onRemoved: { addListener: () => undefined },
      },
      tabs: {
        query: vi.fn(async () => []),
        get: vi.fn(async () => ({ id: 10, url: "https://example.com" })),
        sendMessage: vi.fn(async () => undefined),
        onRemoved: { addListener: () => undefined },
        onUpdated: { addListener: () => undefined },
      },
      windows: { getCurrent: vi.fn(async () => ({ id: 1 })), onRemoved: { addListener: () => undefined } },
      scripting: { executeScript: vi.fn(async () => undefined) },
      commands: { onCommand: { addListener: () => undefined } },
      contextMenus: { create: vi.fn(), removeAll: vi.fn((cb?: () => void) => cb?.()), onClicked: { addListener: () => undefined } },
      sidePanel: { open: vi.fn(async () => undefined) },
      offscreen: { closeDocument: vi.fn(async () => undefined), createDocument: vi.fn(async () => undefined) },
      downloads: { download: vi.fn(async () => undefined) },
      notifications: { create: vi.fn(async () => "notif-1") },
      alarms: { create: vi.fn(), clear: vi.fn(), onAlarm: { addListener: () => undefined } },
      action: { setBadgeText: vi.fn(async () => undefined), setBadgeBackgroundColor: vi.fn(async () => undefined) },
    });

    await import("../src/service-worker/index.js");
    const onMessage = messageListeners[0];
    expect(onMessage).toBeDefined();

    onMessage?.(
      { type: "POPUP_MANAGEMENT_UNENROLL", requestId: "req-unenroll-blocked" },
      { id: "test-ext", url: "chrome-extension://test-ext/popup.html" },
      vi.fn()
    );

    await vi.waitFor(() => {
      const statusMsg = runtimeSent.find((m) => m.type === "POPUP_MANAGEMENT_STATUS_STATE");
      expect(statusMsg).toBeDefined();
      expect(statusMsg?.enrolled).toBe(true);
      expect(String(statusMsg?.error)).toContain("administrator");
    });

    expect(localStore.gw_management_enrollment).toEqual(enrollmentRecord);
  });
});
