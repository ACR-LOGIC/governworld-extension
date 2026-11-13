// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect } from "vitest";
import { detect, maskValue, maskContext, resolveOverlaps, placeholderLabelFor, type RawMatch } from "../src/content/detect.js";
import { parseName, isStandaloneName, isNameToken } from "../src/content/detectors/nameParser.js";

describe("detect", () => {
  const ALL = [
    "email",
    "phone",
    "ssn",
    "dob",
    "medical_record_number",
    "member_id",
    "npi",
    "dea",
    "mbi",
    "address",
    "payment_card",
    "secrets",
    "possible_name",
  ] as const;

  it("detects emails", () => {
    const [match] = detect("Contact jane.doe@example.com for details.", [...ALL]);
    expect(match.category).toBe("email");
    expect(match.value).toBe("jane.doe@example.com");
  });

  it("detects US phones and rejects invalid exchanges", () => {
    const text = "Call (415) 555-1234 or 212-867-5309 now.";
    const matches = detect(text, [...ALL]);
    const phones = matches.filter((m) => m.category === "phone");
    expect(phones).toHaveLength(2);
  });

  it("detects SSNs only in valid dash form or with context", () => {
      const text = "SSN 123-45-6789 and 000-12-3456 and social security number 123456789";
      const matches = detect(text, [...ALL]);
      const ssns = matches.filter((m) => m.category === "ssn");
      expect(ssns).toHaveLength(2); // 123-45-6789 + context-tagged bare form
    });

    it("does not treat the bare word 'social' as an SSN cue", () => {
      // "social" on its own is ordinary English. Treating it as a cue meant any
      // page with the word next to a 9-digit number produced an SSN — "Join our
      // social 123456789 community" was enough.
      const matches = detect("Join our social 123456789 community", [...ALL]);
      expect(matches.filter((m) => m.category === "ssn")).toHaveLength(0);
    });

  it("detects DOB only with contextual cues", () => {
    const withCue = detect("Date of birth: 04/22/1990", [...ALL]);
    const withoutCue = detect("Order 04/22/1990 shipped today", [...ALL]);
    expect(withCue.filter((m) => m.category === "dob")).toHaveLength(1);
    expect(withoutCue.filter((m) => m.category === "dob")).toHaveLength(0);
  });

  it("detects medical record numbers by label", () => {
    const text = "MRN: 884310 and record # AX-9921";
    const matches = detect(text, [...ALL]);
    expect(matches.filter((m) => m.category === "medical_record_number").length).toBeGreaterThanOrEqual(2);
  });

  it("detects member ids by label", () => {
    const text = "Member ID: 7788990";
    const matches = detect(text, [...ALL]);
    expect(matches.filter((m) => m.category === "member_id")).toHaveLength(1);
  });

  it("detects payment cards only when Luhn-valid", () => {
    const valid = "4111111111111111"; // passes Luhn
    const invalid = "4111111111111112";
    const matches = detect(`Card ${valid} and ${invalid}`, [...ALL]);
    const cards = matches.filter((m) => m.category === "payment_card");
    expect(cards).toHaveLength(1);
    expect(cards[0].value).toBe(valid);
  });

  it("detects possible names after contextual labels", () => {
    const text = "Patient Name: Jane Q Public";
    const matches = detect(text, [...ALL]);
    expect(matches.filter((m) => m.category === "possible_name")).toHaveLength(1);
  });

  it("detects NPIs when label-bound or Luhn-valid", () => {
    const text = "Provider NPI: 1234567893 and asset tag 1993999998";
    const matches = detect(text, [...ALL]);
    const npis = matches.filter((m) => m.category === "npi");
    expect(npis.length).toBeGreaterThanOrEqual(1);
    expect(npis[0].value).toBe("1234567893");
  });

  it("does not flag a bare invalid-checksum 10-digit run as NPI", () => {
    const text = "Reference 1234567890 was logged";
    const matches = detect(text, [...ALL]);
    expect(matches.filter((m) => m.category === "npi")).toHaveLength(0);
  });

  it("detects DEA registration numbers with a valid checksum", () => {
    const text = "DEA number AB1234563 on file";
    const matches = detect(text, [...ALL]);
    expect(matches.filter((m) => m.category === "dea")).toHaveLength(1);
  });

  it("rejects DEA-shaped runs with an invalid checksum", () => {
    const text = "Order AB1234567 was shipped";
    const matches = detect(text, [...ALL]);
    expect(matches.filter((m) => m.category === "dea")).toHaveLength(0);
  });

  it("detects label-bound Medicare Beneficiary IDs", () => {
    const text = "MBI 1EG4-TE5-MK73 per coverage";
    const matches = detect(text, [...ALL]);
    expect(matches.filter((m) => m.category === "mbi")).toHaveLength(1);
  });

  it("does not flag generic alphanumeric runs as MBI without a Medicare label", () => {
    const text = "Order ref 1EG4-TE5-MK73 processed";
    const matches = detect(text, [...ALL]);
    expect(matches.filter((m) => m.category === "mbi")).toHaveLength(0);
  });

  it("detects API keys and secrets", () => {
    const text =
      "database postgres://user:secret123456@db.internal:5432/main and token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c and api_key=a1b2c3d4e5f6g7h8i9j0k1l2m3n4";
    const matches = detect(text, [...ALL]);
    const secrets = matches.filter((m) => m.category === "secrets");
    expect(secrets.length).toBeGreaterThanOrEqual(3);
  });

  it("does not flag placeholder secrets", () => {
    const text = "sample key sk_test_abc123 and example password changeme";
    const matches = detect(text, [...ALL]);
    expect(matches.filter((m) => m.category === "secrets")).toHaveLength(0);
  });

  it("masks a secret keeping only a leading character visible", () => {
    expect(maskValue("secrets", "sk_proj_abcdef")).toBe("s***");
  });

  it("maps every category to a short uppercase placeholder label", () => {
    expect(placeholderLabelFor("ssn")).toBe("SSN");
    expect(placeholderLabelFor("dob")).toBe("DOB");
    expect(placeholderLabelFor("payment_card")).toBe("CARD");
    expect(placeholderLabelFor("secrets")).toBe("API KEY");
    expect(placeholderLabelFor("possible_name")).toBe("NAME");
    expect(placeholderLabelFor("medical_record_number")).toBe("MRN");
  });

  it("detects structured addresses", () => {
    const text = "Ship to 123 Main Street, Springfield, IL 62704";
    const matches = detect(text, [...ALL]);
    expect(matches.filter((m) => m.category === "address")).toHaveLength(1);
  });


  it("detects authentic spaced IBANs under bank_account", () => {
    const text = "Wire payment to IBAN DE89 3704 0044 0532 0130 00 today";
    const matches = detect(text, [...ALL, "bank_account"]);
    const bankMatches = matches.filter((m) => m.category === "bank_account");
    expect(bankMatches.length).toBeGreaterThanOrEqual(1);
    expect(bankMatches[0].value).toContain("DE89");
  });

  it("detects passport numbers and MRZ lines under member_id", () => {
    const text = "Holder Passport Number: 123456789";
    const matches = detect(text, [...ALL]);
    const memberMatches = matches.filter((m) => m.category === "member_id");
    expect(memberMatches.length).toBeGreaterThanOrEqual(1);
    expect(memberMatches[0].value).toBe("123456789");

    const mrzText = "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<";
    const mrzMatches = detect(mrzText, [...ALL]);
    expect(mrzMatches.some((m) => m.value.startsWith("P<UTO"))).toBe(true);
  });
  it("does not flag every number as sensitive", () => {
    const text = "Invoice total is $1,234.56 with reference 78492.";
    const matches = detect(text, [...ALL]);
    expect(matches.length).toBe(0);
  });

  it("resolves overlaps keeping the higher-priority span", () => {
    const overlapping = [
      { category: "email" as const, confidence: 0.92, value: "a@b.com", start: 0, end: 10 },
      { category: "possible_name" as const, confidence: 0.52, value: "a@b.com extra", start: 0, end: 18 },
    ];
    const merged = resolveOverlaps(overlapping);
    expect(merged).toHaveLength(1);
    expect(merged[0].category).toBe("email");
  });
});

