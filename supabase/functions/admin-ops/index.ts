import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleCorsPreflight, jsonResponse, methodNotAllowed } from "../_shared/cors.ts";
import { createSupabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { requireAdminContext, requireApiKey, verifyAdminJwt } from "../_shared/auth.ts";
import { isNonZeroUuid } from "../_shared/crypto.ts";
import {
  normalizeAndValidatePolicyBody,
  PolicyBodyValidationError,
} from "../_shared/policySigner.ts";

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

  // Bootstrap action for a newly signed-up primary admin (no admins row yet).
  if (action === "create_organisation") {
    const jwtRes = await verifyAdminJwt(req, supabaseAdmin);
    if (!jwtRes.ok) return jwtRes.response;

    const orgName = typeof body.name === "string" ? body.name.trim() : "";
    const username =
      typeof body.username === "string" && body.username.trim().length >= 2
        ? body.username.trim()
        : (jwtRes.user.email?.split("@")[0]?.slice(0, 64) ?? "primary_admin");
    const email = jwtRes.user.email ?? (typeof body.email === "string" ? body.email.trim() : "");

    if (!orgName || !email) {
      return jsonResponse(400, { ok: false, error: "Organisation name and verified email required" });
    }

    const { data, error } = await supabaseAdmin.rpc("rpc_create_organisation", {
      p_admin_id: jwtRes.user.userId,
      p_email: email,
      p_username: username,
      p_org_name: orgName,
    });
    if (error || !data) {
      return jsonResponse(500, { ok: false, error: "Failed to create organisation" });
    }
    if (!data.ok) {
      return jsonResponse(Number(data.http_status) || 400, {
        ok: false,
        error: data.error ?? "Could not create organisation",
      });
    }
    return jsonResponse(200, data);
  }

  // All remaining actions require an active admin with must_change_password = false.
  const authRes = await requireAdminContext(req, supabaseAdmin);
  if (!authRes.ok) return authRes.response;
  const admin = authRes.admin;

  if (action === "delete_organisation") {
    const orgId = body.organisation_id ?? admin.organisation_id;
    if (!isNonZeroUuid(orgId)) {
      return jsonResponse(400, { ok: false, error: "Invalid organisation_id" });
    }
    const { data, error } = await supabaseAdmin.rpc("rpc_delete_organisation", {
      p_admin_id: admin.id,
      p_organisation_id: orgId,
    });
    if (error || !data) {
      return jsonResponse(500, { ok: false, error: "Failed to delete organisation" });
    }
    if (!data.ok) {
      return jsonResponse(Number(data.http_status) || 403, {
        ok: false,
        error: data.error ?? "Forbidden",
      });
    }
    return jsonResponse(200, data);
  }

  if (
    action === "policy_create" ||
    action === "policy_update" ||
    action === "policy_delete" ||
    action === "policy_assign"
  ) {
    const op = action.replace("policy_", "");
    const policyId =
      body.policy_id !== undefined && body.policy_id !== null ? body.policy_id : null;
    const targetId =
      body.target_id !== undefined && body.target_id !== null ? body.target_id : null;
    if (policyId !== null && !isNonZeroUuid(policyId)) {
      return jsonResponse(400, { ok: false, error: "Invalid policy_id" });
    }
    if (targetId !== null && !isNonZeroUuid(targetId)) {
      return jsonResponse(400, { ok: false, error: "Invalid target_id" });
    }

    let normalizedBody: Record<string, unknown> | null = null;
    if (op === "create" || (op === "update" && body.body !== undefined)) {
      try {
        normalizedBody = normalizeAndValidatePolicyBody(body.body ?? {});
      } catch (err) {
        if (err instanceof PolicyBodyValidationError) {
          return jsonResponse(400, { ok: false, error: err.message });
        }
        return jsonResponse(400, { ok: false, error: "Invalid policy body" });
      }
    }

    const { data, error } = await supabaseAdmin.rpc("rpc_policy_ops", {
      p_admin_id: admin.id,
      p_op: op,
      p_policy_id: policyId,
      p_name: typeof body.name === "string" ? body.name : null,
      p_body: normalizedBody,
      p_target_type: typeof body.target_type === "string" ? body.target_type : null,
      p_target_id: targetId,
    });
    if (error || !data) {
      return jsonResponse(500, { ok: false, error: "Policy operation failed" });
    }
    if (!data.ok) {
      return jsonResponse(Number(data.http_status) || 400, {
        ok: false,
        error: data.error ?? "Policy operation failed",
      });
    }
    return jsonResponse(200, data);
  }

  if (
    action === "group_create" ||
    action === "group_update" ||
    action === "group_delete" ||
    action === "seat_assign_group"
  ) {
    const op = action === "seat_assign_group" ? "assign_seat" : action.replace("group_", "");
    const groupId =
      body.group_id !== undefined && body.group_id !== null ? body.group_id : null;
    const policyId =
      body.policy_id !== undefined && body.policy_id !== null ? body.policy_id : null;
    const seatId = body.seat_id !== undefined && body.seat_id !== null ? body.seat_id : null;

    if (groupId !== null && !isNonZeroUuid(groupId)) {
      return jsonResponse(400, { ok: false, error: "Invalid group_id" });
    }
    if (policyId !== null && !isNonZeroUuid(policyId)) {
      return jsonResponse(400, { ok: false, error: "Invalid policy_id" });
    }
    if (seatId !== null && !isNonZeroUuid(seatId)) {
      return jsonResponse(400, { ok: false, error: "Invalid seat_id" });
    }

    const { data, error } = await supabaseAdmin.rpc("rpc_group_ops", {
      p_admin_id: admin.id,
      p_op: op,
      p_group_id: groupId,
      p_name: typeof body.name === "string" ? body.name : null,
      p_policy_id: policyId,
      p_seat_id: seatId,
    });
    if (error || !data) {
      return jsonResponse(500, { ok: false, error: "Group operation failed" });
    }
    if (!data.ok) {
      return jsonResponse(Number(data.http_status) || 400, {
        ok: false,
        error: data.error ?? "Group operation failed",
      });
    }
    return jsonResponse(200, data);
  }

  if (
    action === "seat_create" ||
    action === "seat_unlock" ||
    action === "seat_lock" ||
    action === "seat_revoke"
  ) {
    const op = action.replace("seat_", "");
    const seatId = body.seat_id !== undefined && body.seat_id !== null ? body.seat_id : null;
    if (op !== "create" && !isNonZeroUuid(seatId)) {
      return jsonResponse(400, { ok: false, error: "Valid seat_id is required" });
    }

    const { data, error } = await supabaseAdmin.rpc("rpc_seat_ops", {
      p_admin_id: admin.id,
      p_op: op,
      p_seat_id: seatId,
      p_label: typeof body.label === "string" ? body.label : null,
    });
    if (error || !data) {
      return jsonResponse(500, { ok: false, error: "Seat operation failed" });
    }
    if (!data.ok) {
      return jsonResponse(Number(data.http_status) || 400, {
        ok: false,
        error: data.error ?? "Seat operation failed",
      });
    }
    return jsonResponse(200, data);
  }

  if (action === "audit_read") {
    const limit =
      typeof body.limit === "number" && Number.isInteger(body.limit) ? body.limit : 50;
    const before =
      typeof body.before_created_at === "string" && !Number.isNaN(Date.parse(body.before_created_at))
        ? body.before_created_at
        : null;
    const { data, error } = await supabaseAdmin.rpc("rpc_read_audit_log", {
      p_admin_id: admin.id,
      p_limit: limit,
      p_before: before,
    });
    if (error || !data) {
      return jsonResponse(500, { ok: false, error: "Failed to read audit log" });
    }
    if (!data.ok) {
      return jsonResponse(Number(data.http_status) || 403, {
        ok: false,
        error: data.error ?? "Forbidden",
      });
    }
    return jsonResponse(200, data);
  }

  return jsonResponse(400, { ok: false, error: "Unsupported action" });
});
