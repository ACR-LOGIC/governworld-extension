// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
/**
 * Strictly Isolated Telemetry Sandbox.
 *
 * Architectural Zero-Egress Guarantee:
 * - Imports ONLY `browserFamily.ts` (zero imports from `content/`, `document-pipeline/`,
 *   `offscreen/`, `docDb`, `docStore`, `audit`, `settings`, or DOM inspection code).
 * - Enforces a closed-key, strict-enum outbound schema so dynamic fields, URLs,
 *   page content, DOM fragments, or free-text user data are rejected before egress.
 */

import { isBrowserFamily, type BrowserFamily } from "./browserFamily.js";

export type TelemetryEventKind = "heartbeat" | "clean_shutdown" | "uninstall_signal";
export type ExtensionLifecycleState = "online" | "offline_clean_shutdown" | "uninstalled_or_terminated";
export type TelemetryPolicyStatus = "compliant" | "out-of-date" | "locked_lapsed" | "unmanaged_default" | "error";
export type TelemetryHealthStatus = "healthy" | "active" | "degraded" | "offline_clean";

export interface StrictTelemetryPayload {
  schema_version: "2.0";
  event_kind: TelemetryEventKind;
  lifecycle_state: ExtensionLifecycleState;
  device_id: string;
  organization_id: string;
  seat_id?: string;
  user_email_hash?: string;
  device_activation_hash?: string;
  browser_family: BrowserFamily;
  extension_version: string;
  policy_version: number;
  policy_hash?: string;
  policy_status: TelemetryPolicyStatus;
  health_status: TelemetryHealthStatus;
  clean_shutdown_flag: boolean;
  last_clean_shutdown_at?: string;
  timestamp: string;
}

export const ALLOWED_TELEMETRY_KEYS: ReadonlySet<string> = new Set([
  "schema_version",
  "event_kind",
  "lifecycle_state",
  "device_id",
  "organization_id",
  "seat_id",
  "user_email_hash",
  "device_activation_hash",
  "browser_family",
  "extension_version",
  "policy_version",
  "policy_hash",
  "policy_status",
  "health_status",
  "clean_shutdown_flag",
  "last_clean_shutdown_at",
  "timestamp",
]);

const EVENT_KINDS = new Set<TelemetryEventKind>(["heartbeat", "clean_shutdown", "uninstall_signal"]);
const LIFECYCLE_STATES = new Set<ExtensionLifecycleState>([
  "online",
  "offline_clean_shutdown",
  "uninstalled_or_terminated",
]);
const POLICY_STATUSES = new Set<TelemetryPolicyStatus>([
  "compliant",
  "out-of-date",
  "locked_lapsed",
  "unmanaged_default",
  "error",
]);
const HEALTH_STATUSES = new Set<TelemetryHealthStatus>(["healthy", "active", "degraded", "offline_clean"]);

const DEVICE_ID_RE = /^[A-Za-z0-9_-]{4,128}$/;
const ORG_ID_RE = /^[A-Za-z0-9_-]{2,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const SEMVER_CORE_RE = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/;
const SEMVER_PRE_RE = /^[A-Za-z0-9._-]{1,32}$/;
const UTC_ISO_BASE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const UTC_MS_RE = /^\d{1,3}$/;

function isValidSemver(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 32) return false;
  const dashIdx = value.indexOf("-");
  if (dashIdx === -1) return SEMVER_CORE_RE.test(value);
  const core = value.slice(0, dashIdx);
  const pre = value.slice(dashIdx + 1);
  return SEMVER_CORE_RE.test(core) && SEMVER_PRE_RE.test(pre);
}

