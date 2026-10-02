// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Who a signed-in user is allowed to change things for.
//
// A connected organization has employees who should be able to use the extension
// and administrators who should be able to change how it behaves for everyone. That
// distinction must be decided in ONE place, from ONE input, and it must fail
// closed — an unrecognised or absent role grants nothing.
//
// Three properties this module exists to guarantee:
//
// 1. Fail closed. No roles, unknown roles, an empty array, `null`, or a malformed
//    shape all mean "no administrative access". Privilege is never the default.
// 2. Server-decided. The role comes from a verified bootstrap response, never from
//    user input or local storage, so a user cannot grant themselves admin rights
//    by editing their own profile.
// 3. Presentation only. Every function here decides what to SHOW. Authorisation is
//    enforced by the API, which is why `settings.ts` re-adds mandated categories on
//    save rather than trusting a hidden checkbox. A hidden control is a courtesy,
//    not a control — the worker refuses the operation too.

import type { EntitlementsResponse, ExtensionCapability, TenantContext } from "../api/types.js";

/** Roles the control plane may issue. Anything else is treated as unrecognised. */
export const KNOWN_ORG_ROLES = ["owner", "admin", "member", "viewer"] as const;
export type OrgRole = (typeof KNOWN_ORG_ROLES)[number];

/** The highest privilege present in a role list, or null when none is recognised. */
export function resolveHighestRole(roles: readonly unknown[] | null | undefined): OrgRole | null {
  if (!Array.isArray(roles) || roles.length === 0) return null;
  const present = new Set(
    roles.filter((r): r is OrgRole => typeof r === "string" && (KNOWN_ORG_ROLES as readonly string[]).includes(r))
  );
  // Ordered by descending privilege. `owner` is checked first so an account that
  // somehow holds both is treated as the more privileged one.
  for (const role of ["owner", "admin", "member", "viewer"] as const) {
    if (present.has(role)) return role;
  }
  return null;
}

/**
 * Whether this user's role permits changing organization-wide settings.
 *
 * Membership alone never grants this: `member` and `viewer` are deliberately
 * excluded, so the answer is false unless the server issued an admin-level role.
 */
export function canManageOrganization(roles: readonly unknown[] | null | undefined): boolean {
  const role = resolveHighestRole(roles);
  return role === "owner" || role === "admin";
}

/** Human-facing role label, or null when the role list yields nothing recognised. */
export function roleLabel(roles: readonly unknown[] | null | undefined): string | null {
  return resolveHighestRole(roles);
}

/** Subscription tier, defaulting to the lowest. A malformed response is not a paid tier. */
export function subscriptionTier(entitlements: EntitlementsResponse | null | undefined): "free" | "pro" | "enterprise" {
  const tier = entitlements?.tier;
  return tier === "enterprise" || tier === "pro" ? tier : "free";
}

export interface AccountView {
  /** Whether an organization account is signed in and verified. */
  connected: boolean;
  /** Non-secret identity, safe to display. */
  userEmail: string | null;
  tenantId: string | null;
  tenantName: string | null;
  /** Highest recognised role, or null. */
  role: OrgRole | null;
  /** Whether this user may view and change organization-wide settings. */
  canManage: boolean;
  /** Subscription plan name. */
  tier: "free" | "pro" | "enterprise";
  /** Whether the tier or seat entitlement has an expiry we know about. */
  expiresAt: string | null;
  /** Capabilities the server granted. */
  capabilities: ExtensionCapability[];
}

export const NO_ACCOUNT: AccountView = {
  connected: false,
  userEmail: null,
  tenantId: null,
  tenantName: null,
  role: null,
  canManage: false,
  tier: "free",
  expiresAt: null,
  capabilities: [],
};

/**
 * Reduce a verified bootstrap result to exactly what the account surface renders.
 *
 * Accepts only what the server sent. A tenant that fails verification, or a
 * missing tenant, yields a disconnected view — never a partially populated one,
 * because a half-rendered account reads as authoritative when it is not.
 */
