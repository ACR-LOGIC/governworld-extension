// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import type { Finding } from "../shared/types.js";
import { IGNORE_ATTR, OVERLAY_ATTR, buildScanText, segmentIndexAt } from "./extract.js";
import type { TextSegment } from "./extract.js";
import { getAccessibleShadowRoot } from "./normalization/shadow.js";

/**
 * Accessibility-surface extraction (report-only).
 *
 * Scans the values of aria-label, alt, placeholder, and title attributes for
 * sensitive data. These attributes are read but NEVER written: nothing in this
 * module mutates the DOM, emits overlay masks over attribute findings, or
 * allows them to be selected for redaction. Findings are surfaced in the
 * popup with an "Attribute - report only" badge only.
 */

export const SCANNED_ATTRIBUTES = ["aria-label", "alt", "placeholder", "title"] as const;
export type ScannedAttribute = (typeof SCANNED_ATTRIBUTES)[number];

/** One read-only accessibility attribute value collected from the page. */
export interface AttrRecord {
  /** Exact attribute name, e.g. "aria-label". */
  attributeName: string;
  /** Trimmed, whitespace-collapsed attribute value slice. */
  value: string;
  /** Start offset in the original raw attribute text, preserving leading whitespace offset. */
  startOffset?: number;
}

export interface AttributeSegment extends TextSegment {
  attributeName: string;
}

export interface AttrScan {
  segments: AttributeSegment[];
  segmentStarts: number[];
  combined: string;
  truncated: boolean;
}

const TRIM_RE = /^[\s\u00a0\u200b]+|[\s\u00a0\u200b]+$/g;

/** Collapse internal whitespace runs (incl. newlines/tabs) to single spaces. */
function normalizeValue(raw: string): string {
  return raw.replace(/[\s\u00a0\u200b]+/g, " ").replace(TRIM_RE, "");
}

/**
 * Minimal structural view of a DOM element. The real content script passes
 * live Elements; tests pass fakes. Only getters are used - never setters -
 * so attribute values cannot be mutated through this interface.
 */
export interface AttrElementLike {
  getAttribute(name: string): string | null;
  closest(selector: string): unknown;
}

export interface AttrRootLike {
  querySelectorAll(selector: string): Iterable<AttrElementLike>;
}

export interface CollectOptions {
  /** Total character budget across all attribute values. */
  maxTotalChars: number;
  /** Per-attribute-value character cap. */
  maxPerValue: number;
}

function collectAllRoots(root: AttrRootLike, visited = new Set<unknown>(), depth = 0): AttrRootLike[] {
  if (depth > 10 || visited.has(root)) return [];
  visited.add(root);
  const result: AttrRootLike[] = [root];

  if (typeof (root as Document).querySelectorAll === "function") {
    try {
      const allEls = (root as Document).querySelectorAll("*");
      for (const el of Array.from(allEls)) {
        const shadow = getAccessibleShadowRoot(el as Element) ?? (el as unknown as { shadowRoot?: unknown })?.shadowRoot;
        if (shadow && !visited.has(shadow)) {
          result.push(...collectAllRoots(shadow as unknown as AttrRootLike, visited, depth + 1));
        }
        if (el.tagName && (el.tagName.toLowerCase() === "iframe" || el.tagName.toLowerCase() === "frame")) {
          try {
            const frameDoc = (el as HTMLIFrameElement).contentDocument;
            if (frameDoc && !visited.has(frameDoc)) {
              result.push(...collectAllRoots(frameDoc as unknown as AttrRootLike, visited, depth + 1));
            }
          } catch {
            // Cross-origin iframe
          }
        }
      }
    } catch {
      // Fallback for custom/mock roots
    }
  }

  return result;
}

/**
 * Read accessibility attribute values from the root, honoring scan-exclusion
 * markers and the character budgets. Strictly read-only.
 */
export function collectAttrRecords(
  root: AttrRootLike,
  options: CollectOptions
): { records: AttrRecord[]; truncated: boolean } {
  const selector = SCANNED_ATTRIBUTES.map((a) => `[${a}]`).join(",");
  const allRoots = collectAllRoots(root);
  const records: AttrRecord[] = [];
  let remaining = options.maxTotalChars;
  let truncated = false;

  for (const r of allRoots) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const nodes = Array.from(r.querySelectorAll(selector));
    for (const node of nodes) {
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      if (typeof node.closest === "function" && (node.closest(`[${OVERLAY_ATTR}]`) || node.closest(`[${IGNORE_ATTR}]`))) continue;
      for (const name of SCANNED_ATTRIBUTES) {
        if (remaining <= 0) {
          truncated = true;
          break;
        }
        const raw = node.getAttribute(name);
        if (raw === null) continue;
        const lead = raw.length - raw.replace(/^[\s\u00a0\u200b]+/, "").length;
        const value = normalizeValue(raw).slice(0, options.maxPerValue);
        if (value.length < raw.length) truncated = true;
        if (value.length === 0) continue;
        records.push({ attributeName: name, value, startOffset: lead });
        remaining -= value.length;
      }
    }
  }

  return { records, truncated };
}

/** Join attribute records into a scan text with offset tables (pure). */
export function buildAttrScan(records: AttrRecord[]): AttrScan {
  const segments: AttributeSegment[] = records.map((record, i) => ({
    nodeId: `attr_${i}`,
    attributeName: record.attributeName,
    startOffset: record.startOffset ?? 0,
    endOffset: (record.startOffset ?? 0) + record.value.length,
    text: record.value,
  }));
  const { combined, segmentStarts } = buildScanText(segments);
  return { segments, segmentStarts, combined, truncated: false };
}

/** Exact attribute name owning the combined offset, or "" when out of range. */
export function attributeAt(scan: AttrScan, offset: number): string {
  const idx = segmentIndexAt(scan.segmentStarts, scan.combined.length, offset);
  if (idx < 0) return "";
  return scan.segments[idx].attributeName;
}

/**
 * Selection guard for report-only semantics: applies the chosen id set to
 * regular findings while forcing attribute-source findings to stay
 * unselected so they can never be masked, copied as redacted, or exported
 * as selectable items.
 */
export function applySelectionExcludingAttrs(findings: Finding[] | readonly Finding[], idSet: ReadonlySet<string>): Finding[] {
  return findings.map((f) =>
    f.source === "attr" ? { ...f, selected: false } : { ...f, selected: idSet.has(f.id) }
  );
}
