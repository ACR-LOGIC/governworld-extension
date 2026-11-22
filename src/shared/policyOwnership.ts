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

import { isRecord, type FindingCategory, type RedactionStyle } from "./types.js";
import { ALL_CATEGORIES, isCategory, isProtectionMode, type ProtectionMode, type Settings } from "./settings.js";
import type { EnterprisePolicy } from "./enterprisePolicy.js";
import type { NetworkDestinationPolicy } from "./networkGuard.js";

export type SettingOwnership = "administrator" | "user" | "system";

/**
 * Authoritative registry of setting keys to ownership classifications.
 */
export const SETTING_OWNERSHIP_MAP: Record<string, SettingOwnership> = {
  // --- Administrator-controlled settings ---
  protectionMode: "administrator",
  pasteGuardEnabled: "administrator", // synced alias of protectionMode
  enabled: "administrator",
  enabledCategories: "administrator", // admin mandated categories cannot be disabled
  categories: "administrator",
  confidenceThresholds: "administrator",
  networkDestinationPolicy: "administrator",
  networkAllowlist: "administrator",
  maxVisibleChars: "administrator",
  maxNodeChars: "administrator",
  defaultRedactionStyle: "administrator",
  defaultStampText: "administrator",
  customRules: "administrator",
  customPatterns: "administrator",
  autoMaskSingleNames: "administrator",

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

function arraysEqualUnordered(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

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
    // Per-seat administrator unlock allows local overrides when the policy itself is valid.
    if (policy.valid && policy.seatUnlocked === true) {
      return { allowed: true, effectiveValue: proposedValue };
    }

    const locked = !policy.valid || !policy.userCanDisable;
    if (!locked) {
      // Even if userCanDisable is true, admin-enforced categories remain an enforced floor.
      if (settingKey === "enabledCategories" || settingKey === "categories") {
        const proposedCats = Array.isArray(proposedValue)
          ? (proposedValue as unknown[]).filter(isCategory)
          : [];
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
      return { allowed: true, effectiveValue: proposedValue };
    }

    // Locked or fail-closed invalid policy: administrator policy is immutable.
    if (settingKey === "protectionMode") {
      const adminMode: ProtectionMode = policy.valid ? policy.protectionMode : "always-on";
      if (!isProtectionMode(proposedValue)) {
        return {
          allowed: false,
          reason: `Invalid protectionMode; administrator enforces "${adminMode}".`,
          effectiveValue: adminMode,
        };
      }
      if (adminMode === "off") {
        return {
          allowed: proposedValue === "off",
          reason: "Administrator has enforced protection mode: off.",
          effectiveValue: "off",
        };
      }
      if (PROTECTION_MODE_RANK[proposedValue] < PROTECTION_MODE_RANK[adminMode]) {
        return {
          allowed: false,
          reason: `Administrator policy enforces minimum protection mode "${adminMode}". Cannot downgrade to "${proposedValue}".`,
          effectiveValue: adminMode,
        };
      }
      return { allowed: true, effectiveValue: proposedValue };
    }

    if (settingKey === "pasteGuardEnabled" || settingKey === "enabled") {
      const adminMode: ProtectionMode = policy.valid ? policy.protectionMode : "always-on";
      const requiredEnabled = adminMode !== "off";
      if (proposedValue !== requiredEnabled) {
        return {
          allowed: false,
          reason: `Administrator policy locks ${settingKey} to ${String(requiredEnabled)}.`,
          effectiveValue: requiredEnabled,
        };
      }
      return { allowed: true, effectiveValue: requiredEnabled };
    }

    if (settingKey === "enabledCategories" || settingKey === "categories") {
      const mandated = policy.valid ? policy.enforcedCategories : [...ALL_CATEGORIES];
      const proposedCats = Array.isArray(proposedValue)
        ? (proposedValue as unknown[]).filter(isCategory)
        : [];
      const enforcedSet = new Set(mandated);
      const missingEnforced = mandated.filter((c) => !proposedCats.includes(c));

      if (!Array.isArray(proposedValue) || missingEnforced.length > 0) {
        const effective = Array.from(new Set([...proposedCats, ...enforcedSet]));
        return {
          allowed: false,
          reason: `Administrator mandates categories: [${missingEnforced.join(", ")}]. They cannot be disabled.`,
          effectiveValue: effective,
        };
      }
      return { allowed: true, effectiveValue: proposedCats };
    }

    if (settingKey === "confidenceThresholds") {
      if (!isRecord(proposedValue)) {
        return {
          allowed: false,
          reason: "Invalid confidenceThresholds value.",
          effectiveValue: { ...currentSettings.confidenceThresholds },
        };
      }
      const adminThresholds = policy.confidenceThresholds ?? {};
      const effective: Record<FindingCategory, number> = { ...currentSettings.confidenceThresholds };
      let rejected = false;
      for (const cat of ALL_CATEGORIES) {
        const prop = proposedValue[cat];
        const validProp = typeof prop === "number" && Number.isFinite(prop) && prop >= 0 && prop <= 1 ? prop : effective[cat];
        if (!policy.valid) {
          if (validProp > 0) rejected = true;
          effective[cat] = 0;
        } else if (adminThresholds[cat] !== undefined) {
          const maxT = adminThresholds[cat]!;
          if (validProp > maxT || (prop !== undefined && validProp !== prop)) {
            rejected = true;
          }
          effective[cat] = Math.min(validProp, maxT);
        } else {
          effective[cat] = validProp;
        }
      }
      if (rejected) {
        return {
          allowed: false,
          reason: "Administrator policy prohibits raising confidence thresholds above mandated limits.",
          effectiveValue: effective,
        };
      }
      return { allowed: true, effectiveValue: effective };
    }

    if (settingKey === "defaultRedactionStyle") {
      const mandated = policy.defaultRedactionStyle;
      if (!policy.valid || (mandated !== undefined && proposedValue !== mandated)) {
        return {
          allowed: false,
          reason: "Administrator policy locks defaultRedactionStyle.",
          effectiveValue: mandated ?? currentSettings.defaultRedactionStyle,
        };
      }
      return { allowed: true, effectiveValue: proposedValue };
    }

    if (settingKey === "defaultStampText") {
      const mandated = policy.defaultStampText;
      if (!policy.valid || (mandated !== undefined && proposedValue !== mandated)) {
        return {
          allowed: false,
          reason: "Administrator policy locks defaultStampText.",
          effectiveValue: mandated ?? currentSettings.defaultStampText,
        };
      }
      return { allowed: true, effectiveValue: proposedValue };
    }

    if (settingKey === "autoMaskSingleNames") {
      const mandated = policy.autoMaskSingleNames;
      if (!policy.valid || (mandated !== undefined && proposedValue !== mandated)) {
        return {
          allowed: false,
          reason: "Administrator policy locks autoMaskSingleNames.",
          effectiveValue: mandated ?? currentSettings.autoMaskSingleNames,
        };
      }
      return { allowed: true, effectiveValue: proposedValue };
    }

    if (settingKey === "maxVisibleChars") {
      const validNum = typeof proposedValue === "number" && Number.isFinite(proposedValue) && proposedValue >= 100;
      if (!policy.valid) {
        return {
          allowed: false,
          reason: "Fail-closed policy locks maxVisibleChars.",
          effectiveValue: currentSettings.maxVisibleChars,
        };
      }
      if (policy.maxVisibleChars !== undefined) {
        if (!validNum || proposedValue !== policy.maxVisibleChars) {
          return {
            allowed: false,
            reason: `Administrator policy enforces maxVisibleChars=${policy.maxVisibleChars}.`,
            effectiveValue: policy.maxVisibleChars,
          };
        }
        return { allowed: true, effectiveValue: proposedValue };
      }
      if (!validNum || proposedValue < currentSettings.maxVisibleChars) {
        return {
          allowed: false,
          reason: "Administrator policy prohibits lowering maxVisibleChars coverage.",
          effectiveValue: currentSettings.maxVisibleChars,
        };
      }
      return { allowed: true, effectiveValue: proposedValue };
    }

    if (settingKey === "maxNodeChars") {
      const validNum = typeof proposedValue === "number" && Number.isFinite(proposedValue) && proposedValue >= 10;
      if (!policy.valid) {
        return {
          allowed: false,
          reason: "Fail-closed policy locks maxNodeChars.",
          effectiveValue: currentSettings.maxNodeChars,
        };
      }
      if (policy.maxNodeChars !== undefined) {
        if (!validNum || proposedValue !== policy.maxNodeChars) {
          return {
            allowed: false,
            reason: `Administrator policy enforces maxNodeChars=${policy.maxNodeChars}.`,
            effectiveValue: policy.maxNodeChars,
          };
        }
        return { allowed: true, effectiveValue: proposedValue };
      }
      if (!validNum || proposedValue < currentSettings.maxNodeChars) {
        return {
          allowed: false,
          reason: "Administrator policy prohibits lowering maxNodeChars coverage.",
          effectiveValue: currentSettings.maxNodeChars,
        };
      }
      return { allowed: true, effectiveValue: proposedValue };
    }

    if (settingKey === "networkDestinationPolicy") {
      const mandated = policy.valid ? policy.networkDestinationPolicy : "disabled";
      if (proposedValue !== mandated) {
        return {
          allowed: false,
          reason: `Administrator policy enforces networkDestinationPolicy="${mandated}".`,
          effectiveValue: mandated,
        };
      }
      return { allowed: true, effectiveValue: mandated };
    }

    if (settingKey === "networkAllowlist") {
      const mandated = policy.valid ? [...policy.networkAllowlist] : [];
      if (!Array.isArray(proposedValue) || !arraysEqualUnordered(proposedValue as string[], mandated)) {
        return {
          allowed: false,
          reason: "Administrator policy locks networkAllowlist.",
          effectiveValue: mandated,
        };
      }
      return { allowed: true, effectiveValue: mandated };
    }

    // customRules, customPatterns, and any unknown administrator-owned keys are locked under management.
    return {
      allowed: false,
      reason: `Setting "${settingKey}" is administrator-controlled and locked by policy.`,
      effectiveValue: currentSettings[settingKey as keyof Settings],
    };
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
  const result: Settings = {
    ...currentSettings,
    enabledCategories: [...currentSettings.enabledCategories],
    confidenceThresholds: { ...currentSettings.confidenceThresholds },
  };
  const rejectedKeys: Array<{ key: string; reason: string }> = [];

  for (const [key, value] of Object.entries(requestedUpdates)) {
    const check = validateSettingMutation(key, value, currentSettings, policy);
    if (!check.allowed) {
      rejectedKeys.push({ key, reason: check.reason ?? "Mutation rejected by policy ownership." });
    }
    // Set the effective value (which may be clamped, enforced, or preserved)
    (result as unknown as Record<string, unknown>)[key] = check.effectiveValue;
  }

  if (!policy.managed) {
    return { settings: result, rejectedKeys };
  }

  // Fail-closed invalid managed policy overrides everything, including seatUnlocked.
  if (!policy.valid) {
    result.protectionMode = "always-on";
    result.pasteGuardEnabled = true;
    result.enabledCategories = [...ALL_CATEGORIES];
    return { settings: result, rejectedKeys };
  }

  // Unlocked paired seat: preserve user overrides locally (visible as drift until re-locked).
  if (policy.seatUnlocked === true) {
    result.pasteGuardEnabled = result.protectionMode !== "off";
    return { settings: result, rejectedKeys };
  }

  // Final invariant check: administrator-enforced categories must NEVER be missing under management
  if (policy.enforcedCategories.length > 0) {
    const currentSet = new Set(result.enabledCategories);
    for (const enforcedCat of policy.enforcedCategories) {
      currentSet.add(enforcedCat);
    }
    result.enabledCategories = Array.from(currentSet);
  }

  // Final invariant check: all locked administrator settings enforced even when requestedUpdates is {}
  if (!policy.userCanDisable) {
    const adminMode = policy.protectionMode;
    if (adminMode === "off") {
      result.protectionMode = "off";
    } else if (PROTECTION_MODE_RANK[result.protectionMode] < PROTECTION_MODE_RANK[adminMode]) {
      result.protectionMode = adminMode;
    }
    result.pasteGuardEnabled = result.protectionMode !== "off";

    if (policy.confidenceThresholds) {
      const clamped = { ...result.confidenceThresholds };
      for (const cat of ALL_CATEGORIES) {
        const maxT = policy.confidenceThresholds[cat];
        if (typeof maxT === "number" && Number.isFinite(maxT)) {
          clamped[cat] = Math.min(clamped[cat] ?? 0, maxT);
        }
      }
      result.confidenceThresholds = clamped;
    }
    if (policy.defaultRedactionStyle !== undefined) {
      result.defaultRedactionStyle = policy.defaultRedactionStyle;
    }
    if (policy.defaultStampText !== undefined) {
      result.defaultStampText = policy.defaultStampText;
    }
    if (policy.autoMaskSingleNames !== undefined) {
      result.autoMaskSingleNames = policy.autoMaskSingleNames;
    }
    if (policy.maxVisibleChars !== undefined) {
      result.maxVisibleChars = policy.maxVisibleChars;
    }
    if (policy.maxNodeChars !== undefined) {
      result.maxNodeChars = policy.maxNodeChars;
    }
  }

  return { settings: result, rejectedKeys };
}

export interface ReportedPolicyState {
  policyVersion: number | null;
  unlocked: boolean;
  protectionMode: ProtectionMode;
  enabledCategories: FindingCategory[];
  confidenceThresholds: Partial<Record<FindingCategory, number>>;
  defaultRedactionStyle: RedactionStyle;
  defaultStampText: string;
  autoMaskSingleNames: boolean;
  maxVisibleChars: number;
  maxNodeChars: number;
  networkDestinationPolicy: NetworkDestinationPolicy;
  networkAllowlist: string[];
}

export interface PolicyDriftEntry {
  key: string;
  assigned: unknown;
  reported: unknown;
}

export interface PolicyDriftReport {
  hasDrift: boolean;
  driftedKeys: string[];
  driftedFields: PolicyDriftEntry[];
}

/**
 * Builds a minimal, zero-PHI policy-state summary for heartbeats and drift checks.
 */
export function buildReportedPolicyState(
  settings: Settings,
  policy: EnterprisePolicy,
  unlocked: boolean = Boolean(policy.valid && policy.seatUnlocked),
): ReportedPolicyState {
  return {
    policyVersion: policy.policyVersion ?? null,
    unlocked,
    protectionMode: settings.protectionMode,
    enabledCategories: [...settings.enabledCategories],
    confidenceThresholds: { ...settings.confidenceThresholds },
    defaultRedactionStyle: settings.defaultRedactionStyle,
    defaultStampText: settings.defaultStampText,
    autoMaskSingleNames: settings.autoMaskSingleNames,
    maxVisibleChars: settings.maxVisibleChars,
    maxNodeChars: settings.maxNodeChars,
    networkDestinationPolicy: policy.networkDestinationPolicy,
    networkAllowlist: [...policy.networkAllowlist],
  };
}

/**
 * Compares the administrator-assigned EnterprisePolicy against a seat's
 * reported policy state or local settings to surface any configuration drift
 * (for example after a seat was unlocked and later re-locked).
 */
export function detectPolicyDrift(
  assignedPolicy: EnterprisePolicy,
  reportedOrSettings: ReportedPolicyState | Settings,
): PolicyDriftReport {
  const driftedFields: PolicyDriftEntry[] = [];
  if (!assignedPolicy.managed) {
    return { hasDrift: false, driftedKeys: [], driftedFields };
  }

  if (reportedOrSettings.protectionMode !== assignedPolicy.protectionMode) {
    driftedFields.push({
      key: "protectionMode",
      assigned: assignedPolicy.protectionMode,
      reported: reportedOrSettings.protectionMode,
    });
  }

  const reportedCats = new Set(reportedOrSettings.enabledCategories);
  const missingCats = assignedPolicy.enforcedCategories.filter((c) => !reportedCats.has(c));
  if (missingCats.length > 0) {
    driftedFields.push({
      key: "enabledCategories",
      assigned: [...assignedPolicy.enforcedCategories],
      reported: [...reportedOrSettings.enabledCategories],
    });
  }

  if (assignedPolicy.confidenceThresholds) {
    const mismatched: Record<string, { assigned: number; reported: number }> = {};
    for (const [cat, assignedVal] of Object.entries(assignedPolicy.confidenceThresholds)) {
      if (typeof assignedVal === "number") {
        const repVal = (reportedOrSettings.confidenceThresholds as Record<string, number | undefined>)[cat] ?? 0;
        if (repVal !== assignedVal) {
          mismatched[cat] = { assigned: assignedVal, reported: repVal };
        }
      }
    }
    if (Object.keys(mismatched).length > 0) {
      driftedFields.push({
        key: "confidenceThresholds",
        assigned: assignedPolicy.confidenceThresholds,
        reported: reportedOrSettings.confidenceThresholds,
      });
    }
  }

  if (
    assignedPolicy.defaultRedactionStyle !== undefined &&
    reportedOrSettings.defaultRedactionStyle !== assignedPolicy.defaultRedactionStyle
  ) {
    driftedFields.push({
      key: "defaultRedactionStyle",
      assigned: assignedPolicy.defaultRedactionStyle,
      reported: reportedOrSettings.defaultRedactionStyle,
    });
  }

  if (
    assignedPolicy.defaultStampText !== undefined &&
    reportedOrSettings.defaultStampText !== assignedPolicy.defaultStampText
  ) {
    driftedFields.push({
      key: "defaultStampText",
      assigned: assignedPolicy.defaultStampText,
      reported: reportedOrSettings.defaultStampText,
    });
  }

  if (
    assignedPolicy.autoMaskSingleNames !== undefined &&
    reportedOrSettings.autoMaskSingleNames !== assignedPolicy.autoMaskSingleNames
  ) {
    driftedFields.push({
      key: "autoMaskSingleNames",
      assigned: assignedPolicy.autoMaskSingleNames,
      reported: reportedOrSettings.autoMaskSingleNames,
    });
  }

  if (
    assignedPolicy.maxVisibleChars !== undefined &&
    reportedOrSettings.maxVisibleChars !== assignedPolicy.maxVisibleChars
  ) {
    driftedFields.push({
      key: "maxVisibleChars",
      assigned: assignedPolicy.maxVisibleChars,
      reported: reportedOrSettings.maxVisibleChars,
    });
  }

  if (
    assignedPolicy.maxNodeChars !== undefined &&
    reportedOrSettings.maxNodeChars !== assignedPolicy.maxNodeChars
  ) {
    driftedFields.push({
      key: "maxNodeChars",
      assigned: assignedPolicy.maxNodeChars,
      reported: reportedOrSettings.maxNodeChars,
    });
  }

  if ("networkDestinationPolicy" in reportedOrSettings) {
    if (reportedOrSettings.networkDestinationPolicy !== assignedPolicy.networkDestinationPolicy) {
      driftedFields.push({
        key: "networkDestinationPolicy",
        assigned: assignedPolicy.networkDestinationPolicy,
        reported: reportedOrSettings.networkDestinationPolicy,
      });
    }
    if (!arraysEqualUnordered(reportedOrSettings.networkAllowlist, assignedPolicy.networkAllowlist)) {
      driftedFields.push({
        key: "networkAllowlist",
        assigned: [...assignedPolicy.networkAllowlist],
        reported: [...reportedOrSettings.networkAllowlist],
      });
    }
  }

  return {
    hasDrift: driftedFields.length > 0,
    driftedKeys: driftedFields.map((d) => d.key),
    driftedFields,
  };
}
