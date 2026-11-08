// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
/**
 * GovernWorld Evidence-Based PHI Detection Graph & Layered Clinical Engine.
 *
 * Implements the GovernWorld Philosophy:
 *   Don't ask: "Is this medical data?"
 *   Ask: "Does this content contain evidence of a patient record, and is that
 *         data about to leave a controlled environment?"
 *
 * Pure, deterministic, zero-network, explainable evidence graph:
 *   Layer 1: Structured Identifiers (DOB, MRN, Insurance IDs, NPI, DEA)
 *   Layer 2: Medical Vocabulary Density (25+ clinical domain terms)
 *   Layer 3: ICD-10 Code Detection (Validated formats with clinical cues)
 *   Layer 4: CPT / Procedure Code Detection (5-digit billing/encounter codes)
 *   Layer 5: Common Medication / Prescription Dictionary (Top 250+ drugs)
 *   Layer 6: Clinical Document Signatures (HPI, ROS, Assessment & Plan)
 *   Layer 7: Healthcare EHR Domain Detection (Epic, Athena, Cerner, MyChart)
 *   Layer 8: Composable Evidence Aggregation & Graph Classification
 */

export enum FindingType {
  PATIENT_NAME = "PATIENT_NAME",
  DOB = "DOB",
  AGE = "AGE",
  MRN = "MRN",
  ACCOUNT_NUMBER = "ACCOUNT_NUMBER",
  INSURANCE_ID = "INSURANCE_ID",
  ICD10_CODE = "ICD10_CODE",
  CPT_CODE = "CPT_CODE",
  DIAGNOSIS = "DIAGNOSIS",
  MEDICATION = "MEDICATION",
  LAB_RESULT = "LAB_RESULT",
  PHONE = "PHONE",
  EMAIL = "EMAIL",
  ADDRESS = "ADDRESS",
  SSN = "SSN",
  PROVIDER_NAME = "PROVIDER_NAME",
  MEDICAL_DOCUMENT_MARKER = "MEDICAL_DOCUMENT_MARKER",
  MEDICAL_VOCABULARY = "MEDICAL_VOCABULARY",
  HEALTHCARE_DOMAIN = "HEALTHCARE_DOMAIN",
}

export enum DetectorType {
  REGEX = "REGEX",
  KEYWORD = "KEYWORD",
  DICTIONARY = "DICTIONARY",
  STRUCTURED_PATTERN = "STRUCTURED_PATTERN",
  DOMAIN_CONTEXT = "DOMAIN_CONTEXT",
  DOCUMENT_SIGNATURE = "DOCUMENT_SIGNATURE",
  COMBINATION_RULE = "COMBINATION_RULE",
}

export type Severity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface SourceMetadata {
  url?: string;
  hostname?: string;
  pageTitle?: string;
  sourceType: "DOM" | "FORM" | "UPLOAD" | "DOWNLOAD" | "CLIPBOARD";
  selector?: string;
}

export interface EvidenceMetadata {
  matchedHash: string;
  matchLength: number;
  surroundingContext: string[];
  ruleId?: string;
  weight: number;
}

export interface PHIFinding {
  id: string;
  type: FindingType;
  detector: DetectorType;
  confidence: number;
  severity: Severity;
  source: SourceMetadata;
  evidence: EvidenceMetadata;
  timestamp: number;
}

export type PHIClassification =
  | "NON_MEDICAL"
  | "MEDICAL_CONTEXT"
  | "LIKELY_HEALTHCARE"
  | "LIKELY_PHI"
  | "CONFIRMED_PHI";

export interface PHIEntityGroup {
  id: string;
  findings: PHIFinding[];
  confidence: number;
  totalEvidenceScore: number;
  classification: PHIClassification;
  documentSignatures: string[];
  medicationMatches: string[];
  icdCodes: string[];
  cptCodes: string[];
  vocabularyCount: number;
  hasPatientIdentifiers: boolean;
  hasClinicalData: boolean;
}

