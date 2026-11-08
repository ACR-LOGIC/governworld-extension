// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect } from "vitest";
import {
  extractPHIEvidenceGraph,
  createPHIIncident,
  fastHashString,
  FindingType,
  DetectorType,
  MEDICAL_VOCABULARY,
  COMMON_MEDICATIONS,
  CLINICAL_DOCUMENT_SIGNATURES,
  HEALTHCARE_DOMAINS,
} from "../src/shared/phiEvidence.js";

describe("GovernWorld Evidence-Based PHI Detection Graph", () => {
  describe("Layer 1: Structured Identifier Detection", () => {
    it("extracts MRN, DOB, Insurance ID, and NPI as discrete evidence items", () => {
      const text = `
        Patient: Michael Scott
        MRN: 78945612
        DOB: 03/15/1965
        Member ID: XAA123456789
        NPI: 1234567890
      `;
      const group = extractPHIEvidenceGraph(text);

      const types = group.findings.map((f) => f.type);
      expect(types).toContain(FindingType.MRN);
      expect(types).toContain(FindingType.DOB);
      expect(types).toContain(FindingType.INSURANCE_ID);
      expect(types).toContain(FindingType.PROVIDER_NAME);
      expect(types).toContain(FindingType.PATIENT_NAME);
      expect(group.hasPatientIdentifiers).toBe(true);
    });
  });

  describe("Layer 2: Medical Vocabulary Density", () => {
    it("calculates vocabulary density score based on frequency", () => {
      const singleTerm = "The diagnosis was confirmed today.";
      const g1 = extractPHIEvidenceGraph(singleTerm);
      const vocab1 = g1.findings.find((f) => f.type === FindingType.MEDICAL_VOCABULARY);
      expect(vocab1).toBeDefined();
      expect(vocab1?.evidence.weight).toBe(2); // 1 term = +2

      const multiTerms = `
        The patient presented for clinical evaluation and consultation.
        Review of laboratory findings, pathology, and biopsy specimen.
        Vital signs showed elevated blood pressure.
        Discharge summary prepared with follow-up treatment plan.
      `;
      const g2 = extractPHIEvidenceGraph(multiTerms);
      const vocab2 = g2.findings.find((f) => f.type === FindingType.MEDICAL_VOCABULARY);
      expect(vocab2).toBeDefined();
      expect(vocab2?.evidence.weight).toBeGreaterThanOrEqual(20);
      expect(g2.vocabularyCount).toBeGreaterThanOrEqual(10);
    });
  });

  describe("Layer 3: ICD-10 Code Detection", () => {
    it("detects and corroborates ICD-10 codes in diagnostic context", () => {
      const text = `
        Primary Diagnosis: E11.9 (Type 2 diabetes mellitus without complications)
        Secondary Diagnosis: I10 (Essential hypertension)
      `;
      const group = extractPHIEvidenceGraph(text);

      expect(group.icdCodes).toContain("E11.9");
      expect(group.icdCodes).toContain("I10");

      const icdFindings = group.findings.filter((f) => f.type === FindingType.ICD10_CODE);
      expect(icdFindings.length).toBe(2);
      expect(icdFindings[0].evidence.weight).toBe(25);
    });

    it("rejects isolated short codes when no medical cues or context are present", () => {
      const text = "Please review section A1 on page 2.";
      const group = extractPHIEvidenceGraph(text);
      expect(group.icdCodes.length).toBe(0);
    });
  });

  describe("Layer 4: CPT / Procedure Code Detection", () => {
    it("detects 5-digit CPT codes when bound to procedure or encounter keywords", () => {
      const text = `
        Encounter summary:
        Billing CPT: 99214 Level 4 Office Visit
        Procedure code: 80053 Comprehensive Metabolic Panel
      `;
      const group = extractPHIEvidenceGraph(text);

      expect(group.cptCodes).toContain("99214");
      expect(group.cptCodes).toContain("80053");

      const cptFindings = group.findings.filter((f) => f.type === FindingType.CPT_CODE);
      expect(cptFindings.length).toBe(2);
      expect(cptFindings[0].evidence.weight).toBe(20);
    });

    it("ignores ordinary 5-digit numbers without procedure context (e.g. zip codes)", () => {
      const text = "Shipped package to zip code 90210 via standard delivery.";
      const group = extractPHIEvidenceGraph(text);
      expect(group.cptCodes.length).toBe(0);
    });
  });

  describe("Layer 5: Common Medication / Prescription Dictionary", () => {
    it("matches recognized prescription drugs against local dictionary", () => {
      const text = `
        Current Medications:
        Metformin 500mg PO BID
        Lisinopril 10mg daily
        Ozempic 0.5mg subcutaneous injection weekly
        Atorvastatin 20mg at bedtime
      `;
      const group = extractPHIEvidenceGraph(text);

      expect(group.medicationMatches).toContain("metformin");
      expect(group.medicationMatches).toContain("lisinopril");
      expect(group.medicationMatches).toContain("ozempic");
      expect(group.medicationMatches).toContain("atorvastatin");

      const medFindings = group.findings.filter((f) => f.type === FindingType.MEDICATION);
      expect(medFindings.length).toBe(4);
      expect(medFindings[0].detector).toBe(DetectorType.DICTIONARY);
    });
  });

  describe("Layer 6: Clinical Document Signatures", () => {
    it("identifies standard EHR section markers and rewards compound structure", () => {
      const text = `
        Chief Complaint: Acute chest tightness
        History of Present Illness: 54yo male with 2-day worsening dyspnea.
        Review of Systems: Positive for shortness of breath, negative for fever.
        Assessment and Plan: Acute coronary syndrome workup initiated.
        Vital Signs: BP 142/88, HR 92, SpO2 97% on room air.
      `;
      const group = extractPHIEvidenceGraph(text);

      expect(group.documentSignatures).toContain("Chief Complaint");
      expect(group.documentSignatures).toContain("History of Present Illness");
      expect(group.documentSignatures).toContain("Review of Systems");
      expect(group.documentSignatures).toContain("Assessment and Plan");
      expect(group.documentSignatures).toContain("Vital Signs");
      expect(group.documentSignatures.length).toBeGreaterThanOrEqual(3);

      // Compound document signature boost applied
      expect(group.totalEvidenceScore).toBeGreaterThanOrEqual(75);
    });
  });

  describe("Layer 7: Healthcare Domain Detection", () => {
    it("recognizes healthcare EHR websites as high-context domain sources", () => {
      const text = "Patient chart notes review.";
      const source = {
        hostname: "subdomain.athenahealth.com",
        sourceType: "DOM" as const,
      };
      const group = extractPHIEvidenceGraph(text, source);

      const domainFinding = group.findings.find((f) => f.type === FindingType.HEALTHCARE_DOMAIN);
      expect(domainFinding).toBeDefined();
      expect(domainFinding?.evidence.weight).toBe(20);
    });
  });

  describe("Layer 8: Composable Evidence Aggregation & Graph Classification", () => {
    it("classifies realistic clinical chart text as CONFIRMED_PHI (100+)", () => {
      const chartText = `
        Patient: Robert Johnson
        DOB: 11/04/1972
        MRN: 88442211
        Chief Complaint: Chronic lower back pain
        Assessment and Plan:
        Diagnosis: M54.5 Low back pain
        CPT: 99213 Outpatient follow up
        Current Meds: Gabapentin 300mg, Meloxicam 15mg
      `;
      const group = extractPHIEvidenceGraph(chartText);

      expect(group.hasPatientIdentifiers).toBe(true);
      expect(group.hasClinicalData).toBe(true);
      expect(group.totalEvidenceScore).toBeGreaterThanOrEqual(100);
      expect(group.classification).toBe("CONFIRMED_PHI");
    });

    it("classifies general medical discussion without patient identifiers as MEDICAL_CONTEXT or LIKELY_HEALTHCARE", () => {
      const articleText = `
        Type 2 diabetes is a chronic condition characterized by high blood glucose.
        Common treatment options include metformin and lifestyle modifications.
        Laboratory monitoring of HbA1c is recommended every 3 months.
      `;
      const group = extractPHIEvidenceGraph(articleText);

      expect(group.hasPatientIdentifiers).toBe(false);
      expect(group.hasClinicalData).toBe(true);
      expect(group.classification).not.toBe("CONFIRMED_PHI");
      expect(["MEDICAL_CONTEXT", "LIKELY_HEALTHCARE"]).toContain(group.classification);
    });

    it("creates an auditable PHIIncident without persisting raw text", () => {
      const chartText = `
        Patient: Alice Cooper
        DOB: 02/14/1982
        MRN: 44556677
        Diagnosis: J45.909 Asthma
        Rx: Albuterol inhaler
      `;
      const group = extractPHIEvidenceGraph(chartText);
      const incident = createPHIIncident(group, "chatgpt.com", 100);

      expect(incident.classification).toBe("CONFIRMED_PHI");
      expect(incident.riskScore).toBe(100);
      expect(incident.action).toBe("BLOCK");
      expect(incident.destination).toBe("chatgpt.com");
      expect(incident.findings).toContain(FindingType.MRN);
      expect(incident.findings).toContain(FindingType.DOB);
      expect(incident.findings).toContain(FindingType.MEDICATION);

      // Verify zero raw data persistence in incident
      const json = JSON.stringify(incident);
      expect(json).not.toContain("Alice Cooper");
      expect(json).not.toContain("44556677");
    });
  });

  describe("fastHashString Utility", () => {
    it("generates deterministic hexadecimal hash strings", () => {
      const h1 = fastHashString("Metformin");
      const h2 = fastHashString("Metformin");
      const h3 = fastHashString("Lisinopril");

      expect(h1).toBe(h2);
      expect(h1).not.toBe(h3);
      expect(h1.startsWith("h:")).toBe(true);
    });
  });
});
