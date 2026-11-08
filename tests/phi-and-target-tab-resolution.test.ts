// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, expect, it, beforeAll } from "vitest";
import { detect } from "../src/content/detect.js";
import { isExcludedElement } from "../src/content/extract.js";
import { validateMessage } from "../src/shared/messages.js";

type Tab = { id?: number; url?: string; active?: boolean };
const tab = (id: number, url: string, active = false): Tab => ({ id, url, active });

let tabs: Tab[] = [];

(globalThis as unknown as { chrome: unknown }).chrome = {
  runtime: {
    id: "test",
    onMessage: { addListener: () => undefined },
    onConnect: { addListener: () => undefined },
    onStartup: { addListener: () => undefined },
    onInstalled: { addListener: () => undefined },
    sendMessage: async () => undefined,
    connect: () => ({
      onMessage: { addListener: () => undefined },
      onDisconnect: { addListener: () => undefined },
      postMessage: () => undefined,
    }),
    getURL: (path: string) => `chrome-extension://test/${path}`,
  },
  storage: {
    session: {
      get: async () => ({}),
      set: async () => undefined,
      remove: async () => undefined,
    },
    local: {
      get: async () => ({}),
      set: async () => undefined,
      remove: async () => undefined,
    },
  },
  tabs: {
    query: async (q: { active?: boolean; lastFocusedWindow?: boolean; currentWindow?: boolean }) =>
      tabs.filter((t) => (q.active === undefined ? true : t.active === q.active)),
    get: async (tabId: number) => tabs.find((t) => t.id === tabId),
    sendMessage: async () => undefined,
    onRemoved: { addListener: () => undefined },
    onUpdated: { addListener: () => undefined },
  },
  scripting: { executeScript: async () => undefined },
  commands: { onCommand: { addListener: () => undefined } },
  offscreen: { closeDocument: async () => undefined, createDocument: async () => undefined },
  downloads: { download: async () => undefined },
  windows: { onFocusChanged: { addListener: () => undefined } },
  sidePanel: { setPanelBehavior: async () => undefined },
  contextMenus: { create: () => undefined, onClicked: { addListener: () => undefined } },
};

let resolveTargetTab: (explicitTabId?: number) => Promise<unknown>;
let isInternalExtensionUrl: (url?: string) => boolean;

beforeAll(async () => {
  const worker = await import("../src/service-worker/index.js");
  resolveTargetTab = worker.resolveTargetTab as (explicitTabId?: number) => Promise<unknown>;
  isInternalExtensionUrl = worker.isInternalExtensionUrl;
});

describe("resolveTargetTab & extension URL guarding", () => {
  it("recognizes internal extension URLs across Chromium, Firefox, and Safari", () => {
    expect(isInternalExtensionUrl("chrome-extension://abcdef/popup.html")).toBe(true);
    expect(isInternalExtensionUrl("moz-extension://abcdef/sidepanel.html")).toBe(true);
    expect(isInternalExtensionUrl("safari-web-extension://abcdef/review.html")).toBe(true);
    expect(isInternalExtensionUrl("chrome://settings")).toBe(true);
    expect(isInternalExtensionUrl("edge://extensions")).toBe(true);
    expect(isInternalExtensionUrl("about:blank")).toBe(true);
    expect(isInternalExtensionUrl("https://ehr.clinic.org/patient/123")).toBe(false);
  });

  it("resolves explicit tabId when it points to an ordinary scannable web page", async () => {
    tabs = [
      tab(10, "chrome-extension://abcdef/popup.html", true),
      tab(20, "https://hospital.org/chart", false),
    ];
    const resolved = (await resolveTargetTab(20)) as Tab | undefined;
    expect(resolved?.id).toBe(20);
    expect(resolved?.url).toBe("https://hospital.org/chart");
  });

  it("rejects explicit tabId if pointing to an internal extension URL and falls back to scannable tab", async () => {
    tabs = [
      tab(10, "chrome-extension://abcdef/popup.html", false),
      tab(20, "https://hospital.org/chart", true),
    ];
    const resolved = (await resolveTargetTab(10)) as Tab | undefined;
    expect(resolved?.id).toBe(20);
  });
});

describe("POPUP_SCAN message contract with tabId", () => {
  it("validates and preserves optional tabId", () => {
    const res = validateMessage({ type: "POPUP_SCAN", requestId: "req-1", mode: "local", tabId: 42 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.message as { tabId?: number }).tabId).toBe(42);
    }
  });

  it("rejects invalid tabId", () => {
    const res = validateMessage({ type: "POPUP_SCAN", requestId: "req-1", mode: "local", tabId: -5 });
    expect(res.ok).toBe(false);

    const res2 = validateMessage({ type: "POPUP_SCAN", requestId: "req-1", mode: "local", tabId: "42" });
    expect(res2.ok).toBe(false);
  });
});

describe("Injected DOM element exclusion", () => {
  it("excludes GovernWorld toast hosts and paste-guard shields from text extraction", () => {
    const fakeToastHost = {
      closest: (sel: string) => sel.includes("data-gw-toast-host") ? true : null,
      getAttribute: (attr: string) => attr === "data-gw-toast-host" ? "true" : null,
      id: "",
    } as unknown as Element;
    expect(isExcludedElement(fakeToastHost)).toBe(true);

    const fakePasteGuardHost = {
      closest: (sel: string) => sel.includes("__governworld-") ? true : null,
      getAttribute: () => null,
      id: "__governworld-paste-guard-host",
    } as unknown as Element;
    expect(isExcludedElement(fakePasteGuardHost)).toBe(true);

    const fakeNormalElement = {
      closest: () => null,
      getAttribute: () => null,
      id: "patient-name-field",
    } as unknown as Element;
    expect(isExcludedElement(fakeNormalElement)).toBe(false);
  });
});

describe("Clinical PHI detection enhancements", () => {
  it("detects ICD-10 diagnosis codes labeled with clinical terms", () => {
    const text = "Diagnosis: E11.9 (Type 2 diabetes mellitus without complications)\nCondition: M54.5\nICD-10: J45.909";
    const matches = detect(text, ["medical_record_number"]);
    const values = matches.map((m) => m.value);
    expect(values).toContain("E11.9");
    expect(values).toContain("M54.5");
    expect(values).toContain("J45.909");
  });

  it("detects Chart Number and Patient ID as medical records / member identifiers", () => {
    const text = "Chart Number: 984512\nPatient ID: PID-10492\nChart #: 88219";
    const matches = detect(text, ["medical_record_number", "member_id"]);
    const values = matches.map((m) => m.value);
    expect(values).toContain("984512");
    expect(values).toContain("PID-10492");
    expect(values).toContain("88219");
  });

  it("detects Policy Number and Subscriber ID as member identifiers", () => {
    const text = "Policy Number: POL-554421\nSubscriber ID: SUB-99214\nInsurance ID: INS-77112";
    const matches = detect(text, ["member_id"]);
    const values = matches.map((m) => m.value);
    expect(values).toContain("POL-554421");
    expect(values).toContain("SUB-99214");
    expect(values).toContain("INS-77112");
  });

  it("detects Patient names separated by hyphens, tabs, or colons", () => {
    const text = "Patient - Jane Doe\nPatient Name:\tRobert Smith\nAttending Physician | Gregory House";
    const matches = detect(text, ["possible_name"]);
    const values = matches.map((m) => m.value);
    expect(values).toContain("Jane Doe");
    expect(values).toContain("Robert Smith");
    expect(values).toContain("Gregory House");
  });
});
