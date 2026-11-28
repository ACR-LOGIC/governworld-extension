import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleCorsPreflight, jsonResponse, methodNotAllowed } from "../_shared/cors.ts";
import { createSupabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { hashSeatSessionFromRequest, requireApiKey } from "../_shared/auth.ts";
import { isNonZeroUuid } from "../_shared/crypto.ts";
import { ALL_CATEGORIES } from "../_shared/policySigner.ts";

const ALLOWED_TOP_LEVEL_KEYS = new Set([
  "schema_version",
  "event_kind",
  "lifecycle_state",
  "seat_id",
  "installation_id",
  "organisation_id",
  "extension_version",
  "browser_name",
  "browser_version",
  "browser_family",
  "platform",
  "policy_version",
  "policy_hash",
  "policy_status",
  "health_status",
  "clean_shutdown_flag",
  "last_clean_shutdown_at",
  "timestamp",
  "reported_policy",
]);

const ALLOWED_REPORTED_POLICY_KEYS = new Set([
  "policy_version",
  "locked",
  "protectionMode",
  "userCanDisable",
  "enforcedCategories",
  "networkDestinationPolicy",
]);

const CATEGORY_SET = new Set<string>(ALL_CATEGORIES);
const BROWSER_NAMES = new Set(["Chrome", "Firefox", "Edge", "Chromium", "Brave", "Safari", "Opera", "Vivaldi", "unknown"]);
const BROWSER_FAMILIES = new Set(["chrome", "edge", "firefox", "safari", "brave", "opera", "vivaldi", "chromium", "unknown"]);
const LIFECYCLE_STATES = new Set(["online", "offline_clean_shutdown", "uninstalled_or_terminated"]);
const EVENT_KINDS = new Set(["heartbeat", "clean_shutdown"]);
const POLICY_STATUSES = new Set(["compliant", "out-of-date", "locked_lapsed", "unmanaged_default", "error"]);
const HEALTH_STATUSES = new Set(["healthy", "active", "degraded", "offline_clean"]);
const PROTECTION_MODES = new Set(["off", "this-tab", "always-on"]);
const NETWORK_DEST_POLICIES = new Set(["public_only", "managed_intranet", "disabled"]);
const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/;

const SEMVER_REGEX = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
const BROWSER_VER_REGEX = /^(?:[0-9]{1,5}(?:\.[0-9]{1,5}){0,3}|unknown)$/;
const PLATFORM_REGEX = /^[A-Za-z0-9._-]{1,64}$/;

function validateReportedPolicy(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_REPORTED_POLICY_KEYS.has(key)) {
      return null;
    }
  }
  const clean: Record<string, unknown> = {};
  if (obj.policy_version !== undefined) {
    if (
      typeof obj.policy_version !== "number" ||
      !Number.isInteger(obj.policy_version) ||
      obj.policy_version < 0
    ) {
      return null;
    }
    clean.policy_version = obj.policy_version;
  }
  if (obj.locked !== undefined) {
    if (typeof obj.locked !== "boolean") return null;
    clean.locked = obj.locked;
  }
  if (obj.protectionMode !== undefined) {
    if (typeof obj.protectionMode !== "string" || !PROTECTION_MODES.has(obj.protectionMode)) {
      return null;
    }
    clean.protectionMode = obj.protectionMode;
  }
  if (obj.userCanDisable !== undefined) {
    if (typeof obj.userCanDisable !== "boolean") return null;
    clean.userCanDisable = obj.userCanDisable;
  }
  if (obj.enforcedCategories !== undefined) {
    if (
      !Array.isArray(obj.enforcedCategories) ||
      obj.enforcedCategories.length > ALL_CATEGORIES.length ||
      !obj.enforcedCategories.every((c) => typeof c === "string" && CATEGORY_SET.has(c))
    ) {
      return null;
    }
    clean.enforcedCategories = [...new Set(obj.enforcedCategories)];
  }
  if (obj.networkDestinationPolicy !== undefined) {
    if (
      typeof obj.networkDestinationPolicy !== "string" ||
      !NETWORK_DEST_POLICIES.has(obj.networkDestinationPolicy)
    ) {
      return null;
    }
    clean.networkDestinationPolicy = obj.networkDestinationPolicy;
  }
  return clean;
}

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
      return jsonResponse(400, { ok: false, error: "Invalid heartbeat payload" });
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return jsonResponse(400, { ok: false, error: "Invalid JSON payload" });
  }

  // Strict Section 5 allowlist: reject any unexpected or free-text key.
  for (const key of Object.keys(body)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      return jsonResponse(400, { ok: false, error: `Unexpected heartbeat field: ${key}` });
    }
  }

  if (
    !isNonZeroUuid(body.seat_id) ||
    !isNonZeroUuid(body.installation_id) ||
    !isNonZeroUuid(body.organisation_id)
  ) {
    return jsonResponse(400, { ok: false, error: "Invalid seat or organisation identifier" });
  }

  if (
    typeof body.extension_version !== "string" ||
    body.extension_version.length > 32 ||
    !SEMVER_REGEX.test(body.extension_version)
  ) {
    return jsonResponse(400, { ok: false, error: "Invalid extension_version" });
  }

  if (typeof body.browser_name !== "string" || !BROWSER_NAMES.has(body.browser_name)) {
    return jsonResponse(400, { ok: false, error: "Invalid browser_name" });
  }

  if (typeof body.browser_version !== "string" || !BROWSER_VER_REGEX.test(body.browser_version)) {
    return jsonResponse(400, { ok: false, error: "Invalid browser_version" });
  }

  if (typeof body.platform !== "string" || !PLATFORM_REGEX.test(body.platform)) {
    return jsonResponse(400, { ok: false, error: "Invalid platform" });
  }

  if (
    typeof body.policy_version !== "number" ||
    !Number.isInteger(body.policy_version) ||
    body.policy_version < 0
  ) {
    return jsonResponse(400, { ok: false, error: "Invalid policy_version" });
  }

  if (typeof body.policy_status !== "string" || !POLICY_STATUSES.has(body.policy_status)) {
    return jsonResponse(400, { ok: false, error: "Invalid policy_status" });
  }

  if (typeof body.health_status !== "string" || !HEALTH_STATUSES.has(body.health_status)) {
    return jsonResponse(400, { ok: false, error: "Invalid health_status" });
  }

  if (typeof body.timestamp !== "string" || Number.isNaN(Date.parse(body.timestamp))) {
    return jsonResponse(400, { ok: false, error: "Invalid timestamp" });
  }

  if (body.event_kind !== undefined && (typeof body.event_kind !== "string" || !EVENT_KINDS.has(body.event_kind))) {
    return jsonResponse(400, { ok: false, error: "Invalid event_kind" });
  }

  const browserFamily =
    body.browser_family === undefined
      ? "unknown"
      : typeof body.browser_family === "string" && BROWSER_FAMILIES.has(body.browser_family)
        ? body.browser_family
        : null;
  if (!browserFamily) {
    return jsonResponse(400, { ok: false, error: "Invalid browser_family" });
  }

  const lifecycleState =
    body.lifecycle_state === undefined
      ? "online"
      : typeof body.lifecycle_state === "string" && LIFECYCLE_STATES.has(body.lifecycle_state)
        ? body.lifecycle_state
        : null;
  if (!lifecycleState) {
    return jsonResponse(400, { ok: false, error: "Invalid lifecycle_state" });
  }

  if (body.clean_shutdown_flag !== undefined && typeof body.clean_shutdown_flag !== "boolean") {
    return jsonResponse(400, { ok: false, error: "Invalid clean_shutdown_flag" });
  }

  if (
    body.last_clean_shutdown_at !== undefined &&
    (typeof body.last_clean_shutdown_at !== "string" || Number.isNaN(Date.parse(body.last_clean_shutdown_at)))
  ) {
    return jsonResponse(400, { ok: false, error: "Invalid last_clean_shutdown_at" });
  }

  if (body.policy_hash !== undefined && (typeof body.policy_hash !== "string" || !SHA256_HEX_REGEX.test(body.policy_hash))) {
    return jsonResponse(400, { ok: false, error: "Invalid policy_hash" });
  }

  const reportedPolicy = validateReportedPolicy(body.reported_policy ?? {});
  if (!reportedPolicy) {
    return jsonResponse(400, { ok: false, error: "Invalid reported_policy payload" });
  }

  const supabaseAdmin = createSupabaseAdmin();
  const { data, error } = await supabaseAdmin.rpc("rpc_ingest_heartbeat", {
    p_token_hash: sessionHashRes.tokenHash,
    p_installation_id: body.installation_id,
    p_seat_id: body.seat_id,
    p_organisation_id: body.organisation_id,
    p_extension_version: body.extension_version,
    p_browser_name: body.browser_name,
    p_browser_version: body.browser_version,
    p_platform: body.platform,
    p_policy_version: body.policy_version,
    p_policy_status: body.policy_status,
    p_health_status: body.health_status,
    p_reported_policy: reportedPolicy,
    p_browser_family: browserFamily,
    p_lifecycle_state: lifecycleState,
    p_clean_shutdown_flag: body.clean_shutdown_flag === true,
    p_last_clean_shutdown_at: body.last_clean_shutdown_at ?? null,
    p_policy_hash: body.policy_hash ?? null,
  });

  if (error || !data) {
    return jsonResponse(500, { ok: false, error: "Failed to record heartbeat" });
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
    received_at: data.received_at,
    unlocked: Boolean(data.unlocked),
    policy_version: Number(data.policy_version ?? 0),
  });
});
