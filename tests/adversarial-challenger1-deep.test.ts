import { describe, it, expect } from "vitest";
import { detect } from "../src/content/detect.js";
import { isValidNpi } from "../src/validators/index.js";
import type { FindingCategory } from "../src/shared/types.js";

describe("Adversarial Challenger 1 Gen 2: Deep Stress Tests", () => {
  // =========================================================================
  // Dimension 1: Comprehensive Secret Start Offset Calculation
  // =========================================================================
  describe("Dimension 1: Secret Start & End Offset Invariants", () => {
    const testCases: { name: string; text: string; expectedSubstring: string }[] = [
      {
        name: "PostgreSQL connection string",
        text: "Database config: postgres://app_user:s3cr3t_P@ss!@pg-cluster.internal:5432/production?sslmode=require end.",
        expectedSubstring: "postgres://app_user:s3cr3t_P@ss!@pg-cluster.internal:5432/production?sslmode=require",
      },
      {
        name: "MySQL connection string with encoded chars",
        text: "mysql://admin:P%40ssw0rd123@127.0.0.1:3306/db_name active",
        expectedSubstring: "mysql://admin:P%40ssw0rd123@127.0.0.1:3306/db_name",
      },
      {
        name: "MongoDB replica set connection string",
        text: "URI: mongodb://dbadmin:m0ng0s3cr3t@mongo-1.corp:27017,mongo-2.corp:27017/admin?replicaSet=rs0",
        expectedSubstring: "mongodb://dbadmin:m0ng0s3cr3t@mongo-1.corp:27017,mongo-2.corp:27017/admin?replicaSet=rs0",
      },
      {
        name: "Redis connection string with auth",
        text: "Cache at redis://:supersecretredispass@redis-cache.internal:6379/0 now",
        expectedSubstring: "redis://:supersecretredispass@redis-cache.internal:6379/0",
      },
      {
        name: "AMQP connection string",
        text: "Queue url amqp://rabbituser:rabbitpass123@rabbitmq.prod:5672/vhost configured",
        expectedSubstring: "amqp://rabbituser:rabbitpass123@rabbitmq.prod:5672/vhost",
      },
      {
        name: "MSSQL connection string",
        text: "Connect via mssql://sa:ComplexPassword123@sqlserver.corp:1433/database",
        expectedSubstring: "mssql://sa:ComplexPassword123@sqlserver.corp:1433/database",
      },
      {
        name: "Azure SAS with ?sig=",
        text: "URL: https://myaccount.blob.core.windows.net/data/export.zip?sig=H4sICAAAAAAACtz923482734982347&se=2026-12-31",
        expectedSubstring: "?sig=H4sICAAAAAAACtz923482734982347",
      },
      {
        name: "Azure SAS with &sig=",
        text: "Download: https://myaccount.blob.core.windows.net/data/export.zip?sp=r&sig=k3j4h5k6j7h8g9f0a1b2c3d4e5f6g7&sv=2020-08-04",
        expectedSubstring: "&sig=k3j4h5k6j7h8g9f0a1b2c3d4e5f6g7",
      },
      {
        name: "Telegram bot token (9-digit id)",
        text: "TELEGRAM_TOKEN=123456789:AAH1234567890abcdefghijklmnopqrstuv in env",
        expectedSubstring: "123456789:AAH1234567890abcdefghijklmnopqrstuv",
      },
      {
        name: "Telegram bot token (10-digit id)",
        text: "Bot setup 9876543210:AAGabcdefghijklmnopqrstuvwxyz123456 ready",
        expectedSubstring: "9876543210:AAGabcdefghijklmnopqrstuvwxyz123456",
      },
      {
        name: "URL with credentials (https)",
        text: "Git remote: https://ci_robot:ghp_secrettoken987654321012345678@github.com/org/repo.git",
        expectedSubstring: "https://ci_robot:ghp_secrettoken987654321012345678@github.com/org/repo.git",
      },
      {
        name: "URL with credentials (http)",
        text: "WebDAV at http://admin:SecretPass456@webdav.internal/files/ checked",
        expectedSubstring: "http://admin:SecretPass456@webdav.internal/files/",
      },
      {
        name: "Azure AccountKey assignment",
        text: `Blob storage AccountKey=${"B".repeat(88)}== valid`,
        expectedSubstring: `AccountKey=${"B".repeat(88)}==`,
      },
      {
        name: "Credential assignment with colon and quotes",
        text: 'Configuration setting client_secret: "CS_9876543210_abcdefg"',
        expectedSubstring: "CS_9876543210_abcdefg",
      },
      {
        name: "Credential assignment with equals, whitespace and single quotes",
        text: "auth_token   =   'AT_12345678901234567890'",
        expectedSubstring: "AT_12345678901234567890",
      },
      {
        name: "Credential assignment unquoted with hyphens and dots",
        text: "api-key: ak-prod.v1.9876543210.fedcba",
        expectedSubstring: "ak-prod.v1.9876543210.fedcba",
      },
      {
        name: "Credential assignment with password and value sharing prefix",
        text: "password: 'password_secret1234567890'",
        expectedSubstring: "password_secret1234567890",
      },
      {
        name: "AWS secret access key",
        text: "aws_secret_access_key = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'",
        expectedSubstring: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      },
    ];

    for (const tc of testCases) {
      it(`verifies 100% exact substring match for ${tc.name}`, () => {
        const matches = detect(tc.text, ["secrets"]);
        expect(matches.length, `Expected at least 1 match for "${tc.text}"`).toBeGreaterThanOrEqual(1);
        const match = matches.find((m) => m.value.includes(tc.expectedSubstring) || tc.expectedSubstring.includes(m.value));
        expect(match, `Could not find match matching "${tc.expectedSubstring}"`).toBeDefined();
        const extracted = tc.text.slice(match!.start, match!.end);
        expect(extracted).toBe(match!.value);
        expect(extracted).toBe(tc.expectedSubstring);
      });
    }

    it("verifies multi-secret text maintains exact offsets for every match", () => {
      const text = [
        "1. postgres://u:p123456@db:5432/main",
        "2. 123456789:AAabcdefghijklmnopqrstuvwxyz1234567",
        "3. https://example.com/blob?sig=1234567890abcdef1234567890",
        "4. api_key: 'mysecret123456789012'",
      ].join("\n");

      const matches = detect(text, ["secrets"]);
      expect(matches.length).toBeGreaterThanOrEqual(4);
      for (const m of matches) {
        expect(text.slice(m.start, m.end)).toBe(m.value);
      }
    });

    it("verifies overlap resolution retains highest confidence secret", () => {
      // api_key: "xoxb-1234567890-1234567890123" matches generic credential (0.80) and Slack (0.99)
      const text = 'api_key: "xoxb-1234567890-1234567890123"';
      const matches = detect(text, ["secrets"]);
      expect(matches).toHaveLength(1);
      expect(matches[0].confidence).toBe(0.99);
      expect(text.slice(matches[0].start, matches[0].end)).toBe("xoxb-1234567890-1234567890123");
    });
  });

  // =========================================================================
  // Dimension 2: NPI Word Boundary & Phone Prefix Adversarial Matrix
  // =========================================================================
  describe("Dimension 2: NPI Word Boundary & Suppression Invariants", () => {
    const validNpi = "1234567893"; // Luhn valid with 80840 prefix

    it("verifies Luhn check logic for test vectors", () => {
      expect(isValidNpi(validNpi)).toBe(true);
      expect(isValidNpi("1993999998")).toBe(true);
      expect(isValidNpi("1234567890")).toBe(false);
    });

    // Words that end in phone-like letter sequences but ARE NOT phone prefixes
    const falseSuppressionCandidates = [
      "hotel:",
      "motel:",
      "hostel:",
      "recall:",
      "rollcall:",
      "excel:",
      "cartel:",
      "brothel:",
      "chattel:",
      "infocell:",
      "autocall:",
      "cancel:",
      "propel:",
      "dispel:",
      "compel:",
      "downfall:",
      "waterfall:",
      "pitfall:",
      "windfall:",
      "tell:",
      "yell:",
      "HOTEL:",
      "MOTEL #",
      "RECALL:",
    ];

    for (const word of falseSuppressionCandidates) {
      it(`does NOT falsely suppress NPI when preceded by "${word}"`, () => {
        const text = `Provider location at ${word} ${validNpi} confirmed.`;
        const matches = detect(text, ["npi"]);
        const npis = matches.filter((m) => m.category === "npi");
        expect(npis.length, `NPI falsely suppressed by "${word}"`).toBe(1);
        expect(npis[0].value).toBe(validNpi);
        expect(text.slice(npis[0].start, npis[0].end)).toBe(validNpi);
      });
    }

    // Explicit phone prefixes that MUST suppress NPI (true positives for phone exclusion)
    const truePhonePrefixes = [
      "tel:",
      "tel: ",
      "Tel:",
      "TEL:",
      "tel#",
      "tel # ",
      "phone:",
      "Phone:",
      "PHONE: ",
      "fax:",
      "Fax:",
      "FAX: ",
      "mobile:",
      "Mobile:",
      "cell:",
      "Cell:",
      "call:",
      "Call:",
      "call: ",
      "call ",
    ];

    for (const prefix of truePhonePrefixes) {
      it(`strictly suppresses NPI when preceded by true phone prefix "${prefix}"`, () => {
        const text = `Contact physician at ${prefix}${validNpi} immediately.`;
        const matches = detect(text, ["npi"]);
        const npis = matches.filter((m) => m.category === "npi");
        expect(npis.length, `Failed to suppress NPI preceded by phone indicator "${prefix}"`).toBe(0);
      });
    }

    it("detects NPI at string boundaries without underflow/overflow", () => {
      // At index 0
      const atStart = `${validNpi} is provider identifier.`;
      const mStart = detect(atStart, ["npi"]).filter((m) => m.category === "npi");
      expect(mStart).toHaveLength(1);
      expect(mStart[0].start).toBe(0);

      // At end of string
      const atEnd = `Provider ID: ${validNpi}`;
      const mEnd = detect(atEnd, ["npi"]).filter((m) => m.category === "npi");
      expect(mEnd).toHaveLength(1);
      expect(mEnd[0].end).toBe(atEnd.length);
    });
  });

  // =========================================================================
  // Dimension 3: Rescan & Confidence Thresholds Stress Tests
  // =========================================================================
  describe("Dimension 3: Rescan & Confidence Threshold Filtering", () => {
    it("simulates rescan pipeline: filters new findings strictly by confidenceThresholds", () => {
      const settings = {
        enabledCategories: ["email", "npi", "secrets", "possible_name"] as FindingCategory[],
        confidenceThresholds: {
          email: 0.90,
          npi: 0.85, // Bare NPI is 0.70 (will be filtered), prefixed is 0.93 (accepted)
          secrets: 0.90, // Low-conf secret is 0.80 (filtered), DB is 0.95 (accepted)
          possible_name: 0.75, // Generic possible_name is 0.60 (filtered)
        } as Record<FindingCategory, number>,
      };

      const threshold = (cat: FindingCategory) => settings.confidenceThresholds?.[cat] ?? 0;

      // Text contains:
      // 1. Bare NPI (conf: 0.70) -> below 0.85 -> rejected
      // 2. Prefixed NPI (conf: 0.93) -> above 0.85 -> accepted
      // 3. Email (conf: 0.92) -> above 0.90 -> accepted
      // 4. Generic credential (conf: 0.80) -> below 0.90 -> rejected
      // 5. DB connection string (conf: 0.95) -> above 0.90 -> accepted
      const text = [
        "Unprefixed candidate 1234567893 should be filtered.",
        "National Provider Identifier: 1993999998 should be kept.",
        "Contact user@example.com for help.",
        "token: 'secret123456789012' should be filtered.",
        "postgres://u:pass123456@db:5432/main should be kept.",
      ].join("\n");

      const rawMatches = detect(text, settings.enabledCategories, []).filter(
        (m) => m.confidence >= threshold(m.category)
      );

      // Verify rawMatches filtered correctly
      const acceptedCategories = rawMatches.map((m) => ({ cat: m.category, val: m.value, conf: m.confidence }));
      
      // 1. Bare NPI filtered out
      expect(acceptedCategories.some((m) => m.val === "1234567893")).toBe(false);
      // 2. Prefixed NPI kept
      expect(acceptedCategories.some((m) => m.val === "1993999998")).toBe(true);
      // 3. Email kept
      expect(acceptedCategories.some((m) => m.val === "user@example.com")).toBe(true);
      // 4. Low-confidence secret filtered out
      expect(acceptedCategories.some((m) => m.val === "secret123456789012")).toBe(false);
      // 5. High-confidence secret kept
      expect(acceptedCategories.some((m) => m.val.startsWith("postgres://"))).toBe(true);

      // Verify all accepted findings satisfy threshold
      for (const m of rawMatches) {
        expect(m.confidence).toBeGreaterThanOrEqual(threshold(m.category));
      }
    });

    it("verifies dynamic mutation rescan does not resurrect previously-filtered findings", () => {
      const thresholds: Partial<Record<FindingCategory, number>> = {
        npi: 0.80, // suppresses bare NPI (0.70)
      };
      const threshold = (cat: FindingCategory) => thresholds[cat] ?? 0;

      // Initial state has bare NPI (without "NPI" label)
      const initialText = "Initial content with bare candidate 1234567893.";
      const initialMatches = detect(initialText, ["npi"]).filter((m) => m.confidence >= threshold(m.category));
      expect(initialMatches).toHaveLength(0); // Filtered out

      // Mutation adds new segment
      const mutatedCombined = initialText + "\nNew segment with Dr. Smith NPI: 1993999998.";
      const rescanMatches = detect(mutatedCombined, ["npi"]).filter((m) => m.confidence >= threshold(m.category));

      // Rescan finds only the high-confidence NPI, bare NPI is NOT resurrected
      expect(rescanMatches).toHaveLength(1);
      expect(rescanMatches[0].value).toBe("1993999998");
      expect(rescanMatches[0].confidence).toBeGreaterThanOrEqual(0.80);
    });

    it("handles boundary threshold at exactly 0.0 and 1.0", () => {
      const text = "Email doctor@clinic.org with candidate 1234567893";
      
      // Threshold 0.0 accepts everything
      const matches0 = detect(text, ["email", "npi"]).filter((m) => m.confidence >= 0.0);
      expect(matches0.length).toBeGreaterThanOrEqual(2);

      // Threshold 1.0 rejects all (since highest detector conf is ~0.99)
      const matches1 = detect(text, ["email", "npi"]).filter((m) => m.confidence >= 1.0);
      expect(matches1).toHaveLength(0);
    });
  });
});
