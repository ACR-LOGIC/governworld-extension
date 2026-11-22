import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { validateMessage } from "../src/shared/messages";

type MessageListener = (
  raw: unknown,
  sender: Record<string, unknown>,
  sendResponse: (response: unknown) => void
) => boolean | void;

type TabUpdatedListener = (
  tabId: number,
  changeInfo: { status?: string; url?: string; title?: string },
  tab: { id?: number; url?: string; title?: string; active?: boolean }
) => void;

type TabRemovedListener = (tabId: number) => void;

const messageListeners: MessageListener[] = [];
const updatedListeners: TabUpdatedListener[] = [];
const removedListeners: TabRemovedListener[] = [];
const sessionStore = new Map<string, unknown>();
const runtimeSent: Array<Record<string, unknown>> = [];
const tabMessagesSent: Array<{ tabId: number; message: Record<string, unknown> }> = [];

interface MockTab {
  id: number;
  url: string;
  title: string;
  active: boolean;
}

let mockTabs: MockTab[] = [];

const chromeMock = {
  runtime: {
    id: "test",
    onMessage: { addListener: (fn: MessageListener) => messageListeners.push(fn) },
    onConnect: { addListener: () => undefined },
    onStartup: { addListener: () => undefined },
    onInstalled: { addListener: () => undefined },
    sendMessage: (message: Record<string, unknown>) => {
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
      get: async (key: string | string[] | null) => {
        if (key === null) {
          const all: Record<string, unknown> = {};
          for (const [k, v] of sessionStore.entries()) all[k] = v;
          return all;
        }
        const keys = Array.isArray(key) ? key : [key];
        const out: Record<string, unknown> = {};
        for (const k of keys) out[k] = sessionStore.get(k);
        return out;
      },
      set: async (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) sessionStore.set(k, v);
      },
      remove: async (key: string | string[]) => {
        const keys = Array.isArray(key) ? key : [key];
        for (const k of keys) sessionStore.delete(k);
      },
    },
    local: {
      get: async () => ({}),
      set: async () => undefined,
      remove: async () => undefined,
    },
  },
  tabs: {
    query: async (q: { active?: boolean }) =>
      mockTabs.filter((t) => (q.active === undefined ? true : t.active === q.active)),
    get: async (tabId: number) => {
      const found = mockTabs.find((t) => t.id === tabId);
      if (!found) throw new Error(`No tab with id: ${tabId}`);
      return found;
    },
    sendMessage: async (tabId: number, message: Record<string, unknown>) => {
      tabMessagesSent.push({ tabId, message });
      return { ok: true };
    },
    onRemoved: { addListener: (fn: TabRemovedListener) => removedListeners.push(fn) },
    onUpdated: { addListener: (fn: TabUpdatedListener) => updatedListeners.push(fn) },
  },
  scripting: { executeScript: async () => undefined },
  commands: { onCommand: { addListener: () => undefined } },
  offscreen: { closeDocument: async () => undefined, createDocument: async () => undefined },
  downloads: { download: async () => undefined },
  action: {
    setBadgeText: async () => undefined,
    setBadgeBackgroundColor: async () => undefined,
  },
  sidePanel: { setPanelBehavior: async () => undefined },
  contextMenus: { create: () => undefined, removeAll: (cb?: () => void) => cb?.(), onClicked: { addListener: () => undefined } },
};

async function invokePopup(raw: Record<string, unknown>): Promise<unknown> {
  const listener = messageListeners[0];
  if (!listener) throw new Error("service worker onMessage listener was not registered");
  return new Promise((resolve) => {
    const syncResponse = listener(
      raw,
      { id: "test", url: "chrome-extension://test/popup.html" },
      (response) => resolve(response)
    );
    if (syncResponse !== true) resolve(undefined);
  });
}

