// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import {
  FIRST_NAMES, LAST_NAMES, MIDDLE_NAMES, MIDDLE_INITIALS,
  NAME_PREFIXES, NAME_SUFFIXES, PROFESSIONAL_CREDENTIALS, GENDER_INDICATORS,
} from "./nameDictionaries.js";

/**
 * Structured person-name parser ported from the GovernWorld Name Detection
 * Pack (name-detector.js).
 *
 * This is the pack's contribution that the extension's regex name detector
 * (detectors/names.ts, Item 6) does not provide: it splits a name string into
 * prefix / first / middle / last / suffix / credentials / gender / age / dob.
 * It is intentionally NOT a second span detector — the extension already
 * detects name spans via detectNames() — so nothing here is wired into
 * detect() and no existing detection behavior changes.
 */

const PREFIXES = NAME_PREFIXES;
const SUFFIXES = NAME_SUFFIXES;
const CREDENTIALS = PROFESSIONAL_CREDENTIALS;
const GENDER = GENDER_INDICATORS;

function norm(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s).trim().toUpperCase();
}

// Strip surrounding punctuation but keep internal hyphens, apostrophes, periods
function cleanToken(raw: string): string {
  return String(raw).replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9\u00C0-\u024F]+$/g, "");
}

function isPrefix(t: string): boolean {
  return PREFIXES.has(norm(t));
}
function isSuffix(t: string): boolean {
  return SUFFIXES.has(norm(t));
}
function isCredential(t: string): boolean {
  return CREDENTIALS.has(norm(t));
}
function isGenderIndicator(t: string): boolean {
  return GENDER.has(norm(t));
}
function isFirstName(t: string): boolean {
  return FIRST_NAMES.has(norm(t));
}
function isLastName(t: string): boolean {
  return LAST_NAMES.has(norm(t));
}
function isMiddleName(t: string): boolean {
  return MIDDLE_NAMES.has(norm(t));
}
function isMiddleInitial(t: string): boolean {
  const u = norm(t);
  return MIDDLE_INITIALS.has(u) || /^[A-Z]\.?$/.test(u);
}
function isSingleLetterInitial(t: string): boolean {
  return /^[A-Z]\.?$/.test(norm(t));
}

/** True when a single token is a dictionary first/middle/last name. */
export function isNameToken(t: string): boolean {
  return isFirstName(t) || isLastName(t) || isMiddleName(t) || isMiddleInitial(t);
}

/** True when a single whitespace-free token is a standalone name. */
export function isStandaloneName(text: string): boolean {
  if (text == null) return false;
  const t = String(text).trim();
  if (!t) return false;
  if (/\s/.test(t)) return false;
  const c = cleanToken(t);
  return isFirstName(c) || isLastName(c) || isMiddleName(c);
}

/* ---------- Age / DOB patterns ---------- */

const AGE_TAIL_TOKENS = new Set(["Y/O", "YO", "YEARS", "YEAR", "OLDS", "OLD"]);
const AGE_LABELS = new Set(["AGE", "AGED"]);

function looksLikeAgeNumber(t: string): boolean {
  return /^\d{1,3}$/.test(t);
}

function extractAgeFromToken(t: string): number | null {
  const m = t.match(/^(\d{1,3})$/);
  return m ? parseInt(m[1], 10) : null;
}

const DATE_RE = /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/;

function looksLikeDate(t: string): boolean {
  return DATE_RE.test(t);
}

function isDobMarker(t: string): boolean {
  const u = norm(t);
  return u === "DOB" || u === "DATE" || u === "BIRTH"
    || u.startsWith("DATEOFBIRTH") || u.startsWith("DATEOF") || u.startsWith("DATE ");
}

/* ---------- Tokenizer ---------- */

interface NameToken {
  raw: string;
  cleaned: string;
  norm: string;
  index: number;
}

function tokenize(text: string): NameToken[] {
  if (text == null) return [];
  const parts = String(text).match(/\S+/g) || [];
  let cursor = 0;
  return parts.map(raw => {
    const idx = String(text).indexOf(raw, cursor);
    cursor = idx + raw.length;
    return {
      raw,
      cleaned: cleanToken(raw),
      norm: norm(cleanToken(raw)),
      index: idx >= 0 ? idx : -1,
    };
  });
}

