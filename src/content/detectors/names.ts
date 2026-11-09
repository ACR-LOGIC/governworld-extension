// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import type { RawMatch } from "../detect.js";

/**
 * Unicode-aware name detection (Priority 0 — Item 6).
 *
 * Uses Unicode property escapes (`\p{Lu}`, `\p{L}`, `\p{M}`) with the `u` flag
 * instead of ASCII-only `[A-Z][a-zA-Z]` assumptions so international names with
 * accents, diacritics, and non-ASCII Latin letters (e.g., José, Hernández,
 * Peña, Müller, François, Łukasz) are accurately detected.
 */

const NAME_LABEL_WORDS =
  "(?:possible\\s+name|patient(?:\\s+name)?|member(?:\\s+name)?|full\\s+name|name|provider|employee|customer|client|contact|attending\\s+physician|physician|doctor|clinician|guardian|subscriber|insured)";

export const NAME_LABEL_RE = new RegExp(
  `(?<=^|\\n)\\b${NAME_LABEL_WORDS}\\s*[:.\\-\\t|]\\s*(?=\\S)|(?<![\\w])\\b${NAME_LABEL_WORDS}\\s*[:.\\-\\t|]\\s*(?=\\S)`,
  "gi",
);

const INTL_HONORIFIC_PART = "(?:(?:Dr|Mr|Mrs|Ms|Mx|Prof|Sr|Sra|Srta|M|Mme|Mlle)\\.?\\s+)";
const NAME_PARTICLE = "(?:(?:de|del|la|las|los|y|van|von|der|den|da|das|do|dos|di|du|le|al|bin|ibn)\\s+)*";
const UNICODE_NAME_TOKEN = "[\\p{Lu}\\p{Lt}][\\p{L}\\p{M}.'’-]{0,30}";
const NAME_SUFFIX_PART = "(?:,?\\s+(?:Jr|Sr|II|III|IV|MD|DO|NP|PA|RN|PhD|MBBS|FACP|PharmD)\\.?)?";

/**
 * Multi-word Unicode name matcher (2 to 4 capitalized tokens with optional
 * honorifics, particles, and clinical/generational suffixes).
 *
 * Uses Unicode-aware lookaround `(?<![\\p{L}\\p{M}\\d])` and `(?![\\p{L}\\p{M}\\d])`
 * because standard ASCII `\\b` does not treat non-ASCII letters (such as Ł, É, ñ) as word characters.
 */
export const NAME_RE = new RegExp(
  `(?<![\\p{L}\\p{M}\\d])(?:${INTL_HONORIFIC_PART})?([\\p{Lu}\\p{Lt}][\\p{L}\\p{M}.'’-]*(?:[ \\t]+${NAME_PARTICLE}[\\p{Lu}\\p{Lt}][\\p{L}\\p{M}.'’-]*){1,3}${NAME_SUFFIX_PART})(?![\\p{L}\\p{M}\\d])`,
  "u",
);

/**
 * Single-token Unicode name matcher for labeled fields where a single given
 * name or surname with diacritics/non-ASCII letters (e.g., "Name: José",
 * "Surname: Hernández", "Patient: Peña", "Doctor: Müller", "Client: François",
 * "Employee: Łukasz") or an honorific-prefixed single surname ("Dr. Müller")
 * is provided.
 */
export const SINGLE_UNICODE_NAME_RE = new RegExp(
  `^(?:${INTL_HONORIFIC_PART}${UNICODE_NAME_TOKEN}|${UNICODE_NAME_TOKEN})(?![\\p{L}\\p{M}\\d])`,
  "u",
);

/**
 * A name in prose directly followed by a parenthetical clinical/identity
 * qualifier ("José Hernández (DOB ...; MRN ...)").
 */
export const NAME_BEFORE_IDENTIFIER_RE = new RegExp(
  `(?<![\\p{L}\\p{M}\\d])(?:(?:Dr|Mr|Mrs|Ms|Prof)\\.?\\s+)?([\\p{Lu}\\p{Lt}][\\p{L}\\p{M}.'’-]*(?:[ \\t]+${NAME_PARTICLE}[\\p{Lu}\\p{Lt}][\\p{L}\\p{M}.'’-]*){1,3}(?:,?\\s+(?:Jr|Sr|II|III|IV)\\.?)?)[ \\t]*\\((?=\\s*(?:DOB|MRN|Date of Birth|date of birth|Member ID|member id|Provider NPI|NPI|DEA|SSN|ITIN|Patient ID|PAT-ID)\\b)`,
  "gu",
);

