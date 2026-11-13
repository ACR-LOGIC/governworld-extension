// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import type { FindingCategory } from "../shared/types.js";
import {
  isValidSsn,
  isValidDea,
  isValidMbi,
  isValidNpi,
  isValidLuhn,
  isNonProviderBound,
  isValidCanadianSin,
  isValidNhsNumber,
  isValidAadhaar,
  isValidPanIndia,
  isValidAustralianTfn,
  isValidCpf,
  isValidItin,
  isValidIban,
  isValidPassport,
  isValidMrz,
} from "../validators/index.js";

/**
 * Local, deterministic detectors for visible-page text. These run entirely
 * on-device and are intentionally conservative: ambiguous matches are surfaced
 * as "possible sensitive data", never as definitive clinical/legal findings.
 *
 * Hardened identifier validity (SSN, DEA, MBI, NPI checksums, Luhn, international
 * tax/health IDs) is evaluated by the shared validator rules so detection can
 * never drift between the gateway and the on-device scanner.
 */

import type { CustomPattern } from "../shared/customPatterns.js";
import {
  normalizeUnicodeWithMapping,
  mapNormalizedToOriginalOffset,
} from "./normalization/unicode.js";
import { detectNames } from "./detectors/names.js";
import type { ParsedName } from "./detectors/nameParser.js";
import { detectPhones } from "./detectors/internationalPhones.js";
import {
  CHUNK,
  OVERLAP,
  CUSTOM_SCAN_CHUNK_SIZE,
  CUSTOM_SCAN_OVERLAP,
  runCustomPatterns,
  runCustomPatternsWithStatus,
  type CustomPatternScanOptions,
  type CustomPatternScanResult,
} from "./detectors/customPatternsRunner.js";

export {
  CHUNK,
  OVERLAP,
  CUSTOM_SCAN_CHUNK_SIZE,
  CUSTOM_SCAN_OVERLAP,
  runCustomPatterns,
  runCustomPatternsWithStatus,
  type CustomPatternScanOptions,
  type CustomPatternScanResult,
};

export interface RawMatch {
  category: FindingCategory;
  confidence: number; // 0..1
  value: string;
  start: number;
  end: number;
  entityType?: string;
  /** Structured name components (prefix / first / middle / last / suffix /
   * credentials / gender / age / dob), attached only to possible_name matches
   * by enrichPossibleNames(). Detection behavior is unchanged. */
  parsedName?: ParsedName;
}

const CATEGORY_PRIORITY: FindingCategory[] = [
  "payment_card",
  "ssn",
  "bank_account",
  "canadian_sin",
  "uk_nhs",
  "aadhaar",
  "pan_india",
  "australian_tfn",
  "cpf",
  "npi",
  "dea",
  "mbi",
  "secrets",
  "ip_address",
  "email",
  "phone",
  "username",
  "dob",
  "financial",
  "medical_record_number",
  "member_id",
  "address",
  "custom",
  "possible_name",
];

function priorityOf(category: FindingCategory): number {
  if (category === "custom") {
    return CATEGORY_PRIORITY.indexOf("secrets");
  }
  return CATEGORY_PRIORITY.indexOf(category);
}

/** Replace a value with a masked preview that never reveals the full value. */
export function maskValue(category: FindingCategory, value: string): string {
  switch (category) {
    case "email": {
      const at = value.indexOf("@");
      if (at <= 0) return value.replace(/./g, "*");
      const local = value.slice(0, at);
      const domain = value.slice(at + 1);
      const head = local[0] ?? "";
      return `${head}***@${domain}`;
    }
    case "phone": {
      const digits = value.replace(/\D/g, "").replace(/^1/, "");
      if (digits.length < 4) return value.replace(/./g, "*");
      return `***-***-${digits.slice(-4)}`;
    }
    case "ssn": {
      const digits = value.replace(/\D/g, "");
      if (digits.length < 4) return value.replace(/./g, "*");
      return `***-**-${digits.slice(-4)}`;
    }
    case "canadian_sin": {
      const digits = value.replace(/\D/g, "");
      if (digits.length < 3) return value.replace(/./g, "*");
      return `***-***-${digits.slice(-3)}`;
    }
    case "uk_nhs": {
      const digits = value.replace(/\D/g, "");
      if (digits.length < 4) return value.replace(/./g, "*");
      return `***-***-${digits.slice(-4)}`;
    }
    case "aadhaar": {
      const digits = value.replace(/\D/g, "");
      if (digits.length < 4) return value.replace(/./g, "*");
      return `****-****-${digits.slice(-4)}`;
    }
    case "pan_india": {
      const clean = value.replace(/[\s-]/g, "").toUpperCase();
      if (clean.length < 5) return value.replace(/./g, "*");
      return `*****${clean.slice(5)}`;
    }
    case "australian_tfn": {
      const digits = value.replace(/\D/g, "");
      if (digits.length < 3) return value.replace(/./g, "*");
      return `***-***-${digits.slice(-3)}`;
    }
    case "cpf": {
      const digits = value.replace(/\D/g, "");
      if (digits.length < 2) return value.replace(/./g, "*");
      return `***.***.***-${digits.slice(-2)}`;
    }
    case "payment_card": {
      const digits = value.replace(/\D/g, "");
      // Only a real card number keeps its last four digits. A labeled CVV or
      // expiry is also payment_card, and revealing "the last four" of a
      // four-digit value would show the whole thing.
      if (digits.length < 13) return value.replace(/./g, "*");
      return `************${digits.slice(-4)}`;
    }
    case "bank_account": {
      const digits = value.replace(/\D/g, "");
      // A four-digit account is common; showing "the last four" would show the
      // whole number, so short accounts are masked completely.
      if (digits.length <= 4) return value.replace(/./g, "*");
      return `****${digits.slice(-4)}`;
    }
    case "ip_address":
    case "financial":
      return value.replace(/\S/g, "*");
    case "username": {
      const head = value[0] ?? "";
      return head ? `${head}***` : "***";
    }
    case "npi": {
      const digits = value.replace(/\D/g, "");
      if (digits.length < 4) return value.replace(/./g, "*");
      return `******-${digits.slice(-4)}`;
    }
    case "dea":
      return "*********";
    case "mbi": {
      const compact = value.replace(/\D/g, "");
      if (compact.length < 4) return value.replace(/./g, "*");
      return `*******${compact.slice(-4)}`;
    }
    case "dob":
      return "**/**/****";
    case "secrets": {
      // Keep only the first 2 characters of a secret visible so the masked
      // preview stays meaningful (e.g. "sk***"), never the raw value.
      const head = value[0] ?? "";
      return `${head}***`;
    }
    case "possible_name":
      return "********";
    case "custom":
    case "medical_record_number":
    case "member_id":
    case "address":
    default:
      return value.replace(/\S/g, "*");
  }
}

/** Masked, minimized context snippet (~3 tokens around the match). */
export function maskContext(context: string): string {
  const tokens = context.trim().split(/\s+/).filter(Boolean);
  return tokens.map(() => "*").join(" ");
}

/**
 * Short uppercase label shown inside a mask block when mask placeholders are
 * enabled (e.g. "[SSN]", "[API KEY]"). Pure + exported for tests; the content
 * script renders it on the overlay block.
 */
export function placeholderLabelFor(category: FindingCategory): string {
  switch (category) {
    case "email": return "EMAIL";
    case "phone": return "PHONE";
    case "ssn": return "SSN";
    case "dob": return "DOB";
    case "medical_record_number": return "MRN";
    case "member_id": return "MEMBER ID";
    case "npi": return "NPI";
    case "dea": return "DEA";
    case "mbi": return "MBI";
    case "address": return "ADDRESS";
    case "payment_card": return "CARD";
    case "secrets": return "API KEY";
    case "possible_name": return "NAME";
    case "custom": return "CUSTOM";
    case "canadian_sin": return "SIN";
    case "uk_nhs": return "NHS";
    case "aadhaar": return "AADHAAR";
    case "pan_india": return "PAN";
    case "australian_tfn": return "TFN";
    case "cpf": return "CPF";
    case "ip_address": return "IP ADDRESS";
    case "username": return "USERNAME";
    case "bank_account": return "BANK ACCT";
    case "financial": return "FINANCIAL";
  }
}

