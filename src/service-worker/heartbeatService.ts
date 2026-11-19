// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
/**
 * Lightweight Heartbeat and Device Compliance Service for MANAGE mode.
 *
 * Requirements:
 * - Standalone LOCAL Mode: STRICTLY INACTIVE. Zero network requests, zero timers.
 * - Managed Mode (Post-Pairing ONLY): Sends periodic, lightweight status checks
 *   to verify extension installation, health, and policy compliance.
 * - Zero Employee Surveillance: Absolutely NO browsing history, visited URLs,
 *   search queries, page text, DOM elements, credentials, emails, or personal files.
 */

import {
  loadManagementEnrollment,
  loadLastAppliedManagedPolicy,
} from "../shared/managedPolicy.js";
import { loadEnterprisePolicy } from "../shared/enterprisePolicy.js";
import { getInstallationId, CURRENT_EXTENSION_VERSION, validateApiUrl } from "../api/config.js";

export const ALARM_NAME_HEARTBEAT = "gw_management_heartbeat";
export const HEARTBEAT_INTERVAL_MINUTES = 15;

export interface HeartbeatBrowserInfo {
  name: string;
  version: string;
  platform: string;
}

export interface HeartbeatPayload {
  device_id: string;
  organization_id: string;
  employee_id?: string;
  browser_info: HeartbeatBrowserInfo;
  extension_version: string;
  policy_version: number;
  policy_status: "compliant" | "out-of-date" | "healthy";
  timestamp: string;
  status: "active" | "healthy";
}

export interface HeartbeatResult {
  mode: "LOCAL" | "MANAGE";
  sent: boolean;
  status: "idle" | "sent" | "offline" | "error";
  error?: string;
  payload?: HeartbeatPayload;
}

/**
 * Extracts sanitized browser metadata without capturing any sensitive or user-specific data.
 */
export function getBrowserInfo(): HeartbeatBrowserInfo {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const platform = typeof navigator !== "undefined" ? navigator.platform || "unknown" : "unknown";

  let name = "Chromium";
  let version = "unknown";

  if (ua.includes("Firefox/")) {
    name = "Firefox";
    const match = ua.match(/Firefox\/([0-9.]+)/);
    if (match) version = match[1];
  } else if (ua.includes("Edg/")) {
    name = "Edge";
    const match = ua.match(/Edg\/([0-9.]+)/);
    if (match) version = match[1];
  } else if (ua.includes("Chrome/")) {
    name = "Chrome";
    const match = ua.match(/Chrome\/([0-9.]+)/);
    if (match) version = match[1];
  }

  return { name, version, platform };
}

/**
 * Sends a lightweight heartbeat status check to the management coordinator.
 * Strictly checks enrollment: if not in MANAGE mode, returns immediately with ZERO network egress.
 */
export async function sendHeartbeatStatusCheck(): Promise<HeartbeatResult> {
  const enrollment = await loadManagementEnrollment();

  // INVARIANT: In standalone LOCAL mode, NO heartbeat may ever be sent.
  if (!enrollment || enrollment.management_mode !== "MANAGE") {
    return { mode: "LOCAL", sent: false, status: "idle" };
  }

  // If offline, do not attempt network fetch.
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { mode: "MANAGE", sent: false, status: "offline" };
  }

  const lastApplied = await loadLastAppliedManagedPolicy();
  const enterprisePolicy = await loadEnterprisePolicy();
  const deviceId = enrollment.device_id || (await getInstallationId());
  const policyVersion = lastApplied?.policy_version || enterprisePolicy.policyVersion || 1;

  const payload: HeartbeatPayload = {
    device_id: deviceId,
    organization_id: enrollment.organization_id,
    ...(enrollment.employee_id ? { employee_id: enrollment.employee_id } : {}),
    browser_info: getBrowserInfo(),
    extension_version: CURRENT_EXTENSION_VERSION,
    policy_version: policyVersion,
    policy_status: enterprisePolicy.valid ? "compliant" : "out-of-date",
    timestamp: new Date().toISOString(),
    status: "healthy",
  };

  const coordinatorUrl = enrollment.coordinator_url || "http://127.0.0.1:4820";
  const urlCheck = validateApiUrl(coordinatorUrl);
  if (!urlCheck.valid || !urlCheck.normalizedUrl) {
    return {
      mode: "MANAGE",
      sent: false,
      status: "error",
      error: urlCheck.error ?? "Invalid coordinator URL",
      payload,
    };
  }
  const endpoint = `${urlCheck.normalizedUrl}/api/v1/management/heartbeat`;

  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), 8000) : null;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GovernWorld-Device-Id": deviceId,
      },
      body: JSON.stringify(payload),
      ...(controller ? { signal: controller.signal } : {}),
    });

    if (!res.ok) {
      return {
        mode: "MANAGE",
        sent: false,
        status: "error",
        error: `HTTP ${res.status}`,
        payload,
      };
    }

    return {
      mode: "MANAGE",
      sent: true,
      status: "sent",
      payload,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Heartbeat connection failed";
    return {
      mode: "MANAGE",
      sent: false,
      status: "error",
      error: message,
      payload,
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
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

  if (!enrollment || enrollment.management_mode !== "MANAGE") {
    // Un-enrolled: ensure any existing heartbeat alarm is cleared.
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
