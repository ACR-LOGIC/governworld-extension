// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.

export interface UnicodeMapping {
  normalizedIndex: number;
  originalIndex: number;
}

export interface UnicodeNormalizationResult {
  original: string;
  normalized: string;
  mappings: UnicodeMapping[];
  changed: boolean;
}

const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/g;
const NBSP_RE = /\u00A0/g;
const MULTI_SPACE_RE = / {2,}/g;
/** Any Unicode decimal digit (full-width, Arabic-Indic, Devanagari, …). */
const FOREIGN_DIGIT_RE = /\p{Nd}/u;
/**
 * Start code points of the Unicode decimal-digit blocks (each runs 0–9).
 * Number() does not parse non-ASCII digits, so the fold is arithmetic.
 */
const DIGIT_BLOCK_STARTS = [
  0x0660, 0x06f0, 0x0966, 0x09e6, 0x0a66, 0x0ae6, 0x0b66, 0x0be6, 0x0c66,
  0x0ce6, 0x0d66, 0x0e50, 0x0ed0, 0x0f20, 0x1040, 0x1090, 0x17e0, 0x1810,
  0x1946, 0x19d0, 0x1a80, 0x1a90, 0x1b50, 0x1bb0, 0x1c40, 0x1c50, 0xa620,
  0xa8d0, 0xa900, 0xa9d0, 0xa9f0, 0xaa50, 0xabf0, 0xff10,
];

function foldDigit(code: number): string | null {
  for (const start of DIGIT_BLOCK_STARTS) {
    if (code >= start && code <= start + 9) return String(code - start);
  }
  return null;
}
/** Fast path: pure ASCII with no zero-width chars, NBSP, or double spaces. */
const NEEDS_NORMALIZATION_RE = /[\u200B-\u200D\uFEFF\u00A0]|[^\x00-\x7F]| {2}/;

export function normalizeUnicodeWithMapping(text: string): UnicodeNormalizationResult {
  if (!NEEDS_NORMALIZATION_RE.test(text)) {
    return { original: text, normalized: text, mappings: [], changed: false };
  }
  const mappings: UnicodeMapping[] = [];
  let normalized = "";
  let originalIndex = 0;
  let changed = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const code = char.codePointAt(0) ?? 0;

    // Fold foreign/compatibility digits to ASCII so obfuscated identifiers
    // (full-width, Arabic-Indic, …) still detect. 1:1, so offsets are preserved.
    if ((code < 0x30 || code > 0x39) && FOREIGN_DIGIT_RE.test(char)) {
      const folded = foldDigit(code);
      if (folded !== null) {
        normalized += folded;
        mappings.push({ normalizedIndex: normalized.length - 1, originalIndex });
        originalIndex++;
        changed = true;
        continue;
      }
      // Unrecognized Nd block: fall through and keep the char as-is.
    }

    if (ZERO_WIDTH_RE.test(char)) {
      changed = true;
      originalIndex++;
      continue;
    }

    if (NBSP_RE.test(char)) {
      normalized += " ";
      mappings.push({ normalizedIndex: normalized.length - 1, originalIndex });
      originalIndex++;
      changed = true;
      continue;
    }

    if (char === " " && normalized.endsWith(" ")) {
      changed = true;
      originalIndex++;
      continue;
    }

    normalized += char;
    mappings.push({ normalizedIndex: normalized.length - 1, originalIndex });
    originalIndex++;
  }

  return { original: text, normalized, mappings, changed };
}

export function mapNormalizedToOriginalOffset(mapping: UnicodeMapping[], normalizedOffset: number): number {
  if (mapping.length === 0) return Math.max(0, normalizedOffset);
  if (normalizedOffset <= 0) return mapping[0]?.originalIndex ?? 0;
  if (normalizedOffset >= mapping.length) return mapping[mapping.length - 1]?.originalIndex ?? 0;
  return mapping[normalizedOffset]?.originalIndex ?? normalizedOffset;
}

export function mapOriginalToNormalizedOffset(mapping: UnicodeMapping[], originalOffset: number): number {
  if (mapping.length === 0) return originalOffset;
  for (let i = 0; i < mapping.length; i++) {
    if (mapping[i].originalIndex === originalOffset) {
      return mapping[i].normalizedIndex;
    }
  }
  return originalOffset;
}
