import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleCorsPreflight, jsonResponse, methodNotAllowed } from "../_shared/cors.ts";
import { createSupabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { requireAdminContext, requireApiKey } from "../_shared/auth.ts";
import {
  computePairingCodeHashes,
  generate8DigitCode,
  getPairingPepper,
  isNonZeroUuid,
} from "../_shared/crypto.ts";

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

  const supabaseAdmin = createSupabaseAdmin();
  const authResult = await requireAdminContext(req, supabaseAdmin);
  if (!authResult.ok) return authResult.response;
  const admin = authResult.admin;

  const action = typeof body.action === "string" ? body.action : "generate";

  if (action === "revoke") {
    const seatId = body.seat_id !== undefined ? body.seat_id : null;
    const codeId = body.code_id !== undefined ? body.code_id : null;
    if (
      (seatId !== null && !isNonZeroUuid(seatId)) ||
      (codeId !== null && !isNonZeroUuid(codeId)) ||
      (seatId === null && codeId === null)
    ) {
      return jsonResponse(400, { ok: false, error: "Valid seat_id or code_id is required" });
    }
    const { data, error } = await supabaseAdmin.rpc("rpc_revoke_pairing_code", {
      p_admin_id: admin.id,
      p_seat_id: seatId,
      p_code_id: codeId,
    });
    if (error || !data) {
      return jsonResponse(500, { ok: false, error: "Failed to revoke pairing code" });
    }
    if (!data.ok) {
      return jsonResponse(Number(data.http_status) || 400, {
        ok: false,
        error: data.error ?? "Failed to revoke pairing code",
      });
    }
    return jsonResponse(200, data);
  }

  if (action !== "generate") {
    return jsonResponse(400, { ok: false, error: "Unsupported action" });
  }

  if (!isNonZeroUuid(body.seat_id)) {
    return jsonResponse(400, { ok: false, error: "Valid seat_id is required" });
  }

  let pepper: string;
  try {
    pepper = await getPairingPepper(supabaseAdmin);
  } catch {
    return jsonResponse(503, { ok: false, error: "Pairing service is not configured" });
  }

  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generate8DigitCode();
    const { lookupHash, orgHash } = await computePairingCodeHashes(
      pepper,
      code,
      admin.organisation_id,
    );

    const { data, error } = await supabaseAdmin.rpc("rpc_generate_pairing_code", {
      p_admin_id: admin.id,
      p_seat_id: body.seat_id,
      p_code_hash: orgHash,
      p_lookup_hash: lookupHash,
      p_expires_at: expiresAt,
    });

    if (error || !data) {
      return jsonResponse(500, { ok: false, error: "Failed to generate pairing code" });
    }

    if (data.ok) {
      return jsonResponse(200, {
        ok: true,
        code_id: data.code_id,
        seat_id: data.seat_id,
        code,
        expires_at: data.expires_at,
      });
    }

    if (data.error === "CODE_COLLISION") {
      continue;
    }

    return jsonResponse(Number(data.http_status) || 400, {
      ok: false,
      error: data.error ?? "Could not generate pairing code",
    });
  }

  return jsonResponse(503, { ok: false, error: "Could not allocate unique pairing code" });
});
