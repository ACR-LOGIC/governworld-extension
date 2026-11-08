// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect } from "vitest";
import {
  isValidSsn,
  isValidItin,
  isValidCardExpiry,
  isValidDea,
  isValidMbi,
  luhnValid,
  isValidLuhn,
  isValidNpi,
  isNonProviderBound,
  isValidCusip,
  isValidIsin,
  isValidSedol,
  isValidLoinc,
  isValidIban,
  isValidPassport,
  isValidMrz,
} from "../src/validators/index.js";

describe("isValidSsn", () => {
  it("accepts valid SSN shapes", () => {
    expect(isValidSsn("123-45-6789")).toBe(true);
    expect(isValidSsn("123 45 6789")).toBe(true);
    expect(isValidSsn("001234567")).toBe(true);
  });

  it("rejects structurally impossible values", () => {
    expect(isValidSsn("000-12-3456")).toBe(false); // area 000
    expect(isValidSsn("666-12-3456")).toBe(false); // area 666
    expect(isValidSsn("900-12-3456")).toBe(false); // area 900-999 never issued
    expect(isValidSsn("999-99-9999")).toBe(false);
    expect(isValidSsn("123-00-6789")).toBe(false); // group 00
    expect(isValidSsn("123-45-0000")).toBe(false); // serial 0000
    expect(isValidSsn("123456")).toBe(false); // wrong length
  });
});

describe("isValidItin", () => {
  it("accepts a valid ITIN", () => {
    expect(isValidItin("912-70-1234")).toBe(true);
    expect(isValidItin("987-98-7654")).toBe(true);
  });

  it("rejects non-9xx, invalid group, or zero serial", () => {
    expect(isValidItin("123-45-6789")).toBe(false);
    expect(isValidItin("900-00-0000")).toBe(false);
    expect(isValidItin("912-69-1234")).toBe(false); // group 69 not assigned
    expect(isValidItin("912-70-0000")).toBe(false); // serial 0000
  });
});

describe("isValidCardExpiry", () => {
  it("accepts near-future expiries", () => {
    const year = String(new Date().getFullYear() % 100).padStart(2, "0");
    expect(isValidCardExpiry(`12/${year}`)).toBe(true);
  });

  it("rejects out-of-range months and far-future years", () => {
    expect(isValidCardExpiry("13/30")).toBe(false);
    expect(isValidCardExpiry("00/30")).toBe(false);
    expect(isValidCardExpiry("01/2099")).toBe(false);
  });
});

describe("isValidDea", () => {
  it("accepts a valid DEA number", () => {
    expect(isValidDea("AB1234563")).toBe(true);
  });

  it("rejects invalid checksums and registrant letters", () => {
    expect(isValidDea("AB1234567")).toBe(false); // check digit 7 != computed 3
    expect(isValidDea("IB1234563")).toBe(false); // 'I' not a registrant code
    expect(isValidDea("AB123456")).toBe(false); // wrong length
  });
});

describe("isValidMbi", () => {
  it("accepts a valid MBI", () => {
    expect(isValidMbi("1EG4-TE5-MK73")).toBe(true);
    expect(isValidMbi("1EG4TE5MK73")).toBe(true);
  });

  it("rejects forbidden letters and wrong shapes", () => {
    expect(isValidMbi("1SG4TE5MK73")).toBe(false); // 'S' excluded
    expect(isValidMbi("1EG4TE5MK7")).toBe(false); // wrong length
    expect(isValidMbi("12345678901")).toBe(false); // all digits
  });
});

describe("Luhn / NPI", () => {
  it("luhnValid accepts valid card numbers only", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
    expect(isValidLuhn("4111111111111111")).toBe(true);
  });

  it("isValidNpi checks the 80840-prefixed Luhn", () => {
    expect(isValidNpi("1234567893")).toBe(true);
    expect(isValidNpi("1993999998")).toBe(true);
    expect(isValidNpi("1234567890")).toBe(false);
  });
});

describe("isNonProviderBound", () => {
  it("flags non-provider identifier labels", () => {
    expect(isNonProviderBound("Serial number ")).toBe(true);
    expect(isNonProviderBound("asset tag: ")).toBe(true);
    expect(isNonProviderBound("Invoice ")).toBe(true);
  });

  it("does not flag provider context", () => {
    expect(isNonProviderBound("NPI ")).toBe(false);
    expect(isNonProviderBound("Provider number ")).toBe(false);
  });
});

describe("isValidCusip", () => {
  it("validates authentic CUSIP numbers with correct check digit", () => {
    // Apple Inc CUSIP: 037833100
    expect(isValidCusip("037833100")).toBe(true);
    // Microsoft Corp CUSIP: 594918104
    expect(isValidCusip("594918104")).toBe(true);
  });

  it("rejects invalid CUSIPs (bad check digit, wrong length, forbidden chars)", () => {
    expect(isValidCusip("037833109")).toBe(false); // wrong check digit
    expect(isValidCusip("03783310")).toBe(false); // too short
    expect(isValidCusip("0378331000")).toBe(false); // too long
  });
});

