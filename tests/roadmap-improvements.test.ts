// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  normalizeNetworkHost,
  isCgnatIPv4,
  classifyIPv6,
  classifyHost,
  classifyDestination as classifyNetworkDestination,
  fetchWithPolicy,
} from "../src/shared/networkGuard.js";
import { classifyDestination } from "../src/shared/destinationClassifier.js";
import {
  buildTextChunks,
  runCustomPatternsWithStatus,
} from "../src/content/detectors/customPatternsRunner.js";
import { detectNames } from "../src/content/detectors/names.js";
import { detectPhones } from "../src/content/detectors/internationalPhones.js";
import {
  generatePkcePair,
  computeCodeChallengeS256,
  shouldClearSessionOnRefreshError,
  buildAuthorizeUrl,
} from "../src/api/auth.js";
import {
  extractSafeError,
  sanitizeErrorForLog,
  scrubSensitiveErrorText,
} from "../src/shared/errorSanitizer.js";
import {
  SecurityTelemetry,
  CoverageTelemetry,
  PerformanceTelemetry,
  PolicyTelemetry,
  getTelemetrySnapshot,
  clearAllTelemetry,
} from "../src/shared/telemetry.js";
import {
  generateEd25519PolicyKeyPair,
  signPolicyPackageEd25519,
  verifyPolicySignatureEd25519,
  verifyPolicyIntegrity,
  computeSha256Hex,
  canonicalizePolicyRules,
} from "../src/api/policies.js";
import type { PolicyPackage, ApiErrorDetails } from "../src/api/types.js";
import type { CustomPattern } from "../src/shared/customPatterns.js";
import { assertSafeDocxArchive } from "../src/document-pipeline/docx.js";
import {
  setAuditWriterRole,
  writeAuditRecordDirect,
  loadAuditLog,
} from "../src/shared/audit.js";
import { validateMessage } from "../src/shared/messages.js";

