import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { handleCorsPreflight, jsonResponse, methodNotAllowed } from "../_shared/cors.ts";
import { createSupabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { isNonZeroUuid } from "../_shared/crypto.ts";

const BROWSER_FAMILIES = new Set([
  "chrome",
  "edge",
  "firefox",
  "safari",
  "brave",
  "opera",
  "vivaldi",
  "chromium",
  "unknown",
]);
const HEX_PREFIX_RE = /^[0-9a-f]{16}$/;

Deno.serve(async (req: Request) => {
  const preflight = handleCorsPreflight(req);
  if (preflight) return preflight;
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed();

  const url = new URL(req.url);
  let orgId = url.searchParams.get("org") ?? "";
  let deviceId = url.searchParams.get("device") ?? "";
  let browserFamily = url.searchParams.get("browser") ?? "unknown";
  let activationPrefix = url.searchParams.get("activation") ?? "";

  if (req.method === "POST") {
    try {
      const body = (await req.json()) as Record<string, unknown>;
      if (typeof body.org === "string") orgId = body.org;
      if (typeof body.device === "string") deviceId = body.device;
      if (typeof body.browser === "string") browserFamily = body.browser;
      if (typeof body.activation === "string") activationPrefix = body.activation;
    } catch {
      return jsonResponse(400, { ok: false, error: "Invalid JSON payload" });
    }
  }

  if (!isNonZeroUuid(orgId) || !deviceId || deviceId.length > 128 || !BROWSER_FAMILIES.has(browserFamily)) {
    return jsonResponse(400, { ok: false, error: "Invalid uninstall signal parameters" });
  }

  if (activationPrefix && !HEX_PREFIX_RE.test(activationPrefix)) {
    return jsonResponse(400, { ok: false, error: "Invalid activation prefix" });
  }

  const supabaseAdmin = createSupabaseAdmin();
  const { data, error } = await supabaseAdmin.rpc("rpc_record_uninstall_signal", {
    p_organisation_id: orgId,
    p_installation_id: deviceId,
    p_browser_family: browserFamily,
    p_activation_prefix: activationPrefix || null,
  });

  if (error || !data) {
    return jsonResponse(500, { ok: false, error: "Failed to record uninstall signal" });
  }

  return jsonResponse(data.ok ? 200 : Number(data.http_status) || 404, data);
});
