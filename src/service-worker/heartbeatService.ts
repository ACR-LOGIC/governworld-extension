// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
/**
 * Lightweight Heartbeat, Clean-Shutdown Lifecycle, and Uninstall Signal Service for MANAGE mode.
 *
 * Requirements:
 * - Standalone LOCAL Mode: STRICTLY INACTIVE. Zero network requests, zero timers, zero uninstall hook.
 * - Managed Mode (Post-Pairing ONLY): Sends schema-validated status checks via the isolated
 *   telemetry schema (`telemetrySandbox.ts`), records clean-shutdown flags on browser exit/suspend,
 *   and registers a zero-PII uninstall callback.
 * - Lapsed Subscription Continuity: Ceases cloud heartbeats/sync while keeping managed policies
 *   locked locally (never unlinks or resets on non-payment).
 * - Zero Employee Surveillance: Absolutely NO browsing history, visited URLs, search queries,
 *   page text, DOM elements, credentials, emails, or personal files.
 */

import {
  loadManagementEnrollment,
  loadLastAppliedManagedPolicy,
} from "../shared/managedPolicy.js";
import { loadEnterprisePolicy } from "../shared/enterprisePolicy.js";
import { getInstallationId, CURRENT_EXTENSION_VERSION, validateApiUrl } from "../api/config.js";
import { detectBrowserFamily, type BrowserFamily } from "../shared/browserFamily.js";
import {
  buildStrictTelemetryPayload,
  buildUninstallSignalUrl,
  type ExtensionLifecycleState,
  type StrictTelemetryPayload,
  type TelemetryEventKind,
} from "../shared/telemetrySandbox.js";
import {
  enterLapsedSubscriptionContinuity,
  STORAGE_KEY_LIFECYCLE_STATE,
  unlinkAndResetToDefaults,
} from "../shared/multiBrowserLicensing.js";

export const ALARM_NAME_HEARTBEAT = "gw_management_heartbeat";
export const HEARTBEAT_INTERVAL_MINUTES = 15;

export interface HeartbeatBrowserInfo {
  name: string;
  version: string;
  platform: string;
  family?: BrowserFamily;
}

export interface HeartbeatPayload {
  schema_version?: "2.0";
  event_kind?: TelemetryEventKind;
  lifecycle_state?: ExtensionLifecycleState;
  device_id: string;
  organization_id: string;
  employee_id?: string;
  seat_id?: string;
  user_email_hash?: string;
  device_activation_hash?: string;
  browser_family?: BrowserFamily;
  browser_info: HeartbeatBrowserInfo;
  extension_version: string;
  policy_version: number;
  policy_hash?: string;
  policy_status: "compliant" | "out-of-date" | "healthy" | "locked_lapsed";
  health_status?: "healthy" | "active" | "degraded" | "offline_clean";
  clean_shutdown_flag?: boolean;
  last_clean_shutdown_at?: string;
  timestamp: string;
  status: "active" | "healthy";
}

export interface HeartbeatResult {
  mode: "LOCAL" | "MANAGE";
  sent: boolean;
  status: "idle" | "sent" | "offline" | "lapsed_continuity" | "unpaired_reset" | "error";
  error?: string;
  payload?: HeartbeatPayload;
  strictPayload?: Readonly<StrictTelemetryPayload>;
}

export interface LocalLifecycleRecord {
  state: ExtensionLifecycleState | "local_idle";
  clean_shutdown: boolean;
  last_active_at: string | null;
  clean_shutdown_at: string | null;
  last_heartbeat_at: string | null;
  last_heartbeat_status: string;
  browser_family: BrowserFamily;
}

/**
 * Extracts sanitized browser metadata without capturing any sensitive or user-specific data.
 */
export function getBrowserInfo(): HeartbeatBrowserInfo {
  const detected = detectBrowserFamily();
  const platform = typeof navigator !== "undefined" ? navigator.platform || "unknown" : "unknown";
  return {
    name: detected.displayName === "Browser" ? "Chromium" : detected.displayName,
    version: detected.version,
    platform,
    family: detected.family,
  };
}

