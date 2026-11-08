// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
/**
 * GovernWorld Explainable Compliance Score Engine (Risk Formula v1).
 *
 * Replaces opaque "AI magic" scoring with a deterministic, mathematically
 * provable, and fully auditable compliance risk calculation:
 *
 *   Risk Score =
 *     (Data Sensitivity * Confidence Modifier)
 *     + Combination Bonus
 *     + Volume Risk
 *     + Destination Risk
 *     + Action Risk
 *
 * Range: 0 - 100
 *
 * Final Risk Bands:
 *   0 - 24:   INFORMATIONAL -> LOG
 *   25 - 49:  LOW           -> ALLOW + LOG
 *   50 - 69:  MEDIUM        -> WARN
 *   70 - 89:  HIGH          -> MASK
 *   90 - 100: CRITICAL      -> BLOCK
 *
 * AI Leakage Rule (Secret Weapon):
 *   PHI Present + External AI Destination + Paste/Upload Action = 100 (CRITICAL / BLOCK).
 */

import type { DestinationClassification } from "./destinationClassifier.js";
import { extractPHIEvidenceGraph, FindingType, type PHIEntityGroup } from "./phiEvidence.js";
export { extractPHIEvidenceGraph, FindingType, type PHIEntityGroup };

export type ComplianceAction =
  | "view"
  | "copy"
  | "paste"
  | "upload"
  | "share"
  | "download";

export type RiskBand =
  | "INFORMATIONAL"
  | "LOW"
  | "MEDIUM"
  | "HIGH"
  | "CRITICAL";

export type ComplianceDecision =
  | "LOG"
  | "ALLOW"
  | "WARN"
  | "MASK"
  | "BLOCK";

export interface ComplianceFindingInput {
  category: string;
  confidence?: number;
  value?: string;
  count?: number;
}

export interface CombinationRule {
  id: string;
  name: string;
  requiredEntities: string[];
  bonusScore: number;
  minimumAction?: ComplianceDecision;
}

export interface ComplianceFactors {
  baseSensitivity: number;
  confidenceModifier: number;
  adjustedSensitivity: number;
  combinationBonus: number;
  volumeRisk: number;
  destinationRisk: number;
  actionRisk: number;
  aiLeakageTriggered: boolean;
  appliedRules: string[];
  entityCounts: Record<string, number>;
}

export interface ComplianceEvaluation {
  who: string;
  what: string[];
  where: string;
  how: string;
  riskScore: number; // 0..100
  riskBand: RiskBand;
  decision: ComplianceDecision;
  reason: string;
  factors: ComplianceFactors;
  destination: DestinationClassification;
  action: ComplianceAction;
}

/** Standard PII and PHI Base Sensitivity Weights per GovernWorld Formula v1 */
export const BASE_SENSITIVITY_TABLE: Record<string, { weight: number; isPhi: boolean; label: string }> = {
  // PII
  email: { weight: 5, isPhi: false, label: "Email" },
  phone: { weight: 8, isPhi: false, label: "Phone" },
  address: { weight: 10, isPhi: false, label: "Address" },
  driver_license: { weight: 20, isPhi: false, label: "Driver License" },
  passport: { weight: 25, isPhi: false, label: "Passport" },
  ssn: { weight: 40, isPhi: false, label: "SSN" },
  payment_card: { weight: 40, isPhi: false, label: "Credit Card" },
  bank_account: { weight: 35, isPhi: false, label: "Bank Account" },
  secrets: { weight: 40, isPhi: false, label: "API Secret" },

  // PHI
  possible_name: { weight: 15, isPhi: true, label: "Patient Name" },
  patient_name: { weight: 15, isPhi: true, label: "Patient Name" },
  medical_record_number: { weight: 35, isPhi: true, label: "MRN" },
  mrn: { weight: 35, isPhi: true, label: "MRN" },
  member_id: { weight: 25, isPhi: true, label: "Insurance ID" },
  insurance_id: { weight: 25, isPhi: true, label: "Insurance ID" },
  mbi: { weight: 25, isPhi: true, label: "Medicare ID" },
  npi: { weight: 20, isPhi: true, label: "Provider NPI" },
  dea: { weight: 25, isPhi: true, label: "DEA Number" },
  dob: { weight: 20, isPhi: true, label: "DOB" },
  diagnosis: { weight: 25, isPhi: true, label: "Diagnosis Code" },
  treatment: { weight: 30, isPhi: true, label: "Treatment Data" },
  medication: { weight: 20, isPhi: true, label: "Medication" },
  lab_results: { weight: 30, isPhi: true, label: "Lab Results" },
  provider_notes: { weight: 35, isPhi: true, label: "Provider Notes" },
};

