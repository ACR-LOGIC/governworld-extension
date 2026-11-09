// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import type { RawMatch } from "../detect.js";
import { isNonProviderBound } from "../../validators/index.js";

const DASH_CHARS =
  "\\u002D\\u058A\\u05BE\\u1400\\u1806\\u2010-\\u2015\\u2212\\u2E17\\u2E1A\\u2E3A\\u2E3B\\u2E40\\u301C\\u3030\\u30A0\\uFE31\\uFE32\\uFE58\\uFE63\\uFF0D";
const SEP = `[\\s${DASH_CHARS}.]`;
const NANP_SEP = `[\\s${DASH_CHARS}]`;

/** North American Numbering Plan (US/Canada +1) matcher. */
const NANP_PHONE_RE = new RegExp(
  `(?<![\\dA-Za-z+])(?:\\+?1${NANP_SEP}?)?` +
    `(?:\\([2-9][0-8][0-9]\\)${NANP_SEP}?|[2-9][0-8][0-9]${NANP_SEP}?)` +
    `[2-9][0-9]{2}${NANP_SEP}?[0-9]{4}(?![\\dA-Za-z])`,
  "g",
);

/**
 * Mexico (+52) phone matcher:
 * Supports +52 55 1234 5678, +52 (55) 1234-5678, +52 1 55 1234 5678,
 * +52 333 123 4567, +525512345678.
 */
const MX_PHONE_RE = new RegExp(
  `(?<![\\dA-Za-z])\\+52(?:${SEP}+1)?${SEP}*(?:\\(\\d{2,3}\\)|\\d{2,3})${SEP}*\\d{3,4}${SEP}*\\d{4}(?![\\dA-Za-z])`,
  "g",
);

/**
 * United Kingdom (+44) phone matcher:
 * Supports +44 20 7946 0958, +44 (0) 20 7946 0958, +44 7700 900077,
 * +44-7911-123456, +44 161 496 0123, +442079460958.
 */
const UK_INTL_PHONE_RE = new RegExp(
  `(?<![\\dA-Za-z])\\+44${SEP}*(?:\\(0\\)${SEP}*)?(?:\\(\\d{2,5}\\)|[1-9]\\d{1,4})${SEP}*\\d{3,4}${SEP}*\\d{3,4}(?![\\dA-Za-z])`,
  "g",
);

/**
 * Additional international E.164 formatted phone matcher:
 * Country codes: +31, +32, +33, +34, +39, +41, +43, +45, +46, +47, +48, +49,
 * +51, +54, +55, +56, +57, +60, +61, +62, +63, +64, +65, +66, +81, +82, +86,
 * +90, +91, +92, +351, +353, +358, +420, +852, +886, +971, +972.
 * Requires at least one separator between groups to avoid matching bare numbers.
 */
const INTL_FORMATTED_PHONE_RE = new RegExp(
  `(?<![\\dA-Za-z])\\+(?:3[12349]|4[1356789]|5[14567]|6[0123456]|8[126]|9[012]|35[138]|420|852|886|97[12])${SEP}+(?:\\(0\\)${SEP}*)?(?:\\(\\d{1,4}\\)|\\d{1,4})(?:${SEP}+\\d{2,5}){2,4}(?![\\dA-Za-z])`,
  "g",
);

const NON_PHONE_LABEL_RE =
  /\b(?:invoice|order|reference|tracking|serial|confirmation|receipt|purchase\s+order|p\.?o\.?)\b/i;

export function detectPhones(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  const seenSpans = new Set<string>();

  const pushUnique = (value: string, start: number, confidence: number) => {
    const end = start + value.length;
    const key = `${start}:${end}`;
    if (seenSpans.has(key)) return;
    seenSpans.add(key);
    out.push({ category: "phone", confidence, value, start, end });
  };

  // 1. NANP (+1 / US / Canada)
  for (const m of text.matchAll(NANP_PHONE_RE)) {
    const value = m[0];
    const digits = value.replace(/\D/g, "").replace(/^1/, "");
    if (digits.length !== 10) continue;
    const area = digits.slice(0, 3);
    const exchange = digits.slice(3, 6);
    if (
      area[0] !== "2" &&
      area[0] !== "3" &&
      area[0] !== "4" &&
      area[0] !== "5" &&
      area[0] !== "6" &&
      area[0] !== "7" &&
      area[0] !== "8" &&
      area[0] !== "9"
    ) {
      continue;
    }
    if (area[0] === "9" && area[1] === "0" && area[2] === "0") continue;
    if (exchange === "555" && digits.slice(6) === "0100") continue;

    const isBareRun = !/[^+\d]/.test(value);
    if (isBareRun) {
      const before = text.slice(Math.max(0, m.index - 48), m.index);
      if (isNonProviderBound(before) || NON_PHONE_LABEL_RE.test(before.slice(-32))) {
        continue;
      }
    }
    pushUnique(value, m.index, 0.88);
  }

  // 2. Mexico (+52)
  for (const m of text.matchAll(MX_PHONE_RE)) {
    const value = m[0];
    const digits = value.replace(/\D/g, "");
    // +52 + 10 digits = 12 digits (or 13 with legacy mobile '1')
    if (digits.length < 12 || digits.length > 13) continue;
    pushUnique(value, m.index, 0.91);
  }

  // 3. United Kingdom (+44)
  for (const m of text.matchAll(UK_INTL_PHONE_RE)) {
    const value = m[0];
    const digits = value.replace(/\D/g, "");
    // +44 + 9..10 digits (or +440 + 9..10 digits) = 11..13 digits
    if (digits.length < 11 || digits.length > 13) continue;
    pushUnique(value, m.index, 0.91);
  }

  // 4. Additional international formatted numbers
  for (const m of text.matchAll(INTL_FORMATTED_PHONE_RE)) {
    const value = m[0];
    const digits = value.replace(/\D/g, "");
    // E.164 max is 15 digits; require at least 9 digits total
    if (digits.length < 9 || digits.length > 15) continue;
    pushUnique(value, m.index, 0.89);
  }

  return out;
}
