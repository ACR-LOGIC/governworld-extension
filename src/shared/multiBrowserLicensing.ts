// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
/**
 * Multi-Browser Single-Seat Licensing, Anti-Sharing Conflict Resolution,
 * and Lapsed-Subscription Fail-Closed Continuity.
 *
 * Invariants:
 * - 1 User = 1 Seat across distinct browser families (Chrome + Edge + Firefox + Safari = 1 seat).
 * - At most 1 active instance per (user_email_hash, browser_family).
 * - Voluntary re-pairing on a duplicate browser family unlinks and resets the old instance.
 * - Lapsed subscription ceases cloud heartbeats/sync while keeping policies locked locally.
 */

import { browserDisplayName, type BrowserFamily } from "./browserFamily.js";
import {
  clearManagementEnrollment,
  loadManagementEnrollment,
  saveManagementEnrollment,
} from "./managedPolicy.js";
import { clearPairingState, DEFAULT_SETTINGS } from "./settings.js";

export const STORAGE_KEY_LIFECYCLE_STATE = "gw_telemetry_lifecycle";

export interface DuplicateBrowserConflict {
  code: "DUPLICATE_BROWSER_CONFLICT";
  browser_family: BrowserFamily;
  browser_display_name: string;
  existing_instance_id?: string;
  message: string;
}

export interface BrowserSeatBindingRecord {
  seat_id: string;
  user_email_hash: string;
  browser_family: BrowserFamily;
  installation_id: string;
  device_activation_hash: string;
  status: "active" | "replaced" | "uninstalled";
  paired_at: string;
}

export type BrowserSeatBindingEvaluation =
  | {
      ok: true;
      seat_id: string;
      replaced_instance_id?: string;
      records: BrowserSeatBindingRecord[];
      seat_count_used: number;
    }
  | {
      ok: false;
      conflict: DuplicateBrowserConflict;
      records: BrowserSeatBindingRecord[];
      seat_count_used: number;
    };

async function sha256HexLocal(input: string): Promise<string> {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new Error("WebCrypto subtle digest is unavailable.");
  }
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Privacy-safe irreversible hash binding an organization + normalized email.
 * Never transmits or stores plaintext email addresses in telemetry payloads.
 */
export async function computeUserEmailHash(organizationId: string, email: string): Promise<string> {
  const normalizedOrg = organizationId.trim().toLowerCase();
  const normalizedEmail = email.trim().toLowerCase();
  return await sha256HexLocal(`${normalizedOrg}:${normalizedEmail}`);
}

/**
 * Cryptographic binding of (user_email_hash, browser_family, installation_id).
 */
export async function computeDeviceActivationHash(
  userEmailHash: string,
  browserFamily: BrowserFamily,
  installationId: string,
): Promise<string> {
  return await sha256HexLocal(`${userEmailHash}:${browserFamily}:${installationId}`);
}

export function buildDuplicateBrowserConflictMessage(browserFamily: BrowserFamily): string {
  const label = browserDisplayName(browserFamily);
  return `This account is already associated with an active ${label} extension. Do you want to unpair and reset the previous instance to default, or cancel?`;
}

/**
 * Evaluates 1-user-1-seat multi-browser binding and 1-instance-per-browser-family
 * anti-sharing rules deterministically.
 */
