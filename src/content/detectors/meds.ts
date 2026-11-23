// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Drug dosage/frequency booster & medical context scoring.

const DOSAGE_RE = /\b\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml|units|iu|meq)\b/gi;
const FREQUENCY_RE = /\b(?:bid|tid|qid|qd|hs|prn|daily|twice\s+daily|once\s+daily|every\s+\d+\s+hours)\b/gi;

export const MED_CONTEXT: Record<string, number> = {
  patient: 0.2,
  diagnosis: 0.3,
  prescribed: 0.3,
  prescription: 0.3,
  treatment: 0.2,
  dosage: 0.3,
  taking: 0.15,
  "history of": 0.25,
  hospital: 0.1,
  clinic: 0.1,
  doctor: 0.1,
  example: -0.3,
  sample: -0.3,
  "side effects may include": -0.35,
  advertisement: -0.3,
};

export interface DrugBoostResult {
  confidence: number;
  hasDosage: boolean;
  hasFrequency: boolean;
  end: number;
}

export function boostForDrug(
  text: string,
  start: number,
  end: number,
  baseConfidence = 0.72
): DrugBoostResult {
  const windowAfter = text.slice(end, Math.min(text.length, end + 40)).split(/[,;\n]/)[0];
  DOSAGE_RE.lastIndex = 0;
  FREQUENCY_RE.lastIndex = 0;
  const dMatch = DOSAGE_RE.exec(windowAfter);
  const fMatch = FREQUENCY_RE.exec(windowAfter);
  const hasDosage = Boolean(dMatch);
  const hasFrequency = Boolean(fMatch);

  let extendedEnd = end;
  if (dMatch) extendedEnd = Math.max(extendedEnd, end + dMatch.index + dMatch[0].length);
  if (fMatch) extendedEnd = Math.max(extendedEnd, end + fMatch.index + fMatch[0].length);

  let confidence = baseConfidence;
  if (hasDosage && hasFrequency) confidence = Math.max(confidence, 0.95);
  else if (hasDosage) confidence = Math.max(confidence, 0.9);
  else if (hasFrequency) confidence = Math.max(confidence, 0.84);

  return { confidence, hasDosage, hasFrequency, end: extendedEnd };
}

export function applyMedicalContextScore(text: string, start: number, end: number, base: number): number {
  const ctx = text.slice(Math.max(0, start - 64), Math.min(text.length, end + 64)).toLowerCase();
  let score = base;
  for (const [phrase, delta] of Object.entries(MED_CONTEXT)) {
    if (ctx.includes(phrase)) {
      score += delta;
    }
  }
  return Math.max(0.05, Math.min(0.99, Number(score.toFixed(3))));
}
