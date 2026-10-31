// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Detection quality, precision, and recall benchmark suite (Objective 3 / Milestone 0.1.2).
//
// Invariant: Synthetic test data only (RFC 2606 .test domains, never-issued SSNs,
// documented test cards). Real PII is strictly forbidden.
//
// Structured Benchmark Partitions:
// 1. SYNTHETIC_POSITIVES: Clean, standard synthetic positive vectors across all categories.
// 2. FORMATTING_VARIATIONS: Alternate delimiters, spacing, parentheses, continuous strings.
// 3. OCR_DERIVED_SAMPLES: Text patterns reflecting typical OCR pipeline outputs & whitespace.
// 4. DOCUMENT_SPECIFIC_SAMPLES: Multi-field realistic document context (discharge, billing, tax).
// 5. NEGATIVE_DISTRACTORS: Inputs resembling PII that must NOT trigger false positives.
// 6. UNSUPPORTED_BOUNDARY_CASES: Intentional false-negative boundary cases (documented by design).

import { describe, it, expect } from "vitest";
import { detect } from "../src/content/detect.js";
import type { FindingCategory } from "../src/shared/types.js";

interface BenchmarkSample {
  category: FindingCategory;
  text: string;
  expectedMatch: string;
  description: string;
}

interface NegativeSample {
  text: string;
  description: string;
  disallowedCategories: FindingCategory[];
}

interface UnsupportedBoundarySample {
  category: FindingCategory;
  text: string;
  reason: string;
}

const ALL_CATEGORIES: FindingCategory[] = [
  "email",
  "phone",
  "ssn",
  "payment_card",
  "npi",
  "dea",
  "mbi",
  "canadian_sin",
  "uk_nhs",
  "aadhaar",
  "pan_india",
  "australian_tfn",
  "cpf",
  "secrets",
];

// 1. Synthetic Positive Vectors (Clean baseline)
export const SYNTHETIC_POSITIVES: BenchmarkSample[] = [
  { category: "email", text: "Contact patient at test.user@example.test for details.", expectedMatch: "test.user@example.test", description: "Standard dot email" },
  { category: "email", text: "Direct inquiries to dr_smith@hospital.test.", expectedMatch: "dr_smith@hospital.test", description: "Underscore email" },
  { category: "phone", text: "Direct callback number is (555) 234-5678.", expectedMatch: "(555) 234-5678", description: "Parenthesized area code phone" },
  { category: "phone", text: "Emergency line: +1-555-987-6543.", expectedMatch: "+1-555-987-6543", description: "Leading +1 with hyphens" },
  { category: "ssn", text: "Applicant SSN listed as 219-09-9999 on form.", expectedMatch: "219-09-9999", description: "Standard dashed SSN" },
  { category: "ssn", text: "Primary subscriber SSN: 219-09-9997.", expectedMatch: "219-09-9997", description: "Prefixed dashed SSN" },
  { category: "payment_card", text: "Paid with card 4111 1111 1111 1111 exp 12/28.", expectedMatch: "4111 1111 1111 1111", description: "Spaced Visa 16-digit" },
  { category: "payment_card", text: "Mastercard test card 5105 1051 0510 5100 on file.", expectedMatch: "5105 1051 0510 5100", description: "Spaced Mastercard" },
  { category: "npi", text: "Rendering physician NPI: 1234567893 on file.", expectedMatch: "1234567893", description: "Standard physician NPI" },
  { category: "dea", text: "Prescribing clinician DEA number: AB1234563 issued.", expectedMatch: "AB1234563", description: "Standard DEA number" },
  { category: "mbi", text: "Patient Medicare MBI 1EG4TE5MK73 verified.", expectedMatch: "1EG4TE5MK73", description: "Continuous MBI" },
  { category: "canadian_sin", text: "Social Insurance Number is 130-692-908.", expectedMatch: "130-692-908", description: "Hyphenated Canadian SIN" },
  { category: "uk_nhs", text: "Patient NHS number 943 476 5919 registered.", expectedMatch: "943 476 5919", description: "3-3-4 spaced NHS number" },
  { category: "aadhaar", text: "Resident Aadhaar: 3675 9834 6125 provided.", expectedMatch: "3675 9834 6125", description: "4-4-4 spaced Aadhaar" },
  { category: "pan_india", text: "Tax identification PAN: ABCPE1234F.", expectedMatch: "ABCPE1234F", description: "Individual PAN (P)" },
  { category: "australian_tfn", text: "Australian Tax File Number: 876 543 210.", expectedMatch: "876 543 210", description: "3-3-3 spaced Australian TFN" },
  { category: "cpf", text: "Cadastro de Pessoas Fisicas CPF: 123.456.789-09.", expectedMatch: "123.456.789-09", description: "Formatted standard CPF" },
  { category: "secrets", text: "AWS Key: AKIAIOSFODNN7EXAMPLE active.", expectedMatch: "AKIAIOSFODNN7EXAMPLE", description: "AWS Access Key ID" },
  { category: "secrets", text: "GitHub Token: ghp_123456789012345678901234567890123456 in env.", expectedMatch: "ghp_123456789012345678901234567890123456", description: "GitHub PAT" },
];

