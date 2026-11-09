// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Network safety checks for extension-initiated fetches (SSRF defense, destination policies, & bounded streams).

import { PolicyTelemetry, SecurityTelemetry } from "./telemetry.js";

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
  "169.254.170.2", // AWS ECS task metadata
  "100.100.100.200", // Alibaba Cloud metadata
  "metadata.google.internal",
  "metadata.internal",
  "metadata.azure.internal",
  "instance-data",
  "metadata",
]);

/** Internal/private domain suffixes that are non-public (RFC 6762, RFC 8375, corporate LANs). */
const LOOPBACK_DOMAIN_SUFFIXES = [".localhost", ".local", ".internal"];
const PRIVATE_DOMAIN_SUFFIXES = [
  ".lan",
  ".home",
  ".home.arpa",
  ".corp",
  ".intranet",
  ".localdomain",
  ".priv",
  ".internal.corp",
];

/**
 * Normalize a raw host string:
 *   - lowercase & trim
 *   - strip enclosing IPv6 brackets `[...]`
 *   - strip IPv6 zone identifiers (`%eth0`, `%25eth0`)
 *   - strip trailing DNS root dots (`localhost.` -> `localhost`)
 */
export function normalizeNetworkHost(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/%(?:25)?[0-9a-z._-]+$/i, "")
    .replace(/\.+$/, "");
}

/**
 * Parse an IPv4 address string supporting dotted decimal, octal, hex, and single-integer representations.
 * Returns 4 byte numbers [0-255] or null if not a valid IPv4 address.
 */
