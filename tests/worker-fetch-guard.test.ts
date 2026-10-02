// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// A page must not be able to steer the service worker into fetching a URL of its
// choosing.
//
// The content script reports media it found in page DOM; the worker then fetches
// those URLs on the page's behalf. Accepting any *parseable* URL therefore gave a
// page an SSRF primitive: it could make the browser issue requests to `file:`,
// `blob:` or any address reachable from the user's machine — including
// `http://169.254.169.254/...` cloud metadata and `http://localhost:*` services —
// and distinguish reachable from unreachable by the behaviour it observed.
//
// Nothing about the response reaches the page directly, but the request itself is
// the attack: it originates from the user's browser, carries their network
// position, and can reach hosts the page itself could not.
//
// `isSafeImageSrc` already enforced an http(s)-only rule for the visual queue.
// The pdf queue had no scheme check at all, and the visual queue's PDF allowance
// was an `|| /\.pdf/` that let `file:///.../x.pdf` through.
import { describe, expect, it } from "vitest";
import { validateMessage } from "../src/shared/messages.js";

const scanStats = {
  visibleChars: 100,
  truncated: false,
};

/** A minimal SCAN_RESULT carrying one pdfQueue entry under `stats`. */
function withPdf(url: string) {
  return {
    type: "SCAN_RESULT",
    requestId: "r1",
    sessionId: "s1",
    findings: [],
    stats: {
      ...scanStats,
      pdfQueue: [{ url, cssSelector: "embed", isTopLevel: false }],
    },
  };
}

/** Extract the accepted pdfQueue urls from a validated message. */
function acceptedPdfUrls(raw: unknown): string[] {
  const result = validateMessage(raw);
  if (!result.ok) return [];
  const msg = result.message as { stats?: { pdfQueue?: { url: string }[] } };
  return (msg.stats?.pdfQueue ?? []).map((e) => e.url);
}

describe("the pdf queue only accepts URLs the worker may fetch", () => {
  it("accepts ordinary http(s) PDF URLs", () => {
    // The feature must keep working.
    for (const url of [
      "https://example.com/doc.pdf",
      "http://example.com/doc.pdf",
      "https://example.com/viewer?id=1",
    ]) {
      expect(acceptedPdfUrls(withPdf(url)), url).toEqual([url]);
    }
  });

  it("rejects schemes that let a page reach the local machine", () => {
    // Each of these is a request the page could not itself make, or a scheme with
    // no legitimate PDF use here.
    for (const url of [
      "file:///C:/Windows/win.ini",
      "file:///etc/passwd?x.pdf",
      "blob:https://example.com/1234",
      "chrome://settings",
      "chrome-extension://abc/redact.html",
      "data:application/pdf;base64,JVBERi0=",
      "javascript:fetch('http://x')",
      "about:blank",
      "vbscript:msgbox(1)",
    ]) {
      expect(acceptedPdfUrls(withPdf(url)), url).toEqual([]);
    }
  });

  it("still allows http(s) to any host, which is a separate decision", () => {
    // Honest about scope. Scheme validation stops `file:`/`blob:`/`data:`/
    // `javascript:` — requests the page could not originate itself, and schemes
    // with no legitimate PDF use here. It deliberately does NOT block loopback or
    // link-local hosts over http(s): a page can already embed those directly, so
    // blocking them at the queue would not remove the capability, and a legitimate
    // intranet PDF viewer (a common case for this tool) would stop working.
    //
    // Whether to add host allowlisting here is a product decision, not a
    // correctness fix. See the handoff notes.
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://localhost:8080/report.pdf",
      "http://127.0.0.1:9200/_cat/indices",
      "http://[::1]:8000/doc.pdf",
    ]) {
      expect(acceptedPdfUrls(withPdf(url)), url).toEqual([url]);
    }
  });

  it("rejects values that are not URLs at all", () => {
    for (const url of ["", "not a url", "example.com/doc.pdf"]) {
      expect(acceptedPdfUrls(withPdf(url)), url).toEqual([]);
    }
  });

  it("does not let a .pdf suffix bypass the scheme check", () => {
    // The visual queue allowed any URL whose text ended in .pdf, which made
    // `file:///.../x.pdf` acceptable. The suffix must not decide the scheme.
    expect(acceptedPdfUrls(withPdf("file:///etc/shadow.pdf"))).toEqual([]);
    expect(acceptedPdfUrls(withPdf("data:text/html,<script>1</script>.pdf"))).toEqual([]);
  });
});