// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  matchesUrlPattern,
  findMatchingFullSiteBlockPolicy,
  isCategoryInPolicyScope,
  evaluateSitePolicies,
  parseSitePolicy,
  loadSitePolicies,
  saveSitePolicies,
  saveSitePolicy,
  deleteSitePolicy,
  toggleSitePolicy,
  MAX_SITE_POLICIES,
  PHI_CATEGORIES,
  PCI_CATEGORIES,
  SECRETS_CATEGORIES,
  PII_CATEGORIES,
  type SitePolicy,
  type PolicyScope,
  type PolicyAction,
} from "../src/shared/policyStudio.js";
import {
  initPasteGuard,
  detectPasteFindings,
  sanitizePastedText,
  renderFullSiteBlockShield,
  removeFullSiteBlockShield,
  FULL_SITE_BLOCK_HOST_ID,
} from "../src/content/pasteGuard.js";
import type { FindingCategory } from "../src/shared/settings.js";

describe("Policy Studio - URL Pattern Matching", () => {
  it("matches exact domain and with protocol", () => {
    expect(matchesUrlPattern("chatgpt.com", "https://chatgpt.com")).toBe(true);
    expect(matchesUrlPattern("chatgpt.com", "https://chatgpt.com/c/12345")).toBe(true);
    expect(matchesUrlPattern("chatgpt.com", "http://chatgpt.com/")).toBe(true);
    expect(matchesUrlPattern("chatgpt.com", "chatgpt.com")).toBe(true);
  });

  it("matches subdomains for a domain pattern", () => {
    expect(matchesUrlPattern("slack.com", "https://app.slack.com/client")).toBe(true);
    expect(matchesUrlPattern("slack.com", "https://my-team.enterprise.slack.com")).toBe(true);
    expect(matchesUrlPattern("*.slack.com", "https://app.slack.com")).toBe(true);
  });

  it("handles wildcard * and <all_urls>", () => {
    expect(matchesUrlPattern("*", "https://example.com")).toBe(true);
    expect(matchesUrlPattern("<all_urls>", "https://anywhere.org/path")).toBe(true);
    expect(matchesUrlPattern("*", "http://localhost:3000")).toBe(true);
  });

  it("strips ports during comparison", () => {
    expect(matchesUrlPattern("localhost", "http://localhost:8080/app")).toBe(true);
    expect(matchesUrlPattern("localhost:8080", "http://localhost:8080/app")).toBe(true);
  });

  it("matches path prefixes when specified", () => {
    expect(matchesUrlPattern("example.com/api/*", "https://example.com/api/v1/users")).toBe(true);
    expect(matchesUrlPattern("example.com/api/*", "https://example.com/login")).toBe(false);
    expect(matchesUrlPattern("example.com/checkout", "https://example.com/checkout")).toBe(true);
  });

  it("rejects mismatched domains", () => {
    expect(matchesUrlPattern("example.com", "https://not-example.com")).toBe(false);
    expect(matchesUrlPattern("google.com", "https://evil-google.com")).toBe(false);
    expect(matchesUrlPattern("slack.com", "https://slack.com.attacker.com")).toBe(false);
  });

  it("handles invalid or empty inputs safely", () => {
    expect(matchesUrlPattern("", "https://example.com")).toBe(false);
    expect(matchesUrlPattern("example.com", "")).toBe(false);
    expect(matchesUrlPattern("   ", "   ")).toBe(false);
    expect(matchesUrlPattern(null as any, "https://example.com")).toBe(false);
  });
});

