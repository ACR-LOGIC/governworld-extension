// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import type { DocumentPage, CountInput } from "../document-pipeline/adapter.js";
import { BrowserDocumentPipeline } from "../document-pipeline/browser.js";
import { DocumentCancelledError, MAX_DOC_PAGES } from "../document-pipeline/contract.js";
import type { RedactionVerification } from "../document-pipeline/verify.js";
import type { RedactedDocRef } from "../shared/docStore.js";
import { MAX_DOC_BYTES, pageWindowLabel, resolvePageWindow } from "../shared/docLimits.js";
import type { DocKind, FindingCategory, Rect, RedactionOptions } from "../shared/types.js";
import { loadSettings, meetsThreshold } from "../shared/settings.js";
import {
  DOCUMENT_PIPELINE_UNAVAILABLE_MESSAGE,
  isDocumentPipelineSupported,
} from "../shared/platform.js";
import { loadCustomPatterns } from "../shared/customPatterns.js";
import {
  docStoreFile,
  docReadFile,
  docDeleteByPrefix,
  docClearFiles,
  docListKeys,
  docGetStagedStats,
  docListStaleMetaRoots,
  docDeleteMetaByPrefix,
  markDocumentStaged,
  isDocumentStaged,
  getStagedFileKey,
  clearStagedMarker,
} from "../shared/docDb.js";
import type { PurgeStagedDataResult, StagedStorageAudit } from "../shared/types.js";

/**
 * Document session management for the service worker. File bytes are held in
 * IndexedDB (shared with the popup) so they survive popup reloads; the
 * in-memory session only holds metadata + preview pages. Raw page text is
 * never stored — only masked previews and rectangles.
 */

const LAST_DOC_KEY = "lastDocId";
/**
 * Descriptor for the in-flight/last document session, minus the file bytes.
 *
 * MV3 tears the service worker down after ~30s idle and the `sessions` map dies
 * with it, while `lastDocId` in storage.session survives. That combination made
 * the Document Studio vanish on reopen even though the bytes were still in
 * IndexedDB, so a user who looked away during the 6-20s preview lost the whole
 * job. Persisting the descriptor lets the worker rebuild the session from the
 * stored file instead of asking the user to pick the document again.
 */
const LAST_SESSION_KEY = "lastDocSession";

export interface DocSession {
  docId: string;
  fileKey: string;
  name: string;
  mimeType: string;
  kind: DocKind;
  bytes: ArrayBuffer;
  /**
   * SHA-256 of `bytes` at preview time. Redaction requires the bytes to still
   * match: if the file was swapped after the preview, the boxes could be
   * measuring something else and the pixel verification would still pass
   * (it verifies the output against the boxes, not against the original).
   */
  digest: string;
  pages: DocumentPage[];
  categories: FindingCategory[];
  /**
   * 0-based index of the first page this session scanned, and the document's
   * true length.
   *
   * The window is part of the session, not of the request, because redaction
   * re-renders from the original bytes: if the preview scanned pages 21-40 and
   * the redact rendered pages 1-20, the boxes would land on the wrong pages and
   * the pixel verification would still pass. Total pages ride along so the UI
   * can say "pages 21-40 of 45" instead of implying 20 is the whole document.
   */
  pageOffset: number;
  totalPages: number;
  /**
   * True when a Word document exceeded the character cap and was cut short.
   * Persisted like the page window, so a restored session still discloses that
   * part of the document was never read.
   */
  truncated: boolean;
}

const sessions = new Map<string, DocSession>();
const inFlightFileKeys = new Set<string>();
const cancelledFileKeys = new Set<string>();
let lastDocId: string | null = null;

/**
 * Mark a document as staged, so the lifecycle purge leaves it alone.
 *
 * The purge clears the entire store, so it would otherwise delete a document the
 * popup staged moments earlier. The marker lives in `chrome.storage.session`
 * because the write happens in the popup and the decision in this worker; see
 * `markDocumentStaged` in shared/docDb.ts.
 */
export async function storeFile(fileKey: string, bytes: ArrayBuffer): Promise<void> {
  await markDocumentStaged(fileKey);
  await docStoreFile(fileKey, bytes);
}

/** SHA-256 of the given bytes, lowercase hex (64 chars). */
export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", view.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hasStagedDocument(): Promise<boolean> {
  return isDocumentStaged();
}

export async function readFile(fileKey: string): Promise<ArrayBuffer | null> {
  return docReadFile(fileKey);
}

