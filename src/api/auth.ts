// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
/**
 * Authentication management for GovernWorld control-plane connection.
 * Short-lived bearer credentials live exclusively in chrome.storage.session (in-memory).
 * Non-secret connection metadata lives in chrome.storage.local.
 *
 * Implements OAuth 2.0 with PKCE S256 (Priority 0 — Item 4) and resilient
 * refresh-token session handling (Priority 0 — Item 5).
 */

import { GovernWorldApiClient } from "./client.js";
import { getApiUrl } from "./config.js";
import type { ApiErrorDetails, AuthTokens } from "./types.js";
import { SecurityTelemetry } from "../shared/telemetry.js";

const SESSION_KEY_AUTH_TOKENS = "gw_auth_tokens";
const LOCAL_KEY_AUTH_METADATA = "gw_auth_metadata";
const OAUTH_STATE_KEY = "gw_oauth_state";
export const OAUTH_PKCE_VERIFIER_KEY = "gw_oauth_pkce_verifier";

export interface StoredAuthMetadata {
  connected: boolean;
  user_id?: string;
  user_email?: string;
  tenant_id?: string;
  tenant_name?: string;
  connected_at: string;
}

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Computes RFC 7636 S256 `code_challenge = BASE64URL(SHA256(ASCII(code_verifier)))`.
 */
export async function computeCodeChallengeS256(codeVerifier: string): Promise<string> {
  const data = new TextEncoder().encode(codeVerifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(digest));
}

/**
 * Generates a high-entropy PKCE `code_verifier` and `code_challenge` (SHA-256)
 * and stores `code_verifier` in `chrome.storage.session` for token exchange.
 */
export async function generatePkcePair(): Promise<PkcePair> {
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  const codeVerifier = base64UrlEncode(randomBytes);
  const codeChallenge = await computeCodeChallengeS256(codeVerifier);
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.session) {
      await chrome.storage.session.set({ [OAUTH_PKCE_VERIFIER_KEY]: codeVerifier });
    }
  } catch {
    // Session storage unavailable in some test environments
  }
  return {
    codeVerifier,
    codeChallenge,
    codeChallengeMethod: "S256",
  };
}

export async function getStoredPkceVerifier(): Promise<string | null> {
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.session) {
      const stored = await chrome.storage.session.get(OAUTH_PKCE_VERIFIER_KEY);
      const verifier = stored[OAUTH_PKCE_VERIFIER_KEY];
      if (typeof verifier === "string" && verifier.length >= 43) {
        return verifier;
      }
    }
  } catch {
    // Session storage not available
  }
  return null;
}

export async function clearStoredPkceVerifier(): Promise<void> {
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.session) {
      await chrome.storage.session.remove(OAUTH_PKCE_VERIFIER_KEY);
    }
  } catch {
    // Session storage not available
  }
}

export async function getStoredTokens(): Promise<AuthTokens | null> {
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.session) {
      const stored = await chrome.storage.session.get(SESSION_KEY_AUTH_TOKENS);
      const tokens = stored[SESSION_KEY_AUTH_TOKENS] as AuthTokens | undefined;
      if (tokens && typeof tokens.access_token === "string") {
        return tokens;
      }
    }
  } catch {
    // Session storage not available
  }
  return null;
}

export async function saveAuthSession(tokens: AuthTokens, metadata: StoredAuthMetadata): Promise<void> {
  if (typeof chrome !== "undefined") {
    if (chrome.storage?.session) {
      await chrome.storage.session.set({ [SESSION_KEY_AUTH_TOKENS]: tokens });
    }
    if (chrome.storage?.local) {
      await chrome.storage.local.set({ [LOCAL_KEY_AUTH_METADATA]: metadata });
    }
  }
}

export async function clearAuthSession(): Promise<void> {
  if (typeof chrome !== "undefined") {
    if (chrome.storage?.session) {
      await chrome.storage.session.remove(SESSION_KEY_AUTH_TOKENS);
    }
    if (chrome.storage?.local) {
      await chrome.storage.local.remove(LOCAL_KEY_AUTH_METADATA);
    }
  }
}

export async function getAuthMetadata(): Promise<StoredAuthMetadata | null> {
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      const stored = await chrome.storage.local.get(LOCAL_KEY_AUTH_METADATA);
      return (stored[LOCAL_KEY_AUTH_METADATA] as StoredAuthMetadata) ?? null;
    }
  } catch {
    // Local storage not available
  }
  return null;
}

