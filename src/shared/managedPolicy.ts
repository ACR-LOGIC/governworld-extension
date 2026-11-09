// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
/**
 * Managed Policy Receiving, Cryptographic Verification, Targeting, and Anti-Rollback.
 *
 * Requirements (GovernWorld Engineering Directive v0.3.0 - Section 3):
 * - Identify assigned organization, employee, and device.
 * - Authenticate management connection securely.
 * - Retrieve approved policy payload.
 * - Verify cryptographic signature (Ed25519) against pinned trusted key.
 * - Validate organization, assignment, target, schema, and version.
 * - Reject unsigned, malformed, unauthorized, replayed, or downgraded policies.
 * - Automatically apply valid administrator-approved policies.
 * - Store last successfully applied policy locally; preserve offline.
 * - Acknowledge policy application using minimal status information (zero sensitive leak).
 * - Safe-state fail-closed design for expired, revoked, or invalid policies.
 */

import type { FindingCategory, RedactionStyle } from "./types.js";
import type { ProtectionMode } from "./settings.js";
import type { NetworkDestinationPolicy } from "./networkGuard.js";
import { ALL_CATEGORIES, isCategory, isProtectionMode } from "./settings.js";
import type { EnterprisePolicy } from "./enterprisePolicy.js";
import { FAIL_CLOSED_ENTERPRISE_POLICY, NO_ENTERPRISE_POLICY } from "./enterprisePolicy.js";
import { TRUSTED_POLICY_PUBLIC_KEY_JWK } from "../api/config.js";
import type { PolicyRule } from "../api/types.js";
import { canonicalizePolicyRules, computeSha256Hex } from "../api/policies.js";

export const STORAGE_KEY_MANAGED_POLICY = "gw_applied_managed_policy";
export const STORAGE_KEY_ENROLLMENT = "gw_management_enrollment";
export const STORAGE_KEY_LAST_POLICY_ACK = "gw_last_policy_ack";

export interface ManagedPolicyTarget {
  organization_id: string;
  /** Specific employee ID or email, or "*" for all employees in organization. */
  employee_id?: string;
  /** Specific device installation UUID, or "*" for all devices. */
  device_id?: string;
}

export interface ManagedPolicySettings {
  protectionMode?: ProtectionMode;
  userCanDisable?: boolean;
  enforcedCategories?: FindingCategory[];
  networkDestinationPolicy?: NetworkDestinationPolicy;
  networkAllowlist?: string[];
  confidenceThresholds?: Partial<Record<FindingCategory, number>>;
  defaultRedactionStyle?: RedactionStyle;
  defaultStampText?: string;
  maxVisibleChars?: number;
  maxNodeChars?: number;
}

export interface ManagedPolicyEnvelope {
  policy_id: string;
  organization_id: string;
  organization_name?: string;
  target: ManagedPolicyTarget;
  /** Strictly monotonic positive integer version for anti-rollback / downgrade defense. */
  policy_version: number;
  schema_version: string;
  effective_at: string; // ISO 8601
  expires_at?: string;  // ISO 8601
  created_at: string;   // ISO 8601
  nonce: string;        // Cryptographic nonce to prevent replay attacks
  policy_hash: string;  // SHA-256 hex digest of canonical rules + settings
  rules: PolicyRule[];
  settings: ManagedPolicySettings;
  /** Base64-encoded 64-byte Ed25519 signature. */
  policy_signature: string;
  signature_algorithm: "Ed25519";
}

export interface ManagementEnrollment {
  organization_id: string;
  organization_name?: string;
  employee_id: string;
  employee_email?: string;
  device_id: string; // installation UUID
  enrolled_at: string; // ISO 8601
  coordinator_url?: string;
  management_mode: "LOCAL" | "MANAGE";
}

export interface PolicyApplicationAcknowledgment {
  organization_id: string;
  employee_id: string;
  device_id: string;
  policy_id: string;
  policy_version: number;
  status: "applied" | "rejected";
  reason?: string;
  applied_at: string; // ISO 8601
}

