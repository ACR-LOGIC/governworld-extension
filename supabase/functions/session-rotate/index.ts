import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleCorsPreflight, jsonResponse, methodNotAllowed } from "../_shared/cors.ts";
import { createSupabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { hashSeatSessionFromRequest, requireApiKey } from "../_shared/auth.ts";
import { isNonZeroUuid, randomOpaqueToken, sha256Hex } from "../_shared/crypto.ts";

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

  const newToken = randomOpaqueToken("gws_", 32);
  const newTokenHash = await sha256Hex(newToken);
  const newExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const supabaseAdmin = createSupabaseAdmin();
  const { data, error } = await supabaseAdmin.rpc("rpc_rotate_seat_session", {
    p_old_token_hash: sessionHashRes.tokenHash,
    p_installation_id: body.installation_id,
    p_new_token_hash: newTokenHash,
    p_new_expires_at: newExpiresAt,
  });

  if (error || !data) {
    return jsonResponse(500, { ok: false, error: "Failed to rotate session" });
  }

  if (!data.ok) {
    const status = Number(data.http_status) || 401;
    return jsonResponse(status, {
      ok: false,
      status: data.status ?? "invalid",
      error: data.error ?? "Unauthorized",
    });
  }

  return jsonResponse(200, {
    ok: true,
    seat_session_token: newToken,
    session_expires_at: data.session_expires_at ?? newExpiresAt,
    token_generation: data.token_generation,
  });
});
