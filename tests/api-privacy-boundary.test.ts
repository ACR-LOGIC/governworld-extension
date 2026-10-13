// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GovernWorldApiClient } from "../src/api/client.js";
import { checkHealth } from "../src/api/health.js";
import { performBootstrap } from "../src/api/bootstrap.js";
import { fetchCapabilities } from "../src/api/capabilities.js";
import { fetchEntitlements } from "../src/api/entitlements.js";
import { syncPolicy } from "../src/api/policies.js";
import { submitLogic, validateSubmissionPayload } from "../src/api/submissions.js";
import { reportAuditEvent } from "../src/api/events.js";

describe("API Privacy Boundary & Zero-Sensitive-Egress Invariants", () => {
  // Concrete synthetic canaries that must never appear in any outbound payload.
  // 219-09-9999 is a never-issued SSN, 4111111111111111 is the documented test
  // card, and .test domains are RFC 2606 fixtures. Checking literal values
  // (rather than regexes) keeps rule-pattern syntax such as "^EMP-[0-9]{6}$"
  // in submissions from false-positive matching.
  const SSN_CANARY = "219-09-9999";
  const CARD_CANARY = "4111111111111111";
  const EMAIL_CANARY = "canary.person@example.test";
  const SENSITIVE_TERM_CANARY = /patient|diagnosis|prescription|medication/i;

  function assertNoSensitiveContent(payloadStr: string): void {
    expect(payloadStr).not.toContain(SSN_CANARY);
    expect(payloadStr).not.toContain(CARD_CANARY);
    expect(payloadStr).not.toContain(EMAIL_CANARY);
    expect(payloadStr).not.toMatch(SENSITIVE_TERM_CANARY);
  }

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("health check request carries zero sensitive payload or data", async () => {
    let capturedBody: string | undefined;

    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      capturedBody = init?.body as string | undefined;
      return new Response(
        JSON.stringify({
          status: "ok",
          api_version: "v1",
          min_extension_version: "0.1.0",
          server_time: new Date().toISOString(),
          kill_switch: "ENABLED",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const client = new GovernWorldApiClient("https://api.governworld.com");
    await checkHealth(client);

    expect(capturedBody).toBeUndefined();
  });

  it("bootstrap handshake carries zero sensitive document contents or OCR text", async () => {
    let capturedBody: string | undefined;

    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      capturedBody = init?.body as string | undefined;
      return new Response(
        JSON.stringify({
          server_time: new Date().toISOString(),
          api_version: "v1",
          min_extension_version: "0.1.0",
          tenant: { tenant_id: "org_test", tenant_name: "Test Org", roles: ["admin"], verified: true },
          capabilities: ["policy_sync"],
          entitlements: { tier: "pro", features: [] },
          kill_switch: "ENABLED",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const client = new GovernWorldApiClient("https://api.governworld.com");
    await performBootstrap(client, "valid_token");

    expect(capturedBody).toBeDefined();
    expect(capturedBody).toBe("{}"); // Empty body on bootstrap POST
    assertNoSensitiveContent(capturedBody!);
  });

  it("logic submissions transmit only regex specifications and category metadata, never raw examples", async () => {
    let capturedBody: string | undefined;

    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      capturedBody = init?.body as string | undefined;
      return new Response(
        JSON.stringify({
          submission_id: "GW-SUB-999888",
          status: "pending_review",
          submitted_at: new Date().toISOString(),
          rule_name: "Internal ID Rule",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const client = new GovernWorldApiClient("https://api.governworld.com");
    const res = await submitLogic(
      client,
      {
        rule_name: "Internal Employee ID",
        category: "custom",
        pattern: "^EMP-[0-9]{6}$",
        cues: ["employee", "badge"],
        description: "Company badge numbers",
      },
      "valid_token"
    );

    expect(res.ok).toBe(true);
    expect(capturedBody).toBeDefined();
    const parsed = JSON.parse(capturedBody!);
    expect(parsed.rule_name).toBe("Internal Employee ID");
    expect(parsed.pattern).toBe("^EMP-[0-9]{6}$");
    expect(parsed.raw_examples).toBeUndefined();
    expect(parsed.document_bytes).toBeUndefined();
    expect(parsed.ocr_text).toBeUndefined();
    assertNoSensitiveContent(capturedBody!);
  });

  it("audit events contain only clean diagnostic metadata and zero raw PHI/PII or OCR text", async () => {
    let capturedBody: string | undefined;

    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      capturedBody = init?.body as string | undefined;
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const client = new GovernWorldApiClient("https://api.governworld.com");
    const res = await reportAuditEvent(client, {
      timestamp: new Date().toISOString(),
      tenant_id: "org_acme_123",
      event_type: "dom_mask_applied",
      policy_id: "pol_v1",
      policy_version: "1.0.0",
      operation_result: "success",
      request_id: "req_test_123",
    });

    expect(res.ok).toBe(true);
    expect(capturedBody).toBeDefined();
    const parsed = JSON.parse(capturedBody!);

    expect(parsed.event_id).toBeDefined();
    expect(parsed.installation_id).toBeDefined();
    expect(parsed.event_type).toBe("dom_mask_applied");
    expect(parsed.phi).toBeUndefined();
    expect(parsed.pii).toBeUndefined();
    expect(parsed.ocr_text).toBeUndefined();
    expect(parsed.raw_content).toBeUndefined();
    assertNoSensitiveContent(capturedBody!);
  });
});