export function parseIPv4Bytes(host: string): number[] | null {
  const trimmed = host.trim().toLowerCase().replace(/\.+$/, "");
  if (!trimmed) return null;

  // 1. Single integer representation (dword: decimal or hex or octal)
  if (/^(?:0x[0-9a-f]+|\d+)$/i.test(trimmed)) {
    let num: number;
    if (trimmed.startsWith("0x")) {
      num = parseInt(trimmed, 16);
    } else if (trimmed.startsWith("0") && trimmed.length > 1) {
      if (!/^0[0-7]+$/.test(trimmed)) return null;
      num = parseInt(trimmed, 8);
    } else {
      num = parseInt(trimmed, 10);
    }
    if (!Number.isFinite(num) || num < 0 || num > 0xffffffff) return null;
    return [(num >>> 24) & 0xff, (num >>> 16) & 0xff, (num >>> 8) & 0xff, num & 0xff];
  }

  // 2. Dotted notation (2 to 4 parts)
  const parts = trimmed.split(".");
  if (parts.length < 2 || parts.length > 4) return null;
  const nums: number[] = [];

  for (const p of parts) {
    if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(p)) return null;
    let n: number;
    if (p.startsWith("0x")) {
      n = parseInt(p, 16);
    } else if (p.startsWith("0") && p.length > 1) {
      if (!/^0[0-7]+$/.test(p)) return null;
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
 * Checks if IPv4 bytes represent loopback (127.0.0.0/8) or current network (0.0.0.0/8).
 */
export function isLoopbackIPv4(b: number[]): boolean {
  return b[0] === 127 || b[0] === 0;
}

/**
 * Checks if IPv4 bytes represent Carrier-Grade NAT (CGNAT / RFC 6598: 100.64.0.0/10).
 * Note: 100.100.100.200 is Alibaba Cloud metadata and is checked before CGNAT.
 */
export function isCgnatIPv4(b: number[]): boolean {
  return b[0] === 100 && b[1] >= 64 && b[1] <= 127;
}

/**
 * Checks if IPv4 bytes represent RFC 1918 private subnets, CGNAT (RFC 6598),
 * IETF protocol assignments (192.0.0.0/24), benchmarking (198.18.0.0/15), or TEST-NETs.
 */
export function isPrivateIPv4(b: number[]): boolean {
  if (b[0] === 10) return true; // 10.0.0.0/8
  if (b[0] === 172 && b[1] >= 16 && b[1] <= 31) return true; // 172.16.0.0/12
  if (b[0] === 192 && b[1] === 168) return true; // 192.168.0.0/16
  if (isCgnatIPv4(b)) return true; // 100.64.0.0/10 (CGNAT)
  if (b[0] === 192 && b[1] === 0 && b[2] === 0) return true; // 192.0.0.0/24
  if (b[0] === 198 && (b[1] === 18 || b[1] === 19)) return true; // 198.18.0.0/15 Benchmarking
  return false;
}

/**
 * Checks if IPv4 bytes represent link-local (169.254.0.0/16) or cloud metadata IPs.
 */
export function isLinkLocalOrMetadataIPv4(b: number[]): boolean {
  if (b[0] === 169 && b[1] === 254) return true;
  if (b[0] === 100 && b[1] === 100 && b[2] === 100 && b[3] === 200) return true;
  return false;
}

/**
 * Extracts 4 IPv4 bytes from an IPv6 tail that is either dotted-quad (`127.0.0.1`)
 * or two 16-bit hex words (`7f00:1` or `a9fe:a9fe`, as normalized by WHATWG URL).
 */
function parseEmbeddedIPv4FromIPv6Tail(tail: string): number[] | null {
  const direct = parseIPv4Bytes(tail);
  if (direct) return direct;

  const hexPair = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(tail.trim());
  if (hexPair) {
    const hi = parseInt(hexPair[1], 16);
    const lo = parseInt(hexPair[2], 16);
    if (Number.isFinite(hi) && Number.isFinite(lo)) {
      return [(hi >>> 8) & 0xff, hi & 0xff, (lo >>> 8) & 0xff, lo & 0xff];
    }
  }
  return null;
}

function classifyEmbeddedIPv4(v4: number[]): "loopback" | "private" | "link_local" | "public" {
  if (isLinkLocalOrMetadataIPv4(v4)) return "link_local";
  if (isLoopbackIPv4(v4)) return "loopback";
  if (isPrivateIPv4(v4)) return "private";
  return "public";
}

/**
 * Classifies an IPv6 address string into loopback, private, link_local, or public.
 * Handles:
 *   - Loopback (`::1`, `0:0:0:0:0:0:0:1`) and unspecified (`::`)
 *   - IPv4-mapped IPv6 (`::ffff:127.0.0.1`, `::ffff:7f00:1`, `::ffff:169.254.169.254`, `::ffff:0:a.b.c.d`)
 *   - NAT64 (`64:ff9b::/96`, `64:ff9b:1::/48`)
 *   - 6to4 (`2002::/16`)
 *   - Teredo (`2001:0000::/32`)
 *   - Cloud metadata IPv6 (`fd00:ec2::254`)
 *   - Link-local (`fe80::/10`)
 *   - Unique Local / Private (`fc00::/7`), Site-local (`fec0::/10`), Documentation (`2001:db8::/32`)
 */
export function classifyIPv6(host: string): "loopback" | "private" | "link_local" | "public" {
  const cleaned = normalizeNetworkHost(host);

  // 1. Unspecified :: or Loopback ::1
  if (
    cleaned === "::" ||
    cleaned === "::1" ||
    /^0*(?::0*)*:[01]$/.test(cleaned)
  ) {
    return "loopback";
  }

  // 2. AWS EC2 IPv6 metadata endpoint (fd00:ec2::254)
  if (/^fd00:ec2:(?:0*:)*254$/i.test(cleaned)) {
    return "link_local";
  }

  // 3. IPv4-mapped IPv6 (::ffff:w.x.y.z or ::ffff:xxxx:yyyy or ::ffff:0:w.x.y.z)
  const mappedMatch = /^(?:::|(?:0+:){5})ffff:(?:0+:)?([0-9a-f.:]+)$/i.exec(cleaned);
  if (mappedMatch) {
    const v4 = parseEmbeddedIPv4FromIPv6Tail(mappedMatch[1]);
    if (v4) {
      return classifyEmbeddedIPv4(v4);
    }
    return "private";
  }

  // 4. IPv4-compatible IPv6 (deprecated ::w.x.y.z)
  const compatMatch = /^(?:::|(?:0+:){6})(\d+\.\d+\.\d+\.\d+)$/i.exec(cleaned);
  if (compatMatch) {
    const v4 = parseIPv4Bytes(compatMatch[1]);
    if (v4) {
      return classifyEmbeddedIPv4(v4);
    }
  }

  // 5. NAT64 Well-Known Prefix (64:ff9b::/96) and Local-Use NAT64 (64:ff9b:1::/48)
  if (/^64:ff9b:/i.test(cleaned)) {
    const nat64TailMatch = /^64:ff9b:(?:1:)?(?:0*:)*([0-9a-f]{1,4}:[0-9a-f]{1,4}|\d+\.\d+\.\d+\.\d+)$/i.exec(cleaned);
    if (nat64TailMatch) {
      const v4 = parseEmbeddedIPv4FromIPv6Tail(nat64TailMatch[1]);
      if (v4) {
        const embeddedClass = classifyEmbeddedIPv4(v4);
        if (embeddedClass !== "public") return embeddedClass;
      }
    }
    // NAT64 synthesis addresses are translation mechanisms and must not be treated as direct public endpoints
    return "private";
  }

  // 6. 6to4 Transition Addresses (2002::/16) — embeds IPv4 in bits 16..47
  const sixToFourMatch = /^2002:([0-9a-f]{1,4}:[0-9a-f]{1,4}|\d+\.\d+\.\d+\.\d+)(?:::|:|$)/i.exec(cleaned);
  if (sixToFourMatch) {
    const v4 = parseEmbeddedIPv4FromIPv6Tail(sixToFourMatch[1]);
    if (v4) {
      const embeddedClass = classifyEmbeddedIPv4(v4);
      if (embeddedClass !== "public") return embeddedClass;
    }
    return "private";
  }

  // 7. Link-local: fe80::/10 (fe8x, fe9x, feax, febx)
  if (/^fe[89ab][0-9a-f]/i.test(cleaned)) {
    return "link_local";
  }

  // 8. Unique Local (ULA) / Private: fc00::/7 (fcxx, fdxx) or deprecated site-local fec0::/10
  if (/^f[cd][0-9a-f]{2}:/i.test(cleaned) || /^fe[c-f][0-9a-f]/i.test(cleaned)) {
    return "private";
  }

  // 9. Teredo (2001:0000::/32), Benchmarking (2001:2::/48), Documentation (2001:db8::/32), Discard (100::/64)
  if (
    /^2001:(?:0+:|:)/i.test(cleaned) ||
    /^2001:0?002:/i.test(cleaned) ||
    /^2001:0?db8(?::|$)/i.test(cleaned) ||
    /^0?100:(?:0*:)+/i.test(cleaned)
  ) {
    return "private";
  }

  return "public";
}

/**
 * Classify a normalized host (without URL scheme) into its network category.
 */
export function classifyHost(rawHostInput: string): DestinationClassification {
  const rawHost = normalizeNetworkHost(rawHostInput);
  if (!rawHost || /[\s/\\?#]/.test(rawHost)) {
    return { type: "invalid", normalizedHost: "", reason: "Malformed hostname" };
  }

  // 1. Cloud metadata hostnames
  if (CLOUD_METADATA_HOSTS.has(rawHost)) {
    return { type: "metadata", normalizedHost: rawHost, reason: "Cloud metadata endpoint" };
  }

  // 2. Loopback domain aliases (.localhost, .local, .internal)
  if (
    rawHost === "localhost" ||
    LOOPBACK_DOMAIN_SUFFIXES.some((suffix) => rawHost.endsWith(suffix))
  ) {
    return { type: "loopback", normalizedHost: rawHost, reason: "Local/internal domain suffix" };
  }

  // 3. Private / LAN domain suffixes (.lan, .home, .corp, .intranet, .localdomain, .home.arpa)
  if (
    rawHost === "lan" ||
    rawHost === "intranet" ||
    rawHost === "localdomain" ||
    PRIVATE_DOMAIN_SUFFIXES.some((suffix) => rawHost.endsWith(suffix))
  ) {
    return { type: "private", normalizedHost: rawHost, reason: "Internal/private LAN domain suffix" };
  }

  // 4. IPv4 Parsing (supporting decimal, octal, hex, dword)
  const v4Bytes = parseIPv4Bytes(rawHost);
  if (v4Bytes) {
    const canonicalV4 = v4Bytes.join(".");
    if (isLinkLocalOrMetadataIPv4(v4Bytes)) {
      return { type: "metadata", normalizedHost: canonicalV4, reason: "IPv4 link-local/metadata (169.254.0.0/16)" };
    }
    if (isLoopbackIPv4(v4Bytes)) {
      return { type: "loopback", normalizedHost: canonicalV4, reason: "IPv4 loopback (127.0.0.0/8)" };
    }
    if (isCgnatIPv4(v4Bytes)) {
      return { type: "private", normalizedHost: canonicalV4, reason: "IPv4 CGNAT shared address space (100.64.0.0/10)" };
    }
    if (isPrivateIPv4(v4Bytes)) {
      return { type: "private", normalizedHost: canonicalV4, reason: "IPv4 private network (RFC 1918)" };
    }
    return { type: "public", normalizedHost: canonicalV4 };
  }

  // 5. IPv6 Parsing
  if (rawHost.includes(":")) {
    const v6Class = classifyIPv6(rawHost);
    if (v6Class === "link_local") {
      return { type: "metadata", normalizedHost: rawHost, reason: "IPv6 link-local or mapped metadata" };
    }
    if (v6Class === "loopback") {
      return { type: "loopback", normalizedHost: rawHost, reason: "IPv6 loopback" };
    }
    if (v6Class === "private") {
      return { type: "private", normalizedHost: rawHost, reason: "IPv6 private, NAT64, or transition address" };
    }
    return { type: "public", normalizedHost: rawHost };
  }

  return { type: "public", normalizedHost: rawHost };
}

/**
 * Classify a destination URL (or bare hostname/IP literal) into its network category.
 */
export function classifyDestination(target: string | URL): DestinationClassification {
  if (target instanceof URL) {
    if (target.protocol !== "https:" && target.protocol !== "http:") {
      return { type: "invalid", normalizedHost: target.hostname, reason: `Disallowed scheme: ${target.protocol}` };
    }
    return classifyHost(target.hostname);
  }

  if (typeof target !== "string") {
    return { type: "invalid", normalizedHost: "", reason: "Malformed URL" };
  }

  const trimmed = target.trim();
  if (!trimmed) {
    return { type: "invalid", normalizedHost: "", reason: "Empty URL" };
  }

  // If the string has an explicit URL scheme (e.g. https://, http://, file://, ftp://, javascript:)
  const hasExplicitScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) && !trimmed.includes("::") && !/^\d+:/.test(trimmed);
  if (trimmed.includes("://") || hasExplicitScheme) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return { type: "invalid", normalizedHost: "", reason: "Malformed URL" };
    }

    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return { type: "invalid", normalizedHost: url.hostname, reason: `Disallowed scheme: ${url.protocol}` };
    }

    return classifyHost(url.hostname);
  }

  // Support bare host / IPv6 / IPv4 inputs (e.g. "::ffff:127.0.0.1", "localhost.", "printer.lan", "100.64.0.1")
  const bracketed = trimmed.includes(":") && !trimmed.startsWith("[") ? `[${trimmed}]` : trimmed;
  try {
    const synthetic = new URL(`http://${bracketed}`);
    return classifyHost(synthetic.hostname);
  } catch {
    return classifyHost(trimmed);
  }
}

