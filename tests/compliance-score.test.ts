// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect } from "vitest";
import {
  evaluateComplianceScore,
  extractComplianceFindings,
  calculateVolumeRisk,
  resolveConfidenceModifier,
  scoreToRiskBand,
  bandToDefaultDecision,
  formatExplainableReason,
  BASE_SENSITIVITY_TABLE,
  ACTION_RISK_TABLE,
} from "../src/shared/complianceScore.js";
import type { DestinationClassification } from "../src/shared/destinationClassifier.js";

const DEST_AI: DestinationClassification = {
  category: "EXTERNAL_AI",
  risk: 30,
  hostname: "chatgpt.com",
  serviceId: "chatgpt",
  serviceName: "ChatGPT",
  isAi: true,
  isTrusted: false,
};

const DEST_STORAGE: DestinationClassification = {
  category: "PERSONAL_STORAGE",
  risk: 20,
  hostname: "dropbox.com",
  serviceId: "dropbox",
  serviceName: "Dropbox",
  isAi: false,
  isTrusted: false,
};

const DEST_TRUSTED: DestinationClassification = {
  category: "TRUSTED_INTERNAL",
  risk: 0,
  hostname: "ehr.company.com",
  serviceId: "trusted_internal",
  serviceName: "Internal EHR",
  isAi: false,
  isTrusted: true,
};

const DEST_WEB: DestinationClassification = {
  category: "UNKNOWN_WEB",
  risk: 10,
  hostname: "example.org",
  serviceId: "unknown_web",
  serviceName: "External Website",
  isAi: false,
  isTrusted: false,
};