/** Action Risk Modifiers */
export const ACTION_RISK_TABLE: Record<ComplianceAction, number> = {
  view: 0,
  copy: 10,
  paste: 15,
  upload: 20,
  share: 25,
  download: 10,
};

/**
 * Standard Combination Rules.
 * Single fields rarely create HIPAA violations; combinations do.
 */
export const DEFAULT_COMBINATION_RULES: readonly CombinationRule[] = [
  // Rule F: Complete Patient Profile (+80)
  {
    id: "RULE_F",
    name: "Complete Patient Profile",
    requiredEntities: ["patient_name", "dob", "mrn", "diagnosis", "treatment"],
    bonusScore: 80,
    minimumAction: "BLOCK",
  },
  // Rule E: MRN + DOB + Diagnosis (+50)
  {
    id: "RULE_E",
    name: "MRN + DOB + Diagnosis",
    requiredEntities: ["mrn", "dob", "diagnosis"],
    bonusScore: 50,
    minimumAction: "BLOCK",
  },
  // Rule B: Patient Name + MRN (+40)
  {
    id: "RULE_B",
    name: "Patient Name + MRN",
    requiredEntities: ["patient_name", "mrn"],
    bonusScore: 40,
    minimumAction: "MASK",
  },
  // Rule C: Patient Name + Diagnosis (+35)
  {
    id: "RULE_C",
    name: "Patient Name + Diagnosis",
    requiredEntities: ["patient_name", "diagnosis"],
    bonusScore: 35,
    minimumAction: "MASK",
  },
  // Rule D: Patient Name + Treatment (+35)
  {
    id: "RULE_D",
    name: "Patient Name + Treatment",
    requiredEntities: ["patient_name", "treatment"],
    bonusScore: 35,
    minimumAction: "MASK",
  },
  // Rule A: Patient Name + DOB (+25)
  {
    id: "RULE_A",
    name: "Patient Name + DOB",
    requiredEntities: ["patient_name", "dob"],
    bonusScore: 25,
    minimumAction: "WARN",
  },
];

/** HIPAA Rule Pack aliases */
export const HIPAA_RULE_PACK: Record<string, { contains: string[]; action: ComplianceDecision }> = {
  "GW-PHI-001": { contains: ["patient_name", "dob"], action: "WARN" },
  "GW-PHI-002": { contains: ["patient_name", "mrn"], action: "MASK" },
  "GW-PHI-003": { contains: ["patient_name", "diagnosis"], action: "MASK" },
  "GW-PHI-004": { contains: ["mrn", "dob", "diagnosis"], action: "BLOCK" },
  "GW-PHI-005": { contains: ["patient_name", "dob", "mrn", "diagnosis"], action: "BLOCK" },
};

/** Normalize category alias (e.g. possible_name -> patient_name, medical_record_number -> mrn) */
export function normalizeCategoryName(category: string): string {
  const c = category.toLowerCase().trim();
  if (c === "possible_name") return "patient_name";
  if (c === "medical_record_number") return "mrn";
  if (c === "member_id" || c === "mbi") return "insurance_id";
  return c;
}

/** Check if a category represents Protected Health Information (PHI) */
export function isPhiCategory(category: string): boolean {
  const norm = normalizeCategoryName(category);
  const entry = BASE_SENSITIVITY_TABLE[norm];
  if (entry) return entry.isPhi;
  return ["patient_name", "mrn", "dob", "insurance_id", "diagnosis", "treatment", "medication", "lab_results", "provider_notes", "npi", "dea"].includes(norm);
}