describe("Task A2 (Decision D2) — Pinned scan target / tab picker, no auto-follow", () => {
  beforeAll(async () => {
    vi.stubGlobal("chrome", chromeMock);
    await import("../src/service-worker/index.js");
  });

  beforeEach(() => {
    sessionStore.clear();
    runtimeSent.length = 0;
    tabMessagesSent.length = 0;
    mockTabs = [
      { id: 101, url: "https://clinic1.example.test/chart", title: "Tab 1 - Clinic One", active: false },
      { id: 102, url: "https://clinic2.example.test/chart", title: "Tab 2 - Clinic Two", active: false },
      { id: 103, url: "https://clinic3.example.test/chart", title: "Tab 3 - Target Ward", active: true },
      { id: 104, url: "https://clinic4.example.test/chart", title: "Tab 4 - Billing", active: false },
      { id: 105, url: "https://clinic5.example.test/chart", title: "Tab 5 - Pharmacy", active: false },
    ];
  });

  it("validates POPUP_PIN_TAB messages and rejects negative or non-integer tabIds", () => {
    expect(validateMessage({ type: "POPUP_PIN_TAB", requestId: "r-1", tabId: 103 }).ok).toBe(true);
    expect(validateMessage({ type: "POPUP_PIN_TAB", requestId: "r-2", tabId: null, pinCurrent: true }).ok).toBe(true);
    expect(validateMessage({ type: "POPUP_PIN_TAB", requestId: "r-3", tabId: -1 }).ok).toBe(false);
    expect(validateMessage({ type: "POPUP_PIN_TAB", requestId: "r-4", tabId: "103" }).ok).toBe(false);
  });

  it("binds all scans and masks to pinned Tab 3 across focus switches, warns on navigation, and falls back to no scan when Tab 3 closes", async () => {
    // 1. Pin Tab 3 (id: 103)
    await invokePopup({ type: "POPUP_PIN_TAB", requestId: "pin-3", tabId: 103 });
    const pinStateMsg = runtimeSent[runtimeSent.length - 1] as {
      type: string;
      state: {
        pinnedTarget?: {
          status: string;
          pinnedTabId: number | null;
          title?: string;
          domain?: string;
          availableTabs: Array<{ tabId: number }>;
        };
      };
    };
    expect(pinStateMsg.type).toBe("POPUP_STATE");
    expect(pinStateMsg.state.pinnedTarget?.status).toBe("pinned");
    expect(pinStateMsg.state.pinnedTarget?.pinnedTabId).toBe(103);
    expect(pinStateMsg.state.pinnedTarget?.title).toBe("Tab 3 - Target Ward");
    expect(pinStateMsg.state.pinnedTarget?.domain).toBe("clinic3.example.test");
    expect(pinStateMsg.state.pinnedTarget?.availableTabs).toHaveLength(5);

    // 2. Switch active focus among Tabs 1, 2, 4, and 5 and trigger scans:
    // Every scan MUST target Tab 3 (103), never the newly focused tabs.
    for (const focusedId of [101, 102, 104, 105]) {
      for (const t of mockTabs) t.active = t.id === focusedId;
      tabMessagesSent.length = 0;
      await invokePopup({ type: "POPUP_SCAN", requestId: `scan-while-${focusedId}`, mode: "local" });
      const scanPageDispatches = tabMessagesSent.filter((m) => m.message.type === "SCAN_PAGE");
      expect(scanPageDispatches).toHaveLength(1);
      expect(scanPageDispatches[0].tabId).toBe(103);
    }

    // 3. Navigate Tab 3 to a new URL -> status becomes 'navigated' while keeping pinnedTabId = 103
    mockTabs[2].url = "https://clinic3.example.test/discharge-summary";
    mockTabs[2].title = "Tab 3 - Discharge Summary";
    runtimeSent.length = 0;
    for (const fn of updatedListeners) {
      fn(103, { url: mockTabs[2].url, title: mockTabs[2].title, status: "complete" }, mockTabs[2]);
    }
    await vi.waitFor(() => {
      expect(runtimeSent.some((m) => m.type === "POPUP_STATE")).toBe(true);
    });
    const navState = (runtimeSent[runtimeSent.length - 1] as {
      state: { pinnedTarget?: { status: string; pinnedTabId: number | null; title?: string } };
    }).state;
    expect(navState.pinnedTarget?.status).toBe("navigated");
    expect(navState.pinnedTarget?.pinnedTabId).toBe(103);
    expect(navState.pinnedTarget?.title).toBe("Tab 3 - Discharge Summary");

    // 4. Close Tab 3 -> status becomes 'closed', pinnedTabId = null, and subsequent scans refuse to scan other tabs
    mockTabs = mockTabs.filter((t) => t.id !== 103);
    mockTabs[0].active = true; // Tab 1 is now active in the browser
    runtimeSent.length = 0;
    for (const fn of removedListeners) {
      fn(103);
    }
    await vi.waitFor(() => {
      expect(runtimeSent.some((m) => m.requestId === "pinned-tab-closed")).toBe(true);
    });
    const closedMsg = runtimeSent.find((m) => m.requestId === "pinned-tab-closed") as {
      state: { pinnedTarget?: { status: string; pinnedTabId: number | null; closedTitle?: string } };
    };
    expect(closedMsg.state.pinnedTarget?.status).toBe("closed");
    expect(closedMsg.state.pinnedTarget?.pinnedTabId).toBeNull();
    expect(closedMsg.state.pinnedTarget?.closedTitle).toBe("Tab 3 - Discharge Summary");

    // Attempting to scan while target is closed MUST NOT scan Tab 1 or any other tab
    tabMessagesSent.length = 0;
    runtimeSent.length = 0;
    await invokePopup({ type: "POPUP_SCAN", requestId: "scan-after-close", mode: "local" });
    expect(tabMessagesSent).toHaveLength(0);
    const errState = (runtimeSent[runtimeSent.length - 1] as {
      state: { error?: { code: string }; pinnedTarget?: { status: string; pinnedTabId: number | null } };
    }).state;
    expect(errState.error?.code).toBe("TARGET_TAB_CLOSED");
    expect(errState.pinnedTarget?.status).toBe("closed");
    expect(errState.pinnedTarget?.pinnedTabId).toBeNull();

    // 5. Clicking 'Pin current tab' pins the currently active tab (Tab 1, id: 101)
    await invokePopup({ type: "POPUP_PIN_TAB", requestId: "pin-current", tabId: null, pinCurrent: true });
    const repinnedState = (runtimeSent[runtimeSent.length - 1] as {
      state: { pinnedTarget?: { status: string; pinnedTabId: number | null; title?: string } };
    }).state;
    expect(repinnedState.pinnedTarget?.status).toBe("pinned");
    expect(repinnedState.pinnedTarget?.pinnedTabId).toBe(101);
    expect(repinnedState.pinnedTarget?.title).toBe("Tab 1 - Clinic One");
  });
});