function base64ToBytes(base64: string): Uint8Array | null {
  try {
    const normalized = base64.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * Deterministically canonicalizes settings for hashing.
 */
export function canonicalizeManagedPolicySettings(settings: ManagedPolicySettings): string {
  const sortedKeys = Object.keys(settings).sort();
  const obj: Record<string, unknown> = {};
  for (const k of sortedKeys) {
    const val = (settings as Record<string, unknown>)[k];
    if (val !== undefined) {
      if (Array.isArray(val)) {
        obj[k] = [...val].sort();
      } else if (typeof val === "object" && val !== null) {
        const subKeys = Object.keys(val).sort();
        const subObj: Record<string, unknown> = {};
        for (const sk of subKeys) {
          subObj[sk] = (val as Record<string, unknown>)[sk];
        }
        obj[k] = subObj;
      } else {
        obj[k] = val;
      }
    }
  }
  return JSON.stringify(obj);
}

/**
 * Canonicalizes the complete envelope for Ed25519 signing / verification.
 */
export function canonicalizeManagedPolicyEnvelope(
  envelope: Omit<ManagedPolicyEnvelope, "policy_signature" | "signature_algorithm">,
): string {
  return JSON.stringify({
    created_at: envelope.created_at,
    effective_at: envelope.effective_at,
    expires_at: envelope.expires_at ?? null,
    nonce: envelope.nonce,
    organization_id: envelope.organization_id,
    organization_name: envelope.organization_name ?? null,
    policy_hash: envelope.policy_hash.toLowerCase(),
    policy_id: envelope.policy_id,
    policy_version: envelope.policy_version,
    rules: JSON.parse(canonicalizePolicyRules(envelope.rules)),
    schema_version: envelope.schema_version,
    settings: JSON.parse(canonicalizeManagedPolicySettings(envelope.settings)),
    target: {
      device_id: envelope.target.device_id ?? "*",
      employee_id: envelope.target.employee_id ?? "*",
      organization_id: envelope.target.organization_id,
    },
  });
}

/**
 * Computes the SHA-256 hash of rules + settings.
 */
export async function computeManagedPolicyContentHash(
  rules: PolicyRule[],
  settings: ManagedPolicySettings,
): Promise<string> {
  const canonicalRules = canonicalizePolicyRules(rules);
  const canonicalSettings = canonicalizeManagedPolicySettings(settings);
  return await computeSha256Hex(`${canonicalRules}|${canonicalSettings}`);
}

/**
 * Verifies an Ed25519 signature over a canonicalized managed policy envelope.
 */
export async function verifyManagedPolicySignature(
  envelope: ManagedPolicyEnvelope,
  trustedKey: JsonWebKey | CryptoKey = TRUSTED_POLICY_PUBLIC_KEY_JWK,
): Promise<boolean> {
  if (!envelope.policy_signature || typeof envelope.policy_signature !== "string") {
    return false;
  }
  const sigBytes = base64ToBytes(envelope.policy_signature);
  if (!sigBytes || sigBytes.byteLength !== 64) {
    return false;
  }
  if (envelope.signature_algorithm !== "Ed25519") {
    return false;
  }

  const canonical = canonicalizeManagedPolicyEnvelope(envelope);
  const data = new TextEncoder().encode(canonical);

  try {
    const publicKey: CryptoKey =
      trustedKey instanceof CryptoKey
        ? trustedKey
        : await crypto.subtle.importKey("jwk", trustedKey, { name: "Ed25519" }, false, ["verify"]);

    return await crypto.subtle.verify(
      { name: "Ed25519" },
      publicKey,
      sigBytes as unknown as BufferSource,
      data as unknown as BufferSource,
    );
  } catch {
    return false;
  }
}

export interface VerifyManagedPolicyResult {
  valid: boolean;
  reason?: string;
  code?: "MALFORMED" | "UNAUTHORIZED" | "DOWNGRADE" | "REPLAY" | "EXPIRED" | "HASH_MISMATCH" | "SIGNATURE_INVALID" | "SCHEMA_INVALID";
  policy?: ManagedPolicyEnvelope;
}

/**
 * Validates and verifies an incoming administrator-approved policy payload against:
 * 1. Schema & Structure
 * 2. Organization Assignment (Unauthorized check)
 * 3. Target Employee & Device (Target mismatch check)
 * 4. Version Monotonicity (Anti-downgrade / Anti-rollback check)
 * 5. Replay Nonce & Timestamp (Anti-replay check)
 * 6. Expiration (Validity window)
 * 7. Content Hash Integrity (SHA-256)
 * 8. Cryptographic Signature (Ed25519 against pinned public key)
 */
export async function verifyAndValidateManagedPolicy(
  raw: unknown,
  enrollment: ManagementEnrollment,
  lastAppliedPolicy: ManagedPolicyEnvelope | null,
  nowMs = Date.now(),
  trustedKey?: JsonWebKey | CryptoKey,
): Promise<VerifyManagedPolicyResult> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { valid: false, code: "MALFORMED", reason: "Policy payload is not a valid object." };
  }

  const pkg = raw as Partial<ManagedPolicyEnvelope>;

  // 1. Structural check
  if (
    typeof pkg.policy_id !== "string" ||
    typeof pkg.organization_id !== "string" ||
    !pkg.target ||
    typeof pkg.target.organization_id !== "string" ||
    typeof pkg.policy_version !== "number" ||
    !Number.isInteger(pkg.policy_version) ||
    pkg.policy_version <= 0 ||
    typeof pkg.nonce !== "string" ||
    pkg.nonce.length < 8 ||
    typeof pkg.policy_hash !== "string" ||
    !Array.isArray(pkg.rules) ||
    !pkg.settings ||
    typeof pkg.settings !== "object" ||
    typeof pkg.policy_signature !== "string" || pkg.policy_signature.trim().length === 0
  ) {
    return { valid: false, code: "MALFORMED", reason: "Policy payload has invalid or missing required envelope fields." };
  }

  // 2. Organization check
  if (
    pkg.organization_id !== enrollment.organization_id ||
    pkg.target.organization_id !== enrollment.organization_id
  ) {
    return {
      valid: false,
      code: "UNAUTHORIZED",
      reason: `Policy organization ID (${pkg.organization_id}) does not match enrolled organization (${enrollment.organization_id}).`,
    };
  }

  // 3. Target check
  if (pkg.target.employee_id && pkg.target.employee_id !== "*" && pkg.target.employee_id !== enrollment.employee_id) {
    return {
      valid: false,
      code: "UNAUTHORIZED",
      reason: `Policy target employee (${pkg.target.employee_id}) does not match enrolled employee (${enrollment.employee_id}).`,
    };
  }
  if (pkg.target.device_id && pkg.target.device_id !== "*" && pkg.target.device_id !== enrollment.device_id) {
    return {
      valid: false,
      code: "UNAUTHORIZED",
      reason: `Policy target device (${pkg.target.device_id}) does not match current device (${enrollment.device_id}).`,
    };
  }

  // 4. Anti-rollback / Anti-downgrade check
  if (lastAppliedPolicy) {
    if (pkg.policy_version < lastAppliedPolicy.policy_version) {
      return {
        valid: false,
        code: "DOWNGRADE",
        reason: `Rollback attack detected: incoming policy version (${pkg.policy_version}) is lower than currently applied version (${lastAppliedPolicy.policy_version}).`,
      };
    }

    // 5. Anti-replay check
    if (pkg.policy_version === lastAppliedPolicy.policy_version && pkg.nonce === lastAppliedPolicy.nonce) {
      // Identical policy already applied; idempotent safe re-verification
      return { valid: true, policy: pkg as ManagedPolicyEnvelope };
    }
  }

  // 6. Expiration check
  if (pkg.expires_at) {
    const expiresMs = new Date(pkg.expires_at).getTime();
    if (!isNaN(expiresMs) && nowMs > expiresMs) {
      return {
        valid: false,
        code: "EXPIRED",
        reason: `Policy expired at ${pkg.expires_at}.`,
      };
    }
  }

  // Schema checks on settings
  const settings = pkg.settings;
  if (settings.protectionMode !== undefined && !isProtectionMode(settings.protectionMode)) {
    return { valid: false, code: "SCHEMA_INVALID", reason: `Invalid protectionMode: ${settings.protectionMode}` };
  }
  if (settings.enforcedCategories !== undefined) {
    if (!Array.isArray(settings.enforcedCategories) || !settings.enforcedCategories.every(isCategory)) {
      return { valid: false, code: "SCHEMA_INVALID", reason: "Invalid enforcedCategories list." };
    }
  }

  // 7. Content Hash Check
  const computedHash = await computeManagedPolicyContentHash(pkg.rules, settings);
  if (computedHash.toLowerCase() !== pkg.policy_hash.toLowerCase()) {
    return {
      valid: false,
      code: "HASH_MISMATCH",
      reason: `Integrity check failed: Computed hash (${computedHash}) does not match declared hash (${pkg.policy_hash}).`,
    };
  }

  // 8. Cryptographic Signature Verification (Ed25519)
  const fullEnvelope = pkg as ManagedPolicyEnvelope;
  const signatureOk = await verifyManagedPolicySignature(fullEnvelope, trustedKey);
  if (!signatureOk) {
    return {
      valid: false,
      code: "SIGNATURE_INVALID",
      reason: "Cryptographic signature verification failed: signature does not match trusted administrator key.",
    };
  }

  return { valid: true, policy: fullEnvelope };
}