export async function deleteFile(fileKey: string): Promise<void> {
  await docDeleteByPrefix(fileKey);
}

/**
 * Empty the staged-document store.
 *
 * This is destructive by definition: it drops every staged file, preview and
 * print page. `purgeStagedFilesOnLifecycle` checks `hasStagedDocument()` first
 * and skips in that case, so housekeeping cannot take a document the user is
 * working on. Callers that mean "discard this now" (an explicit cancel, a new
 * file replacing the old one) call it directly.
 */
export async function clearAllFiles(): Promise<void> {
  await docClearFiles();
  await chrome.storage.session.remove(LAST_DOC_KEY);
  await clearStagedMarker();
  forgetPersistedSession();
  sessions.clear();
  lastDocId = null;
}

export async function loadLastDocId(): Promise<string | null> {
  const raw = await chrome.storage.session.get(LAST_DOC_KEY);
  const value = raw[LAST_DOC_KEY];
  return typeof value === "string" && value ? value : null;
}

function setLastDocId(docId: string | null): void {
  lastDocId = docId;
  void chrome.storage.session.set({ [LAST_DOC_KEY]: docId }).catch(() => undefined);
}

interface PersistedSession {
  docId: string;
  fileKey: string;
  name: string;
  mimeType: string;
  kind: DocKind;
  /** Present in records written after digest binding was introduced. */
  digest?: string;
  pages: DocumentPage[];
  categories: FindingCategory[];
  /** Absent in a record written before windowed passes existed. */
  pageOffset?: number;
  totalPages?: number;
  /** Absent in a record from a build before the character cap was disclosed. */
  truncated?: boolean;
}

/** Record enough to rebuild the session after the worker is recycled. */
function persistSession(session: DocSession): void {
  const record: PersistedSession = {
    docId: session.docId,
    fileKey: session.fileKey,
    name: session.name,
    mimeType: session.mimeType,
    kind: session.kind,
    digest: session.digest,
    pages: session.pages,
    categories: session.categories,
    pageOffset: session.pageOffset,
    totalPages: session.totalPages,
    truncated: session.truncated,
  };
  void chrome.storage.session.set({ [LAST_SESSION_KEY]: record }).catch(() => undefined);
}

function forgetPersistedSession(): void {
  void chrome.storage.session.remove(LAST_SESSION_KEY).catch(() => undefined);
}

export function getSession(docId: string): DocSession | null {
  return sessions.get(docId) ?? null;
}

export function getLastSession(): DocSession | null {
  return lastDocId ? sessions.get(lastDocId) ?? null : null;
}

/**
 * Return the last document session, rebuilding it from IndexedDB if the worker
 * was recycled. Returns null when there is nothing to restore or the file the
 * descriptor points at is gone.
 */
export async function restoreLastSession(): Promise<DocSession | null> {
  const live = getLastSession();
  if (live) return live;

  const raw = await chrome.storage.session.get(LAST_SESSION_KEY).catch(() => ({} as Record<string, unknown>));
  const record = raw[LAST_SESSION_KEY] as PersistedSession | undefined;
  if (!record || typeof record.docId !== "string" || typeof record.fileKey !== "string" || !Array.isArray(record.pages)) {
    return null;
  }

  // The descriptor can outlive its file (cleared, or the browser evicted it).
  const bytes = await readFile(record.fileKey).catch(() => null);
  if (!bytes) {
    forgetPersistedSession();
    return null;
  }

  const pageOffset =
    typeof record.pageOffset === "number" && Number.isSafeInteger(record.pageOffset) && record.pageOffset >= 0
      ? record.pageOffset
      : 0;
  // Compute a fresh digest on restore: an older persisted record has none,
  // and either way the session must carry the digest of the bytes it holds.
  const digest = await sha256Hex(bytes);
  const session: DocSession = {
    docId: record.docId,
    fileKey: record.fileKey,
    name: record.name,
    mimeType: record.mimeType,
    kind: record.kind,
    bytes,
    digest,
    pages: record.pages,
    categories: Array.isArray(record.categories) ? record.categories : uniqueCategories(record.pages),
    pageOffset,
    // An older record has no total; the scanned pages are then all that is known.
    totalPages:
      typeof record.totalPages === "number" && Number.isSafeInteger(record.totalPages) && record.totalPages >= 1
        ? record.totalPages
        : record.pages.length + pageOffset,
    // Only ever coerced to true from a real signal; an absent or malformed
    // field means "not disclosed", which is the safe direction for a claim
    // about what was read.
    truncated: record.truncated === true,
  };
  sessions.set(session.docId, session);
  setLastDocId(session.docId);
  return session;
}

