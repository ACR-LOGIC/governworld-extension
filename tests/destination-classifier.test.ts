// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect } from "vitest";
import {
  classifyDestination,
  matchesDomainPattern,
  normalizeHostname,
} from "../src/shared/destinationClassifier.js";

describe("Destination Classifier", () => {
  describe("normalizeHostname", () => {
    it("handles plain hostnames", () => {
      expect(normalizeHostname("chatgpt.com")).toBe("chatgpt.com");
      expect(normalizeHostname("   CLAUDE.AI   ")).toBe("claude.ai");
    });

    it("extracts hostname from full URLs", () => {
      expect(normalizeHostname("https://chat.openai.com/c/1234")).toBe("chat.openai.com");
      expect(normalizeHostname("http://localhost:8080/path?query=1")).toBe("localhost");
      expect(normalizeHostname("https://drive.google.com:443/drive/my-drive")).toBe("drive.google.com");
    });

    it("handles empty or invalid inputs safely", () => {
      expect(normalizeHostname("")).toBe("");
      expect(normalizeHostname(null as any)).toBe("");
    });
  });

  describe("matchesDomainPattern", () => {
    it("matches exact domains", () => {
      expect(matchesDomainPattern("claude.ai", "claude.ai")).toBe(true);
      expect(matchesDomainPattern("claude.ai", "openai.com")).toBe(false);
    });

    it("matches subdomains with wildcard", () => {
      expect(matchesDomainPattern("*.hospital.net", "portal.hospital.net")).toBe(true);
      expect(matchesDomainPattern("*.hospital.net", "hospital.net")).toBe(true);
      expect(matchesDomainPattern("*.hospital.net", "otherhospital.net")).toBe(false);
    });

    it("matches default root domains for subdomains", () => {
      expect(matchesDomainPattern("dropbox.com", "paper.dropbox.com")).toBe(true);
    });
  });

  describe("classifyDestination", () => {
    it("classifies major AI providers as EXTERNAL_AI with +30 risk", () => {
      const openAi = classifyDestination("https://chat.openai.com");
      expect(openAi.category).toBe("EXTERNAL_AI");
      expect(openAi.risk).toBe(30);
      expect(openAi.isAi).toBe(true);
      expect(openAi.isTrusted).toBe(false);

      const claude = classifyDestination("https://claude.ai/chat");
      expect(claude.category).toBe("EXTERNAL_AI");
      expect(claude.risk).toBe(30);

      const gemini = classifyDestination("https://gemini.google.com");
      expect(gemini.category).toBe("EXTERNAL_AI");
      expect(gemini.risk).toBe(30);

      const perplexity = classifyDestination("https://www.perplexity.ai/search");
      expect(perplexity.category).toBe("EXTERNAL_AI");
      expect(perplexity.risk).toBe(30);

      const deepseek = classifyDestination("https://chat.deepseek.com");
      expect(deepseek.category).toBe("EXTERNAL_AI");
      expect(deepseek.risk).toBe(30);
    });

    it("classifies Microsoft Copilot with specified risk (20)", () => {
      const copilot = classifyDestination("https://copilot.microsoft.com");
      expect(copilot.category).toBe("EXTERNAL_AI");
      expect(copilot.risk).toBe(20);
      expect(copilot.isAi).toBe(true);
    });

    it("classifies personal / cloud storage destinations as PERSONAL_STORAGE with +20 risk", () => {
      const dropbox = classifyDestination("https://www.dropbox.com/home");
      expect(dropbox.category).toBe("PERSONAL_STORAGE");
      expect(dropbox.risk).toBe(20);
      expect(dropbox.isAi).toBe(false);

      const gdrive = classifyDestination("https://drive.google.com/drive/u/0/my-drive");
      expect(gdrive.category).toBe("PERSONAL_STORAGE");
      expect(gdrive.risk).toBe(20);

      const onedrive = classifyDestination("https://onedrive.live.com");
      expect(onedrive.category).toBe("PERSONAL_STORAGE");
      expect(onedrive.risk).toBe(20);

      const box = classifyDestination("https://app.box.com/folder/0");
      expect(box.category).toBe("PERSONAL_STORAGE");
      expect(box.risk).toBe(20);
    });

    it("classifies internal / local domains as TRUSTED_INTERNAL with 0 risk", () => {
      const local = classifyDestination("http://localhost:3000/app");
      expect(local.category).toBe("TRUSTED_INTERNAL");
      expect(local.risk).toBe(0);
      expect(local.isTrusted).toBe(true);

      const corp = classifyDestination("https://ehr.internal/patients");
      expect(corp.category).toBe("TRUSTED_INTERNAL");
      expect(corp.risk).toBe(0);
    });

    it("respects custom trusted internal domains passed in options", () => {
      const options = {
        trustedInternalDomains: ["ehr.company.com", "*.hospital.net", "clinic.org"],
      };

      const ehr = classifyDestination("https://ehr.company.com/chart/992", options);
      expect(ehr.category).toBe("TRUSTED_INTERNAL");
      expect(ehr.risk).toBe(0);
      expect(ehr.isTrusted).toBe(true);

      const hospital = classifyDestination("https://records.hospital.net", options);
      expect(hospital.category).toBe("TRUSTED_INTERNAL");
      expect(hospital.risk).toBe(0);
      expect(hospital.isTrusted).toBe(true);
    });

    it("supports enterprise-sanctioned AI domains with reduced risk (+10)", () => {
      const options = {
        trustedAiDomains: ["copilot.company.com", "ai.internal.hospital.net"],
      };

      const enterpriseCopilot = classifyDestination("https://copilot.company.com", options);
      expect(enterpriseCopilot.category).toBe("EXTERNAL_AI");
      expect(enterpriseCopilot.risk).toBe(10);
      expect(enterpriseCopilot.isTrusted).toBe(true);
      expect(enterpriseCopilot.isAi).toBe(true);
    });

    it("falls back to UNKNOWN_WEB with +10 risk for unrecognized domains", () => {
      const unknown = classifyDestination("https://random-forum-website.org/thread/42");
      expect(unknown.category).toBe("UNKNOWN_WEB");
      expect(unknown.risk).toBe(10);
      expect(unknown.isAi).toBe(false);
      expect(unknown.isTrusted).toBe(false);
    });
  });
});
