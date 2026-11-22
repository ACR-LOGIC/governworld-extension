// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.

/**
 * Staged-document storage shared by the popup and the service worker.
 *
 * Both contexts run on the same extension origin, so they read and write the
 * same database; that is the only reason a file picked in the popup can be
 * picked back up by the worker.
 *
 * This lives in one place on purpose. The popup and the worker previously each
 * carried its own copy of `openDb`, and the copies drifted into a failure
 * mode where the cached connection went stale and every later transaction
 * threw forever, silently disabling the whole extension.
 */

const DB_NAME = "governworld-redaction";
const DB_VERSION = 1;
const STORE = "docfiles";

/**
 * Session-scoped marker: a document has been staged and must not be purged.
 *
 * The lifecycle purge clears the entire object store. A document is in that
 * store, so a purge that started after the popup staged one destroyed it and the
 * preview failed with "The selected file is no longer available." — for a file
 * the user could see selected on screen. Awaiting the purge before reading the
 * document did not help; it made the outcome certain, because the purge then
 * always finished before the read.
 *
 * `chrome.storage.session` rather than a module-level boolean, because the write
 * happens in the popup and the decision is made in the service worker: in-memory
 * state is per-context and cannot carry a fact between them. It is session-scoped
 * on purpose — a stale marker must not survive a restart into a session that has
 * staged nothing.
 */
const STAGED_MARKER_KEY = "docStagedMarker";
const STAGED_FILE_KEY = "docStagedFileKey";

export interface StagedPrefixStats {
  keyCount: number;
  bytes: number;
}

export interface StagedDataStats {
  keyCount: number;
  totalBytes: number;
  byPrefix: Record<string, StagedPrefixStats>;
}

export async function markDocumentStaged(fileKey?: string): Promise<void> {
  try {
    const payload: Record<string, unknown> = { [STAGED_MARKER_KEY]: Date.now() };
    if (fileKey) payload[STAGED_FILE_KEY] = fileKey;
    await chrome.storage.session.set(payload);
  } catch {
    // Best-effort. If this fails the purge may delete a staged document, which
    // the user can recover from by picking the file again; failing the pick
    // outright would be worse than losing the housekeeping optimisation.
  }
}

export async function isDocumentStaged(): Promise<boolean> {
  try {
    const raw = await chrome.storage.session.get(STAGED_MARKER_KEY);
    return typeof raw[STAGED_MARKER_KEY] === "number";
  } catch {
    return false;
  }
}

export async function getStagedFileKey(): Promise<string | null> {
  try {
    const raw = await chrome.storage.session.get(STAGED_FILE_KEY);
    const val = raw[STAGED_FILE_KEY];
    return typeof val === "string" && val.length > 0 ? val : null;
  } catch {
    return null;
  }
}

/** Clear the marker, e.g. once every staged document has been discarded. */
export async function clearStagedMarker(): Promise<void> {
  try {
    await chrome.storage.session.remove([STAGED_MARKER_KEY, STAGED_FILE_KEY]);
  } catch {
    // Nothing to do: the marker is session-scoped and expires with the session.
  }
}

let dbPromise: Promise<IDBDatabase> | null = null;

const OPEN_TIMEOUT_MS = 5_000;
const OP_TIMEOUT_MS = 10_000;

/**
 * Open (or reuse) the database connection.
 *
 * A cached `IDBDatabase` can stop being usable: another context upgrades the
 * schema, or the browser closes it under pressure. A cached promise keeps
 * handing out that dead connection, and every subsequent transaction throws
 * `InvalidStateError` for the life of the context. Dropping the cache on
 * `close`/`versionchange` is what makes the next call reconnect instead.
 *
 * The open is also bounded, and a `blocked` request fails fast. An
 * `indexedDB.open` blocked by another open connection fires neither `success`
 * nor `error`, so the cached promise would stay pending for the life of the
 * context and every caller would await it forever. That produced the worst
 * symptom in this extension: the popup looked completely inert, with no error
 * anywhere and no console output. Nothing in this module may hang.
 */
export function openDocDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      // Leave the cache clean so the next caller gets a fresh attempt.
      dbPromise = null;
      settle(() => reject(new Error("Local document storage did not respond.")));
    }, OPEN_TIMEOUT_MS);
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (error) {
      dbPromise = null;
      settle(() => reject(error instanceof Error ? error : new Error(String(error))));
      return;
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onclose = () => {
        dbPromise = null;
      };
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      settle(() => resolve(db));
    };
    req.onerror = () => {
      dbPromise = null;
      settle(() => reject(req.error ?? new Error("IndexedDB is unavailable")));
    };
    req.onblocked = () => {
      // Another open connection is holding an older version and has not
      // released it. Report it as a retryable failure instead of waiting for
      // an event that will never arrive.
      dbPromise = null;
      settle(() => reject(new Error("Local document storage is busy.")));
    };
  });
  return dbPromise;
}

/** Drop the cached connection so the next operation reconnects. */
export function resetDocDb(): void {
  dbPromise = null;
}