export function isTokenExpired(tokens: AuthTokens, clockSkewMs = 0): boolean {
  const now = Date.now() + clockSkewMs;
  // Expire 30 seconds early as a safety buffer
  return now >= tokens.expires_at - 30_000;
}

/**
 * Determines whether a refresh-token failure represents an authoritative token
 * revocation/rejection that requires clearing the user's session (Priority 0 — Item 5).
 *
 * Clear session ONLY for:
 *   - HTTP 401 (Unauthorized)
 *   - HTTP 400 (Bad Request / invalid_grant / invalid_token)
 *   - Explicit `invalid_grant` or `invalid_token` OAuth error
 *
 * Do NOT clear session for:
 *   - Timeouts (`TIMEOUT`)
 *   - Offline / network interruptions (`OFFLINE`, status 0)
 *   - Rate limits (HTTP 429)
 *   - Server errors (HTTP 500, 502, 503, 504)
 */
export function shouldClearSessionOnRefreshError(error: ApiErrorDetails): boolean {
  if (!error) return false;
  if (error.code === "TIMEOUT" || error.code === "OFFLINE" || error.code === "RATE_LIMITED") {
    return false;
  }
  if (error.status_code >= 500 || error.status_code === 0 || error.status_code === 429) {
    return false;
  }
  const oauthErr = (error.oauth_error ?? "").toLowerCase();
  const msgLower = (error.user_message ?? "").toLowerCase();
  const codeLower = (error.code ?? "").toLowerCase();
  if (
    oauthErr === "invalid_grant" ||
    oauthErr === "invalid_token" ||
    codeLower === "invalid_grant" ||
    codeLower === "invalid_token" ||
    /\b(?:invalid_grant|invalid_token)\b/.test(msgLower)
  ) {
    return true;
  }
  if (error.status_code === 401 || error.status_code === 400) {
    return true;
  }
  return false;
}

let refreshInFlight: Promise<{ ok: true; tokens: AuthTokens } | { ok: false; error: string }> | null = null;

export async function refreshAccessToken(
  client: GovernWorldApiClient,
  refreshToken: string
): Promise<{ ok: true; tokens: AuthTokens } | { ok: false; error: string }> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const result = await client.post<AuthTokens>("/api/v1/extension/auth/refresh", {
      refresh_token: refreshToken,
    });

    if (!result.ok) {
      if (shouldClearSessionOnRefreshError(result.error)) {
        SecurityTelemetry.record("oauth_refresh_session_cleared", {
          statusCode: result.error.status_code,
          code: result.error.code,
          oauthError: result.error.oauth_error ?? "none",
        });
        await clearAuthSession();
      } else {
        SecurityTelemetry.record("oauth_refresh_transient_failure", {
          statusCode: result.error.status_code,
          code: result.error.code,
        });
      }
      return { ok: false, error: result.error.user_message };
    }

    const tokens = result.data;
    const now = Date.now();
    const normalizedTokens: AuthTokens = {
      ...tokens,
      expires_at: tokens.expires_at || now + (tokens.expires_in || 3600) * 1000,
    };

    const existingMeta = await getAuthMetadata();
    if (existingMeta) {
      await saveAuthSession(normalizedTokens, existingMeta);
    }

    return { ok: true, tokens: normalizedTokens };
  })();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

export async function logout(client: GovernWorldApiClient): Promise<void> {
  const tokens = await getStoredTokens();
  if (tokens?.access_token) {
    void client.post("/api/v1/extension/auth/logout", {}, { token: tokens.access_token }).catch(() => undefined);
  }
  await clearAuthSession();
}

export async function generateOAuthState(): Promise<string> {
  const state = crypto.randomUUID();
  if (typeof chrome !== "undefined" && chrome.storage?.session) {
    await chrome.storage.session.set({ [OAUTH_STATE_KEY]: state });
  }
  return state;
}

export async function verifyOAuthState(state: string): Promise<boolean> {
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.session) {
      const stored = await chrome.storage.session.get(OAUTH_STATE_KEY);
      const expected = stored[OAUTH_STATE_KEY];
      if (expected === state) {
        await chrome.storage.session.remove(OAUTH_STATE_KEY);
        return true;
      }
    }
  } catch {
    // Session storage not available
  }
  return false;
}

