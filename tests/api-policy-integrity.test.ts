// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  canonicalizePolicyRules,
  computeSha256Hex,
  generateEd25519PolicyKeyPair,
  signPolicyPackageEd25519,
  verifyPolicyIntegrity,
  syncPolicy,
} from "../src/api/policies.js";
import { GovernWorldApiClient } from "../src/api/client.js";
import type { PolicyPackage } from "../src/api/types.js";

describe("Policy Synchronization & Cryptographic Integrity", () => {
  beforeEach(() => {
    const localStore: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: localStore[key] })),
          set: vi.fn(async (items: Record<string, unknown>) => {
            Object.assign(localStore, items);
          }),
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("verifies matching SHA-256 cryptographic hash and Ed25519 signature for valid policy packages", async () => {
    const keypair = await generateEd25519PolicyKeyPair();
    const rules = [
      {
        id: "rule_custom_1",
        category: "ssn",
        pattern: "\\b\\d{3}-\\d{2}-\\d{4}\\b",
        cues: ["ssn", "social"],
        confidence: 0.95,
        description: "Standard US SSN",
      },
      {
        id: "rule_custom_2",
        category: "payment_card",
        pattern: "\\b\\d{16}\\b",
        confidence: 0.9,
        description: "16-digit card",
      },
    ];

    const canonical = canonicalizePolicyRules(rules);
    const expectedHash = await computeSha256Hex(canonical);

    const unsignedPackage: PolicyPackage = {
      policy_id: "pol_acme_v1",
      policy_version: "1.0.0",
      effective_at: "2026-01-01T00:00:00Z",
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      policy_hash: expectedHash,
      rules,
    };
    const signature = await signPolicyPackageEd25519(unsignedPackage, keypair.privateKey);
    const validPackage: PolicyPackage = {
      ...unsignedPackage,
      policy_signature: signature,
      signature_algorithm: "Ed25519",
    };

    const verification = await verifyPolicyIntegrity(validPackage, Date.now(), {
      trustedPublicKeyJwk: keypair.publicKeyJwk,
    });
    expect(verification.valid).toBe(true);
    expect(verification.signatureVerified).toBe(true);
  });

  it("rejects unsigned policy packages unconditionally even when requireSignature is omitted or false", async () => {
    const rules = [
      {
        id: "rule_unsigned",
        category: "ssn",
        pattern: "\\b\\d{3}-\\d{2}-\\d{4}\\b",
        confidence: 0.95,
      },
    ];
    const expectedHash = await computeSha256Hex(canonicalizePolicyRules(rules));
    const unsignedPackage: PolicyPackage = {
      policy_id: "pol_unsigned",
      policy_version: "1.0.0",
      effective_at: "2026-01-01T00:00:00Z",
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      policy_hash: expectedHash,
      rules,
    };

    const verificationDefault = await verifyPolicyIntegrity(unsignedPackage);
    expect(verificationDefault.valid).toBe(false);
    expect(verificationDefault.reason).toContain("missing required Ed25519 signature");

    const verificationOptOut = await verifyPolicyIntegrity(unsignedPackage, Date.now(), {
      requireSignature: false,
    });
    expect(verificationOptOut.valid).toBe(false);
  });

  it("detects tampering and rejects policy when any rule pattern or cue is modified", async () => {
    const keypair = await generateEd25519PolicyKeyPair();
    const rules = [
      {
        id: "rule_tamper",
        category: "ssn",
        pattern: "\\b\\d{3}-\\d{2}-\\d{4}\\b",
        confidence: 0.95,
      },
    ];

    const canonical = canonicalizePolicyRules(rules);
    const legitimateHash = await computeSha256Hex(canonical);
    const basePkg: PolicyPackage = {
      policy_id: "pol_tampered",
      policy_version: "1.0.0",
      effective_at: "2026-01-01T00:00:00Z",
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      policy_hash: legitimateHash,
      rules,
    };
    const signature = await signPolicyPackageEd25519(basePkg, keypair.privateKey);

    // Tamper with regex pattern
    const tamperedPackage: PolicyPackage = {
      ...basePkg,
      policy_signature: signature,
      signature_algorithm: "Ed25519",
      rules: [
        {
          id: "rule_tamper",
          category: "ssn",
          pattern: ".*", // Tampered wildcard!
          confidence: 0.95,
        },
      ],
    };

    const verification = await verifyPolicyIntegrity(tamperedPackage, Date.now(), {
      trustedPublicKeyJwk: keypair.publicKeyJwk,
    });
    expect(verification.valid).toBe(false);
    expect(verification.reason).toContain("Integrity check failed");
  });

  it("fails closed when policy payload is expired", async () => {
    const keypair = await generateEd25519PolicyKeyPair();
    const rules = [
      {
        id: "rule_expired",
        category: "email",
        pattern: "\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Z|a-z]{2,}\\b",
        confidence: 0.9,
      },
    ];

    const canonical = canonicalizePolicyRules(rules);
    const hash = await computeSha256Hex(canonical);

    const expiredBase: PolicyPackage = {
      policy_id: "pol_expired",
      policy_version: "1.0.0",
      effective_at: "2020-01-01T00:00:00Z",
      expires_at: "2020-12-31T23:59:59Z", // Expired years ago
      policy_hash: hash,
      rules,
    };
    const expiredPackage: PolicyPackage = {
      ...expiredBase,
      policy_signature: await signPolicyPackageEd25519(expiredBase, keypair.privateKey),
      signature_algorithm: "Ed25519",
    };

    const verification = await verifyPolicyIntegrity(expiredPackage, Date.now(), {
      trustedPublicKeyJwk: keypair.publicKeyJwk,
    });
    expect(verification.valid).toBe(false);
    expect(verification.reason).toContain("Policy expired");
  });

  it("refuses to activate corrupted policy payload during synchronization", async () => {
    const corruptedPayload: PolicyPackage = {
      policy_id: "pol_corrupted",
      policy_version: "2.0.0",
      effective_at: "2026-01-01T00:00:00Z",
      policy_hash: "0000000000000000000000000000000000000000000000000000000000000000",
      rules: [
        {
          id: "rule_corrupt",
          category: "secrets",
          pattern: "sk-[A-Za-z0-9]{32}",
          confidence: 0.99,
        },
      ],
    };

    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify(corruptedPayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const client = new GovernWorldApiClient("https://api.governworld.com");
    const res = await syncPolicy(client, "mock_token");

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("Policy activation rejected");
    }
  });
});