describe("Policy Studio - Scope Filtering", () => {
  it("matches any category for scope 'all'", () => {
    expect(isCategoryInPolicyScope("ssn", "all")).toBe(true);
    expect(isCategoryInPolicyScope("secrets", "all")).toBe(true);
    expect(isCategoryInPolicyScope("payment_card", "all")).toBe(true);
  });

  it("correctly identifies PHI categories for scope 'phi'", () => {
    for (const cat of PHI_CATEGORIES) {
      expect(isCategoryInPolicyScope(cat, "phi")).toBe(true);
    }
    expect(isCategoryInPolicyScope("payment_card", "phi")).toBe(false);
    expect(isCategoryInPolicyScope("secrets", "phi")).toBe(false);
  });

  it("correctly identifies PCI categories for scope 'pci'", () => {
    for (const cat of PCI_CATEGORIES) {
      expect(isCategoryInPolicyScope(cat, "pci")).toBe(true);
    }
    expect(isCategoryInPolicyScope("medical_record_number", "pci")).toBe(false);
    expect(isCategoryInPolicyScope("secrets", "pci")).toBe(false);
  });

  it("correctly identifies Secrets categories for scope 'secrets'", () => {
    expect(isCategoryInPolicyScope("secrets", "secrets")).toBe(true);
    expect(isCategoryInPolicyScope("ssn", "secrets")).toBe(false);
  });

  it("correctly identifies PII categories for scope 'pii'", () => {
    for (const cat of PII_CATEGORIES) {
      expect(isCategoryInPolicyScope(cat, "pii")).toBe(true);
    }
    expect(isCategoryInPolicyScope("payment_card", "pii")).toBe(false);
  });

  it("matches custom category array scope", () => {
    const scope: FindingCategory[] = ["email", "phone"];
    expect(isCategoryInPolicyScope("email", scope)).toBe(true);
    expect(isCategoryInPolicyScope("phone", scope)).toBe(true);
    expect(isCategoryInPolicyScope("ssn", scope)).toBe(false);
  });
});

describe("Policy Studio - Policy Evaluation & Conflict Resolution", () => {
  const samplePolicy1: SitePolicy = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Block PHI on ChatGPT",
    urlPattern: "chatgpt.com",
    scope: "phi",
    action: "block",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  const samplePolicy2: SitePolicy = {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Redact Secrets on Slack",
    urlPattern: "slack.com",
    scope: "secrets",
    action: "redact",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  const samplePolicy3: SitePolicy = {
    id: "33333333-3333-4333-8333-333333333333",
    name: "Warn on All Sites for Cards",
    urlPattern: "*",
    scope: "pci",
    action: "warn",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  it("triggers block action on matching URL and category", () => {
    const result = evaluateSitePolicies(
      [samplePolicy1, samplePolicy2],
      "https://chatgpt.com/chat",
      [{ category: "ssn" }]
    );
    expect(result.hasMatch).toBe(true);
    expect(result.action).toBe("block");
    expect(result.matchedPolicy?.id).toBe(samplePolicy1.id);
    expect(result.matchedCategories).toContain("ssn");
  });

  it("prioritizes block over redact and warn when multiple policies match", () => {
    const redactPolicy: SitePolicy = {
      ...samplePolicy1,
      id: "44444444-4444-4444-8444-444444444444",
      action: "redact",
    };
    const warnPolicy: SitePolicy = {
      ...samplePolicy1,
      id: "55555555-5555-4555-8555-555555555555",
      action: "warn",
    };

    const result = evaluateSitePolicies(
      [warnPolicy, redactPolicy, samplePolicy1],
      "https://chatgpt.com",
      [{ category: "medical_record_number" }]
    );
    expect(result.hasMatch).toBe(true);
    expect(result.action).toBe("block");
    expect(result.matchedPolicy?.id).toBe(samplePolicy1.id);
  });

  it("prioritizes redact over warn when both match", () => {
    const redactPolicy: SitePolicy = {
      ...samplePolicy3,
      id: "66666666-6666-4666-8666-666666666666",
      action: "redact",
    };
    const result = evaluateSitePolicies(
      [samplePolicy3, redactPolicy],
      "https://random-store.com",
      [{ category: "payment_card" }]
    );
    expect(result.hasMatch).toBe(true);
    expect(result.action).toBe("redact");
  });

  it("skips disabled policies", () => {
    const disabledPolicy: SitePolicy = {
      ...samplePolicy1,
      enabled: false,
    };
    const result = evaluateSitePolicies(
      [disabledPolicy],
      "https://chatgpt.com",
      [{ category: "ssn" }]
    );
    expect(result.hasMatch).toBe(false);
  });

  it("returns no match if URL does not match", () => {
    const result = evaluateSitePolicies(
      [samplePolicy1],
      "https://google.com",
      [{ category: "ssn" }]
    );
    expect(result.hasMatch).toBe(false);
  });

  it("returns no match if category does not match scope", () => {
    const result = evaluateSitePolicies(
      [samplePolicy1], // PHI scope
      "https://chatgpt.com",
      [{ category: "payment_card" }] // PCI category
    );
    expect(result.hasMatch).toBe(false);
  });
});

describe("Policy Studio - Schema & Parser Validation", () => {
  it("parses valid policy successfully", () => {
    const raw = {
      id: "a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d",
      name: "Enforce PHI on Clinic Portal",
      urlPattern: "*.clinic.org",
      scope: "phi",
      action: "block",
      enabled: true,
      createdAt: "2026-03-01T12:00:00.000Z",
    };
    const res = parseSitePolicy(raw);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.policy.id).toBe(raw.id);
      expect(res.policy.name).toBe(raw.name);
      expect(res.policy.urlPattern).toBe(raw.urlPattern);
      expect(res.policy.scope).toBe("phi");
      expect(res.policy.action).toBe("block");
      expect(res.policy.enabled).toBe(true);
    }
  });

  it("parses array of categories scope", () => {
    const raw = {
      id: "a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d",
      name: "Custom Card Policy",
      urlPattern: "payment.example.com",
      scope: ["payment_card", "financial"],
      action: "redact",
      enabled: true,
      createdAt: "2026-03-01T12:00:00.000Z",
    };
    const res = parseSitePolicy(raw);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.policy.scope).toEqual(["payment_card", "financial"]);
    }
  });

  it("rejects invalid id format", () => {
    const res = parseSitePolicy({
      id: "not-a-uuid",
      name: "Test",
      urlPattern: "test.com",
      scope: "all",
      action: "warn",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(res.ok).toBe(false);
  });

  it("rejects empty or oversized name", () => {
    expect(
      parseSitePolicy({
        id: "a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d",
        name: "",
        urlPattern: "test.com",
        scope: "all",
        action: "warn",
        createdAt: "2026-01-01T00:00:00.000Z",
      }).ok
    ).toBe(false);

    expect(
      parseSitePolicy({
        id: "a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d",
        name: "x".repeat(81),
        urlPattern: "test.com",
        scope: "all",
        action: "warn",
        createdAt: "2026-01-01T00:00:00.000Z",
      }).ok
    ).toBe(false);
  });

  it("rejects invalid action or scope", () => {
    expect(
      parseSitePolicy({
        id: "a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d",
        name: "Test",
        urlPattern: "test.com",
        scope: "invalid_scope",
        action: "warn",
        createdAt: "2026-01-01T00:00:00.000Z",
      }).ok
    ).toBe(false);

    expect(
      parseSitePolicy({
        id: "a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d",
        name: "Test",
        urlPattern: "test.com",
        scope: "phi",
        action: "invalid_action",
        createdAt: "2026-01-01T00:00:00.000Z",
      }).ok
    ).toBe(false);
  });
});

