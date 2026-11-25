// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

interface FakeReq {
  result: unknown;
  error: unknown;
  onsuccess: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
}

function createInMemoryIndexedDb(backing: Map<string, unknown>) {
  // This fake used to ignore store names and kept one flat map; the document
  // store now also has a `docfilemeta` store for write timestamps, so keys are
  // namespaced per store to keep the two namespaces apart.
  const storeKey = (storeName: string, key: string): string => `${storeName}::${key}`;

  const mkReq = (compute: () => unknown): FakeReq => {
    const req: FakeReq = { result: undefined, error: null, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      try {
        req.result = compute();
        req.onsuccess?.();
      } catch (err) {
        req.error = err;
        req.onerror?.();
      }
    });
    return req;
  };

  const makeStore = (storeName: string) => ({
    put(val: unknown, key: string) {
      backing.set(storeKey(storeName, String(key)), val);
      return mkReq(() => key);
    },
    get(key: string) {
      return mkReq(() => backing.get(storeKey(storeName, String(key))));
    },
    delete(key: string) {
      backing.delete(storeKey(storeName, String(key)));
      return mkReq(() => undefined);
    },
    clear() {
      backing.clear();
      return mkReq(() => undefined);
    },
    getAllKeys() {
      const prefix = `${storeName}::`;
      return mkReq(() =>
        Array.from(backing.keys())
          .filter((k) => k.startsWith(prefix))
          .map((k) => k.slice(prefix.length)),
      );
    },
    openCursor() {
      const prefix = `${storeName}::`;
      const entries = Array.from(backing.entries())
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, v]) => [k.slice(prefix.length), v] as [string, unknown]);
      let idx = 0;
      const req: FakeReq = { result: null, error: null, onsuccess: null, onerror: null };
      const emit = () => {
        queueMicrotask(() => {
          if (idx >= entries.length) {
            req.result = null;
            req.onsuccess?.();
            return;
          }
          const [key, value] = entries[idx++];
          req.result = {
            key,
            value,
            continue: emit,
          };
          req.onsuccess?.();
        });
      };
      emit();
      return req;
    },
  });

  return {
    open() {
      const openReq: Record<string, unknown> = {
        result: {
          objectStoreNames: { contains: () => true },
          createObjectStore: () => ({}),
          close: () => {},
          transaction: () => {
            const tx: Record<string, unknown> = {
              oncomplete: null,
              onabort: null,
              onerror: null,
              error: null,
              objectStore: (name: string) => makeStore(String(name)),
            };
            // Resolve transaction after microtask ops finish
            setTimeout(() => (tx.oncomplete as (() => void) | null)?.(), 5);
            return tx;
          },
        },
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        onblocked: null,
      };
      queueMicrotask(() => (openReq.onsuccess as (() => void) | null)?.());
      return openReq;
    },
  };
}