describe("GovernWorld Explainable Compliance Score Engine", () => {
  describe("Base Data Sensitivity Tables", () => {
    it("has exact PII weights per specification", () => {
      expect(BASE_SENSITIVITY_TABLE.email.weight).toBe(5);
      expect(BASE_SENSITIVITY_TABLE.phone.weight).toBe(8);
      expect(BASE_SENSITIVITY_TABLE.address.weight).toBe(10);
      expect(BASE_SENSITIVITY_TABLE.driver_license.weight).toBe(20);
      expect(BASE_SENSITIVITY_TABLE.passport.weight).toBe(25);
      expect(BASE_SENSITIVITY_TABLE.ssn.weight).toBe(40);
      expect(BASE_SENSITIVITY_TABLE.payment_card.weight).toBe(40);
    });

    it("has exact PHI weights per specification", () => {
      expect(BASE_SENSITIVITY_TABLE.patient_name.weight).toBe(15);
      expect(BASE_SENSITIVITY_TABLE.mrn.weight).toBe(35);
      expect(BASE_SENSITIVITY_TABLE.insurance_id.weight).toBe(25);
      expect(BASE_SENSITIVITY_TABLE.dob.weight).toBe(20);
      expect(BASE_SENSITIVITY_TABLE.diagnosis.weight).toBe(25);
      expect(BASE_SENSITIVITY_TABLE.treatment.weight).toBe(30);
      expect(BASE_SENSITIVITY_TABLE.medication.weight).toBe(20);
      expect(BASE_SENSITIVITY_TABLE.lab_results.weight).toBe(30);
      expect(BASE_SENSITIVITY_TABLE.provider_notes.weight).toBe(35);
    });
  });

  describe("Volume Risk Calculations", () => {
    it("scales volume risk based on matches count", () => {
      expect(calculateVolumeRisk(1)).toBe(0);
      expect(calculateVolumeRisk(5)).toBe(0);
      expect(calculateVolumeRisk(6)).toBe(10);
      expect(calculateVolumeRisk(20)).toBe(10);
      expect(calculateVolumeRisk(21)).toBe(20);
      expect(calculateVolumeRisk(50)).toBe(20);
      expect(calculateVolumeRisk(51)).toBe(30);
      expect(calculateVolumeRisk(100)).toBe(30);
    });
  });

  describe("Confidence Modifier", () => {
    it("maps high, medium, and low confidences", () => {
      expect(resolveConfidenceModifier(0.95)).toBe(1.0);
      expect(resolveConfidenceModifier(0.85)).toBe(1.0);
      expect(resolveConfidenceModifier(0.75)).toBe(0.8);
      expect(resolveConfidenceModifier(0.60)).toBe(0.8);
      expect(resolveConfidenceModifier(0.50)).toBe(0.5);
    });
  });

  describe("Risk Bands and Default Decisions", () => {
    it("maps scores to correct compliance bands", () => {
      expect(scoreToRiskBand(10)).toBe("INFORMATIONAL");
      expect(scoreToRiskBand(25)).toBe("LOW");
      expect(scoreToRiskBand(55)).toBe("MEDIUM");
      expect(scoreToRiskBand(75)).toBe("HIGH");
      expect(scoreToRiskBand(95)).toBe("CRITICAL");
    });

    it("maps bands to default compliance actions", () => {
      expect(bandToDefaultDecision("INFORMATIONAL")).toBe("LOG");
      expect(bandToDefaultDecision("LOW")).toBe("ALLOW");
      expect(bandToDefaultDecision("MEDIUM")).toBe("WARN");
      expect(bandToDefaultDecision("HIGH")).toBe("MASK");
      expect(bandToDefaultDecision("CRITICAL")).toBe("BLOCK");
    });
  });

  describe("Combination Rules Evaluation (HIPAA Pack)", () => {
    it("applies Rule A: Patient Name + DOB (+25 bonus)", () => {
      const findings = [
        { category: "patient_name", confidence: 1.0 },
        { category: "dob", confidence: 1.0 },
      ];
      // On Trusted Internal: Base (15 + 20 = 35) + Rule A (+25) + Vol (0) + Dest (0) + View (0) = 60 (MEDIUM)
      const res = evaluateComplianceScore(findings, DEST_TRUSTED, "view");
      expect(res.factors.combinationBonus).toBe(25);
      expect(res.factors.appliedRules).toContain("Patient Name + DOB");
      expect(res.riskScore).toBe(60);
      expect(res.riskBand).toBe("MEDIUM");
      expect(res.decision).toBe("WARN");
    });

    it("applies Rule B: Patient Name + MRN (+40 bonus)", () => {
      const findings = [
        { category: "patient_name", confidence: 1.0 },
        { category: "mrn", confidence: 1.0 },
      ];
      // Base (15 + 35 = 50) + Rule B (+40) = 90 (CRITICAL / BLOCK)
      const res = evaluateComplianceScore(findings, DEST_TRUSTED, "view");
      expect(res.factors.combinationBonus).toBe(40);
      expect(res.factors.appliedRules).toContain("Patient Name + MRN");
      expect(res.riskScore).toBe(90);
      expect(res.riskBand).toBe("CRITICAL");
      expect(res.decision).toBe("BLOCK");
    });

    it("applies Rule E: MRN + DOB + Diagnosis (+50 bonus)", () => {
      const findings = [
        { category: "mrn", confidence: 1.0 },
        { category: "dob", confidence: 1.0 },
        { category: "diagnosis", confidence: 1.0 },
      ];
      // Base (35 + 20 + 25 = 80) + Rule E (+50) = 130 -> capped at 100 (CRITICAL)
      const res = evaluateComplianceScore(findings, DEST_TRUSTED, "view");
      expect(res.factors.combinationBonus).toBe(50);
      expect(res.riskScore).toBe(100);
      expect(res.decision).toBe("BLOCK");
    });

    it("applies Rule F: Complete Patient Profile (+80 bonus)", () => {
      const findings = [
        { category: "patient_name", confidence: 1.0 },
        { category: "dob", confidence: 1.0 },
        { category: "mrn", confidence: 1.0 },
        { category: "diagnosis", confidence: 1.0 },
        { category: "treatment", confidence: 1.0 },
      ];
      const res = evaluateComplianceScore(findings, DEST_TRUSTED, "view");
      expect(res.factors.combinationBonus).toBe(80);
      expect(res.factors.appliedRules).toContain("Complete Patient Profile");
      expect(res.riskScore).toBe(100);
      expect(res.decision).toBe("BLOCK");
    });
  });

  describe("Secret Weapon: AI Leakage Rule", () => {
    it("immediately triggers 100 (CRITICAL / BLOCK) on PHI + AI Destination + Paste", () => {
      const findings = [
        { category: "patient_name", confidence: 1.0 },
        { category: "dob", confidence: 1.0 },
      ];
      const res = evaluateComplianceScore(findings, DEST_AI, "paste");
      expect(res.factors.aiLeakageTriggered).toBe(true);
      expect(res.riskScore).toBe(100);
      expect(res.riskBand).toBe("CRITICAL");
      expect(res.decision).toBe("BLOCK");
      expect(res.reason).toContain("PHI disclosure to external AI system");
    });

    it("triggers 100 BLOCK on PHI + AI Destination + Upload", () => {
      const findings = [
        { category: "mrn", confidence: 1.0 },
      ];
      const res = evaluateComplianceScore(findings, DEST_AI, "upload");
      expect(res.factors.aiLeakageTriggered).toBe(true);
      expect(res.riskScore).toBe(100);
      expect(res.decision).toBe("BLOCK");
    });

    it("does not trigger AI leakage rule for non-PHI data (e.g. Email only)", () => {
      const findings = [
        { category: "email", confidence: 1.0 },
      ];
      // Email = 5, AI Dest = 30, Paste = 15 => Total = 50 (MEDIUM / WARN)
      const res = evaluateComplianceScore(findings, DEST_AI, "paste");
      expect(res.factors.aiLeakageTriggered).toBe(false);
      expect(res.riskScore).toBe(50);
      expect(res.decision).toBe("WARN");
    });
  });

  describe("Explainable Compliance Reasoning and Audit Schema", () => {
    it("generates clear formula breakdown and WHO/WHAT/WHERE/HOW payload", () => {
      const findings = [
        { category: "patient_name", confidence: 1.0 },
        { category: "dob", confidence: 1.0 },
      ];
      // On Unknown Web with paste:
      // Base: 15 + 20 = 35
      // Rule A: +25
      // Dest (Web): +10
      // Action (Paste): +15
      // Vol: 0
      // Total: 35 + 25 + 10 + 15 = 85 (HIGH / MASK)
      const res = evaluateComplianceScore(findings, DEST_WEB, "paste");
      expect(res.riskScore).toBe(85);
      expect(res.riskBand).toBe("HIGH");
      expect(res.decision).toBe("MASK");
      expect(res.who).toBe("User");
      expect(res.what).toEqual(["Patient Name", "DOB"]);
      expect(res.where).toBe("example.org");
      expect(res.how).toBe("PASTE");
      expect(res.reason).toContain("Patient Name + DOB");
      expect(res.reason).toContain("= 85 Risk");
    });
  });

  describe("extractComplianceFindings", () => {
    it("extracts clinical prose cues for diagnosis, treatment, medication, and driver license", () => {
      const text = `
        Patient: Jane Doe (DOB: 05/14/1980)
        MRN: 98765432
        Diagnosis: E11.9 Type 2 Diabetes
        Treatment: CPT 99214 outpatient visit
        Rx: Metformin 500mg
        Driver License: D1234567
      `;
      const baseMatches = [
        { category: "possible_name", confidence: 0.9, value: "Jane Doe" },
        { category: "dob", confidence: 0.9, value: "05/14/1980" },
        { category: "medical_record_number", confidence: 0.95, value: "98765432" },
      ];

      const findings = extractComplianceFindings(text, baseMatches);
      const categories = findings.map((f) => f.category);

      expect(categories).toContain("patient_name");
      expect(categories).toContain("dob");
      expect(categories).toContain("mrn");
      expect(categories).toContain("diagnosis");
      expect(categories).toContain("treatment");
      expect(categories).toContain("medication");
      expect(categories).toContain("driver_license");
    });
  });
});
