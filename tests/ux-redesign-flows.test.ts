// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CATEGORY_TRANSLATIONS,
  PRESET_TRANSLATIONS,
  SUPPORTED_LANGUAGES,
  UI_TRANSLATIONS,
} from "../src/shared/i18n.js";
import { DOCUMENT_PIPELINE_UNAVAILABLE_MESSAGE } from "../src/shared/platform.js";
import type { AccountView } from "../src/shared/account.js";
import type { Finding, PopupState } from "../src/shared/types.js";

const extRoot = process.cwd();
const popupHtml = readFileSync(join(extRoot, "src/popup/index.html"), "utf8");
const sidepanelHtml = readFileSync(join(extRoot, "src/sidepanel/sidepanel.html"), "utf8");
const popupCss = readFileSync(join(extRoot, "src/popup/popup.css"), "utf8");
const redactHtml = readFileSync(join(extRoot, "src/popup/redact.html"), "utf8");
const popupTs = readFileSync(join(extRoot, "src/popup/popup.ts"), "utf8");

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

interface HarnessOptions {
  local?: Record<string, unknown>;
  session?: Record<string, unknown>;
  managed?: Record<string, unknown> | null;
  permissionsGranted?: boolean;
  permissionRequestResult?: boolean;
  firefox?: boolean;
  fetchImpl?: typeof fetch;
  activeTabUrl?: string;
  sidePanelOpenImpl?: (opts: { windowId: number }) => Promise<void>;
}

function readSubset(
  store: Record<string, unknown>,
  keys?: string | string[] | Record<string, unknown> | null
): Record<string, unknown> {
  if (keys == null) return { ...store };
  if (typeof keys === "string") {
    return keys in store ? { [keys]: store[keys] } : {};
  }
  if (Array.isArray(keys)) {
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      if (k in store) out[k] = store[k];
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [k, defVal] of Object.entries(keys)) {
    out[k] = k in store ? store[k] : defVal;
  }
  return out;
}

async function setupPopupHarness(options: HarnessOptions = {}) {
  const localStore: Record<string, unknown> = { ...(options.local ?? {}) };
  const sessionStore: Record<string, unknown> = { ...(options.session ?? {}) };
  const listeners: Array<(msg: unknown) => unknown> = [];

  const parsedDoc = new DOMParser().parseFromString(popupHtml, "text/html");
  parsedDoc.querySelectorAll("script, link").forEach((el) => el.remove());
  document.documentElement.innerHTML = parsedDoc.documentElement.innerHTML;
  delete document.documentElement.dataset.gwReady;
  delete document.documentElement.dataset.surface;
  Object.defineProperty(window, "innerHeight", { value: 600, configurable: true, writable: true });

  if (typeof HTMLDialogElement !== "undefined") {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.open = true;
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.open = false;
      this.removeAttribute("open");
    };
  }
  Element.prototype.scrollIntoView = vi.fn();
  URL.createObjectURL = vi.fn(() => "blob:mock-url");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(window, "close").mockImplementation(() => undefined);

  const permissionsGranted = options.permissionsGranted ?? false;
  const permissionRequestResult = options.permissionRequestResult ?? permissionsGranted;
  const sidePanelOpenMock = vi.fn(options.sidePanelOpenImpl ?? (async () => undefined));

  const chromeMock: Record<string, unknown> = {
    storage: {
      local: {
        get: vi.fn(async (keys?: string | string[] | Record<string, unknown> | null) => readSubset(localStore, keys)),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(localStore, items);
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) delete localStore[k];
        }),
      },
      session: {
        get: vi.fn(async (keys?: string | string[] | Record<string, unknown> | null) => readSubset(sessionStore, keys)),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(sessionStore, items);
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) delete sessionStore[k];
        }),
      },
      ...(options.managed != null
        ? {
            managed: {
              get: vi.fn(async (keys?: string | string[] | Record<string, unknown> | null) =>
                readSubset(options.managed as Record<string, unknown>, keys)
              ),
            },
          }
        : {}),
    },
    runtime: {
      id: "test-governworld-ext",
      getURL: vi.fn((path: string) => `chrome-extension://test-governworld-ext/${path}`),
      sendMessage: vi.fn(async () => undefined),
      onMessage: {
        addListener: vi.fn((fn: (msg: unknown) => unknown) => {
          listeners.push(fn);
        }),
      },
    },
    tabs: {
      query: vi.fn(async () => [
        { id: 1, url: options.activeTabUrl ?? "https://example.test/patient-record", active: true },
      ]),
      create: vi.fn(async () => ({ id: 2 })),
    },
    windows: {
      getCurrent: vi.fn(async () => ({ id: 101 })),
      create: vi.fn(async () => ({ id: 102 })),
    },
    permissions: {
      contains: vi.fn(async () => permissionsGranted),
      request: vi.fn(async () => permissionRequestResult),
    },
  };

  if (!options.firefox) {
    chromeMock.offscreen = {
      createDocument: vi.fn(async () => undefined),
    };
    chromeMock.sidePanel = {
      open: sidePanelOpenMock,
    };
    chromeMock.scripting = {
      registerContentScripts: vi.fn(async () => undefined),
      unregisterContentScripts: vi.fn(async () => undefined),
      executeScript: vi.fn(async () => undefined),
    };
  }

  Object.defineProperty(globalThis, "chrome", {
    value: chromeMock,
    configurable: true,
    writable: true,
  });

  const fetchMock = vi.fn(
    options.fetchImpl ??
      (async () => {
        throw new TypeError("Failed to fetch");
      })
  );
  Object.defineProperty(globalThis, "fetch", {
    value: fetchMock,
    configurable: true,
    writable: true,
  });

  vi.resetModules();
  const popupMod = await import("../src/popup/popup.js");
  await popupMod.initPopup();
  expect(document.documentElement.dataset.gwReady).toBe("1");

  const emitRuntimeMessage = async (msg: Record<string, unknown>): Promise<void> => {
    const payload = { requestId: "req-test-1", ...msg };
    for (const listener of listeners) {
      await listener(payload);
    }
    await flushAsync();
  };

  return {
    popupMod,
    localStore,
    sessionStore,
    emitRuntimeMessage,
    fetchMock,
    sidePanelOpenMock,
    chromeMock,
  };
}

