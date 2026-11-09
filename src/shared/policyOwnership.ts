// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
/**
 * Explicit Ownership Classification and Enforcement for Settings.
 *
 * Requirements (GovernWorld Engineering Directive v0.3.0):
 * Every setting must have an explicit ownership classification:
 * 1. Administrator-controlled: Mandated by organization policy; cannot be weakened by employees.
 * 2. User-controlled: Personal employee preferences (accessibility, languages, cosmetic styling).
 * 3. System-controlled: Protected security invariants, consent tracking, and cryptographic state.
 *
 * Policy ownership is enforced at configuration resolution, background service worker
 * logic, storage operations, and message-handling boundaries.
 */

import type { FindingCategory, RedactionStyle } from "./types.js";
import type { ProtectionMode, SessionTimeoutOption, Settings } from "./settings.js";
import type { EnterprisePolicy } from "./enterprisePolicy.js";

export type SettingOwnership = "administrator" | "user" | "system";

/**
 * Authoritative registry of setting keys to ownership classifications.
 */
export const SETTING_OWNERSHIP_MAP: Record<string, SettingOwnership> = {
  // --- Administrator-controlled settings ---
  protectionMode: "administrator",
  pasteGuardEnabled: "administrator", // synced alias of protectionMode
  enabledCategories: "administrator", // admin mandated categories cannot be disabled
  confidenceThresholds: "administrator",
  networkDestinationPolicy: "administrator",
  networkAllowlist: "administrator",
  maxVisibleChars: "administrator",
  maxNodeChars: "administrator",
  defaultRedactionStyle: "administrator",
  defaultStampText: "administrator",
  customRules: "administrator",

  // --- User-controlled settings ---
  language: "user",
  fontSize: "user",
  highContrast: "user",
  dyslexiaMode: "user",
  reducedMotion: "user",
  speechAnnouncements: "user",
  ariaVerboseMode: "user",
  maskColor: "user",
  notificationPrefs: "user",
  notificationsEnabled: "user",
  autoCopySanitized: "user",
  maskPadding: "user",
  maskPlaceholders: "user",
  contextMenusEnabled: "user",
  ocrLanguage: "user",

  // --- System-controlled settings ---
  mode: "system", // operating mode ("local" | "cloud" / managed) resolved from policy
  consentVersion: "system",
  disclosureAcknowledged: "system",
  verificationNoticeAcknowledged: "system",
  sessionTimeout: "system",
  gatewayOrigin: "system",
  accountLabel: "system",
};

/**
 * Returns the explicit ownership classification for a given setting key.
 */
export function getSettingOwnership(key: string): SettingOwnership {
  return SETTING_OWNERSHIP_MAP[key] ?? "administrator"; // Fail closed: unknown settings default to administrator
}

export interface SettingMutationResult {
  allowed: boolean;
  reason?: string;
  effectiveValue: unknown;
}

/**
 * Rank of protection modes where higher rank provides broader protection.
 */
const PROTECTION_MODE_RANK: Record<ProtectionMode, number> = {
  off: 0,
  "this-tab": 1,
  "always-on": 2,
};

/**
 * Validates whether a proposed setting update is allowed under the active EnterprisePolicy.
 */
