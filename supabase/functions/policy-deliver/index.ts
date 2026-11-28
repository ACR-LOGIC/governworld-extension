import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleCorsPreflight, jsonResponse, methodNotAllowed } from "../_shared/cors.ts";
import { createSupabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { hashSeatSessionFromRequest, requireApiKey } from "../_shared/auth.ts";
import { isNonZeroUuid } from "../_shared/crypto.ts";
import {
  buildAndSignManagedPolicyEnvelope,
  PolicySigningNotConfiguredError,
} from "../_shared/policySigner.ts";

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return methodNotAllowed();

  const apiKeyErr = requireApiKey(req);
  if (apiKeyErr) return apiKeyErr;

  const sessionHashRes = await hashSeatSessionFromRequest(req);
  if (!sessionHashRes.ok) return sessionHashRes.response;

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

  if (!isNonZeroUuid(body.installation_id)) {
    return jsonResponse(400, { ok: false, error: "Valid installation_id is required" });
  }

  const supabaseAdmin = createSupabaseAdmin();
  const { data, error } = await supabaseAdmin.rpc("rpc_deliver_policy_for_seat", {
    p_token_hash: sessionHashRes.tokenHash,
    p_installation_id: body.installation_id,
  });

  if (error || !data) {
    return jsonResponse(500, { ok: false, error: "Policy delivery failed" });
  }

  if (!data.ok) {
    const status = Number(data.http_status) || 401;
    return jsonResponse(status, {
      ok: false,
      status: data.status ?? "invalid",
      error: data.error ?? "Unauthorized",
    });
  }

  try {
    const signed = await buildAndSignManagedPolicyEnvelope({
      policy: data.policy ?? null,
      organisation_id: String(data.organisation_id),
      organisation_name: String(data.organisation_name ?? ""),
      seat_id: String(data.seat_id),
      installation_id: body.installation_id,
      unlocked: Boolean(data.unlocked),
      unlocked_features: Array.isArray(data.unlocked_features)
        ? (data.unlocked_features as string[])
        : [],
      policy_seq: Number(data.policy_seq ?? 1),
    });

    return jsonResponse(200, {
      ok: true,
      status: "active",
      organisation_id: data.organisation_id,
      organisation_name: data.organisation_name,
      seat_id: data.seat_id,
      unlocked: Boolean(data.unlocked),
      unlocked_features: Array.isArray(data.unlocked_features) ? data.unlocked_features : [],
      policy_version: signed.policy_version,
      policy_envelope: signed.policy_envelope,
    });
  } catch (err) {
    if (err instanceof PolicySigningNotConfiguredError) {
      return jsonResponse(503, {
        ok: false,
        error: "Policy signing key is not configured",
      });
    }
    return jsonResponse(500, { ok: false, error: "Policy signing failed" });
  }
});