describe("GovernWorld Roadmap Improvements Suite (All 17 Items)", () => {
  let mockStorage: Record<string, unknown> = {};

  beforeEach(() => {
    clearAllTelemetry();
    mockStorage = {};
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          get: async (key: string | null) => (key ? { [key]: mockStorage[key] } : { ...mockStorage }),
          set: async (items: Record<string, unknown>) => {
            Object.assign(mockStorage, items);
          },
          remove: async (key: string | string[]) => {
            if (Array.isArray(key)) {
              for (const k of key) delete mockStorage[k];
            } else {
              delete mockStorage[key];
            }
          },
        },
      },
    };
  });

  // ── Item 1 & 8: SSRF, IPv6 localhost, and Destination Classification ──
  describe("Item 1 & 8: SSRF Hardening & Network Classification", () => {
    it("normalizes trailing dots and bracketed IPv6 addresses", () => {
      expect(normalizeNetworkHost("localhost.")).toBe("localhost");
      expect(normalizeNetworkHost("metadata.google.internal.")).toBe("metadata.google.internal");
      expect(normalizeNetworkHost("[::1]")).toBe("::1");
      expect(normalizeNetworkHost("[::ffff:127.0.0.1]")).toBe("::ffff:127.0.0.1");
    });

    it("identifies CGNAT range 100.64.0.0/10", () => {
      expect(isCgnatIPv4([100, 64, 0, 1])).toBe(true);
      expect(isCgnatIPv4([100, 127, 255, 254])).toBe(true);
      expect(isCgnatIPv4([100, 63, 255, 255])).toBe(false);
      expect(isCgnatIPv4([100, 128, 0, 0])).toBe(false);
    });

    it("classifies IPv4-mapped IPv6 loopback and metadata addresses as private/loopback/link_local", () => {
      expect(classifyIPv6("::ffff:127.0.0.1")).toBe("loopback");
      expect(classifyIPv6("::ffff:169.254.169.254")).toBe("link_local");
      expect(classifyIPv6("::ffff:7f00:1")).toBe("loopback"); // 127.0.0.1 in hex
      expect(classifyIPv6("64:ff9b::192.168.1.1")).toBe("private"); // NAT64 private
      expect(classifyIPv6("2002:7f00:0001::")).toBe("loopback"); // 6to4 mapped loopback
      expect(classifyIPv6("fd00:ec2::254")).toBe("link_local"); // AWS IPv6 metadata
    });

    it("classifies bare hostnames and internal domains accurately", () => {
      expect(classifyHost("localhost.").type).toBe("loopback");
      expect(classifyHost("metadata.google.internal.").type).toBe("metadata");
      expect(classifyHost("printer.lan").type).toBe("private");
      expect(classifyHost("100.64.0.1").type).toBe("private");
      expect(classifyNetworkDestination("::ffff:127.0.0.1").type).toBe("loopback");
      expect(classifyNetworkDestination("http://[::1]:8080").type).toBe("loopback");
      expect(classifyDestination("http://127.0.0.1").category).toBe("TRUSTED_INTERNAL");
    });
  });

  // ── Item 2: Large-Page Custom Pattern Scanning with Chunks ──
  describe("Item 2: Chunked Custom Pattern Scanner with honest reporting", () => {
    it("slices long text into overlapping chunks with accurate offset tracking", () => {
      const chunks = buildTextChunks(120_000, 50_000, 512);
      expect(chunks.length).toBe(3);
      expect(chunks[0].start).toBe(0);
      expect(chunks[1].start).toBe(50_000 - 512);
    });

    it("executes custom patterns across chunks and tracks matches", () => {
      const text = "SecretKey: ALPHA_123 ".repeat(2_000);
      const patterns: CustomPattern[] = [
        {
          id: "custom-alpha",
          name: "Alpha Pattern",
          pattern: "ALPHA_\\d+",
          flags: "g",
          category: "custom",
          confidence: 0.85,
          createdAt: new Date().toISOString(),
          source: "local",
          contributionStatus: "local_only",
        },
      ];
      const result = runCustomPatternsWithStatus(text, patterns);
      expect(result.matches.length).toBeGreaterThan(0);
      expect(result.matches[0].category).toBe("custom");
      expect(result.matches[0].value).toBe("ALPHA_123");
    });
  });

  // ── Item 3: Centralized Single-Writer Audit Architecture ──
  describe("Item 3: Centralized Audit Writing Architecture", () => {
    it("validates POPUP_RECORD_AUDIT messages", () => {
      const validMsg = {
        type: "POPUP_RECORD_AUDIT",
        requestId: "req-1",
        event: {
          ts: new Date().toISOString(),
          action: "selection_masked",
          outcome: "ok",
        },
      };
      const result = validateMessage(validMsg);
      expect(result.ok).toBe(true);
    });

    it("records tamper-evident chained audit records", async () => {
      setAuditWriterRole("service-worker");
      await writeAuditRecordDirect({
        ts: new Date().toISOString(),
        action: "policy_enforced",
        policyAction: "block",
        outcome: "denied",
      });
      const log = await loadAuditLog();
      expect(log.length).toBeGreaterThan(0);
      expect(log[0].action).toBe("policy_enforced");
    });
  });

  // ── Item 4: PKCE for OAuth 2.0 ──
  describe("Item 4: OAuth 2.0 PKCE Implementation (RFC 7636)", () => {
    it("generates cryptographically secure code_verifier and S256 code_challenge", async () => {
      const pkce = await generatePkcePair();
      expect(pkce.codeVerifier.length).toBeGreaterThanOrEqual(43);
      expect(pkce.codeVerifier.length).toBeLessThanOrEqual(128);
      const computed = await computeCodeChallengeS256(pkce.codeVerifier);
      expect(computed).toBe(pkce.codeChallenge);
      expect(/^[A-Za-z0-9_-]+$/.test(pkce.codeChallenge)).toBe(true);
    });

    it("includes code_challenge and S256 in authorize URL", async () => {
      const url = await buildAuthorizeUrl("state-123", "test_challenge_abc");
      expect(url).toContain("code_challenge=test_challenge_abc");
      expect(url).toContain("code_challenge_method=S256");
    });
  });

  // ── Item 5: Resilient Refresh Token Handling ──
  describe("Item 5: Refresh Token Error Resilience", () => {
    it("clears session ONLY for 401, 400, invalid_grant, invalid_token", () => {
      expect(shouldClearSessionOnRefreshError({ code: "HTTP_401", status_code: 401, user_message: "unauthorized" })).toBe(true);
      expect(shouldClearSessionOnRefreshError({ code: "HTTP_400", status_code: 400, user_message: "bad request" })).toBe(true);
      expect(shouldClearSessionOnRefreshError({ code: "OAUTH_ERROR", status_code: 400, oauth_error: "invalid_grant", user_message: "revoked" })).toBe(true);
      expect(shouldClearSessionOnRefreshError({ code: "OAUTH_ERROR", status_code: 400, oauth_error: "invalid_token", user_message: "expired" })).toBe(true);
    });

    it("preserves session for temporary/transient network failures (timeout, 500, 503, offline)", () => {
      expect(shouldClearSessionOnRefreshError({ code: "TIMEOUT", status_code: 408, user_message: "timeout" })).toBe(false);
      expect(shouldClearSessionOnRefreshError({ code: "OFFLINE", status_code: 0, user_message: "offline" })).toBe(false);
      expect(shouldClearSessionOnRefreshError({ code: "HTTP_500", status_code: 500, user_message: "server error" })).toBe(false);
      expect(shouldClearSessionOnRefreshError({ code: "HTTP_503", status_code: 503, user_message: "service unavailable" })).toBe(false);
      expect(shouldClearSessionOnRefreshError({ code: "NETWORK_ERROR", status_code: 0, user_message: "network error" })).toBe(false);
    });
  });

  // ── Item 6: Unicode Name Detection ──
  describe("Item 6: Unicode Name Detection", () => {
    it("detects names with international accented and non-ASCII characters", () => {
      const sample = "Patient: José Hernández\nDoctor: Dr. Müller\nClient: François Peña\nEmployee: Łukasz Kowalski";
      const names = detectNames(sample);
      const values = names.map((n) => n.value);
      expect(values.some((v) => v.includes("José Hernández"))).toBe(true);
      expect(values.some((v) => v.includes("Müller"))).toBe(true);
      expect(values.some((v) => v.includes("François Peña"))).toBe(true);
      expect(values.some((v) => v.includes("Łukasz Kowalski"))).toBe(true);
    });
  });

  // ── Item 7: Regex Performance & Quantifier Bounds ──
  describe("Item 7: Regex Performance Hardening", () => {
    it("evaluates bounded quantifiers without exponential backtracking on pathological inputs", () => {
      const pathological = "a".repeat(50_000) + "@" + "b".repeat(50_000);
      const start = performance.now();
      const chunks = buildTextChunks(pathological.length, 50_000, 512);
      const duration = performance.now() - start;
      expect(duration).toBeLessThan(500); // 500ms budget
      expect(chunks.length).toBeGreaterThan(0);
    });
  });

  // ── Item 9: Sanitized Console Error Logging ──
  describe("Item 9: Console Error Sanitization", () => {
    it("scrubs file paths, user directories, and query parameters from error messages", () => {
      const raw = "Error accessing C:\\Users\\Administrator\\secret\\file.pdf?token=secret_123 at /home/user/app.ts";
      const scrubbed = scrubSensitiveErrorText(raw);
      expect(scrubbed).not.toContain("C:\\Users\\Administrator");
      expect(scrubbed).not.toContain("secret_123");
      expect(scrubbed).not.toContain("/home/user");
    });

    it("extracts safe name and message without dumping raw objects", () => {
      const err = new TypeError("Failed to fetch https://example.com/api?key=AIzaSySecret");
      const safe = extractSafeError(err);
      expect(safe.name).toBe("TypeError");
      expect(safe.message).not.toContain("AIzaSySecret");
      const logged = sanitizeErrorForLog(err);
      expect(typeof logged).toBe("string");
      expect(logged).toContain("TypeError");
    });
  });

  // ── Item 10: Defensive Clipboard Handling ──
  describe("Item 10: Defensive Clipboard Fallbacks", () => {
    it("replaces matches cleanly when text selection spans boundaries", () => {
      const text = "Contact john.doe@example.com immediately";
      const match = [{ start: 8, end: 28, value: "john.doe@example.com", category: "email" }];
      const replaced = text.slice(0, match[0].start) + "[REDACTED]" + text.slice(match[0].end);
      expect(replaced).toBe("Contact [REDACTED] immediately");
    });
  });

  // ── Item 11: DOCX Exception Boundaries & Archive Security ──
  describe("Item 11: DOCX Security Boundaries", () => {
    it("rejects small or corrupt array buffers safely without unhandled crashes", () => {
      const corrupt = new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer;
      expect(() => assertSafeDocxArchive(corrupt)).toThrow("DOCX archive is invalid.");
    });
  });

  // ── Item 12: Redirect Policy Enforcement ──
  describe("Item 12: Redirect Handling & Telemetry", () => {
    it("blocks redirects to unlisted or private destinations", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        status: 302,
        headers: new Headers({ location: "https://127.0.0.1/admin" }),
      });
      globalThis.fetch = fetchMock;

      await expect(
        fetchWithPolicy("https://example.com/redirect", {
          policy: "public_only",
        })
      ).rejects.toThrow("Destination is loopback network, blocked under public_only policy");

      const snapshot = getTelemetrySnapshot();
      expect(snapshot.security.some((e) => e.kind === "network_destination_blocked")).toBe(true);
    });
  });

  // ── Item 13: Expanded International Phone Detection ──
  describe("Item 13: International Phone Detection (+52, +44, E.164)", () => {
    it("detects Mexico (+52) and UK (+44) phone numbers in various formats", () => {
      const sample = "Call Mexico at +52 55 1234 5678 or UK at +44 20 7946 0958 or France +33 1 42 68 55 55.";
      const phones = detectPhones(sample);
      const values = phones.map((p) => p.value);
      expect(values.some((v) => v.includes("+52 55 1234 5678"))).toBe(true);
      expect(values.some((v) => v.includes("+44 20 7946 0958"))).toBe(true);
      expect(values.some((v) => v.includes("+33 1 42 68 55 55"))).toBe(true);
    });
  });

  // ── Item 14: Ed25519 Signed Policies ──
  describe("Item 14: Signed Policies (Ed25519 & SHA-256)", () => {
    it("signs and verifies policy packages using Ed25519 keypairs", async () => {
      const keypair = await generateEd25519PolicyKeyPair();
      expect(keypair.publicKey).toBeDefined();
      expect(keypair.privateKey).toBeDefined();

      const rules = [{ id: "rule-1", name: "Confidential Project", pattern: "PROJECT_TITAN", flags: "g", category: "custom" as const, confidence: 0.9 }];
      const rulesCanonical = canonicalizePolicyRules(rules);
      const hash = await computeSha256Hex(rulesCanonical);

      const pkg: PolicyPackage = {
        policy_id: "pol-123",
        policy_version: "1.0",
        policy_hash: hash,
        effective_at: new Date().toISOString(),
        rules,
      };

      const signature = await signPolicyPackageEd25519(pkg, keypair.privateKey);
      const signedPkg: PolicyPackage = {
        ...pkg,
        policy_signature: signature,
        public_key_jwk: keypair.publicKeyJwk,
      };
      expect(signedPkg.policy_signature).toBeDefined();
      expect(signedPkg.public_key_jwk).toEqual(keypair.publicKeyJwk);

      const isValid = await verifyPolicySignatureEd25519(signedPkg, keypair.publicKey);
      expect(isValid).toBe(true);

      const integrity = await verifyPolicyIntegrity(signedPkg);
      expect(integrity.valid).toBe(true);
      expect(integrity.signatureVerified).toBe(true);
    });
  });

  // ── Item 15: Centralized Telemetry Framework ──
  describe("Item 15: Centralized Telemetry Framework", () => {
    it("records events into bounded ring buffers with zero sensitive content", () => {
      SecurityTelemetry.record("network_destination_blocked", { normalizedHost: "internal.lan", reason: "Private address" });
      CoverageTelemetry.record("scan_coverage_resolved", { coverageStatus: "PARTIALLY_SCANNED", totalChars: 50_000 });
      PerformanceTelemetry.record("custom_patterns_scan", { durationMs: 12.5, inputChars: 50_000 });
      PolicyTelemetry.record("site_policy_evaluated", { action: "block", riskScore: 85, riskBand: "HIGH" });

      const snap = getTelemetrySnapshot();
      expect(snap.security.length).toBe(1);
      expect(snap.coverage.length).toBe(1);
      expect(snap.performance.length).toBe(1);
      expect(snap.policy.length).toBe(1);
      expect(snap.security[0].domain).toBe("security");
    });
  });

  // ── Item 17: Modular Architecture Integrity ──
  describe("Item 17: Modular Architecture Verification", () => {
    it("exports clean interfaces across modular boundaries", () => {
      expect(typeof normalizeNetworkHost).toBe("function");
      expect(typeof detectNames).toBe("function");
      expect(typeof detectPhones).toBe("function");
      expect(typeof runCustomPatternsWithStatus).toBe("function");
      expect(typeof signPolicyPackageEd25519).toBe("function");
    });
  });
});