const sampleFinding: Finding = {
  id: "f-1",
  category: "ssn",
  confidence: 0.99,
  source: "local-rules",
  preview: "***-**-1234",
  nodeId: "n-1",
  startOffset: 0,
  endOffset: 11,
  rects: [{ x: 10, y: 20, width: 100, height: 18 }],
  selected: true,
};

function makePopupState(overrides: Partial<PopupState> = {}): PopupState {
  return {
    mode: "local",
    operatingMode: "LOCAL",
    scanning: false,
    findings: [],
    scanned: false,
    truncated: false,
    visibleChars: 0,
    consentRequired: false,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("UI/UX Redesign Static Layout & Hygiene Contracts", () => {
  it("provides a circular profile avatar button and accessible popover in both popup and sidepanel", () => {
    for (const [name, html] of [
      ["index.html", popupHtml],
      ["sidepanel.html", sidepanelHtml],
    ] as const) {
      expect(html, `${name} missing #profile-avatar-btn`).toContain('id="profile-avatar-btn"');
      expect(html, `${name} missing #profile-popover`).toContain('id="profile-popover"');
      expect(html, `${name} missing #profile-goto-account-btn`).toContain('id="profile-goto-account-btn"');
      expect(html, `${name} missing #profile-goto-settings-btn`).toContain('id="profile-goto-settings-btn"');
      expect(html, `${name} missing #profile-pair-btn`).toContain('id="profile-pair-btn"');
      expect(html, `${name} missing #profile-help-btn`).toContain('id="profile-help-btn"');
      expect(html, `${name} missing #profile-goto-about-btn`).toContain('id="profile-goto-about-btn"');
      expect(html, `${name} missing #profile-signout-btn`).toContain('id="profile-signout-btn"');
    }
    expect(popupCss).toMatch(/\.profile-avatar-btn\s*\{[^}]*border-radius:\s*9999px/);
  });

  it("uses fluid responsive widths without locking popup scrollbar, sidepanel, or redact.html", () => {
    expect(popupCss).not.toMatch(/html,\s*body\s*\{\s*width:\s*360px/);
    expect(popupCss).toMatch(/html,\s*body\s*\{[^}]*min-width:\s*0/);
    expect(popupCss).toMatch(/html\[data-surface="popup"\]\s*\{[^}]*width:\s*390px;\s*max-width:\s*100%/);
    expect(redactHtml).toMatch(/html,\s*body\s*\{[^}]*width:\s*100%/);
    expect(popupTs).toContain('document.documentElement.dataset.surface = isSidePanelContext ? "sidepanel" : "popup"');
  });

  it("fixes the 7 malformed settings-nav button attributes and high-contrast trailing comma", () => {
    for (const [name, html] of [
      ["index.html", popupHtml],
      ["sidepanel.html", sidepanelHtml],
    ] as const) {
      expect(html, `${name} still has stray '>' before id="settings-nav-"`).not.toMatch(/>\s*id="settings-nav-/);
      for (const page of ["profile", "protection", "appearance", "notifications", "privacy", "advanced", "about"]) {
        expect(html, `${name} missing #settings-nav-${page}`).toContain(`id="settings-nav-${page}"`);
      }
    }
    expect(popupCss).not.toMatch(/\.shield-banner,\s*\{/);
  });

  it("fixes coverage-details-btn, clear-audit-btn storage keys, and removes fake pairing lock & native confirm/alert", () => {
    const coverageBlock = popupTs.slice(
      popupTs.indexOf("coverageDetailsBtn?.addEventListener"),
      popupTs.indexOf("coverageDetailsBtn?.addEventListener") + 200
    );
    expect(coverageBlock).toContain('switchTab("settings")');
    expect(coverageBlock).toContain('switchSettingsPage("privacy")');

    expect(popupTs).toContain('chrome.storage.local.remove(["auditLog", "auditCheckpointState"])');
    expect(popupTs).not.toContain('"audit_log"');
    expect(popupTs).not.toContain("GovernWorld Medical Practice");
    expect(popupTs).not.toMatch(/\bwindow\.confirm\s*\(/);
    expect(popupTs).not.toMatch(/\balert\s*\(/);
  });
});

describe("i18n Claims & Key Completeness Guards", () => {
  it("contains zero prohibited claims or stale (19) counts across all 7 locales", () => {
    for (const { code } of SUPPORTED_LANGUAGES) {
      const uiDict = UI_TRANSLATIONS[code];
      expect(uiDict.filter_all, `${code}.filter_all must report 24 categories`).toContain("24");
      expect(uiDict.filter_all, `${code}.filter_all must not report 19`).not.toContain("19");

      for (const [key, value] of Object.entries(uiDict)) {
        expect(value, `${code}.${key} prohibited proactive claim`).not.toMatch(/proactiv|proakt|プロアクティブ|主动/i);
        expect(value, `${code}.${key} prohibited never-leaves/never-uploaded claim`).not.toMatch(
          /never\s*leave|without any data ever leaving|绝不上传|绝不外泄/i
        );
        expect(value, `${code}.${key} prohibited tamper-evident claim`).not.toMatch(/tamper[- ]?evident/i);
        if (key !== "font_size_default") {
          expect(value, `${code}.${key} unexpected 100% claim`).not.toContain("100%");
        }
        expect(value, `${code}.${key} stale (19) count`).not.toMatch(/\(19\)/);
      }

      const catDict = CATEGORY_TRANSLATIONS[code];
      for (const [key, value] of Object.entries(catDict)) {
        expect(value, `cat ${code}.${key}`).not.toMatch(/proactiv|proakt|プロアクティブ|主动|tamper[- ]?evident/i);
      }

      const presetDict = PRESET_TRANSLATIONS[code];
      for (const [key, value] of Object.entries(presetDict)) {
        expect(value, `preset ${code}.${key}`).not.toMatch(/proactiv|proakt|プロアクティブ|主动|tamper[- ]?evident/i);
      }
    }
  });

  it("defines every static t() key in popup.ts and every HTML data-i18n* key across all 7 locales", () => {
    const tKeys = new Set<string>(
      [...popupTs.matchAll(/\bt\(\s*[^,]+,\s*"([A-Za-z0-9_-]+)"/g)].map((m) => m[1])
    );
    for (const m of popupTs.matchAll(/activity_action_[a-z_]+/g)) {
      tKeys.add(m[0]);
    }
    const htmlKeys = new Set<string>(
      [...popupHtml.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map((m) => m[1])
    );
    const spHtmlKeys = new Set<string>(
      [...sidepanelHtml.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map((m) => m[1])
    );

    expect(htmlKeys).toEqual(spHtmlKeys);
    for (const { code } of SUPPORTED_LANGUAGES) {
      const dict = UI_TRANSLATIONS[code];
      for (const key of tKeys) {
        expect(typeof dict[key], `Missing t() key "${key}" in ${code}`).toBe("string");
        expect(dict[key].trim().length, `Empty t() key "${key}" in ${code}`).toBeGreaterThan(0);
      }
      for (const key of htmlKeys) {
        expect(typeof dict[key], `Missing HTML data-i18n* key "${key}" in ${code}`).toBe("string");
        expect(dict[key].trim().length, `Empty HTML data-i18n* key "${key}" in ${code}`).toBeGreaterThan(0);
      }
    }
  });

  it("preserves the Free & Local-First badge inside #contributions-details summary across language switches", async () => {
    const { popupMod } = await setupPopupHarness();
    popupMod.applyUiLanguage("es");
    let badge = document.querySelector("#contributions-details > summary .guide-badge");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain("Free & Local-First");

    popupMod.applyUiLanguage("en");
    badge = document.querySelector("#contributions-details > summary .guide-badge");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain("Free & Local-First");
  });
});

describe("UI/UX Redesign Behavioral Flows (JSDOM)", () => {
  it("handles profile avatar popover keyboard/outside dismissal, connect -> disconnect reset, and MANAGE mode", async () => {
    const { emitRuntimeMessage } = await setupPopupHarness();
    const avatarBtn = document.getElementById("profile-avatar-btn") as HTMLButtonElement;
    const popover = document.getElementById("profile-popover") as HTMLElement;
    const avatarInitials = document.getElementById("profile-avatar-initials") as HTMLElement;
    const popoverAvatar = document.getElementById("profile-popover-avatar") as HTMLElement;
    const popoverName = document.getElementById("profile-popover-name") as HTMLElement;
    const popoverMode = document.getElementById("profile-popover-mode") as HTMLElement;

    // 1. Open and dismiss with Escape -> restores focus
    avatarBtn.click();
    expect(popover.hidden).toBe(false);
    expect(avatarBtn.getAttribute("aria-expanded")).toBe("true");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(popover.hidden).toBe(true);
    expect(avatarBtn.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement?.id).toBe("profile-avatar-btn");

    // 2. Open and dismiss via outside click
    avatarBtn.click();
    expect(popover.hidden).toBe(false);
    (document.querySelector(".brand-text") as HTMLElement).click();
    expect(popover.hidden).toBe(true);

    // 3. Connect as member -> #org-settings hidden, #org-settings-wall visible
    const memberView: AccountView = {
      connected: true,
      userEmail: "member@acme.test",
      tenantId: "acme",
      tenantName: "Acme Corp",
      role: "member",
      canManage: false,
      tier: "pro",
      expiresAt: null,
      capabilities: ["policy_sync"],
    };
    await emitRuntimeMessage({
      type: "POPUP_ACCOUNT_STATE",
      linked: true,
      gatewayOrigin: "https://api.governworld.acrlogic.com",
      credentialAvailable: true,
      accountLabel: "member@acme.test",
      account: memberView,
    });

    expect(avatarInitials.textContent).toBe("ME");
    expect(popoverName.textContent).toBe("member@acme.test");
    expect(avatarBtn.classList.contains("profile-avatar-btn--linked")).toBe(true);
    expect((document.getElementById("org-settings") as HTMLElement).hidden).toBe(true);
    expect((document.getElementById("org-settings-wall") as HTMLElement).hidden).toBe(false);

    // 4. Disconnect -> silhouette SVG restored (stale "ME" cleared)
    await emitRuntimeMessage({
      type: "POPUP_ACCOUNT_STATE",
      gatewayOrigin: null,
      linked: false,
    });

    expect(avatarInitials.textContent?.trim()).not.toBe("ME");
    expect(avatarInitials.querySelector("svg")).not.toBeNull();
    expect(popoverAvatar.textContent).toBe("L");
    expect(popoverName.textContent).toBe(UI_TRANSLATIONS.en.profile_local_title);
    expect(avatarBtn.classList.contains("profile-avatar-btn--linked")).toBe(false);
    expect(avatarBtn.classList.contains("profile-avatar-btn--local")).toBe(true);

    // 5. Switch to MANAGE mode via POPUP_STATE
    await emitRuntimeMessage({
      type: "POPUP_STATE",
      state: makePopupState({ operatingMode: "MANAGE" }),
    });

    expect((document.getElementById("mode-badge") as HTMLElement).textContent).toBe("MANAGE");
    expect(avatarBtn.classList.contains("profile-avatar-btn--managed")).toBe(true);
    expect(popoverMode.textContent).toContain("MANAGE");
    expect(popoverMode.dataset.mode).toBe("managed");
    expect(popoverAvatar.textContent).toBe("M");
    expect(popoverName.textContent).not.toBe(UI_TRANSLATIONS.en.profile_local_title);
  });

  it("shows First-Run Welcome card until disclosureAcknowledged is persisted", async () => {
    const { localStore } = await setupPopupHarness();
    const welcome = document.getElementById("first-run-welcome") as HTMLElement;
    const dismissBtn = document.getElementById("welcome-dismiss-btn") as HTMLButtonElement;

    expect(welcome.hidden).toBe(false);
    dismissBtn.click();
    await flushAsync();

    expect(welcome.hidden).toBe(true);
    expect((localStore.settings as { disclosureAcknowledged?: boolean }).disclosureAcknowledged).toBe(true);

    // Re-init with persisted disclosureAcknowledged: true
    await setupPopupHarness({ local: localStore });
    expect((document.getElementById("first-run-welcome") as HTMLElement).hidden).toBe(true);
  });

  it("reports honest live protection status across this-tab, off, always-on waiting, and Firefox", async () => {
    // 1. Default this-tab
    await setupPopupHarness();
    expect((document.getElementById("live-paste-value") as HTMLElement).textContent).toBe(
      UI_TRANSLATIONS.en.status_val_this_tab
    );
    expect((document.getElementById("live-docs-value") as HTMLElement).textContent).toBe(
      UI_TRANSLATIONS.en.status_val_ready
    );
    expect((document.getElementById("grant-access-btn") as HTMLButtonElement).hidden).toBe(true);

    // 2. Protection off
    await setupPopupHarness({
      local: { settings: { protectionMode: "off", pasteGuardEnabled: false } },
    });
    const pasteOff = document.getElementById("live-paste-value") as HTMLElement;
    expect(pasteOff.textContent).toBe(UI_TRANSLATIONS.en.status_val_off);
    expect(pasteOff.getAttribute("data-tone")).toBe("muted");
    expect((document.getElementById("scanner-shield-status") as HTMLElement).classList.contains("shield-banner--inactive")).toBe(true);

    // 3. Always-on without site access
    await setupPopupHarness({
      local: { settings: { protectionMode: "always-on", pasteGuardEnabled: true } },
      permissionsGranted: false,
    });
    const pasteWait = document.getElementById("live-paste-value") as HTMLElement;
    expect(pasteWait.textContent).toBe(UI_TRANSLATIONS.en.status_val_waiting);
    expect(pasteWait.getAttribute("data-tone")).toBe("warn");
    expect((document.getElementById("grant-access-btn") as HTMLButtonElement).hidden).toBe(false);

    // 4. Firefox (no offscreen/sidePanel/scripting)
    await setupPopupHarness({ firefox: true });
    const docsFf = document.getElementById("live-docs-value") as HTMLElement;
    expect(docsFf.textContent).toBe(UI_TRANSLATIONS.en.status_val_chromium_only);
    expect(docsFf.getAttribute("data-tone")).toBe("muted");
    expect((document.getElementById("diag-doc-value") as HTMLElement).textContent).toBe(
      UI_TRANSLATIONS.en.status_val_chromium_only
    );
    expect((document.getElementById("diag-ocr-value") as HTMLElement).textContent).toBe(
      UI_TRANSLATIONS.en.status_val_chromium_only
    );
    expect((document.getElementById("doc-status") as HTMLElement).hidden).toBe(false);
    expect((document.getElementById("doc-status-text") as HTMLElement).textContent).toBe(
      DOCUMENT_PIPELINE_UNAVAILABLE_MESSAGE
    );
  });

  it("aggregates real audit telemetry in Tab Scan Status, navigates Coverage Details, and clears audit keys", async () => {
    const { localStore } = await setupPopupHarness({
      local: {
        auditLog: [
          { action: "page_scan_completed", outcome: "ok", host: "ehr.test", counts: { email: 2, ssn: 1 }, ts: "2026-11-18T05:00:00Z" },
          { action: "masks_applied", outcome: "ok", host: "ehr.test", counts: { email: 2 }, ts: "2026-11-18T05:01:00Z" },
          { action: "doc_redacted", outcome: "ok", host: "local", pages: 2, counts: { ssn: 1 }, ts: "2026-11-18T05:02:00Z" },
        ],
        auditCheckpointState: { hash: "abc123" },
      },
    });

    expect((document.getElementById("review-findings-count") as HTMLElement).textContent).toBe("3");
    expect((document.getElementById("review-protected-count") as HTMLElement).textContent).toBe("3");
    expect((document.getElementById("review-pages-count") as HTMLElement).textContent).toBe("3");
    expect((document.getElementById("activity-empty") as HTMLElement).hidden).toBe(true);
    expect((document.getElementById("activity-list") as HTMLElement).children.length).toBe(3);

    // Coverage Details -> Settings -> Privacy
    (document.getElementById("coverage-details-btn") as HTMLButtonElement).click();
    expect((document.getElementById("tab-settings") as HTMLElement).hidden).toBe(false);
    expect((document.getElementById("settings-page-privacy") as HTMLElement).hidden).toBe(false);
    expect((document.getElementById("settings-nav-privacy") as HTMLElement).getAttribute("aria-current")).toBe("page");

    // Clear Audit Trail
    const clearDialog = document.getElementById("clear-audit-dialog") as HTMLDialogElement;
    (document.getElementById("clear-audit-btn") as HTMLButtonElement).click();
    expect(clearDialog.open).toBe(true);

    (document.getElementById("clear-audit-confirm") as HTMLButtonElement).click();
    await flushAsync();

    expect("auditLog" in localStore).toBe(false);
    expect("auditCheckpointState" in localStore).toBe(false);
    expect((document.getElementById("review-findings-count") as HTMLElement).textContent).toBe("0");
    expect((document.getElementById("review-protected-count") as HTMLElement).textContent).toBe("0");
    expect((document.getElementById("review-pages-count") as HTMLElement).textContent).toBe("0");
    expect((document.getElementById("activity-list") as HTMLElement).children.length).toBe(0);
    expect((document.getElementById("activity-empty") as HTMLElement).hidden).toBe(false);
  });

  it("handles findings vs empty-findings states, export menu, localized Wizard error, Office pairing failure, language switch, and user gesture preservation", async () => {
    const { localStore, emitRuntimeMessage, sidePanelOpenMock, chromeMock } = await setupPopupHarness();

    // 1. Active findings -> inline export menu & buttons enabled
    await emitRuntimeMessage({
      type: "POPUP_STATE",
      state: makePopupState({ scanned: true, visibleChars: 500, findings: [sampleFinding] }),
    });
    const resultsSection = document.getElementById("results-section") as HTMLElement;
    expect(resultsSection.hidden).toBe(false);
    expect((document.getElementById("live-scan-value") as HTMLElement).textContent).toBe("1 found");
    expect((document.getElementById("apply-masks-btn") as HTMLButtonElement).disabled).toBe(false);

    (document.getElementById("export-findings-btn") as HTMLButtonElement).click();
    const exportMenu = document.getElementById("export-format-menu") as HTMLElement;
    expect(exportMenu.hidden).toBe(false);
    (document.getElementById("export-cancel-btn") as HTMLButtonElement).click();
    expect(exportMenu.hidden).toBe(true);

    // 2. Empty findings after scan -> #results-section hidden & action buttons disabled
    await emitRuntimeMessage({
      type: "POPUP_STATE",
      state: makePopupState({ scanned: true, visibleChars: 500, findings: [] }),
    });
    expect(resultsSection.hidden).toBe(true);
    expect((document.getElementById("live-scan-value") as HTMLElement).textContent).toBe(UI_TRANSLATIONS.en.status_val_clean);
    for (const btnId of [
      "toggle-all-findings-btn",
      "export-findings-btn",
      "apply-masks-btn",
      "undo-masks-btn",
      "remove-masks-btn",
      "copy-redacted-btn",
    ]) {
      expect((document.getElementById(btnId) as HTMLButtonElement).disabled, `${btnId} should be disabled`).toBe(true);
    }

    // 3. Wizard empty-input error uses localized UI_TRANSLATIONS (never raw key)
    (document.getElementById("open-wizard-btn-2") as HTMLButtonElement).click();
    expect((document.getElementById("wizard-dialog") as HTMLDialogElement).open).toBe(true);
    (document.getElementById("wizard-analyze-btn") as HTMLButtonElement).click();
    await flushAsync();
    const wizardErr = document.getElementById("wizard-step1-error") as HTMLElement;
    expect(wizardErr.hidden).toBe(false);
    expect(wizardErr.textContent).not.toBe("wizard_need_positive");
    expect(wizardErr.textContent).toBe(UI_TRANSLATIONS.en.wizard_need_positive);
    (document.getElementById("wizard-cancel-1") as HTMLButtonElement).click();

    // 4. Honest Office Manager pairing failure (no fake policy fallback)
    const pairingInput = document.getElementById("office-pairing-input") as HTMLInputElement;
    pairingInput.value = "AB12CD";
    (document.getElementById("office-pair-btn") as HTMLButtonElement).click();
    await flushAsync();
    const officeStatus = document.getElementById("office-manager-status") as HTMLElement;
    expect(officeStatus.textContent).toContain("Managed mode unavailable");
    expect(officeStatus.textContent).not.toContain("GovernWorld Medical Practice");
    expect("gw_coordinator_policy" in localStore).toBe(false);
    expect((document.getElementById("mode-badge") as HTMLElement).textContent).toBe("LOCAL");

    // 5. Language switch immediately refreshes dynamic status strips & popover without reload
    const langSelect = document.getElementById("lang-select") as HTMLSelectElement;
    langSelect.value = "es";
    langSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await flushAsync();
    expect((document.getElementById("live-paste-value") as HTMLElement).textContent).toBe(
      UI_TRANSLATIONS.es.status_val_this_tab
    );
    expect((document.getElementById("live-docs-value") as HTMLElement).textContent).toBe(
      UI_TRANSLATIONS.es.status_val_ready
    );
    expect((document.getElementById("live-scan-value") as HTMLElement).textContent).toBe(
      UI_TRANSLATIONS.es.status_val_clean
    );
    expect((document.getElementById("profile-popover-mode") as HTMLElement).textContent).toBe(
      UI_TRANSLATIONS.es.profile_mode_local
    );
    expect(officeStatus.textContent).toBe(UI_TRANSLATIONS.es.office_status_local);

    // 6. User-gesture preservation: chrome.sidePanel.open runs BEFORE storage.local.set resolves
    const events: string[] = [];
    const storageLocal = (chromeMock.storage as { local: { set: ReturnType<typeof vi.fn> } }).local;
    storageLocal.set.mockImplementation(async (items: Record<string, unknown>) => {
      events.push("storage.set.start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      Object.assign(localStore, items);
      events.push("storage.set.done");
    });
    sidePanelOpenMock.mockImplementation(async () => {
      events.push("sidePanel.open");
    });

    (document.getElementById("doc-dropzone") as HTMLDivElement).click();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(events.indexOf("sidePanel.open")).toBeGreaterThan(-1);
    expect(events.indexOf("sidePanel.open")).toBeLessThan(events.indexOf("storage.set.done"));
  });

  it("wires all backend capabilities and provides in-place step-by-step instructional guides", async () => {
    const { chromeMock } = await setupPopupHarness();
    const getSentMessages = () =>
      (chromeMock.runtime as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage.mock.calls.map(
        (c) => c[0] as Record<string, unknown>
      );

    // 1. The three primary tabs' how-to instruction cards exist (the Review
    // tab is gone; its coverage/audit how-to now lives in Tab Scan Status)
    expect(document.getElementById("protection-howto-card")).toBeTruthy();
    expect(document.getElementById("doc-howto-card")).toBeTruthy();
    expect(document.getElementById("logic-howto-card")).toBeTruthy();
    expect(document.getElementById("tab-scan-howto-card")).toBeTruthy();
    expect(document.getElementById("review-howto-card")).toBeNull();
    expect(document.getElementById("tab-review")).toBeNull();

    // 2. Clicking a [data-guide] link opens the in-place contextual guide modal without leaving the current tab
    const howToScanLink = document.querySelector('[data-guide="guide-page-scan"]') as HTMLButtonElement;
    expect(howToScanLink).toBeTruthy();
    howToScanLink.click();
    await flushAsync();

    const guideDialog = document.getElementById("contextual-guide-dialog") as HTMLDialogElement;
    expect(guideDialog.open).toBe(true);
    expect(document.getElementById("contextual-guide-title")?.textContent).toBe("Page Scan");
    expect(document.getElementById("contextual-guide-body")?.textContent).toContain("Alt+Shift+S");
    // Still on Protection tab until user asks to view all guides
    expect((document.getElementById("tab-protection") as HTMLElement).hidden).toBe(false);

    // Clicking "View All 21 Guides" navigates to Settings -> About and highlights the target card
    (document.getElementById("contextual-guide-open-about") as HTMLButtonElement).click();
    await flushAsync();
    expect(guideDialog.open).toBe(false);
    expect((document.getElementById("tab-settings") as HTMLElement).hidden).toBe(false);
    expect((document.getElementById("settings-page-about") as HTMLElement).hidden).toBe(false);
    expect((document.getElementById("about-guides-details") as HTMLDetailsElement).open).toBe(true);
    expect(document.getElementById("guide-page-scan")?.classList.contains("guide-card--highlight")).toBe(true);

    // 3. Account disconnect, Enterprise MANAGE enrollment/sync/unenroll, and Gateway OAuth/API actions
    (document.getElementById("account-clear-btn") as HTMLButtonElement).click();
    expect(getSentMessages().some((m) => m.type === "POPUP_ACCOUNT_CLEAR")).toBe(true);

    (document.getElementById("mgmt-org-id-input") as HTMLInputElement).value = "org-acme-01";
    (document.getElementById("mgmt-org-name-input") as HTMLInputElement).value = "Acme Health";
    (document.getElementById("mgmt-emp-id-input") as HTMLInputElement).value = "emp-42";
    (document.getElementById("mgmt-enroll-btn") as HTMLButtonElement).click();
    expect(
      getSentMessages().some(
        (m) =>
          m.type === "POPUP_MANAGEMENT_ENROLL" &&
          m.organizationId === "org-acme-01" &&
          m.employeeId === "emp-42"
      )
    ).toBe(true);

    (document.getElementById("mgmt-sync-policy-btn") as HTMLButtonElement).click();
    expect(getSentMessages().some((m) => m.type === "POPUP_SYNC_MANAGED_POLICY")).toBe(true);

    (document.getElementById("mgmt-unenroll-btn") as HTMLButtonElement).click();
    expect(getSentMessages().some((m) => m.type === "POPUP_MANAGEMENT_UNENROLL")).toBe(true);

    (document.getElementById("oauth-connect-btn") as HTMLButtonElement).click();
    expect(getSentMessages().some((m) => m.type === "POPUP_OAUTH_CONNECT")).toBe(true);

    (document.getElementById("api-sync-policy-btn") as HTMLButtonElement).click();
    expect(getSentMessages().some((m) => m.type === "POPUP_API_SYNC_POLICY")).toBe(true);

    (document.getElementById("api-disconnect-btn") as HTMLButtonElement).click();
    expect(getSentMessages().some((m) => m.type === "POPUP_API_DISCONNECT")).toBe(true);

    // 4. Wizard Step 4 saves contextCues, captureGroup, minLength, and maxLength
    (document.getElementById("open-wizard-btn-2") as HTMLButtonElement).click();
    (document.getElementById("wizard-rule-name") as HTMLInputElement).value = "Badge ID";
    (document.getElementById("wizard-regex-input") as HTMLInputElement).value = "BADGE-(\\d{5})";
    (document.getElementById("wizard-rule-cues") as HTMLInputElement).value = "badge, employee";
    (document.getElementById("wizard-rule-group") as HTMLInputElement).value = "1";
    (document.getElementById("wizard-rule-min-len") as HTMLInputElement).value = "5";
    (document.getElementById("wizard-rule-max-len") as HTMLInputElement).value = "12";
    (document.getElementById("wizard-save-btn") as HTMLButtonElement).click();

    const saveMsg = getSentMessages().find((m) => m.type === "POPUP_CUSTOM_PATTERN_SAVE") as
      | { pattern: { name: string; captureGroup: number; contextCues: string[]; minLength: number; maxLength: number } }
      | undefined;
    expect(saveMsg).toBeTruthy();
    expect(saveMsg?.pattern.name).toBe("Badge ID");
    expect(saveMsg?.pattern.captureGroup).toBe(1);
    expect(saveMsg?.pattern.contextCues).toEqual(["badge", "employee"]);
    expect(saveMsg?.pattern.minLength).toBe(5);
    expect(saveMsg?.pattern.maxLength).toBe(12);
  });
});

describe("Frontend Redesign (3 tabs, Document home, profile-menu Settings)", () => {
  it("has exactly three primary tabs and puts document controls only in the Document tab", () => {
    for (const [name, html] of [
      ["index.html", popupHtml],
      ["sidepanel.html", sidepanelHtml],
    ] as const) {
      const tabBtns = [...html.matchAll(/id="tab-btn-[a-z]+"/g)].map((m) => m[0]);
      expect(tabBtns, `${name} tab buttons`).toEqual([
        'id="tab-btn-protection"',
        'id="tab-btn-logic"',
        'id="tab-btn-document"',
      ]);
      expect(html).not.toContain('id="tab-btn-review"');
      expect(html).not.toContain('id="tab-btn-settings"');
      expect(html).not.toContain('id="tab-review"');
      expect(html).not.toContain("link-community-btn");
      expect(html).not.toContain("fetch-community-rules-btn");
      expect(html).not.toContain("community-disclosure");
      // Document is the only home for upload/redaction.
      expect(html).toContain('id="tab-document"');
      expect(html).toContain('id="doc-workspace"');
      expect(html).toContain('id="doc-dropzone"');
      expect(html).toContain('id="doc-redact-btn"');
      // Protection keeps scan + findings + tab scan status + quick tools.
      expect(html).toContain('id="tab-scan-list"');
      expect(html).toContain('id="results-section"');
      expect(html).toContain('id="quick-tools"');
      expect(html).toContain('id="paste-mode-this-tab-btn"');
      // Settings is a dedicated view behind the profile menu, with a back button.
      expect(html).toContain('id="tab-settings"');
      expect(html).toContain('id="settings-back-btn"');
      // Audit export is deduplicated into Settings -> Advanced.
      expect(html).toContain('id="review-export-audit-btn"');
      expect(html).not.toContain('id="export-audit-btn"');
    }
    // Document controls appear exactly once in the popup (no duplicates in Protection).
    expect((popupHtml.match(/id="doc-workspace"/g) || []).length).toBe(1);
    expect((popupHtml.match(/id="doc-dropzone"/g) || []).length).toBe(1);
  });

  it("never promises anonymization and routes Share Rule through the live gateway path", () => {
    expect(popupTs).not.toMatch(/anonymiz/i);
    expect(popupTs).toContain('type: "POPUP_API_SUBMIT_LOGIC"');
    expect(popupTs).not.toContain('type: "POPUP_COMMUNITY_CONTRIBUTE"');
  });

  it("renders Tab Scan Status from real per-tab sessions and scans from a tab entry", async () => {
    const { emitRuntimeMessage, chromeMock } = await setupPopupHarness({
      session: {
        "scan:2": {
          sessionId: "s-2",
          mode: "local",
          findings: [{}, {}, {}],
          stats: { visibleChars: 100, truncated: false, totalFindings: 3 },
          scannedAt: Date.now() - 60_000,
          scanning: false,
        },
      },
    });
    await emitRuntimeMessage({
      type: "POPUP_STATE",
      state: makePopupState({
        scanned: true,
        visibleChars: 500,
        findings: [sampleFinding],
        totalFindings: 1,
        pinnedTarget: {
          status: "pinned",
          pinnedTabId: 1,
          title: "Patient Record",
          url: "https://ehr.test/record",
          domain: "ehr.test",
          availableTabs: [
            { tabId: 1, title: "Patient Record", url: "https://ehr.test/record", domain: "ehr.test", active: true },
            { tabId: 2, title: "Lab Results", url: "https://labs.test/r", domain: "labs.test", active: false },
            { tabId: 3, title: "News", url: "https://news.test/", domain: "news.test", active: false },
          ],
        },
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const list = document.getElementById("tab-scan-list") as HTMLUListElement;
    expect(list.children.length).toBe(3);
    const rows = [...list.children].map((li) => (li as HTMLElement).textContent ?? "");
    expect(rows[0]).toContain("Patient Record");
    expect(rows[0]).toContain("Scanned");
    expect(rows[0]).toContain("Pinned");
    expect(rows[1]).toContain("Lab Results");
    expect(rows[1]).toContain("Scanned");
    expect(rows[1]).toContain("3");
    expect(rows[1]).toContain("Last scan:");
    expect(rows[2]).toContain("News");
    expect(rows[2]).toContain("Not scanned");
    expect((document.getElementById("tab-scan-empty") as HTMLElement).hidden).toBe(true);

    const getSentMessages = () =>
      (chromeMock.runtime as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage.mock.calls.map(
        (c) => c[0] as Record<string, unknown>
      );
    const scanBtn = list.children[2].querySelector("button") as HTMLButtonElement;
    expect(scanBtn.textContent).toBe("Scan");
    scanBtn.click();
    expect(getSentMessages().some((m) => m.type === "POPUP_PIN_TAB" && m.tabId === 3)).toBe(true);
    expect(getSentMessages().some((m) => m.type === "POPUP_SCAN" && m.tabId === 3)).toBe(true);
  });

  it("sends Share Rule consent through the live gateway path, never the stubbed community path", async () => {
    const { emitRuntimeMessage, chromeMock } = await setupPopupHarness();
    await emitRuntimeMessage({
      type: "POPUP_CUSTOM_PATTERNS_STATE",
      patterns: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          name: "Badge ID",
          category: "custom",
          pattern: "BADGE-\\d{5}",
          flags: "",
          confidence: 0.85,
          createdAt: "2026-11-25T00:00:00.000Z",
          source: "local",
          contributionStatus: "local_only",
        },
      ],
    });
    const list = document.getElementById("custom-patterns-list") as HTMLUListElement;
    expect(list.children.length).toBe(1);
    const shareBtn = [...list.querySelectorAll("button")].find((b) => b.textContent === "Share Rule") as HTMLButtonElement;
    expect(shareBtn).toBeTruthy();
    expect(shareBtn.title).not.toMatch(/anonymiz/i);
    shareBtn.click();
    expect((document.getElementById("contrib-consent-dialog") as HTMLDialogElement).open).toBe(true);
    const checkbox = document.getElementById("contrib-consent-checkbox") as HTMLInputElement;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    (document.getElementById("contrib-confirm-btn") as HTMLButtonElement).click();
    await flushAsync();
    const sent = (chromeMock.runtime as { sendMessage: ReturnType<typeof vi.fn> }).sendMessage.mock.calls.map(
      (c) => c[0] as Record<string, unknown>
    );
    expect(sent.some((m) => m.type === "POPUP_API_SUBMIT_LOGIC" && m.patternId === "11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(sent.some((m) => typeof m.type === "string" && m.type.startsWith("POPUP_COMMUNITY"))).toBe(false);
  });

  it("opens Settings behind the profile menu and returns with the back button", async () => {
    await setupPopupHarness();
    (document.getElementById("profile-avatar-btn") as HTMLButtonElement).click();
    expect((document.getElementById("profile-popover") as HTMLElement).hidden).toBe(false);
    (document.getElementById("profile-goto-settings-btn") as HTMLButtonElement).click();
    await flushAsync();
    expect((document.getElementById("tab-settings") as HTMLElement).hidden).toBe(false);
    expect((document.getElementById("settings-page-profile") as HTMLElement).hidden).toBe(false);
    expect(document.getElementById("app")?.classList.contains("settings-view-open")).toBe(true);
    (document.getElementById("settings-back-btn") as HTMLButtonElement).click();
    expect((document.getElementById("tab-protection") as HTMLElement).hidden).toBe(false);
    expect((document.getElementById("tab-settings") as HTMLElement).hidden).toBe(true);
    expect(document.getElementById("app")?.classList.contains("settings-view-open")).toBe(false);
  });

  it("switches Paste Shield mode from Protection Quick Tools through the same settings path", async () => {
    const { localStore } = await setupPopupHarness();
    expect(
      (document.getElementById("paste-mode-this-tab-btn") as HTMLButtonElement).getAttribute("aria-pressed")
    ).toBe("true");
    (document.getElementById("paste-mode-off-btn") as HTMLButtonElement).click();
    await flushAsync();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const saved = localStore.settings as { protectionMode?: string } | undefined;
    expect(saved?.protectionMode).toBe("off");
    expect((document.getElementById("paste-mode-off-btn") as HTMLButtonElement).getAttribute("aria-pressed")).toBe(
      "true"
    );
  });
});

describe("Mockup Layout Iteration (7 settings cards, hero, banner, tool tiles)", () => {
  it("has exactly seven settings cards with Detection folded into Protection Settings", () => {
    for (const [name, html] of [
      ["index.html", popupHtml],
      ["sidepanel.html", sidepanelHtml],
    ] as const) {
      expect(html, `${name} still has a Detection nav`).not.toContain('id="settings-nav-detection"');
      expect(html, `${name} still has a Detection page`).not.toContain('id="settings-page-detection"');
      const navBtns = [...html.matchAll(/id="settings-nav-[a-z]+"/g)].map((m) => m[0]);
      expect(navBtns, `${name} settings nav buttons`).toEqual([
        'id="settings-nav-profile"',
        'id="settings-nav-protection"',
        'id="settings-nav-appearance"',
        'id="settings-nav-notifications"',
        'id="settings-nav-privacy"',
        'id="settings-nav-advanced"',
        'id="settings-nav-about"',
      ]);
      // Every Detection control survived the fold, inside the Protection page.
      expect(html).toContain('id="preset-select"');
      expect(html).toContain('id="category-list"');
      expect(html).toContain('id="auto-mask-single-names-toggle"');
      expect(html).toContain('id="medical-dictionary-toggle"');
      expect(html).toContain('id="threshold-apply-all-btn"');
      expect(html).toContain('id="mask-color-select"');
      expect(html).toContain('id="settings-nav-pair-btn"');
      expect(html).toContain('id="settings-pair-now-btn"');
      expect(html).toContain('data-i18n="settings_subtitle"');
    }
    expect(popupTs).toContain('document.getElementById("settings-nav-pair-btn")');
    expect(popupTs).toContain('document.getElementById("settings-pair-now-btn")');
  });

  it("adds the Protection hero, Scan Complete banner, three tool tiles, and footer", () => {
    for (const [name, html] of [
      ["index.html", popupHtml],
      ["sidepanel.html", sidepanelHtml],
    ] as const) {
      expect(html, `${name} missing hero`).toContain('class="protection-hero"');
      expect(html, `${name} missing banner`).toContain('id="scan-result-banner"');
      expect(html, `${name} missing banner details button`).toContain('id="scan-banner-details-btn"');
      expect(html, `${name} missing Paste Shield tile`).toContain('id="tool-tile-paste-shield"');
      expect(html, `${name} missing Page Masking tile`).toContain('id="tool-tile-page-masking"');
      expect(html, `${name} missing More Tools tile`).toContain('id="tool-tile-more-tools"');
      // Exactly three tiles, and no Document Redaction tile in Protection
      // (the Document tab is its only home).
      const tiles = [...html.matchAll(/id="tool-tile-(?:paste-shield|page-masking|more-tools)"/g)].map((m) => m[0]);
      expect(tiles, `${name} tool tiles`).toEqual([
        'id="tool-tile-paste-shield"',
        'id="tool-tile-page-masking"',
        'id="tool-tile-more-tools"',
      ]);
      expect(html, `${name} missing protection footer`).toContain('id="protection-footer-learn-more"');
      expect(html, `${name} missing avatar chevron`).toContain('class="profile-avatar-chevron"');
    }
    // Page Masking is a jump tile: it scrolls to the findings and focuses
    // Apply Masks, and there is still exactly one Apply Masks button.
    expect(popupTs).toContain('document.getElementById("tool-tile-page-masking")');
    expect((popupHtml.match(/id="apply-masks-btn"/g) || []).length).toBe(1);
    // The banner renders only for a real scan (see renderState).
    expect(popupTs).toMatch(/showBanner = state\.scanned && !state\.error && state\.visibleChars > 0/);
  });

  it("adds the Document Tools card without Apply Masks / Block Sensitive Data rows", () => {
    for (const [name, html] of [
      ["index.html", popupHtml],
      ["sidepanel.html", sidepanelHtml],
    ] as const) {
      expect(html, `${name} missing doc tools card`).toContain('class="doc-tools-card"');
      expect(html, `${name} missing Choose File`).toContain('id="doc-choose-file-btn"');
      expect(html, `${name} missing doc footer`).toContain('data-i18n="doc_footer_note"');
      expect(html, `${name} renders a Block Sensitive Data row`).not.toMatch(/>Block Sensitive Data</);
      // Scoped to the Document tab: the legitimate Apply Masks button lives
      // in Protection (Scan Findings), not here.
      const docTab = html.slice(html.indexOf('id="tab-document"'), html.indexOf('id="tab-settings"'));
      expect(docTab, `${name} renders an Apply Masks row in Document`).not.toMatch(/>Apply Masks</);
    }
    // Redact Document and Open Full-Screen Review still exist exactly once,
    // now grouped in the card; Print stays gated on a verified redaction.
    expect((popupHtml.match(/id="doc-redact-btn"/g) || []).length).toBe(1);
    expect((popupHtml.match(/id="doc-open-review-btn"/g) || []).length).toBe(1);
    expect((popupHtml.match(/id="doc-print-btn"/g) || []).length).toBe(1);
    expect(popupTs).toContain('document.getElementById("doc-choose-file-btn")');
  });

  it("fixes F1: a fresh document-state restore lands on the Document tab", () => {
    const branch = popupTs.slice(popupTs.indexOf('message.type === "POPUP_DOC_STATE"'));
    expect(branch).toContain("const isFreshRestore = lastDoc === null;");
    expect(branch).toContain('if (isFreshRestore) switchTab("document");');
  });

  it("fixes F2: Contributions no longer claims rule sharing is disabled", () => {
    for (const [name, html] of [
      ["index.html", popupHtml],
      ["sidepanel.html", sidepanelHtml],
    ] as const) {
      expect(html, `${name} still claims sharing is disabled`).not.toContain("rule sharing is disabled");
      expect(html, `${name} still claims there is no server`).not.toContain("there is no server to send it to");
      expect(html, `${name} missing corrected Contributions copy`).toContain(
        "Sharing a rule is separate and opt-in"
      );
    }
  });
});