export function buildAccountView(input: {
  connected?: boolean;
  userEmail?: string | null;
  tenant?: TenantContext | null;
  entitlements?: EntitlementsResponse | null;
  capabilities?: readonly string[] | null;
}): AccountView {
  const tenant = input.tenant ?? null;
  if (!input.connected || !tenant || !tenant.verified) return NO_ACCOUNT;

  const capabilities = Array.isArray(input.capabilities)
    ? (input.capabilities.filter((c): c is ExtensionCapability => typeof c === "string") as ExtensionCapability[])
    : [];

  // `organization_controls` is a server grant, not something the role implies. A
  // role that says "admin" without this capability is still an admin for settings,
  // but must not be shown as holding organization controls — so these are read
  // independently rather than conflated.
  return {
    connected: true,
    userEmail: typeof input.userEmail === "string" && input.userEmail ? input.userEmail : null,
    tenantId: tenant.tenant_id,
    tenantName: tenant.tenant_name,
    role: resolveHighestRole(tenant.roles),
    canManage: canManageOrganization(tenant.roles),
    tier: subscriptionTier(input.entitlements),
    expiresAt: typeof input.entitlements?.expires_at === "string" ? input.entitlements.expires_at : null,
    capabilities,
  };
}

/**
 * Whether the server granted organization-wide controls.
 *
 * Separate from `canManage` on purpose: one answers "may this user edit settings",
 * the other "does this deployment have org controls at all".
 */
export function hasOrganizationControls(capabilities: readonly string[] | null | undefined): boolean {
  return Array.isArray(capabilities) && capabilities.includes("organization_controls");
}

const TIERS = new Set(["free", "pro", "enterprise"]);
const CAPABILITIES = new Set<ExtensionCapability>([
  "policy_sync",
  "cloud_monitoring",
  "usage_metadata",
  "logic_submission",
  "community_logic_updates",
  "organization_controls",
]);

function optionalString(value: unknown, max = 512): string | null | undefined {
  if (value === undefined || value === null) return value === undefined ? undefined : null;
  if (typeof value !== "string") return undefined;
  if (value.length === 0 || value.length > max) return undefined;
  return value;
}

/**
 * Validate an `AccountView` crossing the message boundary.
 *
 * Returns null for anything malformed rather than repairing it. The caller then
 * omits the account entirely, which renders the disconnected wall — the safe
 * direction, since a repaired view could otherwise invent a role the server never
 * granted or downgrade `canManage` from a value the server did grant.
 *
 * `canManage` is re-derived from `role` here rather than trusted. It is a
 * presentation field, and re-deriving it means a tampered message claiming
 * `canManage: true` with `role: "member"` is rejected instead of honoured.
 */
export function parseAccountView(raw: unknown): AccountView | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;

  if (value.connected !== true) return null;
  if (typeof value.tenantId !== "string" || !value.tenantId || value.tenantId.length > 256) return null;

  const role = value.role;
  if (role !== null && !KNOWN_ORG_ROLES.includes(role as OrgRole)) return null;

  const tier = value.tier;
  if (typeof tier !== "string" || !TIERS.has(tier)) return null;

  const capabilities = value.capabilities;
  if (!Array.isArray(capabilities)) return null;
  const parsedCapabilities: ExtensionCapability[] = [];
  for (const c of capabilities) {
    if (typeof c !== "string" || !CAPABILITIES.has(c as ExtensionCapability)) return null;
    parsedCapabilities.push(c as ExtensionCapability);
  }
  if (parsedCapabilities.length > 32) return null;

  const userEmail = optionalString(value.userEmail, 320);
  if (userEmail === undefined) return null;
  const tenantName = optionalString(value.tenantName);
  if (tenantName === undefined) return null;
  const expiresAt = optionalString(value.expiresAt, 64);
  if (expiresAt === undefined) return null;

  return {
    connected: true,
    userEmail,
    tenantId: value.tenantId,
    tenantName,
    role: role as OrgRole | null,
    // Derived, never taken from the message.
    canManage: canManageOrganization(role === null ? [] : [role]),
    tier: tier as "free" | "pro" | "enterprise",
    expiresAt,
    capabilities: parsedCapabilities,
  };
}