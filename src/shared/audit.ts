// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { isRecord } from "./types.js";

/**
 * Metadata-only, tamper-evident audit trail. Every recorded event contains
 * counts, hashes, and policy references — never raw detected values or page
 * content (zero raw-data persistence invariant).
 *
 * Events live in chrome.storage.local (ring buffer). Export produces JSONL
 * plus a detached ECDSA P-256/SHA-256 signature over the exact exported bytes,
 * so a reviewer can verify nothing was altered after the fact.
 */

export const AUDIT_KEY = "auditLog";
export const AUDIT_MAX_EVENTS = 500;

export type AuditAction =
  | "page_scan_completed"
  | "masks_applied"
  | "masks_removed"
  | "selection_redacted"
  | "selection_masked"
  | "doc_previewed"
  | "doc_redacted"
  | "doc_cleared"
  | "session_cleared"
  | "preset_applied"
  | "preset_overridden"
  | "account_linked";

/**
 * The authoritative action list.
 *
 * It is a single source of truth on purpose: the union above and the runtime
 * guard in `isAuditEvent` used to be two hand-maintained lists of the same
 * values. Adding an action to one but not the other produced an event that
 * typechecked and was then silently dropped by the validator, so the action
 * looked audited and was not.
 */
export const AUDIT_ACTIONS: readonly AuditAction[] = [
  "page_scan_completed",
  "masks_applied",
  "masks_removed",
  "selection_redacted",
  "selection_masked",
  "doc_previewed",
  "doc_redacted",
  "doc_cleared",
  "session_cleared",
  "preset_applied",
  "preset_overridden",
  "account_linked",
];

export function isAuditAction(value: unknown): value is AuditAction {
  return typeof value === "string" && (AUDIT_ACTIONS as readonly string[]).includes(value);
}

export interface AuditEvent {
  /** ISO-8601 timestamp. */
  ts: string;
  action: AuditAction;
  /** Host of the scanned page, when applicable (never full URL). */
  host?: string;
  /** Findings surfaced, by category. Counts only. */
  counts?: Record<string, number>;
  /** SHA-256 hex of processed document bytes, when applicable. */
  docHash?: string;
  /** Number of pages processed. */
  pages?: number;
  /** Preset selected by the user (metadata only, never content). */
  presetId?: string;
  /** Gateway origin linked at account_linked time (metadata only, never the key). */
  gatewayOrigin?: string;
  /** Category set active after the change — policy references, never content. */
  enabledCategories?: string[];
  prevHash?: string;
  outcome: "ok" | "denied" | "error";
}

function isCounts(value: unknown): value is Record<string, number> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0);
}

export function isAuditEvent(value: unknown): value is AuditEvent {
  if (!isRecord(value)) return false;
  if (typeof value.ts !== "string" || value.ts.length === 0) return false;
  if (!isAuditAction(value.action)) return false;
  if (value.outcome !== "ok" && value.outcome !== "denied" && value.outcome !== "error") return false;
  if (value.host !== undefined && (typeof value.host !== "string" || value.host.length === 0 || value.host.length > 253)) return false;
  if (value.counts !== undefined && !isCounts(value.counts)) return false;
  if (value.docHash !== undefined && (typeof value.docHash !== "string" || !/^[a-f0-9]{64}$/.test(value.docHash))) return false;
  if (value.pages !== undefined && (typeof value.pages !== "number" || !Number.isInteger(value.pages) || value.pages < 0)) return false;
  if (value.presetId !== undefined && (typeof value.presetId !== "string" || value.presetId.length === 0 || value.presetId.length > 32)) return false;
  if (
    value.gatewayOrigin !== undefined &&
    (typeof value.gatewayOrigin !== "string" ||
      value.gatewayOrigin.length === 0 ||
      value.gatewayOrigin.length > 2048 ||
      !value.gatewayOrigin.startsWith("https://"))
  )
    return false;
  if (
    value.enabledCategories !== undefined &&
    (!Array.isArray(value.enabledCategories) ||
      value.enabledCategories.some((c) => typeof c !== "string" || c.length === 0 || c.length > 64))
  ) {
    return false;
  }
  if (value.prevHash !== undefined && (typeof value.prevHash !== "string" || !/^[a-f0-9]{64}$/.test(value.prevHash))) {
    return false;
  }
  return true;
}

