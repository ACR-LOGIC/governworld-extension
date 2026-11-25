// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Sliding n-gram (1..4 words) phrase matcher over Bloom packs, keeping longest match.

import type { BloomFilter } from "./bloom.js";

export interface Token {
  raw: string;
  norm: string;
  start: number;
  end: number;
}

export interface PhraseHit {
  phrase: string;
  norm: string;
  start: number;
  end: number;
  tokenCount: number;
}

export function normalizePhrase(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenizeMedicalText(text: string): Token[] {
  const tokens: Token[] = [];
  // eslint-disable-next-line security/detect-unsafe-regex
  for (const m of text.matchAll(/[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?/g)) {
    if (m.index === undefined) continue;
    tokens.push({
      raw: m[0],
      norm: m[0].toLowerCase(),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return tokens;
}

/**
 * Slides 1..maxN token windows and checks `bloom.has(...)`, keeping the longest
 * non-overlapping match at each position.
 */
export function detectPhrases(text: string, bloom: BloomFilter, maxN = 4): PhraseHit[] {
  const tokens = tokenizeMedicalText(text);
  const hits: PhraseHit[] = [];
  let i = 0;
  while (i < tokens.length) {
    let matched: PhraseHit | null = null;
    const upper = Math.min(maxN, tokens.length - i);
    for (let n = upper; n >= 1; n--) {
      const slice = tokens.slice(i, i + n);
      // Only join contiguous/nearby tokens (within 3 chars of each other, e.g. spaces/hyphens)
      let contiguous = true;
      for (let k = 1; k < slice.length; k++) {
        // eslint-disable-next-line security/detect-object-injection
        if (slice[k].start - slice[k - 1].end > 3) {
          contiguous = false;
          break;
        }
      }
      if (!contiguous) continue;
      const norm = slice.map((t) => t.norm).join(" ");
      if (norm.length < 3) continue;
      if (bloom.has(norm)) {
        matched = {
          phrase: text.slice(slice[0].start, slice[slice.length - 1].end),
          norm,
          start: slice[0].start,
          end: slice[slice.length - 1].end,
          tokenCount: n,
        };
        break;
      }
    }
    if (matched) {
      hits.push(matched);
      i += matched.tokenCount;
    } else {
      i += 1;
    }
  }
  return hits;
}