// 2. Formatting Variations (Alternative delimiters, spacing, continuous digits)
export const FORMATTING_VARIATIONS: BenchmarkSample[] = [
  { category: "email", text: "Forward records to compliance@health-corp.test immediately.", expectedMatch: "compliance@health-corp.test", description: "Hyphenated domain email" },
  { category: "email", text: "Billing inquiry sent to billing.support+ref@org.test yesterday.", expectedMatch: "billing.support+ref@org.test", description: "Plus-tag email address" },
  { category: "phone", text: "Clinic mobile is 555-876-5432 ext 104.", expectedMatch: "555-876-5432", description: "Standard hyphenated phone" },
  { category: "payment_card", text: "Card number: 4111111111111111 on invoice.", expectedMatch: "4111111111111111", description: "Continuous Visa 16-digit" },
  { category: "payment_card", text: "American Express card 3782 822463 10005 charged.", expectedMatch: "3782 822463 10005", description: "Amex 15-digit format" },
  { category: "payment_card", text: "Discover card 6011-1111-1111-1117 accepted.", expectedMatch: "6011-1111-1111-1117", description: "Hyphenated Discover card" },
  { category: "mbi", text: "Encounter MBI: 1EG4-TE5-MK73.", expectedMatch: "1EG4-TE5-MK73", description: "Hyphenated MBI" },
  { category: "canadian_sin", text: "Employee SIN: 130 692 908 on tax slip.", expectedMatch: "130 692 908", description: "Spaced Canadian SIN" },
  { category: "uk_nhs", text: "NHS Number: 9434765919 on NHS letter.", expectedMatch: "9434765919", description: "Continuous 10-digit NHS" },
  { category: "aadhaar", text: "UIDAI Aadhaar 367598346125 on identity card.", expectedMatch: "367598346125", description: "Continuous 12-digit Aadhaar" },
  { category: "pan_india", text: "Company Income Tax PAN: AAACF1234A.", expectedMatch: "AAACF1234A", description: "Company PAN (C)" },
  { category: "australian_tfn", text: "Tax File Number TFN: 876543210 on statement.", expectedMatch: "876543210", description: "Continuous 9-digit Australian TFN" },
  { category: "cpf", text: "CPF do titular: 12345678909 cadastrado.", expectedMatch: "12345678909", description: "Unformatted 11-digit CPF" },
];

// 3. OCR-Derived Samples (Whitespace around colons, newline separations, typical OCR output)
export const OCR_DERIVED_SAMPLES: BenchmarkSample[] = [
  { category: "email", text: "PATIENT EMAIL : patient.records@clinic.test", expectedMatch: "patient.records@clinic.test", description: "Spaced colon email from OCR" },
  { category: "phone", text: "TELEPHONE : (555) 345-6789", expectedMatch: "(555) 345-6789", description: "OCR telephone field header" },
  { category: "ssn", text: "TAX ID :\nSSN 219-09-9998", expectedMatch: "219-09-9998", description: "Newline separated SSN from OCR table" },
  { category: "payment_card", text: "ACCOUNT NUMBER : 4111 1111 1111 1111", expectedMatch: "4111 1111 1111 1111", description: "Card number with OCR spaced colon" },
  { category: "npi", text: "PROVIDER NPI : 1993999998", expectedMatch: "1993999998", description: "OCR provider box NPI" },
  { category: "dea", text: "CLINICIAN DEA : FM9876547", expectedMatch: "FM9876547", description: "OCR clinician DEA line" },
  { category: "mbi", text: "MEDICARE MBI : 3A91NM4KK82", expectedMatch: "3A91NM4KK82", description: "OCR Medicare card capture" },
];

