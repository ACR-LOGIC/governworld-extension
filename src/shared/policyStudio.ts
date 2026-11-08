// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { isRecord } from "./types.js";
import { isCategory, type FindingCategory } from "./settings.js";

export type PolicyAction = "block" | "redact" | "warn";

export type PolicyScope = "all" | "phi" | "pci" | "secrets" | "pii" | FindingCategory[];

export interface SitePolicy {
  id: string; // UUID v4 format
  name: string; // 1-80 chars
  urlPattern: string; // 1-255 chars
  scope: PolicyScope;
  action: PolicyAction;
  enabled: boolean;
  createdAt: string; // ISO timestamp
}

export const SITE_POLICIES_KEY = "sitePolicies";
export const MAX_SITE_POLICIES = 100;
export const MAX_POLICY_NAME = 80;
export const MAX_POLICY_URL = 255;

export const PHI_CATEGORIES: readonly FindingCategory[] = [
  "ssn",
  "dob",
  "npi",
  "dea",
  "mbi",
  "medical_record_number",
  "member_id",
  "phone",
  "email",
  "address",
] as const;

export const PCI_CATEGORIES: readonly FindingCategory[] = [
  "payment_card",
  "financial",
  "bank_account",
] as const;

export const SECRETS_CATEGORIES: readonly FindingCategory[] = [
  "secrets",
] as const;

export const PII_CATEGORIES: readonly FindingCategory[] = [
  "ssn",
  "dob",
  "phone",
  "email",
  "address",
  "possible_name",
  "username",
  "ip_address",
  "canadian_sin",
  "uk_nhs",
  "aadhaar",
  "pan_india",
  "australian_tfn",
  "cpf",
] as const;

export function isCategoryInPolicyScope(category: FindingCategory, scope: PolicyScope): boolean {
  if (scope === "all") return true;
  if (scope === "phi") return (PHI_CATEGORIES as readonly string[]).includes(category);
  if (scope === "pci") return (PCI_CATEGORIES as readonly string[]).includes(category);
  if (scope === "secrets") return (SECRETS_CATEGORIES as readonly string[]).includes(category);
  if (scope === "pii") return (PII_CATEGORIES as readonly string[]).includes(category);
  if (Array.isArray(scope)) return scope.includes(category);
  return false;
}

export function matchesUrlPattern(pattern: string, urlOrHost: string): boolean {
  if (!pattern || !urlOrHost) return false;
  const p = pattern.trim().toLowerCase();
  const u = urlOrHost.trim().toLowerCase();
  if (!p || !u) return false;

  if (p === "*" || p === "<all_urls>") return true;

  // Extract hostname and path from urlOrHost
  let targetHost = u;
  let targetPath = "/";
  try {
    if (u.includes("://")) {
      const parsed = new URL(u);
      targetHost = parsed.hostname;
      targetPath = parsed.pathname;
    } else {
      const slashIdx = u.indexOf("/");
      if (slashIdx >= 0) {
        targetHost = u.slice(0, slashIdx);
        targetPath = u.slice(slashIdx);
      }
    }
  } catch {
    // If URL parsing fails, targetHost remains u
  }

  // Normalize pattern host and path
  let patHost = p;
  let patPath = "";
  if (p.includes("://")) {
    try {
      const parsedP = new URL(p.replace(/\*/g, "wildcard-placeholder"));
      patHost = parsedP.hostname.replace(/wildcard-placeholder/g, "*");
      patPath = parsedP.pathname.replace(/wildcard-placeholder/g, "*");
    } catch {
      // fallback
    }
  } else {
    const slashIdx = p.indexOf("/");
    if (slashIdx >= 0) {
      patHost = p.slice(0, slashIdx);
      patPath = p.slice(slashIdx);
    }
  }

  // Strip port from hosts if present
  targetHost = targetHost.split(":")[0];
  patHost = patHost.split(":")[0];

  // Check host match
  let hostMatched = false;
  if (patHost === "*" || patHost === "") {
    hostMatched = true;
  } else if (patHost.startsWith("*.")) {
    const baseDomain = patHost.slice(2);
    hostMatched = targetHost === baseDomain || targetHost.endsWith("." + baseDomain);
  } else if (targetHost === patHost || targetHost.endsWith("." + patHost)) {
    hostMatched = true;
  }

  if (!hostMatched) return false;

  // Check path match if pattern specifies path
  if (patPath && patPath !== "/" && patPath !== "/*") {
    if (patPath.endsWith("*")) {
      const prefix = patPath.slice(0, -1);
      return targetPath.startsWith(prefix);
    }
    return targetPath === patPath;
  }

  return true;
}

export interface PolicyEvaluationResult {
  hasMatch: boolean;
  action: PolicyAction;
  matchedPolicy?: SitePolicy;
  matchedCategories: FindingCategory[];
}

