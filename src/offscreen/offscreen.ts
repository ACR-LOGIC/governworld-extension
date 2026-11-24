// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import {
  OFFSCREEN_CHANNEL,
  DocumentCancelledError,
  isOffscreenRequest,
  base64ToBytes,
  bytesToBase64,
  MAX_DOC_PAGES,
} from "../document-pipeline/contract.js";
import { runDocumentPreview, runDocumentRedact, runDocumentCount } from "../document-pipeline/impl.js";
import { resetOcr } from "../document-pipeline/ocr.js";
import { getDocBytes } from "../shared/docStore.js";

/**
 * Offscreen document entry point. This page exists only to host pdf.js +
 * tesseract workers and to do canvas work — capabilities a service worker
 * lacks. It has no UI and processes one job at a time, always replying over
 * the dedicated port it opened to the service worker.
 *
 * MAX_DOC_PAGES comes from the shared contract rather than a local copy: the
 * cap is a policy value the popup discloses to the user, and a second copy here
 * is a second thing to forget to change.
 */

/**
 * Load the document bytes for a job.
 *
 * The service worker stages documents in the shared IndexedDB-backed document
 * store (shared/docStore.ts) and passes the store key. A legacy inline base64
 * `bytes` field is still accepted so older callers keep working.
 */
async function loadDocumentBytes(raw: { documentKey?: unknown; bytes?: unknown }): Promise<ArrayBuffer> {
  const documentKey = typeof raw.documentKey === "string" && raw.documentKey ? raw.documentKey : null;
  if (documentKey) {
    const bytes = await getDocBytes(documentKey);
    if (!bytes) throw new Error("The staged document bytes are no longer available.");
    return bytes;
  }
  if (typeof raw.bytes === "string" && raw.bytes) {
    return base64ToBytes(raw.bytes).buffer as ArrayBuffer;
  }
  throw new Error("Document bytes are missing from the request.");
}

const port = chrome.runtime.connect({ name: OFFSCREEN_CHANNEL });
const activeJobs = new Map<string, { controller: AbortController; fileKey?: string }>();

/**
 * Bounded document job scheduler.
 *
 * Document jobs share offscreen resources — the OCR workers, canvas contexts
 * and tesseract workers — and running several of them at once produced
 * collisions and corrupted results. At most this many run concurrently; the
 * rest wait for a slot. A waiting job that gets cancelled is skipped when it
 * reaches the head of the queue.
 */
const MAX_CONCURRENT_DOCUMENT_JOBS = 2;
let activeJobCount = 0;
const slotWaiters: Array<{ resolve: () => void }> = [];

function acquireSlot(): Promise<void> {
  if (activeJobCount < MAX_CONCURRENT_DOCUMENT_JOBS) {
    activeJobCount += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    slotWaiters.push({ resolve });
  });
}

function releaseSlot(): void {
  const next = slotWaiters.shift();
  if (next) {
    // The waiter takes this slot; the count is unchanged.
    next.resolve();
    return;
  }
  activeJobCount -= 1;
}

/** Ceiling for one document job inside the offscreen document. */
const JOB_TIMEOUT_MS = 300_000;

/**
 * Race a job against a timeout; the timeout aborts the job's controller so
 * cooperative cancellation (DocumentCancelledError, cancel messages) can take
 * over from the timer.
 */
async function withJobTimeout<T>(controller: AbortController, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new DocumentCancelledError(`Document processing timed out after ${JOB_TIMEOUT_MS} ms.`));
        }, JOB_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function toError(error: unknown): { code: string; userMessage: string } {
  if (error instanceof DocumentCancelledError || (error instanceof Error && error.name === "DocumentCancelledError")) {
    return { code: "DOC_CANCELLED", userMessage: "Document processing cancelled." };
  }
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes("password") || lower.includes("encrypted")) {
    return { code: "PASSWORD_PROTECTED", userMessage: "This PDF is password-protected and cannot be processed." };
  }
  if (lower.includes("too large")) {
    return { code: "DOC_TOO_LARGE", userMessage: "This document is too large to process on this device." };
  }
  if (lower.includes("language data") || lower.includes("ocr") || lower.includes("tesseract")) {
    return { code: "OCR_UNAVAILABLE", userMessage: "Text recognition is unavailable in offline mode." };
  }
  if (lower.includes("canvas") || lower.includes("worker")) {
    return { code: "PIPELINE_UNAVAILABLE", userMessage: "Document processing is unavailable right now." };
  }
  return { code: "DOC_ERROR", userMessage: "This document could not be processed." };
}