// 4. Document-Specific Samples (Realistic clinical, financial, tax and identity document context)
export const DOCUMENT_SPECIFIC_SAMPLES: BenchmarkSample[] = [
  {
    category: "npi",
    text: "CLINICAL DISCHARGE SUMMARY\nAttending Physician: Dr. Jane Doe (NPI: 1234567893, DEA: AB1234563)\nFacility: Metro General Hospital",
    expectedMatch: "1234567893",
    description: "Multi-field medical discharge summary (NPI)"
  },
  {
    category: "dea",
    text: "CLINICAL DISCHARGE SUMMARY\nAttending Physician: Dr. Jane Doe (NPI: 1234567893, DEA: AB1234563)\nFacility: Metro General Hospital",
    expectedMatch: "AB1234563",
    description: "Multi-field medical discharge summary (DEA)"
  },
  {
    category: "ssn",
    text: "PATIENT REGISTRATION & FINANCIAL INTAKE\nPatient Name: John Smith\nSSN: 219-09-9999\nEmergency Phone: (555) 234-5678",
    expectedMatch: "219-09-9999",
    description: "Patient registration form (SSN)"
  },
  {
    category: "payment_card",
    text: "PAYMENT AUTHORIZATION FORM\nCardholder: John Smith\nCard Number: 5105 1051 0510 5100\nExp: 11/27",
    expectedMatch: "5105 1051 0510 5100",
    description: "Payment authorization document (Card)"
  },
  {
    category: "canadian_sin",
    text: "T4 STATEMENT OF REMUNERATION PAID\nBox 12 Social Insurance Number: 130-692-908\nEmployer: Northern Health Ltd",
    expectedMatch: "130-692-908",
    description: "Canadian T4 tax statement"
  },
  {
    category: "uk_nhs",
    text: "NHS FOUNDATION TRUST - APPOINTMENT LETTER\nNHS Number: 943 476 5919\nClinic: Cardiology Outpatients",
    expectedMatch: "943 476 5919",
    description: "NHS hospital appointment letter"
  },
  {
    category: "aadhaar",
    text: "KYC VERIFICATION CERTIFICATE\nAadhaar Number: 3675 9834 6125\nIncome Tax PAN: ABCPE1234F",
    expectedMatch: "3675 9834 6125",
    description: "Indian KYC document (Aadhaar)"
  },
  {
    category: "pan_india",
    text: "KYC VERIFICATION CERTIFICATE\nAadhaar Number: 3675 9834 6125\nIncome Tax PAN: ABCPE1234F",
    expectedMatch: "ABCPE1234F",
    description: "Indian KYC document (PAN)"
  },
  {
    category: "cpf",
    text: "DECLARACAO DE IMPOSTO DE RENDA\nContribuinte CPF: 123.456.789-09\nExercicio 2026",
    expectedMatch: "123.456.789-09",
    description: "Brazilian tax return (CPF)"
  },
  {
    category: "australian_tfn",
    text: "AUSTRALIAN TAXATION OFFICE NOTICE\nTax File Number TFN: 876 543 210\nAssessment Year: 2026",
    expectedMatch: "876 543 210",
    description: "ATO tax notice (TFN)"
  },
];

