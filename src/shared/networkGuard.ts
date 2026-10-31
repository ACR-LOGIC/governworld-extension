// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Network safety checks for extension-initiated fetches (SSRF defense, destination policies, & bounded streams).

export type NetworkDestinationPolicy = "public_only" | "managed_intranet" | "disabled";

export interface DestinationClassification {
  type: "loopback" | "private" | "link_local" | "metadata" | "public" | "invalid";
  normalizedHost: string;
  reason?: string;
}

export interface PolicyEvaluationResult {
  allowed: boolean;
  classification: DestinationClassification["type"];
  normalizedHost: string;
  reason?: string;
}

/** Cloud metadata IPs and hostnames that must never be fetched by the extension. */
const CLOUD_METADATA_HOSTS = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata.internal",
  "instance-data",
]);

/**
 * Parse an IPv4 address string supporting dotted decimal, octal, hex, and single-integer representations.
 * Returns 4 byte numbers [0-255] or null if not a valid IPv4 address.
 */
export function parseIPv4Bytes(host: string): number[] | null {
  const trimmed = host.trim().toLowerCase();

  // 1. Single integer representation (dword: decimal or hex or octal)
  if (/^(?:0x[0-9a-f]+|\d+)$/i.test(trimmed)) {
    let num: number;
    if (trimmed.startsWith("0x")) {
      num = parseInt(trimmed, 16);
    } else if (trimmed.startsWith("0") && trimmed.length > 1) {
      num = parseInt(trimmed, 8);
    } else {
      num = parseInt(trimmed, 10);
    }
    if (!Number.isFinite(num) || num < 0 || num > 0xffffffff) return null;
    return [(num >>> 24) & 0xff, (num >>> 16) & 0xff, (num >>> 8) & 0xff, num & 0xff];
  }

  // 2. Dotted notation (1 to 4 parts)
  const parts = trimmed.split(".");
  if (parts.length < 2 || parts.length > 4) return null;
  const nums: number[] = [];

  for (const p of parts) {
    if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(p)) return null;
    let n: number;
    if (p.startsWith("0x")) {
      n = parseInt(p, 16);
    } else if (p.startsWith("0") && p.length > 1) {
      n = parseInt(p, 8);
    } else {
      n = parseInt(p, 10);
    }
    if (!Number.isFinite(n) || n < 0) return null;
    nums.push(n);
  }

  if (nums.length === 4) {
    if (nums.some((n) => n > 255)) return null;
    return nums;
  }
  if (nums.length === 2) {
    // a.b notation (a = 8-bit, b = 24-bit tail)
    if (nums[0] > 255 || nums[1] > 0xffffff) return null;
    return [nums[0], (nums[1] >>> 16) & 0xff, (nums[1] >>> 8) & 0xff, nums[1] & 0xff];
  }
  if (nums.length === 3) {
    // a.b.c notation (a = 8-bit, b = 8-bit, c = 16-bit tail)
    if (nums[0] > 255 || nums[1] > 255 || nums[2] > 0xffff) return null;
    return [nums[0], nums[1], (nums[2] >>> 8) & 0xff, nums[2] & 0xff];
  }

  return null;
}

/**
 * Checks if IPv4 bytes represent loopback (127.0.0.0/8 or 0.0.0.0).
 */
export function isLoopbackIPv4(b: number[]): boolean {
  return b[0] === 127 || (b[0] === 0 && b[1] === 0 && b[2] === 0 && b[3] === 0);
}

/**
 * Checks if IPv4 bytes represent RFC 1918 private subnets.
 */
export function isPrivateIPv4(b: number[]): boolean {
  if (b[0] === 10) return true; // 10.0.0.0/8
  if (b[0] === 172 && b[1] >= 16 && b[1] <= 31) return true; // 172.16.0.0/12
  if (b[0] === 192 && b[1] === 168) return true; // 192.168.0.0/16
  return false;
}

/**
 * Checks if IPv4 bytes represent link-local (169.254.0.0/16) or cloud metadata.
 */
export function isLinkLocalOrMetadataIPv4(b: number[]): boolean {
  return b[0] === 169 && b[1] === 254;
}

/**
 * Classifies an IPv6 address string into loopback, private, link-local, or public.
 */
export function classifyIPv6(host: string): "loopback" | "private" | "link_local" | "public" {
  const cleaned = host.toLowerCase().trim().replace(/^\[|\]$/g, "");

  // Check IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1)
  const mappedMatch = /^::ffff:([0-9a-z.:]+)$/i.exec(cleaned);
  if (mappedMatch) {
    const v4 = parseIPv4Bytes(mappedMatch[1]);
    if (v4) {
      if (isLinkLocalOrMetadataIPv4(v4)) return "link_local";
      if (isLoopbackIPv4(v4)) return "loopback";
      if (isPrivateIPv4(v4)) return "private";
      return "public";
    }
  }

  // Loopback ::1
  if (cleaned === "::1" || /^0*(?::0*)*:1$/.test(cleaned)) {
    return "loopback";
  }

  // Link-local: fe80::/10 (fe8x, fe9x, feax, febx)
  if (/^fe[89ab][0-9a-f]/i.test(cleaned)) {
    return "link_local";
  }

  // Unique Local (ULA) / Private: fc00::/7 (fcxx, fdxx)
  if (/^f[cd][0-9a-f]{2}:/i.test(cleaned)) {
    return "private";
  }

  return "public";
}