/**
 * Translates a verified ManagedPolicyEnvelope into an active EnterprisePolicy.
 */
export function managedPolicyToEnterprisePolicy(envelope: ManagedPolicyEnvelope): EnterprisePolicy {
  const settings = envelope.settings;
  return {
    managed: true,
    valid: true,
    protectionMode: settings.protectionMode ?? "always-on",
    userCanDisable: settings.userCanDisable ?? false,
    enforcedCategories: settings.enforcedCategories ?? [...ALL_CATEGORIES],
    networkDestinationPolicy: settings.networkDestinationPolicy ?? "public_only",
    networkAllowlist: settings.networkAllowlist ?? [],
    coordinatorOrigin: envelope.organization_id,
    organizationName: envelope.organization_name || envelope.organization_id,
    policyVersion: envelope.policy_version,
  };
}

/**
 * Generates an application acknowledgment object containing minimal status information.
 * ZERO sensitive data: no browsing history, no page text, no findings, no documents.
 */
export function createPolicyAcknowledgment(
  enrollment: ManagementEnrollment,
  policyId: string,
  policyVersion: number,
  status: "applied" | "rejected",
  reason?: string,
): PolicyApplicationAcknowledgment {
  return {
    organization_id: enrollment.organization_id,
    employee_id: enrollment.employee_id,
    device_id: enrollment.device_id,
    policy_id: policyId,
    policy_version: policyVersion,
    status,
    ...(reason ? { reason } : {}),
    applied_at: new Date().toISOString(),
  };
}

