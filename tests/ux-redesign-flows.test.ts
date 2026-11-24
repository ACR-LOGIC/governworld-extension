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
      expect(html, `${name} missing #profile-goto-protection-btn`).toContain('id="profile-goto-protection-btn"');
      expect(html, `${name} missing #profile-goto-appearance-btn`).toContain('id="profile-goto-appearance-btn"');
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
      for (const page of ["profile", "protection", "detection", "appearance", "notifications", "privacy", "advanced", "about"]) {
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

  it("aggregates real audit telemetry in Review, navigates Coverage Details, and clears audit keys", async () => {
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
    (document.getElementById("open-wizard-btn") as HTMLButtonElement).click();
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

    (document.getElementById("open-doc-btn") as HTMLButtonElement).click();
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

    // 1. All 4 tab how-to instruction cards exist
    expect(document.getElementById("protection-howto-card")).toBeTruthy();
    expect(document.getElementById("doc-howto-card")).toBeTruthy();
    expect(document.getElementById("logic-howto-card")).toBeTruthy();
    expect(document.getElementById("review-howto-card")).toBeTruthy();

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
    (document.getElementById("open-wizard-btn") as HTMLButtonElement).click();
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
