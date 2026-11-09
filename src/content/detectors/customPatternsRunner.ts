// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import type { CustomPattern } from "../../shared/customPatterns.js";
import { isSafeRegex } from "../../shared/wizardAnalyzer.js";
import { CoverageTelemetry, PerformanceTelemetry } from "../../shared/telemetry.js";
import type { RawMatch } from "../detect.js";

/**
 * Chunked custom-pattern scanner with offset preservation and honest
 * partial-coverage reporting (Priority 0 — Item 2 & Priority 1 — Item 7).
 */
export const CHUNK = 50_000;
export const OVERLAP = 512;
export const CUSTOM_SCAN_CHUNK_SIZE = CHUNK;
export const CUSTOM_SCAN_OVERLAP = OVERLAP;
export const DEFAULT_CUSTOM_PATTERN_BUDGET_MS = 200;
export const MAX_CUSTOM_SCAN_CHARS = 2_000_000;
export const MAX_MATCHES_PER_PATTERN = 1_000;

export interface CustomPatternScanOptions {
  budgetMs?: number;
  chunkSize?: number;
  overlap?: number;
  maxScanChars?: number;
  maxMatchesPerPattern?: number;
}

export interface CustomPatternScanResult {
  matches: RawMatch[];
  partiallyScanned: boolean;
  scannedChars: number;
  totalChars: number;
}

/**
 * Build chunks of `[start, end)` over `text` with `chunkSize` and `overlap`.
 */
export function buildTextChunks(
  textLength: number,
  chunkSize: number = CHUNK,
  overlap: number = OVERLAP,
): Array<{ start: number; end: number }> {
  if (textLength <= 0) return [];
  const safeChunk = Math.max(1024, chunkSize);
  const safeOverlap = Math.max(0, Math.min(overlap, Math.floor(safeChunk / 2)));
  if (textLength <= safeChunk) {
    return [{ start: 0, end: textLength }];
  }
  const chunks: Array<{ start: number; end: number }> = [];
  const step = safeChunk - safeOverlap;
  for (let start = 0; start < textLength; start += step) {
    const end = Math.min(textLength, start + safeChunk);
    chunks.push({ start, end });
    if (end >= textLength) break;
  }
  return chunks;
}

