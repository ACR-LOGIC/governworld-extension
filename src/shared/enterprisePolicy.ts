// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { isRecord, type RedactionStyle } from "./types.js";
import type { NetworkDestinationPolicy } from "./networkGuard.js";
import type { PolicyRule } from "../api/types.js";
import type { ManagementEnrollment } from "./managedPolicy.js";
import { getInstallationId } from "../api/config.js";
import {
  ALL_CATEGORIES,
  isCategory,
  isProtectionMode,
  normalizePairingState,
  PAIRING_STATE_KEY,
  type FindingCategory,
  type ProtectionMode,
  type Settings,
} from "./settings.js";

/**
 * Enterprise (administrator) policy, delivered via `chrome.storage.managed`
 * or via cryptographically signed policy payloads from the GovernWorld
 * management coordination infrastructure.
 *
 * Consumer/free users have no managed policy and control everything
 * themselves. When a managed policy exists, the administrator controls the
 * protection mode (unless `userCanDisable` is true) and mandates a minimum
 * set of detection categories the user cannot switch off. A UI toggle can
 * never override a locked administrative policy: the lock is enforced where
 * the decision is made, not just by disabling a checkbox.
 *
 * Fail-closed: a present-but-invalid managed policy locks the UI and applies
 * maximum protection (always-on with every category) rather than silently
 * falling back to user control. A broken admin push must never read as
 * "unmanaged".
 */

export interface EnterprisePolicy {
  /** True when any managed policy object was present. */
  managed: boolean;
  /** False when the managed object failed validation (fail-closed applies). */
  valid: boolean;
  /** Enforced mode when locked. */
  protectionMode: ProtectionMode;
  /** When false, the user cannot change the mode or mandated categories. */
  userCanDisable: boolean;
  /** Categories the user cannot disable. */
  enforcedCategories: FindingCategory[];
  /** Network destination fetch policy: "public_only" (default), "managed_intranet", or "disabled". */
  networkDestinationPolicy: NetworkDestinationPolicy;
  /** Internal network allowlist for managed_intranet. */
  networkAllowlist: string[];
  /** Optional admin-mandated per-category confidence thresholds (maximum allowed). */
  confidenceThresholds?: Partial<Record<FindingCategory, number>>;
  /** Optional admin-mandated Document Studio redaction style. */
  defaultRedactionStyle?: RedactionStyle;
  /** Optional admin-mandated Document Studio text stamp. */
  defaultStampText?: string;
  /** Optional admin-mandated single-token name masking setting. */
  autoMaskSingleNames?: boolean;
  /** Optional admin-mandated page character scan cap. */
  maxVisibleChars?: number;
  /** Optional admin-mandated per-node character scan cap. */
  maxNodeChars?: number;
  /** Optional admin-mandated custom detection rules. */
  customRules?: PolicyRule[];
  /** True when an administrator has explicitly unlocked this paired seat for local overrides. */
  seatUnlocked?: boolean;
  /** Per-feature administrator delegations ("Unlock for User"), strictly distinct from toggling on/off. */
  unlockedFeatures?: string[];
  /** Optional metadata from local office coordinator when enrolled via desktop app */
  coordinatorOrigin?: string;
  organizationName?: string;
  policyVersion?: number;
}

export const NO_ENTERPRISE_POLICY: EnterprisePolicy = {
  managed: false,
  valid: true,
  protectionMode: "this-tab",
  userCanDisable: true,
  enforcedCategories: [],
  networkDestinationPolicy: "public_only",
  networkAllowlist: [],
};

/** Maximum-protection fallback for a present-but-invalid managed policy. */
export const FAIL_CLOSED_ENTERPRISE_POLICY: EnterprisePolicy = {
  managed: true,
  valid: false,
  protectionMode: "always-on",
  userCanDisable: false,
  enforcedCategories: [...ALL_CATEGORIES],
  networkDestinationPolicy: "disabled",
  networkAllowlist: [],
};

