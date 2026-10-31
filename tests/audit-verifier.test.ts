// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  canonicalEventLine,
  toAuditJsonl,
  sha256Hex,
  type AuditEvent,
  type SignedAuditExport,
} from "../src/shared/audit.js";

describe("standalone audit verifier tool (scripts/verify-audit.mjs)", () => {
  const tmpExportPath = path.resolve(process.cwd(), ".tmp-test-audit-export.json");

  afterEach(() => {
    if (fs.existsSync(tmpExportPath)) {
      try {
        fs.unlinkSync(tmpExportPath);
      } catch {
        // ignore
      }
    }
  });

  it("verifies an authentic signed export and rejects a tampered export", async () => {
    // 1. Build an authentic chained event list
    const event1: AuditEvent = { ts: "2026-08-21T00:00:00.000Z", action: "page_scan_completed", outcome: "ok" };
    const prev1 = await sha256Hex(canonicalEventLine(event1));
    const event2: AuditEvent = { ts: "2026-08-21T00:01:00.000Z", action: "masks_applied", prevHash: prev1, outcome: "ok" };
    const prev2 = await sha256Hex(canonicalEventLine(event2));
    const event3: AuditEvent = { ts: "2026-08-21T00:02:00.000Z", action: "doc_redacted", pages: 1, prevHash: prev2, outcome: "ok" };

    const events = [event1, event2, event3];
    const jsonl = toAuditJsonl(events);

    // 2. Sign with ECDSA P-256
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const publicKeyJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const data = new TextEncoder().encode(jsonl);
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, data);
    const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signature)));

    const exportData: SignedAuditExport = {
      jsonl,
      signatureBase64,
      publicKeyJwk,
      exportedAt: new Date().toISOString(),
      eventCount: events.length,
    };

    fs.writeFileSync(tmpExportPath, JSON.stringify(exportData, null, 2), "utf8");

    // 3. Run CLI verification - should succeed (exit code 0)
    const out = execFileSync("node", ["scripts/verify-audit.mjs", tmpExportPath], { encoding: "utf8" });
    expect(out).toContain("VERIFICATION SUCCESSFUL");
    expect(out).toContain("Hash chain verified intact across 3 events");

    // 4. Tamper with the jsonl content (simulate attacker altering an event)
    const tampered = { ...exportData, jsonl: exportData.jsonl.replace('"page_scan_completed"', '"unauthorized_export"') };
    fs.writeFileSync(tmpExportPath, JSON.stringify(tampered, null, 2), "utf8");

    // 5. Run CLI verification - should fail (exit non-zero)
    let failed = false;
    try {
      execFileSync("node", ["scripts/verify-audit.mjs", tmpExportPath], { encoding: "utf8" });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });
});
