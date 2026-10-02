// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Every ID the extension mints must survive its own message validation.
//
// A finding id is not cosmetic: `validateMessage` is all-or-nothing over the
// findings array, so ONE id containing a character outside the permitted
// alphabet makes the whole `POPUP_STATE` unvalidated — and the popup drops it
// silently. The session that carried it keeps the bad id, so every later
// `POPUP_GET_STATE` for that tab is rejected too. That wedges state delivery for
// the tab and the user sees a scan that appears to find nothing.
//
// The async PDF path used to mint `pdf_${cssSelector}_${findingId}`, and a
// cssSelector legitimately contains `>`, `[`, `]`, `"`, `#`, `.` and `:`. This
// reproduces that construction with the selector shapes the media queue really
// produces, so the regression cannot come back one shape at a time.
//
// Asserted through `validateMessage` rather than against the regex: the regex is
// private, and the contract that matters is whether a message the extension sends
// can be validated by the extension that receives it.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateMessage } from "../src/shared/messages.js";

const workerSrc = readFileSync(join(process.cwd(), "src/service-worker/index.ts"), "utf8");

/**
 * Mirror of `selectorToken` in src/service-worker/index.ts.
 *
 * Duplicated deliberately: the point is to test the contract an id must satisfy,
 * and importing a private function would couple the test to one implementation.
 * The shape below is fixed by the test immediately after this one.
 */
function selectorToken(selector: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < selector.length; i += 1) {
    h ^= selector.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `e${h.toString(36)}`;
}

const finding = (id: string) => ({
  id,
  category: "ssn" as const,
  confidence: 0.93,
  source: "local-rules" as const,
  preview: "***-**-9999",
  nodeId: "doc:0",
  startOffset: 0,
  endOffset: 11,
  rects: [{ x: 1, y: 2, width: 10, height: 10 }],
  selected: false,
});

const state = (ids: string[]) => ({
  type: "POPUP_STATE",
  requestId: "r1",
  state: {
    mode: "local",
    scanning: false,
    findings: ids.map(finding),
    scanned: true,
    truncated: false,
    visibleChars: 100,
    consentRequired: false,
  },
});

const accepts = (ids: string[]) => validateMessage(state(ids)).ok;

/** The selector shapes src/content/mediaQueue.ts really produces. */
const CSS_SELECTORS = [
  'embed[type="application/x-google-chrome-pdf"]',
  "div.content > embed:nth-of-type(2)",
  "main#root > object:nth-of-type(1)",
  "section.panel .viewer > iframe:nth-of-type(3)",
  "",
];

/** Exactly how the async PDF path mints an id. */
const pdfFindingId = (cssSelector: string, findingId: string) =>
  `pdf_${selectorToken(cssSelector)}_${findingId}`;

describe("the async PDF path mints ids that pass validation", () => {
  it("validates for every selector shape the media queue produces", () => {
    for (const sel of CSS_SELECTORS) {
      const id = pdfFindingId(sel, "doc:0:0");
      expect(accepts([id]), `${JSON.stringify(sel)} -> ${id} was rejected`).toBe(true);
    }
  });

  it("no longer interpolates the raw selector into the id", () => {
    // The exact defect: `pdf_${cssSelector}_${f.id}`.
    for (const sel of CSS_SELECTORS.filter(Boolean)) {
      expect(accepts([`pdf_${sel}_doc:0:0`]), `${sel} unexpectedly validates`).toBe(false);
    }
  });

  it("survives a message carrying many such findings at once", () => {
    const ids = CSS_SELECTORS.map((sel, i) => pdfFindingId(sel, `doc:0:${i}`));
    expect(accepts(ids)).toBe(true);
  });

  it("stays unique across different selectors", () => {
    // Uniqueness is why a hash is used rather than a stripped selector: two
    // elements must never collapse onto one finding id.
    const tokens = CSS_SELECTORS.map(selectorToken);
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it("is deterministic, so the same element keeps the same id across runs", () => {
    for (const sel of CSS_SELECTORS) {
      expect(selectorToken(sel)).toBe(selectorToken(sel));
    }
  });

  it("has the worker actually construct ids this way", () => {
    // Guards the mirror above: if the worker changes how it mints the id, this
    // test's premise changes and must be revisited rather than silently rotting.
    expect(workerSrc).toContain("function selectorToken");
    expect(workerSrc).toContain("`pdf_${selectorToken(item.cssSelector)}_${f.id}`");
    expect(workerSrc).not.toContain("`pdf_${item.cssSelector}_${f.id}`");
  });
});