export async function clearSession(docId?: string, fileKey?: string): Promise<void> {
  const byId = docId ? sessions.get(docId) : undefined;
  const byFileKey =
    !byId && fileKey ? [...sessions.values()].find((s) => s.fileKey === fileKey) : undefined;
  const session = byId ?? byFileKey;
  const targetFileKey = session?.fileKey ?? fileKey;
  const targetDocId = session?.docId ?? docId;

  if (targetDocId) sessions.delete(targetDocId);
  if (targetFileKey) {
    await docDeleteByPrefix(targetFileKey).catch(() => undefined);
  }
  const persisted = await chrome.storage.session.get([LAST_DOC_KEY, LAST_SESSION_KEY]).catch(() => ({} as Record<string, unknown>));
  const persistedSession = persisted[LAST_SESSION_KEY] as PersistedSession | undefined;
  const matchesPersisted =
    (targetDocId && (lastDocId === targetDocId || persisted[LAST_DOC_KEY] === targetDocId || persistedSession?.docId === targetDocId)) ||
    (targetFileKey && persistedSession?.fileKey === targetFileKey);

  if (matchesPersisted || sessions.size === 0) {
    setLastDocId(null);
    forgetPersistedSession();
  }
  if (sessions.size === 0 && inFlightFileKeys.size === 0) {
    await clearStagedMarker();
  }
}

const pipeline = new BrowserDocumentPipeline();

export async function cancelDocument(docId?: string, fileKey?: string): Promise<void> {
  const byId = docId ? sessions.get(docId) : undefined;
  const targetKey =
    byId?.fileKey ??
    fileKey ??
    (inFlightFileKeys.size === 1 ? [...inFlightFileKeys][0] : undefined);
  if (targetKey) {
    cancelledFileKeys.add(targetKey);
  }
  await pipeline.cancel(targetKey).catch(() => undefined);
  if (targetKey) {
    inFlightFileKeys.delete(targetKey);
  }
  await clearSession(docId, targetKey);
  if (targetKey) {
    await docDeleteByPrefix(targetKey).catch(() => undefined);
  }
}

async function collectLiveStagedRoots(): Promise<Set<string>> {
  const liveRoots = new Set<string>();
  for (const s of sessions.values()) liveRoots.add(s.fileKey);
  for (const fk of inFlightFileKeys) liveRoots.add(fk);

  const raw = await chrome.storage.session.get(LAST_SESSION_KEY).catch(() => ({} as Record<string, unknown>));
  const persisted = raw[LAST_SESSION_KEY] as Partial<PersistedSession> | undefined;
  if (persisted && typeof persisted.fileKey === "string" && persisted.fileKey) {
    liveRoots.add(persisted.fileKey);
  }
  if (await hasStagedDocument()) {
    const stagedKey = await getStagedFileKey();
    if (stagedKey) liveRoots.add(stagedKey);
  }
  return liveRoots;
}

export async function purgeOrphanedStagedKeys(): Promise<number> {
  const liveRoots = await collectLiveStagedRoots();

  let keys: string[];
  try {
    keys = await docListKeys();
  } catch {
    return 0;
  }

  const orphanRoots = new Set<string>();
  for (const k of keys) {
    const root = k.split("::")[0] || k;
    if (!liveRoots.has(root)) {
      orphanRoots.add(root);
    }
  }

  let deletedCount = 0;
  for (const root of orphanRoots) {
    deletedCount += await docDeleteByPrefix(root).catch(() => 0);
  }
  return deletedCount;
}

/**
 * Age after which staged documents are purged by the TTL sweep. Temporary
 * documents (popup previews, redaction outputs) are meant to be short-lived;
 * this bounds how long they can linger in IndexedDB after cleanup fails.
 */
export const STAGED_DOCUMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface ExpiredDocumentPurgeResult {
  /** Roots that were actually deleted (best effort). */
  roots: string[];
  deletedKeys: number;
  /** Roots that could not be deleted; surfaced, never swallowed. */
  failures: string[];
}

/**
 * Delete staged documents whose write timestamp is older than the TTL.
 *
 * Roots with live sessions or in-flight jobs are skipped. Failures are
 * collected per root rather than thrown, so the caller can report them
 * visibly instead of losing the whole sweep.
 */
