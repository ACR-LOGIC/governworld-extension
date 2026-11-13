// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
/**
 * Policy Synchronization Service for Background Service Worker.
 *
 * Implements:
 * - Extension-initiated durable, idempotent policy retrieval.
 * - Initial check on extension startup.
 * - Event-driven bounded checks (throttled to avoid load spikes).
 * - Online recovery checks.
 * - Management state change synchronization.
 * - Cryptographic verification (Ed25519) and anti-rollback validation.
 * - Safe-state offline continuity enforcing last known valid policy.
 * - Minimal acknowledgment back to coordinator with zero sensitive leak.
 */

import {
  loadManagementEnrollment,
  loadLastAppliedManagedPolicy,
  saveAppliedManagedPolicy,
  verifyAndValidateManagedPolicy,
  createPolicyAcknowledgment,
  ManagedPolicyEnvelope,
  ManagementEnrollment,
  PolicyApplicationAcknowledgment,
} from "../shared/managedPolicy.js";
import { syncSiteProtection } from "./siteProtection.js";
import { recordAudit } from "./auditService.js";
import { dispatchExtensionNotification } from "./index.js";
import { GovernWorldApiClient } from "../api/client.js";

const STORAGE_KEY_LAST_SYNC_TS = "gw_policy_last_sync_ts";
/** Minimum interval between background sync check-ins (15 minutes). */
export const MIN_SYNC_INTERVAL_MS = 15 * 60 * 1000;

export interface PolicySyncResult {
  mode: "LOCAL" | "MANAGE";
  status: "idle" | "cached" | "applied" | "up-to-date" | "rejected" | "offline" | "offline_continuity" | "error";
  policyId?: string;
  policyVersion?: number;
  error?: string;
}

async function getLastSyncTimestamp(): Promise<number> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return 0;
  try {
    const res = await chrome.storage.local.get(STORAGE_KEY_LAST_SYNC_TS);
    return typeof res[STORAGE_KEY_LAST_SYNC_TS] === "number" ? res[STORAGE_KEY_LAST_SYNC_TS] : 0;
  } catch {
    return 0;
  }
}

async function setLastSyncTimestamp(ts: number): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  try {
    await chrome.storage.local.set({ [STORAGE_KEY_LAST_SYNC_TS]: ts });
  } catch {
    // Ignore storage write error
  }
}

/**
 * Checks for assigned policy updates from the GovernWorld management coordination
 * infrastructure and applies valid administrator-approved policies automatically.
 */
export async function syncManagedPolicy(force = false): Promise<PolicySyncResult> {
  const enrollment = await loadManagementEnrollment();

  // If not enrolled or in standalone LOCAL mode:
  if (!enrollment || enrollment.management_mode !== "MANAGE") {
    return { mode: "LOCAL", status: "idle" };
  }

  // Throttle check-ins unless force is requested
  const now = Date.now();
  if (!force) {
    const lastSync = await getLastSyncTimestamp();
    if (now - lastSync < MIN_SYNC_INTERVAL_MS) {
      const lastApplied = await loadLastAppliedManagedPolicy();
      return {
        mode: "MANAGE",
        status: "cached",
        policyId: lastApplied?.policy_id,
        policyVersion: lastApplied?.policy_version,
      };
    }
  }

  // Check if offline
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    const lastApplied = await loadLastAppliedManagedPolicy();
    return {
      mode: "MANAGE",
      status: "offline",
      policyId: lastApplied?.policy_id,
      policyVersion: lastApplied?.policy_version,
    };
  }

  const lastApplied = await loadLastAppliedManagedPolicy();

  try {
    const client = new GovernWorldApiClient(enrollment.coordinator_url);
    const query = new URLSearchParams({
      organization_id: enrollment.organization_id,
      employee_id: enrollment.employee_id,
      device_id: enrollment.device_id,
      ...(lastApplied?.policy_version ? { current_version: String(lastApplied.policy_version) } : {}),
    });

    const response = await client.get<ManagedPolicyEnvelope>(
      `/api/v1/management/policy?${query.toString()}`,
      { timeoutMs: 8000 }
    );

    await setLastSyncTimestamp(now);

    if (!response.ok) {
      // If server returns 304 or not modified / up-to-date
      if (response.error.status_code === 304) {
        return {
          mode: "MANAGE",
          status: "up-to-date",
          policyId: lastApplied?.policy_id,
          policyVersion: lastApplied?.policy_version,
        };
      }

      // Offline / network failure: continue enforcing last valid policy (offline continuity)
      return {
        mode: "MANAGE",
        status: "offline_continuity",
        policyId: lastApplied?.policy_id,
        policyVersion: lastApplied?.policy_version,
        error: response.error.user_message,
      };
    }

    const payload = response.data;
    const verification = await verifyAndValidateManagedPolicy(
      payload,
      enrollment,
      lastApplied,
      now,
    );

    if (!verification.valid || !verification.policy) {
      // Rejection: log security audit and send acknowledgment
      void recordAudit({
        ts: new Date().toISOString(),
        action: "policy_enforced",
        outcome: "error",
      });

      // Send rejection acknowledgment
      if (payload?.policy_id && typeof payload.policy_version === "number") {
        const ack = createPolicyAcknowledgment(
          enrollment,
          payload.policy_id,
          payload.policy_version,
          "rejected",
          verification.reason,
        );
        void client.post<void>("/api/v1/management/ack", ack).catch(() => undefined);
      }

      return {
        mode: "MANAGE",
        status: "rejected",
        error: verification.reason,
        policyId: lastApplied?.policy_id,
        policyVersion: lastApplied?.policy_version,
      };
    }

    // Check if identical policy already applied (idempotent)
    if (
      lastApplied &&
      verification.policy.policy_id === lastApplied.policy_id &&
      verification.policy.policy_version === lastApplied.policy_version &&
      verification.policy.nonce === lastApplied.nonce
    ) {
      return {
        mode: "MANAGE",
        status: "up-to-date",
        policyId: lastApplied.policy_id,
        policyVersion: lastApplied.policy_version,
      };
    }

    // Valid administrator-approved policy received: Apply automatically
    await saveAppliedManagedPolicy(verification.policy);

    // Reconcile site protection and runtime enforcement
    void syncSiteProtection();

    // Acknowledge application with minimal status
    const ack = createPolicyAcknowledgment(
      enrollment,
      verification.policy.policy_id,
      verification.policy.policy_version,
      "applied",
    );
    void client.post<void>("/api/v1/management/ack", ack).catch(() => undefined);

    // Signed audit log record
    void recordAudit({
      ts: new Date().toISOString(),
      action: "policy_enforced",
      outcome: "ok",
    });

    // Notify UI / tabs of policy change
    void dispatchExtensionNotification({
      event: "policy_change",
      title: "GovernWorld Policy Updated",
      message: `Administrator policy v${verification.policy.policy_version} applied.`,
      level: "info",
    });

    return {
      mode: "MANAGE",
      status: "applied",
      policyId: verification.policy.policy_id,
      policyVersion: verification.policy.policy_version,
    };
  } catch (error) {
    // Offline continuity: ensure last applied policy remains authoritative
    return {
      mode: "MANAGE",
      status: "offline_continuity",
      policyId: lastApplied?.policy_id,
      policyVersion: lastApplied?.policy_version,
      error: error instanceof Error ? error.message : "Network error during policy sync",
    };
  }
}
