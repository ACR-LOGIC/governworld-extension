import { describe, it, expect } from "vitest";
import { detect } from "../src/content/detect.js";
import { ALL_CATEGORIES } from "../src/shared/settings.js";
import type { CustomPattern } from "../src/shared/customPatterns.js";

const customPatterns: CustomPattern[] = [
  {
    id: "c1",
    name: "proj",
    category: "custom",
    pattern: "^PROJ-[A-Z]{3}-\\d{6}-[A-Z0-9]{4}$",
    confidence: 0.9,
    createdAt: new Date().toISOString(),
    source: "local",
    contributionStatus: "local_only",
  },
  {
    id: "c2",
    name: "ticket",
    category: "custom",
    pattern: "^INT-TICKET-\\d{4}-\\d{4}$",
    confidence: 0.9,
    createdAt: new Date().toISOString(),
    source: "local",
    contributionStatus: "local_only",
  },
];

describe("Test Suite Corpus Identification & Fixes", () => {
  it("diagnoses and validates all 24 categories from the test suite corpus", () => {
    const testSamples = [
      { name: "Possible Name 1", text: "Possible name: Eleanor Vance-Sterling", expectedCat: "possible_name" },
      { name: "Possible Name 2", text: "Category: Possible name\nEleanor Vance-Sterling\tMarcus Aurelius Thorne Jr.", expectedCat: "possible_name" },
      { name: "DOB Textual", text: "Date of birth: November 23, 1978", expectedCat: "dob" },
      { name: "Address NW", text: "1600 Pennsylvania Ave NW, Apt 4B, Austin, TX 78701-1402", expectedCat: "address" },
      { name: "PAT-ID", text: "PAT-ID: 774829103 / UHC849201742", expectedCat: "member_id" },
      { name: "DEA Alternate", text: "BC6543219 / FS2468135 (Checksum valid)", expectedCat: "dea" },
      { name: "MBI Alternate", text: "4S98A34RT67 (Unformatted 11-char MBI)", expectedCat: "mbi" },
      { name: "Canadian SIN 046", text: "Canadian Social Insurance Number (SIN): 046-454-286", expectedCat: "canadian_sin" },
      { name: "Canadian SIN 130", text: "Canadian Social Insurance Number (SIN): 130692544", expectedCat: "canadian_sin" },
      { name: "Indian Aadhaar Compact", text: "Indian Aadhaar Number\t234567890126 (Verhoeff valid)", expectedCat: "aadhaar" },
      { name: "Indian PAN Formatted", text: "Indian PAN Card\tABCDE1234F", expectedCat: "pan_india" },
      { name: "Australian TFN Compact", text: "Australian Tax File Number (TFN)\t648188480 (Mod 11 valid)", expectedCat: "australian_tfn" },
      { name: "Brazilian CPF", text: "Brazilian CPF Number\t111.444.777-05 / 52998224725", expectedCat: "cpf" },
      { name: "Bank Account #", text: "Account #: 004928174629", expectedCat: "bank_account" },
      { name: "IBAN", text: "IBAN: GB29NWBK60161331926819", expectedCat: "bank_account" },
      { name: "Comp USD", text: "Total Comp: USD 242,750", expectedCat: "financial" },
      { name: "Comp Equity", text: "Equity: $22,000", expectedCat: "financial" },
      { name: "Comp Hourly", text: "Hourly: $89.18/hr", expectedCat: "financial" },
      { name: "IPv6 Wrapped", text: "IPv6: 2001:0db8:85a3:0000:0000:\n8a2e:0370:7334", expectedCat: "ip_address" },
      { name: "User Login", text: "under login CORP\\mthorne84", expectedCat: "username" },
      { name: "Password", text: "password P@ssw0rd!99_Synthet1c#2026", expectedCat: "secrets" },
      { name: "Basic Auth", text: "Basic Auth: svc_dlp_runner:K9#mP2$vL8@qR5!z", expectedCat: "secrets" },
      { name: "AWS Secret Key", text: "AWS Secret Key: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", expectedCat: "secrets" },
      { name: "Custom PROJ", text: "PROJ-SEC-482910-X9B2", expectedCat: "custom" },
      { name: "Custom TICKET", text: "INT-TICKET-8821-0943", expectedCat: "custom" },
    ];

    for (const s of testSamples) {
      const matches = detect(s.text, ALL_CATEGORIES, customPatterns);
      const found = matches.filter((m) => m.category === s.expectedCat);
      expect(found.length, `Expected finding for ${s.name}`).toBeGreaterThan(0);
    }
  });
});
