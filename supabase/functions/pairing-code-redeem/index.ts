import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleCorsPreflight, jsonResponse, methodNotAllowed } from "../_shared/cors.ts";
import { createSupabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { requireApiKey } from "../_shared/auth.ts";
import {
  computePairingCodeHashes,
  getClientIpHash,
  getPairingPepper,
  isNonZeroUuid,
  randomOpaqueToken,
  sha256Hex,
} from "../_shared/crypto.ts";
import {
  buildAndSignManagedPolicyEnvelope,
  PolicySigningNotConfiguredError,
} from "../_shared/policySigner.ts";

const GENERIC_REDEEM_ERROR = "That code could not be accepted";
const EIGHT_DIGIT_CODE_REGEX = /^\d{8}$/;
const ALLOWED_KEYS = new Set(["code", "installation_id"]);

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
      return jsonResponse(400, { ok: false, error: GENERIC_REDEEM_ERROR });
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return jsonResponse(400, { ok: false, error: GENERIC_REDEEM_ERROR });
  }

  for (const key of Object.keys(body)) {
    if (!ALLOWED_KEYS.has(key)) {
      return jsonResponse(400, { ok: false, error: GENERIC_REDEEM_ERROR });
    }
  }

  const rawCode = typeof body.code === "string" ? body.code.trim() : "";
  const installationId = body.installation_id;

  if (!EIGHT_DIGIT_CODE_REGEX.test(rawCode) || !isNonZeroUuid(installationId)) {
    return jsonResponse(400, { ok: false, error: GENERIC_REDEEM_ERROR });
  }

  const supabaseAdmin = createSupabaseAdmin();

  let pepper: string;
  try {
    pepper = await getPairingPepper(supabaseAdmin);
  } catch {
    return jsonResponse(503, { ok: false, error: "Pairing service unavailable" });
  }

  const { lookupHash } = await computePairingCodeHashes(pepper, rawCode);
  const ipHash = await getClientIpHash(req, pepper);

  // Locate candidate org_id without ever sending plaintext code to Postgres.
  const { data: candidate, error: candErr } = await supabaseAdmin.rpc(
    "rpc_find_pairing_code_candidate",
    { p_lookup_hash: lookupHash },
  );

  if (candErr) {
    return jsonResponse(500, { ok: false, error: GENERIC_REDEEM_ERROR });
  }

  let orgHash = "unmatched";
  if (candidate?.found === true && typeof candidate.organisation_id === "string") {
    const computed = await computePairingCodeHashes(pepper, rawCode, candidate.organisation_id);
    orgHash = computed.orgHash ?? "unmatched";
  }

  const seatSessionToken = randomOpaqueToken("gws_", 32);
  const sessionTokenHash = await sha256Hex(seatSessionToken);
  const sessionExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data: redeemResult, error: redeemErr } = await supabaseAdmin.rpc(
    "rpc_redeem_pairing_code",
    {
      p_lookup_hash: lookupHash,
      p_code_hash: orgHash,
      p_installation_id: installationId,
      p_ip_hash: ipHash,
      p_session_token_hash: sessionTokenHash,
      p_session_expires_at: sessionExpiresAt,
    },
  );

  if (redeemErr || !redeemResult) {
    return jsonResponse(500, { ok: false, error: GENERIC_REDEEM_ERROR });
  }

  if (!redeemResult.ok) {
    const status = Number(redeemResult.http_status) || 403;
    return jsonResponse(status, { ok: false, error: GENERIC_REDEEM_ERROR });
  }

  try {
    const signed = await buildAndSignManagedPolicyEnvelope({
      policy: redeemResult.policy ?? null,
      organisation_id: String(redeemResult.organisation_id),
      organisation_name: String(redeemResult.organisation_name ?? ""),
      seat_id: String(redeemResult.seat_id),
      installation_id: installationId,
      unlocked: Boolean(redeemResult.unlocked),
      policy_seq: Number(redeemResult.policy_seq ?? 1),
    });

    return jsonResponse(200, {
      ok: true,
      organisation_id: redeemResult.organisation_id,
      organisation_name: redeemResult.organisation_name,
      seat_id: redeemResult.seat_id,
      unlocked: Boolean(redeemResult.unlocked),
      seat_session_token: seatSessionToken,
      session_expires_at: redeemResult.session_expires_at ?? sessionExpiresAt,
      policy_envelope: signed.policy_envelope,
      policy_version: signed.policy_version,
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
