// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import {
  extractTableStructures,
  annotateSegmentsWithTableStructure,
  formatTableContext,
} from "../src/content/normalization/table.js";
import { extractVisibleText } from "../src/content/extract.js";
import { buildCanonicalDocument } from "../src/content/normalization/canonical.js";
import type { CanonicalSegment } from "../src/content/normalization/types.js";

/** Build segments the way a real scan does, with their live DOM nodes. */
function scan(html: string): CanonicalSegment[] {
  document.body.innerHTML = html;
  const nodeIds = new Map<string, Node>();
  return buildCanonicalDocument({ root: document, nodeIds }).segments;
}

describe("table structure", () => {
  it("finds tables and their dimensions", () => {
    document.body.innerHTML = `
      <table>
        <tr><th>Name</th><th>SSN</th></tr>
        <tr><td>John</td><td>123-45-6789</td></tr>
      </table>`;
    const tables = extractTableStructures(document);
    expect(tables.length).toBe(1);
    expect(tables[0].rows).toBe(2);
    expect(tables[0].cols).toBe(2);
  });
});

describe("annotateSegmentsWithTableStructure", () => {
  it("annotates a cell segment from the DOM, not from a string comparison", () => {
    const nodeIds = new Map<string, Node>();
    document.body.innerHTML = `
      <table>
        <tr><th>Name</th><th>SSN</th></tr>
        <tr><td>John</td><td>123-45-6789</td></tr>
      </table>`;
    const canonical = buildCanonicalDocument({ root: document, nodeIds });
    const annotated = annotateSegmentsWithTableStructure(canonical.segments, nodeIds);

    const ssn = annotated.find((s) => s.text === "123-45-6789");
    expect(ssn?.tableRole).toBe("cell");
    expect(ssn?.tableRow).toBe(1);
    expect(ssn?.tableCol).toBe(1);

    const header = annotated.find((s) => s.text === "SSN");
    expect(header?.tableRole).toBe("header");
    expect(header?.tableRow).toBe(0);
  });

  it("labels a TH outside the first row as a row header", () => {
    const nodeIds = new Map<string, Node>();
    document.body.innerHTML = `
      <table>
        <tr><td>a</td></tr>
        <tr><th>Section</th><td>b</td></tr>
      </table>`;
    const canonical = buildCanonicalDocument({ root: document, nodeIds });
    const annotated = annotateSegmentsWithTableStructure(canonical.segments, nodeIds);
    const th = annotated.find((s) => s.text === "Section");
    expect(th?.tableRole).toBe("row-header");
  });

  it("leaves segments outside any table unannotated", () => {
    const nodeIds = new Map<string, Node>();
    document.body.innerHTML = `<p>Just a paragraph</p><table><tr><td>x</td></tr></table>`;
    const canonical = buildCanonicalDocument({ root: document, nodeIds });
    const annotated = annotateSegmentsWithTableStructure(canonical.segments, nodeIds);
    const para = annotated.find((s) => s.text === "Just a paragraph");
    expect(para?.tableRole).toBeUndefined();
  });

  it("annotates a cell inside a shadow root", () => {
    const nodeIds = new Map<string, Node>();
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<table><tr><td>shadow@test.com</td></tr></table>`;
    document.body.appendChild(host);
    const canonical = buildCanonicalDocument({ root: document, nodeIds });
    const annotated = annotateSegmentsWithTableStructure(canonical.segments, nodeIds);
    const cell = annotated.find((s) => s.text === "shadow@test.com");
    expect(cell?.tableRole).toBe("cell");
  });

  it("gives a nested table's cells the nested table's own indices", () => {
    const nodeIds = new Map<string, Node>();
    document.body.innerHTML = `
      <table>
        <tr><td>outer</td></tr>
        <tr><td>
          <table><tr><td>inner</td></tr></table>
        </td></tr>
      </table>`;
    const canonical = buildCanonicalDocument({ root: document, nodeIds });
    const annotated = annotateSegmentsWithTableStructure(canonical.segments, nodeIds);
    const outer = annotated.find((s) => s.text === "outer");
    const inner = annotated.find((s) => s.text === "inner");
    expect(outer?.tableRow).toBe(0);
    expect(inner?.tableRow).toBe(0);
  });

  it("ignores a segment whose node is not registered", () => {
    const segment: CanonicalSegment = {
      nodeId: "seg_missing",
      startOffset: 0,
      endOffset: 5,
      text: "Hello",
      combinedStartOffset: 0,
      combinedEndOffset: 5,
    };
    const annotated = annotateSegmentsWithTableStructure([segment], new Map());
    expect(annotated[0].tableRole).toBeUndefined();
  });
});

describe("formatTableContext", () => {
  it("describes a cell position", () => {
    document.body.innerHTML = `<table><tr><td>x</td></tr></table>`;
    const nodeIds = new Map<string, Node>();
    const canonical = buildCanonicalDocument({ root: document, nodeIds });
    const [annotated] = annotateSegmentsWithTableStructure(canonical.segments, nodeIds);
    const context = formatTableContext(annotated);
    expect(context).toContain("cell");
    expect(context).toContain("row 1");
    expect(context).toContain("col 1");
  });

  it("describes a header", () => {
    document.body.innerHTML = `<table><tr><th>Name</th></tr></table>`;
    const nodeIds = new Map<string, Node>();
    const canonical = buildCanonicalDocument({ root: document, nodeIds });
    const [annotated] = annotateSegmentsWithTableStructure(canonical.segments, nodeIds);
    expect(formatTableContext(annotated)).toContain("header");
  });

  it("returns undefined for a non-table segment", () => {
    document.body.innerHTML = `<p>Hello</p>`;
    const nodeIds = new Map<string, Node>();
    const canonical = buildCanonicalDocument({ root: document, nodeIds });
    const [annotated] = annotateSegmentsWithTableStructure(canonical.segments, nodeIds);
    expect(formatTableContext(annotated)).toBeUndefined();
  });
});

describe("extractVisibleText reaches table cells", () => {
  it("extracts text from every cell", () => {
    document.body.innerHTML = `<table><tr><td>4111111111111111</td><td>219-09-9999</td></tr></table>`;
    const nodeIds = new Map<string, Node>();
    const { segments } = extractVisibleText(document, 250_000, 10_000, nodeIds);
    const all = segments.map((s) => s.text).join(" ");
    expect(all).toContain("4111111111111111");
    expect(all).toContain("219-09-9999");
  });
});