let mockStorage: Record<string, unknown> = {};
describe("Policy Studio - Storage & Lifecycle Management", () => {

  beforeEach(() => {
    mockStorage = {};
    (globalThis as any).chrome = {
      storage: {
        local: {
          get: vi.fn(async (key: string | string[]) => {
            if (typeof key === "string") {
              return { [key]: mockStorage[key] };
            }
            if (Array.isArray(key)) {
              const res: Record<string, unknown> = {};
              for (const k of key) res[k] = mockStorage[k];
              return res;
            }
            return { ...mockStorage };
          }),
          set: vi.fn(async (obj: Record<string, unknown>) => {
            Object.assign(mockStorage, obj);
          }),
        },
      },
    };
  });

  it("saves, loads, toggles, and deletes site policies", async () => {
    const policy: SitePolicy = {
      id: "11111111-2222-4333-8444-555555555555",
      name: "Enforce No PHI on Slack",
      urlPattern: "*.slack.com",
      scope: "phi",
      action: "block",
      enabled: true,
      createdAt: new Date().toISOString(),
    };

    // Save
    const afterSave = await saveSitePolicy(policy);
    expect(afterSave.length).toBe(1);

    // Load
    const loaded = await loadSitePolicies();
    expect(loaded.length).toBe(1);
    expect(loaded[0].name).toBe("Enforce No PHI on Slack");
    expect(loaded[0].enabled).toBe(true);

    // Toggle
    const afterToggle = await toggleSitePolicy(policy.id);
    expect(afterToggle[0].enabled).toBe(false);

    // Delete
    const afterDelete = await deleteSitePolicy(policy.id);
    expect(afterDelete.length).toBe(0);

    const reloaded = await loadSitePolicies();
    expect(reloaded.length).toBe(0);
  });

  it("enforces maximum site policies cap", async () => {
    const policies: SitePolicy[] = Array.from({ length: 105 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      name: `Policy ${i}`,
      urlPattern: `site${i}.com`,
      scope: "all" as const,
      action: "block" as const,
      enabled: true,
      createdAt: new Date().toISOString(),
    }));

    await saveSitePolicies(policies);
    const loaded = await loadSitePolicies();
    expect(loaded.length).toBe(MAX_SITE_POLICIES);
  });
});

  function createTestMockElement(tagName: string, props: any = {}) {
    const listeners: Record<string, Function[]> = {};
    const attrs: any = [];
    const el: any = {
      nodeType: 1,
      tagName: tagName.toUpperCase(),
      attributes: attrs,
      children: [],
      parentNode: null,
      style: {},
      getBoundingClientRect: () => ({ left: 100, top: 100, right: 300, bottom: 130, width: 200, height: 30 }),
      focus: vi.fn(),
      dispatchEvent: (e: any) => {
        const fns = listeners[e.type] || [];
        for (const fn of fns) fn(e);
        return true;
      },
      addEventListener: (type: string, fn: Function) => {
        listeners[type] = listeners[type] || [];
        listeners[type].push(fn);
      },
      removeEventListener: (type: string, fn: Function) => {
        if (listeners[type]) {
          listeners[type] = listeners[type].filter((f) => f !== fn);
        }
      },
      setAttribute: (k: string, v: string) => {
        attrs[k] = v;
        const existing = attrs.find((a: any) => a.name === k);
        if (existing) existing.value = v;
        else attrs.push({ name: k, value: v });
      },
      getAttribute: (k: string) => attrs[k] ?? props[k],
      appendChild: (c: any) => { c.parentNode = el; el.children.push(c); return c; },
      append: (...cs: any[]) => { cs.forEach((c) => { c.parentNode = el; el.children.push(c); }); },
      remove: function() {
        if (this.parentNode && Array.isArray(this.parentNode.children)) {
          this.parentNode.children = this.parentNode.children.filter((ch: any) => ch !== this);
        }
      },
      attachShadow: () => {
        const shadow = createTestMockElement("shadow-root");
        el.shadowRoot = shadow;
        return shadow;
      },
      ...props,
    };
    return el;
  }

  function createTestMockDocument(url = "https://medical-portal.example.com/patient/chat") {
    const listeners: Record<string, Function[]> = {};
    const body = createTestMockElement("body");

    const doc: any = {
      nodeType: 9,
      body,
      documentElement: body,
      defaultView: {
        location: { href: url, hostname: new URL(url).hostname },
        innerWidth: 1024,
        innerHeight: 768,
      },
      createElement: (tag: string) => createTestMockElement(tag),
      createElementNS: (_ns: string, tag: string) => createTestMockElement(tag),
      createTextNode: (text: string) => ({ text, nodeType: 3 }),
      getElementById: (id: string) => {
        const findIn = (node: any): any => {
          if (node.id === id) return node;
          for (const ch of node.children || []) {
            const res = findIn(ch);
            if (res) return res;
          }
          return null;
        };
        return findIn(body);
      },
      addEventListener: (type: string, fn: Function) => {
        listeners[type] = listeners[type] || [];
        listeners[type].push(fn);
      },
      removeEventListener: (type: string, fn: Function) => {
        if (listeners[type]) {
          listeners[type] = listeners[type].filter((f) => f !== fn);
        }
      },
      dispatchEvent: (e: any) => {
        const fns = listeners[e.type] || [];
        for (const fn of fns) fn(e);
        return true;
      },
    };
    return doc;
  }

