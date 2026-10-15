// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.

/**
 * Document limits, in one place.
 *
 * These values used to live as independent copies in the popup, the worker and
 * the offscreen document. Nothing tied them together, so a change to the page
 * cap had to be made in several files with no compile-time link, and the user-
 * facing copy ("up to 20 MB") was a fourth, hand-maintained copy of the same
 * fact. One module owns the numbers; every context imports it.
 *
 * This module is deliberately free of DOM and chrome.* references so the popup,
 * the service worker, the offscreen document and the unit tests can all use it.
 */

/** Hard cap on pages processed per document pass. */
export const MAX_DOC_PAGES = 20;

/** Hard cap on document file size, in bytes. */
export const MAX_DOC_BYTES = 20 * 1024 * 1024;

/**
 * Hard cap on how much of a Word document's text is read.
 *
 * Word files have no pages of their own - the bytes are one document.xml - so
 * the only bound on the work a huge document can cause is a character limit.
 * It used to be applied silently: a document past the cap produced fewer pages
 * and the studio reported that count as the document, which is the same false
 * completeness the page cap had. The value is disclosed to the user whenever it
 * actually bites, via `doc_text_limit_warning`.
 */
export const MAX_DOCX_CHARS = 200_000;

/** Human-readable form of {@link MAX_DOC_BYTES}, for user-facing copy. */
export const MAX_DOC_BYTES_LABEL = "20 MB";

/**
 * A page window: which pages of a document a pass actually processes.
 *
 * `offset` is what the pipeline consumes (0-based index of the first page to
 * render). `from`/`to` are what the user chose and sees (1-based, inclusive) —
 * mixing the two conventions in the UI is how "page 21" becomes page 20.
 */
export interface PageWindow {
  /** 0-based index of the first page to process. */
  offset: number;
  /** 1-based first page number processed (inclusive). */
  from: number;
  /** 1-based last page number processed (inclusive). */
  to: number;
  /** Total pages in the document. */
  total: number;
  /** True when the window does not cover the whole document. */
  windowed: boolean;
}

/**
 * Resolve a user-requested page range against the document and the cap.
 *
 * The request arrives as 1-based inclusive page numbers, because that is how a
 * user thinks about a document and how the picker is labelled. It is clamped
 * rather than rejected: a document that shrank between the count and the pick,
 * or a range typed slightly wide, must still produce a valid window instead of
 * an error the user cannot act on.
 *
 * The cap is always honoured, and the window always contains at least one page,
 * so no caller can end up rendering nothing or exceeding the transport budget
 * that assumes at most MAX_DOC_PAGES pages per pass.
 */
export function resolvePageWindow(
  totalPages: number,
  requestedFromPage: number,
  maxPages: number = MAX_DOC_PAGES
): PageWindow {
  const total = Number.isSafeInteger(totalPages) && totalPages >= 1 ? Math.floor(totalPages) : 1;
  const cap = Number.isSafeInteger(maxPages) && maxPages >= 1 ? Math.min(Math.floor(maxPages), total) : Math.min(MAX_DOC_PAGES, total);
  const requestedFrom = Number.isFinite(requestedFromPage) ? Math.floor(requestedFromPage) : 1;
  const from = Math.min(Math.max(1, requestedFrom), total);
  const count = Math.min(cap, total - from + 1);
  const to = from + Math.max(0, count - 1);
  return { offset: from - 1, from, to, total, windowed: from > 1 || to < total };
}

/**
 * A short description of what a pass covers, for status lines and filenames.
 *
 * Returns null when the pass covers the whole document, so callers can keep the
 * plain "47 pages" wording for the common case instead of every document
 * reading "pages 1-47 of 47".
 */
export function pageWindowLabel(window: PageWindow): string | null {
  if (!window.windowed) return null;
  return `p${window.from}-${window.to}`;
}