// 5. Negative Distractor Corpus (Inputs resembling PII that must NOT trigger false positives)
export const NEGATIVE_DISTRACTORS: NegativeSample[] = [
  { text: "System build version 2.19.0.9999 deployed without errors.", description: "Software version matching SSN regex shape", disallowedCategories: ["ssn"] },
  { text: "Invoice #12345678 total is $450.00.", description: "Invoice number and dollar price", disallowedCategories: ["payment_card", "ssn"] },
  { text: "Meeting scheduled on Tuesday at 4:30 PM.", description: "Time stamp", disallowedCategories: ["email", "phone", "ssn"] },
  { text: "Standard part identifier ABC12345 in warehouse.", description: "Alphanumeric inventory part", disallowedCategories: ["dea", "mbi"] },
  { text: "Tracking number 1Z9999999999999999 via courier.", description: "Courier tracking number", disallowedCategories: ["payment_card"] },
  { text: "Git commit hash 7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b.", description: "40-hex SHA commit", disallowedCategories: ["secrets", "payment_card"] },
  { text: "Server IP address 192.168.1.100 port 8080.", description: "IPv4 socket address", disallowedCategories: ["phone", "ssn"] },
  { text: "UUID: 123e4567-e89b-12d3-a456-426614174000.", description: "Standard UUIDv4", disallowedCategories: ["ssn", "payment_card"] },
  { text: "Postal code 90210 in Beverly Hills.", description: "5-digit zip code", disallowedCategories: ["phone", "ssn"] },
  { text: "Mathematical formula: f(x) = (219 * 9) / 9999.", description: "Math expression", disallowedCategories: ["ssn"] },
];

// 6. Documented Unsupported Inputs (Intentional false negatives / boundaries by design)
export const UNSUPPORTED_BOUNDARY_CASES: UnsupportedBoundarySample[] = [
  { category: "ssn", text: "Customer account 219099999 on file.", reason: "Bare 9-digit number without contextual SSN keyword cue is ignored by design to prevent false positives" },
  { category: "ssn", text: "Invalid area code SSN 000-09-9999 on file.", reason: "SSN starting with 000, 666, or 9xx is invalid per SSA guidelines" },
  { category: "npi", text: "Physician NPI 1234567890 submitted.", reason: "NPI failing 80840-prefixed Luhn checksum is rejected by design" },
  { category: "payment_card", text: "Fake card 4111 1111 1111 1112 fails Luhn.", reason: "Payment card with invalid Luhn checksum is rejected by design" },
  { category: "phone", text: "Office desk phone at 555.234.5678 today.", reason: "Dotted phone notation is unsupported by design to prevent false positives on IP addresses and floats" },
  { category: "phone", text: "Dial 123-456-7890 for test.", reason: "Phone with leading area code 1xx is unsupported by NANP standards" },
  { category: "mbi", text: "Medicare MBI 1ES4TE5MK73 has letter S.", reason: "MBIs containing forbidden letters S, L, O, I, B, Z are rejected per CMS specification" },
  { category: "dea", text: "Clinician DEA AB1234567 fails check.", reason: "DEA numbers with invalid 9th checksum digit are rejected by formula validation" },
  { category: "uk_nhs", text: "NHS 943 476 5918 fails mod 11.", reason: "UK NHS numbers failing modulus 11 checksum are rejected by design" },
  { category: "aadhaar", text: "Aadhaar 3675 9834 6124 fails Verhoeff.", reason: "Aadhaar numbers failing Verhoeff checksum algorithm are rejected by design" },
  { category: "australian_tfn", text: "TFN 876 543 211 fails mod 11.", reason: "Australian TFN failing weighted modulus 11 is rejected by design" },
  { category: "cpf", text: "CPF 123.456.789-00 fails verifier.", reason: "Brazilian CPF with invalid 10th/11th verification digits is rejected by design" },
];