describe("Policy Studio - Paste Guard Enforcement Integration", () => {
  it("strictly blocks pasting when a block policy matches", () => {
    const policy: SitePolicy = {
      id: "99999999-9999-4999-8999-999999999999",
      name: "Strict PHI Block on Medical Portal",
      urlPattern: "medical-portal.example.com",
      scope: "phi",
      action: "block",
      enabled: true,
      createdAt: new Date().toISOString(),
    };

    const doc = createTestMockDocument("https://medical-portal.example.com/patient/chat");
    const target = createTestMockElement("input", { type: "text", value: "" });
    target.ownerDocument = doc;
    doc.body.appendChild(target);

    const cleanup = initPasteGuard(doc, {
      initialSitePolicies: [policy],
    });

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const pasteEvent = {
      type: "paste",
      target,
      clipboardData: {
        getData: (type: string) => (type === "text/plain" ? "Patient SSN is 123-45-6789" : ""),
      },
      preventDefault,
      stopPropagation,
    };

    doc.dispatchEvent(pasteEvent);

    // Assert paste was intercepted and cancelled
    expect(preventDefault).toHaveBeenCalled();
    // Raw value was never pasted into target
    expect(target.value).toBe("");

    cleanup();
  });

  it("strictly enforces redaction and disallows raw paste when a redact policy matches", () => {
    const policy: SitePolicy = {
      id: "88888888-8888-4888-8888-888888888888",
      name: "Mandatory Secrets Redaction",
      urlPattern: "github.com",
      scope: "secrets",
      action: "redact",
      enabled: true,
      createdAt: new Date().toISOString(),
    };

    const doc = createTestMockDocument("https://github.com/org/repo/issues");
    const target = createTestMockElement("textarea", { value: "" });
    target.ownerDocument = doc;
    doc.body.appendChild(target);

    const cleanup = initPasteGuard(doc, {
      initialSitePolicies: [policy],
    });

    const preventDefault = vi.fn();
    const pasteEvent = {
      type: "paste",
      target,
      clipboardData: {
        getData: (type: string) => (type === "text/plain" ? "OpenAI token: sk-1234567890abcdef1234567890" : ""),
      },
      preventDefault,
      stopPropagation: vi.fn(),
    };

    doc.dispatchEvent(pasteEvent);
    expect(preventDefault).toHaveBeenCalled();

    // Verify modal was added
    const host = doc.getElementById("__governworld-paste-guard-host");
    expect(host).not.toBeNull();

    cleanup();
  });
});

