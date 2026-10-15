// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import type { CanonicalSegment } from "./types.js";
import { getAccessibleShadowRoot } from "./shadow.js";

export interface TableStructure {
  tableId: string;
  rows: number;
  cols: number;
  headerRowIds: string[];
  cellSegmentIds: Map<string, { row: number; col: number; role: "header" | "cell" | "row-header" }>;
}

export function extractTableStructures(root: Document | Element | ShadowRoot): TableStructure[] {
  const tables: TableStructure[] = [];
  const doc = root instanceof Document ? root : root.ownerDocument ?? root;
  const tableElements = doc.querySelectorAll("table");

  for (let t = 0; t < tableElements.length; t++) {
    const table = tableElements[t];
    const tableId = `table_${t}`;
    const rows = table.querySelectorAll("tr");
    const cellSegmentIds = new Map<string, { row: number; col: number; role: "header" | "cell" | "row-header" }>();
    const headerRowIds: string[] = [];
    let maxCols = 0;

    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      const cells = row.querySelectorAll("th, td");
      maxCols = Math.max(maxCols, cells.length);

      for (let c = 0; c < cells.length; c++) {
        const cell = cells[c];
        const role: "header" | "cell" | "row-header" = cell.tagName === "TH" ? (r === 0 ? "header" : "row-header") : "cell";
        const cellId = `${tableId}_r${r}_c${c}`;
        cellSegmentIds.set(cellId, { row: r, col: c, role });

        if (role === "header" && !headerRowIds.includes(cellId)) {
          headerRowIds.push(cellId);
        }
      }
    }

    tables.push({
      tableId,
      rows: rows.length,
      cols: maxCols,
      headerRowIds,
      cellSegmentIds,
    });
  }

  return tables;
}

/**
 * Attaches table position to each segment by asking the DOM where its text
 * node actually lives.
 *
 * The previous implementation compared `seg.tableId_r{row}_c{col}` against the
 * segment's nodeId with `String.includes`. A nodeId is `seg_12` or
 * `frame_1_seg_12` — neither contains a table cell id and no cell id contains
 * a nodeId — so the comparison never matched, `tableRole` was never set, and
 * `formatTableContext` always returned undefined. `extractTableStructures`
 * still ran and `metadata.tableCount` still counted, so a page full of tables
 * reported table structure that nothing downstream could use.
 *
 * `nodeIds` resolves a segment back to the Text/Input node it was extracted
 * from; ancestry is then walked to the nearest cell.
 */
export function annotateSegmentsWithTableStructure(
  segments: CanonicalSegment[],
  nodeIds: Map<string, Node>
): CanonicalSegment[] {
  const annotated = [...segments];
  const cellIndex = buildCellIndex();

  for (const seg of annotated) {
    const node = nodeIds.get(seg.nodeId);
    if (!node) continue;
    const cell = nearestCell(node);
    if (!cell) continue;
    const info = cellIndex.get(cell);
    if (!info) continue;
    seg.tableRole = info.role;
    seg.tableRow = info.row;
    seg.tableCol = info.col;
  }

  return annotated;
}

interface CellInfo {
  table: HTMLTableElement;
  row: number;
  col: number;
  role: "header" | "cell" | "row-header";
}

/**
 * Maps every TD/TH in the document to its table, row and column.
 *
 * A cell's position is resolved against its own table rather than a global
 * document query: `querySelectorAll` on the document cannot see cells inside a
 * shadow root, and nested tables would otherwise collide on index.
 */
function buildCellIndex(): Map<Element, CellInfo> {
  const index = new Map<Element, CellInfo>();
  const tables: HTMLTableElement[] = [];
  collectTables(document, tables, 0);

  for (const table of tables) {
    const rows = Array.from(table.rows);
    for (let r = 0; r < rows.length; r++) {
      const cells = Array.from(rows[r].cells);
      for (let c = 0; c < cells.length; c++) {
        const cell = cells[c];
        const isHeader = cell.tagName === "TH";
        index.set(cell, {
          table,
          row: r,
          col: c,
          role: isHeader ? (r === 0 ? "header" : "row-header") : "cell",
        });
      }
    }
  }
  return index;
}

function collectTables(root: Node, out: HTMLTableElement[], depth: number): void {
  if (depth > 10) return;
  for (let child = root.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as Element;
      if (el.tagName === "TABLE") out.push(el as HTMLTableElement);
      const shadow = getAccessibleShadowRoot(el);
      if (shadow) collectTables(shadow, out, depth + 1);
    }
    // Recursed into even after finding a table: `table.rows` reports the
    // outermost rows, so a table nested inside a cell is only reachable by
    // walking in, and its cells must resolve against its own indices.
    collectTables(child, out, depth + 1);
  }
}

/** Nearest ancestor TD/TH, crossing shadow boundaries. */
function nearestCell(node: Node): Element | null {
  let current: Node | null = node;
  let root: Node | null = node;
  while (root) {
    if (root.nodeType === Node.ELEMENT_NODE) {
      const el = root as Element;
      if (el.tagName === "TD" || el.tagName === "TH") return el;
      const shadow = getAccessibleShadowRoot(el);
      if (shadow && shadow.contains(node)) {
        current = shadow;
        root = shadow;
        continue;
      }
    }
    current = root.parentNode;
    root = current;
  }
  return null;
}

export function formatTableContext(segment: CanonicalSegment): string | undefined {
  if (!segment.tableRole) return undefined;
  const roleLabel = segment.tableRole === "header" ? "header" : segment.tableRole === "row-header" ? "row header" : "cell";
  return `table ${roleLabel}, row ${(segment.tableRow ?? 0) + 1}, col ${(segment.tableCol ?? 0) + 1}`;
}
