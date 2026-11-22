export const VALID_PERMISSIONS = [
  "policy.write",
  "seat.unlock",
  "code.manage",
  "group.manage",
  "audit.read",
  "admin.grant",
] as const;

export type Permission = (typeof VALID_PERMISSIONS)[number];

const PERMISSION_SET = new Set<string>(VALID_PERMISSIONS);

export interface AdminContext {
  id: string;
  organisation_id: string;
  organisation_name: string;
  email: string;
  username: string;
  role: "primary" | "granted";
  permission_set: string[];
  tier: "high" | "standard" | null;
  admin_group_id: string | null;
  must_change_password: boolean;
  status: "active" | "revoked";
}

export function isValidPermission(value: unknown): value is Permission {
  return typeof value === "string" && PERMISSION_SET.has(value);
}

export function validatePermissionSet(input: unknown): Permission[] | null {
  if (!Array.isArray(input)) {
    return null;
  }
  const out: Permission[] = [];
  for (const item of input) {
    if (!isValidPermission(item)) {
      return null;
    }
    if (!out.includes(item)) {
      out.push(item);
    }
  }
  return out;
}

/**
 * D5: Authoritative permission check strictly uses role === 'primary' or
 * admins.permission_set. Tier and admin_groups.permission_template never grant permissions.
 */
export function hasPermission(admin: AdminContext, permission: Permission): boolean {
  if (admin.status !== "active" || admin.must_change_password) {
    return false;
  }
  if (admin.role === "primary") {
    return true;
  }
  return Array.isArray(admin.permission_set) && admin.permission_set.includes(permission);
}
