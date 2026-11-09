// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
/**
 * Policy synchronization, SHA-256 integrity, and Ed25519 cryptographic
 * signature verification (Item 14: Move From Hash Verification to Signed Policies).
 *
 * Hashes prove integrity; Ed25519 signatures prove authorship.
 * Corrupted, tampered, unsigned (when required), or expired policy payloads
 * are rejected immediately (fail-closed).
 */

import { GovernWorldApiClient } from "./client.js";
import type { PolicyPackage, PolicyRule } from "./types.js";
import { PolicyTelemetry, SecurityTelemetry } from "../shared/telemetry.js";

const STORAGE_KEY_CACHED_POLICY = "gw_cached_policy";

export interface VerifyPolicyIntegrityOptions {
  /** When true, rejects packages that do not carry a valid cryptographic signature. */
  requireSignature?: boolean;
  /** Pinned/trusted Ed25519 public key JWK to verify against. */
  trustedPublicKeyJwk?: JsonWebKey;
}

/**
 * Canonicalizes a policy's rules into a deterministic JSON string for hashing.
 */
export function canonicalizePolicyRules(rules: PolicyRule[]): string {
  // Sort rules by id to ensure order-independence
  const sorted = [...rules].sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify(
    sorted.map((r) => ({
      category: r.category,
      confidence: r.confidence,
      cues: r.cues ? [...r.cues].sort() : undefined,
      description: r.description,
      id: r.id,
      pattern: r.pattern,
    }))
  );
}

/**
 * Canonicalizes the entire policy package envelope + rules into a deterministic
 * UTF-8 string for Ed25519 signing and verification.
 */
export function canonicalizePolicyPackageForSigning(pkg: PolicyPackage): string {
  return JSON.stringify({
    effective_at: pkg.effective_at,
    expires_at: pkg.expires_at ?? null,
    policy_hash: pkg.policy_hash.toLowerCase(),
    policy_id: pkg.policy_id,
    policy_version: pkg.policy_version,
    rules: JSON.parse(canonicalizePolicyRules(pkg.rules)),
  });
}

/**
 * Computes the SHA-256 hex digest of a string using Web Crypto API.
 */