describe("Policy Studio - Full Website Blocking & Notes", () => {
  it("parses blockEntireSite and notes correctly", () => {
    const raw = {
      id: "11111111-2222-4333-8444-555555555555",
      name: "Block Dangerous Site",
      urlPattern: "malicious.test",
      scope: "all",
      action: "block",
      enabled: true,
      createdAt: new Date().toISOString(),
      blockEntireSite: true,
      notes: "Mandated by security bulletin Sec-091",
    };

    const res = parseSitePolicy(raw);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.policy.blockEntireSite).toBe(true);
      expect(res.policy.notes).toBe("Mandated by security bulletin Sec-091");
    }
  });

  it("truncates notes exceeding 200 characters", () => {
    const longNote = "A".repeat(300);
    const raw = {
      id: "11111111-2222-4333-8444-555555555555",
      name: "Policy With Long Note",
      urlPattern: "example.com",
      scope: "all",
      action: "block",
      enabled: true,
      createdAt: new Date().toISOString(),
      notes: longNote,
    };

    const res = parseSitePolicy(raw);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.policy.notes?.length).toBe(200);
    }
  });

  it("finds matching full site block policy when enabled and url matches", () => {
    const policies: SitePolicy[] = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        name: "Standard redact policy",
        urlPattern: "untrusted.org",
        scope: "all",
        action: "redact",
        enabled: true,
        createdAt: new Date().toISOString(),
        blockEntireSite: false,
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        name: "Full site block on untrusted",
        urlPattern: "untrusted.org",
        scope: "all",
        action: "block",
        enabled: true,
        createdAt: new Date().toISOString(),
        blockEntireSite: true,
      },
    ];

    const match = findMatchingFullSiteBlockPolicy(policies, "https://untrusted.org/login");
    expect(match).not.toBeNull();
    expect(match?.id).toBe("22222222-2222-4222-8222-222222222222");

    // When policy is disabled, should not match
    policies[1].enabled = false;
    expect(findMatchingFullSiteBlockPolicy(policies, "https://untrusted.org/login")).toBeNull();

    // When URL does not match
    expect(findMatchingFullSiteBlockPolicy(policies, "https://safe.org/page")).toBeNull();
  });

  it("injects high-assurance barrier shield when full site block matches in pasteGuard", () => {
    const policy: SitePolicy = {
      id: "77777777-7777-4777-8777-777777777777",
      name: "Restricted Site Barrier",
      urlPattern: "blocked-domain.com",
      scope: "all",
      action: "block",
      enabled: true,
      createdAt: new Date().toISOString(),
      blockEntireSite: true,
    };

    const doc = createTestMockDocument("https://blocked-domain.com/dashboard");
    const cleanup = initPasteGuard(doc, {
      initialSitePolicies: [policy],
    });

    const host = doc.getElementById(FULL_SITE_BLOCK_HOST_ID);
    expect(host).not.toBeNull();

    cleanup();
    expect(doc.getElementById(FULL_SITE_BLOCK_HOST_ID)).toBeNull();
  });
});