export function parseEnterprisePolicy(raw: unknown): EnterprisePolicy {
  if (raw === null || raw === undefined) return { ...NO_ENTERPRISE_POLICY };
  if (!isRecord(raw)) return { ...FAIL_CLOSED_ENTERPRISE_POLICY };
  // An explicitly empty object is a valid "no opinion" policy, not corruption.
  const mode = raw.protectionMode === undefined
    ? "this-tab"
    : isProtectionMode(raw.protectionMode)
      ? raw.protectionMode
      : null;
  if (mode === null) return { ...FAIL_CLOSED_ENTERPRISE_POLICY };
  if (raw.userCanDisable !== undefined && typeof raw.userCanDisable !== "boolean") {
    return { ...FAIL_CLOSED_ENTERPRISE_POLICY };
  }
  let enforced: FindingCategory[] = [];
  if (raw.enforcedCategories !== undefined) {
    if (!Array.isArray(raw.enforcedCategories)) return { ...FAIL_CLOSED_ENTERPRISE_POLICY };
    const seen = new Set<FindingCategory>();
    for (const entry of raw.enforcedCategories) {
      if (!isCategory(entry)) return { ...FAIL_CLOSED_ENTERPRISE_POLICY };
      seen.add(entry);
    }
    enforced = [...seen];
  }

  let networkPolicy: NetworkDestinationPolicy = "public_only";
  if (raw.networkDestinationPolicy !== undefined) {
    if (raw.networkDestinationPolicy === "public_only" || raw.networkDestinationPolicy === "managed_intranet" || raw.networkDestinationPolicy === "disabled") {
      networkPolicy = raw.networkDestinationPolicy;
    } else {
      return { ...FAIL_CLOSED_ENTERPRISE_POLICY };
    }
  }

  let allowlist: string[] = [];
  if (raw.networkAllowlist !== undefined) {
    if (!Array.isArray(raw.networkAllowlist)) return { ...FAIL_CLOSED_ENTERPRISE_POLICY };
    for (const item of raw.networkAllowlist) {
      if (typeof item !== "string" || item.length > 512) return { ...FAIL_CLOSED_ENTERPRISE_POLICY };
      allowlist.push(item);
    }
  }

  const coordinatorOrigin = typeof raw.coordinatorOrigin === "string" ? raw.coordinatorOrigin : undefined;
  const organizationName = typeof raw.organizationName === "string" ? raw.organizationName : undefined;
  const policyVersion = typeof raw.policyVersion === "number" ? raw.policyVersion : undefined;

  let confidenceThresholds: Partial<Record<FindingCategory, number>> | undefined;
  if (raw.confidenceThresholds !== undefined) {
    if (!isRecord(raw.confidenceThresholds)) return { ...FAIL_CLOSED_ENTERPRISE_POLICY };
    const parsedThresholds: Partial<Record<FindingCategory, number>> = {};
    for (const [k, v] of Object.entries(raw.confidenceThresholds)) {
      if (!isCategory(k) || typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
        return { ...FAIL_CLOSED_ENTERPRISE_POLICY };
      }
      // eslint-disable-next-line security/detect-object-injection
      parsedThresholds[k] = v;
    }
    confidenceThresholds = parsedThresholds;
  }

  let defaultRedactionStyle: RedactionStyle | undefined;
  if (raw.defaultRedactionStyle !== undefined) {
    if (raw.defaultRedactionStyle !== "blackout" && raw.defaultRedactionStyle !== "whiteout" && raw.defaultRedactionStyle !== "stamp") {
      return { ...FAIL_CLOSED_ENTERPRISE_POLICY };
    }
    defaultRedactionStyle = raw.defaultRedactionStyle;
  }

  let defaultStampText: string | undefined;
  if (raw.defaultStampText !== undefined) {
    if (typeof raw.defaultStampText !== "string" || raw.defaultStampText.trim().length === 0 || raw.defaultStampText.length > 50) {
      return { ...FAIL_CLOSED_ENTERPRISE_POLICY };
    }
    defaultStampText = raw.defaultStampText.trim();
  }

  let autoMaskSingleNames: boolean | undefined;
  if (raw.autoMaskSingleNames !== undefined) {
    if (typeof raw.autoMaskSingleNames !== "boolean") return { ...FAIL_CLOSED_ENTERPRISE_POLICY };
    autoMaskSingleNames = raw.autoMaskSingleNames;
  }

  let maxVisibleChars: number | undefined;
  if (raw.maxVisibleChars !== undefined) {
    if (typeof raw.maxVisibleChars !== "number" || !Number.isFinite(raw.maxVisibleChars) || raw.maxVisibleChars < 100) {
      return { ...FAIL_CLOSED_ENTERPRISE_POLICY };
    }
    maxVisibleChars = raw.maxVisibleChars;
  }

  let maxNodeChars: number | undefined;
  if (raw.maxNodeChars !== undefined) {
    if (typeof raw.maxNodeChars !== "number" || !Number.isFinite(raw.maxNodeChars) || raw.maxNodeChars < 10) {
      return { ...FAIL_CLOSED_ENTERPRISE_POLICY };
    }
    maxNodeChars = raw.maxNodeChars;
  }

  let customRules: PolicyRule[] | undefined;
  if (raw.customRules !== undefined) {
    if (!Array.isArray(raw.customRules)) return { ...FAIL_CLOSED_ENTERPRISE_POLICY };
    customRules = raw.customRules as PolicyRule[];
  }

  let seatUnlocked: boolean | undefined;
  if (raw.seatUnlocked !== undefined) {
    if (typeof raw.seatUnlocked !== "boolean") return { ...FAIL_CLOSED_ENTERPRISE_POLICY };
    seatUnlocked = raw.seatUnlocked;
  }

  let unlockedFeatures: string[] | undefined;
  if (raw.unlockedFeatures !== undefined) {
    if (!Array.isArray(raw.unlockedFeatures) || !raw.unlockedFeatures.every((f) => typeof f === "string" && f.length > 0 && f.length <= 64)) {
      return { ...FAIL_CLOSED_ENTERPRISE_POLICY };
    }
    unlockedFeatures = [...new Set(raw.unlockedFeatures)];
  }

  return {
    managed: true,
    valid: true,
    protectionMode: mode,
    userCanDisable: raw.userCanDisable ?? false,
    enforcedCategories: enforced,
    networkDestinationPolicy: networkPolicy,
    networkAllowlist: allowlist,
    ...(confidenceThresholds ? { confidenceThresholds } : {}),
    ...(defaultRedactionStyle ? { defaultRedactionStyle } : {}),
    ...(defaultStampText !== undefined ? { defaultStampText } : {}),
    ...(autoMaskSingleNames !== undefined ? { autoMaskSingleNames } : {}),
    ...(maxVisibleChars !== undefined ? { maxVisibleChars } : {}),
    ...(maxNodeChars !== undefined ? { maxNodeChars } : {}),
    ...(customRules ? { customRules } : {}),
    ...(seatUnlocked !== undefined ? { seatUnlocked } : {}),
    ...(unlockedFeatures ? { unlockedFeatures } : {}),
    ...(coordinatorOrigin ? { coordinatorOrigin } : {}),
    ...(organizationName ? { organizationName } : {}),
    ...(policyVersion ? { policyVersion } : {}),
  };
}

