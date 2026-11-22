import { bytesToBase64, sha256Hex } from "./crypto.ts";

export const ALL_CATEGORIES = [
  "email",
  "phone",
  "ssn",
  "dob",
  "medical_record_number",
  "member_id",
  "npi",
  "dea",
  "mbi",
  "address",
  "payment_card",
  "secrets",
  "possible_name",
  "custom",
  "canadian_sin",
  "uk_nhs",
  "aadhaar",
  "pan_india",
  "australian_tfn",
  "cpf",
  "ip_address",
  "username",
  "bank_account",
  "financial",
] as const;

const CATEGORY_SET = new Set<string>(ALL_CATEGORIES);
const PROTECTION_MODES = new Set(["off", "this-tab", "always-on"]);
const NETWORK_DEST_POLICIES = new Set(["public_only", "managed_intranet", "disabled"]);
const REDACTION_STYLES = new Set(["blackout", "whiteout", "stamp"]);

const RFC_8032_TEST_VECTOR_1_X = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";

export interface PolicyRule {
  id: string;
  category: string;
  pattern: string;
  cues?: string[];
  confidence: number;
  description?: string;
}

export interface ManagedPolicySettings {
  protectionMode?: "off" | "this-tab" | "always-on";
  userCanDisable?: boolean;
  enforcedCategories?: string[];
  networkDestinationPolicy?: "public_only" | "managed_intranet" | "disabled";
  networkAllowlist?: string[];
  confidenceThresholds?: Record<string, number>;
  defaultRedactionStyle?: "blackout" | "whiteout" | "stamp";
  defaultStampText?: string;
  maxVisibleChars?: number;
  maxNodeChars?: number;
}

export interface ManagedPolicyEnvelope {
  policy_id: string;
  organization_id: string;
  organization_name?: string;
  target: {
    organization_id: string;
    employee_id?: string;
    device_id?: string;
  };
  policy_version: number;
  schema_version: string;
  effective_at: string;
  expires_at?: string;
  created_at: string;
  nonce: string;
  policy_hash: string;
  rules: PolicyRule[];
  settings: ManagedPolicySettings;
  policy_signature: string;
  signature_algorithm: "Ed25519";
}

export class PolicySigningNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicySigningNotConfiguredError";
  }
}

export class PolicyBodyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyBodyValidationError";
  }
}

/**
 * Byte-exact port of src/api/policies.ts:canonicalizePolicyRules
 */
export function canonicalizePolicyRules(rules: PolicyRule[]): string {
  const sorted = [...rules].sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify(
    sorted.map((r) => ({
      category: r.category,
      confidence: r.confidence,
      cues: r.cues ? [...r.cues].sort() : undefined,
      description: r.description,
      id: r.id,
      pattern: r.pattern,
    })),
  );
}

/**
 * Byte-exact port of src/shared/managedPolicy.ts:canonicalizeManagedPolicySettings
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
 * Byte-exact port of src/shared/managedPolicy.ts:computeManagedPolicyContentHash
 */
export async function computeManagedPolicyContentHash(
  rules: PolicyRule[],
  settings: ManagedPolicySettings,
): Promise<string> {
  const canonicalRules = canonicalizePolicyRules(rules);
  const canonicalSettings = canonicalizeManagedPolicySettings(settings);
  return await sha256Hex(`${canonicalRules}|${canonicalSettings}`);
}

