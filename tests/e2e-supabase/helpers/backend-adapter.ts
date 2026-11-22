// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
/**
 * Unified backend adapter for `--mode=mock` and `--mode=live` E2E verification.
 * Tracks all ephemeral `e2e-test-*` organisations and users and guarantees cleanup.
 */

import { randomUUID } from "node:crypto";
import type { PolicyRule } from "../../../src/api/types.js";
import type { ManagedPolicyEnvelope, ManagedPolicySettings } from "../../../src/shared/managedPolicy.js";
import {
  startMockSupabaseServer,
  type MockSupabaseServer,
} from "./mock-supabase-server.js";

export type E2eMode = "mock" | "live";

export interface HttpResult<T = Record<string, unknown>> {
  status: number;
  ok: boolean;
  data: T;
  rawText: string;
}

export interface TestOrgContext {
  organisationId: string;
  organisationName: string;
  primaryAdminJwt: string;
  seatIds: string[];
}

export interface CreateTestOrgOptions {
  namePrefix?: string;
  seatLimit?: number;
  initialPolicy?: {
    rules?: PolicyRule[];
    settings?: ManagedPolicySettings;
  };
}

export interface BackendAdapter {
  readonly mode: E2eMode;
  readonly baseUrl: string;
  readonly publishableKey: string;
  readonly mockServer: MockSupabaseServer | null;
  getDefaultAdminJwt(): Promise<string>;
  createTestOrg(opts?: CreateTestOrgOptions): Promise<TestOrgContext>;
  generatePairingCode(
    orgId: string,
    opts?: { seatId?: string; groupId?: string; adminJwt?: string },
  ): Promise<HttpResult<{ ok: boolean; code?: string; code_id?: string; seat_id?: string; expires_at?: string; error?: string }>>;
  redeemPairingCode(
    code: string,
    installationId: string,
  ): Promise<
    HttpResult<{
      ok: boolean;
      organisation_id?: string;
      organisation_name?: string;
      seat_id?: string;
      unlocked?: boolean;
      seat_session_token?: string;
      session_expires_at?: string;
      policy_envelope?: ManagedPolicyEnvelope | null;
      policy_version?: number;
      error?: string;
    }>
  >;
  deliverPolicy(
    seatSessionToken: string,
    installationId: string,
  ): Promise<
    HttpResult<{
      ok: boolean;
      status?: string;
      organisation_id?: string;
      organisation_name?: string;
      seat_id?: string;
      unlocked?: boolean;
      policy_version?: number;
      policy_envelope?: ManagedPolicyEnvelope | null;
      error?: string;
    }>
  >;
  sendHeartbeat(
    seatSessionToken: string,
    payload: Record<string, unknown>,
  ): Promise<HttpResult<{ ok: boolean; received_at?: string; unlocked?: boolean; policy_version?: number; status?: string; error?: string }>>;
  rotateSession(
    seatSessionToken: string,
    installationId: string,
  ): Promise<HttpResult<{ ok: boolean; seat_session_token?: string; session_expires_at?: string; status?: string; error?: string }>>;
  unpairSeat(
    seatSessionToken: string,
    installationId: string,
  ): Promise<HttpResult<{ ok: boolean; status?: string; error?: string }>>;
  upsertPolicy(
    orgId: string,
    policy: {
      scopeType?: "org" | "group" | "seat";
      scopeId?: string;
      rules?: PolicyRule[];
      settings?: ManagedPolicySettings;
    },
    adminJwt?: string,
  ): Promise<HttpResult>;
  createGroup(orgId: string, name: string, adminJwt?: string): Promise<HttpResult<{ ok: boolean; group?: { id: string; name: string }; error?: string }>>;
  assignSeatToGroup(orgId: string, seatId: string, groupId: string | null, adminJwt?: string): Promise<HttpResult>;
  setSeatUnlocked(orgId: string, seatId: string, unlocked: boolean, adminJwt?: string): Promise<HttpResult>;
  revokeSeat(orgId: string, seatId: string, adminJwt?: string): Promise<HttpResult>;
  issueAdminGrant(
    orgId: string,
    grant: { email: string; permissionSet: string[]; groupIds?: string[] },
    adminJwt?: string,
  ): Promise<
    HttpResult<{
      ok: boolean;
      grant_id?: string;
      admin_id?: string;
      email?: string;
      temp_password?: string;
      expires_at?: string;
      admin_jwt?: string;
      error?: string;
    }>
  >;
  loginAdmin(
    email: string,
    password: string,
  ): Promise<HttpResult<{ ok: boolean; admin_jwt?: string; admin_id?: string; must_change_password?: boolean; error?: string }>>;
  changeAdminPassword(adminJwt: string, newPassword: string): Promise<HttpResult>;
  updateAdminGrant(
    orgId: string,
    grantId: string,
    updates: { permissionSet?: string[]; groupIds?: string[] },
    adminJwt?: string,
  ): Promise<HttpResult>;
  revokeAdminGrant(orgId: string, grantId: string, adminJwt?: string): Promise<HttpResult>;
  attemptSelfEscalate(orgId: string, adminJwt: string, targetPermissions: string[]): Promise<HttpResult>;
  deleteOrganisation(orgId: string, adminJwt?: string): Promise<HttpResult>;
  getAuditLogs(orgId: string, adminJwt?: string): Promise<HttpResult<{ ok: boolean; logs?: unknown[]; error?: string }>>;
  probeDirectRest(
    tablePath: string,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    opts?: { authBearer?: string; seatSession?: string; body?: unknown; query?: string; useServiceRole?: boolean },
  ): Promise<HttpResult<unknown>>;
  trackCreatedUser(userId: string): void;
  cleanup(): Promise<void>;
}

