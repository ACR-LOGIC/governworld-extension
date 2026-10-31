// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect } from "vitest";
import { beforeEach } from "vitest";
import {
  isAuditEvent,
  isAuditAction,
  canonicalEventLine,
  toAuditJsonl,
  trimEvents,
  sha256Hex,
  verifyAuditChain,
  recordAudit,
  loadAuditLog,
  AUDIT_ACTIONS,
  AUDIT_MAX_EVENTS,
  type AuditEvent,
} from "../src/shared/audit.js";

const base: AuditEvent = { ts: "2026-08-21T00:00:00.000Z", action: "page_scan_completed", outcome: "ok" };

describe("audit event validation", () => {
  it("accepts a minimal valid event", () => {
    expect(isAuditEvent(base)).toBe(true);
  });

  it("accepts full events", () => {
    expect(
      isAuditEvent({
        ...base,
        host: "example.com",
        counts: { email: 2, ssn: 1 },
        docHash: "a".repeat(64),
        pages: 3,
      })
    ).toBe(true);
  });

  it("rejects unknown actions and outcomes", () => {
    expect(isAuditEvent({ ...base, action: "exfiltrate" })).toBe(false);
    expect(isAuditEvent({ ...base, outcome: "allowed" })).toBe(false);
  });

  it("rejects malformed hashes, hosts, counts, pages", () => {
    expect(isAuditEvent({ ...base, docHash: "xyz" })).toBe(false);
    expect(isAuditEvent({ ...base, host: "" })).toBe(false);
    expect(isAuditEvent({ ...base, counts: { email: -1 } })).toBe(false);
    expect(isAuditEvent({ ...base, pages: 1.5 })).toBe(false);
    expect(isAuditEvent(null)).toBe(false);
  });

  it("accepts preset audit events with policy-reference metadata", () => {
    expect(
      isAuditEvent({ ...base, action: "preset_applied", presetId: "hipaa", enabledCategories: ["ssn", "email"], outcome: "ok" })
    ).toBe(true);
    expect(
      isAuditEvent({ ...base, action: "preset_overridden", presetId: "hipaa", enabledCategories: ["ssn"], outcome: "ok" })
    ).toBe(true);
    expect(isAuditEvent({ ...base, action: "preset_applied", presetId: 42 })).toBe(false);
    expect(isAuditEvent({ ...base, action: "preset_applied", enabledCategories: [""] })).toBe(false);
  });
});

describe("canonical serialization", () => {
  it("emits stable key order regardless of construction order", () => {
    const a = canonicalEventLine({ outcome: "ok", ts: base.ts, action: base.action });
    const b = canonicalEventLine({ ts: base.ts, action: base.action, outcome: "ok" });
    expect(a).toBe(b);
    expect(a.indexOf('"ts"')).toBeLessThan(a.indexOf('"action"'));
  });

  it("omits undefined fields", () => {
    const line = canonicalEventLine(base);
    expect(line).not.toContain("host");
    expect(line).not.toContain("docHash");
  });

  it("serializes preset metadata in stable order", () => {
    const line = canonicalEventLine({ ...base, action: "preset_overridden", presetId: "hipaa", enabledCategories: ["ssn", "email"] });
    expect(line).toContain('"presetId":"hipaa"');
    expect(line.indexOf('"presetId"')).toBeLessThan(line.indexOf('"enabledCategories"'));
  });

  it("accepts the context-menu redaction actions", () => {
    // A right-click redaction writes content to the clipboard, so it is an
    // audited operation like any other. These actions were added after the
    // context-menu path shipped without a record.
    expect(isAuditEvent({ ...base, action: "selection_redacted", counts: { email: 2 }, outcome: "ok" })).toBe(true);
    expect(isAuditEvent({ ...base, action: "selection_masked", outcome: "error" })).toBe(true);
  });

  it("keeps the action union and the validator in step", () => {
    // These were two hand-maintained lists of the same values. An action added
    // to one but not the other typechecked and was then dropped by the
    // validator, so the operation looked audited and was not.
    for (const action of AUDIT_ACTIONS) {
      expect(isAuditEvent({ ...base, action, outcome: "ok" }), `${action} is rejected by the validator`).toBe(true);
      expect(isAuditAction(action)).toBe(true);
    }
    expect(new Set(AUDIT_ACTIONS).size, "AUDIT_ACTIONS has duplicates").toBe(AUDIT_ACTIONS.length);
    expect(isAuditAction("selection_redacted_unknown")).toBe(false);
  });

  it("joins jsonl with newlines only", () => {
    const jsonl = toAuditJsonl([base, { ...base, action: "masks_applied" }]);
    expect(jsonl.split("\n")).toHaveLength(2);
  });
});

