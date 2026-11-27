// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import {
  isRecord,
  MAX_MESSAGE_BYTES,
  MESSAGE_TYPES,
} from "./types.js";
import type { DocKind, ExtensionMessage, Finding, ScanMode, DocPageMeta, RedactionOptions, RedactionStyle, DocRedactionStage, ScanSettingsMessage, OwningBackend, SupabasePairingState } from "./types.js";
import type { RedactionVerifyMethod } from "../document-pipeline/verify.js";
import { isAllowedGatewayOrigin, isCategory } from "./settings.js";
import { isPageImageKey, isPreviewKey } from "./docStore.js";
import { parseCustomPattern } from "./customPatterns.js";
import type { CustomPattern } from "./customPatterns.js";
import type { FindingCategory, IncompleteWindowInfo, PopupState, ScanStats } from "./types.js";
import type { AccountView } from "./account.js";
import { parseAccountView } from "./account.js";
import type { PatternTestResult, WizardAnalysis } from "./wizardAnalyzer.js";
import { isAuditEvent } from "./audit.js";

export type ValidationResult =
  | { ok: true; message: ExtensionMessage }
  | { ok: false; error: string };

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function isRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID_RE.test(value);
}

function isMode(value: unknown): value is ScanMode {
  return value === "local" || value === "cloud";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isDocKind(value: unknown): value is DocKind {
  return value === "pdf" || value === "image" || value === "docx";
}

function isName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 255;
}

function isFileKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

/**
 * A 0-based page offset: which page a windowed pass starts at.
 *
 * Bounded by MAX_DOC_PAGES-free arithmetic on purpose - the worker clamps it
 * against the real document anyway. What matters here is that a nonsense value
 * (negative, fractional, astronomic) fails validation instead of reaching the
 * renderer, where it would silently render the wrong pages.
 */
function isPageOffset(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 100_000;
}

function isTotalPages(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 100_000;
}

/**
 * Only http(s) and data image URLs may be captured.
 *
 * The URL comes from the page, so it is untrusted input. Rejecting every other
 * scheme keeps a page from steering the worker at `file:`, `chrome:`, or the
 * extension's own pages, and keeps a `javascript:` payload out of the fetch.
 */
function isSafeImageSrc(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return false;
  if (value.startsWith("data:image/")) return /^data:image\/(png|jpeg|jpg|webp|gif|bmp);base64,[A-Za-z0-9+/=]+$/.test(value);
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function isRect(value: unknown): value is { x: number; y: number; width: number; height: number } {
  return (
    isRecord(value) &&
    typeof value.x === "number" &&
    typeof value.y === "number" &&
    typeof value.width === "number" &&
    typeof value.height === "number" &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.width) &&
    Number.isFinite(value.height) &&
    value.x >= 0 &&
    value.y >= 0 &&
    value.width >= 0 &&
    value.height >= 0
  );
}

const FINDING_ID_RE = /^[a-z][a-z0-9:_-]{0,127}$/;
// eslint-disable-next-line security/detect-unsafe-regex
const NODE_ID_RE = /^(?:[A-Za-z0-9][A-Za-z0-9:_-]{0,127})?$/;
const ATTRIBUTE_NAMES = new Set(["aria-label", "alt", "placeholder", "title"]);
const ALL_MASKED_PREVIEW_RE = /^[\s*]+$/;

function isMaskedPreview(category: FindingCategory, preview: string): boolean {
  if (preview.length === 0 || preview.length > 256) return false;
  switch (category) {
    case "email":
      return /^(?:[\p{L}\p{N}._%+-]{0,2}\*{3,}@[\p{L}\p{N}.-]{1,190}|[\s*]+)$/u.test(preview);
    case "phone":
      return /^(?:\*{3}-\*{3}-\d{4}|[\s*]+)$/.test(preview);
    case "ssn":
      return /^(?:\*{3}-\*{2}-\d{4}|[\s*]+)$/.test(preview);
    case "payment_card":
      return /^(?:\*{12}\d{4}|[\s*]+)$/.test(preview);
    case "npi":
      return /^(?:\*{6}-\d{4}|[\s*]+)$/.test(preview);
    case "mbi":
      return /^(?:\*{7}\d{4}|[\s*]+)$/.test(preview);
    case "dob":
      return preview === "**/**/****";
    case "dea":
      return preview === "*********";
    case "secrets":
      return /^(?:[^\s*]\*{3,}|[\s*]+)$/.test(preview);
    case "canadian_sin":
      return /^(?:\*{3}-\*{3}-\d{3}|[\s*]+)$/.test(preview);
    case "uk_nhs":
      return /^(?:\*{3}-\*{3}-\d{4}|[\s*]+)$/.test(preview);
    case "aadhaar":
      return /^(?:\*{4}-\*{4}-\d{4}|[\s*]+)$/.test(preview);
    case "pan_india":
      return /^(?:\*{5}[0-9A-Za-z]{5}|[\s*]+)$/.test(preview);
    case "australian_tfn":
      return /^(?:\*{3}-\*{3}-\d{2,3}|[\s*]+)$/.test(preview);
    case "cpf":
      return /^(?:\*{3}\.\*{3}\.\*{3}-\d{2}|[\s*]+)$/.test(preview);
    case "bank_account":
      return /^(?:\*{4}\d{4}|[\s*]+)$/.test(preview);
    case "username":
      return /^(?:[^\s*]\*{3,}|[\s*]+)$/.test(preview);
    case "ip_address":
    case "financial":
      return ALL_MASKED_PREVIEW_RE.test(preview);
    case "possible_name":
    case "medical_record_number":
    case "member_id":
    case "address":
    case "custom":
      return ALL_MASKED_PREVIEW_RE.test(preview);
    default:
      return false;
  }
}

function isDocPageMeta(value: unknown): value is DocPageMeta {
  if (!isRecord(value)) return false;
  // `pageImageKey` is optional (a session persisted by an older build has none,
  // and the review page falls back to the thumbnail), but when present it must
  // still be a well-formed store key rather than an arbitrary string.
  if (value.pageImageKey !== undefined && !isPageImageKey(value.pageImageKey)) return false;
  if (value.lowOcrConfidence !== undefined && typeof value.lowOcrConfidence !== "boolean") return false;
  return (
    typeof value.index === "number" &&
    typeof value.widthPx === "number" &&
    typeof value.heightPx === "number" &&
    isPreviewKey(value.previewKey) &&
    Array.isArray(value.findings) &&
    value.findings.every(isFinding)
  );
}

function isFinding(value: unknown): value is Finding {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || !FINDING_ID_RE.test(value.id) || !isCategory(value.category)) return false;
  if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) return false;
  if (
    value.source !== "local-rules" &&
    value.source !== "local-model" &&
    value.source !== "gateway" &&
    value.source !== "attr" &&
    value.source !== "custom-pattern" &&
    value.source !== "selection"
  ) return false;
  if (typeof value.preview !== "string" || !isMaskedPreview(value.category, value.preview)) return false;
  if (
    value.contextPreview !== undefined &&
    (typeof value.contextPreview !== "string" || value.contextPreview.length > 512 || !/^[\s*]*$/.test(value.contextPreview))
  ) return false;
  if (typeof value.nodeId !== "string" || !NODE_ID_RE.test(value.nodeId)) return false;
  if (
    typeof value.startOffset !== "number" ||
    typeof value.endOffset !== "number" ||
    !Number.isSafeInteger(value.startOffset) ||
    !Number.isSafeInteger(value.endOffset) ||
    value.startOffset < 0 ||
    value.endOffset < value.startOffset
  ) return false;
  if (value.entityType !== undefined && (typeof value.entityType !== "string" || value.entityType.length > 64)) return false;
  if (!Array.isArray(value.rects) || value.rects.length > 1000 || !value.rects.every(isRect)) return false;
  if (value.source === "attr") {
    if (typeof value.attribute !== "string" || !ATTRIBUTE_NAMES.has(value.attribute) || value.selected !== false) return false;
  } else if (value.attribute !== undefined) return false;
  return typeof value.selected === "boolean";
}

function normalizeFindingArray(value: unknown): Finding[] | null {
  if (!Array.isArray(value) || !value.every(isFinding)) return null;
  return value.map((finding) => ({
    id: finding.id,
    category: finding.category,
    confidence: finding.confidence,
    source: finding.source,
    preview: finding.preview,
    nodeId: finding.nodeId,
    startOffset: finding.startOffset,
    endOffset: finding.endOffset,
    rects: finding.rects.map((rect) => ({ ...rect })),
    ...(finding.contextPreview !== undefined ? { contextPreview: finding.contextPreview } : {}),
    ...(finding.entityType !== undefined ? { entityType: finding.entityType } : {}),
    ...(finding.attribute !== undefined ? { attribute: finding.attribute } : {}),
    selected: finding.selected,
  }));
}

const SCAN_COVERAGE_STATUSES = new Set([
  "FULLY_SCANNED",
  "PARTIALLY_SCANNED",
  "UNSUPPORTED_CONTENT_PRESENT",
  "BLOCKED_BY_BROWSER_SECURITY",
  "NO_SENSITIVE_DATA_DETECTED",
  "SCAN_FAILED",
]);

const VISUAL_SOURCE_TYPES = new Set([
  "image-ocr", "canvas-ocr", "video-frame-ocr", "pdf-text", "pdf-ocr", "screenshot-ocr",
]);

const VISIBILITY_STATES = new Set([
  "VISIBLE_IN_VIEWPORT", "VISIBLE_OUT_OF_VIEWPORT",
  "HIDDEN_COLLAPSED_UI", "HIDDEN_METADATA", "UNVERIFIED_VISIBILITY",
]);

/**
 * Validate one VisualCaptureRequestItem from untrusted content-script input.
 * All fields are validated; malformed items are dropped (not returning null for
 * the whole stats object). dataUrl is only accepted as a data:image/ prefix
 * and only when ≤ 64 KB so it cannot exceed MAX_MESSAGE_BYTES on its own.
 */