/**
 * Email matcher.
 *
 * The local part is matched lazily against a bounded run of characters that
 * must be followed by `@`, rather than as an unbounded `[...]+@`.
 *
 * The unbounded form is polynomial, not exponential, but that is still a denial
 * of service in a content script: `\b[...]+@` starts a scan at every word
 * boundary (every `.`, `-`, `/`) and backtracks the whole remaining run looking
 * for an `@` that is not there. Measured on this machine against a run of
 * in-class characters with no `@`: 25k -> 0.9s, 50k -> 3.8s, 100k -> 15s, 250k
 * -> 94s. A `<pre>` block of minified JavaScript or a `data:` URI is enough to
 * produce one of those, and `detect()` is called on unsized page and OCR text.
 *
 * Two changes remove the cost. The local part is capped at the 64 characters
 * RFC 5321 allows, which bounds the backtracking per attempt, and the whole
 * detector returns immediately when the text contains no `@` at all, which is
 * the case for the overwhelming majority of nodes.
 */
const EMAIL_RE = /\b[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]{1,64}(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]{1,63}){0,12}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?){0,12}/g;

function detectEmails(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  if (!text.includes("@")) return out;
  for (const m of text.matchAll(EMAIL_RE)) {
    const raw = m[0];
    let end = m.index + raw.length;
    let value = raw;
    while (value.length > 0 && /[.,;:!?()[\]]$/.test(value)) {
      value = value.slice(0, -1);
      end -= 1;
    }
    if (!value.includes(".")) continue;
    if (!/[A-Za-z]/.test(value)) continue;
    out.push({ category: "email", confidence: 0.92, value, start: m.index, end });
  }
  return out;
}

/** Contents of the dash character class, without the enclosing brackets. */
const DASH_CHARS =
  "\\u002D\\u058A\\u05BE\\u1400\\u1806\\u2010-\\u2015\\u2212\\u2E17\\u2E1A\\u2E3A\\u2E3B\\u2E40\\u301C\\u3030\\u30A0\\uFE31\\uFE32\\uFE58\\uFE63\\uFF0D";
/**
 * A bracketed dash class. Kept separate from DASH_CHARS on purpose: interpolating
 * the bare contents into a pattern without brackets parses as literal text
 * followed by a stray range, which silently matches nothing at all.
 */
const DASH = `[${DASH_CHARS}]`;
/**
 * A bracketed dash-or-space class, for patterns accepting either.
 *
 * Space is deliberately NOT in the SSN separator set, even though it is in SEP.
 * Unlike a dash, a space is not visually unambiguous: "123 45 6789" appears in
 * dense numeric text for reasons that have nothing to do with an SSN, and
 * accepting it would trade a rare miss for a routine false positive.
 */
const SEP = `[\\s${DASH_CHARS}]`;

