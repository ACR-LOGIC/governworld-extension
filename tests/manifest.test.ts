import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8")) as {
  minimum_chrome_version: string;
  permissions: string[];
  web_accessible_resources?: unknown[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
};

describe("extension manifest disclosure contract", () => {
  it("keeps the packaged privacy page extension-origin-only", () => {
    expect(manifest.permissions).not.toContain("tabs");
    expect(manifest.web_accessible_resources).toBeUndefined();
  });

  it("uses the Chrome version required by sidePanel.open", () => {
    expect(manifest.minimum_chrome_version).toBe("116");
  });

  it("restricts automatic host_permissions to the pinned Supabase backend with zero wildcards", () => {
    expect(manifest.host_permissions).toEqual(["https://lkgcehdwasewwoieyoip.supabase.co/*"]);
    for (const entry of manifest.host_permissions ?? []) {
      expect(entry).not.toContain("<all_urls>");
      expect(entry).not.toMatch(/^https?:\/\/\*/);
    }
  });

  it("keeps always-on site access runtime-only, narrow, and revocable", () => {
    // Always-on protection is technically impossible without page access, so
    // the minimum grant is optional http(s) origins: nothing at install,
    // grantable and revocable at runtime, and never the <all_urls> blanket
    // (which would also cover chrome://, file://, and other schemes).
    expect(manifest.optional_host_permissions?.slice().sort()).toEqual([
      "http://*/*",
      "https://*/*",
    ]);
  });
});