export async function purgeExpiredDocuments(
  maxAgeMs: number = STAGED_DOCUMENT_TTL_MS
): Promise<ExpiredDocumentPurgeResult> {
  let roots: string[];
  try {
    roots = await docListStaleMetaRoots(maxAgeMs);
  } catch {
    return { roots: [], deletedKeys: 0, failures: ["Could not list expired document records."] };
  }
  const liveRoots = await collectLiveStagedRoots().catch(() => new Set<string>());
  const expired = roots.filter((root) => root.length > 0 && !liveRoots.has(root));

  const deletedRoots: string[] = [];
  const failures: string[] = [];
  let deletedKeys = 0;
  for (const root of expired) {
    try {
      deletedKeys += await docDeleteByPrefix(root);
      deletedRoots.push(root);
    } catch {
      failures.push(root);
    }
    await docDeleteMetaByPrefix(root).catch(() => undefined);
  }
  return { roots: deletedRoots, deletedKeys, failures };
}

export async function getStagedStorageAudit(): Promise<StagedStorageAudit> {
  const [rawStats, liveRoots] = await Promise.all([
    docGetStagedStats().catch(() => ({ keyCount: 0, totalBytes: 0, byPrefix: {} })),
    collectLiveStagedRoots(),
  ]);

  let liveKeys = 0;
  let liveBytes = 0;
  let orphanKeys = 0;
  let orphanBytes = 0;

  for (const [prefix, entry] of Object.entries(rawStats.byPrefix)) {
    if (liveRoots.has(prefix)) {
      liveKeys += entry.keyCount;
      liveBytes += entry.bytes;
    } else {
      orphanKeys += entry.keyCount;
      orphanBytes += entry.bytes;
    }
  }

  return {
    totalKeys: rawStats.keyCount,
    totalBytes: rawStats.totalBytes,
    liveKeys,
    liveBytes,
    orphanKeys,
    orphanBytes,
    hasInFlightJob: inFlightFileKeys.size > 0,
  };
}

export async function purgeStagedData(options?: {
  includeIdleSession?: boolean;
}): Promise<PurgeStagedDataResult> {
  const includeIdle = options?.includeIdleSession !== false;
  const before = await docGetStagedStats().catch(() => ({ keyCount: 0, totalBytes: 0, byPrefix: {} }));
  const protectedRoots = includeIdle ? new Set(inFlightFileKeys) : await collectLiveStagedRoots();

  if (includeIdle) {
    for (const [docId, s] of [...sessions.entries()]) {
      if (!protectedRoots.has(s.fileKey)) {
        sessions.delete(docId);
      }
    }
    if (inFlightFileKeys.size === 0) {
      await chrome.storage.session.remove([LAST_DOC_KEY, LAST_SESSION_KEY]).catch(() => undefined);
      await clearStagedMarker().catch(() => undefined);
      lastDocId = null;
    }
  }

  let deletedKeys = 0;
  let deletedBytes = 0;
  for (const [prefix, entry] of Object.entries(before.byPrefix)) {
    if (!protectedRoots.has(prefix)) {
      const removed = await docDeleteByPrefix(prefix).catch(() => 0);
      deletedKeys += removed;
      if (removed > 0) deletedBytes += entry.bytes;
    }
  }

  const remaining = await getStagedStorageAudit();
  return {
    deletedKeys,
    deletedBytes,
    preservedLiveSession: remaining.liveKeys > 0,
    remaining,
  };
}

function uniqueCategories(pages: DocumentPage[]): FindingCategory[] {
  const seen = new Set<FindingCategory>();
  for (const page of pages) for (const f of page.findings) seen.add(f.category);
  return [...seen];
}

/**
 * Count a document's pages without scanning it.
 *
 * The popup asks before the slow pass so the user can choose which window to
 * scan. Without it, every document longer than the cap was truncated to its
 * first pages in silence and then reported as complete.
 */
export async function countDocument(input: {
  fileKey: string;
  name: string;
  mimeType: string;
  kind: DocKind;
}): Promise<number> {
  if (!isDocumentPipelineSupported()) throw new Error(DOCUMENT_PIPELINE_UNAVAILABLE_MESSAGE);
  const bytes = await readFile(input.fileKey);
  if (!bytes) throw new Error("The selected file is no longer available. Please re-open it.");
  if (bytes.byteLength > MAX_DOC_BYTES) throw new Error("Document is too large to process on this device.");

  const countInput: CountInput = {
    kind: input.kind,
    bytes,
    name: input.name,
    mimeType: input.mimeType,
    documentKey: input.fileKey,
  };
  const total = await pipeline.count(countInput);
  // A document always has at least one page; anything else is a bug or a lie.
  return Number.isSafeInteger(total) && total >= 1 ? total : 1;
}