/** Canonical serialization: stable key order so signatures are reproducible. */
export function canonicalEventLine(event: AuditEvent): string {
  const ordered: Record<string, unknown> = {};
  for (const key of ["ts", "action", "host", "counts", "docHash", "pages", "presetId", "gatewayOrigin", "enabledCategories", "prevHash", "outcome"] as const) {
    if (event[key] !== undefined) ordered[key] = event[key];
  }
  return JSON.stringify(ordered);
}

export function toAuditJsonl(events: AuditEvent[]): string {
  return events.map(canonicalEventLine).join("\n");
}

/** Trim to the newest AUDIT_MAX_EVENTS entries. */
export function trimEvents(events: AuditEvent[]): AuditEvent[] {
  if (events.length <= AUDIT_MAX_EVENTS) return events;
  return events.slice(events.length - AUDIT_MAX_EVENTS);
}

// ---------- Storage (service worker side) ----------

export async function loadAuditLog(): Promise<AuditEvent[]> {
  const raw = await chrome.storage.local.get(AUDIT_KEY);
  const value = raw[AUDIT_KEY];
  if (!Array.isArray(value)) return [];
  return value.filter(isAuditEvent);
}

export async function sha256Hex(data: string): Promise<string> {
  const bytes = new TextEncoder().encode(data);
  const hashBuf = await crypto.subtle.digest("SHA-256", bytes);
  const hashArray = Array.from(new Uint8Array(hashBuf));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ChainVerificationResult {
  valid: boolean;
  brokenIndex?: number;
  reason?: string;
}

export async function verifyAuditChain(events: AuditEvent[]): Promise<ChainVerificationResult> {
  if (events.length === 0) return { valid: true };

  // Detect prefix truncation: if the first event carries a prevHash, preceding history was deleted or pruned
  const isChainedLog = events.some((e) => e.prevHash !== undefined);
  if (isChainedLog && events[0].prevHash !== undefined) {
    return {
      valid: false,
      brokenIndex: 0,
      reason: "Prefix history truncated: genesis event at index 0 carries prevHash pointing to prior deleted event",
    };
  }

  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1];
    const current = events[i];
    if (isChainedLog) {
      if (current.prevHash === undefined) {
        return {
          valid: false,
          brokenIndex: i,
          reason: `Missing prevHash at index ${i} in a hash-chained log`,
        };
      }
      const expected = await sha256Hex(canonicalEventLine(prev));
      if (current.prevHash !== expected) {
        return {
          valid: false,
          brokenIndex: i,
          reason: `Hash chain mismatch at index ${i}: expected prevHash ${expected}, got ${current.prevHash}`,
        };
      }
    }
  }
  return { valid: true };
}

export interface RecordAuditOptions {
  /**
   * When true, persistence errors reject the returned promise.
   * Required for protected release operations (such as document redaction and clipboard copy).
   */
  failClosed?: boolean;
}

let isAuditWriting = false;
const auditWriteWaiters: Array<() => void> = [];

async function acquireAuditLock(): Promise<void> {
  if (!isAuditWriting) {
    isAuditWriting = true;
    return;
  }
  await new Promise<void>((resolve) => {
    auditWriteWaiters.push(resolve);
  });
}

function releaseAuditLock(): void {
  const next = auditWriteWaiters.shift();
  if (next) {
    next();
  } else {
    isAuditWriting = false;
  }
}

export async function recordAudit(event: AuditEvent, options?: RecordAuditOptions): Promise<void> {
  await acquireAuditLock();
  try {
    const events = await loadAuditLog();
    if (!event.prevHash && events.length > 0) {
      const last = events[events.length - 1];
      event.prevHash = await sha256Hex(canonicalEventLine(last));
    }
    events.push(event);
    await chrome.storage.local.set({ [AUDIT_KEY]: trimEvents(events) });
  } catch (err) {
    if (options?.failClosed) {
      throw err;
    }
    // Best-effort for non-release events (scans, previews, UI mode changes)
  } finally {
    releaseAuditLock();
  }
}

