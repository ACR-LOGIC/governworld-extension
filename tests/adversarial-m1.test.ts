import { describe, it, expect } from "vitest";
import { detect } from "../src/content/detect.js";
import { isValidNpi } from "../src/validators/index.js";
import type { FindingCategory } from "../src/shared/types.js";
import type { CustomPattern } from "../src/shared/customPatterns.js";

const ALL_CATEGORIES: FindingCategory[] = [
  "email", "phone", "ssn", "dob", "medical_record_number", "member_id",
  "npi", "dea", "mbi", "address", "payment_card", "secrets", "possible_name",
  "canadian_sin", "uk_nhs", "aadhaar", "pan_india", "australian_tfn", "cpf", "custom",
];

describe("Adversarial M1 Test Suite", () => {
  // ── Area 1: Unprefixed NPI Detection ───────────────────────────────────
  describe("Area 1: Unprefixed NPI Detection", () => {
    it("validates Luhn check digits with 80840 prefix correctly", () => {
      expect(isValidNpi("1234567893")).toBe(true);
      expect(isValidNpi("1993999998")).toBe(true);
      expect(isValidNpi("1234567890")).toBe(false);
      expect(isValidNpi("0000000000")).toBe(false);
      expect(isValidNpi("9999999999")).toBe(false);
      expect(isValidNpi("123456789")).toBe(false); // 9 digits
      expect(isValidNpi("12345678931")).toBe(false); // 11 digits
    });

    it("detects valid NPI in natural prose without label prefix", () => {
      const text = "Referred to provider 1234567893 at oncology department.";
      const matches = detect(text, ["npi"]);
      expect(matches).toHaveLength(1);
      expect(matches[0].category).toBe("npi");
      expect(matches[0].value).toBe("1234567893");
    });

    it("detects valid NPI surrounded by various punctuation", () => {
      const text = "Contact (1234567893), [1993999998]; {1234567893}!";
      const matches = detect(text, ["npi"]);
      expect(matches.length).toBeGreaterThanOrEqual(3);
      for (const m of matches) {
        expect(m.category).toBe("npi");
      }
    });

    it("rejects 10-digit numbers preceded by explicit phone prefixes", () => {
      const prefixes = ["tel:", "tel: ", "phone:", "Phone: ", "fax:", "Fax: ", "mobile:", "cell:", "call:"];
      for (const p of prefixes) {
        const text = `${p}1234567893`;
        const matches = detect(text, ["npi"]);
        const npis = matches.filter((m) => m.category === "npi");
        expect(npis).toHaveLength(0);
      }
    });

    it("does NOT reject NPI when preceded by words ending in 'tel' or 'call' (e.g. hotel, motel, recall)", () => {
      const words = ["hotel:", "motel:", "hostel:", "recall:", "rollcall:"];
      for (const w of words) {
        const text = `Physician at ${w} 1234567893 for consultation.`;
        const matches = detect(text, ["npi"]);
        const npis = matches.filter((m) => m.category === "npi");
        expect(npis.length, `Failed to detect NPI preceded by "${w}"`).toBe(1);
        expect(npis[0].value).toBe("1234567893");
      }
    });

    it("rejects non-provider bound identifiers (invoice, order, tracking, serial)", () => {
      const text = "Order number 1234567893 was processed. Serial number 1993999998 tagged.";
      const matches = detect(text, ["npi"]);
      expect(matches.filter((m) => m.category === "npi")).toHaveLength(0);
    });

    it("rejects 10-digit number that has invalid Luhn checksum", () => {
      const text = "Dr. Smith internal id 1234567890 noted.";
      const matches = detect(text, ["npi"]);
      expect(matches.filter((m) => m.category === "npi")).toHaveLength(0);
    });
  });

  // ── Area 2: Confidence Thresholds ──────────────────────────────────────
  describe("Area 2: Confidence Thresholds", () => {
    it("filters findings strictly when confidence is below threshold", () => {
      // Unprefixed NPI has confidence 0.70
      // Label-bound NPI has confidence 0.93
      const text = "Bare provider 1234567893 and NPI: 1993999998";
      const matches = detect(text, ["npi"]);
      expect(matches).toHaveLength(2);

      const threshold = 0.85;
      const filtered = matches.filter((m) => m.confidence >= threshold);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].value).toBe("1993999998");
      expect(filtered[0].confidence).toBe(0.93);
    });

    it("retains findings when confidence meets or exceeds threshold", () => {
      const text = "Email test@example.com and Bare NPI 1234567893";
      const matches = detect(text, ["email", "npi"]);
      // Email confidence is 0.92, Bare NPI is 0.70
      const thresholds: Record<string, number> = {
        email: 0.90,
        npi: 0.70,
      };
      const filtered = matches.filter((m) => m.confidence >= (thresholds[m.category] ?? 0));
      expect(filtered).toHaveLength(2);
    });

    it("filters all findings when threshold is 1.0 (higher than any finding)", () => {
      const text = "Email test@example.com and NPI: 1234567893";
      const matches = detect(text, ["email", "npi"]);
      const filtered = matches.filter((m) => m.confidence >= 1.0);
      expect(filtered).toHaveLength(0);
    });
  });

  // ── Area 3: Custom Patterns ────────────────────────────────────────────
  describe("Area 3: Custom Pattern Constraints", () => {
    it("extracts exact captureGroup > 0 value and boundary offsets", () => {
      const pattern: CustomPattern = {
        id: "pat-order",
        name: "Order Number",
        category: "custom",
        pattern: String.raw`Order\s+ID:\s*([A-Z0-9]{6})`,
        flags: "gi",
        captureGroup: 1,
        confidence: 0.95,
        createdAt: "2026-01-01T00:00:00.000Z",
        source: "local",
        contributionStatus: "local_only",
      };
      const text = "Please review Order ID: ORD123 in your account.";
      const matches = detect(text, ["custom"], [pattern]);
      expect(matches).toHaveLength(1);
      expect(matches[0].value).toBe("ORD123");
      expect(text.slice(matches[0].start, matches[0].end)).toBe("ORD123");
    });

    it("uses full match when captureGroup is 0 or undefined", () => {
      const pattern: CustomPattern = {
        id: "pat-order-full",
        name: "Order Full",
        category: "custom",
        pattern: String.raw`Order-ID-[A-Z0-9]{6}`,
        flags: "gi",
        captureGroup: 0,
        confidence: 0.95,
        createdAt: "2026-01-01T00:00:00.000Z",
        source: "local",
        contributionStatus: "local_only",
      };
      const text = "Please review Order-ID-ORD123 in your account.";
      const matches = detect(text, ["custom"], [pattern]);
      expect(matches).toHaveLength(1);
      expect(matches[0].value).toBe("Order-ID-ORD123");
      expect(text.slice(matches[0].start, matches[0].end)).toBe("Order-ID-ORD123");
    });

    it("enforces minLength constraint", () => {
      const pattern: CustomPattern = {
        id: "pat-min-len",
        name: "Min Length Code",
        category: "custom",
        pattern: String.raw`CODE-[0-9]+`,
        flags: "g",
        captureGroup: 0,
        minLength: 10,
        confidence: 0.9,
        createdAt: "2026-01-01T00:00:00.000Z",
        source: "local",
        contributionStatus: "local_only",
      };
      // CODE-12 is 7 chars (< 10) -> reject
      // CODE-123456 is 11 chars (>= 10) -> accept
      const text = "Short CODE-12 and long CODE-123456 present.";
      const matches = detect(text, ["custom"], [pattern]);
      expect(matches).toHaveLength(1);
      expect(matches[0].value).toBe("CODE-123456");
    });

    it("enforces maxLength constraint", () => {
      const pattern: CustomPattern = {
        id: "pat-max-len",
        name: "Max Length Code",
        category: "custom",
        pattern: String.raw`TAG-[0-9]+`,
        flags: "g",
        captureGroup: 0,
        maxLength: 8,
        confidence: 0.9,
        createdAt: "2026-01-01T00:00:00.000Z",
        source: "local",
        contributionStatus: "local_only",
      };
      // TAG-123 is 7 chars (<= 8) -> accept
      // TAG-123456 is 10 chars (> 8) -> reject
      const text = "Accept TAG-123 but reject TAG-123456.";
      const matches = detect(text, ["custom"], [pattern]);
      expect(matches).toHaveLength(1);
      expect(matches[0].value).toBe("TAG-123");
    });

    it("enforces contextCues constraint within ±120 characters", () => {
      const pattern: CustomPattern = {
        id: "pat-cues",
        name: "Confidential Project",
        category: "custom",
        pattern: String.raw`PROJ-[0-9]{4}`,
        flags: "g",
        captureGroup: 0,
        contextCues: ["classified", "confidential"],
        confidence: 0.9,
        createdAt: "2026-01-01T00:00:00.000Z",
        source: "local",
        contributionStatus: "local_only",
      };
      const textWithCue = "This document is confidential. Reference code PROJ-9999 applies.";
      const textWithoutCue = "Public release ticket PROJ-8888 created yesterday.";
      const textFarCue = "Confidential header " + "x".repeat(200) + " PROJ-7777 footer.";

      expect(detect(textWithCue, ["custom"], [pattern])).toHaveLength(1);
      expect(detect(textWithoutCue, ["custom"], [pattern])).toHaveLength(0);
      expect(detect(textFarCue, ["custom"], [pattern])).toHaveLength(0);
    });
  });

  // ── Area 4: Secrets & Form Labels ──────────────────────────────────────
  describe("Area 4: Secrets & Form Labels", () => {
    it("does not tag generic form labels as possible_name", () => {
      const labels = [
        "Patient Name: First Name",
        "Member Name: Last Name",
        "Full Name: User Name",
        "Name: Enter Name",
        "Patient: Required Field",
        "Member: Select One",
        "Full Name: Your Name",
      ];
      for (const line of labels) {
        const matches = detect(line, ["possible_name"]);
        expect(matches.filter((m) => m.category === "possible_name")).toHaveLength(0);
      }
    });

    it("detects real names after labels while excluding generic label placeholders", () => {
      const text = "First Name: John Doe\nLast Name: Smith";
      const matches = detect(text, ["possible_name"]);
      const names = matches.filter((m) => m.category === "possible_name");
      expect(names.length).toBeGreaterThanOrEqual(1);
      expect(names[0].value).toBe("John Doe");
    });

    it("resolves overlapping generic secrets vs high-confidence credentials by confidence", () => {
      // api_key = "xoxb-..." matches both generic credential assignment (0.80) and Slack token (0.99)
      const text = 'api_key: "xoxb-1234567890-1234567890123"';
      const matches = detect(text, ["secrets"]);
      expect(matches).toHaveLength(1);
      expect(matches[0].category).toBe("secrets");
      expect(matches[0].confidence).toBe(0.99);
      expect(matches[0].value).toBe("xoxb-1234567890-1234567890123");
    });

    it("accurately computes start offset after [:=] assignment without offset drift", () => {
      const text = 'api_key = "mysecret123456789012"';
      const matches = detect(text, ["secrets"]);
      expect(matches).toHaveLength(1);
      expect(matches[0].value).toBe("mysecret123456789012");
      expect(text.slice(matches[0].start, matches[0].end)).toBe("mysecret123456789012");
    });
  });
});