export async function buildAuthorizeUrl(state: string, codeChallenge?: string): Promise<string> {
  const baseUrl = await getApiUrl();
  const runtimeId =
    typeof chrome !== "undefined" && chrome?.runtime?.id ? chrome.runtime.id : "governworld-extension";
  const redirectUri = `https://${runtimeId}.chromiumapp.org/`;
  let effectiveChallenge = codeChallenge;
  if (!effectiveChallenge) {
    const pkce = await generatePkcePair();
    effectiveChallenge = pkce.codeChallenge;
  }
  const params = new URLSearchParams({
    response_type: "code",
    redirect_uri: redirectUri,
    state,
    client_id: "governworld-extension",
    code_challenge: effectiveChallenge,
    code_challenge_method: "S256",
  });
  return `${baseUrl}/api/v1/extension/auth/authorize?${params.toString()}`;
}

/**
 * Launches the OAuth 2.0 PKCE flow using `chrome.identity.launchWebAuthFlow()`
 * when available, parsing the returned redirect URL for `code` and `state`.
 */
export async function launchOAuthWebFlow(
  authorizeUrl: string,
): Promise<{ ok: true; redirectUrl: string; code: string; state: string } | { ok: false; error: string }> {
  const identityApi =
    typeof chrome !== "undefined"
      ? (chrome as unknown as {
          identity?: {
            launchWebAuthFlow?: (
              details: { url: string; interactive: boolean },
              callback?: (responseUrl?: string) => void,
            ) => Promise<string | undefined> | void;
          };
        }).identity
      : undefined;

  if (!identityApi || typeof identityApi.launchWebAuthFlow !== "function") {
    return { ok: false, error: "chrome.identity.launchWebAuthFlow is unavailable" };
  }

  try {
    const redirectUrl = await new Promise<string | undefined>((resolve, reject) => {
      let settled = false;
      const finish = (url?: string, err?: unknown) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve(url);
      };
      try {
        const maybePromise = identityApi.launchWebAuthFlow!(
          { url: authorizeUrl, interactive: true },
          (responseUrl?: string) => {
            const lastErr =
              typeof chrome !== "undefined" ? chrome.runtime?.lastError : undefined;
            if (lastErr) {
              finish(undefined, new Error(lastErr.message || "OAuth web flow failed"));
            } else {
              finish(responseUrl);
            }
          },
        );
        if (maybePromise && typeof (maybePromise as Promise<string | undefined>).then === "function") {
          void (async () => {
            try {
              const resUrl = await (maybePromise as Promise<string | undefined>);
              finish(resUrl);
            } catch (err) {
              finish(undefined, err);
            }
          })();
        }
      } catch (err) {
        finish(undefined, err);
      }
    });

    if (!redirectUrl) {
      return { ok: false, error: "OAuth flow was cancelled or returned no redirect URL." };
    }

    const parsed = new URL(redirectUrl);
    const errorParam = parsed.searchParams.get("error");
    if (errorParam) {
      return {
        ok: false,
        error: parsed.searchParams.get("error_description") || `OAuth error: ${errorParam}`,
      };
    }

    const code = parsed.searchParams.get("code");
    const state = parsed.searchParams.get("state");
    if (!code || !state) {
      return { ok: false, error: "OAuth redirect URL did not contain authorization code and state." };
    }

    return { ok: true, redirectUrl, code, state };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "OAuth web auth flow failed.",
    };
  }
}

export async function exchangeCodeForTokens(
  client: GovernWorldApiClient,
  code: string,
  codeVerifier?: string
): Promise<{ ok: true; tokens: AuthTokens } | { ok: false; error: string }> {
  const runtimeId =
    typeof chrome !== "undefined" && chrome?.runtime?.id ? chrome.runtime.id : "governworld-extension";
  const redirectUri = `https://${runtimeId}.chromiumapp.org/`;
  const verifier = codeVerifier ?? (await getStoredPkceVerifier()) ?? undefined;
  const payload: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: "governworld-extension",
    ...(verifier ? { code_verifier: verifier } : {}),
  };

  const result = await client.post<AuthTokens>("/api/v1/extension/auth/token", payload);
  await clearStoredPkceVerifier();

  if (!result.ok) {
    return { ok: false, error: result.error.user_message };
  }
  const tokens = result.data;
  const now = Date.now();
  const normalized: AuthTokens = {
    ...tokens,
    expires_at: tokens.expires_at || now + (tokens.expires_in || 3600) * 1000,
  };
  return { ok: true, tokens: normalized };
}
