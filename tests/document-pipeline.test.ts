// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect } from "vitest";
import { tokenSpans, findingsFromOcrPages } from "../src/document-pipeline/core.js";
import type { OcrPageResult, OcrToken } from "../src/document-pipeline/ocr.js";
import { assertSafeDocxArchive, extractDocxText } from "../src/document-pipeline/docx.js";
import { MAX_DOCX_CHARS } from "../src/shared/docLimits.js";

function token(text: string, lineIndex: number, x: number, width: number): OcrToken {
  return { text, confidence: 90, lineIndex, bbox: { x, y: 10, width, height: 16 } };
}

function page(tokens: OcrToken[], widthPx = 800, heightPx = 1000): OcrPageResult {
  return {
    pageIndex: 0,
    widthPx,
    heightPx,
    tokens,
    fullText: tokens
      .map((t, i) => (i > 0 && t.lineIndex !== tokens[i - 1].lineIndex ? "\n" : i > 0 ? " " : "") + t.text)
      .join(""),
  };
}

describe("tokenSpans", () => {
  it("reconstructs offsets that match the joined fullText exactly", () => {
    const tokens = [token("Contact", 0, 0, 40), token("jane@example.com", 0, 41, 90), token("today", 0, 132, 30)];
    const p = page(tokens);
    const spans = tokenSpans(tokens);
    expect(spans.map((s) => p.fullText.slice(s.start, s.end))).toEqual(["Contact", "jane@example.com", "today"]);
    expect(spans[1].start).toBe(8);
    expect(spans[1].end).toBe(24);
  });

  it("inserts a newline between lines so offsets stay deterministic", () => {
    const tokens = [token("A", 0, 0, 10), token("B", 1, 0, 10), token("C", 1, 11, 10)];
    const p = page(tokens);
    const spans = tokenSpans(tokens);
    expect(p.fullText).toBe("A\nB C");
    expect(spans[1].start).toBe(2);
    expect(spans[2].start).toBe(4);
  });
});

function docxArchive(uncompressedSize: number, compressedSize: number): ArrayBuffer {
  const nameLength = 11;
  const centralOffset = 0;
  const centralSize = 46 + nameLength;
  const eocdOffset = centralOffset + centralSize;
  const buffer = new ArrayBuffer(eocdOffset + 22);
  const view = new DataView(buffer);
  view.setUint32(centralOffset, 0x02014b50, true);
  view.setUint16(centralOffset + 28, nameLength, true);
  view.setUint32(centralOffset + 20, compressedSize, true);
  view.setUint32(centralOffset + 24, uncompressedSize, true);
  view.setUint32(eocdOffset, 0x06054b50, true);
  view.setUint16(eocdOffset + 10, 1, true);
  view.setUint32(eocdOffset + 12, centralSize, true);
  view.setUint32(eocdOffset + 16, centralOffset, true);
  return buffer;
}

describe("DOCX archive limits", () => {
  it("accepts a bounded archive", () => {
    expect(() => assertSafeDocxArchive(docxArchive(20, 10))).not.toThrow();
  });

  it("rejects an archive with an unsafe compression ratio", () => {
    expect(() => assertSafeDocxArchive(docxArchive(20_000, 10))).toThrow(/compression ratio/);
  });
});

/**
 * A minimal, real .docx: a stored (uncompressed) zip holding the three parts
 * mammoth needs. Hand-built because the suite has no docx writer, and the
 * character-cap disclosure cannot be tested without real bytes to read.
 */
function docxWithText(text: string): ArrayBuffer {
  const encoder = new TextEncoder();
  const files: Array<[string, Uint8Array]> = [
    ["[Content_Types].xml", encoder.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')],
    ["_rels/.rels", encoder.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')],
    ["word/document.xml", encoder.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`)],
  ];

  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, bytes] of files) {
    const crc = crc32(bytes);
    const lh = new Uint8Array(30 + name.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true); // stored
    lv.setUint32(14, crc, true);
    lv.setUint32(18, bytes.length, true);
    lv.setUint32(22, bytes.length, true);
    lv.setUint16(26, name.length, true);
    for (let i = 0; i < name.length; i += 1) lh[30 + i] = name.charCodeAt(i);
    locals.push(lh, bytes);

    const ch = new Uint8Array(46 + name.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, bytes.length, true);
    cv.setUint32(24, bytes.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true); // where this entry's local header starts
    for (let i = 0; i < name.length; i += 1) ch[46 + i] = name.charCodeAt(i);
    central.push(ch);
    offset += lh.length + bytes.length;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const parts = [...locals, ...central, eocd];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out.buffer;
}

function crc32(bytes: Uint8Array): number {
  let crc = ~0;
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i];
    for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

describe("DOCX character cap is disclosed, not silent", () => {
  it("reads a short document whole and reports no truncation", async () => {
    // mammoth appends its own paragraph separator, so compare the content.
    const { text, truncated } = await extractDocxText(docxWithText("Account 4123"));
    expect(text.trim()).toBe("Account 4123");
    expect(truncated).toBe(false);
  });

  it("cuts a document past the cap AND says so", async () => {
    // The defect: the cap was applied with no signal, so a long Word file
    // produced fewer pages and the studio called that page count the document.
    const { text, truncated } = await extractDocxText(docxWithText("x".repeat(MAX_DOCX_CHARS + 5_000)));
    expect(text.length).toBe(MAX_DOCX_CHARS);
    expect(truncated).toBe(true);
  });

  it("does not report truncation for a document exactly at the cap", async () => {
    // mammoth's own separators can put a byte count a hair over the limit with
    // nothing dropped; claiming a cut that did not happen is a false alarm.
    const { text, truncated } = await extractDocxText(docxWithText("y".repeat(MAX_DOCX_CHARS - 2)));
    expect(text.length).toBe(MAX_DOCX_CHARS);
    expect(truncated).toBe(false);
  });
});

describe("findingsFromOcrPages", () => {
  it("detects an email across tokens and maps it to the token rect", () => {
    const tokens = [token("Contact", 0, 0, 40), token("jane@example.com", 0, 41, 90), token("today", 0, 132, 30)];
    const findings = findingsFromOcrPages([page(tokens)], ["email"]);
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe("email");
    expect(findings[0].preview).toBe("j***@example.com");
    expect(findings[0].source).toBe("local-rules");
    expect(findings[0].rects).toEqual([{ x: 41, y: 10, width: 90, height: 16 }]);
  });

  it("returns no findings when the category is disabled", () => {
    const tokens = [token("SSN", 0, 0, 20), token("123-45-6789", 0, 21, 60)];
    const findings = findingsFromOcrPages([page(tokens)], ["email"]);
    expect(findings).toHaveLength(0);
  });

  it("prunes findings that cover only zero-area tokens", () => {
    const tokens = [token("123-45-6789", 0, 21, 0)];
    const findings = findingsFromOcrPages([page(tokens)], ["ssn"]);
    expect(findings).toHaveLength(0);
  });

  it("splits multi-line matches into separate rects", () => {
    const tokens = [token("jane@example.com", 0, 10, 90), token("jane@example.com", 1, 10, 90)];
    const p = page(tokens);
    const findings = findingsFromOcrPages([p], ["email"]);
    // Both occurrences are separate matches; each maps to its own line's rect.
    expect(findings).toHaveLength(2);
    expect(findings[0].rects).toEqual([{ x: 10, y: 10, width: 90, height: 16 }]);
    expect(findings[1].rects).toEqual([{ x: 10, y: 10, width: 90, height: 16 }]);
  });
});