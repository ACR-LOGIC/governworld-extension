// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import {
  GovernWorldApiClient,
  getApiUrl,
  saveAuthSession,
  performBootstrap,
} from "../api/index.js";
import type { AuthTokens } from "../api/types.js";
import {
  generateOAuthState,
  verifyOAuthState,
  generatePkcePair,
  buildAuthorizeUrl,
  launchOAuthWebFlow,
  exchangeCodeForTokens,
} from "../api/auth.js";
import { buildAccountView } from "../shared/account.js";
import type { PopupFromWorker } from "../shared/types.js";

/**
 * Service Worker OAuth 2.0 + PKCE (RFC 7636) Service (Priority 0, Item 4 & Item 17).
 */

/**
 * Non-secret user identity carried alongside the access token.
 *
 * Read from the JWT `email` claim WITHOUT verifying the signature. That is safe
 * here and only here: the value came over TLS from the gateway we just exchanged a
 * code with, it is displayed, and `canManage` is derived from `tenant.roles` in the
 * bootstrap body rather than from any claim.
 */
export function tokensUserEmail(tokens: AuthTokens): string | null {
  const parts = tokens.access_token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const decoded = atob(payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), "="));
    const claims: unknown = JSON.parse(decoded);
    if (typeof claims !== "object" || claims === null) return null;
    const email = (claims as Record<string, unknown>).email;
    return typeof email === "string" && email.length > 0 && email.length <= 320 ? email : null;
  } catch {
    return null;
  }
}

export interface OAuthServiceCallbacks {
  notifyPopup: (message: PopupFromWorker) => void;
  updateAccountMetadataView: (view: ReturnType<typeof buildAccountView>) => Promise<void>;
  notifyAccountState: (requestId: string) => Promise<void>;
}

export async function runOAuthConnectFlow(
  requestId: string,
  callbacks: OAuthServiceCallbacks
): Promise<void> {
  try {
    const state = await generateOAuthState();
    const pkce = await generatePkcePair();
    const authorizeUrl = await buildAuthorizeUrl(state, pkce.codeChallenge);

    // Prefer chrome.identity.launchWebAuthFlow() with PKCE when available
    if (typeof chrome !== "undefined" && typeof chrome.identity?.launchWebAuthFlow === "function") {
      const flowResult = await launchOAuthWebFlow(authorizeUrl);
      if (flowResult.ok) {
        await runOAuthCallbackFlow(flowResult.code, flowResult.state, requestId, callbacks, pkce.codeVerifier);
        return;
      }
      // If user explicitly cancelled or launchWebAuthFlow reported an error, surface it
      if (flowResult.error && !flowResult.error.includes("not available")) {
        callbacks.notifyPopup({
          type: "POPUP_OAUTH_STATUS",
          requestId,
          connected: false,
          message: flowResult.error,
        });
        return;
      }
    }

    // Fallback to tab-based OAuth redirect flow when chrome.identity.launchWebAuthFlow is unavailable
    await chrome.tabs.create({ url: authorizeUrl });
    callbacks.notifyPopup({
      type: "POPUP_OAUTH_STATUS",
      requestId,
      connected: false,
      message: "OAuth authorization page opened. Complete sign-in to connect.",
    });
  } catch (error) {
    callbacks.notifyPopup({
      type: "POPUP_OAUTH_STATUS",
      requestId,
      connected: false,
      message: error instanceof Error ? error.message : "Failed to start OAuth flow.",
    });
  }
}

export async function runOAuthCallbackFlow(
  code: string,
  state: string,
  requestId: string,
  callbacks: OAuthServiceCallbacks,
  explicitCodeVerifier?: string
): Promise<void> {
  const valid = await verifyOAuthState(state);
  if (!valid) {
    callbacks.notifyPopup({
      type: "POPUP_OAUTH_STATUS",
      requestId,
      connected: false,
      message: "OAuth state mismatch. Connection denied.",
    });
    return;
  }
  const client = new GovernWorldApiClient(await getApiUrl());
  const result = await exchangeCodeForTokens(client, code, explicitCodeVerifier);
  if (!result.ok) {
    callbacks.notifyPopup({
      type: "POPUP_OAUTH_STATUS",
      requestId,
      connected: false,
      message: result.error,
    });
    return;
  }
  const bootstrap = await performBootstrap(client, result.tokens.access_token);
  if (!bootstrap.success || !bootstrap.tenant) {
    callbacks.notifyPopup({
      type: "POPUP_OAUTH_STATUS",
      requestId,
      connected: false,
      message: bootstrap.error ?? "Bootstrap failed after OAuth.",
    });
    return;
  }
  const userEmail = tokensUserEmail(result.tokens);
  await saveAuthSession(result.tokens, {
    connected: true,
    ...(userEmail !== null ? { user_email: userEmail } : {}),
    tenant_id: bootstrap.tenant.tenant_id,
    tenant_name: bootstrap.tenant.tenant_name,
    connected_at: new Date().toISOString(),
  });
  const view = buildAccountView({
    connected: true,
    userEmail,
    tenant: bootstrap.tenant,
    entitlements: bootstrap.entitlements,
    capabilities: bootstrap.capabilities,
  });
  await callbacks.updateAccountMetadataView(view);
  callbacks.notifyPopup({
    type: "POPUP_OAUTH_STATUS",
    requestId,
    connected: true,
    tenantId: bootstrap.tenant.tenant_id,
    tenantName: bootstrap.tenant.tenant_name,
    apiUrl: await getApiUrl(),
    capabilities: bootstrap.capabilities ?? [],
  });
  await callbacks.notifyAccountState(requestId);
}