export async function loadLocalLifecycleState(): Promise<LocalLifecycleRecord> {
  const detected = detectBrowserFamily();
  const fallback: LocalLifecycleRecord = {
    state: "local_idle",
    clean_shutdown: false,
    last_active_at: null,
    clean_shutdown_at: null,
    last_heartbeat_at: null,
    last_heartbeat_status: "idle",
    browser_family: detected.family,
  };

  if (typeof chrome === "undefined" || !chrome.storage?.local) {
    return fallback;
  }

  try {
    const res = await chrome.storage.local.get(STORAGE_KEY_LIFECYCLE_STATE);
    // eslint-disable-next-line security/detect-object-injection
    const raw = res[STORAGE_KEY_LIFECYCLE_STATE] as Partial<LocalLifecycleRecord> | undefined;
    if (!raw || typeof raw !== "object") return fallback;
    return {
      state: raw.state ?? fallback.state,
      clean_shutdown: raw.clean_shutdown === true,
      last_active_at: typeof raw.last_active_at === "string" ? raw.last_active_at : null,
      clean_shutdown_at: typeof raw.clean_shutdown_at === "string" ? raw.clean_shutdown_at : null,
      last_heartbeat_at: typeof raw.last_heartbeat_at === "string" ? raw.last_heartbeat_at : null,
      last_heartbeat_status:
        typeof raw.last_heartbeat_status === "string" ? raw.last_heartbeat_status : fallback.last_heartbeat_status,
      browser_family: raw.browser_family ?? detected.family,
    };
  } catch {
    return fallback;
  }
}

async function saveLocalLifecycleState(record: LocalLifecycleRecord): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  try {
    await chrome.storage.local.set({ [STORAGE_KEY_LIFECYCLE_STATE]: record });
  } catch {
    // Ignore storage write error
  }
}

/**
 * Registers or clears the browser uninstall hook (`chrome.runtime.setUninstallURL`).
 * Active ONLY in MANAGE mode with an active (non-lapsed) subscription and valid HTTPS coordinator.
 */
export async function syncUninstallHook(): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.runtime?.setUninstallURL) {
    return;
  }

  try {
    const enrollment = await loadManagementEnrollment();
    if (
      !enrollment ||
      enrollment.management_mode !== "MANAGE" ||
      enrollment.subscription_lapsed === true ||
      !enrollment.coordinator_url
    ) {
      await chrome.runtime.setUninstallURL("");
      return;
    }

    const urlCheck = validateApiUrl(enrollment.coordinator_url);
    if (!urlCheck.valid || !urlCheck.normalizedUrl) {
      await chrome.runtime.setUninstallURL("");
      return;
    }

    const deviceId = enrollment.device_id || (await getInstallationId());
    const browserFamily = enrollment.browser_family ?? detectBrowserFamily().family;
    const uninstallUrl = buildUninstallSignalUrl(urlCheck.normalizedUrl, {
      organizationId: enrollment.organization_id,
      deviceId,
      browserFamily,
      ...(enrollment.device_activation_hash ? { activationHash: enrollment.device_activation_hash } : {}),
    });

    await chrome.runtime.setUninstallURL(uninstallUrl ?? "");
  } catch {
    // Never fail worker lifecycle if setUninstallURL is rejected in a test harness
  }
}

/**
 * Marks a clean browser/worker shutdown locally and emits a best-effort
 * schema-validated `clean_shutdown` telemetry signal in active MANAGE mode.
 */
