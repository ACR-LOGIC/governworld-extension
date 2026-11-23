// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Exact medical abbreviation set (too short for Bloom filters).

export const ABBREV = new Map<string, string>([
  ["htn", "Hypertension"],
  ["dm2", "Type 2 Diabetes"],
  ["dm1", "Type 1 Diabetes"],
  ["ckd", "Chronic Kidney Disease"],
  ["copd", "COPD"],
  ["chf", "Congestive Heart Failure"],
  ["hiv", "HIV"],
  ["mdd", "Major Depressive Disorder"],
  ["bph", "Benign Prostatic Hyperplasia"],
  ["pcos", "PCOS"],
  ["gerd", "GERD"],
  ["afib", "Atrial Fibrillation"],
  ["dvt", "Deep Vein Thrombosis"],
  ["uti", "Urinary Tract Infection"],
  ["cad", "Coronary Artery Disease"],
  ["hba1c", "HbA1c"],
]);

export interface AbbrevHit {
  value: string;
  expanded: string;
  start: number;
  end: number;
}

const ABBREV_RE = /\b[A-Za-z0-9]{2,6}\b/g;

export function detectAbbrev(text: string): AbbrevHit[] {
  const out: AbbrevHit[] = [];
  ABBREV_RE.lastIndex = 0;
  for (const m of text.matchAll(ABBREV_RE)) {
    if (m.index === undefined) continue;
    const raw = m[0];
    const expanded = ABBREV.get(raw.toLowerCase());
    if (!expanded) continue;
    out.push({
      value: raw,
      expanded,
      start: m.index,
      end: m.index + raw.length,
    });
  }
  return out;
}
