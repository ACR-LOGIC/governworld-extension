// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../src/service-worker/index.js", () => ({
  dispatchExtensionNotification: vi.fn(async () => undefined),
}));
import { detectBrowserFamily } from "../src/shared/browserFamily.js";
import {
  buildStrictTelemetryPayload,
  buildUninstallSignalUrl,
  classifyExtensionLifecycleState,
  validateStrictTelemetryPayload,
} from "../src/shared/telemetrySandbox.js";
import {
  buildDuplicateBrowserConflictMessage,
  computeDeviceActivationHash,
  computeUserEmailHash,
  enterLapsedSubscriptionContinuity,
  evaluateLocalBrowserSeatBinding,
  unlinkAndResetToDefaults,
} from "../src/shared/multiBrowserLicensing.js";
import {
  loadLocalLifecycleState,
  recordCleanShutdown,
  sendHeartbeatStatusCheck,
  syncUninstallHook,
  ALARM_NAME_HEARTBEAT,
} from "../src/service-worker/heartbeatService.js";
import {
  loadManagementEnrollment,
  saveAppliedManagedPolicy,
  saveManagementEnrollment,
  type ManagedPolicyEnvelope,
} from "../src/shared/managedPolicy.js";
import { parseEnterprisePolicy } from "../src/shared/enterprisePolicy.js";
import { applySettingsWithPolicy, validateSettingMutation } from "../src/shared/policyOwnership.js";
import { DEFAULT_SETTINGS, SETTINGS_KEY } from "../src/shared/settings.js";
import { CURRENT_EXTENSION_VERSION } from "../src/api/config.js";

const extRoot = process.cwd();