export async function recordCleanShutdown(): Promise<void> {
  const nowIso = new Date().toISOString();
  const prev = await loadLocalLifecycleState();
  const enrollment = await loadManagementEnrollment();
  const browserFamily = enrollment?.browser_family ?? detectBrowserFamily().family;

  await saveLocalLifecycleState({
    ...prev,
    state: enrollment?.management_mode === "MANAGE" ? "offline_clean_shutdown" : "local_idle",
    clean_shutdown: true,
    clean_shutdown_at: nowIso,
    last_active_at: nowIso,
    last_heartbeat_status: "clean_shutdown",
    browser_family: browserFamily,
  });

  if (
    !enrollment ||
    enrollment.management_mode !== "MANAGE" ||
    enrollment.subscription_lapsed === true ||
    !enrollment.coordinator_url?.trim()
  ) {
    return;
  }

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return;
  }

  const urlCheck = validateApiUrl(enrollment.coordinator_url);
  if (!urlCheck.valid || !urlCheck.normalizedUrl) {
    return;
  }

  const lastApplied = await loadLastAppliedManagedPolicy();
  const enterprisePolicy = await loadEnterprisePolicy();
  const deviceId = enrollment.device_id || (await getInstallationId());
  const policyVersion = lastApplied?.policy_version || enterprisePolicy.policyVersion || 1;

  try {
    const strictPayload = buildStrictTelemetryPayload({
      schema_version: "2.0",
      event_kind: "clean_shutdown",
      lifecycle_state: "offline_clean_shutdown",
      device_id: deviceId,
      organization_id: enrollment.organization_id,
      ...(enrollment.seat_id ? { seat_id: enrollment.seat_id } : {}),
      ...(enrollment.user_email_hash ? { user_email_hash: enrollment.user_email_hash } : {}),
      ...(enrollment.device_activation_hash ? { device_activation_hash: enrollment.device_activation_hash } : {}),
      browser_family: browserFamily,
      extension_version: CURRENT_EXTENSION_VERSION,
      policy_version: policyVersion,
      ...(lastApplied?.policy_hash && /^[0-9a-f]{64}$/.test(lastApplied.policy_hash)
        ? { policy_hash: lastApplied.policy_hash }
        : {}),
      policy_status: enterprisePolicy.valid ? "compliant" : "out-of-date",
      health_status: "offline_clean",
      clean_shutdown_flag: true,
      last_clean_shutdown_at: nowIso,
      timestamp: nowIso,
    });

    const endpoint = `${urlCheck.normalizedUrl}/api/v1/management/heartbeat`;
    await fetch(endpoint, {
      method: "POST",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        "X-GovernWorld-Device-Id": deviceId,
      },
      body: JSON.stringify(strictPayload),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Best-effort keepalive notification; local clean_shutdown flag already persisted
  }
}

/**
 * Sends a lightweight heartbeat status check to the management coordinator.
 * Strictly checks enrollment: if not in MANAGE mode, returns immediately with ZERO network egress.
 * If subscription has lapsed, stops network egress while keeping managed policy locked locally.
 */