describe("maskValue", () => {
  it("never reveals the full email value", () => {
    expect(maskValue("email", "jane.doe@example.com")).toBe("j***@example.com");
  });
  it("masks phone digits except the last four", () => {
    expect(maskValue("phone", "(415) 555-1234")).toMatch(/^\*\*\*-\*\*\*-1234$/);
  });
  it("masks SSNs fully", () => {
    expect(maskValue("ssn", "123-45-6789")).toMatch(/^\*\*\*-\*\*-\d{4}$/);
  });
  it("masks card numbers except the last four", () => {
    expect(maskValue("payment_card", "4111111111111111")).toMatch(/^\*{12}\d{4}$/);
  });
  it("does not contain the raw value in any masked output", () => {
    const values = ["jane.doe@example.com", "(415) 555-1234", "123-45-6789", "4111111111111111"];
    for (const value of values) {
      for (const category of ["email", "phone", "ssn", "payment_card", "medical_record_number", "member_id"] as const) {
        expect(maskValue(category, value)).not.toContain(value);
      }
    }
  });
});

describe("maskContext", () => {
  it("replaces every token with a mask", () => {
    const out = maskContext("MRN 123456 seen on discharge notes");
    expect(out).not.toContain("123456");
    expect(out).not.toContain("MRN");
    expect(out).not.toContain("discharge");
  });
});