describe("isValidIsin", () => {
  it("validates authentic ISIN codes with ISO 6166 checksum", () => {
    // Apple Inc ISIN: US0378331005
    expect(isValidIsin("US0378331005")).toBe(true);
    // Microsoft ISIN: US5949181045
    expect(isValidIsin("US5949181045")).toBe(true);
  });

  it("rejects invalid ISINs", () => {
    expect(isValidIsin("US0378331000")).toBe(false); // wrong check digit
    expect(isValidIsin("120378331005")).toBe(false); // country code must be 2 letters
    expect(isValidIsin("US037833100")).toBe(false); // too short
  });
});

describe("isValidSedol", () => {
  it("validates authentic 7-character SEDOL codes", () => {
    // British Telecom: 0925288
    expect(isValidSedol("0925288")).toBe(true);
    // BAE Systems: 0263494
    expect(isValidSedol("0263494")).toBe(true);
    // Modern alphanumeric SEDOL (e.g. B10RZP7)
    expect(isValidSedol("B10RZP7")).toBe(true);
  });

  it("rejects invalid SEDOLs (vowels forbidden, bad check digit)", () => {
    expect(isValidSedol("0925289")).toBe(false); // bad check digit
    expect(isValidSedol("092A288")).toBe(false); // 'A' vowel forbidden in SEDOL
  });
});

describe("isValidLoinc", () => {
  it("validates valid LOINC codes with Mod-10 checksum", () => {
    // Glucose in Serum/Plasma: 2345-7
    expect(isValidLoinc("2345-7")).toBe(true);
    // Hemoglobin A1c: 4548-4
    expect(isValidLoinc("4548-4")).toBe(true);
  });

  it("rejects invalid LOINC codes", () => {
    expect(isValidLoinc("2345-8")).toBe(false); // wrong check digit
    expect(isValidLoinc("23457")).toBe(false); // missing hyphen
    expect(isValidLoinc("abc-7")).toBe(false); // non-numeric
  });
});
describe("isValidIban", () => {
  it("validates authentic IBANs across different countries and spacings", () => {
    // Germany
    expect(isValidIban("DE89370400440532013000")).toBe(true);
    expect(isValidIban("DE89 3704 0044 0532 0130 00")).toBe(true);
    // Great Britain
    expect(isValidIban("GB29NWBK60161331926819")).toBe(true);
    expect(isValidIban("GB29 NWBK 6016 1331 9268 19")).toBe(true);
    // France
    expect(isValidIban("FR1420041010050500013M02606")).toBe(true);
    expect(isValidIban("FR14 2004 1010 0505 0001 3M02 606")).toBe(true);
  });

  it("rejects invalid IBANs with corrupted check digits, wrong lengths, or illegal characters", () => {
    expect(isValidIban("DE88 3704 0044 0532 0130 00")).toBe(false); // wrong checksum
    expect(isValidIban("DE89 3704 0044 0532 0130")).toBe(false); // too short for Germany
    expect(isValidIban("1234 5678 9012 3456 7890")).toBe(false); // missing country code
    expect(isValidIban("DE89 3704 0044 0532 0130 00!")).toBe(false); // illegal character
  });
});

describe("isValidPassport and isValidMrz", () => {
  it("validates standard US, UK, Canadian, and Australian passport numbers", () => {
    expect(isValidPassport("123456789", "US")).toBe(true);
    expect(isValidPassport("A12345678", "US")).toBe(true); // Next-gen passport
    expect(isValidPassport("987654321", "GB")).toBe(true);
    expect(isValidPassport("AB123456", "CA")).toBe(true);
    expect(isValidPassport("N1234567", "AU")).toBe(true);
  });

  it("rejects out-of-spec passport numbers", () => {
    expect(isValidPassport("123", "US")).toBe(false); // too short
    expect(isValidPassport("123456789012345", "US")).toBe(false); // too long
  });

  it("validates authentic ICAO Doc 9303 MRZ lines", () => {
    // TD3 Line 1
    expect(isValidMrz("P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<")).toBe(true);
    // TD3 Line 2 with valid check digit 9 over doc number L898902C3 (check digit = 6)
    // L (21)*7 + 8*3 + 9*1 + 8*7 + 9*3 + 0*1 + 2*7 + C(12)*3 + 3*1 = 147+24+9+56+27+0+14+36+3 = 316 % 10 = 6
    expect(isValidMrz("L898902C36UTO7408122F1204159ZE184226B<<<<<10")).toBe(true);
  });

  it("rejects corrupted MRZ lines", () => {
    // Corrupted check digit (9 instead of 6)
    expect(isValidMrz("L898902C39UTO7408122F1204159ZE184226B<<<<<10")).toBe(false);
    expect(isValidMrz("NOT_AN_MRZ_LINE")).toBe(false);
  });
});