export async function sendHeartbeatStatusCheck(): Promise<HeartbeatResult> {
  const enrollment = await loadManagementEnrollment();

  // INVARIANT: In standalone LOCAL mode, NO heartbeat may ever be sent.
  if (!enrollment || enrollment.management_mode !== "MANAGE") {
    return { mode: "LOCAL", sent: false, status: "idle" };
  }

  // Lapsed subscription: fail-closed continuity without cloud heartbeats or resets.
  if (enrollment.subscription_lapsed === true) {
    await clearHeartbeatAlarm();
    return { mode: "MANAGE", sent: false, status: "lapsed_continuity" };
  }

  // If offline, do not attempt network fetch.
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { mode: "MANAGE", sent: false, status: "offline" };
  }

  const lastApplied = await loadLastAppliedManagedPolicy();
  const enterprisePolicy = await loadEnterprisePolicy();
  const deviceId = enrollment.device_id || (await getInstallationId());
  const policyVersion = lastApplied?.policy_version || enterprisePolicy.policyVersion || 1;
  const browserInfo = getBrowserInfo();
  const browserFamily = enrollment.browser_family ?? browserInfo.family ?? "unknown";
  const nowIso = new Date().toISOString();
  const priorLifecycle = await loadLocalLifecycleState();

  const strictPayload = buildStrictTelemetryPayload({
    schema_version: "2.0",
    event_kind: "heartbeat",
    lifecycle_state: "online",
    device_id: deviceId,
    organization_id: enrollment.organization_id,
    ...(enrollment.seat_id ? { seat_id: enrollment.seat_id } : {}),
    ...(enrollment.user_email_hash ? { user_email_hash: enrollment.user_email_hash } : {}),
    ...(enrollment.device_activation_hash ? { device_activation_hash: enrollment.device_activation_hash } : {}),
    browser_family: browserFamily,
    extension_version: CURRENT_EXTENSION_VERSION,
    policy_version: policyVersion,
    ...(lastApplied?.policy_hash && /^[0-9a-f]{64}$/.test(lastApplied.policy_hash)
      ? { policy_hash: lastApplied.policy_hash }
      : {}),
    policy_status: enterprisePolicy.valid ? "compliant" : "out-of-date",
    health_status: enterprisePolicy.valid ? "healthy" : "degraded",
    clean_shutdown_flag: priorLifecycle.clean_shutdown,
    ...(priorLifecycle.clean_shutdown_at ? { last_clean_shutdown_at: priorLifecycle.clean_shutdown_at } : {}),
    timestamp: nowIso,
  });

  const payload: HeartbeatPayload = {
    ...strictPayload,
    ...(enrollment.employee_id ? { employee_id: enrollment.employee_id } : {}),
    browser_info: browserInfo,
    policy_status: enterprisePolicy.valid ? "compliant" : "out-of-date",
    status: "healthy",
  };

  if (!enrollment.coordinator_url || !enrollment.coordinator_url.trim()) {
    return {
      mode: "MANAGE",
      sent: false,
      status: "idle",
      error: "Heartbeat disabled — coordinator not configured.",
      payload,
      strictPayload,
    };
  }

  const urlCheck = validateApiUrl(enrollment.coordinator_url);
  if (!urlCheck.valid || !urlCheck.normalizedUrl) {
    return {
      mode: "MANAGE",
      sent: false,
      status: "error",
      error: urlCheck.error ?? "Invalid coordinator URL",
      payload,
      strictPayload,
    };
  }
  const endpoint = `${urlCheck.normalizedUrl}/api/v1/management/heartbeat`;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GovernWorld-Device-Id": deviceId,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });

    if (res.status === 402) {
      await enterLapsedSubscriptionContinuity();
      return {
        mode: "MANAGE",
        sent: false,
        status: "lapsed_continuity",
        payload,
        strictPayload,
      };
    }

    if (res.status === 410) {
      await unlinkAndResetToDefaults();
      return {
        mode: "LOCAL",
        sent: false,
        status: "unpaired_reset",
      };
    }

    const bodyJson = (await res.json().catch(() => null)) as { status?: string } | null;
    if (bodyJson?.status === "subscription_lapsed") {
      await enterLapsedSubscriptionContinuity();
      return {
        mode: "MANAGE",
        sent: false,
        status: "lapsed_continuity",
        payload,
        strictPayload,
      };
    }
    if (bodyJson?.status === "replaced_by_repairing" || bodyJson?.status === "admin_unpaired") {
      await unlinkAndResetToDefaults();
      return {
        mode: "LOCAL",
        sent: false,
        status: "unpaired_reset",
      };
    }

    if (!res.ok) {
      return {
        mode: "MANAGE",
        sent: false,
        status: "error",
        error: `HTTP ${res.status}`,
        payload,
        strictPayload,
      };
    }

    await saveLocalLifecycleState({
      state: "online",
      clean_shutdown: false,
      last_active_at: nowIso,
      clean_shutdown_at: priorLifecycle.clean_shutdown_at,
      last_heartbeat_at: nowIso,
      last_heartbeat_status: "sent",
      browser_family: browserFamily,
    });

    return {
      mode: "MANAGE",
      sent: true,
      status: "sent",
      payload,
      strictPayload,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Heartbeat connection failed";
    return {
      mode: "MANAGE",
      sent: false,
      status: "error",
      error: message,
      payload,
      strictPayload,
    };
  }
}

/**
 * Configures or cancels the periodic heartbeat alarm depending on active management enrollment.
 */
export async function scheduleHeartbeatAlarm(): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.alarms) {
    return;
  }

  const enrollment = await loadManagementEnrollment();

  if (!enrollment || enrollment.management_mode !== "MANAGE" || enrollment.subscription_lapsed === true) {
    // Un-enrolled or lapsed continuity: ensure any existing heartbeat alarm is cleared.
    await clearHeartbeatAlarm();
    return;
  }

  // In MANAGE mode: ensure recurring alarm is active
  try {
    const existing = await chrome.alarms.get(ALARM_NAME_HEARTBEAT);
    if (!existing) {
      chrome.alarms.create(ALARM_NAME_HEARTBEAT, {
        periodInMinutes: HEARTBEAT_INTERVAL_MINUTES,
        delayInMinutes: HEARTBEAT_INTERVAL_MINUTES,
      });
    }
  } catch {
    // Alarms API failure safe fallback
  }
}

/**
 * Clears the heartbeat alarm.
 */
export async function clearHeartbeatAlarm(): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.alarms) {
    return;
  }
  try {
    await chrome.alarms.clear(ALARM_NAME_HEARTBEAT);
  } catch {
    // Ignore clear error
  }
}