export const GENERIC_NAME_LABELS = new Set([
  "first name",
  "last name",
  "user name",
  "enter name",
  "your name",
  "medical record number",
  "medical record",
  "date of birth",
  "patient id",
  "member id",
  "chart number",
  "attending physician",
  "referring physician",
  "admitting physician",
  "primary care physician",
  "clinical note",
  "progress note",
  "intake note",
  "discharge summary",
  "history and physical",
  "chief complaint",
  "assessment and plan",
  "past medical history",
  "review of systems",
  "vital signs",
  "medication administration record",
  "lab results",
  "radiology report",
  "emergency department",
  "operating room",
  "intensive care unit",
  "general hospital",
  "medical center",
  "health system",
  "clinic note",
  "nursing note",
  "consult note",
  "operative report",
  "pathology report",
  "diagnostic report",
  "cardiology report",
  "physician notes",
  "patient chart",
  "medical history",
  "treatment plan",
  "discharge instructions",
  "prescription order",
  "doctor notes",
  "intake form",
  "registration form",
  "consent form",
  "billing statement",
  "account summary",
  "encounter note",
  "case note",
  "summary note",
  "note summary",
  "required",
  "optional",
  "select one",
  "required field",
  "not specified",
  "unknown",
  "pending",
  "none",
]);

function hasNonAsciiUnicodeLetter(value: string): boolean {
  return /[^\x00-\x7F]/.test(value) && /[\p{L}\p{M}]/u.test(value);
}

export function detectNames(text: string): RawMatch[] {
  const out: RawMatch[] = [];
  for (const m of text.matchAll(NAME_LABEL_RE)) {
    const valueStart = m.index + m[0].length;
    const rest = text.slice(valueStart, Math.min(text.length, valueStart + 60));
    const lineEnd = rest.search(/[\r\n]/);
    const lineSlice = lineEnd === -1 ? rest : rest.slice(0, lineEnd);

    let nameMatch = lineSlice.match(NAME_RE);
    if (!nameMatch) {
      const singleMatch = lineSlice.match(SINGLE_UNICODE_NAME_RE);
      if (singleMatch) {
        const candidate = singleMatch[0];
        const hasHonorific = new RegExp(`^${INTL_HONORIFIC_PART}`, "u").test(candidate);
        if (hasHonorific || hasNonAsciiUnicodeLetter(candidate)) {
          nameMatch = singleMatch;
        }
      }
    }
    if (!nameMatch) continue;
    const value = nameMatch[0];
    if (GENERIC_NAME_LABELS.has(value.toLowerCase().trim())) continue;
    const nameStart = nameMatch.index ?? 0;
    if (value.length < 2) continue;
    out.push({
      category: "possible_name",
      confidence: 0.52,
      value,
      start: valueStart + nameStart,
      end: valueStart + nameStart + value.length,
      entityType: "patient_name",
    });
  }

  // Tab-separated or multiline names after "Possible name"
  const POSS_TABLE_RE = /\b(?:Possible\s+name)\s*[:.\t\n]\s*([^\n\r]+)/gi;
  for (const m of text.matchAll(POSS_TABLE_RE)) {
    const rawLine = m[1];
    const parts = rawLine.split(/[\t|]/);
    for (const part of parts) {
      const trimmed = part.trim();
      const nMatch = trimmed.match(NAME_RE);
      if (nMatch && !GENERIC_NAME_LABELS.has(nMatch[0].toLowerCase())) {
        const offset = m.index + m[0].indexOf(nMatch[0]);
        if (offset >= 0) {
          out.push({
            category: "possible_name",
            confidence: 0.85,
            value: nMatch[0],
            start: offset,
            end: offset + nMatch[0].length,
            entityType: "patient_name",
          });
        }
      }
    }
  }

  for (const m of text.matchAll(NAME_BEFORE_IDENTIFIER_RE)) {
    const value = m[1];
    if (!value || GENERIC_NAME_LABELS.has(value.toLowerCase().trim())) continue;
    const isSingleWord = !/\s/.test(value.trim());
    if (isSingleWord && !hasNonAsciiUnicodeLetter(value)) continue;
    const leadingSpace = m[0].indexOf(value);
    out.push({
      category: "possible_name",
      confidence: 0.6,
      value,
      start: m.index + leadingSpace,
      end: m.index + leadingSpace + value.length,
      entityType: "patient_name",
    });
  }
  return out;
}