export const STORAGE_KEY_COORDINATOR_POLICY = "gw_coordinator_policy";
export const STORAGE_KEY_MANAGED_POLICY = "gw_applied_managed_policy";
const STORAGE_KEY_ENROLLMENT = "gw_management_enrollment";

export interface LoadEnterprisePolicyOptions {
  trustedKey?: JsonWebKey | CryptoKey;
}

export async function loadEnterprisePolicy(options?: LoadEnterprisePolicyOptions): Promise<EnterprisePolicy> {
  try {
    // 1. Check GPO / OS managed storage first (highest authority)
    if (typeof chrome !== "undefined" && chrome.storage?.managed) {
      const raw = await chrome.storage.managed.get(null);
      if (raw && Object.keys(raw).length > 0) {
        return parseEnterprisePolicy(raw);
      }
    }
  } catch {
    // Managed storage unreadable or not configured
  }

  if (typeof chrome === "undefined" || !chrome.storage?.local) {
    return { ...NO_ENTERPRISE_POLICY };
  }

  let stored: Record<string, unknown>;
  try {
    stored = await chrome.storage.local.get([
      STORAGE_KEY_MANAGED_POLICY,
      STORAGE_KEY_ENROLLMENT,
      PAIRING_STATE_KEY,
      STORAGE_KEY_COORDINATOR_POLICY,
    ]);
  } catch {
    // Fail closed if local extension storage fails while checking policy state
    return { ...FAIL_CLOSED_ENTERPRISE_POLICY };
  }

  // eslint-disable-next-line security/detect-object-injection
  const applied = stored[STORAGE_KEY_MANAGED_POLICY];
  // eslint-disable-next-line security/detect-object-injection
  const coordPolicy = stored[STORAGE_KEY_COORDINATOR_POLICY];
  // eslint-disable-next-line security/detect-object-injection
  const pairingState = normalizePairingState(stored[PAIRING_STATE_KEY]);

  // 2. Cryptographically re-verify signed administrator policy before enforcing
  if (applied !== undefined && applied !== null) {
    try {
      let enrollment: ManagementEnrollment | null = null;
      // eslint-disable-next-line security/detect-object-injection
      const rawEnrollment = stored[STORAGE_KEY_ENROLLMENT];
      if (
        isRecord(rawEnrollment) &&
        typeof rawEnrollment.organization_id === "string" &&
        rawEnrollment.organization_id.trim().length > 0 &&
        typeof rawEnrollment.employee_id === "string" &&
        rawEnrollment.employee_id.trim().length > 0 &&
        typeof rawEnrollment.device_id === "string" &&
        rawEnrollment.device_id.trim().length > 0
      ) {
        enrollment = rawEnrollment as unknown as ManagementEnrollment;
      } else if (
        (pairingState.status === "paired" || pairingState.status === "paired_offline") &&
        pairingState.organisation_id &&
        pairingState.seat_id
      ) {
        const deviceId = await getInstallationId();
        enrollment = {
          organization_id: pairingState.organisation_id,
          ...(pairingState.organisation_name ? { organization_name: pairingState.organisation_name } : {}),
          employee_id: pairingState.seat_id,
          device_id: deviceId,
          enrolled_at: new Date(0).toISOString(),
          management_mode: "MANAGE",
        };
      }

      if (!enrollment) {
        return { ...FAIL_CLOSED_ENTERPRISE_POLICY };
      }

      const { verifyAndValidateManagedPolicy, managedPolicyToEnterprisePolicy } = await import("./managedPolicy.js");
      const check = await verifyAndValidateManagedPolicy(
        applied,
        enrollment,
        null,
        Date.now(),
        options?.trustedKey,
      );
      if (!check.valid || !check.policy) {
        return { ...FAIL_CLOSED_ENTERPRISE_POLICY };
      }

      const seatUnlocked =
        (pairingState.status === "paired" || pairingState.status === "paired_offline") &&
        pairingState.unlocked === true;

      const mergedUnlockedFeatures = Array.from(
        new Set([
          ...(managedPolicyToEnterprisePolicy(check.policy).unlockedFeatures ?? []),
          ...(Array.isArray(enrollment.unlocked_features) ? enrollment.unlocked_features : []),
        ]),
      );

      return {
        ...managedPolicyToEnterprisePolicy(check.policy),
        ...(seatUnlocked ? { seatUnlocked: true } : {}),
        ...(mergedUnlockedFeatures.length > 0 ? { unlockedFeatures: mergedUnlockedFeatures } : {}),
      };
    } catch {
      return { ...FAIL_CLOSED_ENTERPRISE_POLICY };
    }
  }

  // 3. Reject unsigned/legacy coordinator policy fail-closed
  if (coordPolicy !== undefined && coordPolicy !== null) {
    return { ...FAIL_CLOSED_ENTERPRISE_POLICY };
  }

  return { ...NO_ENTERPRISE_POLICY };
}