/** Calculate Volume Risk modifier */
export function calculateVolumeRisk(matchCount: number): number {
  if (matchCount <= 5) return 0;
  if (matchCount <= 20) return 10;
  if (matchCount <= 50) return 20;
  return 30;
}

/** Resolve Confidence Modifier: High (1.0), Medium (0.8), Low (0.5) */
export function resolveConfidenceModifier(avgConfidence: number): number {
  if (avgConfidence >= 0.85) return 1.0;
  if (avgConfidence >= 0.6) return 0.8;
  return 0.5;
}

/** Convert numerical risk score to risk band */
export function scoreToRiskBand(score: number): RiskBand {
  if (score >= 90) return "CRITICAL";
  if (score >= 70) return "HIGH";
  if (score >= 50) return "MEDIUM";
  if (score >= 25) return "LOW";
  return "INFORMATIONAL";
}

/** Map risk band to default compliance action */
export function bandToDefaultDecision(band: RiskBand): ComplianceDecision {
  switch (band) {
    case "CRITICAL":
      return "BLOCK";
    case "HIGH":
      return "MASK";
    case "MEDIUM":
      return "WARN";
    case "LOW":
      return "ALLOW";
    case "INFORMATIONAL":
      return "LOG";
  }
}

/** Format human-readable explanation string that compliance officers and auditors love */
export function formatExplainableReason(
  decision: ComplianceDecision,
  riskScore: number,
  entities: string[],
  destinationName: string,
  isAiLeakage: boolean
): string {
  if (isAiLeakage) {
    return `Blocked because: PHI disclosure to external AI system (${destinationName}) = ${riskScore} Risk`;
  }

  const prefix = decision === "BLOCK"
    ? "Blocked because:"
    : decision === "MASK"
    ? "Mask required because:"
    : decision === "WARN"
    ? "Warning:"
    : "Evaluated:";

  const entityLabels = entities.map((e) => {
    const norm = normalizeCategoryName(e);
    return BASE_SENSITIVITY_TABLE[norm]?.label ?? e;
  });

  const parts = [...entityLabels];
  if (destinationName) {
    parts.push(destinationName);
  }

  return `${prefix} ${parts.join(" + ")} = ${riskScore} Risk`;
}