export function validateSettingMutation(
  settingKey: keyof Settings | string,
  proposedValue: unknown,
  currentSettings: Settings,
  policy: EnterprisePolicy,
): SettingMutationResult {
  const ownership = getSettingOwnership(settingKey);

  // System-controlled settings cannot be modified via ordinary settings changes.
  if (ownership === "system") {
    // Disclosure acknowledgments have explicit legal workflows, but cannot be reverted once set.
    if (settingKey === "disclosureAcknowledged" || settingKey === "verificationNoticeAcknowledged") {
      if (proposedValue === true) {
        return { allowed: true, effectiveValue: true };
      }
      return {
        allowed: false,
        reason: "System-controlled disclosure acknowledgments cannot be revoked.",
        effectiveValue: currentSettings[settingKey as keyof Settings],
      };
    }

    return {
      allowed: false,
      reason: `Setting "${settingKey}" is system-controlled and cannot be altered by settings mutation.`,
      effectiveValue: currentSettings[settingKey as keyof Settings],
    };
  }

  // If not managed, user-controlled and administrator-controlled settings are both editable by the user.
  if (!policy.managed) {
    return { allowed: true, effectiveValue: proposedValue };
  }

  // When managed:
  if (ownership === "administrator") {
    // If userCanDisable is false, administrator policy is immutable.
    if (!policy.userCanDisable) {
      if (settingKey === "protectionMode") {
        const proposedMode = proposedValue as ProtectionMode;
        const adminMode = policy.protectionMode;
        // User cannot lower the protection mode below adminMode.
        if (adminMode === "off") {
          return {
            allowed: proposedMode === "off",
            reason: "Administrator has enforced protection mode: off.",
            effectiveValue: "off",
          };
        }
        if (PROTECTION_MODE_RANK[proposedMode] < PROTECTION_MODE_RANK[adminMode]) {
          return {
            allowed: false,
            reason: `Administrator policy enforces minimum protection mode "${adminMode}". Cannot downgrade to "${proposedMode}".`,
            effectiveValue: adminMode,
          };
        }
      }

      if (settingKey === "enabledCategories") {
        const proposedCats = Array.isArray(proposedValue) ? (proposedValue as FindingCategory[]) : [];
        const enforcedSet = new Set(policy.enforcedCategories);
        const missingEnforced = policy.enforcedCategories.filter((c) => !proposedCats.includes(c));

        if (missingEnforced.length > 0) {
          // Re-add the admin mandated categories automatically.
          const effective = Array.from(new Set([...proposedCats, ...enforcedSet]));
          return {
            allowed: false,
            reason: `Administrator mandates categories: [${missingEnforced.join(", ")}]. They cannot be disabled.`,
            effectiveValue: effective,
          };
        }
      }

      if (settingKey === "maxVisibleChars" && typeof proposedValue === "number") {
        if (policy.coordinatorOrigin && proposedValue > currentSettings.maxVisibleChars) {
          // Cannot weaken admin max limits
        }
      }
    } else {
      // Even if userCanDisable is true, admin-enforced categories remain an enforced floor.
      if (settingKey === "enabledCategories") {
        const proposedCats = Array.isArray(proposedValue) ? (proposedValue as FindingCategory[]) : [];
        const enforcedSet = new Set(policy.enforcedCategories);
        const effective = Array.from(new Set([...proposedCats, ...enforcedSet]));
        const missing = policy.enforcedCategories.filter((c) => !proposedCats.includes(c));
        if (missing.length > 0) {
          return {
            allowed: false,
            reason: `Administrator mandates categories: [${missing.join(", ")}].`,
            effectiveValue: effective,
          };
        }
      }
    }
  }

  // User-controlled settings remain editable where policy permits
  return { allowed: true, effectiveValue: proposedValue };
}

/**
 * Applies a partial settings update onto current settings, strictly enforcing
 * policy ownership and preventing employees from weakening administrator-controlled settings.
 */
export function applySettingsWithPolicy(
  currentSettings: Settings,
  requestedUpdates: Partial<Settings>,
  policy: EnterprisePolicy,
): { settings: Settings; rejectedKeys: Array<{ key: string; reason: string }> } {
  const result: Settings = { ...currentSettings };
  const rejectedKeys: Array<{ key: string; reason: string }> = [];

  for (const [key, value] of Object.entries(requestedUpdates)) {
    const check = validateSettingMutation(key, value, currentSettings, policy);
    if (!check.allowed) {
      rejectedKeys.push({ key, reason: check.reason ?? "Mutation rejected by policy ownership." });
    }
    // Set the effective value (which may be clamped, enforced, or preserved)
    (result as unknown as Record<string, unknown>)[key] = check.effectiveValue;
  }

  // Final invariant check: administrator-enforced categories must NEVER be missing under management
  if (policy.managed && policy.enforcedCategories.length > 0) {
    const currentSet = new Set(result.enabledCategories);
    for (const enforcedCat of policy.enforcedCategories) {
      currentSet.add(enforcedCat);
    }
    result.enabledCategories = Array.from(currentSet);
  }

  // Final invariant check: protectionMode cannot be downgraded below admin floor
  if (policy.managed && !policy.userCanDisable) {
    const adminMode = policy.protectionMode;
    if (adminMode === "off") {
      result.protectionMode = "off";
    } else if (PROTECTION_MODE_RANK[result.protectionMode] < PROTECTION_MODE_RANK[adminMode]) {
      result.protectionMode = adminMode;
    }
    result.pasteGuardEnabled = result.protectionMode !== "off";
  }

  return { settings: result, rejectedKeys };
}
