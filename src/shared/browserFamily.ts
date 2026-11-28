// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.

export type BrowserFamily =
  | "chrome"
  | "edge"
  | "firefox"
  | "safari"
  | "brave"
  | "opera"
  | "vivaldi"
  | "chromium"
  | "unknown";

export const BROWSER_FAMILIES: ReadonlySet<BrowserFamily> = new Set<BrowserFamily>([
  "chrome",
  "edge",
  "firefox",
  "safari",
  "brave",
  "opera",
  "vivaldi",
  "chromium",
  "unknown",
]);

export const BROWSER_FAMILY_LABELS: Record<BrowserFamily, string> = {
  chrome: "Chrome",
  edge: "Edge",
  firefox: "Firefox",
  safari: "Safari",
  brave: "Brave",
  opera: "Opera",
  vivaldi: "Vivaldi",
  chromium: "Chromium",
  unknown: "Browser",
};

export interface NavigatorLike {
  userAgentData?: {
    brands?: ReadonlyArray<{ brand: string; version: string }>;
  };
  userAgent?: string;
  brave?: unknown;
}

export interface DetectedBrowserInfo {
  family: BrowserFamily;
  displayName: string;
  version: string;
}

export function isBrowserFamily(value: unknown): value is BrowserFamily {
  return typeof value === "string" && BROWSER_FAMILIES.has(value as BrowserFamily);
}

export function browserDisplayName(family: BrowserFamily): string {
  switch (family) {
    case "chrome":
      return "Chrome";
    case "edge":
      return "Edge";
    case "firefox":
      return "Firefox";
    case "safari":
      return "Safari";
    case "brave":
      return "Brave";
    case "opera":
      return "Opera";
    case "vivaldi":
      return "Vivaldi";
    case "chromium":
      return "Chromium";
    default:
      return "Browser";
  }
}

function sanitizeVersion(raw: string | undefined): string {
  if (!raw) return "unknown";
  const parts = raw.trim().split(".");
  const numericParts: string[] = [];
  for (const part of parts.slice(0, 4)) {
    const digits = /^\d{1,5}/.exec(part);
    if (!digits) break;
    numericParts.push(digits[0]);
    if (digits[0].length !== part.length) break;
  }
  return numericParts.length > 0 ? numericParts.join(".") : "unknown";
}

/**
 * Deterministically identifies the host browser family using `navigator.userAgentData`
 * with User-Agent string fallbacks. Never reads or emits sensitive user data.
 */
export function detectBrowserFamily(nav?: NavigatorLike): DetectedBrowserInfo {
  const source: NavigatorLike | undefined =
    nav ?? (typeof navigator !== "undefined" ? (navigator as unknown as NavigatorLike) : undefined);

  const brands = source?.userAgentData?.brands;
  if (Array.isArray(brands) && brands.length > 0) {
    const normalized = brands
      .filter((b) => b && typeof b.brand === "string")
      .map((b) => ({ brand: b.brand.toLowerCase(), version: sanitizeVersion(b.version) }));

    const matchBrand = (needle: string) => normalized.find((b) => b.brand.includes(needle));

    const edge = matchBrand("microsoft edge");
    if (edge) return { family: "edge", displayName: "Edge", version: edge.version };

    const brave = matchBrand("brave");
    if (brave || source?.brave !== undefined) {
      return { family: "brave", displayName: "Brave", version: brave?.version ?? "unknown" };
    }

    const opera = matchBrand("opera");
    if (opera) return { family: "opera", displayName: "Opera", version: opera.version };

    const vivaldi = matchBrand("vivaldi");
    if (vivaldi) return { family: "vivaldi", displayName: "Vivaldi", version: vivaldi.version };

    const chrome = matchBrand("google chrome");
    if (chrome) return { family: "chrome", displayName: "Chrome", version: chrome.version };

    const chromium = matchBrand("chromium");
    if (chromium) return { family: "chromium", displayName: "Chromium", version: chromium.version };
  }

  const ua = typeof source?.userAgent === "string" ? source.userAgent : "";
  if (ua.includes("Firefox/")) {
    const m = ua.match(/Firefox\/([0-9.]+)/);
    return { family: "firefox", displayName: "Firefox", version: sanitizeVersion(m?.[1]) };
  }
  if (ua.includes("Edg/") || ua.includes("EdgA/") || ua.includes("EdgiOS/")) {
    const m = ua.match(/Edg(?:A|iOS)?\/([0-9.]+)/);
    return { family: "edge", displayName: "Edge", version: sanitizeVersion(m?.[1]) };
  }
  if (ua.includes("OPR/") || ua.includes("Opera/")) {
    const m = ua.match(/(?:OPR|Opera)\/([0-9.]+)/);
    return { family: "opera", displayName: "Opera", version: sanitizeVersion(m?.[1]) };
  }
  if (ua.includes("Vivaldi/")) {
    const m = ua.match(/Vivaldi\/([0-9.]+)/);
    return { family: "vivaldi", displayName: "Vivaldi", version: sanitizeVersion(m?.[1]) };
  }
  if (source?.brave !== undefined || ua.includes("Brave/")) {
    const m = ua.match(/(?:Brave|Chrome)\/([0-9.]+)/);
    return { family: "brave", displayName: "Brave", version: sanitizeVersion(m?.[1]) };
  }
  if (ua.includes("Chrome/") || ua.includes("CriOS/")) {
    const m = ua.match(/(?:Chrome|CriOS)\/([0-9.]+)/);
    return { family: "chrome", displayName: "Chrome", version: sanitizeVersion(m?.[1]) };
  }
  if (ua.includes("Safari/") && !ua.includes("Chrome/") && !ua.includes("Chromium/") && !ua.includes("Android")) {
    const m = ua.match(/Version\/([0-9.]+)/);
    return { family: "safari", displayName: "Safari", version: sanitizeVersion(m?.[1]) };
  }
  if (ua.includes("Chromium/")) {
    const m = ua.match(/Chromium\/([0-9.]+)/);
    return { family: "chromium", displayName: "Chromium", version: sanitizeVersion(m?.[1]) };
  }

  return { family: "unknown", displayName: "Browser", version: "unknown" };
}
