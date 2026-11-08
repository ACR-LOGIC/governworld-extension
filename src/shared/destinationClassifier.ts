// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
/**
 * Local, deterministic destination classification engine for GovernWorld.
 *
 * Classifies destination websites into risk tiers:
 * - TRUSTED_INTERNAL: 0 risk (EHRs, clinic portals, internal health networks)
 * - UNKNOWN_WEB: +10 risk (General internet websites)
 * - PERSONAL_STORAGE: +20 risk (Dropbox, Google Drive, Box, OneDrive)
 * - EXTERNAL_AI: +30 risk (ChatGPT, Claude, Gemini, Perplexity, Copilot, DeepSeek)
 *
 * Zero external network calls. Evaluated synchronously on-device.
 */

import { HEALTHCARE_DOMAINS } from "./phiEvidence.js";

export type DestinationCategory =
  | "TRUSTED_INTERNAL"
  | "UNKNOWN_WEB"
  | "PERSONAL_STORAGE"
  | "EXTERNAL_AI";

export interface DestinationDefinition {
  id: string;
  name: string;
  domains: string[];
  risk: number;
}

export interface DestinationClassification {
  category: DestinationCategory;
  risk: number;
  hostname: string;
  serviceId?: string;
  serviceName?: string;
  isAi: boolean;
  isTrusted: boolean;
}

export interface DestinationClassifierOptions {
  trustedInternalDomains?: string[];
  trustedAiDomains?: string[];
}

/** Built-in high-confidence AI destinations */
export const DEFAULT_AI_REGISTRY: readonly DestinationDefinition[] = [
  {
    id: "chatgpt",
    name: "ChatGPT / OpenAI",
    domains: ["chatgpt.com", "chat.openai.com", "platform.openai.com"],
    risk: 30,
  },
  {
    id: "claude",
    name: "Anthropic Claude",
    domains: ["claude.ai", "console.anthropic.com"],
    risk: 30,
  },
  {
    id: "gemini",
    name: "Google Gemini",
    domains: ["gemini.google.com", "aistudio.google.com"],
    risk: 30,
  },
  {
    id: "perplexity",
    name: "Perplexity AI",
    domains: ["perplexity.ai", "www.perplexity.ai"],
    risk: 30,
  },
  {
    id: "copilot",
    name: "Microsoft Copilot",
    domains: ["copilot.microsoft.com"],
    risk: 20,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    domains: ["chat.deepseek.com", "deepseek.com"],
    risk: 30,
  },
  {
    id: "mistral",
    name: "Mistral / Le Chat",
    domains: ["chat.mistral.ai", "mistral.ai"],
    risk: 30,
  },
  {
    id: "poe",
    name: "Poe",
    domains: ["poe.com"],
    risk: 30,
  },
  {
    id: "huggingface",
    name: "Hugging Face Chat",
    domains: ["hf.co/chat", "huggingface.co/chat"],
    risk: 30,
  },
];

/** Built-in personal / cloud storage destinations */
export const DEFAULT_STORAGE_REGISTRY: readonly DestinationDefinition[] = [
  {
    id: "dropbox",
    name: "Dropbox",
    domains: ["dropbox.com", "www.dropbox.com", "paper.dropbox.com"],
    risk: 20,
  },
  {
    id: "google_drive",
    name: "Google Drive",
    domains: ["drive.google.com", "docs.google.com"],
    risk: 20,
  },
  {
    id: "onedrive",
    name: "Microsoft OneDrive",
    domains: ["onedrive.live.com", "onedrive.com"],
    risk: 20,
  },
  {
    id: "box",
    name: "Box",
    domains: ["box.com", "app.box.com"],
    risk: 20,
  },
  {
    id: "icloud",
    name: "Apple iCloud",
    domains: ["icloud.com", "www.icloud.com"],
    risk: 20,
  },
  {
    id: "wetransfer",
    name: "WeTransfer",
    domains: ["wetransfer.com"],
    risk: 20,
  },
];

/** Known healthcare EHR & clinical internal domain examples */
export const DEFAULT_TRUSTED_INTERNAL_PATTERNS: readonly string[] = [
  "*.internal",
  "*.local",
  "*.corp",
  "localhost",
  "127.0.0.1",
  "::1",
  ...HEALTHCARE_DOMAINS.map((d) => "*." + d),
  ...HEALTHCARE_DOMAINS,
];