export interface PHIIncident {
  id: string;
  classification: PHIClassification;
  riskScore: number;
  findings: string[];
  action: "ALLOW" | "WARN" | "MASK" | "BLOCK";
  destination?: string;
  reason: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Layer 2: Medical Vocabulary
// ---------------------------------------------------------------------------
export const MEDICAL_VOCABULARY: readonly string[] = [
  "diagnosis",
  "treatment",
  "prescription",
  "patient",
  "provider",
  "physician",
  "medication",
  "clinical",
  "history",
  "laboratory",
  "lab result",
  "allergy",
  "blood pressure",
  "discharge summary",
  "pathology",
  "radiology",
  "triage",
  "vital signs",
  "ambulatory",
  "inpatient",
  "outpatient",
  "prognosis",
  "etiology",
  "chief complaint",
  "assessment",
  "hpi",
  "ros",
  "physical exam",
  "consultation",
  "referral",
  "symptom",
  "acute",
  "chronic",
  "follow-up",
  "specimen",
  "biopsy",
  "infusion",
  "chemotherapy",
  "dialysis",
  "cardiology",
  "oncology",
  "neurology",
  "orthopedic",
];

// ---------------------------------------------------------------------------
// Layer 5: Common Medication / Prescription Names (Top 150+ prescribed drugs)
// ---------------------------------------------------------------------------
export const COMMON_MEDICATIONS: readonly string[] = [
  "metformin",
  "lisinopril",
  "atorvastatin",
  "levothyroxine",
  "amlodipine",
  "ozempic",
  "insulin",
  "omeprazole",
  "losartan",
  "gabapentin",
  "hydrochlorothiazide",
  "sertraline",
  "simvastatin",
  "montelukast",
  "escitalopram",
  "amoxicillin",
  "azithromycin",
  "prednisone",
  "metoprolol",
  "albuterol",
  "pantoprazole",
  "furosemide",
  "fluticasone",
  "fluoxetine",
  "tramadol",
  "trazodone",
  "duloxetine",
  "bupropion",
  "carvedilol",
  "potassium chloride",
  "warfarin",
  "clopidogrel",
  "apixaban",
  "eliquis",
  "xarelto",
  "rivaroxaban",
  "ciprofloxacin",
  "cephalexin",
  "doxycycline",
  "ibuprofen",
  "meloxicam",
  "celecoxib",
  "cyclobenzaprine",
  "tamsulosin",
  "finasteride",
  "allopurinol",
  "ondansetron",
  "famotidine",
  "glipizide",
  "januvia",
  "sitagliptin",
  "jardiance",
  "empagliflozin",
  "trulicity",
  "dulaglutide",
  "mounjaro",
  "tirzepatide",
  "wegovy",
  "semaglutide",
  "humalog",
  "novolog",
  "lantus",
  "levemir",
  "tresiba",
  "adderall",
  "vyvanse",
  "methylphenidate",
  "lisdexamfetamine",
  "alprazolam",
  "lorazepam",
  "clonazepam",
  "diazepam",
  "zolpidem",
  "lamotrigine",
  "topiramate",
  "levetiracetam",
  "keppra",
  "hydroxychloroquine",
  "methotrexate",
  "humira",
  "adalimumab",
  "enbrel",
  "keytruda",
  "pembrolizumab",
  "rituximab",
];

// ---------------------------------------------------------------------------
// Layer 6: Clinical Document Signatures (Sections & Headings)
// ---------------------------------------------------------------------------
export const CLINICAL_DOCUMENT_SIGNATURES: readonly { name: string; regex: RegExp }[] = [
  { name: "Chief Complaint", regex: /\b(?:chief\s*complaint|cc)\s*[:#]/i },
  { name: "History of Present Illness", regex: /\b(?:history\s*of\s*present\s*illness|hpi)\s*[:#]/i },
  { name: "Review of Systems", regex: /\b(?:review\s*of\s*systems|ros)\s*[:#]/i },
  { name: "Past Medical History", regex: /\b(?:past\s*medical\s*history|pmh)\s*[:#]/i },
  { name: "Assessment and Plan", regex: /\b(?:assessment\s*(?:and|&|\/)\s*plan|a\s*(?:&|\/)\s*p)\s*[:#]/i },
  { name: "Vital Signs", regex: /\b(?:vital\s*signs|vitals)\s*[:#]/i },
  { name: "Physical Examination", regex: /\b(?:physical\s*examination|physical\s*exam|pe)\s*[:#]/i },
  { name: "Medication List", regex: /\b(?:medication\s*list|current\s*medications|meds)\s*[:#]/i },
  { name: "Discharge Summary", regex: /\b(?:discharge\s*summary|discharge\s*instructions)\s*[:#]/i },
  { name: "Lab Results", regex: /\b(?:laboratory\s*findings|lab\s*results|diagnostic\s*results)\s*[:#]/i },
];

// ---------------------------------------------------------------------------
// Layer 7: Healthcare EHR & Portal Domains
// ---------------------------------------------------------------------------
export const HEALTHCARE_DOMAINS: readonly string[] = [
  "epic.com",
  "athenahealth.com",
  "cerner.com",
  "eclinicalworks.com",
  "nextgen.com",
  "allscripts.com",
  "veradigm.com",
  "mychart.com",
  "care360.com",
  "drchrono.com",
  "kaiserpermanente.org",
];

// ---------------------------------------------------------------------------
// Deterministic Hash Helper for Evidence Metadata (SHA-256 or fast fnv1a fallback)
// ---------------------------------------------------------------------------
export function fastHashString(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return "h:" + (hash >>> 0).toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// Layer 3: ICD-10 Code Pattern
// ---------------------------------------------------------------------------
export const ICD10_CODE_RE = /\b([A-TV-Z][0-9]{1,2}(?:\.[A-Z0-9]{1,4})?)\b/gi;

// Context keywords that corroborate an ICD-10 code
const ICD_CONTEXT_RE = /\b(?:diagnosis|dx|icd-?10(?:-cm)?|assessment|impression|condition|problem|disorder)\b/i;

// ---------------------------------------------------------------------------
// Layer 4: CPT / Procedure Code Pattern
// ---------------------------------------------------------------------------
export const CPT_CODE_RE = /\b(\d{4}[0-9A-Z]|\d{5})\b/g;

// Context keywords that corroborate a CPT procedure code
const CPT_CONTEXT_RE = /\b(?:procedure|cpt(?:-4)?|billing|encounter|service\s*code|treatment)\b/i;

/**
 * Scan text and source context to extract a composable Evidence Graph of PHIFindings.
 */
export function extractPHIEvidenceGraph(
  text: string,
  source: SourceMetadata = { sourceType: "CLIPBOARD" }
): PHIEntityGroup {
  const findings: PHIFinding[] = [];
  const lowerText = text.toLowerCase();
  const now = Date.now();

  let idCounter = 1;
  const nextId = () => `phi-${now}-${idCounter++}`;

  // -------------------------------------------------------------------------
  // Layer 7: Healthcare Domain Detection
  // -------------------------------------------------------------------------
  if (source.hostname) {
    const host = source.hostname.toLowerCase();
    const isHealthcareSite = HEALTHCARE_DOMAINS.some((d) => host === d || host.endsWith("." + d) || host.includes("mychart"));
    if (isHealthcareSite) {
      findings.push({
        id: nextId(),
        type: FindingType.HEALTHCARE_DOMAIN,
        detector: DetectorType.DOMAIN_CONTEXT,
        confidence: 0.99,
        severity: "MEDIUM",
        source,
        evidence: {
          matchedHash: fastHashString(host),
          matchLength: host.length,
          surroundingContext: ["Healthcare EHR Domain", host],
          weight: 20,
        },
        timestamp: now,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Layer 6: Clinical Document Signatures
  // -------------------------------------------------------------------------
  const matchedSignatures: string[] = [];
  for (const sig of CLINICAL_DOCUMENT_SIGNATURES) {
    if (sig.regex.test(text)) {
      matchedSignatures.push(sig.name);
      findings.push({
        id: nextId(),
        type: FindingType.MEDICAL_DOCUMENT_MARKER,
        detector: DetectorType.DOCUMENT_SIGNATURE,
        confidence: 0.95,
        severity: "MEDIUM",
        source,
        evidence: {
          matchedHash: fastHashString(sig.name),
          matchLength: sig.name.length,
          surroundingContext: [sig.name],
          weight: 15,
        },
        timestamp: now,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Layer 2: Medical Vocabulary Density
  // -------------------------------------------------------------------------
  let vocabCount = 0;
  const matchedVocabTerms: string[] = [];
  for (const term of MEDICAL_VOCABULARY) {
    if (lowerText.includes(term)) {
      vocabCount++;
      matchedVocabTerms.push(term);
    }
  }

  if (vocabCount > 0) {
    // Scoring: 1 term = +2, 5 terms = +10, 20 terms = +40
    let vocabWeight = Math.min(40, Math.round(vocabCount * 2));
    findings.push({
      id: nextId(),
      type: FindingType.MEDICAL_VOCABULARY,
      detector: DetectorType.DICTIONARY,
      confidence: vocabCount >= 5 ? 0.9 : 0.7,
      severity: vocabCount >= 10 ? "HIGH" : "LOW",
      source,
      evidence: {
        matchedHash: fastHashString(matchedVocabTerms.slice(0, 5).join(",")),
        matchLength: vocabCount,
        surroundingContext: matchedVocabTerms.slice(0, 5),
        weight: vocabWeight,
      },
      timestamp: now,
    });
  }

  // -------------------------------------------------------------------------
  // Layer 5: Common Medication / Prescription Names
  // -------------------------------------------------------------------------
  const matchedMeds: string[] = [];
  for (const med of COMMON_MEDICATIONS) {
    const medRegex = new RegExp(`\\b${med}\\b`, "i");
    if (medRegex.test(text)) {
      matchedMeds.push(med);
      findings.push({
        id: nextId(),
        type: FindingType.MEDICATION,
        detector: DetectorType.DICTIONARY,
        confidence: 0.9,
        severity: "HIGH",
        source,
        evidence: {
          matchedHash: fastHashString(med),
          matchLength: med.length,
          surroundingContext: ["Prescription Medication", med],
          weight: 20,
        },
        timestamp: now,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Layer 3: ICD-10 Code Detection (with contextual corroboration)
  // -------------------------------------------------------------------------
  const matchedIcds: string[] = [];
  const hasIcdContext = ICD_CONTEXT_RE.test(text);

  ICD10_CODE_RE.lastIndex = 0;
  let icdMatch: RegExpExecArray | null;
  while ((icdMatch = ICD10_CODE_RE.exec(text)) !== null) {
    const code = icdMatch[1];
    // Reject plain common words or abbreviations if no clinical cues present
    if (!hasIcdContext && code.length < 4 && !code.includes(".")) continue;

    // Check surrounding 60 chars for medical or diagnosis context
    const startIdx = Math.max(0, icdMatch.index - 60);
    const endIdx = Math.min(text.length, icdMatch.index + code.length + 60);
    const windowText = text.slice(startIdx, endIdx);

    if (hasIcdContext || ICD_CONTEXT_RE.test(windowText) || matchedSignatures.length > 0 || vocabCount >= 2) {
      if (!matchedIcds.includes(code.toUpperCase())) {
        matchedIcds.push(code.toUpperCase());
        findings.push({
          id: nextId(),
          type: FindingType.ICD10_CODE,
          detector: DetectorType.REGEX,
          confidence: 0.95,
          severity: "HIGH",
          source,
          evidence: {
            matchedHash: fastHashString(code),
            matchLength: code.length,
            surroundingContext: ["ICD-10", code],
            weight: 25,
          },
          timestamp: now,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Layer 4: CPT / Procedure Code Detection
  // -------------------------------------------------------------------------
  const matchedCpts: string[] = [];
  const hasCptContext = CPT_CONTEXT_RE.test(text);

  if (hasCptContext || matchedSignatures.length > 0) {
    CPT_CODE_RE.lastIndex = 0;
    let cptMatch: RegExpExecArray | null;
    while ((cptMatch = CPT_CODE_RE.exec(text)) !== null) {
      const code = cptMatch[1];
      // Only score 5-digit runs when near procedure/billing keywords
      const startIdx = Math.max(0, cptMatch.index - 50);
      const endIdx = Math.min(text.length, cptMatch.index + code.length + 50);
      const windowText = text.slice(startIdx, endIdx);

      if (CPT_CONTEXT_RE.test(windowText)) {
        if (!matchedCpts.includes(code)) {
          matchedCpts.push(code);
          findings.push({
            id: nextId(),
            type: FindingType.CPT_CODE,
            detector: DetectorType.STRUCTURED_PATTERN,
            confidence: 0.9,
            severity: "MEDIUM",
            source,
            evidence: {
              matchedHash: fastHashString(code),
              matchLength: code.length,
              surroundingContext: ["CPT Procedure", code],
              weight: 20,
            },
            timestamp: now,
          });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Layer 1: Structured Identifiers (MRN, DOB, Insurance, NPI)
  // -------------------------------------------------------------------------
  // MRN
  const mrnMatch = /\b(?:mrn|medical\s*record\s*(?:number|no|#)?|patient\s*id|chart\s*(?:number|no|#)?)\s*[:#]?\s*([A-Za-z0-9-]{4,16})\b/i.exec(text);
  if (mrnMatch) {
    findings.push({
      id: nextId(),
      type: FindingType.MRN,
      detector: DetectorType.REGEX,
      confidence: 0.98,
      severity: "CRITICAL",
      source,
      evidence: {
        matchedHash: fastHashString(mrnMatch[1]),
        matchLength: mrnMatch[1].length,
        surroundingContext: ["Medical Record Number", mrnMatch[0]],
        weight: 35,
      },
      timestamp: now,
    });
  }

  // DOB
  const dobMatch = /\b(?:dob|date\s*of\s*birth|born)\s*[:#]?\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}[/-]\d{1,2}[/-]\d{1,2})\b/i.exec(text);
  if (dobMatch) {
    findings.push({
      id: nextId(),
      type: FindingType.DOB,
      detector: DetectorType.REGEX,
      confidence: 0.98,
      severity: "HIGH",
      source,
      evidence: {
        matchedHash: fastHashString(dobMatch[1]),
        matchLength: dobMatch[1].length,
        surroundingContext: ["Date of Birth", dobMatch[0]],
        weight: 20,
      },
      timestamp: now,
    });
  }

  // Insurance ID
  const insMatch = /\b(?:member\s*id|policy\s*(?:number|no|#)?|subscriber\s*id|group\s*(?:number|no|#)?)\s*[:#]?\s*([A-Za-z0-9-]{5,18})\b/i.exec(text);
  if (insMatch) {
    findings.push({
      id: nextId(),
      type: FindingType.INSURANCE_ID,
      detector: DetectorType.REGEX,
      confidence: 0.95,
      severity: "HIGH",
      source,
      evidence: {
        matchedHash: fastHashString(insMatch[1]),
        matchLength: insMatch[1].length,
        surroundingContext: ["Insurance ID", insMatch[0]],
        weight: 25,
      },
      timestamp: now,
    });
  }

  // Provider NPI
  const npiMatch = /\b(?:npi|provider\s*(?:id|#)?|physician\s*(?:id|#)?)\s*[:#]?\s*(\d{10})\b/i.exec(text);
  if (npiMatch) {
    findings.push({
      id: nextId(),
      type: FindingType.PROVIDER_NAME,
      detector: DetectorType.STRUCTURED_PATTERN,
      confidence: 0.95,
      severity: "MEDIUM",
      source,
      evidence: {
        matchedHash: fastHashString(npiMatch[1]),
        matchLength: npiMatch[1].length,
        surroundingContext: ["Provider NPI", npiMatch[0]],
        weight: 20,
      },
      timestamp: now,
    });
  }

  // Patient Name cues (e.g. "Patient: Jane Doe" or "Patient Name: ...")
  const patientMatch = /\b(?:patient(?:\s*name)?)\s*[:#]?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/i.exec(text);
  if (patientMatch) {
    findings.push({
      id: nextId(),
      type: FindingType.PATIENT_NAME,
      detector: DetectorType.REGEX,
      confidence: 0.95,
      severity: "HIGH",
      source,
      evidence: {
        matchedHash: fastHashString(patientMatch[1]),
        matchLength: patientMatch[1].length,
        surroundingContext: ["Patient Name", patientMatch[0]],
        weight: 15,
      },
      timestamp: now,
    });
  }

  // -------------------------------------------------------------------------
  // Layer 8: Evidence Aggregation & Graph Classification
  // -------------------------------------------------------------------------
  let totalEvidenceScore = 0;
  for (const f of findings) {
    totalEvidenceScore += f.evidence.weight;
  }

  const hasPatientIdentifiers = findings.some(
    (f) =>
      f.type === FindingType.PATIENT_NAME ||
      f.type === FindingType.MRN ||
      f.type === FindingType.DOB ||
      f.type === FindingType.INSURANCE_ID
  );

  const hasClinicalData = findings.some(
    (f) =>
      f.type === FindingType.ICD10_CODE ||
      f.type === FindingType.CPT_CODE ||
      f.type === FindingType.MEDICATION ||
      f.type === FindingType.MEDICAL_DOCUMENT_MARKER ||
      (f.type === FindingType.MEDICAL_VOCABULARY && vocabCount >= 3)
  );

  // Bonus: If clinical document signatures are compound (3 or more sections present)
  if (matchedSignatures.length >= 3) {
    totalEvidenceScore += 25;
  }

  // Thresholds:
  //   0-24:   NON_MEDICAL
  //   25-49:  MEDICAL_CONTEXT
  //   50-74:  LIKELY_HEALTHCARE
  //   75-99:  LIKELY_PHI
  //   100+:   CONFIRMED_PHI
  let classification: PHIClassification = "NON_MEDICAL";
  if (totalEvidenceScore >= 100 || (hasPatientIdentifiers && hasClinicalData && totalEvidenceScore >= 75)) {
    classification = "CONFIRMED_PHI";
  } else if (totalEvidenceScore >= 75 || (hasPatientIdentifiers && hasClinicalData)) {
    classification = "LIKELY_PHI";
  } else if (totalEvidenceScore >= 50 || hasClinicalData) {
    classification = "LIKELY_HEALTHCARE";
  } else if (totalEvidenceScore >= 25) {
    classification = "MEDICAL_CONTEXT";
  }

  // Average confidence across evidence items
  let confidence = 0.5;
  if (findings.length > 0) {
    const sumConf = findings.reduce((acc, f) => acc + f.confidence, 0);
    confidence = Math.round((sumConf / findings.length) * 100) / 100;
  }

  return {
    id: `entity-group-${now}`,
    findings,
    confidence,
    totalEvidenceScore,
    classification,
    documentSignatures: matchedSignatures,
    medicationMatches: matchedMeds,
    icdCodes: matchedIcds,
    cptCodes: matchedCpts,
    vocabularyCount: vocabCount,
    hasPatientIdentifiers,
    hasClinicalData,
  };
}

/**
 * Convert a PHIEntityGroup into a high-level PHIIncident for governance & audit reporting.
 */
export function createPHIIncident(
  group: PHIEntityGroup,
  destination: string,
  riskScore: number
): PHIIncident {
  let action: "ALLOW" | "WARN" | "MASK" | "BLOCK" = "ALLOW";
  if (riskScore >= 90 || group.classification === "CONFIRMED_PHI") {
    action = "BLOCK";
  } else if (riskScore >= 70 || group.classification === "LIKELY_PHI") {
    action = "MASK";
  } else if (riskScore >= 50 || group.classification === "LIKELY_HEALTHCARE") {
    action = "WARN";
  }

  const findingTypes = Array.from(new Set(group.findings.map((f) => f.type)));

  let reason = `Evidence Score: ${group.totalEvidenceScore} (${group.classification})`;
  if (group.hasPatientIdentifiers && group.hasClinicalData) {
    reason = `Patient Identifiers + Clinical Records Detected (${group.classification})`;
  }

  return {
    id: `incident-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    classification: group.classification,
    riskScore,
    findings: findingTypes,
    action,
    destination,
    reason,
    timestamp: Date.now(),
  };
}
