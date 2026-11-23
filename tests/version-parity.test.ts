// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Version parity: one shipped version everywhere.
//
// The API client sends CURRENT_EXTENSION_VERSION as X-Extension-Version and
// the health gate compares it against the server's minimum, so a stale
// constant silently misreports the build and mis-evaluates the kill switch.
// The Firefox manifest drifted the same way, so all of them are pinned
// to package.json here.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CURRENT_EXTENSION_VERSION } from "../src/api/config.js";

const extRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const json = (p: string): any => JSON.parse(readFileSync(join(extRoot, p), "utf8"));

describe("version parity (P11 single source of truth)", () => {
  it("ships one version across manifests, client header, lockfile, docs, and UI", () => {
    const pkg = json("package.json");
    const mv3 = json("manifest.json");
    const firefox = json("manifest.firefox.json");
    const lock = json("package-lock.json");
    const readme = readFileSync(join(extRoot, "README.md"), "utf8");
    const agents = readFileSync(join(extRoot, "AGENTS.md"), "utf8");
    const privacy = readFileSync(join(extRoot, "src/popup/privacy.html"), "utf8");
    const popupHtml = readFileSync(join(extRoot, "src/popup/index.html"), "utf8");
    const sidepanelHtml = readFileSync(join(extRoot, "src/sidepanel/sidepanel.html"), "utf8");

    expect(CURRENT_EXTENSION_VERSION).toBe(pkg.version);
    expect(mv3.version).toBe(pkg.version);
    expect(firefox.version).toBe(pkg.version);
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages?.[""]?.version ?? lock.version).toBe(pkg.version);
    expect(readme).toContain(`Version-${pkg.version}-blue.svg`);
    expect(readme).toContain(`(\`v${pkg.version}\`)`);
    expect(agents).toContain(`Current release version: \`${pkg.version}\`.`);
    expect(privacy).toContain(`Extension v${pkg.version}`);
    expect(privacy).toContain(`<code>v${pkg.version}</code>`);
    expect(popupHtml).toContain('id="diag-version-value"');
    expect(sidepanelHtml).toContain('id="diag-version-value"');
  });

  it("sync-version --check passes when all targets match package.json", () => {
    const out = execFileSync(process.execPath, [join(extRoot, "scripts/sync-version.mjs"), "--check"], {
      encoding: "utf8",
    });
    expect(out).toContain("All version targets match package.json");
  });
});