export async function computeSha256Hex(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
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
 * Generates an Ed25519 key pair for signing and verifying policy packages.
 */
export async function generateEd25519PolicyKeyPair(): Promise<{
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicKeyJwk: JsonWebKey;
}> {
  const pair = (await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const publicKeyJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicKeyJwk,
  };
}

/**
 * Signs a canonicalized policy package using an Ed25519 private key.
 * Returns a Base64-encoded signature.
 */
export async function signPolicyPackageEd25519(
  pkg: PolicyPackage,
  privateKey: CryptoKey,
): Promise<string> {
  const canonical = canonicalizePolicyPackageForSigning(pkg);
  const data = new TextEncoder().encode(canonical);
  const sigBuf = await crypto.subtle.sign({ name: "Ed25519" }, privateKey, data);
  return bytesToBase64(new Uint8Array(sigBuf));
}

/**
 * Verifies an Ed25519 (or ECDSA-P256 fallback) signature on a policy package.
 */
export async function verifyPolicySignatureEd25519(
  pkg: PolicyPackage,
  trustedKey?: CryptoKey | JsonWebKey,
): Promise<boolean> {
  if (!pkg.policy_signature || typeof pkg.policy_signature !== "string") {
    return false;
  }
  const sigBytes = base64ToBytes(pkg.policy_signature);
  if (!sigBytes || sigBytes.byteLength === 0) return false;

  const keySource = trustedKey ?? pkg.public_key_jwk;
  if (!keySource) return false;

  const canonical = canonicalizePolicyPackageForSigning(pkg);
  const data = new TextEncoder().encode(canonical);

  try {
    let publicKey: CryptoKey;
    const isEcdsa =
      pkg.signature_algorithm === "ECDSA-P256" ||
      (!(keySource instanceof CryptoKey) && (keySource as JsonWebKey).kty === "EC");

    if (keySource instanceof CryptoKey) {
      publicKey = keySource;
    } else if (isEcdsa) {
      publicKey = await crypto.subtle.importKey(
        "jwk",
        keySource,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
    } else {
      publicKey = await crypto.subtle.importKey(
        "jwk",
        keySource,
        { name: "Ed25519" },
        false,
        ["verify"],
      );
    }

    const verifyAlg = isEcdsa ? { name: "ECDSA", hash: "SHA-256" } : { name: "Ed25519" };
    return await crypto.subtle.verify(
      verifyAlg,
      publicKey,
      sigBytes as unknown as BufferSource,
      data as unknown as BufferSource,
    );
  } catch {
    return false;
  }
}

/**
 * Validates the cryptographic hash, expiration, and optional/required Ed25519
 * signature of a policy package.
 */
export async function verifyPolicyIntegrity(
  pkg: PolicyPackage,
  nowMs = Date.now(),
  options?: VerifyPolicyIntegrityOptions,
): Promise<{ valid: boolean; reason?: string; signatureVerified?: boolean }> {
  if (!pkg || !pkg.policy_id || !pkg.policy_version || !pkg.policy_hash || !Array.isArray(pkg.rules)) {
    return { valid: false, reason: "Malformed policy structure." };
  }

  // Check expiration if provided
  if (pkg.expires_at) {
    const expiresMs = new Date(pkg.expires_at).getTime();
    if (!isNaN(expiresMs) && nowMs > expiresMs) {
      return { valid: false, reason: `Policy expired at ${pkg.expires_at}.` };
    }
  }

  // Compute and compare SHA-256 hash
  const canonical = canonicalizePolicyRules(pkg.rules);
  const computedHash = await computeSha256Hex(canonical);

  if (computedHash.toLowerCase() !== pkg.policy_hash.toLowerCase()) {
    SecurityTelemetry.record("policy_hash_mismatch", {
      policyId: pkg.policy_id,
      policyVersion: pkg.policy_version,
    });
    return {
      valid: false,
      reason: `Integrity check failed: Computed hash (${computedHash}) does not match declared hash (${pkg.policy_hash}).`,
    };
  }

  // Verify Ed25519 signature when present or required
  const hasSignature = typeof pkg.policy_signature === "string" && pkg.policy_signature.length > 0;
  if (options?.requireSignature && !hasSignature) {
    SecurityTelemetry.record("policy_signature_missing", {
      policyId: pkg.policy_id,
      policyVersion: pkg.policy_version,
    });
    return {
      valid: false,
      reason: "Signature check failed: Policy package is missing required Ed25519 signature.",
    };
  }

  let signatureVerified = false;
  if (hasSignature || options?.trustedPublicKeyJwk) {
    if (!hasSignature) {
      return {
        valid: false,
        reason: "Signature check failed: Trusted public key provided but policy package is unsigned.",
      };
    }
    const sigOk = await verifyPolicySignatureEd25519(pkg, options?.trustedPublicKeyJwk);
    if (!sigOk) {
      SecurityTelemetry.record("policy_signature_invalid", {
        policyId: pkg.policy_id,
        policyVersion: pkg.policy_version,
      });
      return {
        valid: false,
        reason: "Signature check failed: Invalid Ed25519 policy signature.",
      };
    }
    signatureVerified = true;
    PolicyTelemetry.record("policy_signature_verified", {
      policyId: pkg.policy_id,
      policyVersion: pkg.policy_version,
      algorithm: pkg.signature_algorithm ?? "Ed25519",
    });
  }

  return { valid: true, signatureVerified };
}

/**
 * Synchronizes the organization's policy from GovernWorld API and verifies cryptographic integrity.
 */
export async function syncPolicy(
  client: GovernWorldApiClient,
  token?: string,
  currentVersion?: string,
  options?: VerifyPolicyIntegrityOptions,
): Promise<{ ok: true; policy: PolicyPackage } | { ok: false; error: string }> {
  const query = currentVersion ? `?current_version=${encodeURIComponent(currentVersion)}` : "";
  const result = await client.get<PolicyPackage>(`/api/v1/extension/policy${query}`, { token });

  if (!result.ok) {
    return { ok: false, error: result.error.user_message };
  }

  const pkg = result.data;
  const verification = await verifyPolicyIntegrity(pkg, Date.now(), options);

  if (!verification.valid) {
    return {
      ok: false,
      error: `Policy activation rejected: ${verification.reason}`,
    };
  }

  // Save verified policy to local cache
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    await chrome.storage.local.set({ [STORAGE_KEY_CACHED_POLICY]: pkg });
  }

  return { ok: true, policy: pkg };
}

/**
 * Retrieves the currently active, verified policy from local cache.
 */
export async function getCachedPolicy(options?: VerifyPolicyIntegrityOptions): Promise<PolicyPackage | null> {
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    const res = await chrome.storage.local.get(STORAGE_KEY_CACHED_POLICY);
    const cached = res[STORAGE_KEY_CACHED_POLICY] as PolicyPackage | undefined;
    if (cached) {
      const check = await verifyPolicyIntegrity(cached, Date.now(), options);
      if (check.valid) return cached;
    }
  }
  return null;
}