/** Clinical context detectors for clinical entities in prose */
const CLINICAL_CONTEXT_DETECTORS: Array<{
  category: string;
  regex: RegExp;
  confidence: number;
}> = [
  {
    category: "diagnosis",
    regex: /\b(?:diagnosis|dx|icd-?10(?:-cm)?|assessment|impression)\s*[:#=]?\s*([A-TV-Z][0-9][0-9AB](?:\.[0-9A-KXZ]{1,4})?|[A-Za-z0-9\s-]{3,35})/gi,
    confidence: 0.9,
  },
  {
    category: "treatment",
    regex: /\b(?:treatment|cpt(?:-4)?|procedure|tx|intervention)\s*[:#=]?\s*(\b\d{4}[0-9A-Z]\b|[A-Za-z0-9\s-]{3,35})/gi,
    confidence: 0.85,
  },
  {
    category: "medication",
    regex: /\b(?:rx|medication|refill|prescribed|dosage)\s*[:#=]?\s*([A-Za-z0-9\s-]{3,35}(?:\d+\s*(?:mg|mcg|ml|units?)\b)?)/gi,
    confidence: 0.9,
  },
  {
    category: "lab_results",
    regex: /\b(?:lab\s*results?|lab\s*values?|specimen|loinc)\s*[:#=]?\s*([A-Za-z0-9\s-]{3,35})/gi,
    confidence: 0.85,
  },
  {
    category: "driver_license",
    regex: /\b(?:driver'?s?\s*license|dl|driver\s*id)\s*[:#=]?\s*([A-Z0-9-]{6,14})\b/gi,
    confidence: 0.9,
  },
  {
    category: "provider_notes",
    regex: /\b(?:provider\s*notes?|clinical\s*notes?|physician\s*notes?|progress\s*notes?)\s*[:#=]?\s*([^\n]{5,50})/gi,
    confidence: 0.85,
  },
];

/**
 * Extract both standard detected matches and clinical contextual findings from text.
 */
export function extractComplianceFindings(
  text: string,
  baseMatches: Array<{ category: string; confidence?: number; value?: string }> = []
): ComplianceFindingInput[] {
  const findings: ComplianceFindingInput[] = baseMatches.map((m) => ({
    category: normalizeCategoryName(m.category),
    confidence: m.confidence ?? 1.0,
    value: m.value,
  }));

  if (!text || typeof text !== "string") {
    return findings;
  }

  const existingCategories = new Set(findings.map((f) => f.category));

  for (const detector of CLINICAL_CONTEXT_DETECTORS) {
    if (existingCategories.has(detector.category)) continue;
    detector.regex.lastIndex = 0;
    const match = detector.regex.exec(text);
    if (match) {
      findings.push({
        category: detector.category,
        confidence: detector.confidence,
        value: match[1]?.trim() || match[0].trim(),
      });
      existingCategories.add(detector.category);
    }
  }

  // Layered Evidence Graph integration (Layers 2-6)
  const evidenceGraph = extractPHIEvidenceGraph(text);
  if (evidenceGraph.icdCodes.length > 0 && !existingCategories.has("diagnosis")) {
    findings.push({
      category: "diagnosis",
      confidence: 0.95,
      value: evidenceGraph.icdCodes[0],
    });
    existingCategories.add("diagnosis");
  }
  if (evidenceGraph.medicationMatches.length > 0 && !existingCategories.has("medication")) {
    findings.push({
      category: "medication",
      confidence: 0.9,
      value: evidenceGraph.medicationMatches[0],
    });
    existingCategories.add("medication");
  }
  if (evidenceGraph.cptCodes.length > 0 && !existingCategories.has("treatment")) {
    findings.push({
      category: "treatment",
      confidence: 0.9,
      value: evidenceGraph.cptCodes[0],
    });
    existingCategories.add("treatment");
  }
  if (evidenceGraph.documentSignatures.length > 0 && !existingCategories.has("provider_notes")) {
    findings.push({
      category: "provider_notes",
      confidence: 0.9,
      value: evidenceGraph.documentSignatures[0],
    });
    existingCategories.add("provider_notes");
  }

  return findings;
}

/**
 * Evaluates the Explainable Compliance Score for findings and destination.
 */
export function evaluateComplianceScore(
  findings: ComplianceFindingInput[],
  destination: DestinationClassification,
  action: ComplianceAction = "paste",
  customRules: CombinationRule[] = []
): ComplianceEvaluation {
  // Aggregate entity counts and confidences
  const entityCounts: Record<string, number> = {};
  let totalConfidence = 0;
  let totalMatches = 0;
  let phiFound = false;

  for (const f of findings) {
    const norm = normalizeCategoryName(f.category);
    const count = f.count && f.count > 0 ? f.count : 1;
    entityCounts[norm] = (entityCounts[norm] ?? 0) + count;
    totalMatches += count;
    const conf = typeof f.confidence === "number" && !isNaN(f.confidence) ? f.confidence : 1.0;
    totalConfidence += conf * count;

    if (isPhiCategory(norm)) {
      phiFound = true;
    }
  }

  const uniqueEntities = Object.keys(entityCounts);

  // 1. Base Data Sensitivity (sum of base weights for unique entities present)
  let baseSensitivity = 0;
  for (const entity of uniqueEntities) {
    const entry = BASE_SENSITIVITY_TABLE[entity];
    if (entry) {
      baseSensitivity += entry.weight;
    } else {
      baseSensitivity += 10; // Default weight for uncatalogued custom entities
    }
  }

  // 2. Confidence Modifier
  const avgConfidence = totalMatches > 0 ? totalConfidence / totalMatches : 1.0;
  const confidenceModifier = resolveConfidenceModifier(avgConfidence);
  const adjustedSensitivity = Math.round(baseSensitivity * confidenceModifier);

  // 3. Combination Rules Engine
  const rules = [...customRules, ...DEFAULT_COMBINATION_RULES];
  let combinationBonus = 0;
  const appliedRules: string[] = [];
  let forcedMinDecision: ComplianceDecision | null = null;

  for (const rule of rules) {
    const matchesAll = rule.requiredEntities.every((req) =>
      uniqueEntities.includes(normalizeCategoryName(req))
    );
    if (matchesAll) {
      combinationBonus += rule.bonusScore;
      appliedRules.push(rule.name);
      if (rule.minimumAction) {
        if (!forcedMinDecision) {
          forcedMinDecision = rule.minimumAction;
        } else {
          // Escalate if needed (BLOCK > MASK > WARN > ALLOW > LOG)
          const hierarchy: ComplianceDecision[] = ["LOG", "ALLOW", "WARN", "MASK", "BLOCK"];
          if (hierarchy.indexOf(rule.minimumAction) > hierarchy.indexOf(forcedMinDecision)) {
            forcedMinDecision = rule.minimumAction;
          }
        }
      }
      // If Rule F matches (Complete profile), we break to prevent duplicate lower-order rule inflation
      if (rule.id === "RULE_F") {
        break;
      }
    }
  }

  // 4. Volume Risk
  const volumeRisk = calculateVolumeRisk(totalMatches);

  // 5. Destination Risk
  const destinationRisk = destination.risk;

  // 6. Action Risk
  const actionRisk = ACTION_RISK_TABLE[action] ?? 0;

  // 7. Check Secret Weapon: AI Leakage Rule
  // PHI Present + External AI Destination (untrusted) + Paste / Upload Action -> 100 BLOCK
  const aiLeakageTriggered =
    phiFound &&
    destination.category === "EXTERNAL_AI" &&
    !destination.isTrusted &&
    (action === "paste" || action === "upload");

  let rawTotal = adjustedSensitivity + combinationBonus + volumeRisk + destinationRisk + actionRisk;
  let finalScore = Math.min(100, Math.max(0, rawTotal));

  let finalDecision: ComplianceDecision;
  let riskBand: RiskBand;

  if (aiLeakageTriggered) {
    finalScore = 100;
    riskBand = "CRITICAL";
    finalDecision = "BLOCK";
  } else {
    riskBand = scoreToRiskBand(finalScore);
    finalDecision = bandToDefaultDecision(riskBand);

    // Apply minimum forced decision from combination rules if higher than default band decision
    if (forcedMinDecision) {
      const hierarchy: ComplianceDecision[] = ["LOG", "ALLOW", "WARN", "MASK", "BLOCK"];
      if (hierarchy.indexOf(forcedMinDecision) > hierarchy.indexOf(finalDecision)) {
        finalDecision = forcedMinDecision;
      }
    }
  }

  const destLabel = destination.category === "EXTERNAL_AI"
    ? "AI Destination"
    : destination.category === "PERSONAL_STORAGE"
    ? "Cloud Storage"
    : destination.serviceName ?? destination.hostname;

  const reason = formatExplainableReason(
    finalDecision,
    finalScore,
    uniqueEntities,
    destLabel,
    aiLeakageTriggered
  );

  return {
    who: "User",
    what: uniqueEntities.map((e) => BASE_SENSITIVITY_TABLE[e]?.label ?? e),
    where: destination.hostname || "browser",
    how: action.toUpperCase(),
    riskScore: finalScore,
    riskBand,
    decision: finalDecision,
    reason,
    factors: {
      baseSensitivity,
      confidenceModifier,
      adjustedSensitivity,
      combinationBonus,
      volumeRisk,
      destinationRisk,
      actionRisk,
      aiLeakageTriggered,
      appliedRules,
      entityCounts,
    },
    destination,
    action,
  };
}
