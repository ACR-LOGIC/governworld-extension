// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Regression test for session storage isolation (D-5 / S-8).
//
// In Chrome Extensions Manifest V3, `chrome.storage.session` is restricted to
// trusted extension contexts (service worker, popup, options, sidepanel) by default.
// Calling `chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })`
// exposes session storage to injected content scripts on arbitrary web pages.
//
// Because GovernWorld stores short-lived API keys, OAuth state, and scan session data
// in `chrome.storage.session`, exposing session storage to content scripts would allow
// hostile host pages to access credentials.
//
// Invariant: Session storage must NEVER be opened to untrusted contexts.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

function getAllSourceFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getAllSourceFiles(fullPath));
    } else if (entry.isFile() && /\.(ts|js|mjs)$/.test(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

describe("session storage isolation invariant", () => {
  it("never calls setAccessLevel with TRUSTED_AND_UNTRUSTED_CONTEXTS in any source file", () => {
    const srcDir = path.resolve(process.cwd(), "src");
    const sourceFiles = getAllSourceFiles(srcDir);
    expect(sourceFiles.length).toBeGreaterThan(10);

    for (const file of sourceFiles) {
      const content = fs.readFileSync(file, "utf8");
      expect(
        content.includes("TRUSTED_AND_UNTRUSTED_CONTEXTS"),
        `Violation found in ${path.relative(process.cwd(), file)}: session storage must not be exposed to untrusted contexts`
      ).toBe(false);

      if (content.includes("setAccessLevel")) {
        expect(
          content,
          `Violation found in ${path.relative(process.cwd(), file)}: setAccessLevel must not grant untrusted access`
        ).not.toMatch(/setAccessLevel\s*\(\s*\{\s*accessLevel\s*:\s*['"]TRUSTED_AND_UNTRUSTED_CONTEXTS['"]/);
      }
    }
  });

  it("verifies that auth credentials and scan sessions reside in session storage, not local", async () => {
    const authCode = fs.readFileSync(path.resolve(process.cwd(), "src/api/auth.ts"), "utf8");
    const workerCode = fs.readFileSync(path.resolve(process.cwd(), "src/service-worker/index.ts"), "utf8");

    // Bearer token must live in chrome.storage.session
    expect(authCode).toContain("chrome.storage.session.get(SESSION_KEY_AUTH_TOKENS)");
    expect(authCode).toContain("chrome.storage.session.set({ [SESSION_KEY_AUTH_TOKENS]");

    // API key credential must live in chrome.storage.session
    expect(workerCode).toContain("chrome.storage.session.set({ [ACCOUNT_KEY_CREDENTIAL]");
  });
});