export interface EffectiveProtection {
  /** Resolved coverage mode after enterprise policy. */
  mode: ProtectionMode;
  /** True when the user must not be offered a way to change the mode. */
  locked: boolean;
  managed: boolean;
  /** User categories plus admin-mandated ones (admin set can only add). */
  enabledCategories: FindingCategory[];
  /** Categories the UI must render disabled. */
  lockedCategories: FindingCategory[];
}

/**
 * Resolve what actually enforces. The enterprise policy can only add
 * protection relative to user settings, never remove it: a user who enables
 * more than the admin requires keeps the wider coverage.
 */
export function resolveEffectiveProtection(
  settings: Settings,
  policy: EnterprisePolicy
): EffectiveProtection {
  if (policy.managed && !policy.valid) {
    return {
      mode: FAIL_CLOSED_ENTERPRISE_POLICY.protectionMode,
      locked: true,
      managed: true,
      enabledCategories: [...ALL_CATEGORIES],
      lockedCategories: [...ALL_CATEGORIES],
    };
  }

  const enforced = new Set<FindingCategory>(policy.enforcedCategories);
  const enabled = new Set<FindingCategory>([...settings.enabledCategories, ...enforced]);
  if (!policy.managed) {
    return {
      mode: settings.protectionMode,
      locked: false,
      managed: false,
      enabledCategories: [...enabled],
      lockedCategories: [],
    };
  }

  if (policy.seatUnlocked === true) {
    return {
      mode: settings.protectionMode,
      locked: false,
      managed: true,
      enabledCategories: [...settings.enabledCategories],
      lockedCategories: [],
    };
  }

  const unlockedSet = new Set(policy.unlockedFeatures ?? []);
  const modeUnlocked = unlockedSet.has("protectionMode");
  const categoriesUnlocked = unlockedSet.has("enabledCategories") || unlockedSet.has("categories");

  if (!policy.userCanDisable) {
    // Locked: the admin mode is a floor, never a ceiling. An admin "off" is
    // explicit and wins outright; otherwise the wider of the admin and user
    // modes enforces, so a user who enables more keeps the wider coverage.
    if (modeUnlocked) {
      return {
        mode: settings.protectionMode,
        locked: false,
        managed: true,
        enabledCategories: categoriesUnlocked ? [...settings.enabledCategories] : [...enabled],
        lockedCategories: categoriesUnlocked ? [] : [...enforced],
      };
    }
    const adminMode = policy.protectionMode;
    if (adminMode === "off") {
      return {
        mode: "off",
        locked: true,
        managed: true,
        enabledCategories: categoriesUnlocked ? [...settings.enabledCategories] : [...enforced],
        lockedCategories: categoriesUnlocked ? [] : [...enforced],
      };
    }
    const rank: Record<ProtectionMode, number> = { off: 0, "this-tab": 1, "always-on": 2 };
    const userMode = settings.protectionMode;
    return {
      // eslint-disable-next-line security/detect-object-injection
      mode: rank[userMode] >= rank[adminMode] ? userMode : adminMode,
      locked: true,
      managed: true,
      enabledCategories: categoriesUnlocked ? [...settings.enabledCategories] : [...enabled],
      lockedCategories: categoriesUnlocked ? [] : [...enforced],
    };
  }
  return {
    mode: settings.protectionMode,
    locked: false,
    managed: true,
    enabledCategories: categoriesUnlocked ? [...settings.enabledCategories] : [...enabled],
    lockedCategories: categoriesUnlocked ? [] : [...enforced],
  };
}

/** Load settings + managed policy together and resolve the live protection. */
export async function loadEffectiveProtection(
  loadSettings: () => Promise<Settings>
): Promise<{ settings: Settings; policy: EnterprisePolicy; effective: EffectiveProtection }> {
  const [settings, policy] = await Promise.all([loadSettings(), loadEnterprisePolicy()]);
  return { settings, policy, effective: resolveEffectiveProtection(settings, policy) };
}