export function evaluateLocalBrowserSeatBinding(params: {
  existingRecords: readonly BrowserSeatBindingRecord[];
  user_email_hash: string;
  browser_family: BrowserFamily;
  installation_id: string;
  device_activation_hash: string;
  confirm_replace?: boolean;
  allocateSeatId?: () => string;
  nowIso?: string;
}): BrowserSeatBindingEvaluation {
  const nowIso = params.nowIso ?? new Date().toISOString();
  const records = params.existingRecords.map((r) => ({ ...r }));
  const activeForUser = records.filter(
    (r) => r.status === "active" && r.user_email_hash === params.user_email_hash,
  );
  const seatCountUsed = new Set(records.filter((r) => r.status === "active").map((r) => r.user_email_hash)).size;

  const duplicateSameBrowser = activeForUser.find(
    (r) => r.browser_family === params.browser_family && r.installation_id !== params.installation_id,
  );

  if (duplicateSameBrowser && !params.confirm_replace) {
    return {
      ok: false,
      conflict: {
        code: "DUPLICATE_BROWSER_CONFLICT",
        browser_family: params.browser_family,
        browser_display_name: browserDisplayName(params.browser_family),
        existing_instance_id: duplicateSameBrowser.installation_id,
        message: buildDuplicateBrowserConflictMessage(params.browser_family),
      },
      records,
      seat_count_used: seatCountUsed,
    };
  }

  let replacedInstanceId: string | undefined;
  if (duplicateSameBrowser && params.confirm_replace) {
    replacedInstanceId = duplicateSameBrowser.installation_id;
    for (const r of records) {
      if (r.status === "active" && r.user_email_hash === params.user_email_hash && r.browser_family === params.browser_family) {
        r.status = "replaced";
      }
    }
  }

  // Reuse the same seat ID across distinct browser families for the same user (1 user = 1 seat).
  const seatId =
    activeForUser[0]?.seat_id ??
    duplicateSameBrowser?.seat_id ??
    (params.allocateSeatId ? params.allocateSeatId() : `seat_${params.user_email_hash.slice(0, 12)}`);

  const alreadySameInstall = records.find(
    (r) => r.status === "active" && r.installation_id === params.installation_id,
  );
  if (!alreadySameInstall) {
    records.push({
      seat_id: seatId,
      user_email_hash: params.user_email_hash,
      browser_family: params.browser_family,
      installation_id: params.installation_id,
      device_activation_hash: params.device_activation_hash,
      status: "active",
      paired_at: nowIso,
    });
  }

  const nextSeatCount = new Set(records.filter((r) => r.status === "active").map((r) => r.user_email_hash)).size;
  return {
    ok: true,
    seat_id: seatId,
    ...(replacedInstanceId ? { replaced_instance_id: replacedInstanceId } : {}),
    records,
    seat_count_used: nextSeatCount,
  };
}

/**
 * Unlinks a paired extension and resets all settings to factory defaults.
 * Invoked ONLY on voluntary unpair, voluntary duplicate-browser replacement, or explicit admin revocation.
 */
export async function unlinkAndResetToDefaults(): Promise<void> {
  await clearManagementEnrollment();
  await clearPairingState();

  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    await chrome.storage.local.remove([
      "gw_coordinator_policy",
      "gw_coordinator_url",
      STORAGE_KEY_LIFECYCLE_STATE,
    ]);
    await chrome.storage.local.set({
      settings: {
        ...DEFAULT_SETTINGS,
        enabledCategories: [...DEFAULT_SETTINGS.enabledCategories],
        confidenceThresholds: { ...DEFAULT_SETTINGS.confidenceThresholds },
        notificationPrefs: { ...DEFAULT_SETTINGS.notificationPrefs },
      },
    });
  }

  if (typeof chrome !== "undefined" && chrome.alarms) {
    try {
      await chrome.alarms.clear("gw_management_heartbeat");
    } catch {
      // Ignore alarm clear failure
    }
  }

  if (typeof chrome !== "undefined" && chrome.runtime?.setUninstallURL) {
    try {
      await chrome.runtime.setUninstallURL("");
    } catch {
      // Ignore uninstall URL clear error
    }
  }
}

/**
 * Fail-Closed Continuity on Subscription Lapse:
 * Ceases cloud heartbeats, policy sync, and uninstall callbacks while keeping all
 * previously pushed administrator policies and locks enforced locally.
 * NEVER unlinks or resets user/admin settings to default.
 */
export async function enterLapsedSubscriptionContinuity(): Promise<void> {
  const enrollment = await loadManagementEnrollment();
  if (enrollment && enrollment.management_mode === "MANAGE" && !enrollment.subscription_lapsed) {
    await saveManagementEnrollment({
      ...enrollment,
      subscription_lapsed: true,
      lapsed_at: new Date().toISOString(),
    });
  }

  if (typeof chrome !== "undefined" && chrome.alarms) {
    try {
      await chrome.alarms.clear("gw_management_heartbeat");
    } catch {
      // Ignore alarm clear failure
    }
  }

  if (typeof chrome !== "undefined" && chrome.runtime?.setUninstallURL) {
    try {
      await chrome.runtime.setUninstallURL("");
    } catch {
      // Ignore uninstall URL clear error
    }
  }
}
