import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { createSupabaseAnon, resolvePublishableKeys } from "./supabaseAdmin.ts";
import { isNonZeroUuid, sha256Hex, timingSafeEqualStrings } from "./crypto.ts";
import { jsonResponse } from "./cors.ts";
import { hasPermission, type AdminContext, type Permission } from "./permissions.ts";

export function requireApiKey(req: Request): Response | null {
  const provided = req.headers.get("apikey")?.trim() ?? "";
  if (!provided) {
    return jsonResponse(401, { ok: false, error: "Missing API key" });
  }
  const validKeys = resolvePublishableKeys();
  const matched = validKeys.some((k) => timingSafeEqualStrings(provided, k));
  if (!matched) {
    return jsonResponse(401, { ok: false, error: "Invalid API key" });
  }
  return null;
}

export function extractBearerJwt(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (!match) return null;
  const token = match[1].trim();
  // JWTs have 3 dot-separated base64url segments.
  if (token.split(".").length !== 3) return null;
  return token;
}

export function extractSeatSessionToken(req: Request): string | null {
  const headerToken = req.headers.get("x-seat-session")?.trim();
  if (headerToken && headerToken.length >= 16) {
    return headerToken;
  }
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (!match) return null;
  const token = match[1].trim();
  // Reject publishable keys or JWTs masquerading as seat tokens.
  if (token.startsWith("sb_publishable_") || token.split(".").length === 3) {
    return null;
  }
  return token.length >= 16 ? token : null;
}

export interface VerifiedJwtUser {
  userId: string;
  email: string | null;
  sessionId: string | null;
}

export async function verifyAdminJwt(
  req: Request,
  supabaseAdmin: SupabaseClient,
): Promise<{ ok: true; user: VerifiedJwtUser } | { ok: false; response: Response }> {
  const jwt = extractBearerJwt(req);
  if (!jwt) {
    return {
      ok: false,
      response: jsonResponse(401, { ok: false, error: "Missing or invalid authorization token" }),
    };
  }

  const anonClient = createSupabaseAnon();
  const authAny = anonClient.auth as unknown as {
    getClaims?: (
      token?: string,
    ) => Promise<{
      data: { claims?: Record<string, unknown> } | null;
      error: unknown;
    }>;
  };

  if (typeof authAny.getClaims === "function") {
    const { data, error } = await authAny.getClaims(jwt);
    if (!error && data?.claims && typeof data.claims.sub === "string") {
      const sub = data.claims.sub;
      const sessionId =
        typeof data.claims.session_id === "string" ? data.claims.session_id : null;
      const email =
        typeof data.claims.email === "string" ? data.claims.email : null;
      if (!isNonZeroUuid(sub)) {
        return {
          ok: false,
          response: jsonResponse(401, { ok: false, error: "Invalid token subject" }),
        };
      }
      return { ok: true, user: { userId: sub, email, sessionId } };
    }
    return {
      ok: false,
      response: jsonResponse(401, { ok: false, error: "Unauthorized" }),
    };
  }

  // Fallback to Auth API user verification if getClaims is unavailable.
  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(jwt);
  if (userErr || !userData?.user?.id) {
    return {
      ok: false,
      response: jsonResponse(401, { ok: false, error: "Unauthorized" }),
    };
  }
  return {
    ok: true,
    user: {
      userId: userData.user.id,
      email: userData.user.email ?? null,
      sessionId: null,
    },
  };
}

export async function requireAdminContext(
  req: Request,
  supabaseAdmin: SupabaseClient,
  options: {
    allowMustChangePassword?: boolean;
    requiredPermission?: Permission;
    requirePrimary?: boolean;
  } = {},
): Promise<{ ok: true; admin: AdminContext } | { ok: false; response: Response }> {
  const jwtResult = await verifyAdminJwt(req, supabaseAdmin);
  if (!jwtResult.ok) {
    return jwtResult;
  }

  const { data, error } = await supabaseAdmin.rpc("rpc_get_admin_context", {
    p_admin_id: jwtResult.user.userId,
    p_session_id: jwtResult.user.sessionId,
  });

  if (error || !data || data.found !== true) {
    return {
      ok: false,
      response: jsonResponse(401, { ok: false, error: "Unauthorized" }),
    };
  }

  const admin = data as unknown as AdminContext;
  if (admin.status !== "active") {
    return {
      ok: false,
      response: jsonResponse(403, { ok: false, error: "Admin access revoked" }),
    };
  }

  if (admin.must_change_password && !options.allowMustChangePassword) {
    return {
      ok: false,
      response: jsonResponse(403, {
        ok: false,
        code: "PASSWORD_CHANGE_REQUIRED",
        error: "Password change required before performing this action",
      }),
    };
  }

  if (options.requirePrimary && admin.role !== "primary") {
    return {
      ok: false,
      response: jsonResponse(403, {
        ok: false,
        error: "Primary administrator privileges required",
      }),
    };
  }

  if (options.requiredPermission && !hasPermission(admin, options.requiredPermission)) {
    return {
      ok: false,
      response: jsonResponse(403, {
        ok: false,
        error: `Missing required permission: ${options.requiredPermission}`,
      }),
    };
  }

  return { ok: true, admin };
}

export async function hashSeatSessionFromRequest(
  req: Request,
): Promise<{ ok: true; tokenHash: string } | { ok: false; response: Response }> {
  const token = extractSeatSessionToken(req);
  if (!token) {
    return {
      ok: false,
      response: jsonResponse(401, { ok: false, error: "Missing seat session credential" }),
    };
  }
  return { ok: true, tokenHash: await sha256Hex(token) };
}