export async function previewDocument(
  fileKey: string,
  name: string,
  mimeType: string,
  kind: DocKind,
  /** 0-based index of the first page to scan; 0 scans from the start. */
  pageOffset = 0,
  /** The document's page count, known from the count pass that precedes this. */
  totalPages?: number
): Promise<{ docId: string; pages: DocumentPage[]; pageOffset: number; totalPages: number; truncated: boolean }> {
  // The pipeline runs in an offscreen document (Chromium-only). On browsers
  // without it, say so plainly instead of failing deep in the job queue.
  if (!isDocumentPipelineSupported()) throw new Error(DOCUMENT_PIPELINE_UNAVAILABLE_MESSAGE);
  const bytes = await readFile(fileKey);
  if (!bytes) throw new Error("The selected file is no longer available. Please re-open it.");
  if (bytes.byteLength > MAX_DOC_BYTES) throw new Error("Document is too large to process on this device.");
  // Digest at preview time; redaction re-checks it so boxes can never be
  // painted onto bytes the user has since replaced.
  const digest = await sha256Hex(bytes);

  const settings = await loadSettings();
  const customPatterns = await loadCustomPatterns();
  const docId = crypto.randomUUID();
  // The cap is applied here, against a real total, so an offset the popup
  // computed before the document changed still yields a bounded window.
  const pageWindow = resolvePageWindow(totalPages ?? 1, pageOffset + 1);
  cancelledFileKeys.delete(fileKey);
  inFlightFileKeys.add(fileKey);
  let previewed: { pages: DocumentPage[]; truncated: boolean };
  try {
    await clearAllFiles();
    if (cancelledFileKeys.has(fileKey)) {
      throw new DocumentCancelledError();
    }
    await storeFile(fileKey, bytes);
    previewed = await pipeline.preview({
      kind,
      bytes,
      name,
      mimeType,
      enabledCategories: settings.enabledCategories,
      maxPages: MAX_DOC_PAGES,
      pageOffset: pageWindow.offset,
      padding: settings.maskPadding,
      previewPages: [],
      categories: [],
      ocrLanguage: settings.ocrLanguage,
      customPatterns,
      previewKeyPrefix: fileKey,
      documentKey: fileKey,
    });
    if (cancelledFileKeys.has(fileKey)) {
      throw new DocumentCancelledError();
    }
  } catch (error) {
    await docDeleteByPrefix(fileKey).catch(() => undefined);
    await clearStagedMarker().catch(() => undefined);
    throw error;
  } finally {
    inFlightFileKeys.delete(fileKey);
  }
  if (cancelledFileKeys.has(fileKey)) {
    cancelledFileKeys.delete(fileKey);
    await docDeleteByPrefix(fileKey).catch(() => undefined);
    await clearStagedMarker().catch(() => undefined);
    throw new DocumentCancelledError();
  }
  // Confidence thresholds are enforced server-side (here), not in the UI.
  const pages = previewed.pages.map((p) => ({
    ...p,
    findings: p.findings.filter((f) => meetsThreshold(settings, f.category, f.confidence)),
  }));

    sessions.set(docId, {
      docId,
      fileKey,
      name,
      mimeType,
      kind,
      bytes,
      digest,
      pages,
    categories: uniqueCategories(pages),
    pageOffset: pageWindow.offset,
    // Never claim a total smaller than what was scanned: if the count pass is
    // missing, the document is exactly as long as the pages that came back.
    totalPages: Math.max(pageWindow.total, pages.length + pageWindow.offset),
    truncated: previewed.truncated === true,
  });
  setLastDocId(docId);
  persistSession(sessions.get(docId)!);
  return {
    docId,
    pages,
    pageOffset: pageWindow.offset,
    totalPages: Math.max(pageWindow.total, pages.length + pageWindow.offset),
    truncated: previewed.truncated === true,
  };
}

