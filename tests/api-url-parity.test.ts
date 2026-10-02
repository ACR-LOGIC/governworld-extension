// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Two constants that must never disagree.
//
// `DEFAULT_PROD_API_URL` (src/api/config.ts) is where the client sends requests.
// `ALLOWED_GATEWAY_HOSTS` (src/shared/settings.ts) is what a user is permitted to
// configure as a gateway origin. They are checked by different code, in different
// layers, and were set to different hosts:
//
//   DEFAULT_PROD_API_URL   https://api.governworld.com
//   ALLOWED_GATEWAY_HOSTS  api.governworld.acrlogic.com
//
// That is not a cosmetic mismatch. A user who connected through the built-in
// default and then saved their gateway origin had their own working configuration
// rejected by `isAllowedGatewayOrigin`, with no indication that the value was
// correct and the allowlist was stale. It also meant the one origin the extension
// itself proposed was one it refused.
//
// The invariant is asserted rather than left to review, because nothing at
// runtime compares them.
import { describe, expect, it } from "vitest";
import { DEFAULT_PROD_API_URL, DEFAULT_DEV_API_URL, validateApiUrl } from "../src/api/config.js";
import { isAllowedGatewayOrigin } from "../src/shared/settings.js";

describe("the default API URL is one the extension will accept", () => {
  it("is an origin the gateway allowlist permits", () => {
    expect(DEFAULT_PROD_API_URL).toBe("https://api.governworld.acrlogic.com");
    expect(isAllowedGatewayOrigin(DEFAULT_PROD_API_URL)).toBe(true);
  });

  it("survives transport validation", () => {
    const check = validateApiUrl(DEFAULT_PROD_API_URL);
    expect(check.valid).toBe(true);
    expect(check.normalizedUrl).toBe(DEFAULT_PROD_API_URL);
  });

  it("is https, with no path, query or fragment", () => {
    const url = new URL(DEFAULT_PROD_API_URL);
    expect(url.protocol).toBe("https:");
    expect(url.pathname).toBe("/");
    expect(url.search).toBe("");
    expect(url.hash).toBe("");
  });

  it("is not the host the allowlist rejects", () => {
    // Named explicitly so the regression is legible if this ever fires again.
    expect(DEFAULT_PROD_API_URL).not.toContain("api.governworld.com");
  });

  it("keeps a localhost dev default that transport validation permits", () => {
    // Dev stays http for loopback, which `validateApiUrl` allows by design.
    expect(DEFAULT_DEV_API_URL).toBe("http://127.0.0.1:8000");
    expect(validateApiUrl(DEFAULT_DEV_API_URL).valid).toBe(true);
  });
});