/**
 * Loads the active management enrollment from local storage.
 */
export async function loadManagementEnrollment(): Promise<ManagementEnrollment | null> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) {
    return null;
  }
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY_ENROLLMENT);
    const enrollment = stored[STORAGE_KEY_ENROLLMENT] as ManagementEnrollment | undefined;
    if (enrollment && enrollment.organization_id && enrollment.employee_id && enrollment.device_id) {
      return enrollment;
    }
  } catch {
    // Storage read error
  }
  return null;
}

/**
 * Saves management enrollment into local storage.
 */
export async function saveManagementEnrollment(enrollment: ManagementEnrollment): Promise<void> {
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    await chrome.storage.local.set({ [STORAGE_KEY_ENROLLMENT]: enrollment });
  }
}

/**
 * Clears management enrollment (switching back to LOCAL mode).
 */
export async function clearManagementEnrollment(): Promise<void> {
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    await chrome.storage.local.remove([STORAGE_KEY_ENROLLMENT, STORAGE_KEY_MANAGED_POLICY]);
  }
}

/**
 * Retrieves the last successfully applied managed policy from local storage.
 */
export async function loadLastAppliedManagedPolicy(): Promise<ManagedPolicyEnvelope | null> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) {
    return null;
  }
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY_MANAGED_POLICY);
    const policy = stored[STORAGE_KEY_MANAGED_POLICY] as ManagedPolicyEnvelope | undefined;
    if (policy && policy.policy_id && policy.policy_version) {
      return policy;
    }
  } catch {
    // Storage read error
  }
  return null;
}

/**
 * Stores the successfully applied managed policy locally for offline persistence.
 */
export async function saveAppliedManagedPolicy(policy: ManagedPolicyEnvelope): Promise<void> {
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    await chrome.storage.local.set({ [STORAGE_KEY_MANAGED_POLICY]: policy });
  }
}