describe("name parser", () => {
  it("parses prefix, gender and age: Mary F. 65", () => {
    const p = parseName("Mary F. 65");
    expect(p.first).toBe("Mary");
    expect(p.gender).toBe("F");
    expect(p.age).toBe(65);
    expect(p.middle).toEqual([]);
    expect(p.last).toBeNull();
  });

  it("parses honorific prefix and generational suffix", () => {
    const p = parseName("Dr. Mary Smith Jr.");
    expect(p.prefix).toBe("Dr");
    expect(p.first).toBe("Mary");
    expect(p.last).toBe("Smith");
    expect(p.suffix).toBe("Jr");
    expect(p.credentials).toEqual([]);
  });

  it("parses professional credentials", () => {
    const p = parseName("Robert Miller MD");
    expect(p.first).toBe("Robert");
    expect(p.last).toBe("Miller");
    expect(p.credentials).toEqual(["MD"]);
  });

  it("parses compound surnames and particles", () => {
    const p = parseName("Mary De La Cruz");
    expect(p.first).toBe("Mary");
    expect(p.last).toBe("Cruz");
    expect(p.middle).toEqual(["De", "La"]);
    expect(p.rawName).toBe("Mary De La Cruz");

    const p2 = parseName("Mary Smith-Jones");
    expect(p2.last).toBe("Smith-Jones");
  });

  it("treats single-letter F/M after an age as gender, not a middle initial", () => {
    const p = parseName("Mary F. 65");
    expect(p.middle).toHaveLength(0);
    expect(p.gender).toBe("F");
  });

  it("handles single-token names", () => {
    const smith = parseName("Smith");
    expect(smith.first ?? smith.last).toBe("Smith");
    expect(parseName("Mary").first).toBe("Mary");
    expect(parseName("").first).toBeNull();
    expect(parseName("").rawName).toBeNull();
  });

  it("exposes standalone-name and name-token classifiers", () => {
    expect(isStandaloneName("Smith")).toBe(true);
    expect(isStandaloneName("Smith Jones")).toBe(false);
    expect(isStandaloneName("NotARealNameXyz")).toBe(false);
    expect(isNameToken("Mary")).toBe(true);
    expect(isNameToken("Smith")).toBe(true);
    expect(isNameToken("NotARealNameXyz")).toBe(false);
  });

  it("parses multi-word honorifics, middle initial, suffix and credentials together", () => {
    const p = parseName("Dr. John A. Smith MD Jr.");
    expect(p.prefix).toBe("Dr");
    expect(p.first).toBe("John");
    expect(p.middle).toContain("A");
    expect(p.last).toBe("Smith");
    expect(p.suffix).toBe("Jr");
    expect(p.credentials).toContain("MD");
  });

  it("parses multiple credentials", () => {
    const p = parseName("Robert Miller MD RN");
    expect(p.first).toBe("Robert");
    expect(p.last).toBe("Miller");
    expect(p.credentials).toContain("MD");
    expect(p.credentials).toContain("RN");
  });

  it("parses age with tail label", () => {
    const p = parseName("Mary 65 y/o");
    expect(p.first).toBe("Mary");
    expect(p.age).toBe(65);
  });

  it("captures DOB when present in the value", () => {
    const p = parseName("Jane Smith DOB 04/22/1990");
    expect(p.first).toBe("Jane");
    expect(p.last).toBe("Smith");
    expect(p.dob).toBe("04/22/1990");
  });

  it("rejects non-name lookalikes via the dictionary classifiers", () => {
    expect(isStandaloneName("Chapter")).toBe(false);
    expect(isStandaloneName("NotARealNameXyz")).toBe(false);
    expect(isNameToken("Chapter")).toBe(false);
    expect(isNameToken("NotARealNameXyz")).toBe(false);
  });

  it("parses without throwing on non-name input and assigns a best-effort first token", () => {
    expect(() => parseName("Chapter 1")).not.toThrow();
    expect(() => parseName("NotARealNameXyz")).not.toThrow();
    expect(parseName("NotARealNameXyz").first).toBe("NotARealNameXyz");
  });
});