/**
 * Run one write transaction, reconnecting and retrying once, and resolve only
 * once it has committed.
 *
 * The retry covers a dead cached handle: the first attempt throws, the second
 * runs against a fresh connection. The timeout covers a transaction that is
 * created but never completes - a stalled commit must surface as an error, not
 * as a caller that waits forever.
 */
async function commitWrite(commit: (tx: IDBTransaction) => void, label: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const db = await openDocDb();
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error(`Could not ${label}: storage did not respond.`));
        }, OP_TIMEOUT_MS);
        const settle = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn();
        };
        let tx: IDBTransaction;
        try {
          tx = db.transaction(STORE, "readwrite");
        } catch (error) {
          settle(() => reject(error));
          return;
        }
        tx.oncomplete = () => settle(resolve);
        tx.onabort = () => settle(() => reject(tx.error ?? new Error(`Could not ${label}`)));
        tx.onerror = () => settle(() => reject(tx.error ?? new Error(`Could not ${label}`)));
        try {
          commit(tx);
        } catch (error) {
          settle(() => reject(error));
        }
      });
      return;
    } catch (error) {
      lastError = error;
      resetDocDb();
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function docStoreFile(fileKey: string, bytes: ArrayBuffer): Promise<void> {
  await commitWrite((tx) => tx.objectStore(STORE).put(bytes, fileKey), "store the file");
}

export async function docDeleteFile(fileKey: string): Promise<void> {
  await commitWrite((tx) => tx.objectStore(STORE).delete(fileKey), "delete the file");
}

export async function docClearFiles(): Promise<void> {
  await commitWrite((tx) => tx.objectStore(STORE).clear(), "clear document files");
}

async function executeRead<T>(
  op: (store: IDBObjectStore, resolve: (value: T) => void, reject: (err: unknown) => void) => void,
  label: string
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const db = await openDocDb();
    try {
      return await new Promise<T>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error(`Could not ${label}: storage did not respond.`));
        }, OP_TIMEOUT_MS);
        const settleResolve = (value: T): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        };
        const settleReject = (err: unknown): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        };
        let tx: IDBTransaction;
        try {
          tx = db.transaction(STORE, "readonly");
        } catch (error) {
          settleReject(error);
          return;
        }
        tx.onabort = () => settleReject(tx.error ?? new Error(`Could not ${label}`));
        tx.onerror = () => settleReject(tx.error ?? new Error(`Could not ${label}`));
        try {
          op(tx.objectStore(STORE), settleResolve, settleReject);
        } catch (error) {
          settleReject(error);
        }
      });
    } catch (error) {
      lastError = error;
      resetDocDb();
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function docListKeys(): Promise<string[]> {
  return executeRead<string[]>((store, resolve, reject) => {
    const req = store.getAllKeys();
    req.onsuccess = () => resolve(Array.from(req.result ?? [], (k) => String(k)));
    req.onerror = () => reject(req.error ?? new Error("Could not list staged keys"));
  }, "list staged keys");
}

export async function docDeleteByPrefix(
  prefix: string,
  options?: { keepRedacted?: boolean }
): Promise<number> {
  if (!prefix) return 0;
  let deleted = 0;
  await commitWrite((tx) => {
    const store = tx.objectStore(STORE);
    const req = store.getAllKeys();
    req.onsuccess = () => {
      const keys = req.result ?? [];
      for (const rawKey of keys) {
        const key = String(rawKey);
        if (
          options?.keepRedacted &&
          (key.startsWith(`${prefix}::redacted::`) || key === `${prefix}::redacted-manifest`)
        ) {
          continue;
        }
        if (key === prefix || key.startsWith(`${prefix}::`)) {
          store.delete(rawKey);
          deleted += 1;
        }
      }
    };
  }, "delete staged document keys");
  return deleted;
}

export async function docGetStagedStats(): Promise<StagedDataStats> {
  return executeRead<StagedDataStats>((store, resolve, reject) => {
    const stats: StagedDataStats = { keyCount: 0, totalBytes: 0, byPrefix: {} };
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve(stats);
        return;
      }
      const key = String(cursor.key);
      const val = cursor.value;
      const bytes = val instanceof ArrayBuffer ? val.byteLength : ArrayBuffer.isView(val) ? val.byteLength : 0;
      const rootPrefix = key.split("::")[0] || key;
      stats.keyCount += 1;
      stats.totalBytes += bytes;
      const entry = stats.byPrefix[rootPrefix] ?? { keyCount: 0, bytes: 0 };
      entry.keyCount += 1;
      entry.bytes += bytes;
      stats.byPrefix[rootPrefix] = entry;
      cursor.continue();
    };
    req.onerror = () => reject(req.error ?? new Error("Could not inspect staged storage"));
  }, "inspect staged storage");
}

export async function docReadFile(fileKey: string): Promise<ArrayBuffer | null> {
  return executeRead<ArrayBuffer | null>((store, resolve, reject) => {
    const req = store.get(fileKey);
    req.onsuccess = () => resolve((req.result as ArrayBuffer | undefined) ?? null);
    req.onerror = () => reject(req.error ?? new Error("Could not read the file"));
  }, "read the file");
}
