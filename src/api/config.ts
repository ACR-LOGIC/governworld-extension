// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
/**
 * Configuration and identity management for GovernWorld API integration.
 * Centralizes endpoints, installation identification, and transport security checks.
 */

/**
 * Production gateway.
 *
 * This must be the same host as `ALLOWED_GATEWAY_HOSTS` in `shared/settings.ts`.
 * They were out of sync — the default resolved to a host the allowlist rejects,
 * so a user who connected and then stored the default origin was silently refused,
 * and a self-hosted-looking deployment could be pointed at a host that was never
 * allowed anyway. `tests/api-url-parity.test.ts` now asserts they match, so the
 * two cannot drift apart again.
 */
export const DEFAULT_PROD_API_URL = "https://api.governworld.acrlogic.com";
export const SUPABASE_URL = "https://lkgcehdwasewwoieyoip.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_BCVFc4dLjWcJIUaXlnv_IQ_F5usIS-C";
export const CURRENT_EXTENSION_VERSION = "0.5.0";

/**
 * Known RFC 8032 Section 7.1 Test Vector 1 public key (paired with publicly
 * documented secret key). Must NEVER be trusted in production.
 */
export const RFC8032_TEST_VECTOR_PUBLIC_X = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
export const KNOWN_TEST_POLICY_PUBLIC_KEYS = new Set<string>([
  RFC8032_TEST_VECTOR_PUBLIC_X,
]);

/**
 * Pinned production Ed25519 public key JWK used to verify policy package signatures.
 * Fail-closed unconfigured default (`x: ""`) until pinned to the production
 * signing public key; untrusted / self-supplied keys inside remote policy
 * packages or known RFC 8032 test vector keys are never accepted.
 */
export const TRUSTED_POLICY_PUBLIC_KEY_JWK: JsonWebKey = {
  kty: "OKP",
  crv: "Ed25519",
  x: "",
  key_ops: ["verify"],
};

const STORAGE_KEY_API_URL = "gw_api_url";
const STORAGE_KEY_INSTALLATION_ID = "gw_installation_id";
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUPABASE_HOST = "lkgcehdwasewwoieyoip.supabase.co";

function decodeBase64UrlBytes(value: string): Uint8Array | null {
  try {
    if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      // eslint-disable-next-line security/detect-object-injection
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Returns true only when `key` is a valid, non-empty, non-test-vector Ed25519
 * verification key (`JsonWebKey` with 32-byte `x` or `CryptoKey` for verify).
 */
export function isTrustedPolicyPublicKeyConfigured(
  key: JsonWebKey | CryptoKey | null | undefined = TRUSTED_POLICY_PUBLIC_KEY_JWK,
): boolean {
  if (!key) return false;

  if (typeof CryptoKey !== "undefined" && key instanceof CryptoKey) {
    return (
      key.type === "public" &&
      key.algorithm?.name === "Ed25519" &&
      Array.isArray(key.usages) &&
      key.usages.includes("verify")
    );
  }

  const jwk = key as JsonWebKey;
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
    return false;
  }
  const trimmedX = jwk.x.trim();
  if (!trimmedX || KNOWN_TEST_POLICY_PUBLIC_KEYS.has(trimmedX)) {
    return false;
  }
  const decoded = decodeBase64UrlBytes(trimmedX);
  return decoded !== null && decoded.byteLength === 32;
}

/**
 * Validates that a candidate API URL is syntactically valid and satisfies
 * production HTTPS/TLS transport security (fail-closed, no plaintext HTTP).
 */
export function validateApiUrl(rawUrl: string): { valid: boolean; normalizedUrl?: string; error?: string } {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.username !== "" || parsed.password !== "") {
      return { valid: false, error: "Malformed API URL: credentials are not permitted." };
    }
    if (parsed.protocol !== "https:") {
      return {
        valid: false,
        error: "Insecure transport rejected: Production GovernWorld endpoints must use HTTPS/TLS.",
      };
    }
    if (!parsed.hostname) {
      return { valid: false, error: "Malformed API URL." };
    }

    // Strip trailing slash for consistency
    const normalized = `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
    return { valid: true, normalizedUrl: normalized };
  } catch {
    return { valid: false, error: "Malformed API URL." };
  }
}

/**
 * Validates that a URL targets the pinned GovernWorld Supabase project over HTTPS
 * with exact hostname, no embedded credentials, and no custom port.
 */
export function validateSupabaseUrl(rawUrl: string): { valid: boolean; normalizedUrl?: string; error?: string } {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.username !== "" || parsed.password !== "") {
      return { valid: false, error: "Malformed Supabase URL: credentials are not permitted." };
    }
    if (parsed.protocol !== "https:") {
      return {
        valid: false,
        error: "Insecure transport rejected: Supabase endpoints must use HTTPS/TLS.",
      };
    }
    if (parsed.port !== "") {
      return { valid: false, error: "Custom ports are not permitted for Supabase endpoints." };
    }
    const cleanHost = parsed.hostname.toLowerCase().replace(/\.+$/, "");
    if (cleanHost !== SUPABASE_HOST) {
      return { valid: false, error: "Untrusted Supabase host rejected." };
    }
    const normalized = `${parsed.protocol}//${cleanHost}${parsed.pathname.replace(/\/+$/, "")}`;
    return { valid: true, normalizedUrl: normalized };
  } catch {
    return { valid: false, error: "Malformed Supabase URL." };
  }
}