describe("name parsedName enrichment", () => {
  const enrich = (matches: RawMatch[]) =>
    matches.map((m) =>
      m.category === "possible_name" ? { ...m, parsedName: parseName(m.value) } : m
    );

  const parsed = (match: RawMatch | undefined) => {
    expect(match).toBeDefined();
    return match!.parsedName!;
  };

  it("attaches structured name components to possible_name matches", () => {
    const found = enrich(detect("Patient: Mary Jane Smith", ["possible_name"]));
    const p = parsed(found.find((m) => m.value === "Mary Jane Smith"));
    expect(p).toMatchObject({
      first: "Mary",
      middle: ["Jane"],
      last: "Smith",
      prefix: null,
      suffix: null,
    });
  });

  it("attaches middle initials as a middle token", () => {
    const found = enrich(detect("Patient: John A. Doe", ["possible_name"]));
    const p = parsed(found.find((m) => /John/.test(m.value) && /Doe/.test(m.value)));
    expect(p.first).toBe("John");
    expect(p.middle).toContain("A");
    expect(p.last).toBe("Doe");
  });

  it("attaches professional titles and credentials", () => {
    const found = enrich(detect("Doctor: Dr. Robert Miller MD", ["possible_name"]));
    const p = parsed(found.find((m) => /Robert/.test(m.value)));
    expect(p.prefix).toBe("Dr");
    expect(p.credentials).toContain("MD");
    expect(p.first).toBe("Robert");
    expect(p.last).toBe("Miller");
  });

  it("attaches compound surnames and particles", () => {
    const found = enrich(detect("Patient: Maria De La Cruz", ["possible_name"]));
    const p = parsed(found.find((m) => m.value === "Maria De La Cruz"));
    expect(p.first).toBe("Maria");
    expect(p.middle).toEqual(["De", "La"]);
    expect(p.last).toBe("Cruz");
    expect(p.rawName).toBe("Maria De La Cruz");
  });

  it("attaches age, gender and DOB context", () => {
    const ageEnriched = enrich([
      { category: "possible_name", confidence: 0.8, value: "Mary F. 65", start: 0, end: 9 },
    ]);
    const ageP = parsed(ageEnriched[0]);
    expect(ageP.age).toBe(65);
    expect(ageP.gender).toBe("F");
    expect(ageP.middle).toHaveLength(0);

    const dobEnriched = enrich([
      { category: "possible_name", confidence: 0.8, value: "Jane Smith DOB 04/22/1990", start: 0, end: 26 },
    ]);
    const dobP = parsed(dobEnriched[0]);
    expect(dobP.dob).toBe("04/22/1990");
  });

  it("distinguishes a titled doctor from a plain patient", () => {
    const doctor = enrich(detect("Doctor: Dr. Elena Rossi", ["possible_name"]));
    const patient = enrich(detect("Patient: Elena Rossi", ["possible_name"]));
    const docP = parsed(doctor.find((m) => m.value.includes("Rossi")));
    const patP = parsed(patient.find((m) => m.value.includes("Rossi")));
    expect(docP.prefix).toBe("Dr");
    expect(patP.prefix).toBeNull();
    expect(docP.first).toBe("Elena");
    expect(patP.first).toBe("Elena");
  });

  it("preserves value, offsets, confidence, and adds no matches", () => {
    const before = detect("Patient: Mary Jane Smith and Dr. Robert Miller MD", [
      "possible_name",
    ]);
    const after = enrich(before);
    expect(after).toHaveLength(before.length);
    for (const [i, m] of after.entries()) {
      expect(m.value).toBe(before[i].value);
      expect(m.start).toBe(before[i].start);
      expect(m.end).toBe(before[i].end);
      expect(m.confidence).toBe(before[i].confidence);
      expect(m.category).toBe(before[i].category);
    }
    for (const m of after) {
      if (m.category === "possible_name") expect(m.parsedName).toBeDefined();
    }
  });
});
