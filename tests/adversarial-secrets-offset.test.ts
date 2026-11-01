import { describe, it, expect } from "vitest";
import { detect } from "../src/content/detect.js";

describe("Adversarial Secrets Offset Verification", () => {
  it("verifies DB connection string start and end offsets", () => {
    const text = "Connect using postgres://user:secret123456@db.internal:5432/main now.";
    const matches = detect(text, ["secrets"]);
    const dbMatch = matches.find((m) => m.value.includes("postgres"));
    expect(dbMatch).toBeDefined();
    expect(text.slice(dbMatch!.start, dbMatch!.end)).toBe("postgres://user:secret123456@db.internal:5432/main");
  });

  it("verifies Azure SAS signature start and end offsets", () => {
    const text = "Download from https://example.com/blob?sig=abcdefghijklmnopqrstuvwxyz123456 extra";
    const matches = detect(text, ["secrets"]);
    const sasMatch = matches.find((m) => m.value.includes("sig="));
    expect(sasMatch).toBeDefined();
    expect(text.slice(sasMatch!.start, sasMatch!.end)).toBe("?sig=abcdefghijklmnopqrstuvwxyz123456");
  });

  it("verifies Telegram bot token start and end offsets", () => {
    const text = "Bot key 123456789:AAabcdefghijklmnopqrstuvwxyz1234567 in config";
    const matches = detect(text, ["secrets"]);
    const tgMatch = matches.find((m) => m.value.includes(":AA"));
    expect(tgMatch).toBeDefined();
    expect(text.slice(tgMatch!.start, tgMatch!.end)).toBe("123456789:AAabcdefghijklmnopqrstuvwxyz1234567");
  });

  it("verifies Azure account key start and end offsets", () => {
    const key = "A".repeat(88);
    const text = `Azure AccountKey=${key} configured.`;
    const matches = detect(text, ["secrets"]);
    const azMatch = matches.find((m) => m.value.includes("AccountKey="));
    expect(azMatch).toBeDefined();
    expect(text.slice(azMatch!.start, azMatch!.end)).toBe(`AccountKey=${key}`);
  });

  it("verifies URL with credentials start and end offsets", () => {
    const text = "Clone from https://user:password123@example.com/repo.git securely.";
    const matches = detect(text, ["secrets"]);
    const urlMatch = matches.find((m) => m.value.includes("https://"));
    expect(urlMatch).toBeDefined();
    expect(text.slice(urlMatch!.start, urlMatch!.end)).toBe("https://user:password123@example.com/repo.git");
  });
});