export function evaluateSitePolicies(
  policies: SitePolicy[],
  currentUrl: string,
  findings: Array<{ category: FindingCategory }>
): PolicyEvaluationResult {
  if (!policies || policies.length === 0 || !findings || findings.length === 0) {
    return { hasMatch: false, action: "warn", matchedCategories: [] };
  }

  const enabledPolicies = policies.filter((p) => p.enabled && matchesUrlPattern(p.urlPattern, currentUrl));
  if (enabledPolicies.length === 0) {
    return { hasMatch: false, action: "warn", matchedCategories: [] };
  }

  // Priority: block > redact > warn
  let blockMatch: { policy: SitePolicy; categories: FindingCategory[] } | null = null;
  let redactMatch: { policy: SitePolicy; categories: FindingCategory[] } | null = null;
  let warnMatch: { policy: SitePolicy; categories: FindingCategory[] } | null = null;

  for (const policy of enabledPolicies) {
    const relevantFindings = findings.filter((f) => isCategoryInPolicyScope(f.category, policy.scope));
    if (relevantFindings.length > 0) {
      const cats = [...new Set(relevantFindings.map((f) => f.category))];
      if (policy.action === "block" && !blockMatch) {
        blockMatch = { policy, categories: cats };
      } else if (policy.action === "redact" && !redactMatch) {
        redactMatch = { policy, categories: cats };
      } else if (policy.action === "warn" && !warnMatch) {
        warnMatch = { policy, categories: cats };
      }
    }
  }

  if (blockMatch) {
    return {
      hasMatch: true,
      action: "block",
      matchedPolicy: blockMatch.policy,
      matchedCategories: blockMatch.categories,
    };
  }

  if (redactMatch) {
    return {
      hasMatch: true,
      action: "redact",
      matchedPolicy: redactMatch.policy,
      matchedCategories: redactMatch.categories,
    };
  }

  if (warnMatch) {
    return {
      hasMatch: true,
      action: "warn",
      matchedPolicy: warnMatch.policy,
      matchedCategories: warnMatch.categories,
    };
  }

  return { hasMatch: false, action: "warn", matchedCategories: [] };
}

export type ParseSitePolicyResult =
  | { ok: true; policy: SitePolicy }
  | { ok: false; error: string };

export function parseSitePolicy(raw: unknown): ParseSitePolicyResult {
  if (!isRecord(raw)) return { ok: false, error: "Policy must be an object" };

  if (typeof raw.id !== "string" || !/^[0-9a-f-]{36}$/.test(raw.id)) {
    return { ok: false, error: "Policy id must be a valid UUID string" };
  }

  if (typeof raw.name !== "string" || raw.name.trim().length === 0 || raw.name.length > MAX_POLICY_NAME) {
    return { ok: false, error: `Policy name must be 1–${MAX_POLICY_NAME} characters` };
  }

  if (typeof raw.urlPattern !== "string" || raw.urlPattern.trim().length === 0 || raw.urlPattern.length > MAX_POLICY_URL) {
    return { ok: false, error: `Policy urlPattern must be 1–${MAX_POLICY_URL} characters` };
  }

  const validActions: PolicyAction[] = ["block", "redact", "warn"];
  if (!validActions.includes(raw.action as PolicyAction)) {
    return { ok: false, error: "Policy action must be 'block', 'redact', or 'warn'" };
  }

  let scope: PolicyScope;
  if (raw.scope === "all" || raw.scope === "phi" || raw.scope === "pci" || raw.scope === "secrets" || raw.scope === "pii") {
    scope = raw.scope;
  } else if (Array.isArray(raw.scope)) {
    const validCats = raw.scope.filter(isCategory);
    if (validCats.length === 0) {
      return { ok: false, error: "Policy category scope array contains no valid categories" };
    }
    scope = validCats;
  } else {
    return { ok: false, error: "Policy scope must be 'all', 'phi', 'pci', 'secrets', 'pii', or an array of categories" };
  }

  const enabled = raw.enabled !== false; // default true

  if (typeof raw.createdAt !== "string" || raw.createdAt.trim().length === 0) {
    return { ok: false, error: "Policy createdAt must be a valid ISO date string" };
  }

  return {
    ok: true,
    policy: {
      id: raw.id,
      name: raw.name.trim(),
      urlPattern: raw.urlPattern.trim(),
      scope,
      action: raw.action as PolicyAction,
      enabled,
      createdAt: raw.createdAt,
    },
  };
}

export async function loadSitePolicies(): Promise<SitePolicy[]> {
  try {
    if (typeof chrome === "undefined" || !chrome.storage?.local) return [];
    const raw = await chrome.storage.local.get(SITE_POLICIES_KEY);
    const arr = raw[SITE_POLICIES_KEY];
    if (!Array.isArray(arr)) return [];
    const valid: SitePolicy[] = [];
    for (const item of arr) {
      const res = parseSitePolicy(item);
      if (res.ok) valid.push(res.policy);
    }
    return valid;
  } catch {
    return [];
  }
}

export async function saveSitePolicies(policies: SitePolicy[]): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.storage?.local) return;
  const capped = policies.slice(0, MAX_SITE_POLICIES);
  await chrome.storage.local.set({ [SITE_POLICIES_KEY]: capped });
}

export async function saveSitePolicy(policy: SitePolicy): Promise<SitePolicy[]> {
  const existing = await loadSitePolicies();
  const idx = existing.findIndex((p) => p.id === policy.id);
  if (idx >= 0) {
    existing[idx] = policy;
  } else {
    existing.push(policy);
  }
  await saveSitePolicies(existing);
  return existing;
}

export async function deleteSitePolicy(id: string): Promise<SitePolicy[]> {
  const existing = await loadSitePolicies();
  const filtered = existing.filter((p) => p.id !== id);
  await saveSitePolicies(filtered);
  return filtered;
}

export async function toggleSitePolicy(id: string): Promise<SitePolicy[]> {
  const existing = await loadSitePolicies();
  const idx = existing.findIndex((p) => p.id === id);
  if (idx >= 0) {
    existing[idx].enabled = !existing[idx].enabled;
    await saveSitePolicies(existing);
  }
  return existing;
}
