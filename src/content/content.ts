// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { extractVisibleText, buildScanText, mapRange, buildRedactedText, maskCombinedRange, selectionCombinedSpan } from "./extract.js";
import type { RangeLike } from "./extract.js";
import { isExcludedElement } from "./extract.js";
import { applySelectionExcludingAttrs, attributeAt, buildAttrScan, collectAttrRecords } from "./attrs.js";
import type { AttrScan } from "./attrs.js";
import { detect, detectWithCoverage, maskValue, maskContext, placeholderLabelFor, type RawMatch } from "./detect.js";
import { parseName, type ParsedName } from "./detectors/nameParser.js";
import { ensureNameDictionariesLoaded, isNameDictionariesLoaded } from "./detectors/nameDictionaries.js";
import {
  ensureMedicalDictionaryLoaded,
  isMedicalDictionaryLoaded,
  detectMedicalDictionaryTerms,
} from "./detectors/medicalDictionary.js";
import { createOverlay } from "./overlay.js";
import type { OverlayController } from "./overlay.js";
import { initPasteGuard } from "./pasteGuard.js";
import { showToast } from "./toast.js";
import { validateMessage, DEFAULT_FINDINGS_CHUNK_BYTES, chunkFindingsByByteBudget } from "../shared/messages.js";
import type { Finding, FindingCategory, IncompleteWindowInfo, Rect, WorkerMessage } from "../shared/types.js";
import { ALL_CATEGORIES } from "../shared/settings.js";
import type { CustomPattern } from "../shared/customPatterns.js";
import { buildCanonicalDocumentWindows } from "./normalization/canonical.js";
import {
  observeMutations,
  getAffectedNodeIds,
  SMALL_BATCH_NODE_THRESHOLD,
  type MutationObserverHandle,
  type MutationBatch,
} from "./normalization/mutation.js";

const SMALL_BATCH_RESCAN_DELAY_MS = 20;
const BURST_RESCAN_DELAY_MS = 500;
import { setDynamicContentMonitored, updateCoverageWithBoundaries } from "./normalization/coverage.js";
import { traverseIframes } from "./normalization/iframe.js";
import { extractTableStructures, annotateSegmentsWithTableStructure } from "./normalization/table.js";
import { runDOMInventoryPass, resolveScanCoverageStatus } from "./normalization/pageInventory.js";
import { buildMediaQueue, extractVideoCaptions } from "./mediaQueue.js";
import { extractSvgText } from "./svgExtract.js";

function enrichAndBoostNames(matches: RawMatch[]): RawMatch[] {
  return matches.map((m) => {
    if (m.category !== "possible_name") return m;
    const parsed = parseName(m.value);
    const structured = isNameStructured(parsed);
    return {
      ...m,
      confidence: structured ? Math.max(m.confidence, 0.85) : m.confidence,
      parsedName: parsed,
    };
  });
}

function isNameStructured(p: ParsedName | undefined): boolean {
  return !!p && ((!!p.first && !!p.last) || !!p.prefix || p.credentials.length > 0);
}

/**
 * Content script (isolated world). Runs only after a deliberate user action
 * triggers injection via activeTab. Owns in-page state for the current scan
 * session and communicates with the service worker through validated messages.
 * The page's own DOM is only read; masks are drawn in a shadow-root overlay.
 */