/**
 * Returns the currently configured API base URL. Defaults to production HTTPS endpoint.
 */
export async function getApiUrl(): Promise<string> {
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      const stored = await chrome.storage.local.get(STORAGE_KEY_API_URL);
      // eslint-disable-next-line security/detect-object-injection
      const url = stored[STORAGE_KEY_API_URL];
      if (typeof url === "string" && url.trim()) {
        const check = validateApiUrl(url);
        if (check.valid && check.normalizedUrl) return check.normalizedUrl;
      }
    }
  } catch {
    // Fall back to default
  }
  return DEFAULT_PROD_API_URL;
}

/**
 * Saves an API base URL into extension local storage after validation.
 */
export async function setApiUrl(url: string): Promise<{ success: boolean; error?: string }> {
  const check = validateApiUrl(url);
  if (!check.valid || !check.normalizedUrl) {
    return { success: false, error: check.error ?? "Invalid URL" };
  }
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    await chrome.storage.local.set({ [STORAGE_KEY_API_URL]: check.normalizedUrl });
  }
  return { success: true };
}

/**
 * Retrieves or generates a non-secret, persistent installation UUID.
 * Used exclusively for compatibility tracking and diagnostics. NEVER functions as an auth token.
 * Fails closed (throws) when persistent extension storage is unavailable or unreadable.
 */
export async function getInstallationId(): Promise<string> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) {
    throw new Error("Extension local storage is unavailable for installation ID resolution.");
  }

  let stored: Record<string, unknown>;
  try {
    stored = await chrome.storage.local.get(STORAGE_KEY_INSTALLATION_ID);
  } catch (err) {
    throw new Error(
      `Failed to read installation ID from extension storage: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  // eslint-disable-next-line security/detect-object-injection
  const existing = stored[STORAGE_KEY_INSTALLATION_ID];
  if (
    typeof existing === "string" &&
    UUID_RE.test(existing) &&
    existing.toLowerCase() !== NIL_UUID
  ) {
    return existing;
  }

  if (typeof crypto === "undefined" || typeof crypto.randomUUID !== "function") {
    throw new Error("WebCrypto randomUUID is unavailable for installation ID generation.");
  }

  const newId = crypto.randomUUID();
  if (!UUID_RE.test(newId) || newId.toLowerCase() === NIL_UUID) {
    throw new Error("Generated installation ID is invalid.");
  }

  try {
    await chrome.storage.local.set({ [STORAGE_KEY_INSTALLATION_ID]: newId });
  } catch (err) {
    throw new Error(
      `Failed to persist installation ID to extension storage: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  return newId;
}

/**
 * Simple semver comparison helper (current >= required).
 */
export function semverGte(current: string, required: string): boolean {
  const parse = (v: string) => v.split(".").map((n) => parseInt(n.replace(/\D.*$/, ""), 10) || 0);
  const [cMaj, cMin, cPat] = parse(current);
  const [rMaj, rMin, rPat] = parse(required);

  if (cMaj !== rMaj) return cMaj > rMaj;
  if (cMin !== rMin) return cMin > rMin;
  return cPat >= rPat;
}