export async function redactDocument(
  docId: string,
  fileKey: string,
  name: string,
  mimeType: string,
  kind: DocKind,
  boxes: { pageIndex: number; rects: Rect[] }[],
  findingIds: string[],
  options?: RedactionOptions
): Promise<{ outputName: string; outputBytes: Uint8Array; outputMimeType: string; verification: RedactionVerification; redactedRegions: number; printRef: RedactedDocRef | null }> {
  const session = sessions.get(docId);
  if (!session || session.fileKey !== fileKey || session.kind !== kind || session.name !== name) {
    throw new Error("This document is no longer loaded. Please re-open it.");
  }
  // Require the original document bytes: if they changed since the preview,
  // the boxes describe a different file and redacting now would paint them
  // onto the wrong content while every pixel check still passes.
  const currentDigest = await sha256Hex(session.bytes);
  if (currentDigest !== session.digest) {
    throw new Error("This document has changed since it was previewed. Please re-open it.");
  }
  const settings = await loadSettings();
  const selectedIds = new Set(findingIds);
  if (selectedIds.size === 0 || selectedIds.size !== findingIds.length) {
    if (!boxes || boxes.length === 0) {
      throw new Error("Select at least one finding to redact.");
    }
  }
  const availableIds = new Set(session.pages.flatMap((page) => page.findings.map((finding) => finding.id)));
  if ([...selectedIds].some((id) => !availableIds.has(id) && !id.startsWith("custom:") && !id.startsWith("user:"))) {
    throw new Error("The selected findings are no longer available.");
  }

  // If explicit boxes (including custom drawn boxes) are provided, use them;
  // otherwise derive from selected session findings.
  const explicitBoxes = (boxes ?? []).filter((b) => b.rects && b.rects.length > 0);
  const derivedBoxes = session.pages
    .map((page) => ({
      pageIndex: page.index,
      rects: page.findings.filter((finding) => selectedIds.has(finding.id)).flatMap((finding) => finding.rects),
    }))
    .filter((page) => page.rects.length > 0);

  const targetBoxes = explicitBoxes.length > 0 ? explicitBoxes : derivedBoxes;
  const groupedTargetBoxesMap = new Map<number, Rect[]>();
  for (const b of targetBoxes) {
    const existing = groupedTargetBoxesMap.get(b.pageIndex);
    if (existing) {
      existing.push(...b.rects);
    } else {
      groupedTargetBoxesMap.set(b.pageIndex, [...b.rects]);
    }
  }
  const mergedTargetBoxes = Array.from(groupedTargetBoxesMap.entries()).map(([pageIndex, rects]) => ({
    pageIndex,
    rects,
  }));
  if (mergedTargetBoxes.length === 0) {
    throw new Error("The selected findings have no redactable regions.");
  }

  const effectivePadding = options?.padding ?? settings.maskPadding;
  const result = await pipeline.redact(
    {
      kind: session.kind,
      bytes: session.bytes,
      name: session.name,
      mimeType: session.mimeType,
      // The same key the preview staged the bytes under; the offscreen
      // document reads them from the shared store instead of a base64 copy.
      documentKey: session.fileKey,
      enabledCategories: settings.enabledCategories,
      maxPages: MAX_DOC_PAGES,
      // The same window the findings came from. A different one here paints the
      // right boxes onto the wrong pages.
      pageOffset: session.pageOffset,
      padding: effectivePadding,
      previewKeyPrefix: session.fileKey,
      previewPages: session.pages,
      categories: session.categories,
      options,
    },
    mergedTargetBoxes,
    options
  );
  // A windowed pass produces a file that covers only part of the document, so
  // the name has to say which part: "report-redacted-p21-40.pdf" cannot be
  // mistaken for the whole document, and two windows do not collide on disk.
  const outputName = windowedOutputName(result.outputName, session.pageOffset, session.totalPages);
  return {
    outputName,
    outputBytes: result.outputBytes,
    outputMimeType: result.outputMimeType,
    verification: result.verification,
    redactedRegions: mergedTargetBoxes.reduce((n, b) => n + b.rects.length, 0),
    printRef: result.printRef ?? null
  };
}

/**
 * Insert the page window into an output filename, when the pass is partial.
 *
 * "report-redacted.pdf" becomes "report-redacted-p21-40.pdf". A full pass keeps
 * the plain name: "-p1-20" on a 20-page document would be noise.
 */
function windowedOutputName(outputName: string, pageOffset: number, totalPages: number): string {
  const label = pageWindowLabel(resolvePageWindow(totalPages, pageOffset + 1));
  if (!label) return outputName;
  const dot = outputName.lastIndexOf(".");
  if (dot <= 0) return `${outputName}-${label}`;
  return `${outputName.slice(0, dot)}-${label}${outputName.slice(dot)}`;
}