describe("detection benchmark, precision, recall, and unsupported inputs (Objective 3)", () => {
  function evaluateCorpus(name: string, corpus: BenchmarkSample[]) {
    const stats: Record<string, { total: number; detected: number; falseNegatives: number }> = {};
    for (const cat of ALL_CATEGORIES) {
      stats[cat] = { total: 0, detected: 0, falseNegatives: 0 };
    }

    for (const sample of corpus) {
      stats[sample.category].total++;
      const matches = detect(sample.text, [sample.category]);
      const matched = matches.some(
        (m) => m.category === sample.category && sample.text.slice(m.start, m.end).includes(sample.expectedMatch)
      );
      if (matched) {
        stats[sample.category].detected++;
      } else {
        stats[sample.category].falseNegatives++;
      }
    }

    let sumTotal = 0;
    let sumTP = 0;
    let sumFN = 0;

    console.log(`\n--- BENCHMARK SUBSET: ${name} (${corpus.length} samples) ---`);
    console.log("Category                 Samples    TP    FN    Recall");
    console.log("-------------------------------------------------------");

    for (const cat of ALL_CATEGORIES) {
      const s = stats[cat];
      if (s.total === 0) continue;
      sumTotal += s.total;
      sumTP += s.detected;
      sumFN += s.falseNegatives;
      const recall = (s.detected / s.total) * 100;
      console.log(
        `${cat.padEnd(24)} ${String(s.total).padStart(7)}  ${String(s.detected).padStart(4)}  ${String(s.falseNegatives).padStart(4)}    ${recall.toFixed(1).padStart(5)}%`
      );
      expect(recall, `Recall for ${cat} in ${name} must be 100%`).toBe(100);
    }
    const subsetRecall = sumTotal > 0 ? (sumTP / sumTotal) * 100 : 100;
    console.log("-------------------------------------------------------");
    console.log(`SUBSET TOTAL:            ${String(sumTotal).padStart(7)}  ${String(sumTP).padStart(4)}  ${String(sumFN).padStart(4)}    ${subsetRecall.toFixed(1).padStart(5)}%`);
    expect(subsetRecall).toBe(100);
  }

  it("evaluates Synthetic Positive samples with 100% recall", () => {
    evaluateCorpus("SYNTHETIC POSITIVES", SYNTHETIC_POSITIVES);
  });

  it("evaluates Formatting Variations with 100% recall", () => {
    evaluateCorpus("FORMATTING VARIATIONS", FORMATTING_VARIATIONS);
  });

  it("evaluates OCR-Derived Samples with 100% recall", () => {
    evaluateCorpus("OCR-DERIVED SAMPLES", OCR_DERIVED_SAMPLES);
  });

  it("evaluates Document-Specific Samples with 100% recall", () => {
    evaluateCorpus("DOCUMENT-SPECIFIC SAMPLES", DOCUMENT_SPECIFIC_SAMPLES);
  });

  it("evaluates Negative Distractors with 0% false positive rate (100% precision)", () => {
    console.log(`\n--- NEGATIVE DISTRACTORS EVALUATION (${NEGATIVE_DISTRACTORS.length} samples) ---`);
    let falsePositives = 0;
    for (const neg of NEGATIVE_DISTRACTORS) {
      for (const cat of neg.disallowedCategories) {
        const matches = detect(neg.text, [cat]);
        if (matches.length > 0) {
          falsePositives += matches.length;
          console.error(`False positive detected in distractor [${neg.description}]: ${cat}`);
        }
      }
    }
    console.log(`False Positives on Distractor Corpus: ${falsePositives}`);
    expect(falsePositives).toBe(0);
  });

  it("asserts intentional false negatives on Unsupported Boundary Cases (fail-safe boundaries)", () => {
    console.log(`\n--- DOCUMENTED UNSUPPORTED BOUNDARY CASES (${UNSUPPORTED_BOUNDARY_CASES.length} cases) ---`);
    for (const u of UNSUPPORTED_BOUNDARY_CASES) {
      const matches = detect(u.text, [u.category]);
      console.log(`  [Rejected as expected] ${u.category}: ${u.reason}`);
      expect(
        matches,
        `Unsupported input [${u.text}] must NOT be detected as ${u.category}: ${u.reason}`
      ).toHaveLength(0);
    }
    console.log("\n[PRODUCTION ACCURACY DISCLOSURE]: Synthetic benchmarks and unit test fixtures measure rule conformance and deterministic regex/validator behavior. They do NOT guarantee identical recall across low-resolution handwritten scans, rotated OCR, or unmodeled international formats.");
  });
});