function isValidUtcIso(value: unknown): value is string {
  if (typeof value !== "string" || !value.endsWith("Z") || value.length < 20 || value.length > 24) {
    return false;
  }
  const withoutZ = value.slice(0, -1);
  const dotIdx = withoutZ.indexOf(".");
  if (dotIdx === -1) {
    return UTC_ISO_BASE_RE.test(withoutZ) && !Number.isNaN(Date.parse(value));
  }
  const base = withoutZ.slice(0, dotIdx);
  const ms = withoutZ.slice(dotIdx + 1);
  return UTC_ISO_BASE_RE.test(base) && UTC_MS_RE.test(ms) && !Number.isNaN(Date.parse(value));
}

export function validateStrictTelemetryPayload(
  raw: unknown,
): { ok: true; payload: Readonly<StrictTelemetryPayload> } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Telemetry payload must be a plain object." };
  }

  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_TELEMETRY_KEYS.has(key)) {
      return { ok: false, error: `Rejected unexpected telemetry field: ${key}` };
    }
  }

  if (obj.schema_version !== "2.0") {
    return { ok: false, error: "Invalid schema_version." };
  }
  if (typeof obj.event_kind !== "string" || !EVENT_KINDS.has(obj.event_kind as TelemetryEventKind)) {
    return { ok: false, error: "Invalid event_kind." };
  }
  if (
    typeof obj.lifecycle_state !== "string" ||
    !LIFECYCLE_STATES.has(obj.lifecycle_state as ExtensionLifecycleState)
  ) {
    return { ok: false, error: "Invalid lifecycle_state." };
  }
  if (typeof obj.device_id !== "string" || !DEVICE_ID_RE.test(obj.device_id)) {
    return { ok: false, error: "Invalid device_id." };
  }
  if (typeof obj.organization_id !== "string" || !ORG_ID_RE.test(obj.organization_id)) {
    return { ok: false, error: "Invalid organization_id." };
  }
  if (obj.seat_id !== undefined && (typeof obj.seat_id !== "string" || !UUID_RE.test(obj.seat_id))) {
    return { ok: false, error: "Invalid seat_id." };
  }
  if (
    obj.user_email_hash !== undefined &&
    (typeof obj.user_email_hash !== "string" || !SHA256_HEX_RE.test(obj.user_email_hash))
  ) {
    return { ok: false, error: "Invalid user_email_hash." };
  }
  if (
    obj.device_activation_hash !== undefined &&
    (typeof obj.device_activation_hash !== "string" || !SHA256_HEX_RE.test(obj.device_activation_hash))
  ) {
    return { ok: false, error: "Invalid device_activation_hash." };
  }
  if (!isBrowserFamily(obj.browser_family)) {
    return { ok: false, error: "Invalid browser_family." };
  }
  if (!isValidSemver(obj.extension_version)) {
    return { ok: false, error: "Invalid extension_version." };
  }
  if (typeof obj.policy_version !== "number" || !Number.isSafeInteger(obj.policy_version) || obj.policy_version < 0) {
    return { ok: false, error: "Invalid policy_version." };
  }
  if (obj.policy_hash !== undefined && (typeof obj.policy_hash !== "string" || !SHA256_HEX_RE.test(obj.policy_hash))) {
    return { ok: false, error: "Invalid policy_hash." };
  }
  if (typeof obj.policy_status !== "string" || !POLICY_STATUSES.has(obj.policy_status as TelemetryPolicyStatus)) {
    return { ok: false, error: "Invalid policy_status." };
  }
  if (typeof obj.health_status !== "string" || !HEALTH_STATUSES.has(obj.health_status as TelemetryHealthStatus)) {
    return { ok: false, error: "Invalid health_status." };
  }
  if (typeof obj.clean_shutdown_flag !== "boolean") {
    return { ok: false, error: "Invalid clean_shutdown_flag." };
  }
  if (obj.last_clean_shutdown_at !== undefined && !isValidUtcIso(obj.last_clean_shutdown_at)) {
    return { ok: false, error: "Invalid last_clean_shutdown_at." };
  }
  if (!isValidUtcIso(obj.timestamp)) {
    return { ok: false, error: "Invalid timestamp." };
  }

  const clean: StrictTelemetryPayload = {
    schema_version: "2.0",
    event_kind: obj.event_kind as TelemetryEventKind,
    lifecycle_state: obj.lifecycle_state as ExtensionLifecycleState,
    device_id: obj.device_id,
    organization_id: obj.organization_id,
    ...(obj.seat_id !== undefined ? { seat_id: obj.seat_id } : {}),
    ...(obj.user_email_hash !== undefined ? { user_email_hash: obj.user_email_hash } : {}),
    ...(obj.device_activation_hash !== undefined ? { device_activation_hash: obj.device_activation_hash } : {}),
    browser_family: obj.browser_family,
    extension_version: obj.extension_version,
    policy_version: obj.policy_version,
    ...(obj.policy_hash !== undefined ? { policy_hash: obj.policy_hash } : {}),
    policy_status: obj.policy_status as TelemetryPolicyStatus,
    health_status: obj.health_status as TelemetryHealthStatus,
    clean_shutdown_flag: obj.clean_shutdown_flag,
    ...(obj.last_clean_shutdown_at !== undefined ? { last_clean_shutdown_at: obj.last_clean_shutdown_at } : {}),
    timestamp: obj.timestamp,
  };

  return { ok: true, payload: Object.freeze(clean) };
}