/**
 * Checks whether a host matches an administrator-provided allowlist pattern.
 * Supports exact hostname, wildcard prefix (*.example.corp), and CIDR/prefix matching.
 */
export function matchesAllowlist(host: string, allowlist?: readonly string[]): boolean {
  if (!allowlist || allowlist.length === 0) return false;
  const lowerHost = normalizeNetworkHost(host);

  for (const pattern of allowlist) {
    const lowerPattern = pattern.toLowerCase().trim().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
    if (!lowerPattern) continue;
    if (lowerHost === lowerPattern) return true;
    if (lowerPattern.startsWith("*.")) {
      const suffix = lowerPattern.slice(1); // e.g. ".internal.corp"
      if (lowerHost.endsWith(suffix) && lowerHost !== suffix.slice(1)) return true;
    }
    // Prefix match for subnets when original pattern ends with "." (e.g. "10.100.")
    const rawTrimmed = pattern.toLowerCase().trim();
    if (rawTrimmed.endsWith(".") && lowerHost.startsWith( rawTrimmed)) return true;
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
  // Enforce that target is a syntactically valid http(s) URL when passed as string
  if (typeof target === "string") {
    try {
      const parsed = new URL(target);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return {
          allowed: false,
          classification: "invalid",
          normalizedHost: parsed.hostname,
          reason: `Disallowed scheme: ${parsed.protocol}`,
        };
      }
    } catch {
      return {
        allowed: false,
        classification: "invalid",
        normalizedHost: "",
        reason: "Malformed URL",
      };
    }
  }

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
    SecurityTelemetry.record({
      kind: "network_destination_blocked",
      classification: classification.type,
      normalizedHost: classification.normalizedHost,
      reason: "Network destination fetching is disabled by policy",
    });
    return {
      allowed: false,
      classification: classification.type,
      normalizedHost: classification.normalizedHost,
      reason: "Network destination fetching is disabled by policy",
    };
  }

  // Metadata and link-local destinations are strictly blocked in all policies
  if (classification.type === "metadata") {
    const reason = `Cloud metadata destination blocked: ${classification.reason}`;
    SecurityTelemetry.record({
      kind: "network_destination_blocked",
      classification: "metadata",
      normalizedHost: classification.normalizedHost,
      reason,
    });
    return {
      allowed: false,
      classification: "metadata",
      normalizedHost: classification.normalizedHost,
      reason,
    };
  }

  if (policy === "public_only") {
    if (classification.type === "loopback" || classification.type === "private") {
      const reason = `Destination is ${classification.type} network, blocked under public_only policy`;
      SecurityTelemetry.record({
        kind: "network_destination_blocked",
        classification: classification.type,
        normalizedHost: classification.normalizedHost,
        reason,
      });
      return {
        allowed: false,
        classification: classification.type,
        normalizedHost: classification.normalizedHost,
        reason,
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
    const reason = `Destination ${classification.normalizedHost} is not on the administrator allowlist for managed_intranet`;
    SecurityTelemetry.record({
      kind: "network_destination_blocked",
      classification: classification.type,
      normalizedHost: classification.normalizedHost,
      reason,
    });
    return {
      allowed: false,
      classification: classification.type,
      normalizedHost: classification.normalizedHost,
      reason,
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
  const c = classifyDestination(hostname);
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
  /** Optional allowlist specifically restricting cross-origin redirect targets. */
  redirectAllowlist?: readonly string[];
}

/**
 * Strip sensitive credentials headers when a redirect crosses origins.
 */
function stripSensitiveHeadersForCrossOrigin(
  headersInit: HeadersInit | undefined
): Record<string, string> | undefined {
  if (!headersInit) return undefined;
  const sensitive = new Set(["authorization", "cookie", "x-api-key", "proxy-authorization"]);
  const out: Record<string, string> = {};
  if (headersInit instanceof Headers) {
    headersInit.forEach((value, key) => {
      if (!sensitive.has(key.toLowerCase())) out[key] = value;
    });
  } else if (Array.isArray(headersInit)) {
    for (const [key, value] of headersInit) {
      if (!sensitive.has(key.toLowerCase())) out[key] = value;
    }
  } else {
    for (const [key, value] of Object.entries(headersInit)) {
      if (!sensitive.has(key.toLowerCase())) out[key] = value;
    }
  }
  return out;
}

/**
 * Safe fetch wrapper that enforces destination policy at initial request AND at each redirect hop.
 * Uses manual redirect inspection to prevent open-redirect SSRF bypasses to private/metadata networks,
 * blocks opaque browser redirects whose target URL cannot be inspected, prevents HTTPS->HTTP downgrades,
 * strips credentials across cross-origin hops, and emits redirect telemetry.
 */
export async function fetchWithPolicy(
  initialUrl: string,
  options: FetchWithPolicyOptions = {}
): Promise<Response> {
  const policy = options.policy || "public_only";
  const allowlist = options.allowlist;
  const redirectAllowlist = options.redirectAllowlist;
  const maxRedirects = options.maxRedirects ?? 5;
  const timeoutMs = options.timeoutMs ?? 10_000;

  let currentUrl = initialUrl;
  let currentHeaders = options.headers;
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
        headers: currentHeaders,
        redirect: "manual",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    // Fail-closed on browser opaqueredirect: when fetch with redirect:"manual"
    // encounters a cross-origin redirect in certain browser contexts, the response
    // has type === "opaqueredirect" and status === 0, hiding the Location header.
    if (response.type === "opaqueredirect") {
      SecurityTelemetry.record({
        kind: "opaque_redirect_blocked",
        normalizedHost: evalResult.normalizedHost,
        reason: "Opaque redirect blocked because target destination cannot be verified",
      });
      throw new Error(`Network policy blocked opaque redirect from ${currentUrl}: redirect target cannot be verified`);
    }

    // Check for HTTP redirects (301, 302, 303, 307, 308)
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) {
        return response; // No location header, return as-is
      }

      redirectsFollowed++;
      if (redirectsFollowed > maxRedirects) {
        SecurityTelemetry.record({
          kind: "redirect_blocked",
          normalizedHost: evalResult.normalizedHost,
          reason: `Exceeded maxRedirects (${maxRedirects})`,
        });
        throw new Error(`Too many redirects (exceeded limit of ${maxRedirects})`);
      }

      // Resolve relative redirect against current URL
      let nextUrlObj: URL;
      let prevUrlObj: URL;
      try {
        prevUrlObj = new URL(currentUrl);
        nextUrlObj = new URL(location, currentUrl);
      } catch {
        throw new Error(`Invalid redirect Location URL: ${location}`);
      }

      // Prevent HTTPS -> HTTP downgrade on redirect
      if (prevUrlObj.protocol === "https:" && nextUrlObj.protocol === "http:") {
        SecurityTelemetry.record({
          kind: "protocol_downgrade_blocked",
          normalizedHost: normalizeNetworkHost(nextUrlObj.hostname),
          reason: "HTTPS to HTTP protocol downgrade on redirect",
        });
        throw new Error(`Network policy blocked destination (${nextUrlObj.href}): redirect protocol downgrade from HTTPS to HTTP`);
      }

      // Enforce optional redirectAllowlist when redirecting to a different host
      const nextNormalizedHost = normalizeNetworkHost(nextUrlObj.hostname);
      if (redirectAllowlist && redirectAllowlist.length > 0 && nextNormalizedHost !== evalResult.normalizedHost) {
        if (!matchesAllowlist(nextNormalizedHost, redirectAllowlist)) {
          SecurityTelemetry.record({
            kind: "redirect_blocked",
            normalizedHost: nextNormalizedHost,
            reason: `Redirect target ${nextNormalizedHost} not in redirectAllowlist`,
          });
          throw new Error(`Network policy blocked redirect to unallowed host: ${nextNormalizedHost}`);
        }
      }

      // Strip sensitive headers when crossing origins
      if (prevUrlObj.origin !== nextUrlObj.origin) {
        currentHeaders = stripSensitiveHeadersForCrossOrigin(currentHeaders);
      }

      PolicyTelemetry.record({
        kind: "redirect_evaluated",
        action: "FOLLOW",
        hops: redirectsFollowed,
      });

      currentUrl = nextUrlObj.href;
      continue;
    }

    return response;
  }
}