/**
 * Byte-exact port of src/shared/managedPolicy.ts:canonicalizeManagedPolicyEnvelope
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

function validateRule(raw: unknown, idx: number): PolicyRule {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PolicyBodyValidationError(`rules[${idx}] must be an object`);
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.trim().length === 0) {
    throw new PolicyBodyValidationError(`rules[${idx}].id must be a non-empty string`);
  }
  if (typeof r.category !== "string" || !CATEGORY_SET.has(r.category)) {
    throw new PolicyBodyValidationError(`rules[${idx}].category is invalid`);
  }
  if (typeof r.pattern !== "string" || r.pattern.length === 0) {
    throw new PolicyBodyValidationError(`rules[${idx}].pattern must be a non-empty string`);
  }
  if (typeof r.confidence !== "number" || !Number.isFinite(r.confidence) || r.confidence < 0 || r.confidence > 1) {
    throw new PolicyBodyValidationError(`rules[${idx}].confidence must be in [0, 1]`);
  }
  const rule: PolicyRule = {
    id: r.id.trim(),
    category: r.category,
    pattern: r.pattern,
    confidence: r.confidence,
  };
  if (r.cues !== undefined) {
    if (!Array.isArray(r.cues) || !r.cues.every((c) => typeof c === "string")) {
      throw new PolicyBodyValidationError(`rules[${idx}].cues must be string[]`);
    }
    rule.cues = r.cues;
  }
  if (r.description !== undefined) {
    if (typeof r.description !== "string") {
      throw new PolicyBodyValidationError(`rules[${idx}].description must be string`);
    }
    rule.description = r.description;
  }
  return rule;
}

export function normalizeAndValidatePolicyBody(raw: unknown): {
  settings: ManagedPolicySettings;
  rules: PolicyRule[];
} {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PolicyBodyValidationError("Policy body must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  const rawSettings =
    obj.settings && typeof obj.settings === "object" && !Array.isArray(obj.settings)
      ? (obj.settings as Record<string, unknown>)
      : obj;

  const settings: ManagedPolicySettings = {};

  if (rawSettings.protectionMode !== undefined) {
    if (typeof rawSettings.protectionMode !== "string" || !PROTECTION_MODES.has(rawSettings.protectionMode)) {
      throw new PolicyBodyValidationError("Invalid settings.protectionMode");
    }
    settings.protectionMode = rawSettings.protectionMode as ManagedPolicySettings["protectionMode"];
  }

  if (rawSettings.userCanDisable !== undefined) {
    if (typeof rawSettings.userCanDisable !== "boolean") {
      throw new PolicyBodyValidationError("Invalid settings.userCanDisable");
    }
    settings.userCanDisable = rawSettings.userCanDisable;
  }

  if (rawSettings.enforcedCategories !== undefined) {
    if (
      !Array.isArray(rawSettings.enforcedCategories) ||
      !rawSettings.enforcedCategories.every((c) => typeof c === "string" && CATEGORY_SET.has(c))
    ) {
      throw new PolicyBodyValidationError("Invalid settings.enforcedCategories");
    }
    settings.enforcedCategories = [...new Set(rawSettings.enforcedCategories as string[])];
  }

  if (rawSettings.networkDestinationPolicy !== undefined) {
    if (
      typeof rawSettings.networkDestinationPolicy !== "string" ||
      !NETWORK_DEST_POLICIES.has(rawSettings.networkDestinationPolicy)
    ) {
      throw new PolicyBodyValidationError("Invalid settings.networkDestinationPolicy");
    }
    settings.networkDestinationPolicy =
      rawSettings.networkDestinationPolicy as ManagedPolicySettings["networkDestinationPolicy"];
  }

  if (rawSettings.networkAllowlist !== undefined) {
    if (
      !Array.isArray(rawSettings.networkAllowlist) ||
      !rawSettings.networkAllowlist.every((h) => typeof h === "string" && h.trim().length > 0 && h.length <= 253)
    ) {
      throw new PolicyBodyValidationError("Invalid settings.networkAllowlist");
    }
    settings.networkAllowlist = rawSettings.networkAllowlist.map((h) => h.trim());
  }

  if (rawSettings.confidenceThresholds !== undefined) {
    if (
      !rawSettings.confidenceThresholds ||
      typeof rawSettings.confidenceThresholds !== "object" ||
      Array.isArray(rawSettings.confidenceThresholds)
    ) {
      throw new PolicyBodyValidationError("Invalid settings.confidenceThresholds");
    }
    const cleanThresholds: Record<string, number> = {};
    for (const [k, v] of Object.entries(rawSettings.confidenceThresholds as Record<string, unknown>)) {
      if (!CATEGORY_SET.has(k) || typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
        throw new PolicyBodyValidationError(`Invalid confidenceThresholds.${k}`);
      }
      cleanThresholds[k] = v;
    }
    settings.confidenceThresholds = cleanThresholds;
  }

  if (rawSettings.defaultRedactionStyle !== undefined) {
    if (typeof rawSettings.defaultRedactionStyle !== "string" || !REDACTION_STYLES.has(rawSettings.defaultRedactionStyle)) {
      throw new PolicyBodyValidationError("Invalid settings.defaultRedactionStyle");
    }
    settings.defaultRedactionStyle =
      rawSettings.defaultRedactionStyle as ManagedPolicySettings["defaultRedactionStyle"];
  }

  if (rawSettings.defaultStampText !== undefined) {
    if (typeof rawSettings.defaultStampText !== "string" || rawSettings.defaultStampText.length > 64) {
      throw new PolicyBodyValidationError("Invalid settings.defaultStampText");
    }
    settings.defaultStampText = rawSettings.defaultStampText;
  }

  if (rawSettings.maxVisibleChars !== undefined) {
    if (
      typeof rawSettings.maxVisibleChars !== "number" ||
      !Number.isInteger(rawSettings.maxVisibleChars) ||
      rawSettings.maxVisibleChars < 1000 ||
      rawSettings.maxVisibleChars > 5_000_000
    ) {
      throw new PolicyBodyValidationError("Invalid settings.maxVisibleChars");
    }
    settings.maxVisibleChars = rawSettings.maxVisibleChars;
  }

  if (rawSettings.maxNodeChars !== undefined) {
    if (
      typeof rawSettings.maxNodeChars !== "number" ||
      !Number.isInteger(rawSettings.maxNodeChars) ||
      rawSettings.maxNodeChars < 100 ||
      rawSettings.maxNodeChars > 1_000_000
    ) {
      throw new PolicyBodyValidationError("Invalid settings.maxNodeChars");
    }
    settings.maxNodeChars = rawSettings.maxNodeChars;
  }

  let rules: PolicyRule[] = [];
  if (obj.rules !== undefined) {
    if (!Array.isArray(obj.rules)) {
      throw new PolicyBodyValidationError("Policy rules must be an array");
    }
    rules = obj.rules.map((r, idx) => validateRule(r, idx));
  }

  return { settings, rules };
}

let cachedSigningKey: CryptoKey | null = null;
let cachedKeyRaw = "";

async function getEd25519SigningKey(): Promise<CryptoKey> {
  const raw = Deno.env.get("GW_POLICY_SIGNING_PRIVATE_KEY_JWK");
  if (!raw || raw.trim().length === 0) {
    throw new PolicySigningNotConfiguredError(
      "GW_POLICY_SIGNING_PRIVATE_KEY_JWK secret is not configured",
    );
  }
  if (cachedSigningKey && cachedKeyRaw === raw) {
    return cachedSigningKey;
  }

  let parsed: JsonWebKey;
  try {
    parsed = JSON.parse(raw) as JsonWebKey;
  } catch {
    throw new PolicySigningNotConfiguredError("Invalid GW_POLICY_SIGNING_PRIVATE_KEY_JWK JSON");
  }

  if (
    parsed.kty !== "OKP" ||
    parsed.crv !== "Ed25519" ||
    typeof parsed.d !== "string" ||
    parsed.d.length === 0 ||
    typeof parsed.x !== "string" ||
    parsed.x.length === 0
  ) {
    throw new PolicySigningNotConfiguredError("Invalid Ed25519 private JWK fields");
  }

  if (parsed.x === RFC_8032_TEST_VECTOR_1_X) {
    throw new PolicySigningNotConfiguredError(
      "Refusing to sign with RFC 8032 Test Vector 1 key in production",
    );
  }

  const key = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "OKP",
      crv: "Ed25519",
      x: parsed.x,
      d: parsed.d,
      ext: false,
      key_ops: ["sign"],
    },
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  cachedSigningKey = key;
  cachedKeyRaw = raw;
  return key;
}

const DEFAULT_POLICY_ENVELOPE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function buildAndSignManagedPolicyEnvelope(params: {
  policy: { id: string; body: unknown } | null;
  organisation_id: string;
  organisation_name: string;
  seat_id: string;
  installation_id: string;
  unlocked: boolean;
  policy_seq: number;
}): Promise<{ policy_envelope: ManagedPolicyEnvelope | null; policy_version: number }> {
  if (!params.policy) {
    return { policy_envelope: null, policy_version: 0 };
  }

  const signingKey = await getEd25519SigningKey();
  const normalized = normalizeAndValidatePolicyBody(params.policy.body ?? {});
  const effectiveSettings: ManagedPolicySettings = {
    ...normalized.settings,
    userCanDisable: params.unlocked ? true : (normalized.settings.userCanDisable ?? false),
  };

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const expiresIso = new Date(nowMs + DEFAULT_POLICY_ENVELOPE_TTL_MS).toISOString();
  const policyVersion = Math.max(1, Math.trunc(Number(params.policy_seq) || 1));

  const policyHash = await computeManagedPolicyContentHash(normalized.rules, effectiveSettings);

  const unsignedEnvelope: Omit<ManagedPolicyEnvelope, "policy_signature" | "signature_algorithm"> = {
    policy_id: params.policy.id,
    organization_id: params.organisation_id,
    organization_name: params.organisation_name,
    target: {
      organization_id: params.organisation_id,
      employee_id: params.seat_id,
      device_id: params.installation_id,
    },
    policy_version: policyVersion,
    schema_version: "2026-11",
    effective_at: nowIso,
    expires_at: expiresIso,
    created_at: nowIso,
    nonce: crypto.randomUUID(),
    policy_hash: policyHash,
    rules: normalized.rules,
    settings: effectiveSettings,
  };

  const canonical = canonicalizeManagedPolicyEnvelope(unsignedEnvelope);
  const sigBuf = await crypto.subtle.sign(
    { name: "Ed25519" },
    signingKey,
    new TextEncoder().encode(canonical),
  );

  return {
    policy_envelope: {
      ...unsignedEnvelope,
      policy_signature: bytesToBase64(new Uint8Array(sigBuf)),
      signature_algorithm: "Ed25519",
    },
    policy_version: policyVersion,
  };
}