export function buildStrictTelemetryPayload(input: StrictTelemetryPayload): Readonly<StrictTelemetryPayload> {
  const result = validateStrictTelemetryPayload(input);
  if (!result.ok) {
    throw new Error(`Telemetry schema violation: ${result.error}`);
  }
  return result.payload;
}

export const DEFAULT_HEARTBEAT_GRACE_WINDOW_MS = 35 * 60 * 1000;

export function classifyExtensionLifecycleState(input: {
  lastHeartbeatAtMs: number | null;
  lastCleanShutdownAtMs: number | null;
  cleanShutdownFlag: boolean;
  uninstalledAtMs: number | null;
  nowMs?: number;
  graceWindowMs?: number;
}): ExtensionLifecycleState {
  const nowMs = input.nowMs ?? Date.now();
  const graceWindowMs = input.graceWindowMs ?? DEFAULT_HEARTBEAT_GRACE_WINDOW_MS;

  if (input.uninstalledAtMs !== null) {
    return "uninstalled_or_terminated";
  }

  if (
    input.cleanShutdownFlag &&
    input.lastCleanShutdownAtMs !== null &&
    (input.lastHeartbeatAtMs === null || input.lastCleanShutdownAtMs >= input.lastHeartbeatAtMs - 120_000)
  ) {
    return "offline_clean_shutdown";
  }

  if (input.lastHeartbeatAtMs !== null && nowMs - input.lastHeartbeatAtMs <= graceWindowMs) {
    return "online";
  }

  return "uninstalled_or_terminated";
}

export function buildUninstallSignalUrl(
  baseCoordinatorUrl: string,
  params: {
    organizationId: string;
    deviceId: string;
    browserFamily: BrowserFamily;
    activationHash?: string;
  },
): string | null {
  try {
    const parsed = new URL(baseCoordinatorUrl);
    if (parsed.protocol !== "https:") return null;
    if (!ORG_ID_RE.test(params.organizationId) || !DEVICE_ID_RE.test(params.deviceId)) return null;
    if (!isBrowserFamily(params.browserFamily)) return null;

    const path = parsed.hostname.toLowerCase().endsWith(".supabase.co")
      ? "/functions/v1/uninstall-signal"
      : "/api/v1/management/uninstall";
    const url = new URL(`${parsed.origin}${path}`);
    url.searchParams.set("event", "uninstall");
    url.searchParams.set("org", params.organizationId);
    url.searchParams.set("device", params.deviceId);
    url.searchParams.set("browser", params.browserFamily);
    if (params.activationHash && SHA256_HEX_RE.test(params.activationHash)) {
      url.searchParams.set("activation", params.activationHash.slice(0, 16));
    }
    return url.toString();
  } catch {
    return null;
  }
}
