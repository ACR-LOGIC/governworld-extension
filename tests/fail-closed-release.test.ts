// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Fail-closed verification for document and clipboard release operations (Objective 4).
import { describe, it, expect, beforeEach } from "vitest";
import { recordAudit, loadAuditLog, type AuditEvent } from "../src/shared/audit.js";

describe("fail-closed protected operations (Objective 4)", () => {
  let mockStorage: Record<string, unknown> = {};
  let shouldFailStorage = false;

  beforeEach(() => {
    mockStorage = {};
    shouldFailStorage = false;
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: mockStorage[key] }),
          set: async (items: Record<string, unknown>) => {
            if (shouldFailStorage) {
              throw new Error("QuotaExceededError: storage write failed");
            }
            Object.assign(mockStorage, items);
          },
        },
      },
    };
  });

  it("fails closed on protected document redaction audit error", async () => {
    const event: AuditEvent = {
      ts: "2026-08-21T00:00:00.000Z",
      action: "doc_redacted",
      docHash: "a".repeat(64),
      pages: 1,
      outcome: "ok",
    };

    // 1. Success path
    await expect(recordAudit(event, { failClosed: true })).resolves.toBeUndefined();
    const log1 = await loadAuditLog();
    expect(log1).toHaveLength(1);

    // 2. Storage failure path with failClosed: true MUST throw
    shouldFailStorage = true;
    const event2: AuditEvent = {
      ts: "2026-08-21T00:01:00.000Z",
      action: "doc_redacted",
      docHash: "b".repeat(64),
      pages: 1,
      outcome: "ok",
    };

    await expect(recordAudit(event2, { failClosed: true })).rejects.toThrow("QuotaExceededError");

    // 3. Unprotected/best-effort event does NOT throw
    const nonProtectedEvent: AuditEvent = {
      ts: "2026-08-21T00:02:00.000Z",
      action: "page_scan_completed",
      outcome: "ok",
    };
    await expect(recordAudit(nonProtectedEvent, { failClosed: false })).resolves.toBeUndefined();
  });

  it("fails closed on clipboard selection redaction audit error", async () => {
    shouldFailStorage = true;
    const selectionEvent: AuditEvent = {
      ts: "2026-08-21T00:00:00.000Z",
      action: "selection_redacted",
      counts: { ssn: 1 },
      outcome: "ok",
    };

    // Protected clipboard release requires failClosed: true
    await expect(recordAudit(selectionEvent, { failClosed: true })).rejects.toThrow("QuotaExceededError");
  });
});