export function runCustomPatternsWithStatus(
  text: string,
  patterns: CustomPattern[],
  options?: CustomPatternScanOptions,
): CustomPatternScanResult {
  const totalChars = typeof text === "string" ? text.length : 0;
  if (!text || !Array.isArray(patterns) || patterns.length === 0) {
    return {
      matches: [],
      partiallyScanned: false,
      scannedChars: totalChars,
      totalChars,
    };
  }

  const budgetMs = options?.budgetMs ?? DEFAULT_CUSTOM_PATTERN_BUDGET_MS;
  const chunkSize = options?.chunkSize ?? CHUNK;
  const overlap = options?.overlap ?? OVERLAP;
  const maxScanChars = options?.maxScanChars ?? MAX_CUSTOM_SCAN_CHARS;
  const maxMatchesPerPattern = options?.maxMatchesPerPattern ?? MAX_MATCHES_PER_PATTERN;

  const effectiveLength = Math.min(totalChars, maxScanChars);
  let partiallyScanned = totalChars > maxScanChars;

  const chunks = buildTextChunks(effectiveLength, chunkSize, overlap);
  const matches: RawMatch[] = [];
  const seenKeys = new Set<string>();
  const startTime = Date.now();
  let maxScannedOffset = 0;

  for (const pat of patterns) {
    if (Date.now() - startTime > budgetMs) {
      partiallyScanned = true;
      PerformanceTelemetry.record("regex_budget_exceeded", {
        patternId: pat.id ?? pat.name ?? "custom",
        elapsedMs: Date.now() - startTime,
        budgetMs,
      });
      break;
    }

    // Location-only rules have no regex; they are handled by a separate
    // location pass and never execute here.
    if (!pat.pattern) continue;
    const patFlags = pat.flags ?? "gi";
    const patSource = pat.pattern.replace(/^\^/, "").replace(/\$$/, "");
    if (!isSafeRegex(patSource, patFlags)) continue;

    let re: RegExp;
    try {
      const effFlags = patFlags.includes("g") ? patFlags : `${patFlags}g`;
      const flags = effFlags.includes("d") ? effFlags : `${effFlags}d`;
      try {
        re = new RegExp(patSource, flags);
      } catch {
        re = new RegExp(patSource, effFlags);
      }
    } catch {
      continue;
    }

    let patternMatchCount = 0;

    for (const chunk of chunks) {
      if (Date.now() - startTime > budgetMs) {
        partiallyScanned = true;
        PerformanceTelemetry.record("regex_budget_exceeded", {
          patternId: pat.id ?? pat.name ?? "custom",
          elapsedMs: Date.now() - startTime,
          budgetMs,
        });
        break;
      }

      const chunkText = text.slice(chunk.start, chunk.end);
      re.lastIndex = 0;
      let m: RegExpExecArray | null;

      try {
        while ((m = re.exec(chunkText)) !== null) {
          if (Date.now() - startTime > budgetMs) {
            partiallyScanned = true;
            break;
          }
          if (patternMatchCount >= maxMatchesPerPattern) {
            partiallyScanned = true;
            break;
          }
          if (!m[0]) {
            re.lastIndex += 1;
            continue;
          }

          let value = m[0];
          let localStart = m.index;
          let localEnd = m.index + m[0].length;

          if (pat.captureGroup !== undefined && pat.captureGroup > 0) {
            const captured = m[pat.captureGroup];
            if (captured === undefined) continue;
            value = captured;
            const indices = (m as unknown as { indices?: Array<[number, number] | undefined> }).indices?.[
              pat.captureGroup
            ];
            if (
              Array.isArray(indices) &&
              typeof indices[0] === "number" &&
              typeof indices[1] === "number"
            ) {
              localStart = indices[0];
              localEnd = indices[1];
            } else {
              const relOffset = m[0].indexOf(captured);
              localStart = m.index + (relOffset >= 0 ? relOffset : 0);
              localEnd = localStart + captured.length;
            }
          }

          if (pat.minLength !== undefined && value.length < pat.minLength) continue;
          if (pat.maxLength !== undefined && value.length > pat.maxLength) continue;

          const globalStart = chunk.start + localStart;
          const globalEnd = chunk.start + localEnd;

          if (Array.isArray(pat.contextCues) && pat.contextCues.length > 0) {
            const windowStart = Math.max(0, globalStart - 120);
            const windowEnd = Math.min(text.length, globalEnd + 120);
            const windowText = text.slice(windowStart, windowEnd).toLowerCase();
            const hasCue = pat.contextCues.some(
              (cue) => cue && windowText.includes(cue.toLowerCase()),
            );
            if (!hasCue) continue;
          }

          const dedupKey = `${pat.category}:${globalStart}:${globalEnd}:${value}`;
          if (seenKeys.has(dedupKey)) continue;
          seenKeys.add(dedupKey);
          patternMatchCount += 1;

          matches.push({
            category: pat.category,
            confidence: pat.confidence,
            value,
            start: globalStart,
            end: globalEnd,
          });
        }
      } catch {
        // Ignore individual pattern runtime failure and continue
      }

      maxScannedOffset = Math.max(maxScannedOffset, chunk.end);
    }
  }

  if (partiallyScanned) {
    CoverageTelemetry.record("custom_patterns_partially_scanned", {
      totalChars,
      scannedChars: maxScannedOffset,
      matchCount: matches.length,
    });
  }

  return {
    matches,
    partiallyScanned,
    scannedChars: partiallyScanned ? maxScannedOffset : totalChars,
    totalChars,
  };
}

export function runCustomPatterns(
  text: string,
  patterns: CustomPattern[],
  options?: CustomPatternScanOptions,
): RawMatch[] {
  return runCustomPatternsWithStatus(text, patterns, options).matches;
}