/* ---------- Core name parser ---------- */

export interface ParsedName {
  prefix: string | null;
  first: string | null;
  middle: string[];
  last: string | null;
  suffix: string | null;
  credentials: string[];
  gender: string | null;
  age: number | null;
  dob: string | null;
  rawName: string | null;
  rawInput: string;
  tokens: string[];
}

/**
 * Parse a single name string into its components.
 *
 * Returns null fields for anything not present; never throws.
 */
export function parseName(text: string): ParsedName {
  const result: ParsedName = {
    prefix: null,
    first: null,
    middle: [],
    last: null,
    suffix: null,
    credentials: [],
    gender: null,
    age: null,
    dob: null,
    rawName: null,
    rawInput: text,
    tokens: [],
  };

  const toks = tokenize(text);
  result.tokens = toks.map(t => t.cleaned);
  if (toks.length === 0) return result;

  let i = 0;
  let n = toks.length;

  // Prefix at start.
  if (i < n && isPrefix(toks[i].cleaned)) {
    result.prefix = toks[i].cleaned;
    i++;
  }

  // Trailing components consumed from the end.
  let j = n - 1;
  const trailingCredentials: string[] = [];
  let trailingSuffix: string | null = null;
  let capturedDOBDate: string | null = null;

  while (j >= i) {
    const t = toks[j];
    const u = t.norm;
    const cleaned = t.cleaned;

    if (looksLikeDate(cleaned)) {
      capturedDOBDate = cleaned;
      j--;
      continue;
    }

    if (isDobMarker(u)) {
      if (capturedDOBDate) result.dob = capturedDOBDate;
      capturedDOBDate = null;
      j--;
      continue;
    }

    if (isCredential(u)) {
      trailingCredentials.unshift(cleaned);
      j--;
      continue;
    }

    if (isSuffix(u) && trailingSuffix === null) {
      trailingSuffix = cleaned;
      j--;
      continue;
    }

    if (looksLikeAgeNumber(cleaned)) {
      result.age = parseInt(cleaned, 10);
      j--;
      continue;
    }

    if (j - 1 >= i && AGE_TAIL_TOKENS.has(u) && looksLikeAgeNumber(toks[j - 1].cleaned)) {
      result.age = parseInt(toks[j - 1].cleaned, 10);
      j = j - 2;
      continue;
    }

    if (AGE_LABELS.has(u) && j - 1 >= i && looksLikeAgeNumber(toks[j - 1].cleaned)) {
      result.age = parseInt(toks[j - 1].cleaned, 10);
      j = j - 2;
      continue;
    }

    break;
  }

  if (capturedDOBDate) result.dob = capturedDOBDate;

  result.credentials = trailingCredentials;
  result.suffix = trailingSuffix;

  const core = toks.slice(i, j + 1).map(t => t.cleaned);
  if (core.length === 0) {
    result.rawName = "";
    return result;
  }

  // Single-letter trailing token is gender only if it is a recognized gender
  // indicator (e.g. "Mary F. 65": age consumed, "F" remains -> gender).
  if (result.age != null && core.length >= 1) {
    const lastCore = core[core.length - 1];
    if (isGenderIndicator(lastCore)) {
      result.gender = lastCore;
      core.pop();
    }
  }

  if (result.gender == null && core.length >= 1) {
    const lastCore = core[core.length - 1];
    if (isGenderIndicator(lastCore)) {
      result.gender = lastCore;
      core.pop();
    }
  }

  if (core.length === 1) {
    const only = core[0];
    if (isLastName(only) && !isFirstName(only)) {
      result.last = only;
    } else {
      result.first = only;
    }
  } else if (core.length === 2) {
    result.first = core[0];
    result.last = core[1];
  } else {
    result.first = core[0];
    result.last = core[core.length - 1];
    result.middle = core.slice(1, -1);
  }

  result.rawName = core.join(" ");
  return result;
}
