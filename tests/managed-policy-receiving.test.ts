// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
/**
 * Test Suite: Managed Policy Receiving, Cryptographic Verification,
 * Anti-Rollback, Setting Ownership Classification, and Offline Behavior.
 *
 * Verifies GovernWorld Engineering Directive v0.3.0 Sections 2 & 3.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  SETTING_OWNERSHIP_MAP,
  getSettingOwnership,
  validateSettingMutation,
  applySettingsWithPolicy,
} from "../src/shared/policyOwnership.js";
import {
  ManagedPolicyEnvelope,
  ManagementEnrollment,
  verifyAndValidateManagedPolicy,
  canonicalizeManagedPolicyEnvelope,
  computeManagedPolicyContentHash,
  managedPolicyToEnterprisePolicy,
  createPolicyAcknowledgment,
  loadLastAppliedManagedPolicy,
  saveAppliedManagedPolicy,
  saveManagementEnrollment,
  loadManagementEnrollment,
  clearManagementEnrollment,
  STORAGE_KEY_MANAGED_POLICY,
  STORAGE_KEY_ENROLLMENT,
} from "../src/shared/managedPolicy.js";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  Settings,
} from "../src/shared/settings.js";
import {
  parseEnterprisePolicy,
  loadEnterprisePolicy,
  NO_ENTERPRISE_POLICY,
} from "../src/shared/enterprisePolicy.js";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

describe("Section 2: Setting Ownership Classification", () => {
  it("explicitly classifies all settings into administrator, user, or system ownership", () => {
    // Administrator-controlled
    expect(getSettingOwnership("protectionMode")).toBe("administrator");
    expect(getSettingOwnership("enabledCategories")).toBe("administrator");
    expect(getSettingOwnership("confidenceThresholds")).toBe("administrator");
    expect(getSettingOwnership("networkDestinationPolicy")).toBe("administrator");
    expect(getSettingOwnership("networkAllowlist")).toBe("administrator");
    expect(getSettingOwnership("defaultRedactionStyle")).toBe("administrator");
    expect(getSettingOwnership("defaultStampText")).toBe("administrator");

    // User-controlled
    expect(getSettingOwnership("language")).toBe("user");
    expect(getSettingOwnership("fontSize")).toBe("user");
    expect(getSettingOwnership("highContrast")).toBe("user");
    expect(getSettingOwnership("dyslexiaMode")).toBe("user");
    expect(getSettingOwnership("reducedMotion")).toBe("user");
    expect(getSettingOwnership("speechAnnouncements")).toBe("user");
    expect(getSettingOwnership("ariaVerboseMode")).toBe("user");
    expect(getSettingOwnership("maskColor")).toBe("user");
    expect(getSettingOwnership("notificationPrefs")).toBe("user");
    expect(getSettingOwnership("notificationsEnabled")).toBe("user");
    expect(getSettingOwnership("maskPadding")).toBe("user");
    expect(getSettingOwnership("contextMenusEnabled")).toBe("user");
    expect(getSettingOwnership("ocrLanguage")).toBe("user");

    // System-controlled
    expect(getSettingOwnership("consentVersion")).toBe("system");
    expect(getSettingOwnership("disclosureAcknowledged")).toBe("system");
    expect(getSettingOwnership("verificationNoticeAcknowledged")).toBe("system");

    // Unknown settings fail-closed to administrator
    expect(getSettingOwnership("unknownFutureProperty")).toBe("administrator");
  });

  it("prevents employees from weakening administrator-enforced categories", () => {
    const adminPolicy = parseEnterprisePolicy({
      protectionMode: "always-on",
      userCanDisable: false,
      enforcedCategories: ["ssn", "medical_record_number", "payment_card"],
    });

    const current: Settings = {
      ...DEFAULT_SETTINGS,
      enabledCategories: ["ssn", "medical_record_number", "payment_card", "email"],
    };

    // Employee tries to remove ssn and medical_record_number
    const mutation = applySettingsWithPolicy(
      current,
      { enabledCategories: ["email"] },
      adminPolicy,
    );

    expect(mutation.rejectedKeys.length).toBeGreaterThan(0);
    // Mandated categories must be present in the resolved settings
    expect(mutation.settings.enabledCategories).toContain("ssn");
    expect(mutation.settings.enabledCategories).toContain("medical_record_number");
    expect(mutation.settings.enabledCategories).toContain("payment_card");
    expect(mutation.settings.enabledCategories).toContain("email");
  });

  it("prevents employees from downgrading protectionMode when locked", () => {
    const adminPolicy = parseEnterprisePolicy({
      protectionMode: "always-on",
      userCanDisable: false,
      enforcedCategories: [],
    });

    const current: Settings = {
      ...DEFAULT_SETTINGS,
      protectionMode: "always-on",
    };

    // Employee tries to turn protection mode off
    const mutation = applySettingsWithPolicy(
      current,
      { protectionMode: "off" },
      adminPolicy,
    );

    expect(mutation.rejectedKeys.some((k) => k.key === "protectionMode")).toBe(true);
    expect(mutation.settings.protectionMode).toBe("always-on");
  });

  it("permits employee to customize user-controlled settings freely", () => {
    const adminPolicy = parseEnterprisePolicy({
      protectionMode: "always-on",
      userCanDisable: false,
      enforcedCategories: ["ssn"],
    });

    const current = { ...DEFAULT_SETTINGS };

    const mutation = applySettingsWithPolicy(
      current,
      {
        language: "es",
        fontSize: "large",
        highContrast: true,
        maskColor: "#1e293b",
      },
      adminPolicy,
    );

    expect(mutation.rejectedKeys.length).toBe(0);
    expect(mutation.settings.language).toBe("es");
    expect(mutation.settings.fontSize).toBe("large");
    expect(mutation.settings.highContrast).toBe(true);
    expect(mutation.settings.maskColor).toBe("#1e293b");
  });

  it("rejects tampering with system-controlled settings", () => {
    const adminPolicy = { ...NO_ENTERPRISE_POLICY };
    const current = { ...DEFAULT_SETTINGS, consentVersion: "1" };

    const check = validateSettingMutation("consentVersion", "999", current, adminPolicy);
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain("system-controlled");
  });
});

describe("Section 3: Managed Policy Receiving & Cryptographic Verification", () => {
  let testKeyPair: CryptoKeyPair;
  let testPublicKeyJwk: JsonWebKey;

  const enrollment: ManagementEnrollment = {
    organization_id: "org_acme_corp",
    organization_name: "Acme Corporation",
    employee_id: "emp_alice_123",
    employee_email: "alice@acme.com",
    device_id: "device_win_456",
    enrolled_at: "2026-03-01T12:00:00Z",
    management_mode: "MANAGE",
  };

  beforeEach(async () => {
    testKeyPair = (await crypto.subtle.generateKey(
      { name: "Ed25519" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    testPublicKeyJwk = await crypto.subtle.exportKey("jwk", testKeyPair.publicKey);
  });

  async function createSignedEnvelope(
    overrides: Partial<ManagedPolicyEnvelope> = {},
  ): Promise<ManagedPolicyEnvelope> {
    const rules = overrides.rules ?? [
      {
        id: "acme_rule_1",
        category: "ssn",
        pattern: "\\b\\d{3}-\\d{2}-\\d{4}\\b",
        confidence: 0.99,
        description: "Acme Employee SSN",
      },
    ];

    const settings = overrides.settings ?? {
      protectionMode: "always-on",
      userCanDisable: false,
      enforcedCategories: ["ssn", "medical_record_number"],
      networkDestinationPolicy: "managed_intranet",
      networkAllowlist: ["https://internal.acme.com"],
    };

    const contentHash = await computeManagedPolicyContentHash(rules, settings);

    const unsignedEnvelope: Omit<ManagedPolicyEnvelope, "policy_signature" | "signature_algorithm"> = {
      policy_id: overrides.policy_id ?? "pol_acme_prod_01",
      organization_id: overrides.organization_id ?? "org_acme_corp",
      organization_name: overrides.organization_name ?? "Acme Corporation",
      target: overrides.target ?? {
        organization_id: "org_acme_corp",
        employee_id: "emp_alice_123",
        device_id: "device_win_456",
      },
      policy_version: overrides.policy_version ?? 1,
      schema_version: overrides.schema_version ?? "2026-03",
      effective_at: overrides.effective_at ?? "2026-03-01T00:00:00Z",
      expires_at: overrides.expires_at ?? "2027-03-01T00:00:00Z",
      created_at: overrides.created_at ?? "2026-03-01T00:00:00Z",
      nonce: overrides.nonce ?? "nonce_random_abc12345",
      policy_hash: contentHash,
      rules,
      settings,
    };

    const canonical = canonicalizeManagedPolicyEnvelope(unsignedEnvelope);
    const data = new TextEncoder().encode(canonical);
    const sigBuf = await crypto.subtle.sign({ name: "Ed25519" }, testKeyPair.privateKey, data);
    const policy_signature = bytesToBase64(new Uint8Array(sigBuf));

    return {
      ...unsignedEnvelope,
      policy_signature,
      signature_algorithm: "Ed25519",
    };
  }

  it("verifies and accepts a valid administrator-approved policy payload", async () => {
    const envelope = await createSignedEnvelope();
    const result = await verifyAndValidateManagedPolicy(envelope, enrollment, null, Date.now(), testKeyPair.publicKey);

    expect(result.valid).toBe(true);
    expect(result.policy?.policy_id).toBe("pol_acme_prod_01");
  });

  it("translates a verified managed policy into an authoritative EnterprisePolicy", async () => {
    const envelope = await createSignedEnvelope({
      settings: {
        protectionMode: "always-on",
        userCanDisable: false,
        enforcedCategories: ["ssn", "medical_record_number"],
        networkDestinationPolicy: "managed_intranet",
        networkAllowlist: ["https://internal.acme.com"],
      },
    });

    const ep = managedPolicyToEnterprisePolicy(envelope);
    expect(ep.managed).toBe(true);
    expect(ep.protectionMode).toBe("always-on");
    expect(ep.userCanDisable).toBe(false);
    expect(ep.enforcedCategories).toEqual(["ssn", "medical_record_number"]);
    expect(ep.networkDestinationPolicy).toBe("managed_intranet");
    expect(ep.networkAllowlist).toEqual(["https://internal.acme.com"]);
  });

  it("rejects unsigned policy payloads immediately", async () => {
    const envelope = await createSignedEnvelope();
    const unsigned = { ...envelope, policy_signature: "" };

    const result = await verifyAndValidateManagedPolicy(unsigned, enrollment, null, Date.now(), testKeyPair.publicKey);
    expect(result.valid).toBe(false);
    expect(result.code).toBe("MALFORMED");
  });

  it("rejects tampered or forged policy signatures", async () => {
    const envelope = await createSignedEnvelope();
    // Tamper with policy_id after signing
    const tampered = { ...envelope, policy_id: "pol_rogue_injected" };

    const result = await verifyAndValidateManagedPolicy(tampered, enrollment, null, Date.now(), testKeyPair.publicKey);
    expect(result.valid).toBe(false);
    expect(result.code).toBe("SIGNATURE_INVALID");
  });

  it("rejects unauthorized policy from different organization", async () => {
    const envelope = await createSignedEnvelope({
      organization_id: "org_evil_corp",
      target: { organization_id: "org_evil_corp" },
    });

    const result = await verifyAndValidateManagedPolicy(envelope, enrollment, null, Date.now(), testKeyPair.publicKey);
    expect(result.valid).toBe(false);
    expect(result.code).toBe("UNAUTHORIZED");
  });

  it("rejects targeted policy intended for a different employee or device", async () => {
    const mismatchEmployee = await createSignedEnvelope({
      target: {
        organization_id: "org_acme_corp",
        employee_id: "emp_bob_other",
      },
    });

    const resultEmp = await verifyAndValidateManagedPolicy(mismatchEmployee, enrollment, null, Date.now(), testKeyPair.publicKey);
    expect(resultEmp.valid).toBe(false);
    expect(resultEmp.code).toBe("UNAUTHORIZED");

    const mismatchDevice = await createSignedEnvelope({
      target: {
        organization_id: "org_acme_corp",
        device_id: "device_mac_other",
      },
    });

    const resultDev = await verifyAndValidateManagedPolicy(mismatchDevice, enrollment, null, Date.now(), testKeyPair.publicKey);
    expect(resultDev.valid).toBe(false);
    expect(resultDev.code).toBe("UNAUTHORIZED");
  });

  it("defends against policy rollback and downgrade attacks", async () => {
    const appliedPolicy = await createSignedEnvelope({ policy_version: 5 });

    // Attacker attempts to replay an older policy version (e.g. version 2)
    const downgradeAttempt = await createSignedEnvelope({ policy_version: 2 });

    const result = await verifyAndValidateManagedPolicy(
      downgradeAttempt,
      enrollment,
      appliedPolicy,
      Date.now(),
      testKeyPair.publicKey,
    );

    expect(result.valid).toBe(false);
    expect(result.code).toBe("DOWNGRADE");
    expect(result.reason).toContain("Rollback attack detected");
  });

  it("rejects expired administrator policies", async () => {
    const expiredEnvelope = await createSignedEnvelope({
      expires_at: "2025-01-01T00:00:00Z",
    });

    const result = await verifyAndValidateManagedPolicy(
      expiredEnvelope,
      enrollment,
      null,
      new Date("2026-03-01T00:00:00Z").getTime(),
      testKeyPair.publicKey,
    );

    expect(result.valid).toBe(false);
    expect(result.code).toBe("EXPIRED");
  });

  it("creates minimal policy application acknowledgment with zero sensitive leak", () => {
    const ack = createPolicyAcknowledgment(enrollment, "pol_v2_update", 2, "applied");

    expect(ack.organization_id).toBe("org_acme_corp");
    expect(ack.employee_id).toBe("emp_alice_123");
    expect(ack.device_id).toBe("device_win_456");
    expect(ack.policy_id).toBe("pol_v2_update");
    expect(ack.policy_version).toBe(2);
    expect(ack.status).toBe("applied");

    // Strictly verify no leak
    const serialized = JSON.stringify(ack);
    expect(serialized).not.toContain("findings");
    expect(serialized).not.toContain("document");
    expect(serialized).not.toContain("history");
    expect(serialized).not.toContain("page");
    expect(serialized).not.toContain("clipboard");
  });
});