function normalizeVisualCaptureItem(entry: unknown): import("../shared/types.js").VisualCaptureRequestItem | null {
  if (!isRecord(entry)) return null;
  if (typeof entry.sourceId !== "string" || entry.sourceId.length === 0 || entry.sourceId.length > 64) return null;
  if (!VISUAL_SOURCE_TYPES.has(entry.sourceType as string)) return null;
  if (typeof entry.cssSelector !== "string" || entry.cssSelector.length > 1024) return null;
  if (typeof entry.elementTag !== "string" || entry.elementTag.length > 64) return null;
  if (!VISIBILITY_STATES.has(entry.visibility as string)) return null;
  if (
    entry.resourceUrl !== undefined &&
    !isSafeImageSrc(entry.resourceUrl) &&
    !(isSafeFetchUrl(entry.resourceUrl) && /\.pdf($|\?|#)/i.test(entry.resourceUrl))
  ) {
    return null;
  }
  if (entry.dataUrl !== undefined) {
    if (typeof entry.dataUrl !== "string") return null;
    if (!entry.dataUrl.startsWith("data:image/")) return null;
    if (entry.dataUrl.length > 65_536) return null; // hard cap — never allow inline blobs near the 64 KB message limit
  }
  if (entry.cropRect !== undefined && !isRect(entry.cropRect)) return null;
  return {
    sourceId: entry.sourceId as string,
    sourceType: entry.sourceType as import("../shared/types.js").VisualCaptureRequestItem["sourceType"],
    cssSelector: entry.cssSelector as string,
    elementTag: entry.elementTag as string,
    resourceUrl: typeof entry.resourceUrl === "string" ? entry.resourceUrl : undefined,
    dataUrl: typeof entry.dataUrl === "string" ? entry.dataUrl : undefined,
    cropRect: entry.cropRect !== undefined ? (entry.cropRect as { x: number; y: number; width: number; height: number }) : undefined,
    visibility: entry.visibility as import("../shared/types.js").VisualCaptureRequestItem["visibility"],
  };
}

function normalizeVisualQueue(value: unknown): import("../shared/types.js").VisualCaptureRequestItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: import("../shared/types.js").VisualCaptureRequestItem[] = [];
  for (const entry of value) {
    if (out.length >= 8) break; // enforce server-side OCR budget cap
    const item = normalizeVisualCaptureItem(entry);
    if (item) out.push(item);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Scheme check for a URL the WORKER will fetch on a page's behalf.
 */
function isSafeFetchUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function normalizePdfQueue(value: unknown): import("../shared/types.js").PdfExtractRequestItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: import("../shared/types.js").PdfExtractRequestItem[] = [];
  for (const entry of value) {
    if (out.length >= 8) break;
    if (!isRecord(entry)) continue;
    if (!isSafeFetchUrl(entry.url)) continue;
    if (typeof entry.cssSelector !== "string" || entry.cssSelector.length > 1024) continue;
    if (typeof entry.isTopLevel !== "boolean") continue;
    out.push({ url: entry.url, cssSelector: entry.cssSelector, isTopLevel: entry.isTopLevel });
  }
  return out.length > 0 ? out : undefined;
}

export const DEFAULT_FINDINGS_CHUNK_BYTES = 48 * 1024;

/**
 * Partition findings into byte-bounded chunks so every IPC message stays
 * comfortably under Chrome's 64 KB MAX_MESSAGE_BYTES limit without dropping findings.
 */
export function chunkFindingsByByteBudget(
  findings: Finding[],
  budgetBytes: number = DEFAULT_FINDINGS_CHUNK_BYTES
): Finding[][] {
  if (findings.length <= 1) return [findings];
  const full = JSON.stringify(findings);
  if (full.length <= budgetBytes) return [findings];

  const chunks: Finding[][] = [];
  let current: Finding[] = [];
  let currentBytes = 2; // "[]"
  for (const finding of findings) {
    const serializedLen = JSON.stringify(finding).length;
    const addition = current.length > 0 ? serializedLen + 1 : serializedLen;
    if (current.length > 0 && currentBytes + addition > budgetBytes) {
      chunks.push(current);
      current = [finding];
      currentBytes = 2 + serializedLen;
    } else {
      current.push(finding);
      currentBytes += addition;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks.length > 0 ? chunks : [[]];
}

function normalizeIncompleteWindows(value: unknown): IncompleteWindowInfo[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: IncompleteWindowInfo[] = [];
  for (const entry of value) {
    if (out.length >= 256) break;
    if (!isRecord(entry)) continue;
    if (typeof entry.windowIndex !== "number" || !Number.isSafeInteger(entry.windowIndex) || entry.windowIndex < 1) continue;
    if (typeof entry.reason !== "string" || entry.reason.length === 0 || entry.reason.length > 256) continue;
    out.push({ windowIndex: entry.windowIndex, reason: entry.reason });
  }
  return out.length > 0 ? out : undefined;
}

const COVERAGE_WARNING_CAUSES = new Set<string>([
  "incomplete_window",
  "truncated",
  "cross_origin_iframe",
  "closed_shadow_root",
  "canvas_only",
]);

function normalizeCoverageWarnings(value: unknown): import("./types.js").CoverageWarning[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: import("./types.js").CoverageWarning[] = [];
  for (const entry of value) {
    if (out.length >= 16) break;
    if (!isRecord(entry)) continue;
    if (typeof entry.cause !== "string" || !COVERAGE_WARNING_CAUSES.has(entry.cause)) continue;
    if (typeof entry.count !== "number" || !Number.isSafeInteger(entry.count) || entry.count < 1) continue;
    if (entry.detail !== undefined && (typeof entry.detail !== "string" || entry.detail.length > 512)) continue;
    out.push({
      cause: entry.cause as import("./types.js").CoverageWarningCause,
      count: entry.count,
      ...(typeof entry.detail === "string" && entry.detail.length > 0 ? { detail: entry.detail } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

function normalizeScanStats(value: unknown): ScanStats | null {
  if (!isRecord(value) || typeof value.visibleChars !== "number" || !Number.isSafeInteger(value.visibleChars) || value.visibleChars < 0) return null;
  if (value.attrChars !== undefined && (typeof value.attrChars !== "number" || !Number.isSafeInteger(value.attrChars) || value.attrChars < 0)) return null;
  if (typeof value.truncated !== "boolean") return null;
  if (value.windowsScanned !== undefined && (typeof value.windowsScanned !== "number" || !Number.isSafeInteger(value.windowsScanned) || value.windowsScanned < 0)) return null;
  if (value.windowsTotal !== undefined && (typeof value.windowsTotal !== "number" || !Number.isSafeInteger(value.windowsTotal) || value.windowsTotal < 0)) return null;
  if (value.findingsTruncated !== undefined && typeof value.findingsTruncated !== "boolean") return null;
  if (value.totalFindings !== undefined && (typeof value.totalFindings !== "number" || !Number.isSafeInteger(value.totalFindings) || value.totalFindings < 0)) return null;
  if (value.startedAt !== undefined && (typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt))) return null;
  if (value.finishedAt !== undefined && (typeof value.finishedAt !== "number" || !Number.isFinite(value.finishedAt))) return null;
  const imageCandidates = value.imageCandidates === undefined ? undefined : normalizeImageCandidates(value.imageCandidates);
  // Advisory fields (visualQueue, pdfQueue, deferredMediaCount, coverageStatus, incompleteWindows) are dropped
  // rather than failing the whole scan when malformed. Findings remain valid.
  const visualQueue = value.visualQueue === undefined ? undefined : normalizeVisualQueue(value.visualQueue);
  const pdfQueue = value.pdfQueue === undefined ? undefined : normalizePdfQueue(value.pdfQueue);
  const incompleteWindows = value.incompleteWindows === undefined ? undefined : normalizeIncompleteWindows(value.incompleteWindows);
  const coverageWarnings = value.coverageWarnings === undefined ? undefined : normalizeCoverageWarnings(value.coverageWarnings);
  const deferredMediaCount =
    typeof value.deferredMediaCount === "number" &&
    Number.isSafeInteger(value.deferredMediaCount) &&
    value.deferredMediaCount >= 0
      ? value.deferredMediaCount
      : undefined;
  const coverageStatus =
    typeof value.coverageStatus === "string" && SCAN_COVERAGE_STATUSES.has(value.coverageStatus)
      ? (value.coverageStatus as import("../shared/types.js").ScanCoverageStatus)
      : undefined;
  return {
    visibleChars: value.visibleChars,
    ...(value.attrChars !== undefined ? { attrChars: value.attrChars } : {}),
    truncated: value.truncated,
    ...(value.windowsScanned !== undefined ? { windowsScanned: value.windowsScanned } : {}),
    ...(value.windowsTotal !== undefined ? { windowsTotal: value.windowsTotal } : {}),
    ...(incompleteWindows ? { incompleteWindows } : {}),
    ...(value.findingsTruncated !== undefined ? { findingsTruncated: value.findingsTruncated } : {}),
    ...(value.totalFindings !== undefined ? { totalFindings: value.totalFindings } : {}),
    ...(value.startedAt !== undefined ? { startedAt: value.startedAt } : {}),
    ...(value.finishedAt !== undefined ? { finishedAt: value.finishedAt } : {}),
    ...(imageCandidates ? { imageCandidates } : {}),
    ...(visualQueue ? { visualQueue } : {}),
    ...(pdfQueue ? { pdfQueue } : {}),
    ...(deferredMediaCount !== undefined ? { deferredMediaCount } : {}),
    ...(coverageStatus !== undefined ? { coverageStatus } : {}),
    ...(coverageWarnings ? { coverageWarnings } : {}),
  };
}

/** A page image the user could lift into the Document Studio for OCR. */
export interface ImageCandidate {
  src: string;
  width: number;
  height: number;
  sameOrigin: boolean;
}

function normalizeImageCandidates(value: unknown): ImageCandidate[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: ImageCandidate[] = [];
  for (const entry of value) {
    if (out.length >= 12) break;
    if (!isRecord(entry)) continue;
    if (!isSafeImageSrc(entry.src)) continue;
    const width = entry.width;
    const height = entry.height;
    if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) continue;
    if (typeof height !== "number" || !Number.isFinite(height) || height <= 0) continue;
    out.push({ src: entry.src, width: Math.round(width), height: Math.round(height), sameOrigin: entry.sameOrigin === true });
  }
  return out.length > 0 ? out : undefined;
}

function normalizeWizardAnalysis(value: unknown): WizardAnalysis | null {
  if (!isRecord(value) || !isCategory(value.category) || typeof value.proposedPattern !== "string" || value.proposedPattern.length > 512 || typeof value.proposedFlags !== "string") return null;
  if (!Array.isArray(value.characteristics) || !value.characteristics.every((item) => isRecord(item) && typeof item.label === "string" && item.label.length <= 200 && (item.detail === undefined || (typeof item.detail === "string" && item.detail.length <= 500)))) return null;
  if (!Array.isArray(value.matchResults) || !value.matchResults.every((item) => isRecord(item) && typeof item.exampleIndex === "number" && Number.isSafeInteger(item.exampleIndex) && item.exampleIndex >= 0 && typeof item.matched === "boolean" && typeof item.matchCount === "number" && Number.isSafeInteger(item.matchCount) && item.matchCount >= 0 && item.matchCount <= 1000)) return null;
  if (typeof value.qualityScore !== "number" || !Number.isFinite(value.qualityScore) || value.qualityScore < 0 || value.qualityScore > 1) return null;
  if (!Array.isArray(value.limitations) || !value.limitations.every((item) => typeof item === "string" && item.length <= 500)) return null;
  return {
    category: value.category,
    proposedPattern: value.proposedPattern,
    proposedFlags: value.proposedFlags,
    characteristics: value.characteristics.map((item) => ({ label: item.label as string, ...(item.detail !== undefined ? { detail: item.detail as string } : {}) })),
    matchResults: value.matchResults.map((item) => ({ exampleIndex: item.exampleIndex as number, matched: item.matched as boolean, matchCount: item.matchCount as number })),
    qualityScore: value.qualityScore,
    limitations: value.limitations as string[],
  };
}

function normalizePatternTestResults(value: unknown): PatternTestResult[] | null {
  if (!Array.isArray(value)) return null;
  const results: PatternTestResult[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.caseIndex !== "number" || !Number.isSafeInteger(item.caseIndex) || item.caseIndex < 0 || typeof item.matched !== "boolean" || typeof item.matchCount !== "number" || !Number.isSafeInteger(item.matchCount) || item.matchCount < 0 || item.matchCount > 1000) return null;
    results.push({ caseIndex: item.caseIndex, matched: item.matched, matchCount: item.matchCount });
  }
  return results;
}

function normalizeCustomPatterns(value: unknown): CustomPattern[] | null {
  if (!Array.isArray(value)) return null;
  const patterns: CustomPattern[] = [];
  for (const item of value) {
    const parsed = parseCustomPattern(item);
    if (!parsed.ok) return null;
    patterns.push(parsed.pattern);
  }
  return patterns;
}

/** Serialized size guard - reject oversized payloads before trusting them. */
function withinSizeLimit(raw: Record<string, unknown>): boolean {
  try {
    return JSON.stringify(raw).length <= MAX_MESSAGE_BYTES;
  } catch {
    return false;
  }
}

function isConfidenceThresholds(value: unknown): value is Record<FindingCategory, number> {
  if (!isRecord(value)) return false;
  for (const [k, v] of Object.entries(value)) {
    if (!isCategory(k)) return false;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) return false;
  }
  return true;
}

export function isScanSettings(value: unknown): value is ScanSettingsMessage {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value.enabledCategories) &&
    value.enabledCategories.every(isCategory) &&
    typeof value.maxVisibleChars === "number" &&
    typeof value.maxNodeChars === "number" &&
    typeof value.maskPlaceholders === "boolean" &&
    typeof value.sessionTimeoutMs === "number" &&
    value.sessionTimeoutMs >= 0 &&
    (value.confidenceThresholds === undefined || isConfidenceThresholds(value.confidenceThresholds)) &&
    (value.autoMaskSingleNames === undefined || typeof value.autoMaskSingleNames === "boolean") &&
    (value.medicalDictionaryEnabled === undefined || typeof value.medicalDictionaryEnabled === "boolean") &&
    (value.clinicMode === undefined || (typeof value.clinicMode === "string" && ["general", "pediatrics", "obgyn", "geriatrics", "urology"].includes(value.clinicMode))) &&
    (value.windowChars === undefined || (typeof value.windowChars === "number" && Number.isSafeInteger(value.windowChars) && value.windowChars >= 100)) &&
    (value.windowOverlapChars === undefined || (typeof value.windowOverlapChars === "number" && Number.isSafeInteger(value.windowOverlapChars) && value.windowOverlapChars >= 0)) &&
    (value.maxTotalWindows === undefined || (typeof value.maxTotalWindows === "number" && Number.isSafeInteger(value.maxTotalWindows) && value.maxTotalWindows >= 1))
  );
}

const PINNED_TARGET_STATUSES = new Set<string>(["unpinned", "pinned", "navigated", "closed"]);

function normalizePinnedTargetInfo(value: unknown): import("./types.js").PinnedTargetInfo | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.status !== "string" || !PINNED_TARGET_STATUSES.has(value.status)) return undefined;
  const pinnedTabId =
    value.pinnedTabId === null
      ? null
      : typeof value.pinnedTabId === "number" && Number.isSafeInteger(value.pinnedTabId) && value.pinnedTabId > 0
        ? value.pinnedTabId
        : null;
  const availableTabs: import("./types.js").ScannableTabSummary[] = [];
  if (Array.isArray(value.availableTabs)) {
    for (const item of value.availableTabs) {
      if (availableTabs.length >= 64) break;
      if (!isRecord(item)) continue;
      if (typeof item.tabId !== "number" || !Number.isSafeInteger(item.tabId) || item.tabId <= 0) continue;
      if (typeof item.title !== "string" || typeof item.url !== "string" || typeof item.domain !== "string") continue;
      availableTabs.push({
        tabId: item.tabId,
        title: item.title.slice(0, 200),
        url: item.url.slice(0, 1024),
        domain: item.domain.slice(0, 256),
        active: item.active === true,
        // Favicons are browser-supplied URLs; only http(s) and the browser's
        // own chrome://favicon/ scheme are passed through.
        ...(typeof item.favIconUrl === "string" && /^(https?:|chrome:\/\/favicon\/)/.test(item.favIconUrl)
          ? { favIconUrl: item.favIconUrl.slice(0, 1024) }
          : {}),
      });
    }
  }
  return {
    status: value.status as import("./types.js").PinnedTargetStatus,
    pinnedTabId,
    ...(typeof value.title === "string" ? { title: value.title.slice(0, 200) } : {}),
    ...(typeof value.url === "string" ? { url: value.url.slice(0, 1024) } : {}),
    ...(typeof value.domain === "string" ? { domain: value.domain.slice(0, 256) } : {}),
    ...(typeof value.scannedUrl === "string" ? { scannedUrl: value.scannedUrl.slice(0, 1024) } : {}),
    ...(typeof value.closedTitle === "string" ? { closedTitle: value.closedTitle.slice(0, 200) } : {}),
    ...(typeof value.closedDomain === "string" ? { closedDomain: value.closedDomain.slice(0, 256) } : {}),
    availableTabs,
  };
}

function normalizePopupState(value: unknown): PopupState | null {
  if (!isRecord(value) || (value.mode !== "local" && value.mode !== "cloud") || typeof value.scanning !== "boolean" || typeof value.scanned !== "boolean" || typeof value.truncated !== "boolean" || typeof value.visibleChars !== "number" || !Number.isSafeInteger(value.visibleChars) || value.visibleChars < 0) return null;
  if (value.findingsTruncated !== undefined && typeof value.findingsTruncated !== "boolean") return null;
  if (value.totalFindings !== undefined && (typeof value.totalFindings !== "number" || !Number.isSafeInteger(value.totalFindings) || value.totalFindings < 0)) return null;
  const findings = normalizeFindingArray(value.findings);
  if (!findings || typeof value.consentRequired !== "boolean") return null;
  if (value.sessionId !== undefined && (typeof value.sessionId !== "string" || value.sessionId.length > 128)) return null;
  const imageCandidates = value.imageCandidates === undefined ? undefined : normalizeImageCandidates(value.imageCandidates);
  let error: { code: string; userMessage: string } | undefined;
  if (value.error !== undefined) {
    if (!isRecord(value.error) || typeof value.error.code !== "string" || typeof value.error.userMessage !== "string" || value.error.code.length > 100 || value.error.userMessage.length > 500) return null;
    error = { code: value.error.code, userMessage: value.error.userMessage };
  }
  const coverageStatus =
    typeof value.coverageStatus === "string" && SCAN_COVERAGE_STATUSES.has(value.coverageStatus)
      ? (value.coverageStatus as import("../shared/types.js").ScanCoverageStatus)
      : undefined;
  const deferredMediaCount =
    typeof value.deferredMediaCount === "number" &&
    Number.isSafeInteger(value.deferredMediaCount) &&
    value.deferredMediaCount >= 0
      ? value.deferredMediaCount
      : undefined;
  const windowsScanned =
    typeof value.windowsScanned === "number" &&
    Number.isSafeInteger(value.windowsScanned) &&
    value.windowsScanned >= 0
      ? value.windowsScanned
      : undefined;
  const windowsTotal =
    typeof value.windowsTotal === "number" &&
    Number.isSafeInteger(value.windowsTotal) &&
    value.windowsTotal >= 0
      ? value.windowsTotal
      : undefined;
  const incompleteWindows =
    value.incompleteWindows === undefined ? undefined : normalizeIncompleteWindows(value.incompleteWindows);
  const coverageWarnings =
    value.coverageWarnings === undefined ? undefined : normalizeCoverageWarnings(value.coverageWarnings);
  const pinnedTarget =
    value.pinnedTarget === undefined ? undefined : normalizePinnedTargetInfo(value.pinnedTarget);
  return {
    mode: value.mode,
    ...(value.operatingMode === "MANAGE" || value.operatingMode === "LOCAL" ? { operatingMode: value.operatingMode } : {}),
    scanning: value.scanning,
    findings,
    scanned: value.scanned,
    truncated: value.truncated,
    ...(value.findingsTruncated !== undefined ? { findingsTruncated: value.findingsTruncated } : {}),
    ...(value.totalFindings !== undefined ? { totalFindings: value.totalFindings } : {}),
    visibleChars: value.visibleChars,
    ...(imageCandidates ? { imageCandidates } : {}),
    ...(error ? { error } : {}),
    consentRequired: value.consentRequired,
    ...(value.sessionId !== undefined ? { sessionId: value.sessionId } : {}),
    ...(coverageStatus ? { coverageStatus } : {}),
    ...(deferredMediaCount !== undefined ? { deferredMediaCount } : {}),
    ...(windowsScanned !== undefined ? { windowsScanned } : {}),
    ...(windowsTotal !== undefined ? { windowsTotal } : {}),
    ...(incompleteWindows ? { incompleteWindows } : {}),
    ...(coverageWarnings ? { coverageWarnings } : {}),
    ...(pinnedTarget ? { pinnedTarget } : {}),
  };
}

function isApiKey(value: unknown): value is string {
  return typeof value === "string" && /^gw_(live|test)_[A-Za-z0-9]{8,}$/.test(value);
}

function normalizeCustomPattern(value: unknown): CustomPattern | null {
  const parsed = parseCustomPattern(value);
  return parsed.ok ? parsed.pattern : null;
}

export function normalizeRedactionOptions(value: unknown): RedactionOptions | undefined {
  if (!isRecord(value)) return undefined;
  let style: RedactionStyle | undefined;
  if (value.style === "blackout" || value.style === "whiteout" || value.style === "stamp") {
    style = value.style;
  }
  let stampText: string | undefined;
  if (typeof value.stampText === "string" && value.stampText.length <= 100) {
    stampText = value.stampText;
  }
  let padding: number | undefined;
  if (typeof value.padding === "number" && Number.isFinite(value.padding) && value.padding >= 0 && value.padding <= 100) {
    padding = value.padding;
  }
  let fillColor: string | undefined;
  if (typeof value.fillColor === "string" && /^#[0-9a-fA-F]{6}$/.test(value.fillColor)) {
    fillColor = value.fillColor;
  }
  return {
    ...(style ? { style } : {}),
    ...(stampText !== undefined ? { stampText } : {}),
    ...(padding !== undefined ? { padding } : {}),
    ...(fillColor ? { fillColor } : {}),
  };
}

export function validateMessage(raw: unknown): ValidationResult {
  if (!isRecord(raw)) return { ok: false, error: "Message must be an object" };
  if (!withinSizeLimit(raw)) return { ok: false, error: "Message exceeds size limit" };

  const type = raw.type;
  if (typeof type !== "string" || !MESSAGE_TYPES.has(type)) {
    return { ok: false, error: `Unknown message type: ${String(type)}` };
  }

  if (!isRequestId(raw.requestId)) {
    return { ok: false, error: "Invalid or missing requestId" };
  }

  const requestId = raw.requestId;

  switch (type) {
    case "POPUP_SCAN": {
      if (!isMode(raw.mode)) return { ok: false, error: "Invalid mode" };
      if (raw.tabId !== undefined && (typeof raw.tabId !== "number" || !Number.isSafeInteger(raw.tabId) || raw.tabId <= 0)) return { ok: false, error: "Invalid tabId" };
      return { ok: true, message: { type, requestId, mode: raw.mode, ...(typeof raw.tabId === "number" ? { tabId: raw.tabId } : {}) } };
    }
    case "POPUP_PIN_TAB": {
      const tabId = raw.tabId;
      if (tabId !== null && (typeof tabId !== "number" || !Number.isSafeInteger(tabId) || tabId <= 0)) {
        return { ok: false, error: "Invalid tabId" };
      }
      if (raw.pinCurrent !== undefined && typeof raw.pinCurrent !== "boolean") {
        return { ok: false, error: "Invalid pinCurrent" };
      }
      return {
        ok: true,
        message: {
          type,
          requestId,
          tabId,
          ...(typeof raw.pinCurrent === "boolean" ? { pinCurrent: raw.pinCurrent } : {}),
        },
      };
    }
    case "POPUP_APPLY_MASKS": {
      if (!isStringArray(raw.findingIds)) return { ok: false, error: "Invalid findingIds" };
      if (raw.tabId !== undefined && (typeof raw.tabId !== "number" || !Number.isSafeInteger(raw.tabId) || raw.tabId <= 0)) return { ok: false, error: "Invalid tabId" };
      return { ok: true, message: { type, requestId, findingIds: raw.findingIds, ...(typeof raw.tabId === "number" ? { tabId: raw.tabId } : {}) } };
    }
    case "POPUP_REMOVE_MASKS":
    case "POPUP_CLEAR_DATA":
    case "POPUP_GET_STATE":
      if (raw.tabId !== undefined && (typeof raw.tabId !== "number" || !Number.isSafeInteger(raw.tabId) || raw.tabId <= 0)) return { ok: false, error: "Invalid tabId" };
      return { ok: true, message: { type, requestId, ...(typeof raw.tabId === "number" ? { tabId: raw.tabId } : {}) } };
    case "POPUP_COPY_REDACTED": {
      if (!isStringArray(raw.findingIds)) return { ok: false, error: "Invalid findingIds" };
      if (raw.tabId !== undefined && (typeof raw.tabId !== "number" || !Number.isSafeInteger(raw.tabId) || raw.tabId <= 0)) return { ok: false, error: "Invalid tabId" };
      return { ok: true, message: { type, requestId, findingIds: raw.findingIds, ...(typeof raw.tabId === "number" ? { tabId: raw.tabId } : {}) } };
    }
    case "POPUP_SET_MODE": {
      if (!isMode(raw.mode)) return { ok: false, error: "Invalid mode" };
      return { ok: true, message: { type, requestId, mode: raw.mode } };
    }
    case "POPUP_DOC_PREVIEW": {
      if (!isFileKey(raw.fileKey)) return { ok: false, error: "Invalid fileKey" };
      if (!isName(raw.name)) return { ok: false, error: "Invalid name" };
      if (typeof raw.mimeType !== "string" || !raw.mimeType) return { ok: false, error: "Invalid mimeType" };
      if (!isDocKind(raw.kind)) return { ok: false, error: "Invalid kind" };
      if (raw.pageOffset !== undefined && !isPageOffset(raw.pageOffset)) return { ok: false, error: "Invalid pageOffset" };
      if (raw.totalPages !== undefined && !isTotalPages(raw.totalPages)) return { ok: false, error: "Invalid totalPages" };
      return { ok: true, message: { type, requestId, fileKey: raw.fileKey, name: raw.name, mimeType: raw.mimeType, kind: raw.kind, ...(raw.pageOffset !== undefined ? { pageOffset: raw.pageOffset } : {}), ...(raw.totalPages !== undefined ? { totalPages: raw.totalPages } : {}) } };
    }
    case "POPUP_DOC_COUNT": {
      if (!isFileKey(raw.fileKey)) return { ok: false, error: "Invalid fileKey" };
      if (!isName(raw.name)) return { ok: false, error: "Invalid name" };
      if (typeof raw.mimeType !== "string" || !raw.mimeType) return { ok: false, error: "Invalid mimeType" };
      if (!isDocKind(raw.kind)) return { ok: false, error: "Invalid kind" };
      return { ok: true, message: { type, requestId, fileKey: raw.fileKey, name: raw.name, mimeType: raw.mimeType, kind: raw.kind } };
    }
    case "POPUP_DOC_REDACT": {
      if (!isFileKey(raw.fileKey)) return { ok: false, error: "Invalid fileKey" };
      if (typeof raw.docId !== "string" || !raw.docId) return { ok: false, error: "Invalid docId" };
      if (!isName(raw.name)) return { ok: false, error: "Invalid name" };
      if (typeof raw.mimeType !== "string" || !raw.mimeType) return { ok: false, error: "Invalid mimeType" };
      if (!isDocKind(raw.kind)) return { ok: false, error: "Invalid kind" };
      if (
        !Array.isArray(raw.boxes) ||
        raw.boxes.some(
          (b) =>
            !isRecord(b) ||
            typeof b.pageIndex !== "number" ||
            !Array.isArray(b.rects) ||
            !b.rects.every(isRect)
        )
      ) {
        return { ok: false, error: "Invalid boxes" };
      }
      if (!isStringArray(raw.findingIds)) return { ok: false, error: "Invalid findingIds" };
      const options = normalizeRedactionOptions(raw.options);
      return {
        ok: true,
        message: {
          type,
          requestId,
          docId: raw.docId,
          fileKey: raw.fileKey,
          name: raw.name,
          mimeType: raw.mimeType,
          kind: raw.kind,
          boxes: raw.boxes,
          findingIds: raw.findingIds,
          ...(options ? { options } : {}),
        },
      };
    }
    case "POPUP_DOC_PRINT": {
      if (!isFileKey(raw.fileKey)) return { ok: false, error: "Invalid fileKey" };
      return { ok: true, message: { type, requestId, fileKey: raw.fileKey } };
    }
    case "POPUP_DOC_DELIVERY_REPORT": {
      if (typeof raw.delivered !== "boolean") return { ok: false, error: "Invalid delivered" };
      return { ok: true, message: { type, requestId, delivered: raw.delivered } };
    }
    case "POPUP_DOC_CANCEL": {
      const hasDocId = raw.docId !== undefined;
      const hasFileKey = raw.fileKey !== undefined;
      if (hasDocId && (typeof raw.docId !== "string" || !raw.docId)) return { ok: false, error: "Invalid docId" };
      if (hasFileKey && !isFileKey(raw.fileKey)) return { ok: false, error: "Invalid fileKey" };
      if (!hasDocId && !hasFileKey) return { ok: false, error: "Missing docId or fileKey" };
      return {
        ok: true,
        message: {
          type,
          requestId,
          ...(typeof raw.docId === "string" && raw.docId ? { docId: raw.docId } : {}),
          ...(isFileKey(raw.fileKey) ? { fileKey: raw.fileKey } : {}),
        },
      };
    }
    case "SCAN_PAGE": {
      if (!isMode(raw.mode)) return { ok: false, error: "Invalid mode" };
      if (typeof raw.sessionId !== "string" || !raw.sessionId) return { ok: false, error: "Invalid sessionId" };
      if (!isScanSettings(raw.settings)) return { ok: false, error: "Invalid settings" };
      return { ok: true, message: { type, requestId, mode: raw.mode, sessionId: raw.sessionId, settings: raw.settings } };
    }
    case "SCAN_PROGRESS":
    case "POPUP_SCAN_PROGRESS": {
      if (typeof raw.sessionId !== "string" || !raw.sessionId) return { ok: false, error: "Invalid sessionId" };
      if (typeof raw.windowsCompleted !== "number" || !Number.isSafeInteger(raw.windowsCompleted) || raw.windowsCompleted < 0) return { ok: false, error: "Invalid windowsCompleted" };
      if (typeof raw.windowsTotal !== "number" || !Number.isSafeInteger(raw.windowsTotal) || raw.windowsTotal < 0) return { ok: false, error: "Invalid windowsTotal" };
      if (typeof raw.charsScanned !== "number" || !Number.isSafeInteger(raw.charsScanned) || raw.charsScanned < 0) return { ok: false, error: "Invalid charsScanned" };
      if (typeof raw.charsTotal !== "number" || !Number.isSafeInteger(raw.charsTotal) || raw.charsTotal < 0) return { ok: false, error: "Invalid charsTotal" };
      if (typeof raw.findingsSoFar !== "number" || !Number.isSafeInteger(raw.findingsSoFar) || raw.findingsSoFar < 0) return { ok: false, error: "Invalid findingsSoFar" };
      return {
        ok: true,
        message: {
          type,
          requestId,
          sessionId: raw.sessionId,
          windowsCompleted: raw.windowsCompleted,
          windowsTotal: raw.windowsTotal,
          charsScanned: raw.charsScanned,
          charsTotal: raw.charsTotal,
          findingsSoFar: raw.findingsSoFar,
        },
      };
    }
    case "SCAN_RESULT_CHUNK":
    case "POPUP_STATE_CHUNK": {
      if (typeof raw.sessionId !== "string" || !raw.sessionId) return { ok: false, error: "Invalid sessionId" };
      if (typeof raw.totalChunks !== "number" || !Number.isSafeInteger(raw.totalChunks) || raw.totalChunks < 1 || raw.totalChunks > 200) return { ok: false, error: "Invalid totalChunks" };
      if (typeof raw.chunkIndex !== "number" || !Number.isSafeInteger(raw.chunkIndex) || raw.chunkIndex < 0 || raw.chunkIndex >= raw.totalChunks) return { ok: false, error: "Invalid chunkIndex" };
      const chunkFindings = normalizeFindingArray(raw.findings);
      if (!chunkFindings) return { ok: false, error: "Invalid findings" };
      return {
        ok: true,
        message: {
          type,
          requestId,
          sessionId: raw.sessionId,
          chunkIndex: raw.chunkIndex,
          totalChunks: raw.totalChunks,
          findings: chunkFindings,
        },
      };
    }
    case "SCAN_RESULT": {
      if (typeof raw.sessionId !== "string" || !raw.sessionId) return { ok: false, error: "Invalid sessionId" };
      const findings = normalizeFindingArray(raw.findings);
      if (!findings) return { ok: false, error: "Invalid findings" };
      const stats = normalizeScanStats(raw.stats);
      if (!stats) return { ok: false, error: "Invalid stats" };
      if (raw.totalChunks !== undefined && (typeof raw.totalChunks !== "number" || !Number.isSafeInteger(raw.totalChunks) || raw.totalChunks < 1 || raw.totalChunks > 200)) return { ok: false, error: "Invalid totalChunks" };
      if (raw.chunkIndex !== undefined && (typeof raw.chunkIndex !== "number" || !Number.isSafeInteger(raw.chunkIndex) || raw.chunkIndex < 0 || (typeof raw.totalChunks === "number" && raw.chunkIndex >= raw.totalChunks))) return { ok: false, error: "Invalid chunkIndex" };
      return {
        ok: true,
        message: {
          type,
          requestId,
          sessionId: raw.sessionId,
          findings,
          stats,
          ...(typeof raw.chunkIndex === "number" ? { chunkIndex: raw.chunkIndex } : {}),
          ...(typeof raw.totalChunks === "number" ? { totalChunks: raw.totalChunks } : {}),
        },
      };
    }
    case "CONTENT_ERROR": {
      if (typeof raw.sessionId !== "string" || !raw.sessionId) return { ok: false, error: "Invalid sessionId" };
      if (typeof raw.code !== "string") return { ok: false, error: "Invalid error code" };
      if (typeof raw.userMessage !== "string") return { ok: false, error: "Invalid userMessage" };
      return { ok: true, message: { type, requestId, sessionId: raw.sessionId, code: raw.code, userMessage: raw.userMessage } };
    }
    case "CONTENT_GET_NAME_DICTIONARIES":
    case "CONTENT_GET_MEDICAL_DICTIONARY": {
      return { ok: true, message: { type, requestId } };
    }
    case "CONTENT_GET_MEDICAL_PACKS": {
      const cm = raw.clinicMode;
      if (cm !== undefined && (typeof cm !== "string" || !["general", "pediatrics", "obgyn", "geriatrics", "urology"].includes(cm))) {
        return { ok: false, error: "Invalid clinicMode" };
      }
      return { ok: true, message: { type, requestId, ...(cm ? { clinicMode: cm as import("./types.js").ClinicMode } : {}) } };
    }
    case "APPLY_MASKS":
    case "COPY_REDACTED_TEXT": {
      if (typeof raw.sessionId !== "string" || !raw.sessionId) return { ok: false, error: "Invalid sessionId" };
      if (!isStringArray(raw.findingIds)) return { ok: false, error: "Invalid findingIds" };
      return { ok: true, message: { type, requestId, sessionId: raw.sessionId, findingIds: raw.findingIds } };
    }
    case "REMOVE_MASKS": {
      if (typeof raw.sessionId !== "string" || !raw.sessionId) return { ok: false, error: "Invalid sessionId" };
      return { ok: true, message: { type, requestId, sessionId: raw.sessionId } };
    }
    case "COPY_REDACTED_TEXT_RESULT": {
      if (typeof raw.sessionId !== "string" || !raw.sessionId) return { ok: false, error: "Invalid sessionId" };
      if (typeof raw.text !== "string") return { ok: false, error: "Invalid text" };
      return { ok: true, message: { type, requestId, sessionId: raw.sessionId, text: raw.text } };
    }
    case "CONTEXT_REDACT_SELECTION":
    case "CONTEXT_MASK_SELECTION": {
      if (raw.selectionText !== undefined && typeof raw.selectionText !== "string") {
        return { ok: false, error: "Invalid selectionText" };
      }
      if (raw.settings !== undefined && !isScanSettings(raw.settings)) {
        return { ok: false, error: "Invalid settings" };
      }
      return {
        ok: true,
        message: {
          type,
          requestId,
          ...(raw.selectionText !== undefined ? { selectionText: raw.selectionText as string } : {}),
          ...(raw.settings !== undefined ? { settings: raw.settings } : {}),
        },
      };
    }
    case "POPUP_STATE": {
      const state = normalizePopupState(raw.state);
      if (!state) return { ok: false, error: "Invalid state" };
      if (raw.totalChunks !== undefined && (typeof raw.totalChunks !== "number" || !Number.isSafeInteger(raw.totalChunks) || raw.totalChunks < 1 || raw.totalChunks > 200)) return { ok: false, error: "Invalid totalChunks" };
      if (raw.chunkIndex !== undefined && (typeof raw.chunkIndex !== "number" || !Number.isSafeInteger(raw.chunkIndex) || raw.chunkIndex < 0 || (typeof raw.totalChunks === "number" && raw.chunkIndex >= raw.totalChunks))) return { ok: false, error: "Invalid chunkIndex" };
      return {
        ok: true,
        message: {
          type,
          requestId,
          state,
          ...(typeof raw.chunkIndex === "number" ? { chunkIndex: raw.chunkIndex } : {}),
          ...(typeof raw.totalChunks === "number" ? { totalChunks: raw.totalChunks } : {}),
        },
      };
    }
    case "POPUP_COPY_RESULT": {
      if (typeof raw.text !== "string") return { ok: false, error: "Invalid text" };
      return { ok: true, message: { type, requestId, text: raw.text } };
    }
    case "POPUP_UNDO_DONE": {
      if (typeof raw.canUndo !== "boolean") return { ok: false, error: "Invalid canUndo" };
      return { ok: true, message: { type, requestId, canUndo: raw.canUndo } };
    }
    case "POPUP_DOC_STATE": {
      if (typeof raw.docId !== "string" || !raw.docId) return { ok: false, error: "Invalid docId" };
      if (!isName(raw.name)) return { ok: false, error: "Invalid name" };
      if (!isFileKey(raw.fileKey)) return { ok: false, error: "Invalid fileKey" };
      if (typeof raw.mimeType !== "string" || !raw.mimeType) return { ok: false, error: "Invalid mimeType" };
      if (!isDocKind(raw.kind)) return { ok: false, error: "Invalid kind" };
      if (!Array.isArray(raw.pages) || !raw.pages.every(isDocPageMeta)) return { ok: false, error: "Invalid pages" };
      if (raw.error !== undefined && !isRecord(raw.error)) return { ok: false, error: "Invalid error" };
      if (raw.totalPages !== undefined && !isTotalPages(raw.totalPages)) return { ok: false, error: "Invalid totalPages" };
      if (raw.pageOffset !== undefined && !isPageOffset(raw.pageOffset)) return { ok: false, error: "Invalid pageOffset" };
      if (raw.truncated !== undefined && typeof raw.truncated !== "boolean") return { ok: false, error: "Invalid truncated" };
      return { ok: true, message: { type, requestId, docId: raw.docId, name: raw.name, fileKey: raw.fileKey, mimeType: raw.mimeType, kind: raw.kind, pages: raw.pages, ...(raw.totalPages !== undefined ? { totalPages: raw.totalPages } : {}), ...(raw.pageOffset !== undefined ? { pageOffset: raw.pageOffset } : {}), ...(raw.truncated !== undefined ? { truncated: raw.truncated } : {}) } };
    }
    case "POPUP_DOC_DONE": {
      if (!isName(raw.outputName)) return { ok: false, error: "Invalid outputName" };
      if (raw.outputBytesBase64 !== undefined && typeof raw.outputBytesBase64 !== "string") return { ok: false, error: "Invalid outputBytesBase64" };
      if (raw.outputMimeType !== undefined && typeof raw.outputMimeType !== "string") return { ok: false, error: "Invalid outputMimeType" };
      const printFileKey = raw.printFileKey;
      if (printFileKey !== undefined && !isFileKey(printFileKey)) return { ok: false, error: "Invalid printFileKey" };
      return { ok: true, message: { type, requestId, outputName: raw.outputName, ...(raw.outputBytesBase64 ? { outputBytesBase64: raw.outputBytesBase64 as string } : {}), ...(raw.outputMimeType ? { outputMimeType: raw.outputMimeType as string } : {}), ...(printFileKey ? { printFileKey } : {}) } };
    }
    case "POPUP_DOC_ERROR": {
      if (typeof raw.code !== "string" || !raw.code) return { ok: false, error: "Invalid error code" };
      if (typeof raw.userMessage !== "string" || !raw.userMessage) return { ok: false, error: "Invalid userMessage" };
      return { ok: true, message: { type, requestId, code: raw.code, userMessage: raw.userMessage } };
    }
    case "POPUP_DOC_COUNT_RESULT": {
      if (!isTotalPages(raw.totalPages)) return { ok: false, error: "Invalid totalPages" };
      return { ok: true, message: { type, requestId, totalPages: raw.totalPages } };
    }
    case "POPUP_DOC_CLEAR": {
      const hasDocId = raw.docId !== undefined;
      const hasFileKey = raw.fileKey !== undefined;
      if (hasDocId && (typeof raw.docId !== "string" || !raw.docId)) return { ok: false, error: "Invalid docId" };
      if (hasFileKey && !isFileKey(raw.fileKey)) return { ok: false, error: "Invalid fileKey" };
      if (!hasDocId && !hasFileKey) return { ok: false, error: "Missing docId or fileKey" };
      return {
        ok: true,
        message: {
          type,
          requestId,
          ...(typeof raw.docId === "string" && raw.docId ? { docId: raw.docId } : {}),
          ...(isFileKey(raw.fileKey) ? { fileKey: raw.fileKey } : {}),
        },
      };
    }
    case "POPUP_DOC_CAPTURE_IMAGE": {
      if (typeof raw.src !== "string" || !raw.src) return { ok: false, error: "Invalid src" };
      if (!isSafeImageSrc(raw.src)) return { ok: false, error: "Unsupported image source" };
      return { ok: true, message: { type, requestId, src: raw.src, name: isName(raw.name) ? raw.name : "page-image.png" } };
    }
    case "POPUP_EXPORT_AUDIT":
    case "POPUP_UNDO_MASKS": {
      if (raw.tabId !== undefined && (typeof raw.tabId !== "number" || !Number.isSafeInteger(raw.tabId) || raw.tabId <= 0)) return { ok: false, error: "Invalid tabId" };
      return { ok: true, message: { type, requestId, ...(typeof raw.tabId === "number" ? { tabId: raw.tabId } : {}) } };
    }
    case "POPUP_RECORD_AUDIT": {
      if (!isAuditEvent(raw.event)) return { ok: false, error: "Invalid audit event" };
      if (raw.failClosed !== undefined && typeof raw.failClosed !== "boolean") {
        return { ok: false, error: "Invalid failClosed flag" };
      }
      return {
        ok: true,
        message: {
          type,
          requestId,
          event: raw.event,
          ...(raw.failClosed !== undefined ? { failClosed: raw.failClosed } : {}),
        },
      };
    }
    case "POPUP_CUSTOM_PATTERNS_GET":
    case "POPUP_COMMUNITY_ACCOUNT_GET":
    case "POPUP_COMMUNITY_ACCOUNT_LINK_FREE":
    case "POPUP_COMMUNITY_ACCOUNT_UNLINK":
    case "POPUP_COMMUNITY_FETCH_COMMUNITY_RULES":
      return { ok: true, message: { type, requestId } };
    case "POPUP_WIZARD_ANALYZE": {
      if (!isStringArray(raw.positiveExamples)) return { ok: false, error: "Invalid positiveExamples" };
      if (!isStringArray(raw.negativeExamples)) return { ok: false, error: "Invalid negativeExamples" };
      return { ok: true, message: { type, requestId, positiveExamples: raw.positiveExamples, negativeExamples: raw.negativeExamples } };
    }
    case "POPUP_WIZARD_TEST": {
      if (typeof raw.regex !== "string") return { ok: false, error: "Invalid regex" };
      if (typeof raw.sampleText !== "string") return { ok: false, error: "Invalid sampleText" };
      return { ok: true, message: { type, requestId, regex: raw.regex, sampleText: raw.sampleText } };
    }
    case "POPUP_CUSTOM_PATTERN_SAVE": {
      const pattern = normalizeCustomPattern(raw.pattern);
      if (!pattern) return { ok: false, error: "Invalid pattern" };
      return { ok: true, message: { type, requestId, pattern } };
    }
    case "POPUP_CUSTOM_PATTERN_DELETE": {
      if (typeof raw.patternId !== "string") return { ok: false, error: "Invalid patternId" };
      return { ok: true, message: { type, requestId, patternId: raw.patternId } };
    }
    case "POPUP_COMMUNITY_CONTRIBUTE": {
      if (typeof raw.patternId !== "string") return { ok: false, error: "Invalid patternId" };
      return { ok: true, message: { type, requestId, patternId: raw.patternId } };
    }
    case "POPUP_WIZARD_ANALYSIS_RESULT": {
      if (!Array.isArray(raw.proposals)) return { ok: false, error: "Invalid proposals" };
      const proposals = raw.proposals.map(normalizeWizardAnalysis);
      if (proposals.some((proposal) => proposal === null)) return { ok: false, error: "Invalid proposals" };
      return { ok: true, message: { type, requestId, proposals: proposals as WizardAnalysis[] } };
    }
    case "POPUP_WIZARD_TEST_RESULT": {
      const testResult = normalizePatternTestResults(raw.testResult);
      if (!testResult) return { ok: false, error: "Invalid testResult" };
      return { ok: true, message: { type, requestId, testResult } };
    }
    case "POPUP_CUSTOM_PATTERNS_STATE": {
      const patterns = normalizeCustomPatterns(raw.patterns);
      if (!patterns) return { ok: false, error: "Invalid patterns" };
      return { ok: true, message: { type, requestId, patterns } };
    }
    case "POPUP_COMMUNITY_ACCOUNT_DETAILS_STATE": {
      return { ok: true, message: { type, requestId, account: (raw.account ?? null) as any } };
    }
    case "POPUP_COMMUNITY_CONTRIBUTE_RESULT": {
      if (typeof raw.success !== "boolean") return { ok: false, error: "Invalid success" };
      return { ok: true, message: { type, requestId, success: raw.success, ruleId: raw.ruleId as any, error: raw.error as any } };
    }
    case "POPUP_COMMUNITY_COMMUNITY_RULES_STATE": {
      if (!Array.isArray(raw.rules) && raw.error === undefined) return { ok: false, error: "Invalid rules" };
      return { ok: true, message: { type, requestId, rules: (raw.rules ?? []) as any, error: raw.error as any } };
    }
    case "POPUP_SET_NOTIFICATION_PREFS": {
      if (!isRecord(raw.prefs)) return { ok: false, error: "Invalid prefs" };
      return { ok: true, message: { type, requestId, prefs: raw.prefs as any } };
    }
    case "POPUP_NOTIFICATION_PREFS_STATE": {
      if (!isRecord(raw.prefs)) return { ok: false, error: "Invalid prefs" };
      return { ok: true, message: { type, requestId, prefs: raw.prefs as any, granted: typeof raw.granted === "boolean" ? raw.granted : undefined } };
    }
    case "POPUP_SET_NOTIFICATIONS": {
      if (typeof raw.enabled !== "boolean") return { ok: false, error: "Invalid enabled" };
      return { ok: true, message: { type, requestId, enabled: raw.enabled } };
    }
    case "POPUP_ACCOUNT_SAVE": {
      if (typeof raw.gatewayOrigin !== "string" || !isAllowedGatewayOrigin(raw.gatewayOrigin)) {
        return { ok: false, error: "Invalid gatewayOrigin" };
      }
      if (!isApiKey(raw.apiKey)) return { ok: false, error: "Invalid API key" };
      return { ok: true, message: { type, requestId, gatewayOrigin: raw.gatewayOrigin, apiKey: raw.apiKey } };
    }
    case "POPUP_ACCOUNT_CLEAR":
      return { ok: true, message: { type, requestId } };
    case "POPUP_ACCOUNT_PURCHASE": {
      if (typeof raw.planId !== "string" || !raw.planId || raw.planId.length > 128) return { ok: false, error: "Invalid planId" };
      return { ok: true, message: { type, requestId, planId: raw.planId } };
    }
    case "POPUP_NOTIFICATIONS_STATE": {
      if (typeof raw.granted !== "boolean") return { ok: false, error: "Invalid granted" };
      return { ok: true, message: { type, requestId, granted: raw.granted } };
    }
    case "POPUP_ACCOUNT_STATE": {
      if (raw.gatewayOrigin !== null && (typeof raw.gatewayOrigin !== "string" || !isAllowedGatewayOrigin(raw.gatewayOrigin))) {
        return { ok: false, error: "Invalid gatewayOrigin" };
      }
      if (typeof raw.linked !== "boolean") return { ok: false, error: "Invalid linked" };
      if (raw.credentialAvailable !== undefined && typeof raw.credentialAvailable !== "boolean") {
        return { ok: false, error: "Invalid credentialAvailable" };
      }
      if (raw.accountLabel !== undefined && typeof raw.accountLabel !== "string") return { ok: false, error: "Invalid accountLabel" };
      let account: AccountView | undefined;
      if (raw.account !== undefined) {
        const parsed = parseAccountView(raw.account);
        if (!parsed) return { ok: false, error: "Invalid account" };
        account = parsed;
      }
      let error: { code: string; userMessage: string } | undefined;
      if (raw.error !== undefined) {
        if (!isRecord(raw.error) || typeof raw.error.code !== "string" || typeof raw.error.userMessage !== "string") {
          return { ok: false, error: "Invalid error" };
        }
        error = { code: raw.error.code, userMessage: raw.error.userMessage };
      }
      return {
        ok: true,
        message: {
          type,
          requestId,
          gatewayOrigin: raw.gatewayOrigin ?? null,
          linked: raw.linked,
          ...(raw.credentialAvailable !== undefined ? { credentialAvailable: raw.credentialAvailable as boolean } : {}),
          ...(raw.accountLabel !== undefined ? { accountLabel: raw.accountLabel } : {}),
          ...(account ? { account } : {}),
          ...(error ? { error } : {}),
        },
      };
    }
    case "POPUP_ACCOUNT_PURCHASE_URL": {
      if (typeof raw.url !== "string" || !raw.url) return { ok: false, error: "Invalid url" };
      return { ok: true, message: { type, requestId, url: raw.url } };
    }
    case "POPUP_AUDIT_EXPORT": {
      if (typeof raw.jsonl !== "string") return { ok: false, error: "Invalid jsonl" };
      if (typeof raw.signatureBase64 !== "string" || !raw.signatureBase64) return { ok: false, error: "Invalid signature" };
      if (!isRecord(raw.publicKeyJwk)) return { ok: false, error: "Invalid publicKeyJwk" };
      if (typeof raw.exportedAt !== "string" || !raw.exportedAt) return { ok: false, error: "Invalid exportedAt" };
      if (typeof raw.eventCount !== "number" || !Number.isInteger(raw.eventCount) || raw.eventCount < 0) {
        return { ok: false, error: "Invalid eventCount" };
      }
      return {
        ok: true,
        message: {
          type,
          requestId,
          jsonl: raw.jsonl,
          signatureBase64: raw.signatureBase64,
          publicKeyJwk: raw.publicKeyJwk,
          exportedAt: raw.exportedAt,
          eventCount: raw.eventCount,
        },
      };
    }
    case "POPUP_API_CONNECT": {
      if (raw.apiUrl !== undefined && typeof raw.apiUrl !== "string") return { ok: false, error: "Invalid apiUrl" };
      if (raw.token !== undefined && typeof raw.token !== "string") return { ok: false, error: "Invalid token" };
      return {
        ok: true,
        message: {
          type,
          requestId,
          apiUrl: raw.apiUrl as string | undefined,
          token: raw.token as string | undefined,
        },
      };
    }
    case "POPUP_API_DISCONNECT":
    case "POPUP_API_GET_STATUS":
    case "POPUP_API_SYNC_POLICY": {
      return { ok: true, message: { type, requestId } };
    }
    case "POPUP_API_SUBMIT_LOGIC": {
      if (typeof raw.patternId !== "string" || !raw.patternId) return { ok: false, error: "Invalid patternId" };
      return { ok: true, message: { type, requestId, patternId: raw.patternId } };
    }
    case "POPUP_OAUTH_CONNECT": {
      return { ok: true, message: { type, requestId } };
    }
    case "POPUP_OAUTH_CALLBACK": {
      if (typeof raw.code !== "string" || !raw.code) return { ok: false, error: "Invalid code" };
      if (typeof raw.state !== "string" || !raw.state) return { ok: false, error: "Invalid state" };
      return { ok: true, message: { type, requestId, code: raw.code, state: raw.state } };
    }
    case "POPUP_OAUTH_STATUS": {
      if (typeof raw.connected !== "boolean") return { ok: false, error: "Invalid connected" };
      return {
        ok: true,
        message: {
          type,
          requestId,
          connected: raw.connected,
          message: typeof raw.message === "string" ? raw.message : undefined,
          tenantId: typeof raw.tenantId === "string" ? raw.tenantId : undefined,
          tenantName: typeof raw.tenantName === "string" ? raw.tenantName : undefined,
          apiUrl: typeof raw.apiUrl === "string" ? raw.apiUrl : undefined,
          capabilities: Array.isArray(raw.capabilities) ? raw.capabilities : undefined,
        },
      };
    }
    case "POPUP_API_STATUS_STATE": {
      if (typeof raw.connectionState !== "string") return { ok: false, error: "Invalid connectionState" };
      if (typeof raw.apiUrl !== "string") return { ok: false, error: "Invalid apiUrl" };
      if (!Array.isArray(raw.capabilities) || !raw.capabilities.every((c) => typeof c === "string")) {
        return { ok: false, error: "Invalid capabilities" };
      }
      return {
        ok: true,
        message: {
          type,
          requestId,
          connectionState: raw.connectionState,
          tenantId: typeof raw.tenantId === "string" ? raw.tenantId : undefined,
          tenantName: typeof raw.tenantName === "string" ? raw.tenantName : undefined,
          apiUrl: raw.apiUrl,
          capabilities: raw.capabilities as string[],
          error: typeof raw.error === "string" ? raw.error : undefined,
        },
      };
    }
    case "POPUP_API_POLICY_STATE": {
      if (typeof raw.success !== "boolean") return { ok: false, error: "Invalid success" };
      return {
        ok: true,
        message: {
          type,
          requestId,
          success: raw.success,
          policyId: typeof raw.policyId === "string" ? raw.policyId : undefined,
          policyVersion: typeof raw.policyVersion === "string" ? raw.policyVersion : undefined,
          rulesCount: typeof raw.rulesCount === "number" ? raw.rulesCount : undefined,
          error: typeof raw.error === "string" ? raw.error : undefined,
        },
      };
    }
    case "POPUP_API_SUBMIT_RESULT": {
      if (typeof raw.success !== "boolean") return { ok: false, error: "Invalid success" };
      return {
        ok: true,
        message: {
          type,
          requestId,
          success: raw.success,
          submissionId: typeof raw.submissionId === "string" ? raw.submissionId : undefined,
          error: typeof raw.error === "string" ? raw.error : undefined,
        },
      };
    }
    case "POPUP_DOC_CAPTURE_READY": {
      if (!isFileKey(raw.fileKey)) return { ok: false, error: "Invalid fileKey" };
      if (!isName(raw.name)) return { ok: false, error: "Invalid name" };
      if (raw.kind !== "image") return { ok: false, error: "Invalid kind" };
      if (raw.source !== "original" && raw.source !== "capture") return { ok: false, error: "Invalid source" };
      return {
        ok: true,
        message: {
          type,
          requestId,
          fileKey: raw.fileKey,
          name: raw.name,
          mimeType: typeof raw.mimeType === "string" ? raw.mimeType : "image/png",
          kind: "image",
          source: raw.source,
          degraded: raw.degraded === true,
        },
      };
    }
    case "POPUP_DOC_STATUS": {
      const stage = raw.stage as DocRedactionStage;
      if (stage !== "detected" && stage !== "redacted" && stage !== "verified") return { ok: false, error: "Invalid stage" };
      const method = raw.method as RedactionVerifyMethod | undefined;
      if (method !== undefined && method !== "pixel" && method !== "page-pixels") return { ok: false, error: "Invalid method" };
      return {
        ok: true,
        message: {
          type,
          requestId,
          stage,
          paintedRegions: typeof raw.paintedRegions === "number" ? raw.paintedRegions : undefined,
          verifiedRegions: typeof raw.verifiedRegions === "number" ? raw.verifiedRegions : undefined,
          checkedRegions: typeof raw.checkedRegions === "number" ? raw.checkedRegions : undefined,
          method,
          problem: typeof raw.problem === "string" ? raw.problem : undefined,
        },
      };
    }
    case "CONTENT_SHOW_TOAST": {
      if (typeof raw.title !== "string" || !raw.title || raw.title.length > 200) {
        return { ok: false, error: "Invalid title" };
      }
      if (typeof raw.message !== "string" || !raw.message || raw.message.length > 500) {
        return { ok: false, error: "Invalid message" };
      }
      const level = raw.level;
      if (level !== undefined && level !== "info" && level !== "success" && level !== "warning" && level !== "danger") {
        return { ok: false, error: "Invalid level" };
      }
      const durationMs = raw.durationMs;
      if (durationMs !== undefined && (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 500 || durationMs > 30000)) {
        return { ok: false, error: "Invalid durationMs" };
      }
      const actionLabel = raw.actionLabel;
      if (actionLabel !== undefined && (typeof actionLabel !== "string" || actionLabel.length === 0 || actionLabel.length > 50)) {
        return { ok: false, error: "Invalid actionLabel" };
      }
      return {
        ok: true,
        message: {
          type,
          requestId,
          title: raw.title,
          message: raw.message,
          ...(level ? { level } : {}),
          ...(durationMs ? { durationMs } : {}),
          ...(actionLabel ? { actionLabel } : {}),
        },
      };
    }
    case "SCAN_PAGE_VISUAL_RESULT": {
      if (typeof raw.sessionId !== "string" || !raw.sessionId) return { ok: false, error: "Invalid sessionId" };
      if (typeof raw.sourceId !== "string" || !raw.sourceId) return { ok: false, error: "Invalid sourceId" };
      const visualFindings = normalizeFindingArray(raw.findings);
      if (!visualFindings) return { ok: false, error: "Invalid findings" };
      return { ok: true, message: { type, requestId, sessionId: raw.sessionId as string, sourceId: raw.sourceId as string, findings: visualFindings } };
    }
    case "POPUP_SCAN_COVERAGE": {
      const COVERAGE_STATUSES = new Set(["FULLY_SCANNED","PARTIALLY_SCANNED","UNSUPPORTED_CONTENT_PRESENT","BLOCKED_BY_BROWSER_SECURITY","NO_SENSITIVE_DATA_DETECTED","SCAN_FAILED"]);
      if (typeof raw.coverageStatus !== "string" || !COVERAGE_STATUSES.has(raw.coverageStatus)) return { ok: false, error: "Invalid coverageStatus" };
      if (typeof raw.deferredMediaCount !== "number" || !Number.isSafeInteger(raw.deferredMediaCount) || raw.deferredMediaCount < 0) return { ok: false, error: "Invalid deferredMediaCount" };
      return { ok: true, message: { type, requestId, coverageStatus: raw.coverageStatus as string, deferredMediaCount: raw.deferredMediaCount as number } };
    }
    case "POPUP_GET_STAGED_STATS":
      return { ok: true, message: { type, requestId } };
    case "POPUP_PURGE_STAGED_DATA": {
      if (raw.includeIdleSession !== undefined && typeof raw.includeIdleSession !== "boolean") {
        return { ok: false, error: "Invalid includeIdleSession" };
      }
      return {
        ok: true,
        message: {
          type,
          requestId,
          ...(typeof raw.includeIdleSession === "boolean" ? { includeIdleSession: raw.includeIdleSession } : {}),
        },
      };
    }
    case "POPUP_STAGED_STATS_STATE": {
      const isStats = (s: unknown): s is import("./types.js").StagedStorageAudit =>
        isRecord(s) &&
        typeof s.totalKeys === "number" &&
        Number.isSafeInteger(s.totalKeys) &&
        s.totalKeys >= 0 &&
        typeof s.totalBytes === "number" &&
        Number.isFinite(s.totalBytes) &&
        s.totalBytes >= 0 &&
        typeof s.liveKeys === "number" &&
        Number.isSafeInteger(s.liveKeys) &&
        s.liveKeys >= 0 &&
        typeof s.liveBytes === "number" &&
        Number.isFinite(s.liveBytes) &&
        s.liveBytes >= 0 &&
        typeof s.orphanKeys === "number" &&
        Number.isSafeInteger(s.orphanKeys) &&
        s.orphanKeys >= 0 &&
        typeof s.orphanBytes === "number" &&
        Number.isFinite(s.orphanBytes) &&
        s.orphanBytes >= 0 &&
        typeof s.hasInFlightJob === "boolean";
      if (!isStats(raw.stats)) return { ok: false, error: "Invalid stats" };
      let purged: import("./types.js").PurgeStagedDataResult | undefined;
      if (raw.purged !== undefined) {
        if (
          !isRecord(raw.purged) ||
          typeof raw.purged.deletedKeys !== "number" ||
          !Number.isSafeInteger(raw.purged.deletedKeys) ||
          raw.purged.deletedKeys < 0 ||
          typeof raw.purged.deletedBytes !== "number" ||
          !Number.isFinite(raw.purged.deletedBytes) ||
          raw.purged.deletedBytes < 0 ||
          typeof raw.purged.preservedLiveSession !== "boolean" ||
          !isStats(raw.purged.remaining)
        ) {
          return { ok: false, error: "Invalid purged result" };
        }
        purged = {
          deletedKeys: raw.purged.deletedKeys,
          deletedBytes: raw.purged.deletedBytes,
          preservedLiveSession: raw.purged.preservedLiveSession,
          remaining: raw.purged.remaining,
        };
      }
      return {
        ok: true,
        message: {
          type,
          requestId,
          stats: raw.stats,
          ...(purged ? { purged } : {}),
        },
      };
    }
    case "POPUP_MANAGEMENT_GET_STATUS":
    case "POPUP_MANAGEMENT_UNENROLL": {
      return { ok: true, message: { type, requestId } };
    }
    case "POPUP_SYNC_MANAGED_POLICY": {
      if (raw.force !== undefined && typeof raw.force !== "boolean") {
        return { ok: false, error: "Invalid force flag" };
      }
      return {
        ok: true,
        message: {
          type,
          requestId,
          ...(typeof raw.force === "boolean" ? { force: raw.force } : {}),
        },
      };
    }
    case "POPUP_MANAGEMENT_ENROLL": {
      const isBounded = (v: unknown, max: number): v is string =>
        typeof v === "string" && v.trim().length > 0 && v.length <= max;
      if (!isBounded(raw.organizationId, 128)) return { ok: false, error: "Invalid organizationId" };
      if (!isBounded(raw.employeeId, 128)) return { ok: false, error: "Invalid employeeId" };
      if (raw.organizationName !== undefined && !isBounded(raw.organizationName, 200)) {
        return { ok: false, error: "Invalid organizationName" };
      }
      if (raw.employeeEmail !== undefined && !isBounded(raw.employeeEmail, 254)) {
        return { ok: false, error: "Invalid employeeEmail" };
      }
      if (raw.coordinatorUrl !== undefined) {
        if (typeof raw.coordinatorUrl !== "string" || raw.coordinatorUrl.length === 0 || raw.coordinatorUrl.length > 512) {
          return { ok: false, error: "Invalid coordinatorUrl" };
        }
        let parsed: URL;
        try {
          parsed = new URL(raw.coordinatorUrl);
        } catch {
          return { ok: false, error: "Invalid coordinatorUrl" };
        }
        if (parsed.username !== "" || parsed.password !== "" || !parsed.hostname) {
          return { ok: false, error: "Invalid coordinatorUrl" };
        }
        const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
        const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
        if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
          return { ok: false, error: "Invalid coordinatorUrl" };
        }
      }
      return {
        ok: true,
        message: {
          type,
          requestId,
          organizationId: raw.organizationId.trim(),
          employeeId: raw.employeeId.trim(),
          ...(typeof raw.organizationName === "string" ? { organizationName: raw.organizationName.trim() } : {}),
          ...(typeof raw.employeeEmail === "string" ? { employeeEmail: raw.employeeEmail.trim() } : {}),
          ...(typeof raw.coordinatorUrl === "string" ? { coordinatorUrl: raw.coordinatorUrl } : {}),
        },
      };
    }
    case "POPUP_MANAGEMENT_STATUS_STATE": {
      if (raw.mode !== "LOCAL" && raw.mode !== "MANAGE") return { ok: false, error: "Invalid mode" };
      if (typeof raw.enrolled !== "boolean") return { ok: false, error: "Invalid enrolled flag" };
      const checkOptStr = (v: unknown, max: number): boolean =>
        v === undefined || (typeof v === "string" && v.length <= max);
      if (!checkOptStr(raw.organizationId, 128)) return { ok: false, error: "Invalid organizationId" };
      if (!checkOptStr(raw.organizationName, 200)) return { ok: false, error: "Invalid organizationName" };
      if (!checkOptStr(raw.employeeId, 128)) return { ok: false, error: "Invalid employeeId" };
      if (!checkOptStr(raw.employeeEmail, 254)) return { ok: false, error: "Invalid employeeEmail" };
      if (!checkOptStr(raw.deviceId, 128)) return { ok: false, error: "Invalid deviceId" };
      if (!checkOptStr(raw.appliedPolicyId, 128)) return { ok: false, error: "Invalid appliedPolicyId" };
      if (!checkOptStr(raw.lastSyncStatus, 128)) return { ok: false, error: "Invalid lastSyncStatus" };
      if (!checkOptStr(raw.error, 500)) return { ok: false, error: "Invalid error" };
      if (
        raw.appliedPolicyVersion !== undefined &&
        (typeof raw.appliedPolicyVersion !== "number" ||
          !Number.isSafeInteger(raw.appliedPolicyVersion) ||
          raw.appliedPolicyVersion < 0)
      ) {
        return { ok: false, error: "Invalid appliedPolicyVersion" };
      }
      return {
        ok: true,
        message: {
          type,
          requestId,
          mode: raw.mode,
          enrolled: raw.enrolled,
          ...(typeof raw.organizationId === "string" ? { organizationId: raw.organizationId } : {}),
          ...(typeof raw.organizationName === "string" ? { organizationName: raw.organizationName } : {}),
          ...(typeof raw.employeeId === "string" ? { employeeId: raw.employeeId } : {}),
          ...(typeof raw.employeeEmail === "string" ? { employeeEmail: raw.employeeEmail } : {}),
          ...(typeof raw.deviceId === "string" ? { deviceId: raw.deviceId } : {}),
          ...(typeof raw.appliedPolicyId === "string" ? { appliedPolicyId: raw.appliedPolicyId } : {}),
          ...(typeof raw.appliedPolicyVersion === "number" ? { appliedPolicyVersion: raw.appliedPolicyVersion } : {}),
          ...(typeof raw.lastSyncStatus === "string" ? { lastSyncStatus: raw.lastSyncStatus } : {}),
          ...(typeof raw.error === "string" ? { error: raw.error } : {}),
        },
      };
    }
    case "SUPABASE_PAIR_REDEEM": {
      if (typeof raw.code !== "string" || !/^\d{8}$/.test(raw.code)) {
        return { ok: false, error: "Invalid pairing code format" };
      }
      return { ok: true, message: { type, requestId, code: raw.code } };
    }
    case "SUPABASE_PAIR_STATUS":
    case "SUPABASE_PAIR_UNPAIR": {
      return { ok: true, message: { type, requestId } };
    }
    case "SUPABASE_POLICY_SYNC": {
      if (raw.force !== undefined && typeof raw.force !== "boolean") {
        return { ok: false, error: "Invalid force flag" };
      }
      return {
        ok: true,
        message: {
          type,
          requestId,
          ...(typeof raw.force === "boolean" ? { force: raw.force } : {}),
        },
      };
    }
    case "SUPABASE_PAIR_STATUS_STATE": {
      const isPairingState = (v: unknown): v is SupabasePairingState =>
        v === "local_only" || v === "redeeming" || v === "paired" || v === "paired_offline";
      const isBackend = (v: unknown): v is OwningBackend => v === "supabase" || v === "azure";
      const checkOptStr = (v: unknown, max: number): boolean =>
        v === undefined || (typeof v === "string" && v.length <= max);

      if (!isPairingState(raw.pairingState)) return { ok: false, error: "Invalid pairingState" };
      if (raw.owningBackend !== undefined && raw.owningBackend !== null && !isBackend(raw.owningBackend)) {
        return { ok: false, error: "Invalid owningBackend" };
      }
      if (!checkOptStr(raw.organisationId, 128)) return { ok: false, error: "Invalid organisationId" };
      if (!checkOptStr(raw.organisationName, 200)) return { ok: false, error: "Invalid organisationName" };
      if (!checkOptStr(raw.seatId, 128)) return { ok: false, error: "Invalid seatId" };
      if (raw.unlocked !== undefined && typeof raw.unlocked !== "boolean") return { ok: false, error: "Invalid unlocked" };
      if (!checkOptStr(raw.policyId, 128)) return { ok: false, error: "Invalid policyId" };
      if (
        raw.policyVersion !== undefined &&
        (typeof raw.policyVersion !== "number" || !Number.isSafeInteger(raw.policyVersion) || raw.policyVersion < 0)
      ) {
        return { ok: false, error: "Invalid policyVersion" };
      }
      if (raw.policyEnforced !== undefined && typeof raw.policyEnforced !== "boolean") {
        return { ok: false, error: "Invalid policyEnforced" };
      }
      if (raw.hasDrift !== undefined && typeof raw.hasDrift !== "boolean") return { ok: false, error: "Invalid hasDrift" };
      if (raw.driftedKeys !== undefined) {
        if (
          !Array.isArray(raw.driftedKeys) ||
          raw.driftedKeys.length > 32 ||
          !raw.driftedKeys.every((k) => typeof k === "string" && k.length > 0 && k.length <= 64)
        ) {
          return { ok: false, error: "Invalid driftedKeys" };
        }
      }
      let conflict:
        | { detected: boolean; existingBackend: OwningBackend; incomingBackend: OwningBackend; message: string }
        | undefined;
      if (raw.conflict !== undefined) {
        if (
          !isRecord(raw.conflict) ||
          typeof raw.conflict.detected !== "boolean" ||
          !isBackend(raw.conflict.existingBackend) ||
          !isBackend(raw.conflict.incomingBackend) ||
          typeof raw.conflict.message !== "string" ||
          raw.conflict.message.length > 500
        ) {
          return { ok: false, error: "Invalid conflict object" };
        }
        conflict = {
          detected: raw.conflict.detected,
          existingBackend: raw.conflict.existingBackend,
          incomingBackend: raw.conflict.incomingBackend,
          message: raw.conflict.message,
        };
      }
      if (raw.revoked !== undefined && typeof raw.revoked !== "boolean") return { ok: false, error: "Invalid revoked" };
      if (!checkOptStr(raw.revokedNotice, 500)) return { ok: false, error: "Invalid revokedNotice" };
      if (!checkOptStr(raw.lastSyncAt, 64)) return { ok: false, error: "Invalid lastSyncAt" };
      if (!checkOptStr(raw.lastHeartbeatAt, 64)) return { ok: false, error: "Invalid lastHeartbeatAt" };
      if (!checkOptStr(raw.error, 500)) return { ok: false, error: "Invalid error" };

      return {
        ok: true,
        message: {
          type,
          requestId,
          pairingState: raw.pairingState,
          ...(raw.owningBackend !== undefined ? { owningBackend: raw.owningBackend } : {}),
          ...(typeof raw.organisationId === "string" ? { organisationId: raw.organisationId } : {}),
          ...(typeof raw.organisationName === "string" ? { organisationName: raw.organisationName } : {}),
          ...(typeof raw.seatId === "string" ? { seatId: raw.seatId } : {}),
          ...(typeof raw.unlocked === "boolean" ? { unlocked: raw.unlocked } : {}),
          ...(typeof raw.policyId === "string" ? { policyId: raw.policyId } : {}),
          ...(typeof raw.policyVersion === "number" ? { policyVersion: raw.policyVersion } : {}),
          ...(typeof raw.policyEnforced === "boolean" ? { policyEnforced: raw.policyEnforced } : {}),
          ...(typeof raw.hasDrift === "boolean" ? { hasDrift: raw.hasDrift } : {}),
          ...(Array.isArray(raw.driftedKeys) ? { driftedKeys: [...(raw.driftedKeys as string[])] } : {}),
          ...(conflict ? { conflict } : {}),
          ...(typeof raw.revoked === "boolean" ? { revoked: raw.revoked } : {}),
          ...(typeof raw.revokedNotice === "string" ? { revokedNotice: raw.revokedNotice } : {}),
          ...(typeof raw.lastSyncAt === "string" ? { lastSyncAt: raw.lastSyncAt } : {}),
          ...(typeof raw.lastHeartbeatAt === "string" ? { lastHeartbeatAt: raw.lastHeartbeatAt } : {}),
          ...(typeof raw.error === "string" ? { error: raw.error } : {}),
        },
      };
    }
    case "SUPABASE_PAIR_REDEEM_RESULT": {
      const isPairingState = (v: unknown): v is SupabasePairingState =>
        v === "local_only" || v === "redeeming" || v === "paired" || v === "paired_offline";
      const checkOptStr = (v: unknown, max: number): boolean =>
        v === undefined || (typeof v === "string" && v.length <= max);

      if (typeof raw.ok !== "boolean") return { ok: false, error: "Invalid ok flag" };
      if (!isPairingState(raw.pairingState)) return { ok: false, error: "Invalid pairingState" };
      if (!checkOptStr(raw.organisationId, 128)) return { ok: false, error: "Invalid organisationId" };
      if (!checkOptStr(raw.organisationName, 200)) return { ok: false, error: "Invalid organisationName" };
      if (!checkOptStr(raw.seatId, 128)) return { ok: false, error: "Invalid seatId" };
      if (raw.unlocked !== undefined && typeof raw.unlocked !== "boolean") return { ok: false, error: "Invalid unlocked" };
      if (
        raw.policyVersion !== undefined &&
        (typeof raw.policyVersion !== "number" || !Number.isSafeInteger(raw.policyVersion) || raw.policyVersion < 0)
      ) {
        return { ok: false, error: "Invalid policyVersion" };
      }
      if (!checkOptStr(raw.error, 500)) return { ok: false, error: "Invalid error" };

      return {
        ok: true,
        message: {
          type,
          requestId,
          ok: raw.ok,
          pairingState: raw.pairingState,
          ...(typeof raw.organisationId === "string" ? { organisationId: raw.organisationId } : {}),
          ...(typeof raw.organisationName === "string" ? { organisationName: raw.organisationName } : {}),
          ...(typeof raw.seatId === "string" ? { seatId: raw.seatId } : {}),
          ...(typeof raw.unlocked === "boolean" ? { unlocked: raw.unlocked } : {}),
          ...(typeof raw.policyVersion === "number" ? { policyVersion: raw.policyVersion } : {}),
          ...(typeof raw.error === "string" ? { error: raw.error } : {}),
        },
      };
    }
    default:
      return { ok: false, error: "Unhandled message type" };
  }
}