port.onMessage.addListener((raw: unknown) => {
  if (!isOffscreenRequest(raw)) return;
  const jobId = raw.jobId;
  const op = raw.op;
  if (op === "cancel") {
    let abortedAny = false;
    for (const [id, entry] of activeJobs) {
      if (
        (raw.targetJobId && id === raw.targetJobId) ||
        (raw.fileKey && entry.fileKey === raw.fileKey) ||
        (!raw.targetJobId && !raw.fileKey)
      ) {
        entry.controller.abort();
        abortedAny = true;
      }
    }
    void resetOcr().catch(() => undefined);
    port.postMessage({ channel: OFFSCREEN_CHANNEL, op: "cancel", jobId, ok: true, cancelled: abortedAny });
    return;
  }

  const controller = new AbortController();
  const fileKey = op === "preview" ? raw.previewKeyPrefix : op === "redact" ? raw.fileKey : undefined;
  activeJobs.set(jobId, { controller, fileKey });

  const executeJob = async (): Promise<void> => {
    const bytes = await loadDocumentBytes(raw);
    if (controller.signal.aborted) throw new DocumentCancelledError();
    if (op === "count") {
      // The cheap pass: a page count the studio shows the user so they can
      // choose which window to scan. Renders nothing, so it fails fast on a
      // broken document instead of after a minute of work.
      const totalPages = await runDocumentCount({
        kind: raw.kind,
        bytes,
        name: raw.name,
        mimeType: raw.mimeType,
      });
      port.postMessage({ channel: OFFSCREEN_CHANNEL, op: "count", jobId, ok: true, totalPages });
      return;
    }
    if (op === "preview") {
      const { pages, truncated } = await runDocumentPreview(
        {
          kind: raw.kind,
          bytes,
          name: raw.name,
          mimeType: raw.mimeType,
          enabledCategories: raw.enabledCategories,
          maxPages: raw.maxPages,
          pageOffset: raw.pageOffset ?? 0,
          ocrLanguage: raw.ocrLanguage,
          customPatterns: raw.customPatterns,
          previewKeyPrefix: raw.previewKeyPrefix,
        },
        controller.signal
      );
      if (controller.signal.aborted) throw new DocumentCancelledError();
      port.postMessage({ channel: OFFSCREEN_CHANNEL, op: "preview", jobId, ok: true, pages, truncated });
      return;
    }
    const out = await runDocumentRedact(
      { kind: raw.kind, bytes, name: raw.name, mimeType: raw.mimeType },
      raw.boxes,
      MAX_DOC_PAGES,
      raw.padding,
      raw.options,
      raw.fileKey,
      // The findings were produced for this window; redacting a different one
      // paints the right pages by the wrong address.
      raw.pageOffset ?? 0
    );
    if (controller.signal.aborted) throw new DocumentCancelledError();
    port.postMessage({
      channel: OFFSCREEN_CHANNEL,
      op: "redact",
      jobId,
      ok: true,
      outputBytes: bytesToBase64(out.outputBytes),
      outputMimeType: out.outputMimeType,
      outputName: out.outputName,
      redactedCount: out.redactedCount,
      verification: out.verification,
      printRef: out.printRef ?? null,
    });
  };

  void (async () => {
    // Bounded scheduler: wait for a slot so at most
    // MAX_CONCURRENT_DOCUMENT_JOBS document jobs run at once (they share the
    // OCR workers and other offscreen resources). A job cancelled while
    // queued is skipped when it reaches its slot.
    await acquireSlot();
    if (controller.signal.aborted) {
      releaseSlot();
      return;
    }
    try {
      await withJobTimeout(controller, executeJob());
    } catch (error) {
      const e = toError(error);
      port.postMessage({ channel: OFFSCREEN_CHANNEL, op, jobId, ok: false, ...e });
    } finally {
      releaseSlot();
      activeJobs.delete(jobId);
    }
  })();
});
