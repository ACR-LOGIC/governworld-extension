import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleCorsPreflight, jsonResponse, methodNotAllowed } from "../_shared/cors.ts";
import { createSupabaseAdmin, createSupabaseAnon } from "../_shared/supabaseAdmin.ts";
import { requireAdminContext, requireApiKey } from "../_shared/auth.ts";
import {
  generateTempPassword,
  getClientIpHash,
  getPairingPepper,
  hashTempPassword,
  isNonZeroUuid,
  verifyTempPassword,
} from "../_shared/crypto.ts";
import { validatePermissionSet } from "../_shared/permissions.ts";
import { isEmailDeliveryConfigured, sendAdminGrantEmail } from "../_shared/email.ts";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_REGEX = /^[A-Za-z0-9._-]{2,100}$/;

function isStrongNewPassword(password: unknown, disallowValue?: string): password is string {
  if (typeof password !== "string" || password.length < 12 || password.length > 128) {
    return false;
  }
  if (disallowValue && password === disallowValue) {
    return false;
  }
  const hasLetter = /[A-Za-z]/.test(password);
  const hasDigitOrSymbol = /[0-9!@#$%^&*\-_+=.?]/.test(password);
  return hasLetter && hasDigitOrSymbol;
}

function generateDefaultUsername(email: string): string {
  const local = email.split("@")[0]?.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 24) || "admin";
  const suffix = crypto.randomUUID().slice(0, 6);
  const candidate = `${local}.${suffix}`;
  return candidate.length >= 2 ? candidate : `adm.${suffix}`;
}

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return methodNotAllowed();

  const apiKeyErr = requireApiKey(req);
  if (apiKeyErr) return apiKeyErr;

  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return jsonResponse(400, { ok: false, error: "Invalid request payload" });
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return jsonResponse(400, { ok: false, error: "Invalid JSON payload" });
  }

  const action = typeof body.action === "string" ? body.action : "";
  const supabaseAdmin = createSupabaseAdmin();

  // 1. Pre-auth first-login actions (D6 forced password change)
  if (action === "first_login_check" || action === "first_login_activate") {
    const orgId = body.organisation_id;
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const tempPassword = typeof body.temp_password === "string" ? body.temp_password : "";

    if (!isNonZeroUuid(orgId) || !USERNAME_REGEX.test(username) || tempPassword.length < 8) {
      return jsonResponse(400, { ok: false, error: "Valid organisation_id, username, and temporary password are required" });
    }

    let ipHash = "unknown";
    try {
      const pepper = await getPairingPepper(supabaseAdmin);
      ipHash = await getClientIpHash(req, pepper);
    } catch {
      return jsonResponse(503, { ok: false, error: "Authentication service unavailable" });
    }

    const { data: grantRes, error: grantErr } = await supabaseAdmin.rpc(
      "rpc_verify_grant_first_login",
      {
        p_organisation_id: orgId,
        p_username: username,
        p_ip_hash: ipHash,
      },
    );

    if (grantErr || !grantRes) {
      return jsonResponse(500, { ok: false, error: "Failed to verify grant" });
    }

    if (!grantRes.ok) {
      return jsonResponse(Number(grantRes.http_status) || 401, {
        ok: false,
        error: grantRes.error ?? "Invalid or expired grant",
      });
    }

    const passwordOk = await verifyTempPassword(
      tempPassword,
      String(grantRes.temp_password_hash ?? ""),
    );
    if (!passwordOk) {
      await supabaseAdmin.rpc("rpc_record_grant_login_failure", {
        p_organisation_id: orgId,
        p_username: username,
        p_ip_hash: ipHash,
      });
      return jsonResponse(401, { ok: false, error: "Invalid credentials" });
    }

    if (action === "first_login_check") {
      return jsonResponse(403, {
        ok: false,
        code: "PASSWORD_CHANGE_REQUIRED",
        must_change_password: true,
        error: "Temporary password verified; you must set a new password to activate access",
      });
    }

    // first_login_activate
    const newPassword = body.new_password;
    if (!isStrongNewPassword(newPassword, tempPassword)) {
      return jsonResponse(400, {
        ok: false,
        error: "New password must be 12-128 chars, differ from temp password, and include letters plus digits/symbols",
      });
    }

    const { data: createdUser, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email: String(grantRes.email),
      password: newPassword,
      email_confirm: true,
      app_metadata: {
        organisation_id: grantRes.organisation_id,
      },
    });

    if (createErr || !createdUser?.user?.id) {
      return jsonResponse(409, {
        ok: false,
        error: "Could not provision admin user account",
      });
    }

    const authUserId = createdUser.user.id;
    const { data: activateRes, error: activateErr } = await supabaseAdmin.rpc(
      "rpc_activate_admin_grant",
      {
        p_grant_id: grantRes.grant_id,
        p_auth_user_id: authUserId,
      },
    );

    if (activateErr || !activateRes?.ok) {
      await supabaseAdmin.auth.admin.deleteUser(authUserId).catch(() => undefined);
      return jsonResponse(Number(activateRes?.http_status) || 409, {
        ok: false,
        error: activateRes?.error ?? "Grant activation failed",
      });
    }

    const anonClient = createSupabaseAnon();
    const { data: signInData } = await anonClient.auth.signInWithPassword({
      email: String(grantRes.email),
      password: newPassword,
    });

    return jsonResponse(200, {
      ok: true,
      admin_id: authUserId,
      organisation_id: activateRes.organisation_id,
      username: activateRes.username,
      session: signInData?.session ?? null,
    });
  }

  // 2. Authenticated password change (permitted even when must_change_password = true)
  if (action === "change_password") {
    const authRes = await requireAdminContext(req, supabaseAdmin, {
      allowMustChangePassword: true,
    });
    if (!authRes.ok) return authRes.response;

    const newPassword = body.new_password;
    if (!isStrongNewPassword(newPassword)) {
      return jsonResponse(400, {
        ok: false,
        error: "New password must be 12-128 chars and include letters plus digits/symbols",
      });
    }

    const { error: updErr } = await supabaseAdmin.auth.admin.updateUserById(
      authRes.admin.id,
      { password: newPassword },
    );
    if (updErr) {
      return jsonResponse(500, { ok: false, error: "Failed to update password" });
    }

    const { data, error } = await supabaseAdmin.rpc("rpc_change_admin_password", {
      p_admin_id: authRes.admin.id,
    });
    if (error || !data?.ok) {
      return jsonResponse(500, { ok: false, error: "Failed to finalize password change" });
    }

    return jsonResponse(200, data);
  }

  // 3. All other actions require active admin with must_change_password = false.
  const authRes = await requireAdminContext(req, supabaseAdmin);
  if (!authRes.ok) return authRes.response;
  const admin = authRes.admin;

  if (action === "issue_grant") {
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!EMAIL_REGEX.test(email) || email.length > 320) {
      return jsonResponse(400, { ok: false, error: "Valid email is required" });
    }

    const tier = body.tier === "high" || body.tier === "standard" ? body.tier : null;
    if (!tier) {
      return jsonResponse(400, { ok: false, error: "tier must be 'high' or 'standard'" });
    }

    const permissions = validatePermissionSet(body.permission_set);
    if (!permissions) {
      return jsonResponse(400, { ok: false, error: "Invalid permission_set" });
    }

    const adminGroupId = body.admin_group_id !== undefined ? body.admin_group_id : null;
    if (adminGroupId !== null && !isNonZeroUuid(adminGroupId)) {
      return jsonResponse(400, { ok: false, error: "Invalid admin_group_id" });
    }

    const username =
      typeof body.username === "string" && body.username.trim().length > 0
        ? body.username.trim()
        : generateDefaultUsername(email);
    if (!USERNAME_REGEX.test(username)) {
      return jsonResponse(400, { ok: false, error: "Invalid username format" });
    }

    // Fail closed if email delivery provider is unconfigured (§4b.1: no grant exists without email).
    if (!isEmailDeliveryConfigured()) {
      return jsonResponse(503, {
        ok: false,
        error: "Grant email delivery provider is not configured",
      });
    }

    const tempPassword = generateTempPassword(20);
    const tempPasswordHash = await hashTempPassword(tempPassword);

    const { data: issueRes, error: issueErr } = await supabaseAdmin.rpc(
      "rpc_issue_admin_grant",
      {
        p_admin_id: admin.id,
        p_email: email,
        p_username: username,
        p_temp_password_hash: tempPasswordHash,
        p_permission_set: permissions,
        p_tier: tier,
        p_admin_group_id: adminGroupId,
      },
    );

    if (issueErr || !issueRes) {
      return jsonResponse(500, { ok: false, error: "Failed to create grant" });
    }
    if (!issueRes.ok) {
      return jsonResponse(Number(issueRes.http_status) || 400, {
        ok: false,
        error: issueRes.error ?? "Could not issue grant",
      });
    }

    const emailResult = await sendAdminGrantEmail({
      to: email,
      organisationName: admin.organisation_name,
      username,
      tempPassword,
      expiresAt: String(issueRes.expires_at),
    });

    await supabaseAdmin.rpc("rpc_finalize_admin_grant_email", {
      p_admin_id: admin.id,
      p_grant_id: issueRes.grant_id,
      p_email_sent: emailResult.ok,
      p_failure_reason: emailResult.ok ? null : emailResult.error,
    });

    if (!emailResult.ok) {
      return jsonResponse(502, {
        ok: false,
        error: "Grant was cancelled because email delivery failed",
      });
    }

    return jsonResponse(200, {
      ok: true,
      grant_id: issueRes.grant_id,
      username: issueRes.username,
      expires_at: issueRes.expires_at,
    });
  }

  if (action === "update_grant") {
    if (!isNonZeroUuid(body.target_admin_id)) {
      return jsonResponse(400, { ok: false, error: "Valid target_admin_id is required" });
    }
    let permissions: string[] | null = null;
    if (body.permission_set !== undefined) {
      permissions = validatePermissionSet(body.permission_set);
      if (!permissions) {
        return jsonResponse(400, { ok: false, error: "Invalid permission_set" });
      }
    }
    let tier: string | null = null;
    if (body.tier !== undefined) {
      if (body.tier !== "high" && body.tier !== "standard") {
        return jsonResponse(400, { ok: false, error: "Invalid tier" });
      }
      tier = body.tier;
    }
    const clearGroup = body.admin_group_id === null;
    const adminGroupId =
      body.admin_group_id !== undefined && body.admin_group_id !== null
        ? body.admin_group_id
        : null;
    if (adminGroupId !== null && !isNonZeroUuid(adminGroupId)) {
      return jsonResponse(400, { ok: false, error: "Invalid admin_group_id" });
    }

    const { data, error } = await supabaseAdmin.rpc("rpc_update_admin_grant", {
      p_admin_id: admin.id,
      p_target_admin_id: body.target_admin_id,
      p_permission_set: permissions,
      p_tier: tier,
      p_admin_group_id: adminGroupId,
      p_clear_admin_group: clearGroup,
    });
    if (error || !data) {
      return jsonResponse(500, { ok: false, error: "Failed to update grant" });
    }
    if (!data.ok) {
      return jsonResponse(Number(data.http_status) || 400, {
        ok: false,
        error: data.error ?? "Failed to update grant",
      });
    }
    return jsonResponse(200, data);
  }

  if (action === "revoke_grant") {
    const targetAdminId =
      body.target_admin_id !== undefined && body.target_admin_id !== null
        ? body.target_admin_id
        : null;
    const grantId =
      body.grant_id !== undefined && body.grant_id !== null ? body.grant_id : null;
    if (
      (targetAdminId !== null && !isNonZeroUuid(targetAdminId)) ||
      (grantId !== null && !isNonZeroUuid(grantId)) ||
      (targetAdminId === null && grantId === null)
    ) {
      return jsonResponse(400, { ok: false, error: "Valid target_admin_id or grant_id is required" });
    }

    const { data, error } = await supabaseAdmin.rpc("rpc_revoke_admin_grant", {
      p_admin_id: admin.id,
      p_target_admin_id: targetAdminId,
      p_grant_id: grantId,
    });
    if (error || !data) {
      return jsonResponse(500, { ok: false, error: "Failed to revoke grant" });
    }
    if (!data.ok) {
      return jsonResponse(Number(data.http_status) || 400, {
        ok: false,
        error: data.error ?? "Failed to revoke grant",
      });
    }

    if (typeof data.revoked_admin_id === "string" && isNonZeroUuid(data.revoked_admin_id)) {
      await supabaseAdmin.auth.admin
        .updateUserById(data.revoked_admin_id, { ban_duration: "876000h" })
        .catch(() => undefined);
    }

    return jsonResponse(200, data);
  }

  if (
    action === "admin_group_create" ||
    action === "admin_group_update" ||
    action === "admin_group_delete" ||
    action === "admin_group_assign"
  ) {
    const op = action.replace("admin_group_", "");
    const groupId =
      body.admin_group_id !== undefined && body.admin_group_id !== null
        ? body.admin_group_id
        : null;
    const targetAdminId =
      body.target_admin_id !== undefined && body.target_admin_id !== null
        ? body.target_admin_id
        : null;
    if (groupId !== null && !isNonZeroUuid(groupId)) {
      return jsonResponse(400, { ok: false, error: "Invalid admin_group_id" });
    }
    if (targetAdminId !== null && !isNonZeroUuid(targetAdminId)) {
      return jsonResponse(400, { ok: false, error: "Invalid target_admin_id" });
    }
    let permTemplate: string[] | null = null;
    if (body.permission_template !== undefined && body.permission_template !== null) {
      permTemplate = validatePermissionSet(body.permission_template);
      if (!permTemplate) {
        return jsonResponse(400, { ok: false, error: "Invalid permission_template" });
      }
    }

    const { data, error } = await supabaseAdmin.rpc("rpc_manage_admin_group", {
      p_admin_id: admin.id,
      p_op: op,
      p_admin_group_id: groupId,
      p_name: typeof body.name === "string" ? body.name : null,
      p_permission_template: permTemplate,
      p_target_admin_id: targetAdminId,
    });
    if (error || !data) {
      return jsonResponse(500, { ok: false, error: "Admin group operation failed" });
    }
    if (!data.ok) {
      return jsonResponse(Number(data.http_status) || 400, {
        ok: false,
        error: data.error ?? "Admin group operation failed",
      });
    }
    return jsonResponse(200, data);
  }

  return jsonResponse(400, { ok: false, error: "Unsupported action" });
});
