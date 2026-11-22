// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_PROD_API_URL,
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY,
  TRUSTED_POLICY_PUBLIC_KEY_JWK,
  RFC8032_TEST_VECTOR_PUBLIC_X,
  isTrustedPolicyPublicKeyConfigured,
  validateApiUrl,
  validateSupabaseUrl,
  getInstallationId,
} from "../src/api/config.js";
import {
  canonicalizePolicyRules,
  computeSha256Hex,
  generateEd25519PolicyKeyPair,
  signPolicyPackageEd25519,
  verifyPolicyIntegrity,
} from "../src/api/policies.js";
import type { PolicyPackage, PolicyRule } from "../src/api/types.js";
import {
  ALLOWED_GATEWAY_HOSTS,
  DEFAULT_PAIRING_STATE,
  DEFAULT_SETTINGS,
  PAIRING_STATE_KEY,
  clearPairingState,
  isAllowedGatewayOrigin,
  loadPairingState,
  normalizePairingState,
  resetSettings,
  savePairingState,
} from "../src/shared/settings.js";
import {
  canonicalizeManagedPolicyEnvelope,
  computeManagedPolicyContentHash,
  managedPolicyToEnterprisePolicy,
  verifyAndValidateManagedPolicy,
  type ManagedPolicyEnvelope,
  type ManagementEnrollment,
} from "../src/shared/managedPolicy.js";
import {
  FAIL_CLOSED_ENTERPRISE_POLICY,
  NO_ENTERPRISE_POLICY,
  STORAGE_KEY_COORDINATOR_POLICY,
  STORAGE_KEY_MANAGED_POLICY,
  loadEnterprisePolicy,
  parseEnterprisePolicy,
  resolveEffectiveProtection,
} from "../src/shared/enterprisePolicy.js";
import {
  applySettingsWithPolicy,
  buildReportedPolicyState,
  detectPolicyDrift,
  validateSettingMutation,
} from "../src/shared/policyOwnership.js";
import { validateMessage } from "../src/shared/messages.js";
import { initPasteGuard } from "../src/content/pasteGuard.js";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function createChromeStorageMock(initialLocal: Record<string, unknown> = {}, initialManaged: Record<string, unknown> = {}) {
  const localStore: Record<string, unknown> = { ...initialLocal };
  const managedStore: Record<string, unknown> = { ...initialManaged };
  const listeners: Array<(changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void> = [];

  const getFrom = (store: Record<string, unknown>, keys: string | string[] | null) => {
    if (keys === null) return { ...store };
    if (typeof keys === "string") return { [keys]: store[keys] };
    if (Array.isArray(keys)) {
      const out: Record<string, unknown> = {};
      for (const k of keys) out[k] = store[k];
      return out;
    }
    return {};
  };

  const chromeMock = {
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[] | null) => getFrom(localStore, keys)),
        set: vi.fn(async (items: Record<string, unknown>) => {
          const changes: Record<string, chrome.storage.StorageChange> = {};
          for (const [k, v] of Object.entries(items)) {
            changes[k] = { oldValue: localStore[k], newValue: v };
            localStore[k] = v;
          }
          for (const fn of listeners) fn(changes, "local");
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          const arr = Array.isArray(keys) ? keys : [keys];
          const changes: Record<string, chrome.storage.StorageChange> = {};
          for (const k of arr) {
            changes[k] = { oldValue: localStore[k], newValue: undefined };
            delete localStore[k];
          }
          for (const fn of listeners) fn(changes, "local");
        }),
      },
      managed: {
        get: vi.fn(async (keys: string | string[] | null) => getFrom(managedStore, keys)),
      },
      onChanged: {
        addListener: vi.fn((fn: (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void) => {
          listeners.push(fn);
        }),
        removeListener: vi.fn((fn: (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void) => {
          const idx = listeners.indexOf(fn);
          if (idx >= 0) listeners.splice(idx, 1);
        }),
      },
    },
  };

  return { chromeMock, localStore, managedStore };
}