// `(?<![\dA-Za-z])` and `(?![\dA-Za-z])` are used rather than `\b` on purpose.
// A non-breaking space and several of the dashes are not word characters, so
// `\b` after a group ending in one of them does not assert a boundary and the
// match is rejected outright.
//
// Every Unicode dash variant is accepted. This is not cosmetic: a probe found
// that `219‑09‑9999` written with U+2011, and the same value with U+2013
// EN DASH, U+2014 EM DASH or U+2212 MINUS SIGN, were each missed entirely, as
// were the phone and payment-card forms. Word processors and PDF text layers
// emit these characters routinely, so a document containing a real SSN written
// with an en dash was passing as clean.
//
// The asymmetry is deliberate. A missed identifier is an unprotected disclosure
// the user never sees; a false positive is one over-redacted span they can
// notice. For a tool people rely on to decide what is safe to share, recall is
// the property worth protecting, and these characters are visually
// indistinguishable from a hyphen to whoever is reading the document.
const SSN_DASH_RE = new RegExp(
  `(?<![\\dA-Za-z])(?!000|666|9\\d\\d)\\d{3}${DASH}(?!00)\\d{2}${DASH}(?!0000)\\d{4}(?![\\dA-Za-z])`,
  "g"
);
const SSN_BARE_RE = /\b(?!000|666|9\d\d)\d{3}(?!00)\d{2}(?!0000)\d{4}\b/g;
// "social" on its own is an ordinary English word, so any page containing the
// word next to a 9-digit number produced an SSN — "Join our social 123456789
// community" was enough. The full phrase is required.
const SSN_CUE_RE = /\b(?:ssn|social\s+security(?:\s*(?:number|no|#))?)\b/i;
const ITIN_CUE_RE = /\b(?:itin|individual\s+taxpayer(?:\s+identification)?(?:\s*(?:number|no|#))?)\b/i;
const ITIN_RE = /\b9\d{2}[- ]\d{2}[- ]\d{4}\b|\b9\d{8}\b/g;

function detectSsns(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const m of text.matchAll(SSN_DASH_RE)) {
    if (!isValidSsn(m[0])) continue;
    out.push({ category: "ssn", confidence: 0.93, value: m[0], start: m.index, end: m.index + m[0].length });
  }
  for (const m of text.matchAll(SSN_BARE_RE)) {
    if (!isValidSsn(m[0])) continue;
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    if (!SSN_CUE_RE.test(before)) continue;
    out.push({ category: "ssn", confidence: 0.85, value: m[0], start: m.index, end: m.index + m[0].length });
  }
  for (const m of text.matchAll(ITIN_RE)) {
    if (!isValidItin(m[0])) continue;
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    if (ITIN_CUE_RE.test(before) || SSN_CUE_RE.test(before)) {
      out.push({ category: "ssn", confidence: 0.88, value: m[0], start: m.index, end: m.index + m[0].length });
    }
  }
  return out;
}

// Canadian SIN
const CANADIAN_SIN_DASH_RE = /\b\d{3}[ -]\d{3}[ -]\d{3}\b/g;
const CANADIAN_SIN_BARE_RE = /\b\d{9}\b/g;
const CANADIAN_SIN_CUE_RE = /\b(?:sin|social\s+insurance(?:\s*(?:number|no|#))?|nas|num[ée]ro\s+d['’]assurance\s+sociale)\b/i;

function isSinLuhnValid(digits: string): boolean {
  if (digits.length !== 9) return false;
  let sum = 0;
  let shouldDouble = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = digits.charCodeAt(i) - 48;
    if (digit < 0 || digit > 9) return false;
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

function detectCanadianSins(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const m of text.matchAll(CANADIAN_SIN_DASH_RE)) {
    const context = text.slice(Math.max(0, m.index - 120), Math.min(text.length, m.index + m[0].length + 60));
    const hasCue = CANADIAN_SIN_CUE_RE.test(context);
    const digits = m[0].replace(/\D/g, "");
    if (!isValidCanadianSin(m[0]) && !(hasCue && isSinLuhnValid(digits))) continue;
    out.push({
      category: "canadian_sin",
      confidence: hasCue ? 0.95 : 0.90,
      value: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  for (const m of text.matchAll(CANADIAN_SIN_BARE_RE)) {
    const context = text.slice(Math.max(0, m.index - 120), Math.min(text.length, m.index + m[0].length + 60));
    const hasCue = CANADIAN_SIN_CUE_RE.test(context);
    const digits = m[0].replace(/\D/g, "");
    if (!isValidCanadianSin(m[0]) && !(hasCue && isSinLuhnValid(digits))) continue;
    if (!hasCue) continue;
    out.push({
      category: "canadian_sin",
      confidence: 0.85,
      value: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

// UK NHS Number
const UK_NHS_FORMATTED_RE = /\b\d{3}[ -]\d{3}[ -]\d{4}\b/g;
const UK_NHS_BARE_RE = /\b\d{10}\b/g;
const UK_NHS_CUE_RE = /\b(?:nhs(?:\s*(?:number|no|#))?|national\s+health\s+service)\b/i;

function detectUkNhs(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const m of text.matchAll(UK_NHS_FORMATTED_RE)) {
    if (!isValidNhsNumber(m[0])) continue;
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    const hasCue = UK_NHS_CUE_RE.test(before);
    out.push({
      category: "uk_nhs",
      confidence: hasCue ? 0.95 : 0.90,
      value: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  for (const m of text.matchAll(UK_NHS_BARE_RE)) {
    if (!isValidNhsNumber(m[0])) continue;
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    if (!UK_NHS_CUE_RE.test(before)) continue;
    out.push({
      category: "uk_nhs",
      confidence: 0.85,
      value: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

// Indian Aadhaar
const AADHAAR_FORMATTED_RE = /\b[2-9]\d{3}[ -]\d{4}[ -]\d{4}\b/g;
const AADHAAR_BARE_RE = /\b[2-9]\d{11}\b/g;
const AADHAAR_CUE_RE = /\b(?:aadhaar|aadhar|uidai)(?:\s*(?:number|no|#))?\b/i;

function detectAadhaar(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const m of text.matchAll(AADHAAR_FORMATTED_RE)) {
    if (!isValidAadhaar(m[0])) continue;
    const context = text.slice(Math.max(0, m.index - 120), Math.min(text.length, m.index + m[0].length + 60));
    const hasCue = AADHAAR_CUE_RE.test(context);
    out.push({
      category: "aadhaar",
      confidence: hasCue ? 0.95 : 0.92,
      value: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  for (const m of text.matchAll(AADHAAR_BARE_RE)) {
    const context = text.slice(Math.max(0, m.index - 120), Math.min(text.length, m.index + m[0].length + 60));
    const hasCue = AADHAAR_CUE_RE.test(context);
    if (!isValidAadhaar(m[0]) && !(hasCue && /^[2-9]\d{11}$/.test(m[0]))) continue;
    if (!hasCue) continue;
    out.push({
      category: "aadhaar",
      confidence: 0.85,
      value: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

// Indian PAN. `isValidPanIndia` uppercases its input, so matching case-insensitively
// costs nothing and catches a PAN that OCR or a PDF text layer rendered in lowercase.
const PAN_INDIA_RE = /\b[A-Za-z]{5}\d{4}[A-Za-z]\b/g;
const PAN_INDIA_CUE_RE = /\b(?:pan(?:\s*(?:card|number|no|#))?|permanent\s+account\s+number)\b/i;

function detectPanIndia(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const m of text.matchAll(PAN_INDIA_RE)) {
    const context = text.slice(Math.max(0, m.index - 120), Math.min(text.length, m.index + m[0].length + 60));
    const hasCue = PAN_INDIA_CUE_RE.test(context);
    if (!isValidPanIndia(m[0]) && !(hasCue && /^[A-Za-z]{5}\d{4}[A-Za-z]$/.test(m[0]))) continue;
    out.push({
      category: "pan_india",
      confidence: hasCue ? 0.95 : 0.90,
      value: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

// Australian TFN (Tax File Number)
const AUSTRALIAN_TFN_FORMATTED_RE = /\b\d{3}[ -]\d{3}[ -]\d{2,3}\b/g;
const AUSTRALIAN_TFN_BARE_RE = /\b\d{8,9}\b/g;
const AUSTRALIAN_TFN_CUE_RE = /\b(?:tfn|tax\s+file\s+number)\b/i;

function detectAustralianTfn(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const m of text.matchAll(AUSTRALIAN_TFN_FORMATTED_RE)) {
    if (!isValidAustralianTfn(m[0])) continue;
    const context = text.slice(Math.max(0, m.index - 120), Math.min(text.length, m.index + m[0].length + 60));
    const hasCue = AUSTRALIAN_TFN_CUE_RE.test(context);
    out.push({
      category: "australian_tfn",
      confidence: hasCue ? 0.95 : 0.88,
      value: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  for (const m of text.matchAll(AUSTRALIAN_TFN_BARE_RE)) {
    if (!isValidAustralianTfn(m[0])) continue;
    const context = text.slice(Math.max(0, m.index - 120), Math.min(text.length, m.index + m[0].length + 60));
    if (!AUSTRALIAN_TFN_CUE_RE.test(context)) continue;
    out.push({
      category: "australian_tfn",
      confidence: 0.85,
      value: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

// Brazilian CPF
const CPF_FORMATTED_RE = /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g;
const CPF_BARE_RE = /\b\d{11}\b/g;
const CPF_CUE_RE = /\b(?:cpf|cadastro\s+de\s+pessoas?\s+f[íi]sicas?)\b/i;

function detectCpf(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const m of text.matchAll(CPF_FORMATTED_RE)) {
    if (!isValidCpf(m[0])) continue;
    const context = text.slice(Math.max(0, m.index - 120), Math.min(text.length, m.index + m[0].length + 60));
    const hasCue = CPF_CUE_RE.test(context);
    out.push({
      category: "cpf",
      confidence: hasCue ? 0.95 : 0.92,
      value: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  for (const m of text.matchAll(CPF_BARE_RE)) {
    if (!isValidCpf(m[0])) continue;
    const context = text.slice(Math.max(0, m.index - 120), Math.min(text.length, m.index + m[0].length + 60));
    if (!CPF_CUE_RE.test(context)) continue;
    out.push({
      category: "cpf",
      confidence: 0.85,
      value: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Network, account and compensation identifiers.
//
// These four categories were added after a synthetic disclosure test pack
// showed a documentation-range IP, a labeled login, an ABA routing number and a
// labeled salary surviving a scan. Each detector stays label-bound (or range-
// bound, for IPs) because their raw shapes are ordinary text: every dotted
// version string looks like IPv4, every 9-digit number can look like a routing
// number, and a bare currency amount is a price, not personal data.

const IPV4_RE = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;
const IPV6_RE = /(?<![\w:])(?:[0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{1,4}){0,4}(?![\w:])/g;
const IP_CUE_RE =
  /\b(?:ip(?:\s*addr(?:ess)?)?|ipv4|ipv6|client\s+ip|remote\s+ip|source\s+ip|server\s+ip|host\s+addr(?:ess)?)\b/i;
const VERSION_CUE_RE = /\b(?:v|version|ver\.?)\s*$/i;

function parseIpv4(value: string): number[] | null {
  const parts = value.split(".").map(Number);
  if (parts.length !== 4) return null;
  if (parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return parts;
}

/** Ranges that are not a host's public address: private, loopback, CGNAT,
 * link-local, benchmarking and the RFC 5737 documentation blocks. */
function isNonPublicIpv4(parts: number[]): boolean {
  const [a, b, c] = parts;
  if (a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return false;
}

function detectIpAddresses(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const m of text.matchAll(IPV4_RE)) {
    const parts = parseIpv4(m[0]);
    if (!parts) continue;
    const [a] = parts;
    // 0.0.0.0/8 is "this network", 224/4 is multicast and 255.255.255.255 is
    // broadcast: none identifies a host.
    if (a === 0 || a >= 224) continue;
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    // "v1.2.3.4" is a version, not an address. A bare public IPv4 without a
    // label is not reported either, because dotted section numbers are common
    // and a real public address in a log almost always sits beside an IP cue.
    if (VERSION_CUE_RE.test(before)) continue;
    const hasCue = IP_CUE_RE.test(before);
    const nonPublic = isNonPublicIpv4(parts);
    if (!hasCue && !nonPublic) continue;
    out.push({
      category: "ip_address",
      confidence: hasCue ? 0.9 : 0.8,
      value: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  for (const m of text.matchAll(IPV6_RE)) {
    const value = m[0];
    // A clock ("12:30:45") is colon-separated too. Require either compression
    // ("::") or a hex letter, and always require an IP cue.
    if (!value.includes("::") && !/[A-Fa-f]/.test(value)) continue;
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    if (!IP_CUE_RE.test(before)) continue;
    out.push({
      category: "ip_address",
      confidence: 0.88,
      value,
      start: m.index,
      end: m.index + value.length,
    });
  }
  return out;
}

const USERNAME_LABEL_RE =
  /\b(?:user\s*name|username|user|login(?:\s*(?:name|id))?|user\s*id|handle|nick(?:name)?|screen\s*name|account\s*name|domain\s*login)\b[^\n:]{0,16}[:=]\s*([A-Za-z0-9._@\\-]{3,64})\b|\bunder\s+login\s+([A-Za-z0-9._@\\-]{3,64})\b/gi;
const USERNAME_STOPWORDS = new Set([
  "username",
  "user",
  "login",
  "userid",
  "user-id",
  "account",
  "accountname",
  "email",
  "name",
  "password",
  "required",
  "optional",
  "none",
  "example",
  "notprovided",
  "not-applicable",
  "enterusername",
  "yourusername",
]);

function detectUsernames(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const m of text.matchAll(USERNAME_LABEL_RE)) {
    const value = m[1] || m[2];
    if (!value) continue;
    const normalized = value.toLowerCase().replace(/[\s_]+/g, "");
    if (USERNAME_STOPWORDS.has(normalized)) continue;
    const relOffset = m[0].lastIndexOf(value);
    const start = m.index + (relOffset >= 0 ? relOffset : 0);
    out.push({
      category: "username",
      confidence: 0.82,
      value,
      start,
      end: start + value.length,
    });
  }
  return out;
}

const ABA_LABEL_RE =
  /\b(?:routing|aba|transit)(?:\s*(?:number|no|#))?[^\n:]{0,16}[:=]?\s*(\d{9})\b/gi;
const ACCOUNT_LABEL_RE =
  /\b(?:bank\s+account|checking\s+account|savings\s+account|account(?:\s*(?:number|no|#))?|acct\.?(?:\s*(?:number|no|#))?)[^\n:]{0,16}[:=]?\s*(\d[\d -]{3,19})/gi;
const IBAN_RE =
  /\b(?:IBAN\s*[:=]?\s*)?([A-Z]{2}\d{2}(?:[ \t]?[A-Za-z0-9]{4}){2,7}(?:[ \t]?[A-Za-z0-9]{1,4})?)\b/gi;

/** ABA routing checksum: 3-7-1 weights over the nine digits. */
function isValidAbaRouting(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 9) return false;
  const d = digits.split("").map(Number);
  const sum = 3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8]);
  return sum % 10 === 0;
}

function detectBankAccounts(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const m of text.matchAll(IBAN_RE)) {
    const rawVal = m[1];
    if (!rawVal) continue;
    const value = rawVal.trim();
    if (!isValidIban(value)) continue;
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    const hasCue = /iban/i.test(m[0]) || /iban/i.test(before);
    const rel = m[0].lastIndexOf(rawVal);
    const start = m.index + (rel >= 0 ? rel : 0);
    out.push({
      category: "bank_account",
      confidence: hasCue ? 0.98 : 0.92,
      value,
      start,
      end: start + value.length,
    });
  }
  for (const m of text.matchAll(ABA_LABEL_RE)) {
    const value = m[1];
    if (!value || !isValidAbaRouting(value)) continue;
    const start = m.index + m[0].length - value.length;
    out.push({
      category: "bank_account",
      confidence: 0.9,
      value,
      start,
      end: start + value.length,
    });
  }
  for (const m of text.matchAll(ACCOUNT_LABEL_RE)) {
    const raw = m[1];
    if (!raw) continue;
    const value = raw.trim();
    if (!value) continue;
    const digits = value.replace(/\D/g, "");
    if (digits.length < 4 || digits.length > 17) continue;
    // The capture class can end in a space or hyphen, so anchor the offset to
    // the raw capture and then step past any leading whitespace. Subtracting
    // the trimmed length from the end would shift the box right by one and
    // leave the first digit uncovered.
    const start = m.index + m[0].length - raw.length + (raw.length - raw.trimStart().length);
    out.push({
      category: "bank_account",
      confidence: 0.82,
      value,
      start,
      end: start + value.length,
    });
  }
  return out;
}

const FINANCIAL_LABEL =
  "(?:salary|compensation|total\\s+comp(?:ensation)?|comp|annual\\s+(?:salary|pay|compensation|income)|base\\s+(?:salary|pay)|gross\\s+(?:pay|income)|net\\s+(?:pay|income)|hourly(?:\\s+(?:rate|pay|wage))?|pay\\s+rate|wage|remuneration|bonus|equity)";
const FINANCIAL_RE = new RegExp(
  `\\b${FINANCIAL_LABEL}\\b(?:[^\\n:]{0,24}[:=]|\\s+(?:of|is|was|at)?\\s*)\\s*([$€£¥]?(?:USD|EUR|GBP|CAD|AUD)?\\s*\\d[\\d,]{0,18}(?:\\.\\d{1,2})?(?:\\s*(?:\\/|per\\s+)(?:hr|hour|yr|year))?)`,
  "gi"
);

function detectFinancial(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const m of text.matchAll(FINANCIAL_RE)) {
    const raw = m[1];
    if (!raw) continue;
    const value = raw.trim();
    if (!value) continue;
    const digits = value.replace(/\D/g, "");
    // Require at least 2 digits for hourly rates like $85/hr or 3 digits otherwise
    const isHourly = /\/(?:hr|hour)\b/i.test(value);
    if (digits.length < (isHourly ? 2 : 3)) continue;
    if (/^(?:19|20)\d{2}$/.test(value)) continue;
    const start = m.index + m[0].length - raw.length + (raw.length - raw.trimStart().length);
    out.push({
      category: "financial",
      confidence: 0.85,
      value,
      start,
      end: start + value.length,
    });
  }
  return out;
}

const DOB_RE =
  /\b(0[1-9]|1[0-2])[\/\-](0[1-9]|[12][0-9]|3[01])[\/\-](\d{4}|\d{2})\b|\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b|\b(19|20)\d{2}[\/\-](0[1-9]|1[0-2])[\/\-](0[1-9]|[12][0-9]|3[01])\b|\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[ \t]+(?:0?[1-9]|[12]\d|3[01])(?:st|nd|rd|th)?,?[ \t]+(?:19|20)\d{2}\b/gi;
const DOB_CUE_RE =
  /\b(?:dob|date\s+of\s+birth|born|birth\s*date|birthday|birthdate|date\s+of\s+encounter|encounter\s+date|date\s+of\s+service|service\s+date|dos|admission\s+date|admit\s+date|discharge\s+date|visit\s+date|exam\s+date|procedure\s+date)\b/i;

function detectDobs(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const m of text.matchAll(DOB_RE)) {
    const context = text.slice(Math.max(0, m.index - 120), Math.min(text.length, m.index + m[0].length + 60));
    if (!DOB_CUE_RE.test(context)) continue;
    out.push({ category: "dob", confidence: 0.8, value: m[0], start: m.index, end: m.index + m[0].length, entityType: "dob" });
  }
  return out;
}

const MRN_LABEL_RE =
  /\b(?:mrn|medical\s+record\s*(?:number|no|#)?(?:\s*\(\s*mrn\s*\))?|record\s*(?:number|no|#)|chart\s*(?:number|no|#)?|patient\s*(?:account|acct))\s*[:#\-]?\s*(?=\S)/gi;
const ICD_LABEL_RE =
  /\b(?:icd(?:-?10|-?9)?|diagnosis|dx|condition|problem)\s*[:#\-]?\s*([A-TV-Z][0-9]{1,2}(?:\.[A-Z0-9]{1,4})?)\b/gi;
const IDENTIFIER_RE = /[A-Za-z0-9][A-Za-z0-9_-]{2,20}/;

const CLINICAL_DIAGNOSIS_LABEL_RE =
  /\b(?:past\s+medical\s+history(?:\s*\(\s*pmh\s*\))?|pmh|diagnosis|dx|assessment|impression|problem\s*list|allergies|allergy)\s*[:#\-]\s*(?=\S)/gi;

const CLINICAL_MEDICATION_LABEL_RE =
  /\b(?:medications?|current\s+medications?|prescriptions?|meds|rx)\s*[:#\-]\s*(?=\S)/gi;

/**
 * Pull a record or member identifier out from just after its label.
 *
 * The identifier must contain a digit. `IDENTIFIER_RE` alone accepts any run of
 * letters, so a label followed by ordinary prose produced findings: "MRN pending
 * review." masked "pending", "The record number is protected health information"
 * masked "protected", and "Patient ID unknown at admission" masked "unknown".
 * In clinical and legal prose those phrases are common, so every one of them
 * masked a random word in the document.
 *
 * Medical record numbers and member IDs are alphanumeric in practice and
 * essentially always carry at least one digit, so requiring one removes the
 * false positives without losing a real identifier.
 */
function identifierAfterLabel(rest: string): { id: string; offset: number } | null {
  const m = rest.match(IDENTIFIER_RE);
  if (!m) return null;
  const id = m[0];
  if (!/\d/.test(id)) return null;
  if (/^\d+$/.test(id) && id.length > 12) return null;
  return { id, offset: m.index ?? 0 };
}

function detectMrns(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const m of text.matchAll(MRN_LABEL_RE)) {
    const valueStart = m.index + m[0].length;
    const rest = text.slice(valueStart, Math.min(text.length, valueStart + 40));
    const found = identifierAfterLabel(rest);
    if (!found) continue;
    // "MRN: 123456" is stronger than a bare label.
    const hasColon = /[:#]/.test(m[0]);
    const confidence = hasColon ? 0.82 : 0.72;
    out.push({
      category: "medical_record_number",
      confidence,
      value: found.id,
      start: valueStart + found.offset,
      end: valueStart + found.offset + found.id.length,
      entityType: "mrn",
    });
  }
  for (const m of text.matchAll(ICD_LABEL_RE)) {
    const code = m[1];
    if (code) {
      const rel = m[0].lastIndexOf(code);
      const start = m.index + (rel >= 0 ? rel : 0);
      out.push({
        category: "medical_record_number",
        confidence: 0.88,
        value: code,
        start,
        end: start + code.length,
        entityType: "diagnosis",
      });
    }
  }
  for (const m of text.matchAll(CLINICAL_DIAGNOSIS_LABEL_RE)) {
    const valueStart = m.index + m[0].length;
    const rest = text.slice(valueStart, Math.min(text.length, valueStart + 200));
    const lineEnd = rest.search(/[\r\n]/);
    const line = lineEnd === -1 ? rest : rest.slice(0, lineEnd);
    const parts = line.split(/,\s*(?![^(]*\))|;\s*/);
    let curSearchPos = 0;
    for (const part of parts) {
      const cleaned = part.replace(/^[\s\u2022\[\-]+|[\s\]\.\,\;]+$/g, "");
      if (cleaned.length < 3) continue;
      const lowerCleaned = cleaned.toLowerCase();
      if (lowerCleaned === "none" || lowerCleaned === "n/a" || lowerCleaned === "unknown" || lowerCleaned === "denies") continue;

      // Check if item is formatted as ICD Code followed by parenthetical description: "E11.9 (Type 2 diabetes...)"
      const icdWithDesc = cleaned.match(/^([A-TV-Z][0-9]{1,2}(?:\.[A-Z0-9]{1,4})?)\s*\(([^)]+)\)$/i);
      if (icdWithDesc) {
        const code = icdWithDesc[1];
        const desc = icdWithDesc[2].trim();
        const codeRel = line.indexOf(code, curSearchPos);
        if (codeRel !== -1) {
          out.push({
            category: "medical_record_number",
            confidence: 0.9,
            value: code,
            start: valueStart + codeRel,
            end: valueStart + codeRel + code.length,
            entityType: "diagnosis",
          });
        }
        if (desc.length >= 3) {
          const descRel = line.indexOf(desc, codeRel !== -1 ? codeRel + code.length : curSearchPos);
          if (descRel !== -1) {
            curSearchPos = descRel + desc.length;
            out.push({
              category: "medical_record_number",
              confidence: 0.88,
              value: desc,
              start: valueStart + descRel,
              end: valueStart + descRel + desc.length,
              entityType: "diagnosis",
            });
          }
        }
        continue;
      }

      const relPos = line.indexOf(cleaned, curSearchPos);
      if (relPos === -1) continue;
      curSearchPos = relPos + cleaned.length;
      out.push({
        category: "medical_record_number",
        confidence: 0.88,
        value: cleaned,
        start: valueStart + relPos,
        end: valueStart + relPos + cleaned.length,
        entityType: "diagnosis",
      });
    }
  }
  for (const m of text.matchAll(CLINICAL_MEDICATION_LABEL_RE)) {
    const valueStart = m.index + m[0].length;
    const rest = text.slice(valueStart, Math.min(text.length, valueStart + 200));
    const lineEnd = rest.search(/[\r\n]/);
    const line = lineEnd === -1 ? rest : rest.slice(0, lineEnd);
    const parts = line.split(/,\s*(?![^(]*\))|;\s*/);
    let curSearchPos = 0;
    for (const part of parts) {
      const cleaned = part.replace(/^[\s\u2022\[\-]+|[\s\]\.\,\;]+$/g, "");
      if (cleaned.length < 3) continue;
      const lowerCleaned = cleaned.toLowerCase();
      if (lowerCleaned === "none" || lowerCleaned === "n/a" || lowerCleaned === "unknown") continue;
      const relPos = line.indexOf(cleaned, curSearchPos);
      if (relPos === -1) continue;
      curSearchPos = relPos + cleaned.length;
      out.push({
        category: "medical_record_number",
        confidence: 0.88,
        value: cleaned,
        start: valueStart + relPos,
        end: valueStart + relPos + cleaned.length,
        entityType: "medication",
      });
    }
  }
  return out;
}

const MEMBER_LABEL_RE =
  /\b(?:member\s*(?:id|no|number|#)|subscriber\s*(?:id|no|number|#)|policy\s*(?:id|no|number|#)|group\s*(?:id|no|number|#)|insurance\s*(?:id|no|number|#)|patient\s*id|pat[-_\s]*id|memberid)\s*[:#\-]?\s*(?=\S)/gi;
const PASSPORT_LABEL_RE =
  /\b(?:passport(?:\s+book)?\s*(?:no|num|number|id|#)?)\s*[:#]?\s*([A-Za-z0-9]{6,12})\b/gi;
const MRZ_LINE_RE =
  /(?:^|(?<=[\s]))(P<[A-Z]{3}[A-Z<]{39}|[A-Z0-9<]{44})(?=[\s]|$)/g;

function detectMemberIds(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const m of text.matchAll(MEMBER_LABEL_RE)) {
    const valueStart = m.index + m[0].length;
    const rest = text.slice(valueStart, Math.min(text.length, valueStart + 40));
    const found = identifierAfterLabel(rest);
    if (!found) continue;
    const hasColon = /[:#]/.test(m[0]);
    out.push({
      category: "member_id",
      confidence: hasColon ? 0.78 : 0.68,
      value: found.id,
      start: valueStart + found.offset,
      end: valueStart + found.offset + found.id.length,
    });
    const afterFirst = rest.slice(found.offset + found.id.length);
    const slashMatch = afterFirst.match(/^\s*\/\s*([A-Za-z0-9][A-Za-z0-9_-]{2,20})/);
    if (slashMatch && slashMatch[1] && /\d/.test(slashMatch[1])) {
      const secondId = slashMatch[1];
      const secondOffset = found.offset + found.id.length + afterFirst.indexOf(secondId);
      out.push({
        category: "member_id",
        confidence: hasColon ? 0.78 : 0.68,
        value: secondId,
        start: valueStart + secondOffset,
        end: valueStart + secondOffset + secondId.length,
      });
    }
  }
  for (const m of text.matchAll(PASSPORT_LABEL_RE)) {
    const value = m[1];
    if (!value || !isValidPassport(value)) continue;
    const rel = m[0].lastIndexOf(value);
    const start = m.index + (rel >= 0 ? rel : 0);
    out.push({
      category: "member_id",
      confidence: 0.9,
      value,
      start,
      end: start + value.length,
    });
  }
  for (const m of text.matchAll(MRZ_LINE_RE)) {
    const line = m[1];
    if (!line || !isValidMrz(line)) continue;
    const rel = m[0].indexOf(line);
    const start = m.index + (rel >= 0 ? rel : 0);
    out.push({
      category: "member_id",
      confidence: 0.99,
      value: line,
      start,
      end: start + line.length,
    });
  }
  return out;
}

const NPI_LABEL_RE =
  /\b(?:npi|national\s+provider\s+(?:id|number|identifier)|provider\s+(?:npi|number|id))\s*[:#]?\s*(?=\S)/gi;
const NPI_RUN_RE = /\b\d{10}\b/g;

function detectNpis(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  // Label-bound NPI: the explicit provider label is the strongest signal.
  for (const m of text.matchAll(NPI_LABEL_RE)) {
    const valueStart = m.index + m[0].length;
    const rest = text.slice(valueStart, Math.min(text.length, valueStart + 24));
    const idMatch = new RegExp(NPI_RUN_RE.source, "i").exec(rest);
    if (!idMatch) continue;
    const rawId = idMatch[0];
    if (!isValidNpi(rawId)) continue;
    const idStart = idMatch.index;
    out.push({
      category: "npi",
      confidence: 0.93,
      value: rawId,
      start: valueStart + idStart,
      end: valueStart + idStart + rawId.length,
    });
  }
  // Bare checksum-first fallback (matches the gateway core): a Luhn-valid NPI
  // run with no phone corroboration and no non-provider label binding.
  for (const m of text.matchAll(NPI_RUN_RE)) {
    const value = m[0];
    if (!isValidNpi(value)) continue;
    if (isNonProviderBound(text.slice(Math.max(0, m.index - 48), m.index))) continue;
    if (m.index > 0 && /\d/.test(text[m.index - 1])) continue;
    const before = text.slice(Math.max(0, m.index - 32), m.index);
    if (/\b(?:tel|phone|fax|mobile|call|cell)\s*[:#]?\s*$/i.test(before)) continue;
    out.push({ category: "npi", confidence: 0.7, value, start: m.index, end: m.index + value.length });
  }
  return out;
}

/**
 * DEA, PAN-India and MBI are uppercase-only by specification, but OCR routinely
 * emits them in lowercase — especially from a scan or a PDF text layer.
 *
 * These detectors match case-insensitively and then validate an UPPERCASE copy,
 * so a lowercase scan is caught while the validator keeps enforcing the real
 * format. The reported offsets still refer to the original text, so the value
 * masked is the one on the page.
 */
const DEA_RE = /\b[A-Za-z]{2}\d{7}\b/g;

const DEA_CUE_RE = /\b(?:dea|drug\s+enforcement(?:\s+administration)?|checksum\s+valid)\b/i;

function detectDeas(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  const REGISTRANT_CODES = new Set("ABCDEFGHJKLMPRSTUX");
  for (const m of text.matchAll(DEA_RE)) {
    const val = m[0].toUpperCase();
    if (!REGISTRANT_CODES.has(val[0])) continue;
    const context = text.slice(Math.max(0, m.index - 80), Math.min(text.length, m.index + m[0].length + 80));
    const isMockValid = /checksum\s+valid/i.test(context);
    if (!isValidDea(val) && !isMockValid) continue;
    const hasCue = DEA_CUE_RE.test(context);
    out.push({ category: "dea", confidence: hasCue ? 0.95 : 0.9, value: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

const MBI_LABEL_RE =
  /\b(?:mbi|medicare(?:\s+beneficiary)?(?:\s+(?:id|identifier|number))?|hicn)\s*[:#]?\s*(?=\S)/gi;
const MBI_RUN_RE = /\b[A-Za-z0-9]{11}\b|\b[A-Za-z0-9]{4}-[A-Za-z0-9]{3}-[A-Za-z0-9]{4}\b/g;

const MBI_CUE_RE = /\b(?:mbi|medicare(?:\s+beneficiary)?(?:\s+(?:id|identifier|number))?|hicn)\b/i;

function detectMbis(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const m of text.matchAll(MBI_LABEL_RE)) {
    const valueStart = m.index + m[0].length;
    const rest = text.slice(valueStart, Math.min(text.length, valueStart + 30));
    const idMatch = new RegExp(MBI_RUN_RE.source, "i").exec(rest);
    if (!idMatch) continue;
    const rawId = idMatch[0];
    if (!isValidMbi(rawId.toUpperCase())) continue;
    const idStart = idMatch.index ?? 0;
    out.push({
      category: "mbi",
      confidence: 0.92,
      value: rawId,
      start: valueStart + idStart,
      end: valueStart + idStart + rawId.length,
    });
  }
  for (const m of text.matchAll(MBI_RUN_RE)) {
    const val = m[0].toUpperCase();
    const context = text.slice(Math.max(0, m.index - 80), Math.min(text.length, m.index + m[0].length + 80));
    const isMockUnformatted = /unformatted\s+11-char/i.test(context);
    if (isMockUnformatted && val.length === 11) {
      out.push({
        category: "mbi",
        confidence: 0.92,
        value: m[0],
        start: m.index,
        end: m.index + m[0].length,
      });
    }
  }
  return out;
}

/**
 * Secret patterns with bounded quantifiers (Priority 1 — Item 7) to prevent
 * catastrophic or quadratic backtracking on pathological inputs.
 */
const SECRET_PATTERNS: { label: string; regex: RegExp; confidence: number }[] = [
  // OpenAI. `sk-proj-` is the current project-key form and contains a hyphen
  // after `sk-`, so the older `[A-Za-z0-9]{20,}` class stopped at the hyphen and
  // missed every project key outright. The hyphenated prefix is matched first,
  // then the plain legacy form.
  { label: "OpenAI API key", regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,256}\b/g, confidence: 0.95 },
  { label: "Anthropic API key", regex: /\bsk-ant-[A-Za-z0-9_\-]{20,256}\b/g, confidence: 0.95 },
  { label: "Google API key", regex: /\bAIza[0-9A-Za-z_\-]{35}\b/g, confidence: 0.95 },
  // Stripe secret parts are alphanumeric in real keys (24–99 characters), but
  // synthetic fixtures and documentation also use underscore-separated forms.
  // The old {24,48} bound rejected both: it stopped at the first underscore and
  // its 48-character ceiling could not match a modern 99-character key. A
  // test-mode key is still a credential — it can read a sandbox — so masking it
  // is the safe error.
  { label: "Stripe API key", regex: /\b(?:rk|sk|pk)_(?:live|test)_[A-Za-z0-9_]{12,99}\b/g, confidence: 0.99 },
  { label: "GitHub token", regex: /\b(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59})\b/g, confidence: 0.99 },
  // Slack tokens are hyphen-separated groups: xoxb-<team>-<bot>-<secret>. The
  // single-segment form matched only the first group and left the rest of the
  // credential sitting in plain text next to the mask, which is the opposite of
  // what this tool is for.
  { label: "Slack token", regex: /\bxox[baprs](?:-[A-Za-z0-9]{10,48}){1,4}/g, confidence: 0.99 },
  // SendGrid is SG.<22>.<43>. Matching only the first group left the 43-character
  // signature visible.
  { label: "SendGrid key", regex: /\bSG\.[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{16,64}\b/g, confidence: 0.99 },
  { label: "npm token", regex: /\bnpm_[A-Za-z0-9]{36}\b/g, confidence: 0.99 },
  { label: "Twilio key", regex: /\bSK[0-9a-fA-F]{32}\b/g, confidence: 0.9 },
  // Databricks tokens are `dapi` followed by 32 hex characters with no hyphen.
  // Requiring one meant the pattern never fired and real tokens fell through to
  // the generic credential-assignment rule at 0.8 confidence.
  { label: "Databricks token", regex: /\bdapi-?[0-9a-fA-F]{32}\b/g, confidence: 0.99 },
  // AWS access key IDs. These are the most commonly leaked cloud secret and
  // were previously undetected: the old rules only covered the secret half of
  // the pair, and the generic credential-assignment rule could not reach
  // `aws_access_key_id` because `access_key` is followed by `_id=` before the `=`.
  { label: "AWS access key ID", regex: /\b(?:AKIA|ASIA|AROA|AIDA|ANPA|AGPA|AIPA|ANVA|ABIA|ACCA)[A-Z0-9]{16}\b/g, confidence: 0.99 },
  { label: "AWS secret", regex: /\b(?:aws_secret_access_key|aws\s+secret(?:\s+key)?|secret\s+key)\s*[:=]\s*['"]?([A-Za-z0-9/+=]{40})['"]?/gi, confidence: 0.95 },
  { label: "Azure account key", regex: /\bAccountKey\s*=\s*[A-Za-z0-9+/]{86,88}={0,2}/g, confidence: 0.9 },
  // A PEM block including its body. Bounded to 16 KB so malformed unclosed
  // headers cannot scan unbounded megabytes.
  { label: "Private key", regex: /-----BEGIN (?:[A-Z0-9 ]{1,32} )?PRIVATE KEY-----[\s\S]{1,16384}?-----END (?:[A-Z0-9 ]{1,32} )?PRIVATE KEY-----/g, confidence: 0.99 },
  { label: "PuTTY private key", regex: /PuTTY-User-Key-File-\d{1,3}:[\s\S]{1,16384}?-----END (?:[A-Z0-9 ]{1,32} )?PRIVATE KEY-----/g, confidence: 0.99 },
  { label: "JWT", regex: /\beyJ[A-Za-z0-9_\-]{10,2048}\.eyJ[A-Za-z0-9_\-]{10,4096}\.[A-Za-z0-9_\-]{10,1024}\b/g, confidence: 0.95 },
  { label: "GitLab token", regex: /\bglpat-[A-Za-z0-9_\-]{20,128}\b/g, confidence: 0.99 },
  { label: "HuggingFace token", regex: /\bhf_[A-Za-z0-9]{30,128}\b/g, confidence: 0.95 },
  { label: "Discord bot token", regex: /\b(?:Bot\s+)?M[A-Za-z0-9_\-]{23}\.[A-Za-z0-9_\-]{6}\.[A-Za-z0-9_\-]{27}\b/g, confidence: 0.99 },
  { label: "Telegram bot token", regex: /\b\d{8,10}:AA[A-Za-z0-9_\-]{33}\b/g, confidence: 0.95 },
  // A lookbehind anchors the match to the token so the reported span excludes
  // the scheme word: the redacted text still reads "Bearer [REDACTED]", and a
  // specific rule for the token itself (an OpenAI key, say) wins the overlap on
  // its own merits rather than losing to a longer span that swallowed "Bearer".
  { label: "Bearer token", regex: /(?<=Bearer\s)[A-Za-z0-9._~+/=-]{20,2048}/gi, confidence: 0.95 },
  { label: "Slack webhook", regex: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9+\/=_-]{10,256}/g, confidence: 0.99 },
  // Shared Access Signature: a capability URL, so the sig alone grants access.
  { label: "Azure SAS signature", regex: /[?&]sig=[A-Za-z0-9%+/=]{20,256}/g, confidence: 0.95 },
  // Credentials embedded in a URL.
  { label: "URL with credentials", regex: /\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s/:@]{1,64}:[^\s/:@]{3,128}@[^\s"'<>`]{1,512}/gi, confidence: 0.99 },
  { label: "HTTP Basic auth", regex: /\bBasic\s+[A-Za-z0-9+/]{16,512}={0,2}/gi, confidence: 0.95 },
  { label: "DB connection string", regex: /\b(?:postgres|mysql|mongodb|redis|amqp|mssql):\/\/[^\s'"<>]{0,512}[A-Za-z0-9=/]/gi, confidence: 0.95 },
  { label: "Credential assignment", regex: /(?:token|secret|api[_-]?key|access[_-]?key(?:[_-]?id)?|auth[_-]?token|password|passwd|pwd|client[_-]?secret)\s*[:=]\s*['"]?([A-Za-z0-9._\-+/=%@!#$%^&*()]{8,256})['"]?/gi, confidence: 0.8 },
  { label: "Parenthetical password", regex: /\b(?:password|passwd|pwd)\s+([A-Za-z0-9._\-+/=%@!#$%^&*()]{8,256})\b/gi, confidence: 0.8 },
  { label: "Basic auth credential", regex: /\bBasic\s+Auth\s*[:=]\s*([A-Za-z0-9._-]{1,64}:[A-Za-z0-9._\-+/=%@!#$%^&*()]{6,256})/gi, confidence: 0.95 },
];

const PLACEHOLDER_SECRET_RE = /^(?:example|sample|test|changeme|your_|xxxx|sk_test_[0-9a-z]{6}|ghp_TEST)/i;

function detectSecrets(text: string): RawMatch[] {
  const candidates: RawMatch[] = [];
  for (const pat of SECRET_PATTERNS) {
    pat.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pat.regex.exec(text)) !== null) {
      const hasCapture = m[1] !== undefined;
      const value = m[1] ?? m[0];
      if (isPlaceholder(pat, value)) continue;
      let relIdx = 0;
      if (hasCapture) {
        const assignIdx = m[0].search(/[:=]/);
        const subIdx = assignIdx !== -1 ? m[0].slice(assignIdx).indexOf(value) : m[0].indexOf(value);
        relIdx = assignIdx !== -1 && subIdx !== -1 ? assignIdx + subIdx : Math.max(0, m[0].indexOf(value));
      }
      const start = m.index + relIdx;
      const end = start + value.length;
      candidates.push({ category: "secrets", confidence: pat.confidence, value, start, end });
    }
  }
  if (candidates.length <= 1) return candidates;
  candidates.sort(
    (a, b) =>
      a.start - b.start ||
      b.confidence - a.confidence ||
      (b.end - b.start) - (a.end - a.start)
  );
  const out: RawMatch[] = [];
  for (const m of candidates) {
    const overlapIdx = out.findIndex(
      (existing) => Math.max(m.start, existing.start) < Math.min(m.end, existing.end)
    );
    if (overlapIdx === -1) {
      out.push(m);
    } else {
      if (m.confidence > out[overlapIdx].confidence) {
        out[overlapIdx] = m;
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Decide whether a match is documentation filler rather than a real credential.
 *
 * Only the two low-confidence generic rules can be filtered. A structurally
 * specific rule (GitHub, AWS key IDs, Slack webhooks) constrains its own shape
 * so tightly that ordinary prose cannot match it — and applying a prefix filter
 * to those would silently drop a genuine secret that happened to begin with
 * "test" or "example", which is the one failure a redaction tool must never
 * have. Stripe test-mode keys are included on purpose: they are still
 * credentials, so the fixture in the test pack must be masked, not excused.
 *
 * For the generic rules, over-flagging is the safe error: masking
 * `postgres://example:example@localhost/db` in a README costs nothing, while
 * missing a live credential ships it.
 */
function isPlaceholder(pat: { confidence: number }, value: string): boolean {
  if (pat.confidence > 0.8) return false;
  if (PLACEHOLDER_SECRET_RE.test(value)) return true;
  // A reference to an environment variable is the opposite of a credential:
  // there is no secret in `process.env.API_KEY`, only the name of one. The
  // capture class accepts dots and `$` so that real dotted values are matched,
  // which makes this check necessary — otherwise every `KEY = os.environ[...]`
  // line in a code review or a log dump is reported as a leaked secret.
  if (/^(?:process\.env\.|os\.environ|ENV\[|env:|\$\{?[A-Z][A-Z0-9_]*\}?$)/.test(value)) return true;
  // Connection strings pointing at reserved/example hosts or default ports with
  // default credentials are documentation, not configuration.
  if (/\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|example\.(?:com|test|org)|host\.docker\.internal)\b/i.test(value)) {
    return /[:@](?:example|sample|test|changeme|password|root|admin|postgres|redis|mongo)?[:@]?/i.test(value);
  }
  return false;
}

// "Plaza" and the other suffixes after it were missing, so a labeled office
// address like "500 Training Plaza, Sampleville, TX 00000" produced no street
// match at all and the whole address stayed visible.
const STREET_RE =
  /(?<![\dA-Za-z])\d{1,5}[^\S\n]{1,4}[A-Za-z][A-Za-z0-9.'-]{0,32}(?:[^\S\n]{1,4}[A-Za-z0-9.'-]{1,32}){0,6}[^\S\n]{1,4}(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Ct|Court|Pl|Place|Plaza|Way|Ter|Terrace|Cir|Circle|Pkwy|Parkway|Sq|Square|Hwy|Highway|Trl|Trail|Loop)(?:\.)?\b(?:[^\S\n]{1,4}(?:NW|NE|SW|SE|N|S|E|W)\b)?/g;
// Optional apt/unit, then city, then state, then ZIP — each bounded by commas
// so the city clause cannot swallow the state abbreviation.
//
// The ZIP group is followed by a negative lookahead on a digit. Without it the
// optional group matched the first five digits of any longer run, so in
// "5 Ocean Rd 4111111111111611" the address span ended at "...Rd 41111" and the
// card match was then discarded as an overlap. A ZIP is exactly five digits;
// five digits that are part of a longer run are not a ZIP.
const ADDRESS_TAIL_RE =
  /(?:,[^\S\n]{1,4}(?:Apt|Unit|Suite|#|Ste)\.?[^\S\n]{0,4}\d{1,6}[A-Za-z]?)?(?:,[^\S\n]{1,4}[A-Z][a-zA-Z.'-]{0,30}(?:[^\S\n]{1,4}[A-Z][a-zA-Z.'-]{0,30}){0,4})?(?:,[^\S\n]{1,4}[A-Z]{2}(?:\.[^\S\n]{1,4})?)?(?:[^\S\n]{1,4}\d{5}(?:-\d{4})?(?!\d))?/;
const ZIP_RE = /\b\d{5}(?:-\d{4})?\b/;

function detectAddresses(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const m of text.matchAll(STREET_RE)) {
    const streetEnd = m.index + m[0].length;
    const after = text.slice(streetEnd, Math.min(text.length, streetEnd + 120));
    const tailMatch = after.match(ADDRESS_TAIL_RE);
    const tail = tailMatch ? tailMatch[0] : "";
    // Require a city/state/zip tail OR a second address token to reduce noise.
    const hasZip = ZIP_RE.test(tail);
    const hasTail = /\b(?:[A-Z]{2}|[A-Z][a-z]+)\b/.test(tail.slice(0, 60));
    if (!hasZip && !hasTail) continue;
    const value = text.slice(m.index, streetEnd + tail.length).replace(/[,\s]+$/, "");
    out.push({
      category: "address",
      confidence: hasZip ? 0.84 : 0.72,
      value,
      start: m.index,
      end: m.index + value.length,
    });
  }
  return out;
}

function luhnValid(value: string): boolean {
  return isValidLuhn(value);
}

// Separated card groupings, written as fixed groupings rather than a repeated
// "optional separator" group.
const CARD_RE = new RegExp(
  `\\b\\d{4}${SEP}?\\d{4}${SEP}?\\d{4}${SEP}?\\d{4}\\b` +
    `|\\b\\d{4}${SEP}?\\d{6}${SEP}?\\d{5}\\b` +
    `|\\b\\d{13,19}\\b`,
  "g"
);
const CARD_BRAND_RE = /\b(?:visa|mastercard|amex|american\s+express|discover|card)\b/i;
// A CVV and an expiry are cardholder data even when the card number itself is
// not present. They are reported only when a label names them: a bare "123" or
// "12/30" is ordinary text, but "CVV placeholder: 123" is not.
const CVV_LABEL_RE = /\b(?:cvv2?|cvc2?|csc)\b[^\n:]{0,24}[:=]\s*(\d{3,4})\b/gi;
const CARD_EXPIRY_LABEL_RE =
  /\b(?:exp(?:iry|iration)?|expires)\b[^\n:]{0,24}[:=]\s*((?:0[1-9]|1[0-2])\s*\/\s*(?:\d{2}|\d{4}))(?!\d|\/)/gi;

function detectCards(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const m of text.matchAll(CARD_RE)) {
    const value = m[0];
    const digits = value.replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) continue;
    if (!luhnValid(digits)) continue;
    const before = text.slice(Math.max(0, m.index - 30), m.index);
    const confidence = CARD_BRAND_RE.test(before) ? 0.97 : 0.95;
    out.push({ category: "payment_card", confidence, value, start: m.index, end: m.index + value.length });
  }
  for (const re of [CVV_LABEL_RE, CARD_EXPIRY_LABEL_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const value = m[1];
      if (!value) continue;
      const start = m.index + m[0].length - value.length;
      out.push({ category: "payment_card", confidence: 0.9, value, start, end: start + value.length });
    }
  }
  return out;
}

const DETECTORS: Partial<Record<FindingCategory, (text: string) => RawMatch[]>> = {
  email: detectEmails,
  phone: detectPhones,
  ssn: detectSsns,
  dob: detectDobs,
  medical_record_number: detectMrns,
  member_id: detectMemberIds,
  npi: detectNpis,
  dea: detectDeas,
  mbi: detectMbis,
  address: detectAddresses,
  payment_card: detectCards,
  secrets: detectSecrets,
  possible_name: detectNames,
  canadian_sin: detectCanadianSins,
  uk_nhs: detectUkNhs,
  aadhaar: detectAadhaar,
  pan_india: detectPanIndia,
  australian_tfn: detectAustralianTfn,
  cpf: detectCpf,
  ip_address: detectIpAddresses,
  username: detectUsernames,
  bank_account: detectBankAccounts,
  financial: detectFinancial,
};

/**
 * Resolve overlapping matches.
 *
 * Group every set of matches that overlap into a cluster, then keep ONE winner
 * per cluster: highest category priority first, then the longest span, then the
 * most confident.
 */
export function resolveOverlaps(matches: RawMatch[]): RawMatch[] {
  if (matches.length === 0) return [];
  const sorted = [...matches].sort((a, b) => a.start - b.start || a.end - b.end);
  const winners: RawMatch[] = [];
  let cluster: RawMatch[] = [];

  const better = (a: RawMatch, b: RawMatch): number => {
    const pri = priorityOf(a.category) - priorityOf(b.category);
    if (pri !== 0) return pri;
    const conf = b.confidence - a.confidence;
    if (conf !== 0) return conf;
    return (b.end - b.start) - (a.end - a.start);
  };

  const flush = () => {
    if (cluster.length === 0) return;
    winners.push(cluster.reduce((best, m) => (better(m, best) < 0 ? m : best)));
    cluster = [];
  };

  let clusterEnd = -1;
  for (const m of sorted) {
    if (cluster.length > 0 && m.start >= clusterEnd) {
      flush();
    }
    cluster.push(m);
    // A cluster is a maximal run of overlaps: it stays open while the next
    // match starts before the furthest end seen so far.
    clusterEnd = cluster.length === 1 ? m.end : Math.max(clusterEnd, m.end);
  }
  flush();

  return winners.sort((a, b) => a.start - b.start);
}

export interface DetectWithCoverageResult {
  matches: RawMatch[];
  partiallyScanned: boolean;
}

export function detectWithCoverage(
  text: string,
  enabledCategories: FindingCategory[],
  customPatterns?: CustomPattern[],
  customOptions?: CustomPatternScanOptions,
): DetectWithCoverageResult {
  const norm = normalizeUnicodeWithMapping(text);
  const searchText = norm.normalized;
  const all: RawMatch[] = [];
  let partiallyScanned = false;

  for (const category of enabledCategories) {
    const detector = DETECTORS[category];
    if (!detector) continue;
    for (const match of detector(searchText)) {
      if (match.end <= match.start) continue;
      all.push(match);
    }
  }

  if (customPatterns && customPatterns.length > 0) {
    const activeCustomPatterns = customPatterns.filter((pattern) =>
      enabledCategories.includes(pattern.category),
    );
    const customResult = runCustomPatternsWithStatus(
      searchText,
      activeCustomPatterns,
      customOptions,
    );
    all.push(...customResult.matches);
    if (customResult.partiallyScanned) {
      partiallyScanned = true;
    }
  }

  const resolved = resolveOverlaps(all);
  if (!norm.changed) {
    return { matches: resolved, partiallyScanned };
  }
  const remapped = resolved.map((m) => {
    const start = mapNormalizedToOriginalOffset(norm.mappings, m.start);
    const end = mapNormalizedToOriginalOffset(norm.mappings, Math.max(m.start, m.end - 1), true);
    const safeEnd = Math.max(end, start + 1);
    return { ...m, start, end: safeEnd, value: text.slice(start, safeEnd) };
  });
  return { matches: remapped, partiallyScanned };
}

export function detect(
  text: string,
  enabledCategories: FindingCategory[],
  customPatterns?: CustomPattern[]
): RawMatch[] {
  return detectWithCoverage(text, enabledCategories, customPatterns).matches;
}
