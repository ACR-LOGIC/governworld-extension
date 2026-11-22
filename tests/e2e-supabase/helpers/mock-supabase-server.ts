// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
/**
 * Stateful in-process Section 7.1 mock Supabase server for `--mode=mock` E2E tests.
 * Generates an ephemeral Ed25519 keypair at startup and signs ManagedPolicyEnvelopes
 * using the exact canonicalization and SHA-256 hash format of `src/shared/managedPolicy.ts`.
 */

import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { PolicyRule } from "../../../src/api/types.js";
import {
  canonicalizeManagedPolicyEnvelope,
  computeManagedPolicyContentHash,
  type ManagedPolicyEnvelope,
  type ManagedPolicySettings,
} from "../../../src/shared/managedPolicy.js";

export type FaultMode =
  | "none"
  | "500"
  | "503"
  | "401"
  | "403"
  | "network_error"
  | "invalid_signature"
  | "expired_policy"
  | "downgrade_policy";

export interface OrgRecord {
  id: string;
  name: string;
  slug: string;
  seat_limit: number;
  owner_backend: "supabase";
  deleted_at: string | null;
  created_at: string;
}

export interface SeatRecord {
  id: string;
  organisation_id: string;
  group_id: string | null;
  label: string;
  status: "available" | "active" | "revoked";
  installation_id: string | null;
  unlocked: boolean;
  last_heartbeat_at: string | null;
  paired_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface PairingCodeRecord {
  id: string;
  organisation_id: string;
  seat_id: string | null;
  group_id: string | null;
  code_hash: string;
  expires_at: string;
  used_at: string | null;
  failed_attempts: number;
  burned_at: string | null;
  created_at: string;
}

export interface SeatSessionRecord {
  token_hash: string;
  seat_id: string;
  organisation_id: string;
  installation_id: string;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}

export interface GroupRecord {
  id: string;
  organisation_id: string;
  name: string;
  created_at: string;
}

export interface PolicyRecord {
  id: string;
  organisation_id: string;
  scope_type: "org" | "group" | "seat";
  scope_id: string;
  version: number;
  rules: PolicyRule[];
  settings: ManagedPolicySettings;
  updated_at: string;
  created_at: string;
}

export interface AdminRecord {
  id: string;
  organisation_id: string;
  email: string;
  role: "primary" | "granted";
  is_primary: boolean;
  permission_set: string[];
  must_change_password: boolean;
  password_hash: string;
  disabled_at: string | null;
  created_at: string;
}

export interface AdminGrantRecord {
  id: string;
  organisation_id: string;
  admin_id: string;
  email: string;
  permission_set: string[];
  temp_password_hash: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  created_by: string;
  created_at: string;
}

export interface AdminGroupRecord {
  id: string;
  organisation_id: string;
  admin_id: string;
  group_id: string;
}

export interface AuditLogRecord {
  id: string;
  organisation_id: string;
  actor_id: string;
  actor_type: "admin" | "seat" | "system";
  action: string;
  target_type: string;
  target_id: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface HeartbeatRecord {
  seat_id: string;
  installation_id: string;
  organisation_id: string;
  extension_version: string;
  browser_name: string;
  browser_version: string;
  platform: string;
  policy_version: number;
  policy_status: string;
  health_status: string;
  timestamp: string;
  reported_policy: Record<string, unknown> | null;
  received_at: string;
}

export interface MockDbState {
  organisations: Map<string, OrgRecord>;
  seats: Map<string, SeatRecord>;
  pairing_codes: Map<string, PairingCodeRecord>;
  seat_sessions: Map<string, SeatSessionRecord>;
  groups: Map<string, GroupRecord>;
  policies: Map<string, PolicyRecord>;
  admins: Map<string, AdminRecord>;
  admin_grants: Map<string, AdminGrantRecord>;
  admin_groups: Map<string, AdminGroupRecord>;
  audit_log: AuditLogRecord[];
  heartbeat_state: Map<string, HeartbeatRecord>;
  installation_failures: Map<string, { count: number; coolingOffUntilMs: number }>;
  admin_tokens: Map<string, string>;
  server_logs: string[];
}

export interface SeedOrgOptions {
  id?: string;
  name?: string;
  seatLimit?: number;
  primaryEmail?: string;
  primaryPassword?: string;
  initialPolicy?: {
    rules?: PolicyRule[];
    settings?: ManagedPolicySettings;
  };
}

export interface SeededOrgResult {
  organisation: OrgRecord;
  primaryAdmin: AdminRecord;
  primaryAdminJwt: string;
  seats: SeatRecord[];
}

export interface MockSupabaseServer {
  url: string;
  port: number;
  state: MockDbState;
  close(): Promise<void>;
  setClockOffsetMs(offsetMs: number): void;
  advanceClockMs(deltaMs: number): void;
  getClockNowMs(): number;
  setFault(endpoint: string, mode: FaultMode): void;
  clearFaults(): void;
  expireCode(codeId: string): void;
  burnCode(codeId: string): void;
  expireGrant(grantId: string): void;
  getSigningPublicJwk(): JsonWebKey;
  signPolicyEnvelope(
    unsignedEnvelope: Omit<ManagedPolicyEnvelope, "policy_signature" | "signature_algorithm" | "policy_hash">,
    overridePrivateKey?: CryptoKey,
  ): Promise<ManagedPolicyEnvelope>;
  getAuditLogs(orgId?: string): AuditLogRecord[];
  getHeartbeatState(seatId: string): HeartbeatRecord | undefined;
  getRawDbState(): {
    pairingCodes: PairingCodeRecord[];
    auditLog: AuditLogRecord[];
    serverLogs: string[];
    organisations: OrgRecord[];
    seats: SeatRecord[];
    heartbeatState: HeartbeatRecord[];
  };
  seedOrganisation(opts?: SeedOrgOptions): SeededOrgResult;
}

const SECTION_5_HEARTBEAT_KEYS = new Set([
  "seat_id",
  "installation_id",
  "organisation_id",
  "extension_version",
  "browser_name",
  "browser_version",
  "platform",
  "policy_version",
  "policy_status",
  "health_status",
  "timestamp",
  "reported_policy",
]);

const GENERIC_REDEEM_ERROR = "That code could not be accepted";
const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
const SEAT_SESSION_TTL_MS = 4 * 60 * 60 * 1000;
const ADMIN_GRANT_TTL_MS = 72 * 60 * 60 * 1000;
const COOLING_OFF_MS = 15 * 60 * 1000;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function randomSecretToken(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("hex")}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, apikey, content-type, x-seat-session, x-client-info",
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  });
  res.end(body);
}

function extractBearer(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return null;
}

function extractSeatSessionToken(req: IncomingMessage): string | null {
  const seatHeader = req.headers["x-seat-session"];
  if (typeof seatHeader === "string" && seatHeader.trim().length > 0) {
    return seatHeader.trim();
  }
  return extractBearer(req);
}

