// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const html = readFileSync(resolve("download/index.html"), "utf8");
const styleBlock = html.match(/<style>([\s\S]*?)<\/style>/i)?.[1] ?? "";

const EXPECTED_SHA256 = "9a9e3640c27b1e7ea6a70989532f22f434c1501b0045610c865ee6eab175d750";
const REPO_URL = "https://github.com/ACR-LOGIC/governworld-extension";
const RELEASE_URL = "https://github.com/ACR-LOGIC/governworld-extension/releases/tag/v0.5.0";
const DIRECT_CRX_URL =
  "https://github.com/ACR-LOGIC/governworld-extension/releases/download/v0.5.0/governworld-v0.5.0.crx";

describe("/download self-contained release page", () => {
  it("sets exact page title, heading, and embedded PNG logo", () => {
    expect(html).toContain("<title>Download GovernWorld Extension</title>");
    expect(html).toContain("<h1>Download GovernWorld Extension</h1>");
    expect(html).toMatch(/<img[^>]+src="data:image\/png;base64,/);
  });

  it("is self-contained with zero external stylesheets, scripts, or images", () => {
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+rel="stylesheet"/i);
    expect(html).not.toMatch(/<img[^>]+src="https?:/i);
  });

  it("uses zero gold, amber, or yellow styling", () => {
    expect(styleBlock).not.toMatch(/\b(gold|amber|yellow)\b/i);
    expect(styleBlock).not.toMatch(/#(d4af37|f59e0b|eab308|fbbf24|fcd34d|b45309|ffd700)/i);
  });

  it("places the full transparency notice strictly before the download button", () => {
    const noticeIdx = html.indexOf("This extension is side loaded and is not from the Chrome Web Store.");
    const codeIdx = html.indexOf("You get 100 percent of the code as promised.");
    const localIdx = html.indexOf("This is local first. Nothing leaves the device until you choose to link it with a pairing code.");
    const downloadBtnIdx = html.indexOf('id="download-crx-btn"');

    expect(noticeIdx).toBeGreaterThan(-1);
    expect(codeIdx).toBeGreaterThan(noticeIdx);
    expect(localIdx).toBeGreaterThan(codeIdx);
    expect(downloadBtnIdx).toBeGreaterThan(localIdx);
  });

  it("includes live v0.5.0 release URLs and verified SHA-256 with no placeholders", () => {
    expect(html).not.toContain("[INSERT_");
    expect(html).toContain(EXPECTED_SHA256);
    expect(html).toContain(REPO_URL);
    expect(html).toContain(RELEASE_URL);
    expect(html).toContain(DIRECT_CRX_URL);
  });

  it("includes hash verification instructions for Windows, Mac, and Android", () => {
    expect(html).toContain("Verify the hash before you install");
    expect(html).toContain("Get-FileHash governworld-v0.5.0.crx -Algorithm SHA256");
    expect(html).toContain("shasum -a 256 governworld-v0.5.0.crx");
    expect(html).toContain("Verify on desktop if you can. The hash above is the same file from the GitHub release.");
  });

  it("includes install steps for only Windows, Mac, and Android and notes iOS/Safari unsupported", () => {
    const installCards = html.match(/class="install-card"/g) ?? [];
    expect(installCards).toHaveLength(3);
    expect(html).toContain("Windows, Chrome or Edge");
    expect(html).toContain("Safari is not supported on Windows.");
    expect(html).toContain("Mac, Chrome or Edge");
    expect(html).toContain("Safari on Mac does not support Chrome extensions. Use Chrome or Edge.");
    expect(html).toContain("Android, Chrome");
    expect(html).toContain("Tap Install app or Add to Home Screen when prompted.");
    expect(html).toContain("iOS and Safari are not supported in this version.");
    expect(html).not.toMatch(/iphone|ipad/i);
  });

  it("includes bottom GitHub links, manual install note, and local promise closing line", () => {
    expect(html).toContain("View full source on GitHub");
    expect(html).toContain("Get it from the GitHub release instead");
    expect(html).toContain(
      "If you do not want to use this page, you can always go to the release yourself, download the CRX there, and install it manually."
    );
    expect(html).toContain(
      "The local promise still holds on download. The full package downloads to your device and runs locally."
    );
  });
});