/**
 * Classify a destination URL into its network category.
 */
export function classifyDestination(target: string | URL): DestinationClassification {
  let url: URL;
  try {
    url = typeof target === "string" ? new URL(target) : target;
  } catch {
    return { type: "invalid", normalizedHost: "", reason: "Malformed URL" };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { type: "invalid", normalizedHost: url.hostname, reason: `Disallowed scheme: ${url.protocol}` };
  }

  const rawHost = url.hostname.toLowerCase().trim().replace(/^\[|\]$/g, "");

  // 1. Cloud metadata hostnames
  if (CLOUD_METADATA_HOSTS.has(rawHost)) {
    return { type: "metadata", normalizedHost: rawHost, reason: "Cloud metadata endpoint" };
  }

  // 2. Localhost aliases
  if (rawHost === "localhost" || rawHost.endsWith(".localhost") || rawHost.endsWith(".local") || rawHost.endsWith(".internal")) {
    return { type: "loopback", normalizedHost: rawHost, reason: "Local/internal domain suffix" };
  }

  // 3. IPv4 Parsing (supporting decimal, octal, hex, dword)
  const v4Bytes = parseIPv4Bytes(rawHost);
  if (v4Bytes) {
    const canonicalV4 = v4Bytes.join(".");
    if (isLinkLocalOrMetadataIPv4(v4Bytes)) {
      return { type: "metadata", normalizedHost: canonicalV4, reason: "IPv4 link-local/metadata (169.254.0.0/16)" };
    }
    if (isLoopbackIPv4(v4Bytes)) {
      return { type: "loopback", normalizedHost: canonicalV4, reason: "IPv4 loopback (127.0.0.0/8)" };
    }
    if (isPrivateIPv4(v4Bytes)) {
      return { type: "private", normalizedHost: canonicalV4, reason: "IPv4 private network (RFC 1918)" };
    }
    return { type: "public", normalizedHost: canonicalV4 };
  }

  // 4. IPv6 Parsing
  if (rawHost.includes(":")) {
    const v6Class = classifyIPv6(rawHost);
    if (v6Class === "link_local") {
      return { type: "metadata", normalizedHost: rawHost, reason: "IPv6 link-local (fe80::/10)" };
    }
    if (v6Class === "loopback") {
      return { type: "loopback", normalizedHost: rawHost, reason: "IPv6 loopback (::1)" };
    }
    if (v6Class === "private") {
      return { type: "private", normalizedHost: rawHost, reason: "IPv6 unique local address (fc00::/7)" };
    }
    return { type: "public", normalizedHost: rawHost };
  }

  return { type: "public", normalizedHost: rawHost };
}

/**
 * Checks whether a host matches an administrator-provided allowlist pattern.
 * Supports exact hostname, wildcard prefix (*.example.corp), and CIDR-style matching.
 */
export function matchesAllowlist(host: string, allowlist?: readonly string[]): boolean {
  if (!allowlist || allowlist.length === 0) return false;
  const lowerHost = host.toLowerCase().trim();

  for (const pattern of allowlist) {
    const lowerPattern = pattern.toLowerCase().trim();
    if (lowerHost === lowerPattern) return true;
    if (lowerPattern.startsWith("*.")) {
      const suffix = lowerPattern.slice(1); // e.g. ".internal.corp"
      if (lowerHost.endsWith(suffix) && lowerHost !== suffix.slice(1)) return true;
    }
    // Prefix match for subnets (e.g. "10.100.")
    if (lowerPattern.endsWith(".") && lowerHost.startsWith(lowerPattern)) return true;
  }
  return false;
}

/**
 * Evaluates whether a destination URL is permitted under the active policy.
 */