const DEFAULT_SUPABASE_URL = "https://lkgcehdwasewwoieyoip.supabase.co";
const DEFAULT_PUBLISHABLE_KEY = "sb_publishable_BCVFc4dLjWcJIUaXlnv_IQ_F5usIS-C";

function decodeJwtSub(jwt: string): string | null {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) return null;
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const json = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
    return typeof json.sub === "string" ? json.sub : null;
  } catch {
    return null;
  }
}

async function doFetchJson<T = Record<string, unknown>>(
  url: string,
  init: RequestInit,
): Promise<HttpResult<T>> {
  const res = await fetch(url, init);
  const rawText = await res.text();
  let parsed: unknown = {};
  if (rawText.trim().length > 0) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = { raw: rawText };
    }
  }
  return {
    status: res.status,
    ok: res.ok,
    data: parsed as T,
    rawText,
  };
}

export async function createBackendAdapter(explicitMode?: E2eMode): Promise<BackendAdapter> {
  const envMode = process.env.GW_SUPABASE_E2E_MODE === "live" ? "live" : "mock";
  const mode: E2eMode = explicitMode ?? envMode;

  let mockServer: MockSupabaseServer | null = null;
  let ownsMockServer = false;
  let baseUrl: string;
  const publishableKey = (process.env.GW_SUPABASE_PUBLISHABLE_KEY || "").trim() || DEFAULT_PUBLISHABLE_KEY;
  const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

  if (mode === "mock") {
    mockServer = await startMockSupabaseServer();
    ownsMockServer = true;
    baseUrl = mockServer.url;
  } else {
    baseUrl = ((process.env.GW_SUPABASE_URL || "").trim() || DEFAULT_SUPABASE_URL).replace(/\/+$/, "");
  }

  let cachedLiveJwt: string | null = (process.env.GW_E2E_ADMIN_JWT || "").trim() || null;
  const trackedOrgs = new Map<string, string>(); // orgId -> adminJwt
  const trackedUsers = new Set<string>();
  const runTag = randomUUID().slice(0, 8);

  async function getDefaultAdminJwt(): Promise<string> {
    if (mode === "mock") {
      const seeded = mockServer!.seedOrganisation({ name: `e2e-test-default-${runTag}` });
      trackedOrgs.set(seeded.organisation.id, seeded.primaryAdminJwt);
      return seeded.primaryAdminJwt;
    }
    if (cachedLiveJwt) return cachedLiveJwt;
    const email = (process.env.GW_E2E_ADMIN_EMAIL || "").trim();
    const password = (process.env.GW_E2E_ADMIN_PASSWORD || "").trim();
    if (!email || !password) {
      throw new Error(
        "FAIL-CLOSED: --mode=live requires GW_E2E_ADMIN_JWT or both GW_E2E_ADMIN_EMAIL and GW_E2E_ADMIN_PASSWORD.",
      );
    }
    const authRes = await doFetchJson<{ access_token?: string; error_description?: string }>(
      `${baseUrl}/auth/v1/token?grant_type=password`,
      {
        method: "POST",
        headers: {
          apikey: publishableKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({ email, password }),
      },
    );
    if (!authRes.ok || !authRes.data.access_token) {
      throw new Error(
        `FAIL-CLOSED: Live admin login failed (${authRes.status}): ${authRes.data.error_description ?? authRes.rawText}`,
      );
    }
    cachedLiveJwt = authRes.data.access_token;
    return cachedLiveJwt;
  }

  function resolveOrgJwt(orgId: string, explicitJwt?: string): string {
    if (explicitJwt) return explicitJwt;
    const stored = trackedOrgs.get(orgId);
    if (stored) return stored;
    if (cachedLiveJwt) return cachedLiveJwt;
    throw new Error(`No admin JWT available for organisation ${orgId}`);
  }

  async function callFunction<T = Record<string, unknown>>(
    fnName: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<HttpResult<T>> {
    return await doFetchJson<T>(`${baseUrl}/functions/v1/${fnName}`, {
      method: "POST",
      headers: {
        apikey: publishableKey,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  return {
    mode,
    baseUrl,
    publishableKey,
    mockServer,

    getDefaultAdminJwt,

    async createTestOrg(opts: CreateTestOrgOptions = {}): Promise<TestOrgContext> {
      const prefix = opts.namePrefix ?? "e2e-test";
      const orgName = `${prefix}-${runTag}-${randomUUID().slice(0, 6)}`;
      const seatLimit = opts.seatLimit ?? 5;

      if (mode === "mock") {
        const seeded = mockServer!.seedOrganisation({
          name: orgName,
          seatLimit,
          initialPolicy: opts.initialPolicy,
        });
        trackedOrgs.set(seeded.organisation.id, seeded.primaryAdminJwt);
        return {
          organisationId: seeded.organisation.id,
          organisationName: seeded.organisation.name,
          primaryAdminJwt: seeded.primaryAdminJwt,
          seatIds: seeded.seats.map((s) => s.id),
        };
      }

      const adminJwt = await getDefaultAdminJwt();
      if (serviceRoleKey) {
        const orgRes = await doFetchJson<Array<{ id: string; name: string }>>(
          `${baseUrl}/rest/v1/organisations`,
          {
            method: "POST",
            headers: {
              apikey: serviceRoleKey,
              authorization: `Bearer ${serviceRoleKey}`,
              "content-type": "application/json",
              prefer: "return=representation",
            },
            body: JSON.stringify({
              name: orgName,
              slug: orgName.toLowerCase().replace(/[^a-z0-9-]+/g, "-"),
              seat_limit: seatLimit,
              owner_backend: "supabase",
            }),
          },
        );
        if (!orgRes.ok || !Array.isArray(orgRes.data) || orgRes.data.length === 0) {
          throw new Error(`Failed to create live test org (${orgRes.status}): ${orgRes.rawText}`);
        }
        const org = orgRes.data[0];
        trackedOrgs.set(org.id, adminJwt);

        const userId = decodeJwtSub(adminJwt);
        if (userId) {
          await doFetchJson(`${baseUrl}/rest/v1/admins`, {
            method: "POST",
            headers: {
              apikey: serviceRoleKey,
              authorization: `Bearer ${serviceRoleKey}`,
              "content-type": "application/json",
              prefer: "return=minimal",
            },
            body: JSON.stringify({
              organisation_id: org.id,
              user_id: userId,
              email: (process.env.GW_E2E_ADMIN_EMAIL || "").trim() || `admin-${runTag}@example.test`,
              role: "primary",
              is_primary: true,
              permission_set: [
                "policy.write",
                "seat.unlock",
                "code.manage",
                "group.manage",
                "audit.read",
                "admin.grant",
              ],
            }),
          });
        }

        const seatRows = Array.from({ length: seatLimit }, (_, idx) => ({
          organisation_id: org.id,
          label: `seat-${idx + 1}`,
          status: "available",
          unlocked: false,
        }));
        const seatsRes = await doFetchJson<Array<{ id: string }>>(`${baseUrl}/rest/v1/seats`, {
          method: "POST",
          headers: {
            apikey: serviceRoleKey,
            authorization: `Bearer ${serviceRoleKey}`,
            "content-type": "application/json",
            prefer: "return=representation",
          },
          body: JSON.stringify(seatRows),
        });
        const seatIds = Array.isArray(seatsRes.data) ? seatsRes.data.map((s) => s.id) : [];

        if (opts.initialPolicy) {
          await callFunction(
            "admin-ops",
            {
              action: "policy.upsert",
              organisation_id: org.id,
              scope_type: "org",
              scope_id: org.id,
              rules: opts.initialPolicy.rules ?? [],
              settings: opts.initialPolicy.settings ?? {},
            },
            { authorization: `Bearer ${adminJwt}` },
          );
        }

        return {
          organisationId: org.id,
          organisationName: org.name,
          primaryAdminJwt: adminJwt,
          seatIds,
        };
      }

      // Fallback in live mode without service role key: use admin-ops org.create
      const createRes = await callFunction<{
        ok: boolean;
        organisation?: { id: string; name: string };
        seats?: Array<{ id: string }>;
        error?: string;
      }>(
        "admin-ops",
        {
          action: "org.create",
          name: orgName,
          seat_limit: seatLimit,
        },
        { authorization: `Bearer ${adminJwt}` },
      );
      if (!createRes.ok || !createRes.data.organisation) {
        throw new Error(
          `FAIL-CLOSED: Unable to create live test org (${createRes.status}): ${createRes.data.error ?? createRes.rawText}`,
        );
      }
      const org = createRes.data.organisation;
      trackedOrgs.set(org.id, adminJwt);

      if (opts.initialPolicy) {
        await callFunction(
          "admin-ops",
          {
            action: "policy.upsert",
            organisation_id: org.id,
            scope_type: "org",
            scope_id: org.id,
            rules: opts.initialPolicy.rules ?? [],
            settings: opts.initialPolicy.settings ?? {},
          },
          { authorization: `Bearer ${adminJwt}` },
        );
      }

      return {
        organisationId: org.id,
        organisationName: org.name,
        primaryAdminJwt: adminJwt,
        seatIds: (createRes.data.seats ?? []).map((s) => s.id),
      };
    },

    async generatePairingCode(orgId, opts = {}) {
      const jwt = resolveOrgJwt(orgId, opts.adminJwt);
      return await callFunction(
        "pairing-code-generate",
        {
          organisation_id: orgId,
          seat_id: opts.seatId ?? null,
          group_id: opts.groupId ?? null,
        },
        { authorization: `Bearer ${jwt}` },
      );
    },

    async redeemPairingCode(code, installationId) {
      return await callFunction("pairing-code-redeem", {
        code,
        installation_id: installationId,
      });
    },

    async deliverPolicy(seatSessionToken, installationId) {
      return await callFunction(
        "policy-deliver",
        { installation_id: installationId },
        {
          "x-seat-session": seatSessionToken,
          authorization: `Bearer ${seatSessionToken}`,
        },
      );
    },

    async sendHeartbeat(seatSessionToken, payload) {
      return await callFunction("heartbeat-ingest", payload, {
        "x-seat-session": seatSessionToken,
        authorization: `Bearer ${seatSessionToken}`,
      });
    },

    async rotateSession(seatSessionToken, installationId) {
      return await callFunction(
        "session-rotate",
        { installation_id: installationId },
        {
          "x-seat-session": seatSessionToken,
          authorization: `Bearer ${seatSessionToken}`,
        },
      );
    },

    async unpairSeat(seatSessionToken, installationId) {
      return await callFunction(
        "seat-unpair",
        { installation_id: installationId },
        {
          "x-seat-session": seatSessionToken,
          authorization: `Bearer ${seatSessionToken}`,
        },
      );
    },

    async upsertPolicy(orgId, policy, adminJwt) {
      const jwt = resolveOrgJwt(orgId, adminJwt);
      return await callFunction(
        "admin-ops",
        {
          action: "policy.upsert",
          organisation_id: orgId,
          scope_type: policy.scopeType ?? "org",
          scope_id: policy.scopeId ?? orgId,
          rules: policy.rules ?? [],
          settings: policy.settings ?? {},
        },
        { authorization: `Bearer ${jwt}` },
      );
    },

    async createGroup(orgId, name, adminJwt) {
      const jwt = resolveOrgJwt(orgId, adminJwt);
      return await callFunction(
        "admin-ops",
        { action: "group.create", organisation_id: orgId, name },
        { authorization: `Bearer ${jwt}` },
      );
    },

    async assignSeatToGroup(orgId, seatId, groupId, adminJwt) {
      const jwt = resolveOrgJwt(orgId, adminJwt);
      return await callFunction(
        "admin-ops",
        { action: "group.assign_seat", organisation_id: orgId, seat_id: seatId, group_id: groupId },
        { authorization: `Bearer ${jwt}` },
      );
    },

    async setSeatUnlocked(orgId, seatId, unlocked, adminJwt) {
      const jwt = resolveOrgJwt(orgId, adminJwt);
      return await callFunction(
        "admin-ops",
        {
          action: unlocked ? "seat.unlock" : "seat.lock",
          organisation_id: orgId,
          seat_id: seatId,
        },
        { authorization: `Bearer ${jwt}` },
      );
    },

    async revokeSeat(orgId, seatId, adminJwt) {
      const jwt = resolveOrgJwt(orgId, adminJwt);
      return await callFunction(
        "admin-ops",
        { action: "seat.revoke", organisation_id: orgId, seat_id: seatId },
        { authorization: `Bearer ${jwt}` },
      );
    },

    async issueAdminGrant(orgId, grant, adminJwt) {
      const jwt = resolveOrgJwt(orgId, adminJwt);
      const res = await callFunction<{
        ok: boolean;
        grant_id?: string;
        admin_id?: string;
        email?: string;
        temp_password?: string;
        expires_at?: string;
        admin_jwt?: string;
        error?: string;
      }>(
        "admin-grant-manage",
        {
          action: "issue",
          organisation_id: orgId,
          email: grant.email,
          permission_set: grant.permissionSet,
          group_ids: grant.groupIds ?? [],
        },
        { authorization: `Bearer ${jwt}` },
      );
      if (res.ok && res.data.admin_id) {
        trackedUsers.add(res.data.admin_id);
      }
      return res;
    },

    async loginAdmin(email, password) {
      if (mode === "mock") {
        return await callFunction("admin-grant-manage", {
          action: "login",
          email,
          password,
        });
      }
      const res = await doFetchJson<{ access_token?: string; user?: { id: string }; error_description?: string }>(
        `${baseUrl}/auth/v1/token?grant_type=password`,
        {
          method: "POST",
          headers: { apikey: publishableKey, "content-type": "application/json" },
          body: JSON.stringify({ email, password }),
        },
      );
      return {
        status: res.status,
        ok: res.ok,
        rawText: res.rawText,
        data: {
          ok: res.ok,
          admin_jwt: res.data.access_token,
          admin_id: res.data.user?.id,
          error: res.data.error_description,
        },
      };
    },

    async changeAdminPassword(adminJwt, newPassword) {
      return await callFunction(
        "admin-grant-manage",
        { action: "change_password", new_password: newPassword },
        { authorization: `Bearer ${adminJwt}` },
      );
    },

    async updateAdminGrant(orgId, grantId, updates, adminJwt) {
      const jwt = resolveOrgJwt(orgId, adminJwt);
      return await callFunction(
        "admin-grant-manage",
        {
          action: "update",
          organisation_id: orgId,
          grant_id: grantId,
          permission_set: updates.permissionSet,
          group_ids: updates.groupIds,
        },
        { authorization: `Bearer ${jwt}` },
      );
    },

    async revokeAdminGrant(orgId, grantId, adminJwt) {
      const jwt = resolveOrgJwt(orgId, adminJwt);
      return await callFunction(
        "admin-grant-manage",
        { action: "revoke", organisation_id: orgId, grant_id: grantId },
        { authorization: `Bearer ${jwt}` },
      );
    },

    async attemptSelfEscalate(orgId, adminJwt, targetPermissions) {
      return await callFunction(
        "admin-ops",
        {
          action: "admin.self_escalate",
          organisation_id: orgId,
          permission_set: targetPermissions,
        },
        { authorization: `Bearer ${adminJwt}` },
      );
    },

    async deleteOrganisation(orgId, adminJwt) {
      const jwt = resolveOrgJwt(orgId, adminJwt);
      return await callFunction(
        "admin-ops",
        { action: "org.delete", organisation_id: orgId },
        { authorization: `Bearer ${jwt}` },
      );
    },

    async getAuditLogs(orgId, adminJwt) {
      const jwt = resolveOrgJwt(orgId, adminJwt);
      return await callFunction(
        "admin-ops",
        { action: "audit.read", organisation_id: orgId },
        { authorization: `Bearer ${jwt}` },
      );
    },

    async probeDirectRest(tablePath, method, opts = {}) {
      const cleanPath = tablePath.replace(/^\/+/, "");
      const querySuffix = opts.query ? `?${opts.query.replace(/^\?/, "")}` : "";
      const headers: Record<string, string> = {
        apikey: opts.useServiceRole && serviceRoleKey ? serviceRoleKey : publishableKey,
        "content-type": "application/json",
      };
      if (opts.useServiceRole && serviceRoleKey) {
        headers.authorization = `Bearer ${serviceRoleKey}`;
      } else if (opts.authBearer) {
        headers.authorization = `Bearer ${opts.authBearer}`;
      }
      if (opts.seatSession) {
        headers["x-seat-session"] = opts.seatSession;
      }

      return await doFetchJson<unknown>(`${baseUrl}/rest/v1/${cleanPath}${querySuffix}`, {
        method,
        headers,
        body: opts.body !== undefined && method !== "GET" ? JSON.stringify(opts.body) : undefined,
      });
    },

    trackCreatedUser(userId: string) {
      trackedUsers.add(userId);
    },

    async cleanup() {
      for (const [orgId, jwt] of trackedOrgs.entries()) {
        try {
          if (mode === "mock") {
            await callFunction(
              "admin-ops",
              { action: "org.delete", organisation_id: orgId },
              { authorization: `Bearer ${jwt}` },
            );
          } else {
            await callFunction(
              "admin-ops",
              { action: "org.delete", organisation_id: orgId },
              { authorization: `Bearer ${jwt}` },
            );
            if (serviceRoleKey) {
              await doFetchJson(`${baseUrl}/rest/v1/organisations?id=eq.${encodeURIComponent(orgId)}`, {
                method: "DELETE",
                headers: {
                  apikey: serviceRoleKey,
                  authorization: `Bearer ${serviceRoleKey}`,
                },
              });
            }
          }
        } catch {
          // Best-effort cleanup per tracked org
        }
      }
      trackedOrgs.clear();

      if (mode === "live" && serviceRoleKey) {
        for (const userId of trackedUsers) {
          try {
            await doFetchJson(`${baseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
              method: "DELETE",
              headers: {
                apikey: serviceRoleKey,
                authorization: `Bearer ${serviceRoleKey}`,
              },
            });
          } catch {
            // Best-effort cleanup per tracked user
          }
        }
      }
      trackedUsers.clear();

      if (ownsMockServer && mockServer) {
        await mockServer.close();
        mockServer = null;
      }
    },
  };
}