describe("P4: Staged Document Prefix Deletion, Cooperative Abort & Startup Orphan Purge", () => {
  const backing = new Map<string, unknown>();
  const sessionStore = new Map<string, unknown>();
  let origIndexedDB: unknown;
  let origChrome: unknown;

  beforeEach(async () => {
    backing.clear();
    sessionStore.clear();
    vi.resetModules();
    origIndexedDB = (globalThis as Record<string, unknown>).indexedDB;
    origChrome = (globalThis as Record<string, unknown>).chrome;
    (globalThis as Record<string, unknown>).indexedDB = createInMemoryIndexedDb(backing);
    (globalThis as Record<string, unknown>).chrome = {
      runtime: {
        id: "test-ext",
        getURL: (p: string) => `chrome-extension://test-ext/${p}`,
        sendMessage: vi.fn().mockResolvedValue({}),
        onConnect: { addListener: vi.fn() },
        onMessage: { addListener: vi.fn() },
      },
      storage: {
        session: {
          get: vi.fn(async (keys?: string | string[]) => {
            if (!keys) return Object.fromEntries(sessionStore.entries());
            const list = Array.isArray(keys) ? keys : [keys];
            const res: Record<string, unknown> = {};
            for (const k of list) if (sessionStore.has(k)) res[k] = sessionStore.get(k);
            return res;
          }),
          set: vi.fn(async (items: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(items)) sessionStore.set(k, v);
          }),
          remove: vi.fn(async (keys: string | string[]) => {
            const list = Array.isArray(keys) ? keys : [keys];
            for (const k of list) sessionStore.delete(k);
          }),
        },
        local: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
        },
      },
      offscreen: {
        closeDocument: vi.fn().mockResolvedValue(undefined),
        createDocument: vi.fn().mockResolvedValue(undefined),
      },
    };
    const { resetDocDb } = await import("../src/shared/docDb.js");
    resetDocDb();
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).indexedDB = origIndexedDB;
    (globalThis as Record<string, unknown>).chrome = origChrome;
    vi.restoreAllMocks();
  });

  it("docDeleteByPrefix & deleteDocBytesByPrefix delete source, ::preview::, ::page::, and ::redacted:: keys while sparing other docs", async () => {
    const { docStoreFile, docListKeys, docDeleteByPrefix, docGetStagedStats } = await import("../src/shared/docDb.js");
    const { deleteDocBytesByPrefix, listDocKeys, previewKey, pageImageKey, redactedKey, redactedManifestKey } = await import("../src/shared/docStore.js");

    const sample = new Uint8Array([1, 2, 3, 4]).buffer;
    await docStoreFile("jobA", sample);
    await docStoreFile(previewKey("jobA", 0), sample);
    await docStoreFile(pageImageKey("jobA", 0), sample);
    await docStoreFile(previewKey("jobA", 1), sample);
    await docStoreFile(pageImageKey("jobA", 1), sample);
    await docStoreFile(redactedKey("jobA", 0), sample);
    await docStoreFile(redactedManifestKey("jobA"), sample);
    await docStoreFile("jobB", sample);
    await docStoreFile(previewKey("jobB", 0), sample);

    const statsBefore = await docGetStagedStats();
    expect(statsBefore.keyCount).toBe(9);
    expect(statsBefore.totalBytes).toBe(36);

    const deletedA = await docDeleteByPrefix("jobA");
    expect(deletedA).toBe(7);
    expect(await docListKeys()).toEqual(["jobB", "jobB::preview::0"]);

    const deletedB = await deleteDocBytesByPrefix("jobB");
    expect(deletedB).toBe(2);
    expect(await listDocKeys()).toEqual([]);
  });

  it("purgeOrphanedStagedKeys deletes unreferenced orphan keys on startup while preserving active persisted session keys", async () => {
    const { docStoreFile, docListKeys } = await import("../src/shared/docDb.js");
    const { previewKey, pageImageKey } = await import("../src/shared/docStore.js");
    const { purgeOrphanedStagedKeys } = await import("../src/service-worker/documents.js");

    const buf = new Uint8Array([9, 8, 7]).buffer;
    await docStoreFile("orphanJob", buf);
    await docStoreFile(previewKey("orphanJob", 0), buf);
    await docStoreFile(pageImageKey("orphanJob", 0), buf);
    await docStoreFile("liveJob", buf);
    await docStoreFile(previewKey("liveJob", 0), buf);

    sessionStore.set("lastDocSession", {
      docId: "doc-live",
      fileKey: "liveJob",
      name: "live.pdf",
      mimeType: "application/pdf",
      kind: "pdf",
      pages: [],
      categories: [],
    });

    const deleted = await purgeOrphanedStagedKeys();
    expect(deleted).toBe(3);
    expect(await docListKeys()).toEqual(["liveJob", "liveJob::preview::0"]);
  });

  it("validates POPUP_DOC_CANCEL and POPUP_DOC_CLEAR with either docId or fileKey", async () => {
    const { validateMessage } = await import("../src/shared/messages.js");
    expect(validateMessage({ type: "POPUP_DOC_CANCEL", requestId: "r1", fileKey: "fk-123" }).ok).toBe(true);
    expect(validateMessage({ type: "POPUP_DOC_CANCEL", requestId: "r2", docId: "d-1" }).ok).toBe(true);
    expect(validateMessage({ type: "POPUP_DOC_CANCEL", requestId: "r3" }).ok).toBe(false);
    expect(validateMessage({ type: "POPUP_DOC_CLEAR", requestId: "r4", fileKey: "fk-123" }).ok).toBe(true);
    expect(validateMessage({ type: "POPUP_DOC_CLEAR", requestId: "r5" }).ok).toBe(false);
  });

  it("runDocumentPreview aborts via AbortSignal before completing and removes partial per-page keys", async () => {
    const controller = new AbortController();
    // Abort immediately once OCR is entered so mid-job cancellation leaves 0 keys
    vi.doMock("../src/document-pipeline/image.js", () => ({
      loadImagePage: async () => ({
        index: 0,
        canvas: document.createElement("canvas"),
        widthPx: 100,
        heightPx: 100,
        widthPt: 72,
        heightPt: 72,
        hasTextLayer: false,
        tokens: null,
      }),
    }));
    vi.doMock("../src/document-pipeline/ocr.js", () => ({
      ocrCanvas: async (_c: unknown, _idx: number, _lang: string, sig?: AbortSignal) => {
        controller.abort();
        if (sig?.aborted) {
          const { DocumentCancelledError } = await import("../src/document-pipeline/contract.js");
          throw new DocumentCancelledError();
        }
        return { pageIndex: 0, widthPx: 100, heightPx: 100, tokens: [], fullText: "" };
      },
      resetOcr: async () => undefined,
    }));

    const { runDocumentPreview } = await import("../src/document-pipeline/impl.js");
    const { DocumentCancelledError } = await import("../src/document-pipeline/contract.js");
    const { docStoreFile, docListKeys } = await import("../src/shared/docDb.js");

    await docStoreFile("abortKey", new Uint8Array([1, 2, 3]).buffer);
    await expect(
      runDocumentPreview(
        {
          kind: "image",
          bytes: new Uint8Array([1, 2, 3]).buffer,
          name: "scan.png",
          mimeType: "image/png",
          enabledCategories: ["ssn"],
          maxPages: 20,
          previewKeyPrefix: "abortKey",
        },
        controller.signal
      )
    ).rejects.toThrowError(DocumentCancelledError);

    expect(await docListKeys()).toEqual([]);
  });

  it("C2: getStagedStorageAudit & purgeStagedData report exact live vs orphan bytes and purge cleanly", async () => {
    const { docStoreFile, docListKeys } = await import("../src/shared/docDb.js");
    const { previewKey } = await import("../src/shared/docStore.js");
    const { getStagedStorageAudit, purgeStagedData } = await import("../src/service-worker/documents.js");
    const { validateMessage } = await import("../src/shared/messages.js");

    await docStoreFile("orphanDoc", new Uint8Array(1024).buffer);
    await docStoreFile(previewKey("orphanDoc", 0), new Uint8Array(2048).buffer);
    await docStoreFile("activeDoc", new Uint8Array(4096).buffer);
    await docStoreFile(previewKey("activeDoc", 0), new Uint8Array(4096).buffer);

    sessionStore.set("lastDocSession", {
      docId: "doc-active",
      fileKey: "activeDoc",
      name: "active.pdf",
      mimeType: "application/pdf",
      kind: "pdf",
      pages: [],
      categories: [],
    });

    const auditBefore = await getStagedStorageAudit();
    expect(auditBefore).toEqual({
      totalKeys: 4,
      totalBytes: 11264,
      liveKeys: 2,
      liveBytes: 8192,
      orphanKeys: 2,
      orphanBytes: 3072,
      hasInFlightJob: false,
    });

    // 1. Orphan-only purge (preserving live session)
    const orphanPurge = await purgeStagedData({ includeIdleSession: false });
    expect(orphanPurge.deletedKeys).toBe(2);
    expect(orphanPurge.deletedBytes).toBe(3072);
    expect(orphanPurge.preservedLiveSession).toBe(true);
    expect(orphanPurge.remaining.totalKeys).toBe(2);
    expect(orphanPurge.remaining.liveKeys).toBe(2);
    expect(orphanPurge.remaining.orphanKeys).toBe(0);
    expect(await docListKeys()).toEqual(["activeDoc", "activeDoc::preview::0"]);

    // 2. Full manual Document Studio purge clears remaining idle session to 0 keys
    const fullPurge = await purgeStagedData({ includeIdleSession: true });
    expect(fullPurge.deletedKeys).toBe(2);
    expect(fullPurge.deletedBytes).toBe(8192);
    expect(fullPurge.preservedLiveSession).toBe(false);
    expect(fullPurge.remaining.totalKeys).toBe(0);
    expect(fullPurge.remaining.totalBytes).toBe(0);
    expect(await docListKeys()).toEqual([]);

    expect(validateMessage({ type: "POPUP_GET_STAGED_STATS", requestId: "r-s1" }).ok).toBe(true);
    expect(validateMessage({ type: "POPUP_PURGE_STAGED_DATA", requestId: "r-s2", includeIdleSession: true }).ok).toBe(true);
    expect(
      validateMessage({
        type: "POPUP_STAGED_STATS_STATE",
        requestId: "r-s3",
        stats: fullPurge.remaining,
        purged: fullPurge,
      }).ok
    ).toBe(true);
  });

  it("purgeExpiredDocuments deletes documents older than the TTL while sparing fresh ones", async () => {
    const { docStoreFile, docListKeys } = await import("../src/shared/docDb.js");
    const { purgeExpiredDocuments } = await import("../src/service-worker/documents.js");

    await docStoreFile("expiredJob", new Uint8Array(5).buffer);
    await docStoreFile("freshJob", new Uint8Array(5).buffer);

    // Age the first document's write timestamp beyond the TTL.
    backing.set("docfilemeta::expiredJob", 1);

    const result = await purgeExpiredDocuments();
    expect(result.roots).toEqual(["expiredJob"]);
    expect(result.failures).toEqual([]);
    expect(await docListKeys()).toEqual(["freshJob"]);
  });
});
