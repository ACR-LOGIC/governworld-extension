// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GovernWorldApiClient } from "../src/api/client.js";
import { validateApiUrl, setApiUrl, getApiUrl, CURRENT_EXTENSION_VERSION } from "../src/api/config.js";

describe("API Client & Transport Security", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("enforces HTTPS/TLS for remote production endpoints", () => {
    const validHttps = validateApiUrl("https://api.governworld.com");
    expect(validHttps.valid).toBe(true);
    expect(validHttps.normalizedUrl).toBe("https://api.governworld.com");

    const invalidHttp = validateApiUrl("http://api.governworld.com");
    expect(invalidHttp.valid).toBe(false);
    expect(invalidHttp.error).toContain("Insecure transport rejected");
  });

  it("permits plaintext HTTP only for localhost and 127.0.0.1 development", () => {
    const localhost = validateApiUrl("http://localhost:8000");
    expect(localhost.valid).toBe(true);
    expect(localhost.normalizedUrl).toBe("http://localhost:8000");

    const loopback = validateApiUrl("http://127.0.0.1:8000/api");
    expect(loopback.valid).toBe(true);
    expect(loopback.normalizedUrl).toBe("http://127.0.0.1:8000/api");
  });

  it("automatically attaches correlation ID (X-Request-ID) and version headers", async () => {
    let capturedHeaders: HeadersInit | undefined;

    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      capturedHeaders = init?.headers;
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const client = new GovernWorldApiClient("https://api.governworld.com");
    const res = await client.get<{ status: string }>("/api/v1/extension/health");

    expect(res.ok).toBe(true);
    const headers = capturedHeaders as Record<string, string>;
    expect(headers["X-Request-ID"]).toBeDefined();
    expect(headers["X-Request-ID"]).toMatch(/^[a-f0-9-]{36}$/);
    expect(headers["X-Extension-Version"]).toBe(CURRENT_EXTENSION_VERSION);
    expect(headers["X-Installation-ID"]).toBeDefined();
  });

  it("attaches unique Idempotency-Key on mutation requests (POST/PUT/DELETE)", async () => {
    const capturedPostHeaders: Array<Record<string, string>> = [];

    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      capturedPostHeaders.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const client = new GovernWorldApiClient("https://api.governworld.com");
    await client.post("/api/v1/extension/events", { event: "test1" });
    await client.post("/api/v1/extension/events", { event: "test2" });

    expect(capturedPostHeaders.length).toBe(2);
    expect(capturedPostHeaders[0]["Idempotency-Key"]).toBeDefined();
    expect(capturedPostHeaders[1]["Idempotency-Key"]).toBeDefined();
    expect(capturedPostHeaders[0]["Idempotency-Key"]).not.toBe(capturedPostHeaders[1]["Idempotency-Key"]);
  });

  it("normalizes HTTP errors into safe user messages without exposing internal SQL or stack traces", async () => {
    vi.mocked(fetch).mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          error: "syntax error at or near 'SELECT' in postgres azure cluster",
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }
      );
    });

    const client = new GovernWorldApiClient("https://api.governworld.com");
    const res = await client.get("/api/v1/extension/test");

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("SERVER_ERROR");
      expect(res.error.user_message).not.toContain("postgres");
      expect(res.error.user_message).not.toContain("SELECT");
      expect(res.error.user_message).toContain("GovernWorld server is temporarily unavailable");
    }
  });

  it("handles offline network errors and request timeouts safely", async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError("Failed to fetch"));

    const client = new GovernWorldApiClient("https://api.governworld.com");
    const res = await client.get("/api/v1/extension/health");

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("OFFLINE");
      expect(res.error.user_message).toContain("local protection continues normally");
    }
  });

  it("times out a stalled response body, not just a stalled connection", async () => {
    // Headers arrive promptly; the body never does. The timeout must still fire
    // and report TIMEOUT rather than hanging forever.
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const signal = init?.signal as AbortSignal | undefined;
      const neverJson = new Promise<unknown>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted.");
          err.name = "AbortError";
          reject(err);
        });
      });
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        json: () => neverJson,
        text: () => Promise.resolve(""),
      } as unknown as Response;
    });

    const client = new GovernWorldApiClient("https://api.governworld.com");
    const res = await client.get("/api/v1/extension/health", { timeoutMs: 50 });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("TIMEOUT");
      expect(res.error.user_message).toContain("timed out");
    }
  });

  it("sanitizes a backend user_message that looks like a diagnostic dump", async () => {
    vi.mocked(fetch).mockImplementation(async () =>
      new Response(
        JSON.stringify({
          user_message: "panic: runtime error\nstack trace:\nSELECT * FROM users WHERE id=1",
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      )
    );

    const client = new GovernWorldApiClient("https://api.governworld.com");
    const res = await client.get("/api/v1/extension/health");

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.user_message).not.toContain("SELECT");
      expect(res.error.user_message).not.toContain("stack trace");
      expect(res.error.user_message).toContain("temporarily unavailable");
    }
  });

  it("rejects an overlong backend user_message", async () => {
    vi.mocked(fetch).mockImplementation(async () =>
      new Response(JSON.stringify({ user_message: "x".repeat(500) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })
    );

    const client = new GovernWorldApiClient("https://api.governworld.com");
    const res = await client.get("/api/v1/extension/health");

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.user_message).toContain("temporarily unavailable");
    }
  });

  it("still honors a short, safe backend user_message", async () => {
    vi.mocked(fetch).mockImplementation(async () =>
      new Response(JSON.stringify({ user_message: "Your trial has expired." }), {
        status: 402,
        headers: { "Content-Type": "application/json" },
      })
    );

    const client = new GovernWorldApiClient("https://api.governworld.com");
    const res = await client.get("/api/v1/extension/health");

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.user_message).toBe("Your trial has expired.");
    }
  });
});
