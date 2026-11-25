// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Fuzzy drug matching: gated Damerau-Levenshtein + Soundex + SymSpell deletion index.

import type { BloomFilter } from "./bloom.js";

const DRUG_SUFFIXES = [
  "pril", "sartan", "statin", "olol", "mycin", "cillin", "floxacin",
  "prazole", "dipine", "formin", "gliptin", "gliflozin", "mab", "nib", "zepam",
];

// eslint-disable-next-line security/detect-unsafe-regex
const CONTEXT_CUES = /\b(?:\d+(?:\.\d+)?\s*(?:mg|mcg|ml)|mg|mcg|ml|bid|tid|qid|taking|prescribed|twice\s+daily|once\s+daily|daily)\b/i;

export function isDrugLike(token: string, nearbyText = ""): boolean {
  const lower = token.toLowerCase();
  if (lower.length < 5) return false;
  if (DRUG_SUFFIXES.some((s) => lower.endsWith(s))) return true;
  if (CONTEXT_CUES.test(nearbyText)) return true;
  return false;
}

export function damerau(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const d: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  // eslint-disable-next-line security/detect-object-injection
  for (let i = 0; i <= m; i++) d[i][0] = i;
  // eslint-disable-next-line security/detect-object-injection
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      // eslint-disable-next-line security/detect-object-injection
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        // eslint-disable-next-line security/detect-object-injection
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + cost);
      }
    }
  }
  // eslint-disable-next-line security/detect-object-injection
  return d[m][n];
}

export function soundex(s: string): string {
  const w = s.toUpperCase().replace(/[^A-Z]/g, "");
  if (!w) return "";
  const map: Record<string, string> = {
    B: "1", F: "1", P: "1", V: "1",
    C: "2", G: "2", J: "2", K: "2", Q: "2", S: "2", X: "2", Z: "2",
    D: "3", T: "3",
    L: "4",
    M: "5", N: "5",
    R: "6",
  };
  let out = w[0];
  let prev = map[w[0]] || "";
  for (let i = 1; i < w.length && out.length < 4; i++) {
    // eslint-disable-next-line security/detect-object-injection
    const code = map[w[i]] || "";
    if (code && code !== prev) out += code;
    prev = code;
  }
  return out.padEnd(4, "0");
}

export function deletionsUpTo2(word: string, maxDist = 2): Map<string, number> {
  const result = new Map<string, number>();
  result.set(word, 0);
  const queue: [string, number][] = [[word, 0]];
  while (queue.length > 0) {
    const [cur, dist] = queue.shift()!;
    if (dist >= maxDist || cur.length <= 2) continue;
    for (let i = 0; i < cur.length; i++) {
      const del = cur.slice(0, i) + cur.slice(i + 1);
      const nextDist = dist + 1;
      const existing = result.get(del);
      if (existing === undefined || nextDist < existing) {
        result.set(del, nextDist);
        queue.push([del, nextDist]);
      }
    }
  }
  return result;
}

export interface FuzzyDrugMatch {
  suggestion: string;
  distance: number;
  phoneticMatch: boolean;
}

export function fuzzyFindDrugSymSpell(
  token: string,
  symspellIndex: Record<string, string | string[]> | null,
  drugsBloom: BloomFilter | null
): FuzzyDrugMatch | null {
  const lower = token.toLowerCase();
  if (lower.length < 5) return null;

  if (drugsBloom && drugsBloom.has(lower)) {
    return { suggestion: lower, distance: 0, phoneticMatch: true };
  }

  if (!symspellIndex) return null;

  const dels = deletionsUpTo2(lower, lower.length >= 8 ? 2 : 1);
  let best: FuzzyDrugMatch | null = null;
  const inputSoundex = soundex(lower);

  for (const [del] of dels) {
    // eslint-disable-next-line security/detect-object-injection
    const entry = symspellIndex[del];
    if (!entry) continue;
    const candidates = Array.isArray(entry) ? entry : [entry];
    for (const cand of candidates) {
      if (drugsBloom && !drugsBloom.has(cand)) continue;
      const dist = damerau(lower, cand);
      if (dist > (lower.length >= 8 ? 2 : 1)) continue;
      const phoneticMatch = soundex(cand) === inputSoundex;
      if (!best || dist < best.distance || (dist === best.distance && phoneticMatch && !best.phoneticMatch)) {
        best = { suggestion: cand, distance: dist, phoneticMatch };
      }
    }
  }
  return best;
}