export async function clearAuditLog(): Promise<void> {
  await chrome.storage.local.remove(AUDIT_KEY);
}

// ---------- Signing keys (IndexedDB; non-extractable private key) ----------

const KEY_DB_NAME = "governworld-audit";
const KEY_STORE = "signing-keys";
const KEY_ID = "audit-signing";

let dbPromise: Promise<IDBDatabase> | null = null;

function openKeyDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(KEY_DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(KEY_STORE)) req.result.createObjectStore(KEY_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB is unavailable"));
  });
  return dbPromise;
}

async function withKeyStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openKeyDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(KEY_STORE, mode);
    const req = fn(tx.objectStore(KEY_STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error ?? new Error("Key store transaction failed"));
  });
}

export interface AuditSigningKeys {
  privateKey: CryptoKey;
  publicKeyJwk: JsonWebKey;
}

interface StoredSigningKeys {
  privateKey: CryptoKey;
  publicKeyJwk: JsonWebKey;
}

let keyGenPromise: Promise<AuditSigningKeys> | null = null;

async function getOrCreateSigningKeys(): Promise<AuditSigningKeys> {
  if (keyGenPromise) return keyGenPromise;
  keyGenPromise = (async () => {
    const existing = await withKeyStore<StoredSigningKeys | undefined>("readonly", (s) => s.get(KEY_ID));
    if (existing && existing.privateKey instanceof CryptoKey) {
      return { privateKey: existing.privateKey, publicKeyJwk: existing.publicKeyJwk };
    }
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const publicKeyJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const stored: StoredSigningKeys = { privateKey: pair.privateKey, publicKeyJwk };
    await withKeyStore("readwrite", (s) => s.put(stored, KEY_ID));
    return { privateKey: pair.privateKey, publicKeyJwk };
  })();
  try {
    return await keyGenPromise;
  } finally {
    keyGenPromise = null;
  }
}

export const AUDIT_CHECKPOINT_KEY = "auditCheckpointState";

export interface AuditCheckpoint {
  checkpointVersion: 1;
  sequenceNumber: number;
  timestamp: string;
  eventCount: number;
  headHash: string;
  prevCheckpointHash?: string;
}

export function canonicalCheckpointLine(cp: AuditCheckpoint): string {
  const ordered: Record<string, unknown> = {
    checkpointVersion: cp.checkpointVersion,
    eventCount: cp.eventCount,
    headHash: cp.headHash,
  };
  if (cp.prevCheckpointHash !== undefined) {
    ordered.prevCheckpointHash = cp.prevCheckpointHash;
  }
  ordered.sequenceNumber = cp.sequenceNumber;
  ordered.timestamp = cp.timestamp;
  return JSON.stringify(ordered);
}

export interface SignedAuditExport {
  jsonl: string;
  signatureBase64: string;
  publicKeyJwk: JsonWebKey;
  exportedAt: string;
  eventCount: number;
  checkpoint?: AuditCheckpoint;
  checkpointSignatureBase64?: string;
}

export interface VerifyAuditExportOptions {
  minSequenceNumber?: number;
  expectedHeadHash?: string;
}

/**
 * Export + sign in one step. The signature covers the exact JSONL bytes
 * (UTF-8), so any post-export edit breaks verification.
 * Checkpoint anchoring provides monotonic sequence numbering to resist rollback attacks.
 */
