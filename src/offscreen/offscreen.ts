// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { OFFSCREEN_CHANNEL, isOffscreenRequest, base64ToBytes, bytesToBase64, MAX_DOC_PAGES } from "../document-pipeline/contract.js";
import { runDocumentPreview, runDocumentRedact, runDocumentCount } from "../document-pipeline/impl.js";

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

function normalizeBytes(raw: unknown): ArrayBuffer {
  if (typeof raw !== "string" || !raw) throw new Error("Document bytes are missing from the request.");
  return base64ToBytes(raw).buffer as ArrayBuffer;
}

const port = chrome.runtime.connect({ name: OFFSCREEN_CHANNEL });

function toError(error: unknown): { code: string; userMessage: string } {
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
  void (async () => {
    try {
      const bytes = normalizeBytes(raw.bytes);
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
        const pages = await runDocumentPreview({
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
        });
        port.postMessage({ channel: OFFSCREEN_CHANNEL, op: "preview", jobId, ok: true, pages });
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
    } catch (error) {
      const e = toError(error);
      port.postMessage({ channel: OFFSCREEN_CHANNEL, op, jobId, ok: false, ...e });
    }
  })();
});