const g = globalThis as unknown as Record<string, unknown>;
if (g.__gwRedactionContentLoaded !== true) {
  g.__gwRedactionContentLoaded = true;
  initPasteGuard();

  const DEFAULT_SESSION_TIMEOUT_MS = 15 * 60 * 1000;
  let activeSessionTimeoutMs = DEFAULT_SESSION_TIMEOUT_MS;

  let sessionId: string | null = null;
  let nodeIds = new Map<string, Node>();
  let segments: import("./normalization/types.js").CanonicalSegment[] = [];
  let segmentStarts: number[] = [];
  let segmentIndexById = new Map<string, number>();
  let combined = "";
  let attrScan: AttrScan | null = null;
  let findings: Finding[] = [];
  let overlay: OverlayController | null = null;
  let sessionTimer: ReturnType<typeof setTimeout> | null = null;
  let placeholdersEnabled = false;
  let currentSettings: ScanSettings | null = null;
  let currentCustomPatterns: CustomPattern[] = [];
  /** Manual selection ranges from CONTEXT_MASK_SELECTION (selection, not scan findings). */
  let manualSelectionRanges: Array<{ range: Range; rects: DOMRectList; label: string; placeholder?: string }> = [];
  let mutationObserver: MutationObserverHandle | null = null;
  let pendingMutationBatch: MutationBatch | null = null;
  let mutationDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let nextRescanSegId = 0;
  let nextRescanFindingSeq = 0;
  let lastAttrChars = 0;
  let lastTruncated = false;
  let lastCoverageStatus: import("../shared/types.js").ScanCoverageStatus | undefined;
  let lastDeferredMediaCount = 0;
  let lastWindowsScanned: number | undefined;
  let lastWindowsTotal: number | undefined;
  let lastIncompleteWindows: IncompleteWindowInfo[] | undefined;
  let lastCoverageWarnings: import("../shared/types.js").CoverageWarning[] | undefined;

  function clearSession() {
    sessionId = null;
    nodeIds.clear();
    segments = [];
    segmentStarts = [];
    segmentIndexById.clear();
    combined = "";
    attrScan = null;
    findings = [];
    placeholdersEnabled = false;
    manualSelectionRanges = [];
    pendingMutationBatch = null;
    nextRescanSegId = 0;
    nextRescanFindingSeq = 0;
    lastAttrChars = 0;
    lastTruncated = false;
    lastCoverageStatus = undefined;
    lastDeferredMediaCount = 0;
    lastWindowsScanned = undefined;
    lastWindowsTotal = undefined;
    lastIncompleteWindows = undefined;
    lastCoverageWarnings = undefined;
    if (mutationDebounceTimer !== null) {
      clearTimeout(mutationDebounceTimer);
      mutationDebounceTimer = null;
    }
    overlay?.clear();
    overlay?.destroy();
    overlay = null;
    if (sessionTimer) {
      clearTimeout(sessionTimer);
      sessionTimer = null;
    }
  }

  function touchSession() {
    if (sessionTimer) clearTimeout(sessionTimer);
    if (activeSessionTimeoutMs <= 0) return;
    sessionTimer = setTimeout(() => {
      if (sessionId) clearSession();
    }, activeSessionTimeoutMs);
  }

  function contextFor(start: number, end: number): string | undefined {
    const pad = 120;
    const from = Math.max(0, start - pad);
    const to = Math.min(combined.length, end + pad);
    const slice = combined.slice(from, to);
    return maskContext(slice);
  }

  function computeFormInputTokenRect(
    el: HTMLInputElement | HTMLTextAreaElement,
    r: DOMRect,
    val: string,
    startOffset: number,
    endOffset: number
  ): Rect | null {
    try {
      if (typeof window === "undefined" || typeof window.getComputedStyle !== "function") return null;
      const style = window.getComputedStyle(el);
      const paddingLeft = parseFloat(style.paddingLeft) || 0;
      const paddingTop = parseFloat(style.paddingTop) || 0;
      const borderLeft = parseFloat(style.borderLeftWidth) || 0;
      const borderTop = parseFloat(style.borderTopWidth) || 0;
      const fontSize = parseFloat(style.fontSize) || 14;
      const font = style.font || `${style.fontSize || "14px"} ${style.fontFamily || "sans-serif"}`;
      const lineHeight = parseFloat(style.lineHeight) || fontSize * 1.2;

      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.font = font;

      const tag = el.tagName.toLowerCase();
      if (tag === "textarea") {
        const beforeText = val.slice(0, startOffset);
        const beforeLines = beforeText.split("\n");
        const lineIdx = beforeLines.length - 1;
        // eslint-disable-next-line security/detect-object-injection
        const lineBefore = beforeLines[lineIdx];
        const tokenText = val.slice(startOffset, endOffset).split("\n")[0];

        const beforeWidth = ctx.measureText(lineBefore).width;
        const tokenWidth = ctx.measureText(tokenText).width;

        const x = r.x + borderLeft + paddingLeft + beforeWidth - el.scrollLeft;
        const y = r.y + borderTop + paddingTop + lineIdx * lineHeight - el.scrollTop;
        const width = Math.min(tokenWidth, Math.max(0, r.x + r.width - x));
        const height = Math.min(lineHeight, Math.max(0, r.y + r.height - y));
        if (width > 0 && height > 0) {
          return { x, y, width, height };
        }
      } else {
        const beforeText = val.slice(0, startOffset);
        const tokenText = val.slice(startOffset, endOffset);

        const beforeWidth = ctx.measureText(beforeText).width;
        const tokenWidth = ctx.measureText(tokenText).width;

        const x = r.x + borderLeft + paddingLeft + beforeWidth - el.scrollLeft;
        const y = r.y + borderTop + paddingTop;
        const width = Math.min(tokenWidth, Math.max(0, r.x + r.width - x));
        const height = Math.min(lineHeight, Math.max(0, r.height - borderTop * 2 - paddingTop * 2));
        if (width > 0 && height > 0) {
          return { x, y, width, height };
        }
      }
    } catch {
      // Fallback to full element rect
    }
    return null;
  }

  function findingRectsFromRanges(ranges: ReturnType<typeof mapRange>): Rect[] {
    const rects: Rect[] = [];
    for (const range of ranges) {
      const node = nodeIds.get(range.nodeId);
      if (!node || !node.isConnected) continue;
      try {
        if (node.nodeType === Node.TEXT_NODE) {
          const domRange = document.createRange();
          domRange.setStart(node, range.startOffset);
          domRange.setEnd(node, range.endOffset);
          for (const r of domRange.getClientRects()) {
            rects.push({ x: r.x, y: r.y, width: r.width, height: r.height });
          }
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as HTMLElement;
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            const tag = el.tagName.toLowerCase();
            if (
              (tag === "input" || tag === "textarea") &&
              typeof (el as HTMLInputElement).value === "string"
            ) {
              const val = (el as HTMLInputElement).value;
              const tokenRect = computeFormInputTokenRect(
                el as HTMLInputElement | HTMLTextAreaElement,
                r,
                val,
                range.startOffset,
                range.endOffset
              );
              if (tokenRect) {
                rects.push(tokenRect);
                continue;
              }
            }
            rects.push({ x: r.x, y: r.y, width: r.width, height: r.height });
          }
        }
      } catch {
        // Node partially detached between scan and render; skip safely.
      }
    }
    return rects;
  }

  function findingRects(start: number, end: number): Rect[] {
    return findingRectsFromRanges(mapRange(segments, segmentStarts, combined.length, start, end));
  }

  /** Findings travel via chunkFindingsByByteBudget so all findings survive Chrome IPC. */

  function buildFindings(
    rawMatches: ReturnType<typeof detect>,
    enabledCategories: string[],
    customPatterns: CustomPattern[] = []
  ): Finding[] {
    return rawMatches.map((match, i) => {
      const mapped = mapRange(segments, segmentStarts, combined.length, match.start, match.end);
      const rects = findingRectsFromRanges(mapped);
      const isCustom = match.category === "custom" || customPatterns.some((cp) => cp.category === match.category && cp.pattern);
        const parsedName =
          match.parsedName ??
          (match.category === "possible_name" ? parseName(match.value) : undefined);
        return {
          id: `${match.category}_${match.start}_${match.end}_${i}`,
          category: match.category,
          entityType: match.entityType,
          confidence: match.confidence,
          source: isCustom ? "custom-pattern" : "local-rules",
          preview: maskValue(match.category, match.value),
          nodeId: mapped[0]?.nodeId ?? "",
          startOffset: match.start,
          endOffset: match.end,
          rects,
          contextPreview: contextFor(match.start, match.end),
          ...(match.category === "possible_name" ? { parsedName } : {}),
          selected:
            match.category !== "possible_name" ||
            currentSettings?.autoMaskSingleNames === true ||
            isNameStructured(parsedName),
        } satisfies Finding;
    });
  }

  function getOverlayItems(padding: number): Array<{ kind: "highlight" | "mask"; label: string; placeholder?: string; x: number; y: number; width: number; height: number }> {
    const items: Array<{ kind: "highlight" | "mask"; label: string; placeholder?: string; x: number; y: number; width: number; height: number }> = [];
    for (const finding of findings) {
      if (!finding.selected) continue;
      if (finding.source !== "attr" && finding.nodeId && finding.nodeId !== "svg" && !finding.nodeId.startsWith("media")) {
        const mappedNode = nodeIds.get(finding.nodeId);
        if (!mappedNode || !mappedNode.isConnected) {
          finding.rects = [];
          continue;
        }
        const fresh = findingRects(finding.startOffset, finding.endOffset);
        finding.rects = fresh;
      }
      for (const r of finding.rects) {
        if (
          !Number.isFinite(r.x) ||
          !Number.isFinite(r.y) ||
          !Number.isFinite(r.width) ||
          !Number.isFinite(r.height) ||
          r.width <= 0 ||
          r.height <= 0
        ) {
          continue;
        }
        items.push({
          kind: "mask",
          label: `${finding.entityType ?? finding.category}: ${finding.preview}`,
          ...(placeholdersEnabled ? { placeholder: placeholderLabelFor(finding.category) } : {}),
          x: r.x - padding,
          y: r.y - padding,
          width: r.width + padding * 2,
          height: r.height + padding * 2,
        });
      }
    }
    return items;
  }

  function recomputeOverlay(padding: number) {
    if (overlay && overlay.isConnected && !overlay.isConnected()) {
      overlay.destroy();
      overlay = null;
    }
    if (!overlay) {
      overlay = createOverlay(document, () => getOverlayItems(padding));
    } else {
      overlay.setRecalculator?.(() => getOverlayItems(padding));
    }
    const items = getOverlayItems(padding);
    overlay.render(items);

    // Deterministic render-state reconciliation: if active findings fall inside
    // the viewport yet no mask elements were painted, schedule a corrective repaint.
    if (items.length > 0 && overlay.getRenderedCount && overlay.getRenderedCount() === 0) {
      const vw = Math.max(1, window.innerWidth || document.documentElement?.clientWidth || 1024);
      const vh = Math.max(1, window.innerHeight || document.documentElement?.clientHeight || 768);
      const hasVisibleItem = items.some(
        (r) => r.width > 0 && r.height > 0 && r.x + r.width >= 0 && r.y + r.height >= 0 && r.x <= vw && r.y <= vh
      );
      if (hasVisibleItem) {
        queueMicrotask(() => {
          if (!sessionId || !overlay) return;
          const refreshed = getOverlayItems(padding);
          overlay.render(refreshed);
        });
      }
    }
  }

  async function handleScan(mode: "local" | "cloud", requestId: string, settings: ScanSettings): Promise<void> {
    if (mode === "cloud") {
      respond(
        {
          type: "CONTENT_ERROR",
          requestId,
          sessionId: sessionId as string,
          code: "CLOUD_NOT_ALLOWED",
          userMessage: "Cloud scanning is disabled. Switch to local mode in settings.",
        },
        requestId
      );
      return;
    }
    const sessionTimeoutMs = settings.sessionTimeoutMs;
    activeSessionTimeoutMs = sessionTimeoutMs;
    currentSettings = settings;

    // ── Layer 0: Single DOM Inventory Pass (Item 16) ──────────────────────
    let passResult: import("./normalization/pageInventory.js").DOMInventoryPassResult | null = null;
    let inventory: import("./normalization/pageInventory.js").PageInventory | null = null;
    try {
      passResult = runDOMInventoryPass(document);
      inventory = passResult.inventory;
    } catch {
      passResult = null;
      inventory = null;
    }

    // ── Layer 1: DOM canonical text (windowed full-page scan, P6 / D4) ────
    const canonical = buildCanonicalDocumentWindows({
      root: document,
      sourceKind: "web-dom",
      maxVisibleChars: settings.maxVisibleChars,
      maxNodeChars: settings.maxNodeChars,
      windowChars: settings.windowChars,
      windowOverlapChars: settings.windowOverlapChars,
      maxTotalWindows: settings.maxTotalWindows,
      nodeIds,
    });

    const tables = extractTableStructures(document, passResult?.tables);
    if (tables.length > 0) {
      canonical.segments = annotateSegmentsWithTableStructure(canonical.segments, nodeIds);
      canonical.metadata.tableCount = tables.length;
    }

    const frameGlobalStart = canonical.combined.length > 0 ? canonical.combined.length + 1 : 0;
    const frameTextParts: string[] = [];

    // Frame text is appended after the top document's, so the scan string
    // contains every frame. Each frame contributes an independently offset
    // segment list; the shift is applied here, once, against the combined
    // string that is actually built below.
    const allFrames = passResult ? [...passResult.frames.sameOrigin, ...passResult.frames.crossOrigin] : undefined;
    const iframeResult = traverseIframes(document, {
      maxVisibleChars: settings.maxVisibleChars,
      maxNodeChars: settings.maxNodeChars,
      nodeIds,
      preCollectedFrames: allFrames,
    });
    for (const frameDoc of iframeResult.frameDocuments) {
      const shift = canonical.combined.length > 0 ? canonical.combined.length + 1 : 0;
      canonical.segments.push(
        ...frameDoc.segments.map((seg) => ({
          ...seg,
          combinedStartOffset: seg.combinedStartOffset + shift,
          combinedEndOffset: seg.combinedEndOffset + shift,
        }))
      );
      canonical.combined += (canonical.combined.length > 0 ? "\n" : "") + frameDoc.combined;
      canonical.segmentStarts.push(...frameDoc.segmentStarts.map((s) => s + shift));
      if (frameDoc.combined.length > 0) frameTextParts.push(frameDoc.combined);
    }
    canonical.boundaries.push(...iframeResult.boundaries);

    // Coverage is derived from what the traversal actually read, through the
    // same function buildCanonicalDocument used. A frame we could not open is
    // not "complete", and saying so is what stops a cross-origin frame full of
    // PII from being reported as clean.
    canonical.coverage = updateCoverageWithBoundaries(
      canonical.coverage,
      canonical.boundaries,
      {
        // framesSeen is authoritative: it counts frames the inventory may have
        // missed, and it includes cross-origin ones that can never be read.
        present: iframeResult.framesSeen,
        read: iframeResult.frameDocuments.length,
      },
      canonical.truncated
    );

    canonical.coverage = setDynamicContentMonitored(canonical.coverage);

    segments = canonical.segments;
    combined = canonical.combined;
    segmentStarts = canonical.segmentStarts;
    segmentIndexById.clear();
    // eslint-disable-next-line security/detect-object-injection
    for (let i = 0; i < segments.length; i++) segmentIndexById.set(segments[i].nodeId, i);

    placeholdersEnabled = settings.maskPlaceholders;

    let customPatterns: CustomPattern[] = [];
    try {
      const stored = await chrome.storage.local.get("customPatterns");
      if (Array.isArray(stored.customPatterns)) {
        customPatterns = stored.customPatterns;
      }
    } catch {
      // Local storage read failed, fall back to empty
    }
    currentCustomPatterns = customPatterns;

    // eslint-disable-next-line security/detect-object-injection
    const threshold = (cat: FindingCategory) => settings.confidenceThresholds?.[cat] ?? 0;
    let customPatternsPartiallyScanned = false;
    let rawMatches: RawMatch[] = [];

    const totalWindows = canonical.windowsTotal;
    const charsTotal = combined.length;
    const incompleteWindows: IncompleteWindowInfo[] = [...canonical.incompleteWindows];
    let windowsScanned = 0;
    let charsScanned = 0;

    if (totalWindows > 1) {
      respond(
        {
          type: "SCAN_PROGRESS",
          requestId,
          sessionId: sessionId as string,
          windowsCompleted: 0,
          windowsTotal: totalWindows,
          charsScanned: 0,
          charsTotal,
          findingsSoFar: 0,
        },
        requestId
      );
    }

    for (let wIdx = 0; wIdx < canonical.windowSlices.length; wIdx++) {
      // eslint-disable-next-line security/detect-object-injection
      const slice = canonical.windowSlices[wIdx];
      try {
        const winDetected = detectWithCoverage(slice.combined, settings.enabledCategories, customPatterns);
        if (winDetected.partiallyScanned) customPatternsPartiallyScanned = true;
        let winMatches = winDetected.matches.map((m) => ({
          ...m,
          start: slice.globalStartOffset + m.start,
          end: slice.globalStartOffset + m.end,
        }));
        if (settings.enabledCategories.includes("possible_name")) {
          if (!isNameDictionariesLoaded() && winMatches.some((m) => m.category === "possible_name")) {
            await ensureNameDictionariesLoaded();
          }
          winMatches = enrichAndBoostNames(winMatches);
        }
        if (settings.medicalDictionaryEnabled === true) {
          const mode = settings.clinicMode ?? "general";
          await ensureMedicalDictionaryLoaded(mode);
          const medMatches = detectMedicalDictionaryTerms(slice.combined, mode).map((m) => ({
            ...m,
            start: slice.globalStartOffset + m.start,
            end: slice.globalStartOffset + m.end,
          }));
          winMatches.push(...medMatches);
        }
        rawMatches.push(...winMatches);
        windowsScanned += 1;
      } catch (err) {
        incompleteWindows.push({
          windowIndex: slice.windowIndex,
          reason: err instanceof Error && err.message ? err.message.slice(0, 120) : "Window scan failed",
        });
      }
      charsScanned += slice.charCount;
      if (totalWindows > 1) {
        respond(
          {
            type: "SCAN_PROGRESS",
            requestId,
            sessionId: sessionId as string,
            windowsCompleted: wIdx + 1,
            windowsTotal: totalWindows,
            charsScanned: Math.min(charsScanned, charsTotal),
            charsTotal,
            findingsSoFar: rawMatches.filter((m) => m.confidence >= threshold(m.category)).length,
          },
          requestId
        );
        if (wIdx < canonical.windowSlices.length - 1) {
          await new Promise((r) => setTimeout(r, 0));
        }
      }
    }

    if (frameTextParts.length > 0) {
      const frameCombined = frameTextParts.join("\n");
      const frameDetected = detectWithCoverage(frameCombined, settings.enabledCategories, customPatterns);
      if (frameDetected.partiallyScanned) customPatternsPartiallyScanned = true;
      let frameMatches = frameDetected.matches.map((m) => ({
        ...m,
        start: frameGlobalStart + m.start,
        end: frameGlobalStart + m.end,
      }));
      if (settings.enabledCategories.includes("possible_name")) {
        if (!isNameDictionariesLoaded() && frameMatches.some((m) => m.category === "possible_name")) {
          await ensureNameDictionariesLoaded();
        }
        frameMatches = enrichAndBoostNames(frameMatches);
      }
      rawMatches.push(...frameMatches);
    }

    const effectiveTruncated =
      canonical.truncated ||
      canonical.hardLimitReached ||
      customPatternsPartiallyScanned ||
      incompleteWindows.length > 0;

    const filteredMatches = rawMatches.filter(
      (m) => m.confidence >= threshold(m.category)
    );
    findings = buildFindings(filteredMatches, settings.enabledCategories, customPatterns);

    // ── Layer 2 (SVG branch): Inline SVG text → run through detect ────────
    try {
      const svgSegments = extractSvgText(document, passResult?.media.svgs);
      if (svgSegments.length > 0) {
        const svgText = svgSegments.map((s) => s.text).join("\n");
        const svgDetected = detectWithCoverage(svgText, settings.enabledCategories, customPatterns);
        if (svgDetected.partiallyScanned) customPatternsPartiallyScanned = true;
        const svgMatches = svgDetected.matches.filter(
          (m) => m.confidence >= threshold(m.category)
        );
        const svgOffset = combined.length + 1; // beyond the DOM scan text
        svgMatches.forEach((match, i) => {
          const value = svgText.slice(match.start, match.end);
          let accumulated = 0;
          const matchedRects: Rect[] = [];
          for (const s of svgSegments) {
            const segLen = s.text.length;
            if (match.start < accumulated + segLen && match.end > accumulated) {
              if (s.boundingRect.width > 0 && s.boundingRect.height > 0) {
                matchedRects.push({ ...s.boundingRect });
              }
            }
            accumulated += segLen + 1;
          }
          findings.push({
            id: `svg_${match.category}_${match.start}_${match.end}_${i}`,
            category: match.category,
            confidence: match.confidence,
            source: "local-rules",
            preview: maskValue(match.category, value),
            nodeId: "svg",
            startOffset: svgOffset + match.start,
            endOffset: svgOffset + match.end,
            rects: matchedRects,
            contextPreview: maskContext(svgText.slice(Math.max(0, match.start - 80), Math.min(svgText.length, match.end + 80))),
            selected: true, // SVG findings are active and render masks
          } satisfies Finding);
        });
      }
    } catch {
      // SVG extraction is best-effort — never fail the scan.
    }

    // ── Layer 4 (video captions, deterministic): run through detect ───────
    try {
      const captions = extractVideoCaptions(document, passResult?.media.videos);
      if (captions.length > 0) {
        const captionText = captions.map((c) => c.text).join("\n");
        const captionDetected = detectWithCoverage(captionText, settings.enabledCategories, customPatterns);
        if (captionDetected.partiallyScanned) customPatternsPartiallyScanned = true;
        const captionMatches = captionDetected.matches.filter(
          (m) => m.confidence >= threshold(m.category)
        );
        const captionOffset = combined.length + 2000; // well beyond DOM text
        captionMatches.forEach((match, i) => {
          const value = captionText.slice(match.start, match.end);
          findings.push({
            id: `caption_${match.category}_${match.start}_${match.end}_${i}`,
            category: match.category,
            confidence: match.confidence,
            source: "local-rules",
            preview: maskValue(match.category, value),
            nodeId: "video-caption",
            startOffset: captionOffset + match.start,
            endOffset: captionOffset + match.end,
            rects: [],
            contextPreview: maskContext(captionText.slice(Math.max(0, match.start - 80), Math.min(captionText.length, match.end + 80))),
            selected: false,
          } satisfies Finding);
        });
      }
    } catch {
      // Caption extraction is best-effort.
    }

    // Accessibility-surface pass (report-only): scan aria-label/alt/placeholder/
    // title values. Read-only; these findings are never maskable.
    let attrChars = 0;
    try {
      const collected = collectAttrRecords(document, {
        maxTotalChars: settings.maxVisibleChars,
        maxPerValue: Math.min(settings.maxNodeChars, 2048),
      });
      attrScan = buildAttrScan(collected.records);
      attrChars = attrScan.combined.length;
      const attrDetected = detectWithCoverage(attrScan.combined, settings.enabledCategories, customPatterns);
      if (attrDetected.partiallyScanned) customPatternsPartiallyScanned = true;
      const attrMatches = attrDetected.matches.filter(
        (m) => m.confidence >= threshold(m.category)
      );
      const attrFindings = attrMatches.map((match, i) => {
        const value = attrScan!.combined.slice(match.start, match.end);
        const pad = 120;
        const ctxSlice = attrScan!.combined.slice(Math.max(0, match.start - pad), Math.min(attrScan!.combined.length, match.end + pad));
        return {
          id: `attr_${match.category}_${match.start}_${match.end}_${i}`,
          category: match.category,
          confidence: match.confidence,
          source: "attr" as const,
          preview: maskValue(match.category, value),
          nodeId: "",
          startOffset: match.start,
          endOffset: match.end,
          rects: [],
          contextPreview: maskContext(ctxSlice),
          attribute: attributeAt(attrScan!, match.start),
          selected: false,
        } satisfies Finding;
      });
      findings = [...findings, ...attrFindings];
    } catch {
      // Attribute collection is best-effort reporting; never fail the scan.
      attrScan = null;
    }
    findings = findings.filter((f) => f.confidence >= threshold(f.category));
    touchSession();

    // ── Layers 2–5: Build visual-capture and PDF queues ───────────────────
    let visualQueue: import("../shared/types.js").VisualCaptureRequestItem[] | undefined;
    let pdfQueue: import("../shared/types.js").PdfExtractRequestItem[] | undefined;
    let deferredMediaCount = 0;
    let coverageStatus: import("../shared/types.js").ScanCoverageStatus | undefined;

    try {
      if (inventory) {
        const mediaResult = buildMediaQueue(document, inventory, 8, location.href, passResult?.media);
        if (mediaResult.visualQueue.length > 0) visualQueue = mediaResult.visualQueue;
        if (mediaResult.pdfQueue.length > 0) pdfQueue = mediaResult.pdfQueue;
        deferredMediaCount = mediaResult.deferredCount;
        const allUnresolved = [
          ...inventory.unscannableRegions,
          ...mediaResult.newUnscannableRegions,
        ];
        // Exclude items that were successfully queued for processing.
        const queuedIds = new Set((visualQueue ?? []).map((q) => q.cssSelector));
        const remainingUnresolved = allUnresolved.filter((r) => !queuedIds.has(r.cssSelector));
        coverageStatus = resolveScanCoverageStatus({
          findingsCount: findings.filter((f) => f.source !== "attr" && f.selected).length,
          unresolvedRegions: remainingUnresolved,
          deferredMediaCount,
          visibleChars: combined.length,
          truncated: effectiveTruncated,
          customPatternsPartiallyScanned,
        });
      } else if (effectiveTruncated) {
        coverageStatus = "PARTIALLY_SCANNED";
      }
    } catch {
      // Media queue is best-effort — never fail the scan.
      if (effectiveTruncated) {
        coverageStatus = "PARTIALLY_SCANNED";
      }
    }

    const coverageWarnings: import("../shared/types.js").CoverageWarning[] = [];
    if (incompleteWindows.length > 0) {
      coverageWarnings.push({
        cause: "incomplete_window",
        count: incompleteWindows.length,
        detail: incompleteWindows.map((w) => `Window ${w.windowIndex}: ${w.reason}`).join("; "),
      });
    } else if (effectiveTruncated) {
      coverageWarnings.push({
        cause: "truncated",
        count: 1,
      });
    }
    if ((inventory?.crossOriginIframes ?? 0) > 0) {
      coverageWarnings.push({
        cause: "cross_origin_iframe",
        count: inventory!.crossOriginIframes,
      });
    }
    const closedShadowCount =
      (inventory?.closedShadowRootsAccessed ?? 0) + (inventory?.closedShadowRootsBlocked ?? 0);
    if (closedShadowCount > 0) {
      coverageWarnings.push({
        cause: "closed_shadow_root",
        count: closedShadowCount,
      });
    }
    if ((inventory?.canvases ?? 0) > 0 && combined.length === 0) {
      coverageWarnings.push({
        cause: "canvas_only",
        count: inventory!.canvases,
      });
    }

    lastAttrChars = attrChars;
    lastTruncated = effectiveTruncated;
    const rawCoverageStatus = incompleteWindows.length > 0 ? "PARTIALLY_SCANNED" : coverageStatus;
    lastCoverageStatus =
      coverageWarnings.length > 0 &&
      (rawCoverageStatus === "FULLY_SCANNED" ||
        rawCoverageStatus === "NO_SENSITIVE_DATA_DETECTED" ||
        rawCoverageStatus === undefined)
        ? "PARTIALLY_SCANNED"
        : rawCoverageStatus;
    lastDeferredMediaCount = deferredMediaCount;
    lastWindowsScanned = windowsScanned;
    lastWindowsTotal = totalWindows;
    lastIncompleteWindows = incompleteWindows.length > 0 ? incompleteWindows : undefined;
    lastCoverageWarnings = coverageWarnings.length > 0 ? coverageWarnings : undefined;

    const imageCandidates = (combined.length === 0 || (combined.length < 300 && findings.length === 0)) ? collectImageCandidates() : undefined;

    await emitScanResult(requestId, {
      ...(imageCandidates ? { imageCandidates } : {}),
      ...(visualQueue ? { visualQueue } : {}),
      ...(pdfQueue ? { pdfQueue } : {}),
    });
  }

  async function emitScanResult(
    requestId: string,
    extraStats: Record<string, unknown> = {}
  ): Promise<void> {
    if (!sessionId) return;
    const currentSessionId = sessionId;
    const result: Finding[] = findings.map((f) => ({
      ...f,
      rects: f.rects.map((r) => ({ ...r })),
    }));
    const chunks = chunkFindingsByByteBudget(result, DEFAULT_FINDINGS_CHUNK_BYTES);
    const totalFindings = result.length;

    if (chunks.length > 1) {
      for (let i = 0; i < chunks.length - 1; i++) {
        try {
          await chrome.runtime.sendMessage({
            type: "SCAN_RESULT_CHUNK",
            requestId,
            sessionId: currentSessionId,
            chunkIndex: i,
            totalChunks: chunks.length,
            // eslint-disable-next-line security/detect-object-injection
            findings: chunks[i],
          });
        } catch {
          // Best-effort chunk delivery; final SCAN_RESULT will report honest completeness.
        }
      }
    }

    const lastChunk = chunks[chunks.length - 1] ?? [];
    const payload = {
      type: "SCAN_RESULT",
      requestId,
      sessionId: currentSessionId,
      findings: lastChunk,
      ...(chunks.length > 1 ? { chunkIndex: chunks.length - 1, totalChunks: chunks.length } : {}),
      stats: {
        visibleChars: combined.length,
        attrChars: lastAttrChars,
        truncated: lastTruncated,
        findingsTruncated: false,
        totalFindings,
        ...(lastWindowsScanned !== undefined ? { windowsScanned: lastWindowsScanned } : {}),
        ...(lastWindowsTotal !== undefined ? { windowsTotal: lastWindowsTotal } : {}),
        ...(lastIncompleteWindows && lastIncompleteWindows.length > 0
          ? { incompleteWindows: lastIncompleteWindows }
          : {}),
        ...(lastDeferredMediaCount > 0 ? { deferredMediaCount: lastDeferredMediaCount } : {}),
        ...(lastCoverageStatus !== undefined ? { coverageStatus: lastCoverageStatus } : {}),
        ...(lastCoverageWarnings && lastCoverageWarnings.length > 0
          ? { coverageWarnings: lastCoverageWarnings }
          : {}),
        ...extraStats,
      },
    };
    try {
      await chrome.runtime.sendMessage(payload);
    } catch {
      // SW may have suspended; delivery is best-effort.
    }
  }


  /**
   * List the page's images so a textless page can still be protected.
   *
   * Only images that actually carry pixels are reported, ranked largest first,
   * and the list is capped: a gallery page can hold thousands of thumbnails and
   * none of them are the document. `sameOrigin` marks the images this page is
   * allowed to read directly, which is what decides whether the original file
   * can be used or a rendered capture is needed.
   */
  function collectImageCandidates(): Array<{ src: string; width: number; height: number; sameOrigin: boolean }> {
    const found: Array<{ src: string; width: number; height: number; sameOrigin: boolean; pixels: number }> = [];
    let images: HTMLImageElement[];
    try {
      images = Array.from(document.querySelectorAll("img"));
    } catch {
      return [];
    }
    for (const img of images) {
      if (isExcludedElement(img)) continue;
      const width = img.naturalWidth || img.width || 0;
      const height = img.naturalHeight || img.height || 0;
      // Below this the image cannot hold readable text; it is an icon.
      if (width * height < 40_000) continue;
      const src = img.currentSrc || img.src || "";
      if (!src) continue;
      let sameOrigin = false;
      try {
        sameOrigin = new URL(src, location.href).origin === location.origin;
      } catch {
        continue;
      }
      found.push({ src: src.slice(0, 2048), width, height, sameOrigin, pixels: width * height });
    }
    found.sort((a, b) => b.pixels - a.pixels);
    return found.slice(0, 12).map(({ src, width, height, sameOrigin }) => ({ src, width, height, sameOrigin }));
  }

  function respond(message: unknown, requestId: string): void {
    void chrome.runtime.sendMessage(message).catch(() => {
      // SW may have suspended; delivery is best-effort for fire-and-forget.
    });
  }

  chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
    if (sender && sender.id && sender.id !== chrome.runtime.id) {
      sendResponse({ ok: false, error: "Unauthorized sender" });
      return;
    }
    if (typeof raw === "object" && raw !== null && (raw as { type?: unknown }).type === "PING") {
      sendResponse({ ok: true, status: "ready" });
      return true;
    }

    const validation = validateMessage(raw);
    if (!validation.ok) {
      sendResponse({ ok: false, error: validation.error });
      return;
    }
    const msg = validation.message as WorkerMessage;

    void (async () => {
      try {
        switch (msg.type) {
          case "CONTENT_SHOW_TOAST": {
            showToast({
              title: msg.title,
              message: msg.message,
              level: msg.level,
              durationMs: msg.durationMs,
              actionLabel: msg.actionLabel,
            });
            sendResponse({ ok: true });
            break;
          }
          case "SCAN_PAGE_VISUAL_RESULT": {
            if (msg.sessionId !== sessionId) {
              sendResponse({ ok: false, error: "Stale session" });
              break;
            }
            for (const f of msg.findings) {
              if (!findings.some((existing) => existing.id === f.id)) {
                findings.push(f);
              }
            }
            sendResponse({ ok: true });
            break;
          }
          case "SCAN_PAGE": {
            clearSession();
            sessionId = msg.sessionId;
            await handleScan(msg.mode, msg.requestId, msg.settings);
            sendResponse({ ok: true });
            break;
          }
          case "APPLY_MASKS": {
            if (msg.sessionId !== sessionId) {
              sendResponse({ ok: false, error: "Stale session" });
              break;
            }
            const idSet = new Set(msg.findingIds);
            findings = applySelectionExcludingAttrs(findings, idSet);
            recomputeOverlay(4);
            touchSession();
            sendResponse({ ok: true });
            break;
          }
          case "REMOVE_MASKS": {
            // Allow removing manual masks without an active scan session
            const hasManualMasks = manualSelectionRanges.length > 0;
            if (msg.sessionId !== sessionId && !hasManualMasks) {
              sendResponse({ ok: false, error: "Stale session" });
              break;
            }
            findings = findings.map((f) => ({ ...f, selected: false }));
            manualSelectionRanges = [];
            if (overlay) {
              overlay.clear();
              overlay.setRecalculator?.(() => {});
            }
            touchSession();
            sendResponse({ ok: true });
            break;
          }
          case "COPY_REDACTED_TEXT": {
            if (msg.sessionId !== sessionId) {
              sendResponse({ ok: false, error: "Stale session" });
              break;
            }
            const idSet = new Set(msg.findingIds);
            // Report-only attribute findings are never included in redacted copy.
            const selectedFindings = applySelectionExcludingAttrs(findings, idSet).filter(
              (f) => f.source !== "attr"
            );
            const text = buildRedactedText(segments, segmentStarts, combined.length, selectedFindings);
            respond(
              { type: "COPY_REDACTED_TEXT_RESULT", requestId: msg.requestId, sessionId, text },
              msg.requestId
            );
            touchSession();
            sendResponse({ ok: true });
            break;
          }
          case "CONTEXT_REDACT_SELECTION": {
            const selText = msg.selectionText ?? window.getSelection()?.toString() ?? "";
            if (!selText) {
              sendResponse({ ok: false, error: "No text selected" });
              break;
            }
            let customPatterns: CustomPattern[] = [];
            try {
              const stored = await chrome.storage.local.get("customPatterns");
              if (Array.isArray(stored.customPatterns)) {
                customPatterns = stored.customPatterns as CustomPattern[];
              }
            } catch {
              // Ignore
            }
            const enabledCategories: FindingCategory[] = msg.settings?.enabledCategories ?? ALL_CATEGORIES;
            // eslint-disable-next-line security/detect-object-injection
            const threshold = (cat: FindingCategory) => msg.settings?.confidenceThresholds?.[cat] ?? 0;
            const matches = detect(selText, enabledCategories, customPatterns).filter(
              (m) => m.confidence >= threshold(m.category)
            );
            let redacted = selText;
            const sorted = [...matches].sort((a, b) => b.start - a.start);
            for (const m of sorted) {
              const repl = msg.settings?.maskPlaceholders
                ? placeholderLabelFor(m.category)
                : "\u2588".repeat(m.end - m.start);
              redacted = redacted.slice(0, m.start) + repl + redacted.slice(m.end);
            }
            if (navigator.clipboard?.writeText) {
              await navigator.clipboard.writeText(redacted);
            }
            // Counts only. The redacted text is the product of this action — it
            // belongs on the clipboard, which is where the user asked for it —
            // and returning it to the worker only put page-derived content on a
            // second boundary for no consumer. The worker needs the counts to
            // write a metadata-only audit record.
            const counts: Record<string, number> = {};
            for (const m of matches) counts[m.category] = (counts[m.category] ?? 0) + 1;
            sendResponse({ ok: true, counts });
            break;
          }
          case "CONTEXT_MASK_SELECTION": {
            const sel = window.getSelection();
            if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
              sendResponse({ ok: false, error: "No active selection to mask" });
              break;
            }
            if (!overlay) overlay = createOverlay(document);
            placeholdersEnabled = msg.settings?.maskPlaceholders ?? false;
            const range = sel.getRangeAt(0);
            const rects = range.getClientRects();
            const padding = 4;
            // Store for recalculation on scroll/resize
            manualSelectionRanges.push({
              range,
              rects,
              label: "Selected text",
              ...(placeholdersEnabled ? { placeholder: "[REDACTED]" } : {}),
            });
            const items = manualSelectionRanges.flatMap((msr) =>
              Array.from(msr.rects).map((r) => ({
                kind: "mask" as const,
                label: msr.label,
                ...(msr.placeholder ? { placeholder: msr.placeholder } : {}),
                x: r.x - padding,
                y: r.y - padding,
                width: r.width + padding * 2,
                height: r.height + padding * 2,
              }))
            );
            if (overlay) {
              overlay.render(items);
              // Set recalculator to update manual masks on scroll/resize
              const currentOverlay = overlay;
              currentOverlay.setRecalculator?.(() => {
                const updated = manualSelectionRanges.flatMap((msr) => {
                  const freshRects = msr.range.getClientRects();
                  if (freshRects.length === 0) return [];
                  return Array.from(freshRects).map((r) => ({
                    kind: "mask" as const,
                    label: msr.label,
                    ...(msr.placeholder ? { placeholder: msr.placeholder } : {}),
                    x: r.x - padding,
                    y: r.y - padding,
                    width: r.width + padding * 2,
                    height: r.height + padding * 2,
                  }));
                });
                return updated;
              });
            }
            touchSession();
            sendResponse({ ok: true });
            break;
          }
          default:
            sendResponse({ ok: false, error: "Unsupported content message" });
        }
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  });

  /**
   * While a mask session is active, replace clipboard content with the
   * redacted form of the current selection so plain copy/cut cannot leak
   * masked values. The DOM is never mutated; the redacted text is derived
   * from the scan state. With no selected findings, copy behaves normally.
   * For input/textarea, preserves native newlines and selection.
   *
   * Wrapped in defensive try/catch boundaries (Priority 2 — Item 10) so rare
   * selection/range anomalies (detached nodes, cross-shadow boundaries) never
   * crash clipboard handling.
   */
  function onClipboard(event: ClipboardEvent): void {
    try {
      if (!sessionId) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;

      const activeElement = document.activeElement;
      const isInputOrTextarea =
        activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement;

      // If selection is inside an input/textarea, use native value with preserved newlines
      if (isInputOrTextarea && activeElement === sel.anchorNode?.parentElement) {
        const input = activeElement;
        const start = input.selectionStart;
        const end = input.selectionEnd;
        if (
          start !== null &&
          end !== null &&
          start !== end &&
          start >= 0 &&
          end <= input.value.length
        ) {
          const selectedText = input.value.slice(start, end);
          const active = findings.filter(
            (f) => f.selected && f.startOffset < end && f.endOffset > start
          );
          if (active.length > 0) {
            let resultText = selectedText;
            const sortedActive = [...active].sort((a, b) => b.startOffset - a.startOffset);
            for (const f of sortedActive) {
              const fs = Math.max(start, f.startOffset) - start;
              const fe = Math.min(end, f.endOffset) - start;
              if (fe <= fs) continue;
              const repl = placeholdersEnabled
                ? `[${placeholderLabelFor(f.category)}]`
                : "\u2588".repeat(fe - fs);
              resultText = resultText.slice(0, fs) + repl + resultText.slice(fe);
            }
            event.clipboardData?.setData("text/plain", resultText);
            event.preventDefault();
            touchSession();
          }
          return;
        }
      }

      // Fallback: combined scan text approach (may flatten newlines across segments)
      const range = sel.getRangeAt(0) as unknown as RangeLike<Text>;
      const span = selectionCombinedSpan(
        range,
        segments,
        segmentStarts,
        segmentIndexById,
        nodeIds,
        combined.length,
        (node) => node.isConnected
      );
      if (!span) return;
      const active = findings.filter(
        (f) => f.selected && f.startOffset < span.end && f.endOffset > span.start
      );
      if (active.length === 0) return;
      const text = maskCombinedRange(combined, span.start, span.end, active, placeholdersEnabled);
      event.clipboardData?.setData("text/plain", text);
      event.preventDefault();
      touchSession();
    } catch {
      // Graceful fallback: if DOM selection mapping fails (e.g., detached range
      // or cross-shadow boundary), redact the raw selection string on-the-fly
      // if active findings exist so sensitive data is still protected.
      try {
        const hasActiveFindings = findings.some((f) => f.selected);
        if (!hasActiveFindings || !currentSettings) return;
        const rawSelText = window.getSelection()?.toString() ?? "";
        if (!rawSelText) return;
        // eslint-disable-next-line security/detect-object-injection
        const threshold = (cat: FindingCategory) => currentSettings?.confidenceThresholds?.[cat] ?? 0;
        const matches = detect(rawSelText, currentSettings.enabledCategories, currentCustomPatterns).filter(
          (m) => m.confidence >= threshold(m.category)
        );
        if (matches.length === 0) return;
        let redacted = rawSelText;
        const sorted = [...matches].sort((a, b) => b.start - a.start);
        for (const m of sorted) {
          const repl = (placeholdersEnabled || currentSettings?.maskPlaceholders)
            ? `[${placeholderLabelFor(m.category)}]`
            : "\u2588".repeat(m.end - m.start);
          redacted = redacted.slice(0, m.start) + repl + redacted.slice(m.end);
        }
        event.clipboardData?.setData("text/plain", redacted);
        event.preventDefault();
      } catch {
        // Never allow clipboard handler to throw an uncaught exception.
      }
    }
  }

  document.addEventListener("copy", onClipboard);
  // Intercepting cut also prevents the selection from being deleted from the
  // source page while masks are active.
  document.addEventListener("cut", onClipboard);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") clearSession();
  });

  const invalidateOnNavigation = () => clearSession();
  window.addEventListener("popstate", invalidateOnNavigation);
  const pushState = history.pushState;
  const replaceState = history.replaceState;
  history.pushState = function (...args: unknown[]) {
    pushState.apply(this, args as Parameters<typeof pushState>);
    invalidateOnNavigation();
  };
  history.replaceState = function (...args: unknown[]) {
    replaceState.apply(this, args as Parameters<typeof replaceState>);
    invalidateOnNavigation();
  };

  async function appendAndDetectNode(sourceNode: Element | Text, settings: ScanSettings): Promise<void> {
    const newNodeIds = new Map<string, Node>();
    const extracted = extractVisibleText(
      sourceNode,
      settings.maxVisibleChars,
      settings.maxNodeChars,
      newNodeIds
    );
    if (extracted.segments.length === 0) return;

    const newBuilt = buildScanText(extracted.segments);
    const offset = combined.length > 0 ? combined.length + 1 : 0;
    for (let i = 0; i < extracted.segments.length; i++) {
      // eslint-disable-next-line security/detect-object-injection
      const seg = extracted.segments[i];
      const uniqueNodeId = `rescan_seg_${nextRescanSegId++}`;
      const newSeg: import("./normalization/types.js").CanonicalSegment = {
        nodeId: uniqueNodeId,
        startOffset: seg.startOffset,
        endOffset: seg.endOffset,
        text: seg.text,
        // eslint-disable-next-line security/detect-object-injection
        combinedStartOffset: offset + newBuilt.segmentStarts[i],
        // eslint-disable-next-line security/detect-object-injection
        combinedEndOffset: offset + newBuilt.segmentStarts[i] + seg.text.length,
      };
      segments.push(newSeg);
      const targetNode = newNodeIds.get(seg.nodeId) ?? sourceNode;
      nodeIds.set(uniqueNodeId, targetNode);
      segmentIndexById.set(uniqueNodeId, segments.length - 1);
    }
    combined += (combined.length > 0 ? "\n" : "") + newBuilt.combined;
    segmentStarts.push(...newBuilt.segmentStarts.map((s) => s + offset));

    // eslint-disable-next-line security/detect-object-injection
    const threshold = (cat: FindingCategory) => settings.confidenceThresholds?.[cat] ?? 0;
    let deltaMatches = detect(newBuilt.combined, settings.enabledCategories, currentCustomPatterns);
    if (settings.enabledCategories.includes("possible_name")) {
      if (!isNameDictionariesLoaded() && deltaMatches.some((m) => m.category === "possible_name")) {
        void ensureNameDictionariesLoaded();
      }
      deltaMatches = enrichAndBoostNames(deltaMatches);
    }
    if (settings.medicalDictionaryEnabled === true) {
      const mode = settings.clinicMode ?? "general";
      if (!isMedicalDictionaryLoaded(mode)) {
        await ensureMedicalDictionaryLoaded(mode);
      }
      deltaMatches.push(...detectMedicalDictionaryTerms(newBuilt.combined, mode));
    }
    deltaMatches = deltaMatches.filter((m) => m.confidence >= threshold(m.category));
    if (deltaMatches.length === 0) return;

    const adjustedMatches = deltaMatches.map((m) => ({
      ...m,
      start: m.start + offset,
      end: m.end + offset,
    }));
    const newFindings = buildFindings(adjustedMatches, settings.enabledCategories, currentCustomPatterns);
    const existingIds = new Set(findings.map((f) => f.id));
    for (const nf of newFindings) {
      nf.id = `rescan_${nf.category}_${nextRescanFindingSeq++}`;
      if (!existingIds.has(nf.id) && nf.confidence >= threshold(nf.category)) {
        findings.push(nf);
      }
    }
  }

  async function rescanAffectedRegions(batch: MutationBatch): Promise<void> {
    if (!sessionId || !currentSettings) return;
    const settings = currentSettings;

    const affectedNodeIds = getAffectedNodeIds(batch, nodeIds);
    if (
      affectedNodeIds.size === 0 &&
      batch.addedNodes.length === 0 &&
      batch.mutatedTextNodes.length === 0
    ) {
      return;
    }

    const findingsToRemove = new Set<string>();
    for (const finding of findings) {
      if (finding.nodeId && affectedNodeIds.has(finding.nodeId)) {
        findingsToRemove.add(finding.id);
      }
    }
    if (findingsToRemove.size > 0) {
      findings = findings.filter((f) => !findingsToRemove.has(f.id));
    }

    // Record surviving findings' segment-local offsets so rebuilding `combined`
    // after splicing keeps surviving mask and copy ranges aligned.
    const survivingOffsets = new Map<string, { nodeId: string; deltaStart: number; len: number }>();
    for (const f of findings) {
      if (f.source !== "attr" && f.nodeId && f.nodeId !== "svg" && f.nodeId !== "video-caption" && !f.nodeId.startsWith("media")) {
        const oldIdx = segmentIndexById.get(f.nodeId);
        if (oldIdx !== undefined) {
          survivingOffsets.set(f.id, {
            nodeId: f.nodeId,
            // eslint-disable-next-line security/detect-object-injection
            deltaStart: f.startOffset - segmentStarts[oldIdx],
            len: f.endOffset - f.startOffset,
          });
        }
      }
    }

    const removedIndices: number[] = [];
    for (const nodeId of affectedNodeIds) {
      const idx = segmentIndexById.get(nodeId);
      if (idx !== undefined) {
        removedIndices.push(idx);
        nodeIds.delete(nodeId);
        segmentIndexById.delete(nodeId);
      }
    }
    if (removedIndices.length > 0) {
      removedIndices.sort((a, b) => b - a);
      for (const idx of removedIndices) {
        segments.splice(idx, 1);
      }
      segmentIndexById.clear();
      const rebuilt = buildScanText(segments);
      segmentStarts = rebuilt.segmentStarts;
      combined = rebuilt.combined;
      for (let i = 0; i < segments.length; i++) {
        // eslint-disable-next-line security/detect-object-injection
        segmentIndexById.set(segments[i].nodeId, i);
        // eslint-disable-next-line security/detect-object-injection
        segments[i].combinedStartOffset = segmentStarts[i];
        // eslint-disable-next-line security/detect-object-injection
        segments[i].combinedEndOffset = segmentStarts[i] + segments[i].text.length;
      }
      for (const f of findings) {
        const saved = survivingOffsets.get(f.id);
        if (!saved) continue;
        const newIdx = segmentIndexById.get(saved.nodeId);
        if (newIdx !== undefined) {
          // eslint-disable-next-line security/detect-object-injection
          f.startOffset = segmentStarts[newIdx] + saved.deltaStart;
          f.endOffset = f.startOffset + saved.len;
        }
      }
    }

    const connectedAdded = batch.addedNodes.filter(
      (n): n is Element | Text =>
        n.isConnected && (n.nodeType === Node.ELEMENT_NODE || n.nodeType === Node.TEXT_NODE)
    );
    for (const node of connectedAdded) {
      await appendAndDetectNode(node, settings);
    }

    // Option (a) for characterData mutations: re-extract and re-detect connected
    // mutated Text nodes not already covered by an added ancestor node in this batch.
    const uniqueMutatedTextNodes = new Set(batch.mutatedTextNodes);
    for (const textNode of uniqueMutatedTextNodes) {
      if (!textNode.isConnected) continue;
      const coveredByAdded = connectedAdded.some(
        (added) => added === textNode || (added.nodeType === Node.ELEMENT_NODE && added.contains(textNode))
      );
      if (coveredByAdded) continue;
      await appendAndDetectNode(textNode, settings);
    }

    if (findings.some((f) => f.selected)) {
      recomputeOverlay(4);
    } else {
      overlay?.clear();
    }

    // Notify service worker and popup after every incremental rescan so badge
    // and findings count stay synchronized with on-page overlay masks (Task P3).
    void emitScanResult(`rescan_${Date.now()}`);
  }

  function mergeMutationBatch(existing: MutationBatch | null, incoming: MutationBatch): MutationBatch {
    if (!existing) return incoming;
    const addedSet = new Set(existing.addedNodes);
    for (const n of incoming.addedNodes) addedSet.add(n);
    const removedSet = new Set(existing.removedNodes);
    for (const n of incoming.removedNodes) removedSet.add(n);
    const textSet = new Set(existing.mutatedTextNodes);
    for (const t of incoming.mutatedTextNodes) textSet.add(t);
    return {
      addedNodes: Array.from(addedSet),
      removedNodes: Array.from(removedSet),
      mutatedTextNodes: Array.from(textSet),
      timestamp: incoming.timestamp,
    };
  }

  function isInternalUiNode(node: Node): boolean {
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    const el = node as Element;
    return Boolean(
      el.hasAttribute?.("data-gw-scan-overlay") ||
      el.hasAttribute?.("data-gw-toast-host") ||
      el.id?.startsWith?.("__governworld-") ||
      el.closest?.("[data-gw-scan-overlay], [data-gw-toast-host], [id^='__governworld-']")
    );
  }

  function startMutationObserver(): void {
    if (mutationObserver) return;
    mutationObserver = observeMutations(document, (batch) => {
      if (!sessionId) return;

      const filteredBatch: MutationBatch = {
        addedNodes: batch.addedNodes.filter((n) => !isInternalUiNode(n)),
        removedNodes: batch.removedNodes.filter((n) => !isInternalUiNode(n)),
        mutatedTextNodes: batch.mutatedTextNodes,
        timestamp: batch.timestamp,
      };
      const affectedCount =
        filteredBatch.addedNodes.length +
        filteredBatch.removedNodes.length +
        filteredBatch.mutatedTextNodes.length;
      if (affectedCount === 0) return;

      pendingMutationBatch = mergeMutationBatch(pendingMutationBatch, filteredBatch);
      const pendingSize =
        pendingMutationBatch.addedNodes.length +
        pendingMutationBatch.removedNodes.length +
        pendingMutationBatch.mutatedTextNodes.length;
      const rescanDelayMs = pendingSize <= SMALL_BATCH_NODE_THRESHOLD ? SMALL_BATCH_RESCAN_DELAY_MS : BURST_RESCAN_DELAY_MS;

      if (mutationDebounceTimer !== null) clearTimeout(mutationDebounceTimer);
      mutationDebounceTimer = setTimeout(() => {
        mutationDebounceTimer = null;
        if (pendingMutationBatch && sessionId) {
          const batchToScan = pendingMutationBatch;
          pendingMutationBatch = null;
          void rescanAffectedRegions(batchToScan);
        }
      }, rescanDelayMs);
    });
  }

  function stopMutationObserver(): void {
    mutationObserver?.disconnect();
    mutationObserver = null;
    pendingMutationBatch = null;
    if (mutationDebounceTimer !== null) {
      clearTimeout(mutationDebounceTimer);
      mutationDebounceTimer = null;
    }
  }

  startMutationObserver();
}

interface ScanSettings {
  enabledCategories: FindingCategory[];
  maxVisibleChars: number;
  maxNodeChars: number;
  maskPlaceholders: boolean;
  sessionTimeoutMs: number;
  confidenceThresholds?: Record<FindingCategory, number>;
  autoMaskSingleNames?: boolean;
  medicalDictionaryEnabled?: boolean;
  clinicMode?: import("../shared/types.js").ClinicMode;
  windowChars?: number;
  windowOverlapChars?: number;
  maxTotalWindows?: number;
}
