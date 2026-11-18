// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const extRoot = process.cwd();
const popupHtml = readFileSync(join(extRoot, "src/popup/index.html"), "utf8");
const sidepanelHtml = readFileSync(join(extRoot, "src/sidepanel/sidepanel.html"), "utf8");
const popupCss = readFileSync(join(extRoot, "src/popup/popup.css"), "utf8");
const redactHtml = readFileSync(join(extRoot, "src/popup/redact.html"), "utf8");
const popupTs = readFileSync(join(extRoot, "src/popup/popup.ts"), "utf8");

describe("UI/UX Redesign Flows & Bug-Fix Contracts", () => {
  it("provides a circular profile avatar button and accessible popover in both popup and sidepanel", () => {
    for (const [name, html] of [
      ["index.html", popupHtml],
      ["sidepanel.html", sidepanelHtml],
    ] as const) {
      expect(html, `${name} missing #profile-avatar-btn`).toContain('id="profile-avatar-btn"');
      expect(html, `${name} missing #profile-popover`).toContain('id="profile-popover"');
      expect(html, `${name} missing #profile-goto-account-btn`).toContain('id="profile-goto-account-btn"');
      expect(html, `${name} missing #profile-goto-protection-btn`).toContain('id="profile-goto-protection-btn"');
      expect(html, `${name} missing #profile-goto-appearance-btn`).toContain('id="profile-goto-appearance-btn"');
    }
    expect(popupCss).toMatch(/\.profile-avatar-btn\s*\{[^}]*border-radius:\s*9999px/);
  });

  it("uses fluid responsive widths without locking sidepanel or redact.html to 360px", () => {
    expect(popupCss).not.toMatch(/html,\s*body\s*\{\s*width:\s*360px/);
    expect(redactHtml).toMatch(/html,\s*body\s*\{[^}]*width:\s*100%/);
    expect(popupTs).toContain('document.documentElement.dataset.surface = isSidePanelContext ? "sidepanel" : "popup"');
  });

  it("fixes the 7 malformed settings-nav button attributes and high-contrast trailing comma", () => {
    for (const [name, html] of [
      ["index.html", popupHtml],
      ["sidepanel.html", sidepanelHtml],
    ] as const) {
      expect(html, `${name} still has stray '>' before id="settings-nav-"`).not.toMatch(/>\s*id="settings-nav-/);
      for (const page of ["profile", "protection", "detection", "appearance", "notifications", "privacy", "advanced", "about"]) {
        expect(html, `${name} missing #settings-nav-${page}`).toContain(`id="settings-nav-${page}"`);
      }
    }
    expect(popupCss).not.toMatch(/\.shield-banner,\s*\{/);
  });

  it("wires first-run disclosure welcome, live status strip, and review telemetry", () => {
    expect(popupHtml).toContain('id="first-run-welcome"');
    expect(popupHtml).toContain('id="live-scan-value"');
    expect(popupHtml).toContain('id="live-paste-value"');
    expect(popupHtml).toContain('id="live-docs-value"');
    expect(popupTs).toContain("disclosureAcknowledged");
    expect(popupTs).toContain("isDocumentPipelineSupported");
    expect(popupTs).toContain("refreshReviewTelemetry");
    expect(popupTs).toContain("review-findings-count");
    expect(popupTs).toContain("review-protected-count");
    expect(popupTs).toContain("review-pages-count");
    expect(popupTs).toContain("activity-list");
  });

  it("fixes coverage-details-btn, clear-audit-btn storage keys, and removes fake pairing lock & native confirm/alert", () => {
    const coverageBlock = popupTs.slice(popupTs.indexOf("coverageDetailsBtn?.addEventListener"), popupTs.indexOf("coverageDetailsBtn?.addEventListener") + 200);
    expect(coverageBlock).toContain('switchTab("settings")');
    expect(coverageBlock).toContain('switchSettingsPage("privacy")');

    expect(popupTs).toContain('chrome.storage.local.remove(["auditLog", "auditCheckpointState"])');
    expect(popupTs).not.toContain('"audit_log"');
    expect(popupTs).not.toContain("GovernWorld Medical Practice");
    expect(popupTs).not.toMatch(/\bwindow\.confirm\s*\(/);
    expect(popupTs).not.toMatch(/\balert\s*\(/);
  });
});