describe("M3 Fail-Closed Security Hardening", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("1. Supabase Config, Trusted Key, URLs & Installation ID", () => {
    it("exports Supabase URL and publishable key without any service_role or secret keys", () => {
      expect(SUPABASE_URL).toBe("https://lkgcehdwasewwoieyoip.supabase.co");
      expect(SUPABASE_PUBLISHABLE_KEY).toBe("sb_publishable_BCVFc4dLjWcJIUaXlnv_IQ_F5usIS-C");
      expect(DEFAULT_PROD_API_URL).toBe("https://api.governworld.acrlogic.com");

      const configSource = readFileSync(join(process.cwd(), "src", "api", "config.ts"), "utf8");
      expect(configSource).not.toMatch(/service_role/i);
      expect(configSource).not.toMatch(/sb_secret_/i);
      expect(configSource).not.toContain("DEFAULT_DEV_API_URL");
    });

    it("removes RFC 8032 test vector from TRUSTED_POLICY_PUBLIC_KEY_JWK and rejects unconfigured/test keys", async () => {
      expect(TRUSTED_POLICY_PUBLIC_KEY_JWK.x).toBe("");
      expect(TRUSTED_POLICY_PUBLIC_KEY_JWK.x).not.toBe(RFC8032_TEST_VECTOR_PUBLIC_X);
      expect(isTrustedPolicyPublicKeyConfigured()).toBe(false);
      expect(isTrustedPolicyPublicKeyConfigured(null)).toBe(false);
      expect(
        isTrustedPolicyPublicKeyConfigured({
          kty: "OKP",
          crv: "Ed25519",
          x: RFC8032_TEST_VECTOR_PUBLIC_X,
          key_ops: ["verify"],
        }),
      ).toBe(false);
      expect(
        isTrustedPolicyPublicKeyConfigured({
          kty: "OKP",
          crv: "Ed25519",
          x: "short",
        }),
      ).toBe(false);

      const pair = await generateEd25519PolicyKeyPair();
      expect(isTrustedPolicyPublicKeyConfigured(pair.publicKeyJwk)).toBe(true);
      expect(isTrustedPolicyPublicKeyConfigured(pair.publicKey)).toBe(true);
      expect(isTrustedPolicyPublicKeyConfigured(pair.privateKey)).toBe(false);
    });

    it("enforces HTTPS-only in validateApiUrl and exact host in validateSupabaseUrl", () => {
      expect(validateApiUrl("http://127.0.0.1:8000").valid).toBe(false);
      expect(validateApiUrl("http://localhost:8000").valid).toBe(false);
      expect(validateApiUrl("https://user:pass@api.governworld.acrlogic.com").valid).toBe(false);
      expect(validateApiUrl("https://api.governworld.acrlogic.com/").normalizedUrl).toBe(
        "https://api.governworld.acrlogic.com",
      );

      expect(validateSupabaseUrl(SUPABASE_URL).valid).toBe(true);
      expect(validateSupabaseUrl("http://lkgcehdwasewwoieyoip.supabase.co").valid).toBe(false);
      expect(validateSupabaseUrl("https://lkgcehdwasewwoieyoip.supabase.co:8443").valid).toBe(false);
      expect(validateSupabaseUrl("https://other.supabase.co").valid).toBe(false);
      expect(validateSupabaseUrl("https://user@lkgcehdwasewwoieyoip.supabase.co").valid).toBe(false);
    });

    it("fails closed in getInstallationId() when storage is missing, throws, or holds nil UUID", async () => {
      vi.stubGlobal("chrome", undefined);
      await expect(getInstallationId()).rejects.toThrow();

      vi.stubGlobal("chrome", {
        storage: {
          local: {
            get: vi.fn(async () => {
              throw new Error("storage failure");
            }),
            set: vi.fn(),
          },
        },
      });
      await expect(getInstallationId()).rejects.toThrow(/storage failure/);

      const { chromeMock, localStore } = createChromeStorageMock({
        gw_installation_id: "00000000-0000-0000-0000-000000000000",
      });
      vi.stubGlobal("chrome", chromeMock);
      const id = await getInstallationId();
      expect(id).not.toBe("00000000-0000-0000-0000-000000000000");
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(localStore.gw_installation_id).toBe(id);
    });
  });

  describe("2. Gateway Allowlist, PairingState & Manifests", () => {
    it("fixes operator-precedence bug in isAllowedGatewayOrigin and removes localhost/127.0.0.1", () => {
      expect(ALLOWED_GATEWAY_HOSTS.has("api.governworld.acrlogic.com")).toBe(true);
      expect(ALLOWED_GATEWAY_HOSTS.has("lkgcehdwasewwoieyoip.supabase.co")).toBe(true);
      expect(ALLOWED_GATEWAY_HOSTS.has("127.0.0.1")).toBe(false);
      expect(ALLOWED_GATEWAY_HOSTS.has("localhost")).toBe(false);

      expect(isAllowedGatewayOrigin("https://api.governworld.acrlogic.com")).toBe(true);
      expect(isAllowedGatewayOrigin("https://lkgcehdwasewwoieyoip.supabase.co")).toBe(true);
      expect(isAllowedGatewayOrigin("ftp://localhost/")).toBe(false);
      expect(isAllowedGatewayOrigin("http://localhost/")).toBe(false);
      expect(isAllowedGatewayOrigin("http://127.0.0.1/")).toBe(false);
      expect(isAllowedGatewayOrigin("https://localhost/")).toBe(false);
      expect(isAllowedGatewayOrigin("https://lkgcehdwasewwoieyoip.supabase.co:8443")).toBe(false);
      expect(isAllowedGatewayOrigin("https://lkgcehdwasewwoieyoip.supabase.co/functions/v1")).toBe(false);
    });

    it("normalizes PairingState fail-closed and isolates it from resetSettings()", async () => {
      expect(DEFAULT_PAIRING_STATE.status).toBe("local_only");

      // Missing seat_id/organisation_id/owning_backend fails closed to local_only
      expect(
        normalizePairingState({ status: "paired", seat_id: "seat-1", organisation_id: "org-1" }),
      ).toEqual(DEFAULT_PAIRING_STATE);
      expect(normalizePairingState({ status: "paired_offline", owning_backend: "supabase" })).toEqual(
        DEFAULT_PAIRING_STATE,
      );

      // Strips unknown secret fields like pairing_code and seat_session_token
      const normalized = normalizePairingState({
        status: "paired",
        seat_id: "seat-1",
        organisation_id: "org-1",
        organisation_name: "Acme Health",
        unlocked: false,
        session_ref: "ref-abc",
        owning_backend: "supabase",
        pairing_code: "12345678",
        seat_session_token: "super-secret-token",
      }) as unknown as Record<string, unknown>;
      expect(normalized.status).toBe("paired");
      expect(normalized.pairing_code).toBeUndefined();
      expect(normalized.seat_session_token).toBeUndefined();

      const { chromeMock, localStore } = createChromeStorageMock();
      vi.stubGlobal("chrome", chromeMock);

      await savePairingState(normalized);
      expect((await loadPairingState()).status).toBe("paired");

      // resetSettings() must NOT wipe gw_pairing_state
      const reset = await resetSettings();
      expect(reset).toEqual(DEFAULT_SETTINGS);
      expect(localStore[PAIRING_STATE_KEY]).toBeDefined();
      expect((await loadPairingState()).status).toBe("paired");

      await clearPairingState();
      expect((await loadPairingState()).status).toBe("local_only");
    });

    it("pins host_permissions to single Supabase host without wildcards in both manifests", () => {
      const chromeManifest = JSON.parse(readFileSync(join(process.cwd(), "manifest.json"), "utf8"));
      const ffManifest = JSON.parse(readFileSync(join(process.cwd(), "manifest.firefox.json"), "utf8"));

      expect(chromeManifest.host_permissions).toEqual(["https://lkgcehdwasewwoieyoip.supabase.co/*"]);
      expect(ffManifest.host_permissions).toEqual(["https://lkgcehdwasewwoieyoip.supabase.co/*"]);
    });
  });

  describe("3. Fail-Closed Policy Verification & Anti-Replay Fix", () => {
    const enrollment: ManagementEnrollment = {
      organization_id: "org_1",
      employee_id: "seat_1",
      device_id: "11111111-1111-4111-8111-111111111111",
      enrolled_at: "2026-01-01T00:00:00Z",
      management_mode: "MANAGE",
    };

    async function makeSignedManagedEnvelope(
      privateKey: CryptoKey,
      overrides: Partial<ManagedPolicyEnvelope> = {},
    ): Promise<ManagedPolicyEnvelope> {
      const rules = overrides.rules ?? [];
      const settings = overrides.settings ?? {
        protectionMode: "always-on",
        userCanDisable: false,
        enforcedCategories: ["ssn", "email"],
      };
      const hash = await computeManagedPolicyContentHash(rules, settings);
      const unsigned: Omit<ManagedPolicyEnvelope, "policy_signature" | "signature_algorithm"> = {
        policy_id: overrides.policy_id ?? "pol-1",
        organization_id: overrides.organization_id ?? enrollment.organization_id,
        organization_name: overrides.organization_name ?? "Org One",
        target: overrides.target ?? {
          organization_id: enrollment.organization_id,
          employee_id: enrollment.employee_id,
          device_id: enrollment.device_id,
        },
        policy_version: overrides.policy_version ?? 1,
        schema_version: overrides.schema_version ?? "2026-03",
        effective_at: overrides.effective_at ?? "2026-01-01T00:00:00Z",
        expires_at: "expires_at" in overrides ? overrides.expires_at : new Date(Date.now() + 86_400_000).toISOString(),
        created_at: overrides.created_at ?? "2026-01-01T00:00:00Z",
        nonce: overrides.nonce ?? "nonce-12345678",
        policy_hash: overrides.policy_hash ?? hash,
        rules,
        settings,
      };
      const canonical = canonicalizeManagedPolicyEnvelope(unsigned);
      const sig = await crypto.subtle.sign(
        { name: "Ed25519" },
        privateKey,
        new TextEncoder().encode(canonical),
      );
      return {
        ...unsigned,
        policy_signature: bytesToBase64(new Uint8Array(sig)),
        signature_algorithm: "Ed25519",
      };
    }

    it("never short-circuits same version+nonce before verifying hash, signature, and expiry", async () => {
      const pair = await generateEd25519PolicyKeyPair();
      const valid = await makeSignedManagedEnvelope(pair.privateKey, { policy_version: 3, nonce: "nonce-same-123" });

      // Forged signature with identical version & nonce must fail SIGNATURE_INVALID
      const forged = { ...valid, policy_signature: bytesToBase64(new Uint8Array(64).fill(7)) };
      const forgedRes = await verifyAndValidateManagedPolicy(forged, enrollment, valid, Date.now(), pair.publicKey);
      expect(forgedRes.valid).toBe(false);
      expect(forgedRes.code).toBe("SIGNATURE_INVALID");

      // Different validly-signed content reusing same version & nonce must fail REPLAY
      const replayed = await makeSignedManagedEnvelope(pair.privateKey, {
        policy_id: "pol-other",
        policy_version: 3,
        nonce: "nonce-same-123",
      });
      const replayRes = await verifyAndValidateManagedPolicy(replayed, enrollment, valid, Date.now(), pair.publicKey);
      expect(replayRes.valid).toBe(false);
      expect(replayRes.code).toBe("REPLAY");

      // Identical validly-signed envelope succeeds idempotently
      const idemRes = await verifyAndValidateManagedPolicy(valid, enrollment, valid, Date.now(), pair.publicKey);
      expect(idemRes.valid).toBe(true);
    });

    it("rejects missing, empty, or NaN expires_at in both managedPolicy and api/policies", async () => {
      const pair = await generateEd25519PolicyKeyPair();

      for (const badExpires of [undefined, "", "not-a-valid-date"]) {
        const env = await makeSignedManagedEnvelope(pair.privateKey, { expires_at: badExpires as string });
        const res = await verifyAndValidateManagedPolicy(env, enrollment, null, Date.now(), pair.publicKey);
        expect(res.valid).toBe(false);
        expect(res.code).toBe("MALFORMED");
      }

      const rules = [{ id: "r1", category: "ssn", pattern: "\\d{3}", confidence: 0.9 }];
      const hash = await computeSha256Hex(canonicalizePolicyRules(rules));
      for (const badExpires of [undefined, "", "invalid-date"]) {
        const basePkg: PolicyPackage = {
          policy_id: "p1",
          policy_version: "1",
          effective_at: "2026-01-01T00:00:00Z",
          expires_at: badExpires,
          policy_hash: hash,
          rules,
        };
        const signed: PolicyPackage = {
          ...basePkg,
          policy_signature: await signPolicyPackageEd25519(basePkg, pair.privateKey),
          signature_algorithm: "Ed25519",
        };
        const res = await verifyPolicyIntegrity(signed, Date.now(), {
          trustedPublicKeyJwk: pair.publicKeyJwk,
        });
        expect(res.valid).toBe(false);
      }
    });

    it("propagates extended ManagedPolicySettings into EnterprisePolicy", async () => {
      const pair = await generateEd25519PolicyKeyPair();
      const env = await makeSignedManagedEnvelope(pair.privateKey, {
        settings: {
          protectionMode: "always-on",
          userCanDisable: false,
          enforcedCategories: ["ssn"],
          confidenceThresholds: { ssn: 0.4 },
          defaultRedactionStyle: "stamp",
          defaultStampText: "[PHI]",
          autoMaskSingleNames: true,
          maxVisibleChars: 300_000,
          maxNodeChars: 12_000,
        },
      });
      const ep = managedPolicyToEnterprisePolicy(env);
      expect(ep.confidenceThresholds).toEqual({ ssn: 0.4 });
      expect(ep.defaultRedactionStyle).toBe("stamp");
      expect(ep.defaultStampText).toBe("[PHI]");
      expect(ep.autoMaskSingleNames).toBe(true);
      expect(ep.maxVisibleChars).toBe(300_000);
      expect(ep.maxNodeChars).toBe(12_000);
    });
  });

  describe("4. EnterprisePolicy Re-Verification, Ownership Enforcement, Unlock & Drift", () => {
    it("re-verifies gw_applied_managed_policy and rejects unsigned gw_coordinator_policy", async () => {
      const pair = await generateEd25519PolicyKeyPair();
      const rules: PolicyRule[] = [];
      const settings = {
        protectionMode: "always-on" as const,
        userCanDisable: false,
        enforcedCategories: ["ssn" as const],
      };
      const hash = await computeManagedPolicyContentHash(rules, settings);
      const unsigned: Omit<ManagedPolicyEnvelope, "policy_signature" | "signature_algorithm"> = {
        policy_id: "pol-loaded",
        organization_id: "org-1",
        organization_name: "Acme",
        target: { organization_id: "org-1", employee_id: "seat-1", device_id: "22222222-2222-4222-8222-222222222222" },
        policy_version: 2,
        schema_version: "2026-03",
        effective_at: "2026-01-01T00:00:00Z",
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        created_at: "2026-01-01T00:00:00Z",
        nonce: "nonce-load-123",
        policy_hash: hash,
        rules,
        settings,
      };
      const sig = await crypto.subtle.sign(
        { name: "Ed25519" },
        pair.privateKey,
        new TextEncoder().encode(canonicalizeManagedPolicyEnvelope(unsigned)),
      );
      const signedEnvelope: ManagedPolicyEnvelope = {
        ...unsigned,
        policy_signature: bytesToBase64(new Uint8Array(sig)),
        signature_algorithm: "Ed25519",
      };

      // Clean local_only -> NO_ENTERPRISE_POLICY
      const cleanMock = createChromeStorageMock();
      vi.stubGlobal("chrome", cleanMock.chromeMock);
      expect(await loadEnterprisePolicy()).toEqual(NO_ENTERPRISE_POLICY);

      // Unsigned gw_coordinator_policy -> FAIL_CLOSED_ENTERPRISE_POLICY
      const coordMock = createChromeStorageMock({
        [STORAGE_KEY_COORDINATOR_POLICY]: { protectionMode: "off", userCanDisable: true },
      });
      vi.stubGlobal("chrome", coordMock.chromeMock);
      expect(await loadEnterprisePolicy()).toEqual(FAIL_CLOSED_ENTERPRISE_POLICY);

      // Valid gw_applied_managed_policy with unconfigured default trust key -> FAIL_CLOSED
      const validMock = createChromeStorageMock({
        gw_installation_id: "22222222-2222-4222-8222-222222222222",
        [PAIRING_STATE_KEY]: {
          status: "paired",
          seat_id: "seat-1",
          organisation_id: "org-1",
          organisation_name: "Acme",
          unlocked: true,
          session_ref: "sess-1",
          owning_backend: "supabase",
          conflict_state: null,
        },
        [STORAGE_KEY_MANAGED_POLICY]: signedEnvelope,
      });
      vi.stubGlobal("chrome", validMock.chromeMock);
      expect(await loadEnterprisePolicy()).toEqual(FAIL_CLOSED_ENTERPRISE_POLICY);

      // Valid gw_applied_managed_policy with explicit trusted key -> verified + seatUnlocked
      const verified = await loadEnterprisePolicy({ trustedKey: pair.publicKey });
      expect(verified.managed).toBe(true);
      expect(verified.valid).toBe(true);
      expect(verified.seatUnlocked).toBe(true);
      expect(verified.protectionMode).toBe("always-on");

      // Tampered gw_applied_managed_policy -> FAIL_CLOSED
      validMock.localStore[STORAGE_KEY_MANAGED_POLICY] = { ...signedEnvelope, policy_id: "tampered" };
      expect(await loadEnterprisePolicy({ trustedKey: pair.publicKey })).toEqual(FAIL_CLOSED_ENTERPRISE_POLICY);
    });

    it("enforces all admin-owned settings when locked and allows overrides only when seatUnlocked & valid", () => {
      const lockedPolicy = parseEnterprisePolicy({
        protectionMode: "always-on",
        userCanDisable: false,
        enforcedCategories: ["ssn", "email"],
        confidenceThresholds: { ssn: 0.3 },
        defaultRedactionStyle: "stamp",
        defaultStampText: "[CORP]",
        autoMaskSingleNames: true,
        maxVisibleChars: 300_000,
        maxNodeChars: 15_000,
        networkDestinationPolicy: "disabled",
        networkAllowlist: ["https://intranet.acme.internal"],
      });

      const weakUser = {
        ...DEFAULT_SETTINGS,
        protectionMode: "off" as const,
        pasteGuardEnabled: false,
        enabledCategories: ["email" as const],
        confidenceThresholds: { ...DEFAULT_SETTINGS.confidenceThresholds, ssn: 0.9 },
        defaultRedactionStyle: "whiteout" as const,
        defaultStampText: "[USER]",
        autoMaskSingleNames: false,
        maxVisibleChars: 500,
        maxNodeChars: 100,
      };

      // Final invariant check (empty requestedUpdates, as used by saveSettings)
      const enforced = applySettingsWithPolicy(weakUser, {}, lockedPolicy);
      expect(enforced.settings.protectionMode).toBe("always-on");
      expect(enforced.settings.pasteGuardEnabled).toBe(true);
      expect(enforced.settings.enabledCategories).toContain("ssn");
      expect(enforced.settings.confidenceThresholds.ssn).toBe(0.3);
      expect(enforced.settings.defaultRedactionStyle).toBe("stamp");
      expect(enforced.settings.defaultStampText).toBe("[CORP]");
      expect(enforced.settings.autoMaskSingleNames).toBe(true);
      expect(enforced.settings.maxVisibleChars).toBe(300_000);
      expect(enforced.settings.maxNodeChars).toBe(15_000);

      // Direct mutations rejected for all admin-owned keys
      expect(validateSettingMutation("maxVisibleChars", 500, DEFAULT_SETTINGS, lockedPolicy).allowed).toBe(false);
      expect(validateSettingMutation("maxNodeChars", 100, DEFAULT_SETTINGS, lockedPolicy).allowed).toBe(false);
      expect(validateSettingMutation("defaultRedactionStyle", "whiteout", DEFAULT_SETTINGS, lockedPolicy).allowed).toBe(false);
      expect(validateSettingMutation("defaultStampText", "[HACK]", DEFAULT_SETTINGS, lockedPolicy).allowed).toBe(false);
      expect(validateSettingMutation("autoMaskSingleNames", false, DEFAULT_SETTINGS, lockedPolicy).allowed).toBe(false);
      expect(validateSettingMutation("pasteGuardEnabled", false, DEFAULT_SETTINGS, lockedPolicy).allowed).toBe(false);
      expect(validateSettingMutation("networkDestinationPolicy", "managed_intranet", DEFAULT_SETTINGS, lockedPolicy).allowed).toBe(false);
      expect(validateSettingMutation("networkAllowlist", ["https://evil.test"], DEFAULT_SETTINGS, lockedPolicy).allowed).toBe(false);
      expect(validateSettingMutation("customRules", [], DEFAULT_SETTINGS, lockedPolicy).allowed).toBe(false);

      // Unlocked valid seat permits overrides & surfaces drift
      const unlockedPolicy = { ...lockedPolicy, seatUnlocked: true };
      const unlockedEff = resolveEffectiveProtection(weakUser, unlockedPolicy);
      expect(unlockedEff.locked).toBe(false);
      expect(unlockedEff.mode).toBe("off");

      const reported = buildReportedPolicyState(weakUser, unlockedPolicy, true);
      const drift = detectPolicyDrift(lockedPolicy, reported);
      expect(drift.hasDrift).toBe(true);
      expect(drift.driftedKeys).toEqual(
        expect.arrayContaining(["protectionMode", "enabledCategories", "defaultRedactionStyle", "defaultStampText"]),
      );

      // Invalid policy ALWAYS overrides seatUnlocked fail-closed
      const invalidWithUnlock = { ...FAIL_CLOSED_ENTERPRISE_POLICY, seatUnlocked: true };
      const invalidEff = resolveEffectiveProtection(weakUser, invalidWithUnlock);
      expect(invalidEff.locked).toBe(true);
      expect(invalidEff.mode).toBe("always-on");
    });
  });

  describe("5. POPUP_MANAGEMENT_* & SUPABASE_* IPC Message Validation", () => {
    it("validates all 5 POPUP_MANAGEMENT_* messages and rejects unsafe coordinatorUrl", () => {
      expect(validateMessage({ type: "POPUP_MANAGEMENT_GET_STATUS", requestId: "r1" }).ok).toBe(true);
      expect(validateMessage({ type: "POPUP_MANAGEMENT_UNENROLL", requestId: "r2" }).ok).toBe(true);
      expect(validateMessage({ type: "POPUP_SYNC_MANAGED_POLICY", requestId: "r3", force: true }).ok).toBe(true);
      expect(
        validateMessage({
          type: "POPUP_MANAGEMENT_ENROLL",
          requestId: "r4",
          organizationId: "org-1",
          employeeId: "emp-1",
          coordinatorUrl: "https://coord.example.com",
          extraMaliciousField: "drop",
        }),
      ).toEqual({
        ok: true,
        message: {
          type: "POPUP_MANAGEMENT_ENROLL",
          requestId: "r4",
          organizationId: "org-1",
          employeeId: "emp-1",
          coordinatorUrl: "https://coord.example.com",
        },
      });
      expect(
        validateMessage({
          type: "POPUP_MANAGEMENT_ENROLL",
          requestId: "r5",
          organizationId: "org-1",
          employeeId: "emp-1",
          coordinatorUrl: "http://remote.example.com",
        }).ok,
      ).toBe(false);
      expect(
        validateMessage({
          type: "POPUP_MANAGEMENT_STATUS_STATE",
          requestId: "r6",
          mode: "MANAGE",
          enrolled: true,
          appliedPolicyVersion: 3,
        }).ok,
      ).toBe(true);
    });

    it("validates SUPABASE_* IPC messages strictly and never echoes pairing codes in errors", () => {
      expect(
        validateMessage({ type: "SUPABASE_PAIR_REDEEM", requestId: "s1", code: "12345678", extra: "strip" }),
      ).toEqual({
        ok: true,
        message: { type: "SUPABASE_PAIR_REDEEM", requestId: "s1", code: "12345678" },
      });

      for (const badCode of ["1234567", "123456789", "1234abcd", " 12345678 ", 12345678]) {
        const res = validateMessage({ type: "SUPABASE_PAIR_REDEEM", requestId: "s2", code: badCode });
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error).not.toContain(String(badCode));
        }
      }

      expect(validateMessage({ type: "SUPABASE_PAIR_STATUS", requestId: "s3" }).ok).toBe(true);
      expect(validateMessage({ type: "SUPABASE_PAIR_UNPAIR", requestId: "s4" }).ok).toBe(true);
      expect(validateMessage({ type: "SUPABASE_POLICY_SYNC", requestId: "s5", force: false }).ok).toBe(true);

      const statusRes = validateMessage({
        type: "SUPABASE_PAIR_STATUS_STATE",
        requestId: "s6",
        pairingState: "paired",
        owningBackend: "supabase",
        organisationId: "org-1",
        organisationName: "Acme",
        seatId: "seat-1",
        unlocked: false,
        policyVersion: 2,
        hasDrift: false,
        unknownKey: "should-be-stripped",
      });
      expect(statusRes.ok).toBe(true);
      if (statusRes.ok) {
        expect((statusRes.message as unknown as Record<string, unknown>).unknownKey).toBeUndefined();
      }

      expect(
        validateMessage({
          type: "SUPABASE_PAIR_REDEEM_RESULT",
          requestId: "s7",
          ok: true,
          pairingState: "paired",
          seatId: "seat-1",
        }).ok,
      ).toBe(true);
    });
  });

  describe("6. Content PasteGuard Paired Policy Enforcement", () => {
    it("fails closed in pasteGuard when unsigned gw_coordinator_policy or unverified gw_applied_managed_policy is present", async () => {
      const { chromeMock } = createChromeStorageMock({
        settings: { ...DEFAULT_SETTINGS, protectionMode: "off", pasteGuardEnabled: false },
        [STORAGE_KEY_COORDINATOR_POLICY]: { protectionMode: "off", userCanDisable: true },
      });
      vi.stubGlobal("chrome", chromeMock);

      const listeners: Record<string, Array<(e: unknown) => void>> = {};
      const fakeDoc = {
        defaultView: { location: { href: "https://example.com", hostname: "example.com" } },
        documentElement: null,
        getElementById: () => null,
        querySelectorAll: () => [],
        addEventListener: vi.fn((type: string, fn: (e: unknown) => void) => {
          listeners[type] = listeners[type] ?? [];
          listeners[type].push(fn);
        }),
        removeEventListener: vi.fn(),
        body: { appendChild: vi.fn() },
      } as unknown as Document;

      const teardown = initPasteGuard(fakeDoc);
      // Wait for async loadStored + refreshPolicy microtasks
      await new Promise((r) => setTimeout(r, 25));

      const fakeInput = {
        tagName: "INPUT",
        type: "text",
        nodeType: 1,
        isContentEditable: false,
        value: "",
        getBoundingClientRect: () => ({ top: 0, left: 0, bottom: 20, right: 100 }),
      };

      const preventDefault = vi.fn();
      const stopImmediatePropagation = vi.fn();
      for (const fn of listeners.paste ?? []) {
        fn({
          target: fakeInput,
          clipboardData: { getData: () => "Contact alice@example.com for SSN 123-45-6789" },
          preventDefault,
          stopImmediatePropagation,
        });
      }

      // Even though user settings had protectionMode="off", fail-closed managed policy intercepted the paste!
      expect(preventDefault).toHaveBeenCalled();
      teardown();
    });
  });
});
