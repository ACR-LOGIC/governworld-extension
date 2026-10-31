// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Network fetching security & SSRF resilience suite (Objective 5).
(globalThis as unknown as { chrome: unknown }).chrome = {
  runtime: {
    id: "test-id",
    onConnect: { addListener: () => {} },
    sendMessage: () => {},
  },
  storage: {
    local: { get: async () => ({}), set: async () => {} },
    session: { get: async () => ({}), set: async () => {} },
  },
};

import { describe, it, expect, vi } from "vitest";
import {
  isCloudMetadataHost,
  readBoundedArrayBuffer,
  evaluateDestinationPolicy,
  classifyDestination,
  parseIPv4Bytes,
  classifyIPv6,
  matchesAllowlist,
  fetchWithPolicy,
} from "../src/shared/networkGuard.js";
import { validateMessage } from "../src/shared/messages.js";

describe("network fetching security & boundary protections (Objective 5)", () => {
  it("identifies cloud metadata IPs and hostnames", () => {
    expect(isCloudMetadataHost("169.254.169.254")).toBe(true);
    expect(isCloudMetadataHost("169.254.1.1")).toBe(true);
    expect(isCloudMetadataHost("metadata.google.internal")).toBe(true);
    expect(isCloudMetadataHost("instance-data")).toBe(true);
    expect(isCloudMetadataHost("fe80::1")).toBe(true);
    expect(isCloudMetadataHost("[fe80::2c4:2aff:feb0:508]")).toBe(true);

    // Legitimate public and private domains
    expect(isCloudMetadataHost("example.com")).toBe(false);
    expect(isCloudMetadataHost("localhost")).toBe(false);
    expect(isCloudMetadataHost("127.0.0.1")).toBe(false);
    expect(isCloudMetadataHost("192.168.1.1")).toBe(false);
  });

  it("message validation strictly rejects non-http(s) schemes in pdfQueue", () => {
    const makePdfMsg = (url: string) => ({
      type: "SCAN_RESULT",
      requestId: "r1",
      sessionId: "s1",
      findings: [],
      stats: {
        visibleChars: 10,
        truncated: false,
        pdfQueue: [{ url, cssSelector: "embed", isTopLevel: false }],
      },
    });

    for (const dangerous of [
      "file:///C:/secret.pdf",
      "file:///etc/shadow",
      "blob:https://example.test/abc",
      "chrome://version",
      "javascript:alert(1)",
      "data:application/pdf;base64,123",
    ]) {
      const validated = validateMessage(makePdfMsg(dangerous));
      expect(validated.ok).toBe(true);
      const stats = (validated as { message: { stats?: { pdfQueue?: unknown[] } } }).message.stats;
      expect(stats?.pdfQueue ?? []).toHaveLength(0);
    }
  });

  it("aborts and bounds chunked transfer streams that exceed MAX_DOC_BYTES", async () => {
    // Simulate chunked streaming response without Content-Length
    const maxBytes = 1024 * 1024; // 1 MB cap
    const chunk1 = new Uint8Array(600 * 1024); // 600 KB
    const chunk2 = new Uint8Array(600 * 1024); // 600 KB (total 1.2 MB > 1 MB)

    let readCount = 0;
    let streamCanceled = false;

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (readCount === 0) {
          readCount++;
          controller.enqueue(chunk1);
        } else if (readCount === 1) {
          readCount++;
          controller.enqueue(chunk2);
        } else {
          controller.close();
        }
      },
      cancel() {
        streamCanceled = true;
      },
    });

    const response = new Response(stream, {
      headers: { "Content-Type": "application/pdf" }, // no content-length
    });

    const result = await readBoundedArrayBuffer(response, maxBytes);
    expect(result.exceeded).toBe(true);
    expect(result.buffer.byteLength).toBe(0);
    expect(streamCanceled).toBe(true);
  });

  it("accepts streaming bodies within the byte cap", async () => {
    const maxBytes = 1024 * 1024;
    const chunk = new Uint8Array([1, 2, 3, 4, 5]);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.close();
      },
    });

    const response = new Response(stream, {
      headers: { "Content-Type": "application/pdf" },
    });

    const result = await readBoundedArrayBuffer(response, maxBytes);
    expect(result.exceeded).toBe(false);
    expect(result.buffer.byteLength).toBe(5);
  });

  it("tryFetchOriginal rejects unsupported MIME types and dangerous schemes", async () => {
    const { tryFetchOriginal } = await import("../src/service-worker/captureImage.js");
    // 1. Invalid scheme
    await expect(tryFetchOriginal("file:///C:/image.png")).resolves.toBeNull();
    await expect(tryFetchOriginal("ftp://example.test/img.png")).resolves.toBeNull();
    await expect(tryFetchOriginal("javascript:void(0)")).resolves.toBeNull();

    // 2. data: url with non-image mime is rejected
    const textDataUrl = `data:text/html;base64,${btoa("<html>evil</html>")}`;
    const result = await tryFetchOriginal(textDataUrl);
    expect(result).toBeNull();

    // 3. data: url with valid image mime is accepted
    const imageDataUrl = `data:image/png;base64,${btoa("fake-png-bytes")}`;
    const imgResult = await tryFetchOriginal(imageDataUrl);
    expect(imgResult?.mimeType).toBe("image/png");
  });

  it("parses alternative IPv4 representations (octal, hex, dword integer, partial)", () => {
    // Dotted decimal
    expect(parseIPv4Bytes("127.0.0.1")).toEqual([127, 0, 0, 1]);
    // Hex
    expect(parseIPv4Bytes("0x7f.0x0.0x0.0x1")).toEqual([127, 0, 0, 1]);
    // Octal
    expect(parseIPv4Bytes("0177.0.0.1")).toEqual([127, 0, 0, 1]);
    // DWORD single integer
    expect(parseIPv4Bytes("2130706433")).toEqual([127, 0, 0, 1]); // 0x7F000001
    expect(parseIPv4Bytes("0x7f000001")).toEqual([127, 0, 0, 1]);
    // Partial octet (a.b notation)
    expect(parseIPv4Bytes("127.1")).toEqual([127, 0, 0, 1]);

    // Invalid / out-of-range
    expect(parseIPv4Bytes("256.0.0.1")).toBeNull();
    expect(parseIPv4Bytes("abc.def.ghi.jkl")).toBeNull();
    expect(parseIPv4Bytes("999999999999")).toBeNull();
  });

  it("classifies IPv6 addresses and IPv4-mapped IPv6 literals", () => {
    // Loopback
    expect(classifyIPv6("::1")).toBe("loopback");
    expect(classifyIPv6("[::1]")).toBe("loopback");

    // Private ULA (fc00::/7)
    expect(classifyIPv6("fc00::1")).toBe("private");
    expect(classifyIPv6("fd12:3456:789a::1")).toBe("private");

    // Link-local (fe80::/10)
    expect(classifyIPv6("fe80::1")).toBe("link_local");
    expect(classifyIPv6("fe80::2c4:2aff:feb0:508")).toBe("link_local");

    // IPv4-mapped IPv6
    expect(classifyIPv6("::ffff:127.0.0.1")).toBe("loopback");
    expect(classifyIPv6("::ffff:10.0.0.1")).toBe("private");
    expect(classifyIPv6("::ffff:192.168.1.1")).toBe("private");
    expect(classifyIPv6("::ffff:169.254.169.254")).toBe("link_local");
    expect(classifyIPv6("::ffff:8.8.8.8")).toBe("public");
  });

  it("enforces destination policy: public_only, managed_intranet, and disabled", () => {
    // 1. public_only (Default)
    expect(evaluateDestinationPolicy("https://example.com/doc.pdf", "public_only").allowed).toBe(true);
    expect(evaluateDestinationPolicy("http://127.0.0.1/doc.pdf", "public_only").allowed).toBe(false);
    expect(evaluateDestinationPolicy("http://10.0.0.5/doc.pdf", "public_only").allowed).toBe(false);
    expect(evaluateDestinationPolicy("http://192.168.1.50/doc.pdf", "public_only").allowed).toBe(false);
    expect(evaluateDestinationPolicy("http://172.16.0.1/doc.pdf", "public_only").allowed).toBe(false);
    expect(evaluateDestinationPolicy("http://[::1]/doc.pdf", "public_only").allowed).toBe(false);
    expect(evaluateDestinationPolicy("http://[fd00::1]/doc.pdf", "public_only").allowed).toBe(false);
    expect(evaluateDestinationPolicy("http://[fe80::1]/doc.pdf", "public_only").allowed).toBe(false);
    expect(evaluateDestinationPolicy("http://169.254.169.254/latest/meta-data", "public_only").allowed).toBe(false);
    expect(evaluateDestinationPolicy("http://metadata.google.internal/computeMetadata/v1/", "public_only").allowed).toBe(false);

    // 2. disabled policy
    expect(evaluateDestinationPolicy("https://example.com/doc.pdf", "disabled").allowed).toBe(false);
    expect(evaluateDestinationPolicy("https://example.com/doc.pdf", "disabled").reason).toContain("disabled by policy");

    // 3. managed_intranet policy with allowlist
    const allowlist = ["*.internal.corp", "10.50.", "192.168.1.100"];
    // Allowed by allowlist
    expect(evaluateDestinationPolicy("http://wiki.internal.corp/page.pdf", "managed_intranet", allowlist).allowed).toBe(true);
    expect(evaluateDestinationPolicy("http://10.50.1.20/report.pdf", "managed_intranet", allowlist).allowed).toBe(true);
    expect(evaluateDestinationPolicy("http://192.168.1.100/file.pdf", "managed_intranet", allowlist).allowed).toBe(true);
    // Blocked: not in allowlist
    expect(evaluateDestinationPolicy("http://10.99.1.1/secret.pdf", "managed_intranet", allowlist).allowed).toBe(false);
    expect(evaluateDestinationPolicy("http://127.0.0.1/admin", "managed_intranet", allowlist).allowed).toBe(false);
    // Cloud metadata is strictly blocked even under managed_intranet
    expect(evaluateDestinationPolicy("http://169.254.169.254/", "managed_intranet", ["169.254."]).allowed).toBe(false);
  });

  it("fetchWithPolicy aborts redirect chains leading to private or metadata addresses", async () => {
    const originalFetch = globalThis.fetch;
    try {
      // Mock fetch returning 302 redirect from public URL to private loopback
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url === "https://public-service.test/redirect") {
          return new Response(null, {
            status: 302,
            headers: { Location: "http://127.0.0.1:8080/internal-admin" },
          });
        }
        return new Response("ok", { status: 200 });
      });

      await expect(
        fetchWithPolicy("https://public-service.test/redirect", { policy: "public_only" })
      ).rejects.toThrow("Network policy blocked destination");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