describe("ring buffer trim", () => {
  it("keeps the newest entries within cap", () => {
    const many: AuditEvent[] = Array.from({ length: AUDIT_MAX_EVENTS + 10 }, (_, i) => ({
      ...base,
      ts: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.${String(i).padStart(4, "0")}Z`,
      pages: i,
    }));
    const trimmed = trimEvents(many);
    expect(trimmed).toHaveLength(AUDIT_MAX_EVENTS);
    expect(trimmed[trimmed.length - 1].pages).toBe(AUDIT_MAX_EVENTS + 9);
  });

  it("returns the input untouched when under cap", () => {
    const few = [base];
    expect(trimEvents(few)).toBe(few);
  });
});


describe("cryptographic hash chaining", () => {
  it("computes deterministic SHA-256 hex strings", async () => {
    const hash = await sha256Hex("hello world");
    expect(hash).toBe("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
  });

  it("verifies an intact sequence of chained events", async () => {
    const event1: AuditEvent = { ...base, ts: "2026-08-21T00:00:00.000Z" };
    const prev1 = await sha256Hex(canonicalEventLine(event1));
    const event2: AuditEvent = { ...base, ts: "2026-08-21T00:01:00.000Z", prevHash: prev1 };
    const prev2 = await sha256Hex(canonicalEventLine(event2));
    const event3: AuditEvent = { ...base, ts: "2026-08-21T00:02:00.000Z", prevHash: prev2 };

    const result = await verifyAuditChain([event1, event2, event3]);
    expect(result.valid).toBe(true);
  });

  it("detects tampered event content in the middle of the chain", async () => {
    const event1: AuditEvent = { ...base, ts: "2026-08-21T00:00:00.000Z" };
    const prev1 = await sha256Hex(canonicalEventLine(event1));
    const event2: AuditEvent = { ...base, ts: "2026-08-21T00:01:00.000Z", prevHash: prev1, counts: { email: 1 } };
    const prev2 = await sha256Hex(canonicalEventLine(event2));
    const event3: AuditEvent = { ...base, ts: "2026-08-21T00:02:00.000Z", prevHash: prev2 };

    // Attacker modifies event2 counts after the fact
    const tampered2 = { ...event2, counts: { email: 999 } };
    const result = await verifyAuditChain([event1, tampered2, event3]);
    expect(result.valid).toBe(false);
    expect(result.brokenIndex).toBe(2);
  });

  it("detects deleted events (gaps) in the chain", async () => {
    const event1: AuditEvent = { ...base, ts: "2026-08-21T00:00:00.000Z" };
    const prev1 = await sha256Hex(canonicalEventLine(event1));
    const event2: AuditEvent = { ...base, ts: "2026-08-21T00:01:00.000Z", prevHash: prev1 };
    const prev2 = await sha256Hex(canonicalEventLine(event2));
    const event3: AuditEvent = { ...base, ts: "2026-08-21T00:02:00.000Z", prevHash: prev2 };

    // Attacker deletes event 2
    const result = await verifyAuditChain([event1, event3]);
    expect(result.valid).toBe(false);
    expect(result.brokenIndex).toBe(1);
  });
});

describe("recordAudit queue and fail-closed storage", () => {
  let mockStorage: Record<string, unknown> = {};

  beforeEach(() => {
    mockStorage = {};
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: mockStorage[key] }),
          set: async (items: Record<string, unknown>) => {
            Object.assign(mockStorage, items);
          },
          remove: async (key: string) => {
            delete mockStorage[key];
          },
        },
      },
    };
  });

  it("automatically chains subsequent events with prevHash", async () => {
    await recordAudit({ ...base, ts: "2026-01-01T00:00:00.000Z" });
    await recordAudit({ ...base, ts: "2026-01-01T00:01:00.000Z" });
    await recordAudit({ ...base, ts: "2026-01-01T00:02:00.000Z" });

    const log = await loadAuditLog();
    expect(log).toHaveLength(3);
    expect(log[0].prevHash).toBeUndefined();
    expect(log[1].prevHash).toBe(await sha256Hex(canonicalEventLine(log[0])));
    expect(log[2].prevHash).toBe(await sha256Hex(canonicalEventLine(log[1])));

    const verification = await verifyAuditChain(log);
    expect(verification.valid).toBe(true);
  });

  it("fails closed and rejects the promise when storage fails on protected operations", async () => {
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          get: async () => ({ auditLog: [] }),
          set: async () => {
            throw new Error("QuotaExceededError: Local storage full");
          },
        },
      },
    };

    // Fail-closed throws:
    await expect(recordAudit({ ...base }, { failClosed: true })).rejects.toThrow("QuotaExceededError");

    // Best-effort swallows:
    await expect(recordAudit({ ...base }, { failClosed: false })).resolves.toBeUndefined();
  });
});