export async function startMockSupabaseServer(): Promise<MockSupabaseServer> {
  const keyPair = (await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  publicJwk.key_ops = ["verify"];

  let clockOffsetMs = 0;
  const faults = new Map<string, FaultMode>();

  const state: MockDbState = {
    organisations: new Map(),
    seats: new Map(),
    pairing_codes: new Map(),
    seat_sessions: new Map(),
    groups: new Map(),
    policies: new Map(),
    admins: new Map(),
    admin_grants: new Map(),
    admin_groups: new Map(),
    audit_log: [],
    heartbeat_state: new Map(),
    installation_failures: new Map(),
    admin_tokens: new Map(),
    server_logs: [],
  };

  function nowMs(): number {
    return Date.now() + clockOffsetMs;
  }

  function nowIso(deltaMs = 0): string {
    return new Date(nowMs() + deltaMs).toISOString();
  }

  function appendAudit(entry: Omit<AuditLogRecord, "id" | "created_at">): void {
    state.audit_log.push({
      id: randomUUID(),
      created_at: nowIso(),
      ...entry,
    });
  }

  function logSafe(message: string): void {
    state.server_logs.push(`[${nowIso()}] ${message}`);
  }

  async function signPolicyEnvelope(
    unsignedEnvelope: Omit<ManagedPolicyEnvelope, "policy_signature" | "signature_algorithm" | "policy_hash">,
    overridePrivateKey?: CryptoKey,
  ): Promise<ManagedPolicyEnvelope> {
    const policy_hash = await computeManagedPolicyContentHash(
      unsignedEnvelope.rules,
      unsignedEnvelope.settings,
    );
    const withHash = {
      ...unsignedEnvelope,
      policy_hash,
    };
    const canonical = canonicalizeManagedPolicyEnvelope(withHash);
    const sigBuffer = await crypto.subtle.sign(
      { name: "Ed25519" },
      overridePrivateKey ?? keyPair.privateKey,
      new TextEncoder().encode(canonical),
    );
    return {
      ...withHash,
      policy_signature: bytesToBase64(new Uint8Array(sigBuffer)),
      signature_algorithm: "Ed25519",
    };
  }

  function resolveEffectivePolicyRecord(seat: SeatRecord): PolicyRecord | null {
    let seatPolicy: PolicyRecord | null = null;
    let groupPolicy: PolicyRecord | null = null;
    let orgPolicy: PolicyRecord | null = null;

    for (const p of state.policies.values()) {
      if (p.organisation_id !== seat.organisation_id) continue;
      if (p.scope_type === "seat" && p.scope_id === seat.id) {
        if (!seatPolicy || p.version >= seatPolicy.version) seatPolicy = p;
      } else if (p.scope_type === "group" && seat.group_id && p.scope_id === seat.group_id) {
        if (!groupPolicy || p.version >= groupPolicy.version) groupPolicy = p;
      } else if (p.scope_type === "org" && p.scope_id === seat.organisation_id) {
        if (!orgPolicy || p.version >= orgPolicy.version) orgPolicy = p;
      }
    }

    return seatPolicy ?? groupPolicy ?? orgPolicy;
  }

  async function buildSignedEnvelopeForSeat(
    org: OrgRecord,
    seat: SeatRecord,
    installationId: string,
    faultMode: FaultMode,
  ): Promise<ManagedPolicyEnvelope | null> {
    const policy = resolveEffectivePolicyRecord(seat);
    if (!policy) return null;

    const version =
      faultMode === "downgrade_policy" ? Math.max(1, policy.version - 1) : policy.version;
    const expiresAt =
      faultMode === "expired_policy" ? nowIso(-60_000) : nowIso(24 * 60 * 60 * 1000);

    const envelope = await signPolicyEnvelope({
      policy_id: policy.id,
      organization_id: org.id,
      organization_name: org.name,
      target: {
        organization_id: org.id,
        employee_id: seat.id,
        device_id: installationId,
      },
      policy_version: version,
      schema_version: "1.2",
      effective_at: policy.updated_at,
      expires_at: expiresAt,
      created_at: policy.created_at,
      nonce: randomUUID(),
      rules: policy.rules,
      settings: policy.settings,
    });

    if (faultMode === "invalid_signature") {
      const roguePair = (await crypto.subtle.generateKey(
        { name: "Ed25519" },
        true,
        ["sign", "verify"],
      )) as CryptoKeyPair;
      return await signPolicyEnvelope(
        {
          policy_id: envelope.policy_id,
          organization_id: envelope.organization_id,
          organization_name: envelope.organization_name,
          target: envelope.target,
          policy_version: envelope.policy_version,
          schema_version: envelope.schema_version,
          effective_at: envelope.effective_at,
          expires_at: envelope.expires_at,
          created_at: envelope.created_at,
          nonce: envelope.nonce,
          rules: envelope.rules,
          settings: envelope.settings,
        },
        roguePair.privateKey,
      );
    }

    return envelope;
  }

  function authenticateAdmin(req: IncomingMessage): {
    admin: AdminRecord | null;
    errorStatus?: number;
    errorMessage?: string;
  } {
    const bearer = extractBearer(req);
    if (!bearer) {
      return { admin: null, errorStatus: 401, errorMessage: "Missing admin authorization" };
    }
    const adminId = state.admin_tokens.get(bearer);
    if (!adminId) {
      return { admin: null, errorStatus: 401, errorMessage: "Invalid admin token" };
    }
    const admin = state.admins.get(adminId) ?? null;
    if (!admin || admin.disabled_at !== null) {
      return { admin: null, errorStatus: 403, errorMessage: "Admin account disabled" };
    }
    const org = state.organisations.get(admin.organisation_id);
    if (!org || org.deleted_at !== null) {
      return { admin: null, errorStatus: 403, errorMessage: "Organisation not found" };
    }
    if (!admin.is_primary) {
      for (const grant of state.admin_grants.values()) {
        if (grant.admin_id === admin.id) {
          if (grant.revoked_at !== null) {
            return { admin: null, errorStatus: 403, errorMessage: "Admin grant revoked" };
          }
          if (admin.must_change_password && nowMs() > Date.parse(grant.expires_at)) {
            return { admin: null, errorStatus: 403, errorMessage: "Temporary password grant expired" };
          }
        }
      }
    }
    return { admin };
  }

  function getAdminGroupIds(adminId: string): string[] {
    const ids: string[] = [];
    for (const ag of state.admin_groups.values()) {
      if (ag.admin_id === adminId) ids.push(ag.group_id);
    }
    return ids;
  }

  function adminHasPermission(admin: AdminRecord, perm: string): boolean {
    return admin.is_primary || admin.permission_set.includes(perm);
  }

  function authenticateSeatSession(
    req: IncomingMessage,
    installationId?: string,
  ): {
    session: SeatSessionRecord | null;
    seat: SeatRecord | null;
    org: OrgRecord | null;
    status: number;
    error: string;
  } {
    const rawCred = extractSeatSessionToken(req);
    if (!rawCred) {
      return { session: null, seat: null, org: null, status: 401, error: "Missing seat session" };
    }
    const tokenHash = sha256Hex(rawCred);
    const session = state.seat_sessions.get(tokenHash) ?? null;
    if (!session || session.revoked_at !== null) {
      return { session: null, seat: null, org: null, status: 401, error: "Invalid or rotated seat session" };
    }
    if (nowMs() > Date.parse(session.expires_at)) {
      return { session: null, seat: null, org: null, status: 401, error: "Seat session expired" };
    }
    if (installationId && installationId !== session.installation_id) {
      return { session: null, seat: null, org: null, status: 401, error: "Installation mismatch" };
    }
    const seat = state.seats.get(session.seat_id) ?? null;
    const org = state.organisations.get(session.organisation_id) ?? null;
    if (!seat || !org) {
      return { session: null, seat: null, org: null, status: 401, error: "Seat or org not found" };
    }
    return { session, seat, org, status: 200, error: "" };
  }

  function maybeHandleFault(endpointKey: string, req: IncomingMessage, res: ServerResponse): FaultMode | "handled" {
    const mode = faults.get(endpointKey) ?? "none";
    if (mode === "network_error") {
      req.socket.destroy();
      return "handled";
    }
    if (mode === "500") {
      sendJson(res, 500, { ok: false, error: "Injected 500 fault" });
      return "handled";
    }
    if (mode === "503") {
      sendJson(res, 503, { ok: false, error: "Injected 503 fault" });
      return "handled";
    }
    if (mode === "401") {
      sendJson(res, 401, { ok: false, error: "Injected 401 fault" });
      return "handled";
    }
    if (mode === "403") {
      sendJson(res, 403, { ok: false, error: "Injected 403 fault" });
      return "handled";
    }
    return mode;
  }

  async function handlePairingCodeRedeem(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const fault = maybeHandleFault("pairing-code-redeem", req, res);
    if (fault === "handled") return;

    const body = await readJsonBody(req);
    const code = typeof body.code === "string" ? body.code.trim() : "";
    const installationId = typeof body.installation_id === "string" ? body.installation_id.trim() : "";

    if (!installationId) {
      sendJson(res, 400, { ok: false, error: GENERIC_REDEEM_ERROR });
      return;
    }

    const tracker = state.installation_failures.get(installationId);
    if (tracker && tracker.count >= 5 && nowMs() < tracker.coolingOffUntilMs) {
      sendJson(res, 429, { ok: false, error: GENERIC_REDEEM_ERROR });
      return;
    }

    const recordFailure = (): void => {
      const prev = state.installation_failures.get(installationId) ?? { count: 0, coolingOffUntilMs: 0 };
      const nextCount = prev.count + 1;
      state.installation_failures.set(installationId, {
        count: nextCount,
        coolingOffUntilMs: nextCount >= 5 ? nowMs() + COOLING_OFF_MS : prev.coolingOffUntilMs,
      });
    };

    if (!/^\d{8}$/.test(code)) {
      recordFailure();
      logSafe(`pairing-code-redeem rejected malformed attempt for installation ${installationId}`);
      sendJson(res, 400, { ok: false, error: GENERIC_REDEEM_ERROR });
      return;
    }

    const codeHash = sha256Hex(code);
    let matched: PairingCodeRecord | null = null;
    for (const candidate of state.pairing_codes.values()) {
      if (candidate.code_hash === codeHash) {
        matched = candidate;
        break;
      }
    }

    if (!matched) {
      recordFailure();
      logSafe(`pairing-code-redeem rejected unknown hash for installation ${installationId}`);
      sendJson(res, 400, { ok: false, error: GENERIC_REDEEM_ERROR });
      return;
    }

    if (matched.burned_at !== null || matched.failed_attempts >= 5) {
      recordFailure();
      sendJson(res, 429, { ok: false, error: GENERIC_REDEEM_ERROR });
      return;
    }

    if (matched.used_at !== null) {
      recordFailure();
      sendJson(res, 400, { ok: false, error: GENERIC_REDEEM_ERROR });
      return;
    }

    if (nowMs() > Date.parse(matched.expires_at)) {
      recordFailure();
      sendJson(res, 400, { ok: false, error: GENERIC_REDEEM_ERROR });
      return;
    }

    const org = state.organisations.get(matched.organisation_id);
    if (!org || org.deleted_at !== null) {
      recordFailure();
      sendJson(res, 400, { ok: false, error: GENERIC_REDEEM_ERROR });
      return;
    }

    let seat: SeatRecord | null = null;
    if (matched.seat_id) {
      const candidateSeat = state.seats.get(matched.seat_id) ?? null;
      if (!candidateSeat || candidateSeat.status !== "available") {
        recordFailure();
        sendJson(res, 403, { ok: false, error: GENERIC_REDEEM_ERROR });
        return;
      }
      seat = candidateSeat;
    } else {
      const orgSeats = [...state.seats.values()].filter((s) => s.organisation_id === org.id);
      const activeCount = orgSeats.filter((s) => s.status === "active").length;
      if (activeCount >= org.seat_limit) {
        recordFailure();
        sendJson(res, 403, { ok: false, error: GENERIC_REDEEM_ERROR });
        return;
      }
      const freeSeat = orgSeats.find((s) => s.status === "available") ?? null;
      if (freeSeat) {
        seat = freeSeat;
      } else if (orgSeats.length < org.seat_limit) {
        const newSeat: SeatRecord = {
          id: randomUUID(),
          organisation_id: org.id,
          group_id: matched.group_id,
          label: `seat-${orgSeats.length + 1}`,
          status: "available",
          installation_id: null,
          unlocked: false,
          last_heartbeat_at: null,
          paired_at: null,
          revoked_at: null,
          created_at: nowIso(),
        };
        state.seats.set(newSeat.id, newSeat);
        seat = newSeat;
      } else {
        recordFailure();
        sendJson(res, 403, { ok: false, error: GENERIC_REDEEM_ERROR });
        return;
      }
    }

    // Atomic single-use redemption
    matched.used_at = nowIso();
    seat.status = "active";
    seat.installation_id = installationId;
    seat.paired_at = nowIso();
    if (matched.group_id) seat.group_id = matched.group_id;

    state.installation_failures.delete(installationId);

    const sessionToken = randomSecretToken("gw_seat");
    const sessionExpiresAt = nowIso(SEAT_SESSION_TTL_MS);
    state.seat_sessions.set(sha256Hex(sessionToken), {
      token_hash: sha256Hex(sessionToken),
      seat_id: seat.id,
      organisation_id: org.id,
      installation_id: installationId,
      expires_at: sessionExpiresAt,
      revoked_at: null,
      created_at: nowIso(),
    });

    const envelope = await buildSignedEnvelopeForSeat(org, seat, installationId, fault);
    appendAudit({
      organisation_id: org.id,
      actor_id: seat.id,
      actor_type: "seat",
      action: "pairing_code.redeemed",
      target_type: "seat",
      target_id: seat.id,
      metadata: { code_id: matched.id, installation_id: installationId },
    });
    logSafe(`pairing-code-redeem succeeded for seat ${seat.id}`);

    sendJson(res, 200, {
      ok: true,
      organisation_id: org.id,
      organisation_name: org.name,
      seat_id: seat.id,
      unlocked: seat.unlocked,
      seat_session_token: sessionToken,
      session_expires_at: sessionExpiresAt,
      policy_envelope: envelope,
      policy_version: envelope?.policy_version ?? 0,
    });
  }

  async function handlePolicyDeliver(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const fault = maybeHandleFault("policy-deliver", req, res);
    if (fault === "handled") return;

    const body = await readJsonBody(req);
    const installationId = typeof body.installation_id === "string" ? body.installation_id.trim() : undefined;
    const auth = authenticateSeatSession(req, installationId);
    if (!auth.session || !auth.seat || !auth.org) {
      sendJson(res, auth.status, { ok: false, error: auth.error });
      return;
    }

    if (auth.seat.status === "revoked" || auth.org.deleted_at !== null) {
      sendJson(res, 403, { ok: false, status: "revoked", error: "Seat revoked" });
      return;
    }
    if (auth.seat.status !== "active") {
      sendJson(res, 403, { ok: false, status: "unpaired", error: "Seat not active" });
      return;
    }

    const envelope = await buildSignedEnvelopeForSeat(
      auth.org,
      auth.seat,
      auth.session.installation_id,
      fault,
    );

    sendJson(res, 200, {
      ok: true,
      status: "active",
      organisation_id: auth.org.id,
      organisation_name: auth.org.name,
      seat_id: auth.seat.id,
      unlocked: auth.seat.unlocked,
      policy_version: envelope?.policy_version ?? 0,
      policy_envelope: envelope,
    });
  }

  async function handleHeartbeatIngest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const fault = maybeHandleFault("heartbeat-ingest", req, res);
    if (fault === "handled") return;

    const body = await readJsonBody(req);
    const installationId = typeof body.installation_id === "string" ? body.installation_id.trim() : undefined;
    const auth = authenticateSeatSession(req, installationId);
    if (!auth.session || !auth.seat || !auth.org) {
      sendJson(res, auth.status, { ok: false, error: auth.error });
      return;
    }

    if (auth.seat.status === "revoked" || auth.org.deleted_at !== null) {
      sendJson(res, 403, { ok: false, status: "revoked", error: "Seat revoked" });
      return;
    }

    for (const field of Object.keys(body)) {
      if (!SECTION_5_HEARTBEAT_KEYS.has(field)) {
        sendJson(res, 400, {
          ok: false,
          error: `Field "${field}" is forbidden by Section 5 metadata-only heartbeat contract`,
        });
        return;
      }
    }

    if (
      body.seat_id !== auth.seat.id ||
      body.organisation_id !== auth.org.id ||
      body.installation_id !== auth.session.installation_id
    ) {
      sendJson(res, 403, { ok: false, error: "Heartbeat identity mismatch" });
      return;
    }

    const receivedAt = nowIso();
    auth.seat.last_heartbeat_at = receivedAt;
    const record: HeartbeatRecord = {
      seat_id: String(body.seat_id),
      installation_id: String(body.installation_id),
      organisation_id: String(body.organisation_id),
      extension_version: String(body.extension_version ?? ""),
      browser_name: String(body.browser_name ?? ""),
      browser_version: String(body.browser_version ?? ""),
      platform: String(body.platform ?? ""),
      policy_version: Number(body.policy_version ?? 0),
      policy_status: String(body.policy_status ?? "unknown"),
      health_status: String(body.health_status ?? "healthy"),
      timestamp: String(body.timestamp ?? receivedAt),
      reported_policy:
        body.reported_policy && typeof body.reported_policy === "object" && !Array.isArray(body.reported_policy)
          ? (body.reported_policy as Record<string, unknown>)
          : null,
      received_at: receivedAt,
    };
    state.heartbeat_state.set(auth.seat.id, record);

    const activePolicy = resolveEffectivePolicyRecord(auth.seat);
    sendJson(res, 200, {
      ok: true,
      received_at: receivedAt,
      unlocked: auth.seat.unlocked,
      policy_version: activePolicy?.version ?? 0,
    });
  }

  async function handleSessionRotate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const fault = maybeHandleFault("session-rotate", req, res);
    if (fault === "handled") return;

    const body = await readJsonBody(req);
    const installationId = typeof body.installation_id === "string" ? body.installation_id.trim() : undefined;
    const auth = authenticateSeatSession(req, installationId);
    if (!auth.session || !auth.seat || !auth.org) {
      sendJson(res, auth.status, { ok: false, error: auth.error });
      return;
    }

    if (auth.seat.status === "revoked" || auth.org.deleted_at !== null) {
      sendJson(res, 403, { ok: false, status: "revoked", error: "Seat revoked" });
      return;
    }

    // Immediate invalidation before issuing the new credential (zero reuse window per D9/S12)
    auth.session.revoked_at = nowIso();
    state.seat_sessions.delete(auth.session.token_hash);

    const nextToken = randomSecretToken("gw_seat");
    const nextExpiresAt = nowIso(SEAT_SESSION_TTL_MS);
    const nextHash = sha256Hex(nextToken);
    state.seat_sessions.set(nextHash, {
      token_hash: nextHash,
      seat_id: auth.seat.id,
      organisation_id: auth.org.id,
      installation_id: auth.session.installation_id,
      expires_at: nextExpiresAt,
      revoked_at: null,
      created_at: nowIso(),
    });

    sendJson(res, 200, {
      ok: true,
      seat_session_token: nextToken,
      session_expires_at: nextExpiresAt,
    });
  }

  async function handleSeatUnpair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const fault = maybeHandleFault("seat-unpair", req, res);
    if (fault === "handled") return;

    const body = await readJsonBody(req);
    const installationId = typeof body.installation_id === "string" ? body.installation_id.trim() : undefined;
    const auth = authenticateSeatSession(req, installationId);
    if (!auth.session || !auth.seat || !auth.org) {
      sendJson(res, auth.status, { ok: false, error: auth.error });
      return;
    }

    auth.seat.status = "available";
    auth.seat.installation_id = null;
    auth.seat.paired_at = null;
    for (const [k, s] of state.seat_sessions.entries()) {
      if (s.seat_id === auth.seat.id) {
        s.revoked_at = nowIso();
        state.seat_sessions.delete(k);
      }
    }

    appendAudit({
      organisation_id: auth.org.id,
      actor_id: auth.seat.id,
      actor_type: "seat",
      action: "seat.unpaired",
      target_type: "seat",
      target_id: auth.seat.id,
      metadata: {},
    });

    sendJson(res, 200, { ok: true, status: "unpaired" });
  }

  async function handlePairingCodeGenerate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const fault = maybeHandleFault("pairing-code-generate", req, res);
    if (fault === "handled") return;

    const { admin, errorStatus, errorMessage } = authenticateAdmin(req);
    if (!admin) {
      sendJson(res, errorStatus ?? 401, { ok: false, error: errorMessage ?? "Unauthorized" });
      return;
    }
    if (admin.must_change_password) {
      sendJson(res, 403, { ok: false, error: "Password change required before generating pairing codes" });
      return;
    }
    if (!adminHasPermission(admin, "code.manage")) {
      sendJson(res, 403, { ok: false, error: "Missing code.manage permission" });
      return;
    }

    const org = state.organisations.get(admin.organisation_id);
    if (!org || org.deleted_at !== null) {
      sendJson(res, 404, { ok: false, error: "Organisation not found" });
      return;
    }

    const body = await readJsonBody(req);
    const requestedSeatId = typeof body.seat_id === "string" ? body.seat_id : null;
    const requestedGroupId = typeof body.group_id === "string" ? body.group_id : null;

    if (!admin.is_primary) {
      const scopedGroups = getAdminGroupIds(admin.id);
      if (scopedGroups.length > 0) {
        if (requestedGroupId && !scopedGroups.includes(requestedGroupId)) {
          sendJson(res, 403, { ok: false, error: "Group outside admin_groups scope" });
          return;
        }
        if (requestedSeatId) {
          const seatObj = state.seats.get(requestedSeatId);
          if (seatObj && (!seatObj.group_id || !scopedGroups.includes(seatObj.group_id))) {
            sendJson(res, 403, { ok: false, error: "Seat outside admin_groups scope" });
            return;
          }
        }
      }
    }

    let targetSeatId: string | null = requestedSeatId;
    if (requestedSeatId) {
      const seat = state.seats.get(requestedSeatId);
      if (!seat || seat.organisation_id !== org.id) {
        sendJson(res, 404, { ok: false, error: "Seat not found" });
        return;
      }
      if (seat.status !== "available") {
        sendJson(res, 409, { ok: false, error: "Seat is not available for pairing" });
        return;
      }
    } else {
      const orgSeats = [...state.seats.values()].filter((s) => s.organisation_id === org.id);
      const activeCount = orgSeats.filter((s) => s.status === "active").length;
      if (activeCount >= org.seat_limit) {
        sendJson(res, 409, { ok: false, error: "No free seats available in organisation" });
        return;
      }
      const availableSeat = orgSeats.find(
        (s) => s.status === "available" && (!requestedGroupId || s.group_id === requestedGroupId),
      );
      if (availableSeat) {
        targetSeatId = availableSeat.id;
      } else if (orgSeats.length < org.seat_limit) {
        const createdSeat: SeatRecord = {
          id: randomUUID(),
          organisation_id: org.id,
          group_id: requestedGroupId,
          label: `seat-${orgSeats.length + 1}`,
          status: "available",
          installation_id: null,
          unlocked: false,
          last_heartbeat_at: null,
          paired_at: null,
          revoked_at: null,
          created_at: nowIso(),
        };
        state.seats.set(createdSeat.id, createdSeat);
        targetSeatId = createdSeat.id;
      } else {
        sendJson(res, 409, { ok: false, error: "No free seats available in organisation" });
        return;
      }
    }

    // Enforce max 1 live code per seat by superseding any previous unused code for this seat
    if (targetSeatId) {
      for (const existing of state.pairing_codes.values()) {
        if (
          existing.seat_id === targetSeatId &&
          existing.used_at === null &&
          existing.burned_at === null
        ) {
          existing.burned_at = nowIso();
        }
      }
    }

    const rawCode = String(randomInt(0, 100_000_000)).padStart(8, "0");
    const expiresAt = nowIso(PAIRING_CODE_TTL_MS);
    const codeRecord: PairingCodeRecord = {
      id: randomUUID(),
      organisation_id: org.id,
      seat_id: targetSeatId,
      group_id: requestedGroupId,
      code_hash: sha256Hex(rawCode),
      expires_at: expiresAt,
      used_at: null,
      failed_attempts: 0,
      burned_at: null,
      created_at: nowIso(),
    };
    state.pairing_codes.set(codeRecord.id, codeRecord);

    appendAudit({
      organisation_id: org.id,
      actor_id: admin.id,
      actor_type: "admin",
      action: "pairing_code.generated",
      target_type: "seat",
      target_id: targetSeatId ?? org.id,
      metadata: { code_id: codeRecord.id },
    });
    logSafe(`pairing-code-generate created code_id=${codeRecord.id} for seat=${targetSeatId}`);

    sendJson(res, 200, {
      ok: true,
      code: rawCode,
      code_id: codeRecord.id,
      seat_id: targetSeatId,
      expires_at: expiresAt,
    });
  }

  async function handleAdminGrantManage(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const fault = maybeHandleFault("admin-grant-manage", req, res);
    if (fault === "handled") return;

    const body = await readJsonBody(req);
    const action = typeof body.action === "string" ? body.action : "issue";

    if (action === "login") {
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      const password = typeof body.password === "string" ? body.password : "";
      const passwordDigest = sha256Hex(password);
      let matchedAdmin: AdminRecord | null = null;
      for (const candidate of state.admins.values()) {
        if (candidate.email.toLowerCase() === email && candidate.disabled_at === null) {
          matchedAdmin = candidate;
          break;
        }
      }
      if (!matchedAdmin || matchedAdmin.password_hash !== passwordDigest) {
        sendJson(res, 401, { ok: false, error: "Invalid email or password" });
        return;
      }
      if (!matchedAdmin.is_primary) {
        for (const grant of state.admin_grants.values()) {
          if (grant.admin_id === matchedAdmin.id) {
            if (grant.revoked_at !== null) {
              sendJson(res, 403, { ok: false, error: "Admin grant revoked" });
              return;
            }
            if (matchedAdmin.must_change_password && nowMs() > Date.parse(grant.expires_at)) {
              sendJson(res, 403, { ok: false, error: "Temporary grant expired (72h limit)" });
              return;
            }
          }
        }
      }
      const adminToken = randomSecretToken("gw_admin");
      state.admin_tokens.set(adminToken, matchedAdmin.id);
      sendJson(res, 200, {
        ok: true,
        admin_jwt: adminToken,
        admin_id: matchedAdmin.id,
        organisation_id: matchedAdmin.organisation_id,
        must_change_password: matchedAdmin.must_change_password,
      });
      return;
    }

    const { admin, errorStatus, errorMessage } = authenticateAdmin(req);
    if (!admin) {
      sendJson(res, errorStatus ?? 401, { ok: false, error: errorMessage ?? "Unauthorized" });
      return;
    }

    if (action === "change_password") {
      const newPassword = typeof body.new_password === "string" ? body.new_password : "";
      if (newPassword.length < 8) {
        sendJson(res, 400, { ok: false, error: "New password must be at least 8 characters" });
        return;
      }
      const nextDigest = sha256Hex(newPassword);
      if (nextDigest === admin.password_hash) {
        sendJson(res, 400, { ok: false, error: "New password must differ from temporary password" });
        return;
      }
      admin.password_hash = nextDigest;
      admin.must_change_password = false;
      for (const grant of state.admin_grants.values()) {
        if (grant.admin_id === admin.id && grant.revoked_at === null) {
          grant.accepted_at = nowIso();
        }
      }
      appendAudit({
        organisation_id: admin.organisation_id,
        actor_id: admin.id,
        actor_type: "admin",
        action: "admin.password_changed",
        target_type: "admin",
        target_id: admin.id,
        metadata: {},
      });
      sendJson(res, 200, { ok: true, must_change_password: false });
      return;
    }

    if (admin.must_change_password) {
      sendJson(res, 403, { ok: false, error: "Password change required before performing admin operations" });
      return;
    }

    if (!adminHasPermission(admin, "admin.grant")) {
      sendJson(res, 403, { ok: false, error: "Missing admin.grant permission" });
      return;
    }

    if (action === "issue") {
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      const permissionSet = Array.isArray(body.permission_set)
        ? body.permission_set.filter((p): p is string => typeof p === "string")
        : [];
      const groupIds = Array.isArray(body.group_ids)
        ? body.group_ids.filter((g): g is string => typeof g === "string")
        : [];

      if (!email || !email.includes("@")) {
        sendJson(res, 400, { ok: false, error: "Valid email is required for admin grant" });
        return;
      }
      if (permissionSet.includes("primary")) {
        sendJson(res, 403, { ok: false, error: "Cannot grant primary role" });
        return;
      }
      if (!admin.is_primary) {
        for (const p of permissionSet) {
          if (!admin.permission_set.includes(p)) {
            sendJson(res, 403, { ok: false, error: `Cannot grant permission "${p}" not held by caller` });
            return;
          }
        }
      }

      const tempPass = `Tmp-${randomBytes(8).toString("hex")}!`;
      const tempHash = sha256Hex(tempPass);
      const grantedAdmin: AdminRecord = {
        id: randomUUID(),
        organisation_id: admin.organisation_id,
        email,
        role: "granted",
        is_primary: false,
        permission_set: [...permissionSet],
        must_change_password: true,
        password_hash: tempHash,
        disabled_at: null,
        created_at: nowIso(),
      };
      state.admins.set(grantedAdmin.id, grantedAdmin);

      const grantRecord: AdminGrantRecord = {
        id: randomUUID(),
        organisation_id: admin.organisation_id,
        admin_id: grantedAdmin.id,
        email,
        permission_set: [...permissionSet],
        temp_password_hash: tempHash,
        expires_at: nowIso(ADMIN_GRANT_TTL_MS),
        accepted_at: null,
        revoked_at: null,
        created_by: admin.id,
        created_at: nowIso(),
      };
      state.admin_grants.set(grantRecord.id, grantRecord);

      for (const gid of groupIds) {
        const ag: AdminGroupRecord = {
          id: randomUUID(),
          organisation_id: admin.organisation_id,
          admin_id: grantedAdmin.id,
          group_id: gid,
        };
        state.admin_groups.set(ag.id, ag);
      }

      const grantedToken = randomSecretToken("gw_admin");
      state.admin_tokens.set(grantedToken, grantedAdmin.id);

      appendAudit({
        organisation_id: admin.organisation_id,
        actor_id: admin.id,
        actor_type: "admin",
        action: "admin_grant.issued",
        target_type: "admin_grant",
        target_id: grantRecord.id,
        metadata: { granted_admin_id: grantedAdmin.id, permission_set: permissionSet, group_ids: groupIds },
      });

      sendJson(res, 200, {
        ok: true,
        grant_id: grantRecord.id,
        admin_id: grantedAdmin.id,
        email,
        temp_password: tempPass,
        expires_at: grantRecord.expires_at,
        admin_jwt: grantedToken,
      });
      return;
    }

    if (action === "update") {
      const grantId = typeof body.grant_id === "string" ? body.grant_id : "";
      const grant = state.admin_grants.get(grantId);
      if (!grant || grant.organisation_id !== admin.organisation_id || grant.revoked_at !== null) {
        sendJson(res, 404, { ok: false, error: "Grant not found" });
        return;
      }
      const targetAdmin = state.admins.get(grant.admin_id);
      if (!targetAdmin || targetAdmin.is_primary) {
        sendJson(res, 403, { ok: false, error: "Cannot modify primary admin" });
        return;
      }
      if (targetAdmin.id === admin.id) {
        sendJson(res, 403, { ok: false, error: "Self-escalation forbidden" });
        return;
      }

      if (Array.isArray(body.permission_set)) {
        const nextPerms = body.permission_set.filter((p): p is string => typeof p === "string");
        if (!admin.is_primary) {
          for (const p of nextPerms) {
            if (!admin.permission_set.includes(p)) {
              sendJson(res, 403, { ok: false, error: `Cannot escalate permission "${p}"` });
              return;
            }
          }
        }
        grant.permission_set = [...nextPerms];
        targetAdmin.permission_set = [...nextPerms];
      }

      if (Array.isArray(body.group_ids)) {
        for (const [agId, ag] of state.admin_groups.entries()) {
          if (ag.admin_id === targetAdmin.id) state.admin_groups.delete(agId);
        }
        for (const gid of body.group_ids) {
          if (typeof gid === "string") {
            const ag: AdminGroupRecord = {
              id: randomUUID(),
              organisation_id: admin.organisation_id,
              admin_id: targetAdmin.id,
              group_id: gid,
            };
            state.admin_groups.set(ag.id, ag);
          }
        }
      }

      appendAudit({
        organisation_id: admin.organisation_id,
        actor_id: admin.id,
        actor_type: "admin",
        action: "admin_grant.updated",
        target_type: "admin_grant",
        target_id: grant.id,
        metadata: { permission_set: grant.permission_set },
      });

      sendJson(res, 200, { ok: true, grant });
      return;
    }

    if (action === "revoke") {
      const grantId = typeof body.grant_id === "string" ? body.grant_id : "";
      const grant = state.admin_grants.get(grantId);
      if (!grant || grant.organisation_id !== admin.organisation_id) {
        sendJson(res, 404, { ok: false, error: "Grant not found" });
        return;
      }
      grant.revoked_at = nowIso();
      const targetAdmin = state.admins.get(grant.admin_id);
      if (targetAdmin) {
        targetAdmin.disabled_at = nowIso();
      }
      appendAudit({
        organisation_id: admin.organisation_id,
        actor_id: admin.id,
        actor_type: "admin",
        action: "admin_grant.revoked",
        target_type: "admin_grant",
        target_id: grant.id,
        metadata: { target_admin_id: grant.admin_id },
      });
      sendJson(res, 200, { ok: true, status: "revoked" });
      return;
    }

    sendJson(res, 400, { ok: false, error: `Unknown admin-grant-manage action: ${action}` });
  }

  async function handleAdminOps(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const fault = maybeHandleFault("admin-ops", req, res);
    if (fault === "handled") return;

    const { admin, errorStatus, errorMessage } = authenticateAdmin(req);
    if (!admin) {
      sendJson(res, errorStatus ?? 401, { ok: false, error: errorMessage ?? "Unauthorized" });
      return;
    }
    if (admin.must_change_password) {
      sendJson(res, 403, { ok: false, error: "Password change required before admin operations" });
      return;
    }

    const org = state.organisations.get(admin.organisation_id);
    if (!org || org.deleted_at !== null) {
      sendJson(res, 404, { ok: false, error: "Organisation not found" });
      return;
    }

    const body = await readJsonBody(req);
    const action = typeof body.action === "string" ? body.action : "";

    if (action === "admin.self_escalate") {
      sendJson(res, 403, { ok: false, error: "Self-escalation is forbidden" });
      return;
    }

    if (action === "policy.upsert") {
      if (!adminHasPermission(admin, "policy.write")) {
        sendJson(res, 403, { ok: false, error: "Missing policy.write permission" });
        return;
      }
      const scopeType =
        body.scope_type === "group" || body.scope_type === "seat" ? body.scope_type : "org";
      const scopeId = typeof body.scope_id === "string" && body.scope_id ? body.scope_id : org.id;

      if (!admin.is_primary) {
        const scopedGroups = getAdminGroupIds(admin.id);
        if (scopedGroups.length > 0) {
          if (scopeType === "org") {
            sendJson(res, 403, { ok: false, error: "Group-scoped admin cannot edit org policy" });
            return;
          }
          if (scopeType === "group" && !scopedGroups.includes(scopeId)) {
            sendJson(res, 403, { ok: false, error: "Group outside admin_groups scope" });
            return;
          }
          if (scopeType === "seat") {
            const targetSeat = state.seats.get(scopeId);
            if (!targetSeat || !targetSeat.group_id || !scopedGroups.includes(targetSeat.group_id)) {
              sendJson(res, 403, { ok: false, error: "Seat outside admin_groups scope" });
              return;
            }
          }
        }
      }

      const rules = Array.isArray(body.rules) ? (body.rules as PolicyRule[]) : [];
      const settings =
        body.settings && typeof body.settings === "object" && !Array.isArray(body.settings)
          ? (body.settings as ManagedPolicySettings)
          : {};

      let existing: PolicyRecord | null = null;
      for (const p of state.policies.values()) {
        if (p.organisation_id === org.id && p.scope_type === scopeType && p.scope_id === scopeId) {
          existing = p;
          break;
        }
      }

      // Compute org-wide monotonic version so seat > group > org switches never trigger client rollback
      let maxOrgVersion = 0;
      for (const p of state.policies.values()) {
        if (p.organisation_id === org.id && p.version > maxOrgVersion) {
          maxOrgVersion = p.version;
        }
      }
      const nextVersion = Math.max(maxOrgVersion, existing?.version ?? 0) + 1;
      const updatedPolicy: PolicyRecord = existing
        ? {
            ...existing,
            version: nextVersion,
            rules,
            settings,
            updated_at: nowIso(),
          }
        : {
            id: randomUUID(),
            organisation_id: org.id,
            scope_type: scopeType,
            scope_id: scopeId,
            version: nextVersion,
            rules,
            settings,
            updated_at: nowIso(),
            created_at: nowIso(),
          };
      state.policies.set(updatedPolicy.id, updatedPolicy);

      appendAudit({
        organisation_id: org.id,
        actor_id: admin.id,
        actor_type: "admin",
        action: "policy.upserted",
        target_type: scopeType,
        target_id: scopeId,
        metadata: { policy_id: updatedPolicy.id, version: updatedPolicy.version },
      });

      sendJson(res, 200, { ok: true, policy: updatedPolicy });
      return;
    }

    if (action === "group.create") {
      if (!adminHasPermission(admin, "group.manage")) {
        sendJson(res, 403, { ok: false, error: "Missing group.manage permission" });
        return;
      }
      const name = typeof body.name === "string" ? body.name.trim() : "default-group";
      const group: GroupRecord = {
        id: randomUUID(),
        organisation_id: org.id,
        name,
        created_at: nowIso(),
      };
      state.groups.set(group.id, group);
      appendAudit({
        organisation_id: org.id,
        actor_id: admin.id,
        actor_type: "admin",
        action: "group.created",
        target_type: "group",
        target_id: group.id,
        metadata: { name },
      });
      sendJson(res, 200, { ok: true, group });
      return;
    }

    if (action === "group.assign_seat") {
      if (!adminHasPermission(admin, "group.manage")) {
        sendJson(res, 403, { ok: false, error: "Missing group.manage permission" });
        return;
      }
      const seatId = typeof body.seat_id === "string" ? body.seat_id : "";
      const groupId = typeof body.group_id === "string" ? body.group_id : null;
      const seat = state.seats.get(seatId);
      if (!seat || seat.organisation_id !== org.id) {
        sendJson(res, 404, { ok: false, error: "Seat not found" });
        return;
      }
      if (groupId) {
        const group = state.groups.get(groupId);
        if (!group || group.organisation_id !== org.id) {
          sendJson(res, 404, { ok: false, error: "Group not found" });
          return;
        }
      }
      seat.group_id = groupId;
      appendAudit({
        organisation_id: org.id,
        actor_id: admin.id,
        actor_type: "admin",
        action: "group.seat_assigned",
        target_type: "seat",
        target_id: seat.id,
        metadata: { group_id: groupId },
      });
      sendJson(res, 200, { ok: true, seat });
      return;
    }

    if (action === "seat.unlock" || action === "seat.lock") {
      if (!adminHasPermission(admin, "seat.unlock")) {
        sendJson(res, 403, { ok: false, error: "Missing seat.unlock permission" });
        return;
      }
      const seatId = typeof body.seat_id === "string" ? body.seat_id : "";
      const seat = state.seats.get(seatId);
      if (!seat || seat.organisation_id !== org.id) {
        sendJson(res, 404, { ok: false, error: "Seat not found" });
        return;
      }
      if (!admin.is_primary) {
        const scopedGroups = getAdminGroupIds(admin.id);
        if (scopedGroups.length > 0 && (!seat.group_id || !scopedGroups.includes(seat.group_id))) {
          sendJson(res, 403, { ok: false, error: "Seat outside admin_groups scope" });
          return;
        }
      }
      seat.unlocked = action === "seat.unlock";
      appendAudit({
        organisation_id: org.id,
        actor_id: admin.id,
        actor_type: "admin",
        action: seat.unlocked ? "seat.unlocked" : "seat.locked",
        target_type: "seat",
        target_id: seat.id,
        metadata: { unlocked: seat.unlocked },
      });
      sendJson(res, 200, { ok: true, seat });
      return;
    }

    if (action === "seat.revoke") {
      if (!adminHasPermission(admin, "seat.unlock") && !adminHasPermission(admin, "code.manage")) {
        sendJson(res, 403, { ok: false, error: "Missing seat revocation permission" });
        return;
      }
      const seatId = typeof body.seat_id === "string" ? body.seat_id : "";
      const seat = state.seats.get(seatId);
      if (!seat || seat.organisation_id !== org.id) {
        sendJson(res, 404, { ok: false, error: "Seat not found" });
        return;
      }
      seat.status = "revoked";
      seat.revoked_at = nowIso();
      appendAudit({
        organisation_id: org.id,
        actor_id: admin.id,
        actor_type: "admin",
        action: "seat.revoked",
        target_type: "seat",
        target_id: seat.id,
        metadata: {},
      });
      sendJson(res, 200, { ok: true, seat });
      return;
    }

    if (action === "audit.read") {
      if (!adminHasPermission(admin, "audit.read")) {
        sendJson(res, 403, { ok: false, error: "Missing audit.read permission" });
        return;
      }
      const logs = state.audit_log.filter((l) => l.organisation_id === org.id);
      sendJson(res, 200, { ok: true, logs });
      return;
    }

    if (action === "org.delete") {
      if (!admin.is_primary) {
        sendJson(res, 403, { ok: false, error: "Only primary admin can delete an organisation" });
        return;
      }
      org.deleted_at = nowIso();
      for (const s of state.seats.values()) {
        if (s.organisation_id === org.id) {
          s.status = "revoked";
          s.revoked_at = nowIso();
        }
      }
      for (const [k, ss] of state.seat_sessions.entries()) {
        if (ss.organisation_id === org.id) {
          ss.revoked_at = nowIso();
          state.seat_sessions.delete(k);
        }
      }
      appendAudit({
        organisation_id: org.id,
        actor_id: admin.id,
        actor_type: "admin",
        action: "org.deleted",
        target_type: "organisation",
        target_id: org.id,
        metadata: {},
      });
      sendJson(res, 200, { ok: true, status: "deleted" });
      return;
    }

    sendJson(res, 400, { ok: false, error: `Unknown admin-ops action: ${action}` });
  }

  function handleDirectRestProbe(req: IncomingMessage, res: ServerResponse, pathname: string, searchParams: URLSearchParams): void {
    const method = req.method ?? "GET";
    const bearer = extractBearer(req);
    const seatHeader = req.headers["x-seat-session"];

    if (pathname.startsWith("/rest/v1/pairing_codes")) {
      const status = bearer || seatHeader ? 403 : 401;
      sendJson(res, status, {
        code: "42501",
        message: "permission denied for table pairing_codes (RLS strict isolation)",
      });
      return;
    }

    if (pathname.startsWith("/rest/v1/audit_log")) {
      if (method !== "GET") {
        sendJson(res, bearer || seatHeader ? 403 : 401, {
          code: "42501",
          message: "audit_log is append-only via server functions",
        });
        return;
      }
      const { admin, errorStatus, errorMessage } = authenticateAdmin(req);
      if (!admin) {
        sendJson(res, errorStatus ?? 401, { code: "42501", message: errorMessage ?? "Unauthorized" });
        return;
      }
      if (!adminHasPermission(admin, "audit.read")) {
        sendJson(res, 403, { code: "42501", message: "Missing audit.read permission" });
        return;
      }
      const orgFilter = searchParams.get("organisation_id");
      if (orgFilter && orgFilter !== `eq.${admin.organisation_id}`) {
        sendJson(res, 200, []);
        return;
      }
      sendJson(
        res,
        200,
        state.audit_log.filter((l) => l.organisation_id === admin.organisation_id),
      );
      return;
    }

    // Other /rest/v1/* tables enforce strict tenant isolation
    const { admin } = authenticateAdmin(req);
    if (!admin) {
      sendJson(res, 401, { code: "42501", message: "Anonymous REST access denied by RLS" });
      return;
    }
    if (method !== "GET") {
      sendJson(res, 403, { code: "42501", message: "Direct client mutations blocked; use Edge Functions" });
      return;
    }

    const orgFilter = searchParams.get("organisation_id");
    if (orgFilter && orgFilter !== `eq.${admin.organisation_id}`) {
      sendJson(res, 200, []);
      return;
    }
    sendJson(res, 200, []);
  }

  const server: Server = createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        sendJson(res, 200, { ok: true });
        return;
      }

      const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      const pathname = reqUrl.pathname;

      if (req.method === "POST" && pathname === "/functions/v1/pairing-code-redeem") {
        await handlePairingCodeRedeem(req, res);
        return;
      }
      if (req.method === "POST" && pathname === "/functions/v1/policy-deliver") {
        await handlePolicyDeliver(req, res);
        return;
      }
      if (req.method === "POST" && pathname === "/functions/v1/heartbeat-ingest") {
        await handleHeartbeatIngest(req, res);
        return;
      }
      if (req.method === "POST" && pathname === "/functions/v1/session-rotate") {
        await handleSessionRotate(req, res);
        return;
      }
      if (req.method === "POST" && pathname === "/functions/v1/seat-unpair") {
        await handleSeatUnpair(req, res);
        return;
      }
      if (req.method === "POST" && pathname === "/functions/v1/pairing-code-generate") {
        await handlePairingCodeGenerate(req, res);
        return;
      }
      if (req.method === "POST" && pathname === "/functions/v1/admin-grant-manage") {
        await handleAdminGrantManage(req, res);
        return;
      }
      if (req.method === "POST" && pathname === "/functions/v1/admin-ops") {
        await handleAdminOps(req, res);
        return;
      }
      if (pathname.startsWith("/rest/v1/")) {
        handleDirectRestProbe(req, res, pathname, reqUrl.searchParams);
        return;
      }

      sendJson(res, 404, { ok: false, error: `Route not found: ${req.method} ${pathname}` });
    } catch (err) {
      sendJson(res, 500, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("MockSupabaseServer failed to bind an ephemeral TCP port");
  }
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    port: addr.port,
    state,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
    setClockOffsetMs(offsetMs: number) {
      clockOffsetMs = offsetMs;
    },
    advanceClockMs(deltaMs: number) {
      clockOffsetMs += deltaMs;
    },
    getClockNowMs() {
      return nowMs();
    },
    setFault(endpoint: string, mode: FaultMode) {
      if (mode === "none") {
        faults.delete(endpoint);
      } else {
        faults.set(endpoint, mode);
      }
    },
    clearFaults() {
      faults.clear();
    },
    expireCode(codeId: string) {
      const rec = state.pairing_codes.get(codeId);
      if (rec) rec.expires_at = nowIso(-60_000);
    },
    burnCode(codeId: string) {
      const rec = state.pairing_codes.get(codeId);
      if (rec) {
        rec.failed_attempts = 5;
        rec.burned_at = nowIso();
      }
    },
    expireGrant(grantId: string) {
      const g = state.admin_grants.get(grantId);
      if (g) g.expires_at = nowIso(-60_000);
    },
    getSigningPublicJwk() {
      return { ...publicJwk };
    },
    signPolicyEnvelope,
    getAuditLogs(orgId?: string) {
      if (!orgId) return [...state.audit_log];
      return state.audit_log.filter((l) => l.organisation_id === orgId);
    },
    getHeartbeatState(seatId: string) {
      return state.heartbeat_state.get(seatId);
    },
    getRawDbState() {
      return {
        pairingCodes: [...state.pairing_codes.values()],
        auditLog: [...state.audit_log],
        serverLogs: [...state.server_logs],
        organisations: [...state.organisations.values()],
        seats: [...state.seats.values()],
        heartbeatState: [...state.heartbeat_state.values()],
      };
    },
    seedOrganisation(opts: SeedOrgOptions = {}): SeededOrgResult {
      const orgId = opts.id ?? randomUUID();
      const orgName = opts.name ?? `e2e-test-${orgId.slice(0, 8)}`;
      const seatLimit = opts.seatLimit ?? 5;
      const org: OrgRecord = {
        id: orgId,
        name: orgName,
        slug: orgName.toLowerCase().replace(/[^a-z0-9-]+/g, "-"),
        seat_limit: seatLimit,
        owner_backend: "supabase",
        deleted_at: null,
        created_at: nowIso(),
      };
      state.organisations.set(org.id, org);

      const primaryPassword = opts.primaryPassword ?? `Primary-${randomBytes(8).toString("hex")}!`;
      const primaryAdmin: AdminRecord = {
        id: randomUUID(),
        organisation_id: org.id,
        email: opts.primaryEmail ?? `primary-${orgId.slice(0, 8)}@example.test`,
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
        must_change_password: false,
        password_hash: sha256Hex(primaryPassword),
        disabled_at: null,
        created_at: nowIso(),
      };
      state.admins.set(primaryAdmin.id, primaryAdmin);

      const primaryAdminJwt = randomSecretToken("gw_admin");
      state.admin_tokens.set(primaryAdminJwt, primaryAdmin.id);

      const seats: SeatRecord[] = [];
      for (let i = 0; i < seatLimit; i++) {
        const seat: SeatRecord = {
          id: randomUUID(),
          organisation_id: org.id,
          group_id: null,
          label: `seat-${i + 1}`,
          status: "available",
          installation_id: null,
          unlocked: false,
          last_heartbeat_at: null,
          paired_at: null,
          revoked_at: null,
          created_at: nowIso(),
        };
        state.seats.set(seat.id, seat);
        seats.push(seat);
      }

      if (opts.initialPolicy) {
        const policy: PolicyRecord = {
          id: randomUUID(),
          organisation_id: org.id,
          scope_type: "org",
          scope_id: org.id,
          version: 1,
          rules: opts.initialPolicy.rules ?? [],
          settings: opts.initialPolicy.settings ?? {
            protectionMode: "always-on",
            userCanDisable: false,
            enforcedCategories: ["email", "ssn", "payment_card"],
          },
          updated_at: nowIso(),
          created_at: nowIso(),
        };
        state.policies.set(policy.id, policy);
      }

      return {
        organisation: org,
        primaryAdmin,
        primaryAdminJwt,
        seats,
      };
    },
  };
}
