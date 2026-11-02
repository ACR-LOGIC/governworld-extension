// Coverage for the four categories added after the original 19-category set:
// IP addresses, usernames, bank accounts and compensation amounts.
//
// Each detector is label- or format-gated on purpose. Bare dotted numbers,
// clock times, form hints and prices are common in ordinary text, so the
// negative cases below are as important as the positive ones.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detect, maskValue, placeholderLabelFor } from "../src/content/detect.js";
import { getCategoryLabel, SUPPORTED_LANGUAGES } from "../src/shared/i18n.js";
import { ALL_CATEGORIES, DEFAULT_SETTINGS, PRESET_CATEGORIES } from "../src/shared/settings.js";
import type { FindingCategory } from "../src/shared/types.js";

const NEW_CATEGORIES = ["ip_address", "username", "bank_account", "financial"] as const;

function matches(text: string, category: FindingCategory) {
  return detect(text, [category], []);
}

function values(text: string, category: FindingCategory): string[] {
  return matches(text, category).map((m) => m.value);
}

describe("IP address detection", () => {
  it("finds a public IPv4 next to an IP cue", () => {
    expect(values("Client IP: 8.8.4.4", "ip_address")).toContain("8.8.4.4");
    expect(values("IP addr: 8.8.4.4", "ip_address")).toContain("8.8.4.4");
  });

  it("finds a private IPv4 without a cue", () => {
    expect(values("Host 192.168.1.20 answered", "ip_address")).toContain("192.168.1.20");
  });

  it("finds a documented IPv4 range used by fixtures", () => {
    expect(values("Source 192.0.2.42", "ip_address")).toContain("192.0.2.42");
  });

  it("finds a compressed IPv6 next to a cue", () => {
    expect(values("IPv6 address: 2001:db8::1", "ip_address")).toContain("2001:db8::1");
  });

  it("ignores a version number", () => {
    expect(values("Version v1.2.3.4 released", "ip_address")).toEqual([]);
  });

  it("ignores a bare public dotted number with no cue", () => {
    expect(values("Section 8.8.4.4 covers this", "ip_address")).toEqual([]);
  });

  it("ignores an invalid octet and a clock time", () => {
    expect(values("IP address: 999.1.1.1", "ip_address")).toEqual([]);
    expect(values("IP address: 12:30:45", "ip_address")).toEqual([]);
  });
});

describe("username detection", () => {
  it("finds a labeled login handle", () => {
    expect(values("Username: aj.demo_2026", "username")).toContain("aj.demo_2026");
    expect(values("Login: alex", "username")).toContain("alex");
    expect(values("Login ID: alex.demo", "username")).toContain("alex.demo");
    expect(values("Nickname: casey", "username")).toContain("casey");
    expect(values("Screen name: casey.example", "username")).toContain("casey.example");
  });

  it("ignores form hints and placeholder words", () => {
    expect(values("Username: required", "username")).toEqual([]);
    expect(values("Login: optional", "username")).toEqual([]);
  });

  it("requires a label rather than masking every bare word", () => {
    expect(values("alex logged in today", "username")).toEqual([]);
  });
});

describe("bank account detection", () => {
  it("finds an ABA routing number with a valid checksum", () => {
    expect(values("Routing number: 021000021", "bank_account")).toContain("021000021");
  });

  it("rejects an ABA-shaped number with an invalid checksum", () => {
    expect(values("Routing number: 021000022", "bank_account")).toEqual([]);
  });

  it("finds a labeled account number", () => {
    expect(values("Account number: 000123456789", "bank_account")).toContain("000123456789");
    expect(values("Bank account: 1234 5678 9012", "bank_account")).toContain("1234 5678 9012");
    expect(values("Acct: 12345678", "bank_account")).toContain("12345678");
  });

  it("maps the account offset to the exact value, not past its last digit", () => {
    const text = "Account number: 1234 5678 9012 paid";
    const match = matches(text, "bank_account")[0];
    expect(match.value).toBe("1234 5678 9012");
    expect(text.slice(match.start, match.end)).toBe("1234 5678 9012");
  });
});

describe("compensation detection", () => {
  it("finds a labeled salary or compensation amount", () => {
    expect(values("Compensation: $120,000.00", "financial")).toContain("$120,000.00");
    expect(values("Annual salary of 120000 USD", "financial")).toContain("120000");
    expect(values("Hourly rate: $45.00", "financial")).toContain("$45.00");
  });

  it("does not treat a bare price or a year as compensation", () => {
    expect(values("Total: $120.00", "financial")).toEqual([]);
    expect(values("Annual income: 2024", "financial")).toEqual([]);
  });

  it("maps the compensation offset to the exact amount", () => {
    const text = "Compensation: $120,000.00 paid";
    const match = matches(text, "financial")[0];
    expect(match.value).toBe("$120,000.00");
    expect(text.slice(match.start, match.end)).toBe("$120,000.00");
  });
});

describe("masking and labels", () => {
  it("keeps only the last four digits of a bank account", () => {
    expect(maskValue("bank_account", "000123456789")).toBe("****6789");
    expect(maskValue("bank_account", "12")).toBe("**");
    // Revealing "the last four" of a four-digit account reveals all of it.
    expect(maskValue("bank_account", "1234")).toBe("****");
  });

  it("fully masks IP addresses and compensation", () => {
    expect(maskValue("ip_address", "192.168.1.20")).toBe("************");
    expect(maskValue("financial", "$120,000.00")).toBe("***********");
  });

  it("keeps only the first character of a username", () => {
    expect(maskValue("username", "alex")).toBe("a***");
  });

  it("has a placeholder label for every new category", () => {
    for (const category of NEW_CATEGORIES) {
      expect(placeholderLabelFor(category).length).toBeGreaterThan(0);
    }
  });
});

describe("category wiring", () => {
  it("registers every new category in the shared list and defaults", () => {
    for (const category of NEW_CATEGORIES) {
      expect(ALL_CATEGORIES).toContain(category);
      expect(DEFAULT_SETTINGS.enabledCategories).toContain(category);
    }
  });

  it("adds the categories to the presets that cover them", () => {
    expect(PRESET_CATEGORIES.hipaa).toContain("ip_address");
    expect(PRESET_CATEGORIES.gdpr).toEqual(
      expect.arrayContaining([...NEW_CATEGORIES])
    );
    expect(PRESET_CATEGORIES.uk_gdpr).toEqual(
      expect.arrayContaining([...NEW_CATEGORIES])
    );
    expect(PRESET_CATEGORIES.pci).not.toContain("financial");
    expect(PRESET_CATEGORIES.pci).not.toContain("bank_account");
  });

  it("keeps the managed-policy schema in sync with ALL_CATEGORIES", () => {
    const schema = JSON.parse(
      readFileSync(new URL("../schema/policy.json", import.meta.url), "utf8")
    ) as { properties?: Record<string, { items?: { enum?: string[] } }> };
    const enumValues = schema.properties?.enforcedCategories?.items?.enum ?? [];
    for (const category of ALL_CATEGORIES) {
      expect(enumValues).toContain(category);
    }
  });

  it("translates every new category in every supported language", () => {
    for (const language of SUPPORTED_LANGUAGES) {
      for (const category of NEW_CATEGORIES) {
        const label = getCategoryLabel(language.code, category);
        expect(label.length).toBeGreaterThan(0);
        expect(label).not.toBe(category);
      }
    }
  });
});