/** Normalize host or full URL into a clean lowercase hostname without port */
export function normalizeHostname(urlOrHost: string): string {
  if (!urlOrHost || typeof urlOrHost !== "string") return "";
  let host = urlOrHost.trim().toLowerCase();
  try {
    if (host.includes("://")) {
      const u = new URL(host);
      host = u.hostname;
    } else {
      const slash = host.indexOf("/");
      if (slash >= 0) {
        host = host.slice(0, slash);
      }
      const colon = host.indexOf(":");
      if (colon >= 0) {
        host = host.slice(0, colon);
      }
    }
  } catch {
    // Keep fallback cleaned host
  }
  return host.replace(/^\.+|\.+$/g, "");
}

/** Check if a hostname matches a domain pattern (supports exact and *.example.com wildcard) */
export function matchesDomainPattern(pattern: string, hostname: string): boolean {
  if (!pattern || !hostname) return false;
  const p = pattern.trim().toLowerCase();
  const h = hostname.trim().toLowerCase();
  if (p === h) return true;
  if (p.startsWith("*.")) {
    const root = p.slice(2);
    return h === root || h.endsWith("." + root);
  }
  if (p.startsWith(".")) {
    const root = p.slice(1);
    return h === root || h.endsWith("." + root);
  }
  // If pattern does not have wildcard, match exact or subdomains (e.g. "chatgpt.com" matches "sub.chatgpt.com")
  return h === p || h.endsWith("." + p);
}

/**
 * Classifies a destination hostname into category and destination risk score.
 */
export function classifyDestination(
  urlOrHost: string = "",
  options: DestinationClassifierOptions = {}
): DestinationClassification {
  const host = normalizeHostname(urlOrHost);

  // 1. Check for Trusted Internal Domains
  const trustedPatterns = [
    ...(options.trustedInternalDomains ?? []),
    ...DEFAULT_TRUSTED_INTERNAL_PATTERNS,
  ];
  for (const pattern of trustedPatterns) {
    if (matchesDomainPattern(pattern, host)) {
      return {
        category: "TRUSTED_INTERNAL",
        risk: 0,
        hostname: host,
        serviceId: "trusted_internal",
        serviceName: "Trusted Internal System",
        isAi: false,
        isTrusted: true,
      };
    }
  }

  // 2. Check for Trusted AI (Enterprise / internal sanctioned AI)
  if (options.trustedAiDomains && options.trustedAiDomains.length > 0) {
    for (const pattern of options.trustedAiDomains) {
      if (matchesDomainPattern(pattern, host)) {
        return {
          category: "EXTERNAL_AI",
          risk: 10, // Enterprise sanctioned AI gets reduced risk
          hostname: host,
          serviceId: "trusted_ai",
          serviceName: "Sanctioned Enterprise AI",
          isAi: true,
          isTrusted: true,
        };
      }
    }
  }

  // 3. Check External AI Registry
  for (const aiDef of DEFAULT_AI_REGISTRY) {
    for (const domain of aiDef.domains) {
      if (matchesDomainPattern(domain, host)) {
        return {
          category: "EXTERNAL_AI",
          risk: aiDef.risk,
          hostname: host,
          serviceId: aiDef.id,
          serviceName: aiDef.name,
          isAi: true,
          isTrusted: false,
        };
      }
    }
  }

  // 4. Check Personal / Cloud Storage Registry
  for (const storageDef of DEFAULT_STORAGE_REGISTRY) {
    for (const domain of storageDef.domains) {
      if (matchesDomainPattern(domain, host)) {
        return {
          category: "PERSONAL_STORAGE",
          risk: storageDef.risk,
          hostname: host,
          serviceId: storageDef.id,
          serviceName: storageDef.name,
          isAi: false,
          isTrusted: false,
        };
      }
    }
  }

  // 5. Default / Unknown Web
  return {
    category: "UNKNOWN_WEB",
    risk: 10,
    hostname: host,
    serviceId: "unknown_web",
    serviceName: "External Website",
    isAi: false,
    isTrusted: false,
  };
}
