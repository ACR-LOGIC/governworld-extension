// Regression coverage for the synthetic PHI/PII test pack.
//
// Every line below is taken from a test document that was scanned end to end.
// The values listed here survived redaction and were reported as leaks:
//
//   - a Stripe test-mode key that contains underscores
//   - provider and employee names that follow a field label
//   - a name that appears in prose before a DOB/MRN parenthetical
//   - an address whose street suffix is "Plaza"
//   - labeled card verification and expiry values
//
// Values are synthetic and split with `fx` so no credential-shaped literal is
// committed to the repository (see tests/secrets-detection.test.ts).
import { describe, expect, it } from "vitest";
import { detect, maskValue } from "../src/content/detect.js";

const ALL = [
  "payment_card",
  "ssn",
  "email",
  "phone",
  "dob",
  "medical_record_number",
  "member_id",
  "address",
  "possible_name",
  "secrets",
  "custom",
] as const;

function values(text: string, category: string): string[] {
  return detect(text, [...ALL], [])
    .filter((m) => m.category === category)
    .map((m) => m.value);
}

const fx = (...parts: string[]): string => parts.join("");

describe("PHI/PII test pack regressions", () => {
  it("masks a Stripe test-mode key containing underscores", () => {
    const token = fx("sk_test_", "EXAMPLE_ONLY_7d2f91");
    expect(values(`Account token: ${token}`, "secrets")).toContain(token);
  });

  it("masks provider and employee names after their labels", () => {
    expect(values("Provider: Dr. Taylor Placeholder", "possible_name")).toContain("Dr. Taylor Placeholder");
    expect(values("Employee: Morgan Demo", "possible_name")).toContain("Morgan Demo");
  });

  it("masks a name that precedes a DOB/MRN parenthetical", () => {
    const text = "On 2026-10-29, Casey Fictional (DOB 04/22/1990; MRN 884310) called the care desk.";
    expect(values(text, "possible_name")).toContain("Casey Fictional");
  });

  it("masks an address whose street suffix is Plaza", () => {
    expect(values("Office location: 500 Training Plaza, Sampleville, TX 00000", "address")).toContain(
      "500 Training Plaza, Sampleville, TX 00000",
    );
  });

  it("masks labeled card verification values and expiry dates", () => {
    expect(values("CVV placeholder: 123", "payment_card")).toContain("123");
    expect(values("Expiration: 12/30", "payment_card")).toContain("12/30");
  });

  it("does not reveal a short card value through the masked preview", () => {
    expect(maskValue("payment_card", "123")).toBe("***");
    expect(maskValue("payment_card", "12/30")).toBe("*****");
  });

  it("does not treat identifier labels as names", () => {
    expect(values("Customer number: CUST-TEST-482901", "possible_name")).toEqual([]);
    expect(values("Provider phone: (415) 555-1234", "possible_name")).toEqual([]);
  });
});