export function evaluateDestinationPolicy(
  target: string | URL,
  policy: NetworkDestinationPolicy = "public_only",
  allowlist?: readonly string[]
): PolicyEvaluationResult {
  const classification = classifyDestination(target);

  if (classification.type === "invalid") {
    return {
      allowed: false,
      classification: "invalid",
      normalizedHost: classification.normalizedHost,
      reason: classification.reason || "Invalid URL or scheme",
    };
  }

  if (policy === "disabled") {
    return {
      allowed: false,
      classification: classification.type,
      normalizedHost: classification.normalizedHost,
      reason: "Network destination fetching is disabled by policy",
    };
  }

  // Metadata and link-local destinations are strictly blocked in all policies
  if (classification.type === "metadata") {
    return {
      allowed: false,
      classification: "metadata",
      normalizedHost: classification.normalizedHost,
      reason: `Cloud metadata destination blocked: ${classification.reason}`,
    };
  }

  if (policy === "public_only") {
    if (classification.type === "loopback" || classification.type === "private") {
      return {
        allowed: false,
        classification: classification.type,
        normalizedHost: classification.normalizedHost,
        reason: `Destination is ${classification.type} network, blocked under public_only policy`,
      };
    }
    return { allowed: true, classification: "public", normalizedHost: classification.normalizedHost };
  }

  if (policy === "managed_intranet") {
    if (classification.type === "public") {
      return { allowed: true, classification: "public", normalizedHost: classification.normalizedHost };
    }
    // Loopback or private: require allowlist match
    if (matchesAllowlist(classification.normalizedHost, allowlist)) {
      return { allowed: true, classification: classification.type, normalizedHost: classification.normalizedHost };
    }
    return {
      allowed: false,
      classification: classification.type,
      normalizedHost: classification.normalizedHost,
      reason: `Destination ${classification.normalizedHost} is not on the administrator allowlist for managed_intranet`,
    };
  }

  return { allowed: false, classification: "invalid", normalizedHost: classification.normalizedHost, reason: "Unknown policy" };
}

/**
 * Backward-compatible helper for basic URL check.
 */
export function isSafeFetchUrl(value: unknown, policy: NetworkDestinationPolicy = "public_only", allowlist?: readonly string[]): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return false;
  return evaluateDestinationPolicy(value, policy, allowlist).allowed;
}

/** Backward-compatible helper. */
export function isCloudMetadataHost(hostname: string): boolean {
  const trimmed = hostname.trim();
  const hostWithBrackets = trimmed.includes(":") && !trimmed.startsWith("[") ? `[${trimmed}]` : trimmed;
  const c = classifyDestination(`http://${hostWithBrackets}`);
  return c.type === "metadata";
}

export interface BoundedReadResult {
  buffer: ArrayBuffer;
  exceeded: boolean;
}

/**
 * Read response body with a strict maximum byte cap.
 * If the body exceeds maxBytes (even with chunked transfer encoding and no Content-Length),
 * the stream is canceled immediately to protect against memory exhaustion.
 */
export async function readBoundedArrayBuffer(
  response: Response,
  maxBytes: number
): Promise<BoundedReadResult> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const cl = parseInt(contentLength, 10);
    if (Number.isFinite(cl) && cl > maxBytes) {
      return { buffer: new ArrayBuffer(0), exceeded: true };
    }
  }

  if (!response.body || typeof response.body.getReader !== "function") {
    const buf = await response.arrayBuffer();
    if (buf.byteLength > maxBytes) {
      return { buffer: new ArrayBuffer(0), exceeded: true };
    }
    return { buffer: buf, exceeded: false };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          try {
            void reader.cancel();
          } catch {
            // ignore cancel error
          }
          return { buffer: new ArrayBuffer(0), exceeded: true };
        }
        chunks.push(value);
      }
    }
  } catch {
    return { buffer: new ArrayBuffer(0), exceeded: false };
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { buffer: merged.buffer, exceeded: false };
}

export interface FetchWithPolicyOptions extends RequestInit {
  timeoutMs?: number;
  maxRedirects?: number;
  policy?: NetworkDestinationPolicy;
  allowlist?: readonly string[];
}

/**
 * Safe fetch wrapper that enforces destination policy at initial request AND at each redirect hop.
 * Uses manual redirect inspection to prevent open-redirect SSRF bypasses to private/metadata networks.
 */
export async function fetchWithPolicy(
  initialUrl: string,
  options: FetchWithPolicyOptions = {}
): Promise<Response> {
  const policy = options.policy || "public_only";
  const allowlist = options.allowlist;
  const maxRedirects = options.maxRedirects ?? 5;
  const timeoutMs = options.timeoutMs ?? 10_000;

  let currentUrl = initialUrl;
  let redirectsFollowed = 0;

  while (true) {
    const evalResult = evaluateDestinationPolicy(currentUrl, policy, allowlist);
    if (!evalResult.allowed) {
      throw new Error(`Network policy blocked destination (${currentUrl}): ${evalResult.reason}`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(currentUrl, {
        ...options,
        redirect: "manual",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    // Check for HTTP redirects (301, 302, 303, 307, 308)
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) {
        return response; // No location header, return as-is
      }

      redirectsFollowed++;
      if (redirectsFollowed > maxRedirects) {
        throw new Error(`Too many redirects (exceeded limit of ${maxRedirects})`);
      }

      // Resolve relative redirect against current URL
      try {
        currentUrl = new URL(location, currentUrl).href;
      } catch {
        throw new Error(`Invalid redirect Location URL: ${location}`);
      }
      continue;
    }

    return response;
  }
}
