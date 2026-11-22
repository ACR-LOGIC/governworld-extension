import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleCorsPreflight, jsonResponse, methodNotAllowed } from "../_shared/cors.ts";
import { createSupabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { hashSeatSessionFromRequest, requireApiKey } from "../_shared/auth.ts";
import { isNonZeroUuid } from "../_shared/crypto.ts";

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
  const { data, error } = await supabaseAdmin.rpc("rpc_unpair_seat", {
    p_token_hash: sessionHashRes.tokenHash,
    p_installation_id: body.installation_id,
  });

  if (error || !data) {
    return jsonResponse(500, { ok: false, error: "Failed to unpair seat" });
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
    status: "unpaired",
    seat_id: data.seat_id,
  });
});