export async function exportSignedAuditLog(): Promise<SignedAuditExport> {
  await acquireAuditLock();
  try {
    const events = await loadAuditLog();
    const jsonl = toAuditJsonl(events);
    const { privateKey, publicKeyJwk } = await getOrCreateSigningKeys();
    const data = new TextEncoder().encode(jsonl);
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, data);

    const headHash =
      events.length > 0
        ? await sha256Hex(canonicalEventLine(events[events.length - 1]))
        : "0".repeat(64);

    let seq = 1;
    let prevCheckpointHash: string | undefined = undefined;
    try {
      if (typeof chrome !== "undefined" && chrome?.storage?.local) {
        const raw = await chrome.storage.local.get(AUDIT_CHECKPOINT_KEY);
        const state = raw[AUDIT_CHECKPOINT_KEY];
        if (isRecord(state) && typeof state.lastSequenceNumber === "number") {
          seq = state.lastSequenceNumber + 1;
          if (typeof state.lastCheckpointHash === "string") {
            prevCheckpointHash = state.lastCheckpointHash;
          }
        }
      }
    } catch {
      // storage unavailable or mocked
    }

    const exportedAt = new Date().toISOString();
    const checkpoint: AuditCheckpoint = {
      checkpointVersion: 1,
      sequenceNumber: seq,
      timestamp: exportedAt,
      eventCount: events.length,
      headHash,
      prevCheckpointHash,
    };

    const cpData = new TextEncoder().encode(canonicalCheckpointLine(checkpoint));
    const cpSig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, cpData);
    const currentCpHash = await sha256Hex(canonicalCheckpointLine(checkpoint));

    try {
      if (typeof chrome !== "undefined" && chrome?.storage?.local) {
        await chrome.storage.local.set({
          [AUDIT_CHECKPOINT_KEY]: {
            lastSequenceNumber: seq,
            lastCheckpointHash: currentCpHash,
          },
        });
      }
    } catch {
      // Best-effort state persistence
    }

    return {
      jsonl,
      signatureBase64: btoa(String.fromCharCode(...new Uint8Array(signature))),
      publicKeyJwk,
      exportedAt,
      eventCount: events.length,
      checkpoint,
      checkpointSignatureBase64: btoa(String.fromCharCode(...new Uint8Array(cpSig))),
    };
  } finally {
    releaseAuditLock();
  }
}

/** Verify an export against its public key (used by tests and reviewers). */
export async function verifySignedAuditExport(
  exported: SignedAuditExport,
  options?: VerifyAuditExportOptions
): Promise<boolean> {
  try {
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      exported.publicKeyJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
    const data = new TextEncoder().encode(exported.jsonl);
    const sigBytes = Uint8Array.from(atob(exported.signatureBase64), (c) => c.charCodeAt(0));
    const sigValid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, sigBytes, data);
    if (!sigValid) return false;

    if (exported.checkpoint) {
      if (exported.checkpoint.checkpointVersion !== 1) return false;
      if (options?.minSequenceNumber !== undefined && exported.checkpoint.sequenceNumber < options.minSequenceNumber) {
        return false;
      }
      if (options?.expectedHeadHash !== undefined && exported.checkpoint.headHash !== options.expectedHeadHash) {
        return false;
      }
      if (exported.checkpointSignatureBase64) {
        const cpData = new TextEncoder().encode(canonicalCheckpointLine(exported.checkpoint));
        const cpSigBytes = Uint8Array.from(atob(exported.checkpointSignatureBase64), (c) => c.charCodeAt(0));
        const cpValid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, cpSigBytes, cpData);
        if (!cpValid) return false;
      }
    }

    // Verify hash chain of events in jsonl
    const lines = exported.jsonl.split("\n").filter((l) => l.trim().length > 0);
    const events: AuditEvent[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (!isAuditEvent(parsed)) return false;
        events.push(parsed);
      } catch {
        return false;
      }
    }

    if (exported.checkpoint) {
      if (events.length !== exported.checkpoint.eventCount) return false;
      const expectedHead =
        events.length > 0
          ? await sha256Hex(canonicalEventLine(events[events.length - 1]))
          : "0".repeat(64);
      if (exported.checkpoint.headHash !== expectedHead) return false;
    }

    const chainCheck = await verifyAuditChain(events);
    return chainCheck.valid;
  } catch {
    return false;
  }
}
