// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  parseCustomPattern,
  loadCustomPatterns,
  saveCustomPatterns,
  CUSTOM_PATTERNS_KEY,
  type CustomPattern,
} from "../src/shared/customPatterns.js";
import { ALL_CATEGORIES } from "../src/shared/settings.js";

describe("Offline Custom Rules Export & Import Engine", () => {
  let mockStorage: Record<string, any> = {};

  beforeEach(() => {
    mockStorage = {};
    (globalThis as any).chrome = {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: mockStorage[key] })),
          set: vi.fn(async (items: Record<string, any>) => {
            Object.assign(mockStorage, items);
          }),
        },
      },
    };
  });

  const samplePattern1: CustomPattern = {
    id: "11111111-1111-1111-1111-111111111111",
    name: "Internal Project Code",
    category: "custom",
    pattern: "PRJ-[A-Z]{3}-\\d{4}",
    flags: "g",
    captureGroup: 0,
    confidence: 0.95,
    createdAt: "2026-11-01T10:00:00.000Z",
    source: "local",
    contributionStatus: "local_only",
  };

  const samplePattern2: CustomPattern = {
    id: "22222222-2222-2222-2222-222222222222",
    name: "Customer Ref Number",
    category: "secrets",
    pattern: "CUST-REF-\\d{8}",
    flags: "i",
    captureGroup: 0,
    confidence: 0.9,
    createdAt: "2026-11-02T12:00:00.000Z",
    source: "local",
    contributionStatus: "local_only",
  };

  it("exports stored patterns as a valid, sanitized JSON array", async () => {
    await saveCustomPatterns([samplePattern1, samplePattern2]);
    const stored = await loadCustomPatterns();
    expect(stored.length).toBe(2);

    const json = JSON.stringify(stored, null, 2);
    expect(typeof json).toBe("string");
    const parsed = JSON.parse(json);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);

    for (const item of parsed) {
      const res = parseCustomPattern(item);
      expect(res.ok).toBe(true);
    }
  });

  it("successfully imports and parses valid JSON rules", async () => {
    const jsonToImport = JSON.stringify([samplePattern1, samplePattern2]);
    const parsed = JSON.parse(jsonToImport);
    expect(Array.isArray(parsed)).toBe(true);

    const valid: CustomPattern[] = [];
    for (const item of parsed) {
      const res = parseCustomPattern(item);
      if (res.ok) valid.push(res.pattern);
    }
    expect(valid.length).toBe(2);
    expect(valid[0].name).toBe("Internal Project Code");
    expect(valid[1].name).toBe("Customer Ref Number");

    await saveCustomPatterns(valid);
    const loaded = await loadCustomPatterns();
    expect(loaded.length).toBe(2);
    expect(loaded[0].id).toBe(samplePattern1.id);
  });

  it("rejects corrupted or malicious JSON with ReDoS vulnerabilities", () => {
    const maliciousPayload = [
      {
        id: "33333333-3333-3333-3333-333333333333",
        name: "Evil ReDoS",
        category: "custom",
        pattern: "(a+)+$", // Catastrophic backtracking
        flags: "g",
        confidence: 0.9,
        createdAt: "2026-11-03T00:00:00.000Z",
        source: "local",
        contributionStatus: "local_only",
      },
    ];

    const res = parseCustomPattern(maliciousPayload[0]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("safe");
    }
  });

  it("rejects non-array or invalid UUID rules", () => {
    expect(parseCustomPattern({ id: "invalid-uuid", name: "Bad" }).ok).toBe(false);
    expect(parseCustomPattern(null).ok).toBe(false);
    expect(parseCustomPattern("not an object").ok).toBe(false);
  });

  it("merges imported rules with existing rules by ID without duplicating", async () => {
    await saveCustomPatterns([samplePattern1]);

    const updatedSample1: CustomPattern = {
      ...samplePattern1,
      name: "Updated Project Code Label",
    };
    const incoming = [updatedSample1, samplePattern2];

    const existing = await loadCustomPatterns();
    const map = new Map<string, CustomPattern>();
    for (const p of existing) map.set(p.id, p);
    for (const p of incoming) map.set(p.id, p);
    const merged = [...map.values()];

    expect(merged.length).toBe(2);
    expect(merged.find((p) => p.id === samplePattern1.id)?.name).toBe("Updated Project Code Label");
    expect(merged.find((p) => p.id === samplePattern2.id)).toBeDefined();

    await saveCustomPatterns(merged);
    const reloaded = await loadCustomPatterns();
    expect(reloaded.length).toBe(2);
  });

  it("identifies non-custom categories in imported rules for setting auto-activation", () => {
    const importedPatterns = [samplePattern1, samplePattern2];
    const catSet = new Set<string>();
    for (const p of importedPatterns) {
      if (p.category !== "custom") {
        catSet.add(p.category);
      }
    }
    expect(catSet.has("secrets")).toBe(true);
    expect(catSet.has("custom")).toBe(false);

    // Verify secrets is in ALL_CATEGORIES
    expect(ALL_CATEGORIES).toContain("secrets");
  });
});