describe("Telemetry Isolation, Health Lifecycle & Multi-Browser Licensing", () => {
  let localStore: Record<string, unknown> = {};
  let alarmsStore: Record<string, { periodInMinutes?: number; delayInMinutes?: number }> = {};
  let uninstallUrl = "";
  let fetchMock = vi.fn();

  beforeEach(() => {
    localStore = {};
    alarmsStore = {};
    uninstallUrl = "";
    fetchMock = vi.fn();

    const chromeMock = {
      storage: {
        local: {
          get: vi.fn(async (keys?: string | string[] | null) => {
            if (keys == null) return { ...localStore };
            if (typeof keys === "string") return keys in localStore ? { [keys]: localStore[keys] } : {};
            if (Array.isArray(keys)) {
              const out: Record<string, unknown> = {};
              for (const k of keys) if (k in localStore) out[k] = localStore[k];
              return out;
            }
            return {};
          }),
          set: vi.fn(async (items: Record<string, unknown>) => {
            Object.assign(localStore, items);
          }),
          remove: vi.fn(async (keys: string | string[]) => {
            for (const k of Array.isArray(keys) ? keys : [keys]) delete localStore[k];
          }),
        },
        session: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined),
          remove: vi.fn(async () => undefined),
        },
        managed: {
          get: vi.fn(async () => ({})),
        },
      },
      alarms: {
        get: vi.fn(async (name: string) => alarmsStore[name] ?? null),
        create: vi.fn((name: string, info: { periodInMinutes?: number; delayInMinutes?: number }) => {
          alarmsStore[name] = info;
        }),
        clear: vi.fn(async (name: string) => {
          delete alarmsStore[name];
          return true;
        }),
      },
      runtime: {
        id: "test-ext-id",
        getManifest: () => ({ version: CURRENT_EXTENSION_VERSION }),
        getURL: vi.fn((path: string) => `chrome-extension://test-ext-id/${path}`),
        sendMessage: vi.fn(async () => undefined),
        setUninstallURL: vi.fn(async (url: string) => {
          uninstallUrl = url;
        }),
        onMessage: { addListener: vi.fn() },
      },
      tabs: {
        query: vi.fn(async () => [{ id: 1, url: "https://example.test/", active: true }]),
        create: vi.fn(async () => ({ id: 2 })),
      },
      windows: {
        getCurrent: vi.fn(async () => ({ id: 1 })),
      },
      permissions: {
        contains: vi.fn(async () => false),
        request: vi.fn(async () => false),
      },
    };

    Object.defineProperty(globalThis, "chrome", { value: chromeMock, configurable: true, writable: true });
    Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true, writable: true });
  });

  describe("1. Strict Telemetry Sandbox Isolation & Schema", () => {
    it("isolates telemetrySandbox.ts and telemetryWorker.ts from DOM, content, OCR, and storage payload modules", () => {
      const sandboxSrc = readFileSync(join(extRoot, "src/shared/telemetrySandbox.ts"), "utf8");
      const workerSrc = readFileSync(join(extRoot, "src/service-worker/telemetryWorker.ts"), "utf8");

      for (const src of [sandboxSrc, workerSrc]) {
        expect(src).not.toMatch(/from\s+["']\..*(content|document-pipeline|offscreen|docDb|docStore|audit|settings)/);
        expect(src).not.toMatch(/\b(document\.|window\.|chrome\.storage|indexedDB)\b/);
      }
      expect(workerSrc).toContain("telemetrySandbox.js");
    });

    it("enforces closed schema enums and rejects dynamic keys, free-text strings, or sensitive payload fields", () => {
      const valid = buildStrictTelemetryPayload({
        schema_version: "2.0",
        event_kind: "heartbeat",
        lifecycle_state: "online",
        device_id: "dev_uuid_1234",
        organization_id: "org_acme_01",
        browser_family: "chrome",
        extension_version: "0.5.0",
        policy_version: 3,
        policy_status: "compliant",
        health_status: "healthy",
        clean_shutdown_flag: false,
        timestamp: "2026-11-28T10:00:00Z",
      });
      expect(Object.isFrozen(valid)).toBe(true);

      const withDynamicKey = validateStrictTelemetryPayload({
        ...valid,
        visitedUrl: "https://ehr.internal/patient/42",
      });
      expect(withDynamicKey.ok).toBe(false);

      const withFreeText = validateStrictTelemetryPayload({
        ...valid,
        health_status: "Patient John Doe SSN 123-45-6789",
      });
      expect(withFreeText.ok).toBe(false);

      const withPlaintextEmail = validateStrictTelemetryPayload({
        ...valid,
        user_email_hash: "alice@example.com",
      });
      expect(withPlaintextEmail.ok).toBe(false);
    });
  });

  describe("2. Online / Offline (Clean Shutdown) / Uninstalled Lifecycle Detection", () => {
    it("distinguishes Online, Offline (Clean Shutdown), and Uninstalled/Terminated states deterministically", () => {
      const t0 = Date.parse("2026-11-28T10:00:00Z");

      // Active heartbeat within grace window -> online
      expect(
        classifyExtensionLifecycleState({
          lastHeartbeatAtMs: t0 - 5 * 60_000,
          lastCleanShutdownAtMs: t0 - 60 * 60_000,
          cleanShutdownFlag: false,
          uninstalledAtMs: null,
          nowMs: t0,
        }),
      ).toBe("online");

      // Browser closed cleanly after last heartbeat -> offline_clean_shutdown (even past grace window)
      expect(
        classifyExtensionLifecycleState({
          lastHeartbeatAtMs: t0 - 120 * 60_000,
          lastCleanShutdownAtMs: t0 - 119 * 60_000,
          cleanShutdownFlag: true,
          uninstalledAtMs: null,
          nowMs: t0,
        }),
      ).toBe("offline_clean_shutdown");

      // Heartbeat stopped past grace window without clean shutdown -> uninstalled_or_terminated
      expect(
        classifyExtensionLifecycleState({
          lastHeartbeatAtMs: t0 - 45 * 60_000,
          lastCleanShutdownAtMs: null,
          cleanShutdownFlag: false,
          uninstalledAtMs: null,
          nowMs: t0,
        }),
      ).toBe("uninstalled_or_terminated");

      // Explicit uninstall hook fired -> uninstalled_or_terminated immediately
      expect(
        classifyExtensionLifecycleState({
          lastHeartbeatAtMs: t0 - 10_000,
          lastCleanShutdownAtMs: t0 - 5_000,
          cleanShutdownFlag: true,
          uninstalledAtMs: t0 - 1_000,
          nowMs: t0,
        }),
      ).toBe("uninstalled_or_terminated");
    });

    it("records clean-shutdown locally, emits clean_shutdown in MANAGE mode, and registers zero-PII uninstall URL", async () => {
      // LOCAL mode: uninstall URL must stay empty and zero network egress on shutdown
      await syncUninstallHook();
      expect(uninstallUrl).toBe("");
      await recordCleanShutdown();
      expect(fetchMock).not.toHaveBeenCalled();

      // MANAGE mode: registers uninstall URL and sends validated clean_shutdown signal
      await saveManagementEnrollment({
        organization_id: "11111111-1111-4111-8111-111111111111",
        employee_id: "seat-1",
        user_email_hash: "a".repeat(64),
        browser_family: "edge",
        device_activation_hash: "b".repeat(64),
        device_id: "22222222-2222-4222-8222-222222222222",
        coordinator_url: "https://coord.governworld.test",
        enrolled_at: "2026-11-28T09:00:00Z",
        management_mode: "MANAGE",
      });

      await syncUninstallHook();
      expect(uninstallUrl).toContain("https://coord.governworld.test/api/v1/management/uninstall");
      expect(uninstallUrl).toContain("event=uninstall");
      expect(uninstallUrl).toContain("browser=edge");
      expect(uninstallUrl).not.toContain("@");

      fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) });
      await recordCleanShutdown();

      const lifecycle = await loadLocalLifecycleState();
      expect(lifecycle.clean_shutdown).toBe(true);
      expect(lifecycle.state).toBe("offline_clean_shutdown");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(sentBody.event_kind).toBe("clean_shutdown");
      expect(sentBody.lifecycle_state).toBe("offline_clean_shutdown");
      expect(sentBody.clean_shutdown_flag).toBe(true);
    });
  });

  describe("3. Multi-Browser Single-Seat Licensing & Anti-Sharing Conflict Resolution", () => {
    it("reliably detects browser family from userAgentData brands and UA fallbacks", () => {
      expect(
        detectBrowserFamily({
          userAgentData: { brands: [{ brand: "Chromium", version: "130" }, { brand: "Microsoft Edge", version: "130.0.1" }] },
        }).family,
      ).toBe("edge");
      expect(
        detectBrowserFamily({
          userAgentData: { brands: [{ brand: "Google Chrome", version: "131" }] },
        }).family,
      ).toBe("chrome");
      expect(detectBrowserFamily({ userAgent: "Mozilla/5.0 Gecko/20100101 Firefox/128.0" }).family).toBe("firefox");
      expect(
        detectBrowserFamily({ userAgent: "Mozilla/5.0 Version/17.4 Safari/605.1.15" }).family,
      ).toBe("safari");
    });

    it("enforces 1 user = 1 seat across distinct browsers and blocks duplicate browser instances until confirmed", async () => {
      const emailHash = await computeUserEmailHash("org-acme", "Alice@Acme.com");
      const chromeHash = await computeDeviceActivationHash(emailHash, "chrome", "inst-chrome-1");
      const edgeHash = await computeDeviceActivationHash(emailHash, "edge", "inst-edge-1");
      const chromeDupHash = await computeDeviceActivationHash(emailHash, "chrome", "inst-chrome-2");

      // 1. Pair Chrome -> 1 seat used
      const r1 = evaluateLocalBrowserSeatBinding({
        existingRecords: [],
        user_email_hash: emailHash,
        browser_family: "chrome",
        installation_id: "inst-chrome-1",
        device_activation_hash: chromeHash,
      });
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      expect(r1.seat_count_used).toBe(1);

      // 2. Pair Edge for same user -> still 1 seat!
      const r2 = evaluateLocalBrowserSeatBinding({
        existingRecords: r1.records,
        user_email_hash: emailHash,
        browser_family: "edge",
        installation_id: "inst-edge-1",
        device_activation_hash: edgeHash,
      });
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      expect(r2.seat_count_used).toBe(1);
      expect(r2.seat_id).toBe(r1.seat_id);

      // 3. Pair second Chrome -> blocked with exact conflict prompt; existing untouched
      const r3 = evaluateLocalBrowserSeatBinding({
        existingRecords: r2.records,
        user_email_hash: emailHash,
        browser_family: "chrome",
        installation_id: "inst-chrome-2",
        device_activation_hash: chromeDupHash,
        confirm_replace: false,
      });
      expect(r3.ok).toBe(false);
      if (r3.ok) return;
      expect(r3.conflict.code).toBe("DUPLICATE_BROWSER_CONFLICT");
      expect(r3.conflict.message).toBe(
        "This account is already associated with an active Chrome extension. Do you want to unpair and reset the previous instance to default, or cancel?",
      );

      // 4. Confirm replacement -> replaces previous Chrome instance while preserving Edge + 1 seat
      const r4 = evaluateLocalBrowserSeatBinding({
        existingRecords: r2.records,
        user_email_hash: emailHash,
        browser_family: "chrome",
        installation_id: "inst-chrome-2",
        device_activation_hash: chromeDupHash,
        confirm_replace: true,
      });
      expect(r4.ok).toBe(true);
      if (!r4.ok) return;
      expect(r4.replaced_instance_id).toBe("inst-chrome-1");
      expect(r4.seat_count_used).toBe(1);
      expect(r4.records.filter((r) => r.status === "active").map((r) => r.installation_id)).toEqual([
        "inst-edge-1",
        "inst-chrome-2",
      ]);
    });

    it("unlinks and resets previous instance to factory defaults on replacement (410) or voluntary unpair", async () => {
      await saveManagementEnrollment({
        organization_id: "org_acme_01",
        employee_id: "emp-1",
        device_id: "dev_uuid_9999",
        coordinator_url: "https://coord.governworld.test",
        enrolled_at: "2026-11-28T09:00:00Z",
        management_mode: "MANAGE",
      });
      localStore[SETTINGS_KEY] = { ...DEFAULT_SETTINGS, protectionMode: "always-on", pasteGuardEnabled: true };

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 410,
        json: async () => ({ ok: false, status: "replaced_by_repairing" }),
      });

      const hb = await sendHeartbeatStatusCheck();
      expect(hb.status).toBe("unpaired_reset");
      expect(hb.mode).toBe("LOCAL");
      expect(await loadManagementEnrollment()).toBeNull();
      expect((localStore[SETTINGS_KEY] as { protectionMode: string }).protectionMode).toBe(
        DEFAULT_SETTINGS.protectionMode,
      );
      expect(uninstallUrl).toBe("");
    });
  });

  describe("4. Lapsed Subscription Fail-Closed Continuity", () => {
    it("ceases cloud heartbeats and sync on lapsed subscription (402) without unlinking or resetting locked policy", async () => {
      await saveManagementEnrollment({
        organization_id: "org_acme_01",
        employee_id: "emp-1",
        device_id: "dev_uuid_8888",
        coordinator_url: "https://coord.governworld.test",
        enrolled_at: "2026-11-28T09:00:00Z",
        management_mode: "MANAGE",
      });
      const policyEnv: Partial<ManagedPolicyEnvelope> = {
        policy_id: "pol-1",
        organization_id: "org_acme_01",
        policy_version: 5,
      };
      await saveAppliedManagedPolicy(policyEnv as ManagedPolicyEnvelope);
      alarmsStore[ALARM_NAME_HEARTBEAT] = { periodInMinutes: 15 };

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 402,
        json: async () => ({ ok: false, status: "subscription_lapsed" }),
      });

      const hb1 = await sendHeartbeatStatusCheck();
      expect(hb1.status).toBe("lapsed_continuity");
      expect(hb1.sent).toBe(false);

      // Enrollment and applied managed policy remain preserved; alarm and uninstall hook cleared
      const enrollment = await loadManagementEnrollment();
      expect(enrollment?.management_mode).toBe("MANAGE");
      expect(enrollment?.subscription_lapsed).toBe(true);
      expect(localStore["gw_applied_managed_policy"]).toBeDefined();
      expect(alarmsStore[ALARM_NAME_HEARTBEAT]).toBeUndefined();
      expect(uninstallUrl).toBe("");

      // Subsequent heartbeat and policy sync make ZERO network requests while retaining local continuity
      fetchMock.mockClear();
      const hb2 = await sendHeartbeatStatusCheck();
      expect(hb2.status).toBe("lapsed_continuity");
      const { syncManagedPolicy } = await import("../src/service-worker/policySyncService.js");
      const syncRes = await syncManagedPolicy(true);
      expect(syncRes.status).toBe("offline_continuity");
      expect(fetchMock).not.toHaveBeenCalled();

      // Calling enterLapsedSubscriptionContinuity directly is idempotent
      await enterLapsedSubscriptionContinuity();
      expect((await loadManagementEnrollment())?.subscription_lapsed).toBe(true);
    });
  });

  describe("5. Pair-Lock & Separate Per-Feature 'Unlock for User'", () => {
    it("locks all admin features automatically upon pairing and unlocks ONLY explicitly delegated features", () => {
      // Paired default: all admin features locked
      const lockedPolicy = parseEnterprisePolicy({
        protectionMode: "always-on",
        userCanDisable: false,
        enforcedCategories: ["ssn", "email"],
        defaultRedactionStyle: "blackout",
      });

      const modeAttempt = validateSettingMutation("protectionMode", "off", DEFAULT_SETTINGS, lockedPolicy);
      expect(modeAttempt.allowed).toBe(false);

      const styleAttempt = validateSettingMutation("defaultRedactionStyle", "whiteout", DEFAULT_SETTINGS, lockedPolicy);
      expect(styleAttempt.allowed).toBe(false);

      // Admin triggers separate "Unlock for User" on defaultRedactionStyle ONLY
      const delegatedPolicy = parseEnterprisePolicy({
        protectionMode: "always-on",
        userCanDisable: false,
        enforcedCategories: ["ssn", "email"],
        defaultRedactionStyle: "blackout",
        unlockedFeatures: ["defaultRedactionStyle"],
      });

      const unlockedStyle = validateSettingMutation("defaultRedactionStyle", "whiteout", DEFAULT_SETTINGS, delegatedPolicy);
      expect(unlockedStyle.allowed).toBe(true);
      expect(unlockedStyle.effectiveValue).toBe("whiteout");

      // Other admin features remain strictly locked
      const stillLockedMode = validateSettingMutation("protectionMode", "off", DEFAULT_SETTINGS, delegatedPolicy);
      expect(stillLockedMode.allowed).toBe(false);

      const applied = applySettingsWithPolicy(
        DEFAULT_SETTINGS,
        { defaultRedactionStyle: "whiteout", protectionMode: "off" },
        delegatedPolicy,
      );
      expect(applied.settings.defaultRedactionStyle).toBe("whiteout");
      expect(applied.settings.protectionMode).toBe("always-on");
    });
  });

  describe("6. Frontend UI Conflict Dialog & Diagnostics", () => {
    it("displays browser-specific duplicate conflict dialog on HTTP 409 and handles cancel vs confirm replacement", async () => {
      const popupHtml = readFileSync(join(extRoot, "src/popup/index.html"), "utf8");
      const parsed = new DOMParser().parseFromString(popupHtml, "text/html");
      parsed.querySelectorAll("script, link").forEach((el) => el.remove());
      document.documentElement.innerHTML = parsed.documentElement.innerHTML;
      delete document.documentElement.dataset.gwReady;

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

      const configMod = await import("../src/api/config.js");
      vi.spyOn(configMod, "isTrustedPolicyPublicKeyConfigured").mockReturnValue(true);

      localStore["gw_coordinator_url"] = "https://coord.governworld.test";
      localStore["gw_installation_id"] = "33333333-3333-4333-8333-333333333333";
      fetchMock
        .mockResolvedValueOnce({
          ok: false,
          status: 409,
          json: async () => ({
            code: "DUPLICATE_BROWSER_CONFLICT",
            browser_family: "chrome",
            message: buildDuplicateBrowserConflictMessage("chrome"),
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            organizationId: "org_acme_01",
            organizationName: "Acme Health",
            employeeId: "emp-1",
            policy: { protectionMode: "always-on", userCanDisable: false, enforcedCategories: ["ssn"] },
          }),
        });

      const popupMod = await import("../src/popup/popup.js");
      await popupMod.initPopup();

      expect(document.getElementById("office-browser-binding")?.textContent).toContain("Host:");
      expect(document.getElementById("diag-telemetry-isolation-value")?.textContent).toContain("Strict Fixed Schema");
      expect(document.getElementById("diag-heartbeat-value")?.textContent).toContain("Inactive (Local Only)");

      const emailInput = document.getElementById("office-pairing-email-input") as HTMLInputElement;
      const codeInput = document.getElementById("office-pairing-input") as HTMLInputElement;
      emailInput.value = "alice@acme.test";
      codeInput.value = "12345678";

      (document.getElementById("office-pair-btn") as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 20));

      // Pre-pairing consent warning dialog must appear before any network request fires
      const consentDialog = document.getElementById("pairing-consent-dialog") as HTMLDialogElement;
      expect(consentDialog.open).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();

      (document.getElementById("pairing-consent-confirm") as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 20));
      expect(consentDialog.open).toBe(false);

      const conflictDialog = document.getElementById("pairing-conflict-dialog") as HTMLDialogElement;
      expect(conflictDialog.open).toBe(true);
      expect(document.getElementById("pairing-conflict-desc")?.textContent).toContain(
        "Do you want to unpair and reset the previous instance to default, or cancel?",
      );

      // Confirm replacement -> closes dialog, retries with confirm_replace: true, and activates admin lock
      (document.getElementById("pairing-conflict-confirm") as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 20));

      expect(conflictDialog.open).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const retryBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
      expect(retryBody.confirm_replace).toBe(true);
      expect(retryBody.user_email_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(retryBody.device_activation_hash).toMatch(/^[0-9a-f]{64}$/);
      expect((document.getElementById("office-admin-lock-notice") as HTMLElement).hidden).toBe(false);
      expect((document.getElementById("office-manager-form") as HTMLElement).hidden).toBe(true);
      expect(document.getElementById("office-unpair-btn")).toBeNull();

      // Ensure helper buildUninstallSignalUrl returns null for insecure HTTP
      expect(
        buildUninstallSignalUrl("http://insecure.example.com", {
          organizationId: "org_1",
          deviceId: "dev_1234",
          browserFamily: "chrome",
        }),
      ).toBeNull();
      await unlinkAndResetToDefaults();
    });
  });
});
