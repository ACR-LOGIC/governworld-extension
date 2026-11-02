// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Complete visual reconstruction and capture of every user-facing extension screen,
// plus visual contact sheet generation.

import { chromium } from "@playwright/test";
import { browserChannelArgs, browserProfileDir, waitForPopupReady, stageFileInPopup } from "./browser-launch.mjs";
import { createServer } from "node:http";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = join(root, "dist");
const fixtures = join(root, "tests", "fixtures");
const WORK = join(root, ".tmp-reconstruct");
const EXT = join(WORK, "ext");
const DESKTOP_OUT = "C:\\Users\\omg\\Desktop\\chrome pics";

const PORT = 8083;
const ORIGIN = `http://localhost:${PORT}`;
const FIXTURE_URL = `${ORIGIN}/page.html`;

if (!existsSync(join(dist, "manifest.json"))) {
  console.error("dist/manifest.json missing - run npm run build first.");
  process.exit(1);
}

mkdirSync(DESKTOP_OUT, { recursive: true });
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

// Copy dist to throwaway variant with localhost permission
cpSync(dist, EXT, { recursive: true });
const manifestPath = join(EXT, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.host_permissions = [`${ORIGIN}/*`];
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

// Fixture server
const MIME = { ".html": "text/html; charset=utf-8", ".png": "image/png", ".pdf": "application/pdf" };
const server = createServer((req, res) => {
  const name = decodeURIComponent((req.url ?? "/").replace(/^\/+/, "")) || "page.html";
  const file = join(fixtures, name);
  if (!file.startsWith(fixtures) || !existsSync(file)) return void res.writeHead(404).end("not found");
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const PROFILE = browserProfileDir(join(WORK, `profile-${Date.now()}`));
const context = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  ...browserChannelArgs(),
  viewport: { width: 1280, height: 900 },
  acceptDownloads: true,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    "--no-first-run",
    "--no-default-browser-check",
  ],
});

console.log("Context launched, waiting for service worker...");
const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 30000 }));
const extensionId = new URL(worker.url()).host;
console.log(`Extension ID: ${extensionId}`);

const capturedFiles = [];

async function captureElementOrPage(page, selector, outputPath, clipOptions = null) {
  await page.waitForTimeout(400);
  if (selector) {
    const el = page.locator(selector);
    await el.waitFor({ state: "visible", timeout: 8000 });
    await el.screenshot({ path: outputPath });
  } else if (clipOptions) {
    await page.screenshot({ path: outputPath, clip: clipOptions });
  } else {
    await page.screenshot({ path: outputPath, fullPage: true });
  }
  capturedFiles.push(outputPath);
  console.log(`[CAPTURED] ${outputPath}`);
}

try {
  // 1. Prepare fixture tab
  const fixturePage = await context.newPage();
  await fixturePage.goto(FIXTURE_URL, { waitUntil: "load" });
  await fixturePage.bringToFront();

  // 2. Open Popup page
  const popupPage = await context.newPage();
  await popupPage.setViewportSize({ width: 440, height: 750 });
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "load" });
  await waitForPopupReady(popupPage);

  // Screen 1: Popup Protection (Standby / Default)
  await captureElementOrPage(popupPage, "#app", join(DESKTOP_OUT, "01_popup_protection_standby.png"));

  // Inject content script into fixture tab and perform live page scan to capture Findings
  await fixturePage.bringToFront();
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    }
  });

  // Run scan
  await popupPage.evaluate((requestId) => {
    return new Promise((resolve) => {
      const listener = (msg) => {
        if (msg?.type === "POPUP_STATE") {
          chrome.runtime.onMessage.removeListener(listener);
          resolve(true);
        }
      };
      chrome.runtime.onMessage.addListener(listener);
      chrome.runtime.sendMessage({ type: "POPUP_SCAN", requestId, mode: "local" });
    });
  }, "scan-1");

  await popupPage.waitForTimeout(1000);

  // If verify dialog appeared, capture it!
  const verifyOpen = await popupPage.$eval("#verify-dialog", (d) => d.open).catch(() => false);
  if (verifyOpen) {
    await captureElementOrPage(popupPage, "#app", join(DESKTOP_OUT, "20_dialog_verify_work.png"));
    await popupPage.click("#verify-understood");
    await popupPage.waitForTimeout(400);
  }

  // Screen 2: Popup Protection with Findings Detected
  await captureElementOrPage(popupPage, "#app", join(DESKTOP_OUT, "02_popup_protection_findings.png"));

  // Screen 3: Popup Document Studio Workspace
  const photoBytes = readFileSync(join(fixtures, "photo-pii.png"));
  await stageFileInPopup(popupPage, photoBytes, "patient-record-discharge.png", "image/png");
  await popupPage.waitForSelector("#doc-workspace:not([hidden])", { timeout: 60000 });
  await popupPage.waitForTimeout(1500);

  // Redaction style: text stamp
  await popupPage.selectOption("#doc-style-select", "stamp");
  await popupPage.waitForTimeout(500);
  await popupPage.fill("#doc-stamp-text", "[CONFIDENTIAL-PII]");
  await popupPage.waitForTimeout(500);
  await captureElementOrPage(popupPage, "#app", join(DESKTOP_OUT, "03_popup_document_studio.png"));

  // Open Full-Screen Review from doc workspace
  const [reviewTab] = await Promise.all([
    context.waitForEvent("page"),
    popupPage.click("#doc-open-review-btn"),
  ]);
  await reviewTab.waitForLoadState("load");
  await reviewTab.setViewportSize({ width: 1280, height: 800 });
  await reviewTab.waitForTimeout(1200);
  await captureElementOrPage(reviewTab, null, join(DESKTOP_OUT, "27_fullscreen_document_review.png"), { x: 0, y: 0, width: 1280, height: 800 });
  await reviewTab.close();

  // Screen 4: Tab Logic (My Logic)
  await popupPage.click("#tab-btn-logic");
  await popupPage.waitForTimeout(500);
  await captureElementOrPage(popupPage, "#app", join(DESKTOP_OUT, "04_popup_logic_tab.png"));

  // Wizard Dialog Steps (Custom rule creation)
  await popupPage.click("#open-wizard-btn-2");
  await popupPage.waitForTimeout(400);
  // Wizard Step 1
  await captureElementOrPage(popupPage, "#app", join(DESKTOP_OUT, "14_dialog_wizard_step1.png"));
  // Fill sample and analyze to step 2
  await popupPage.fill("#wizard-pos-input", "PATIENT-ID: 994827\nPATIENT-ID: 883921");
  await popupPage.click("#wizard-analyze-btn");
  await popupPage.waitForTimeout(600);
  await captureElementOrPage(popupPage, "#app", join(DESKTOP_OUT, "15_dialog_wizard_step2.png"));
  // Step 3
  await popupPage.click("#wizard-next-2");
  await popupPage.waitForTimeout(500);
  await captureElementOrPage(popupPage, "#app", join(DESKTOP_OUT, "16_dialog_wizard_step3.png"));
  // Step 4
  await popupPage.click("#wizard-next-3");
  await popupPage.waitForTimeout(500);
  await captureElementOrPage(popupPage, "#app", join(DESKTOP_OUT, "17_dialog_wizard_step4.png"));
  
  // Close wizard safely via DOM
  await popupPage.evaluate(() => {
    const dialog = document.getElementById("wizard-dialog");
    dialog?.close();
  });
  await popupPage.waitForTimeout(400);

  // Screen 5: Tab Review (Audit & Activity interface)
  await popupPage.click("#tab-btn-review");
  await popupPage.waitForTimeout(500);
  await captureElementOrPage(popupPage, "#app", join(DESKTOP_OUT, "05_popup_review_audit_tab.png"));

  // Settings Sub-pages
  await popupPage.click("#tab-btn-settings");
  await popupPage.waitForTimeout(400);

  // Settings: Profile & Account
  await popupPage.click('[data-settings-page="profile"]');
  await popupPage.waitForTimeout(400);
  await captureElementOrPage(popupPage, "#app", join(DESKTOP_OUT, "06_popup_settings_profile.png"));

  // Settings: Protection & Location/Site Access Controls
  await popupPage.click('[data-settings-page="protection"]');
  await popupPage.waitForTimeout(400);
  await captureElementOrPage(popupPage, "#app", join(DESKTOP_OUT, "07_popup_settings_protection_location.png"));

  // Settings: Detection Presets & 20 Categories
  await popupPage.click('[data-settings-page="detection"]');
  await popupPage.waitForTimeout(400);
  await captureElementOrPage(popupPage, "#app", join(DESKTOP_OUT, "08_popup_settings_detection_categories.png"));

  // Settings: Appearance & Accessibility
  await popupPage.click('[data-settings-page="appearance"]');
  await popupPage.waitForTimeout(400);
  await captureElementOrPage(popupPage, "#app", join(DESKTOP_OUT, "09_popup_settings_appearance.png"));

  // Settings: Notifications
  await popupPage.click('[data-settings-page="notifications"]');
  await popupPage.waitForTimeout(400);
  await captureElementOrPage(popupPage, "#app", join(DESKTOP_OUT, "10_popup_settings_notifications.png"));

  // Settings: Privacy & Local-Only Mode
  await popupPage.click('[data-settings-page="privacy"]');
  await popupPage.waitForTimeout(400);
  await captureElementOrPage(popupPage, "#app", join(DESKTOP_OUT, "11_popup_settings_privacy.png"));

  // Settings: Advanced
  await popupPage.click('[data-settings-page="advanced"]');
  await popupPage.waitForTimeout(400);
  await captureElementOrPage(popupPage, "#app", join(DESKTOP_OUT, "12_popup_settings_advanced.png"));

  // Settings: About, Diagnostics & Audit Trail Controls
  await popupPage.click('[data-settings-page="about"]');
  await popupPage.waitForTimeout(400);
  await captureElementOrPage(popupPage, "#app", join(DESKTOP_OUT, "13_popup_settings_about_audit.png"));

  // Dialog: Clear Audit Trail Confirmation
  await popupPage.click("#clear-audit-btn");
  await popupPage.waitForTimeout(400);
  await captureElementOrPage(popupPage, "#app", join(DESKTOP_OUT, "18_dialog_clear_audit.png"));
  await popupPage.click("#clear-audit-cancel");
  await popupPage.waitForTimeout(400);

  // Dialog: Document Page Window Chooser
  await popupPage.evaluate(() => {
    const d = document.getElementById("doc-window-dialog");
    const desc = document.getElementById("doc-window-desc");
    if (desc) desc.textContent = "This document has 45 pages. GovernWorld scans up to 20 pages at a time. Choose which page range to scan.";
    d?.showModal();
  });
  await popupPage.waitForTimeout(400);
  await captureElementOrPage(popupPage, "#app", join(DESKTOP_OUT, "19_dialog_doc_page_window.png"));
  await popupPage.evaluate(() => document.getElementById("doc-window-dialog")?.close());
  await popupPage.waitForTimeout(400);

  // Dialog: Copy Redacted Text
  await popupPage.evaluate(() => document.getElementById("copy-dialog")?.showModal());
  await popupPage.waitForTimeout(400);
  await captureElementOrPage(popupPage, "#app", join(DESKTOP_OUT, "21_dialog_copy_redacted.png"));
  await popupPage.evaluate(() => document.getElementById("copy-dialog")?.close());
  await popupPage.waitForTimeout(400);

  // --- Side Panel Views ---
  const sidePage = await context.newPage();
  await sidePage.setViewportSize({ width: 440, height: 800 });
  await sidePage.goto(`chrome-extension://${extensionId}/sidepanel.html`, { waitUntil: "load" });
  await sidePage.waitForTimeout(800);

  // Sidepanel Protection
  await captureElementOrPage(sidePage, "#app", join(DESKTOP_OUT, "22_sidepanel_protection.png"));

  // Sidepanel Logic
  await sidePage.click("#tab-btn-logic");
  await sidePage.waitForTimeout(400);
  await captureElementOrPage(sidePage, "#app", join(DESKTOP_OUT, "23_sidepanel_logic.png"));

  // Sidepanel Review & Audit
  await sidePage.click("#tab-btn-review");
  await sidePage.waitForTimeout(400);
  await captureElementOrPage(sidePage, "#app", join(DESKTOP_OUT, "24_sidepanel_review_audit.png"));

  // Sidepanel Settings Protection & Location
  await sidePage.click("#tab-btn-settings");
  await sidePage.click('[data-settings-page="protection"]');
  await sidePage.waitForTimeout(400);
  await captureElementOrPage(sidePage, "#app", join(DESKTOP_OUT, "25_sidepanel_settings_protection.png"));

  // Sidepanel Settings About & Diagnostics
  await sidePage.click('[data-settings-page="about"]');
  await sidePage.waitForTimeout(400);
  await captureElementOrPage(sidePage, "#app", join(DESKTOP_OUT, "26_sidepanel_settings_about.png"));

  // --- Dedicated Full-Screen Surfaces ---

  // Print & PDF Redaction View (redact.html)
  const redactPage = await context.newPage();
  await redactPage.setViewportSize({ width: 1280, height: 850 });
  await redactPage.goto(`chrome-extension://${extensionId}/redact.html`, { waitUntil: "load" });
  await redactPage.evaluate(() => {
    const sheets = document.getElementById("sheets");
    if (sheets) {
      sheets.innerHTML = `
        <div class="sheet" style="width: 595px; height: 842px; position: relative; background: #ffffff; border: 1px solid #d1d5db; box-shadow: 0 4px 20px rgba(0,0,0,0.15); margin: 0 auto; padding: 40px; box-sizing: border-box; font-family: sans-serif;">
          <div style="border-bottom: 2px solid #1e3a5f; padding-bottom: 8px; margin-bottom: 20px;">
            <h2 style="margin: 0; color: #1e3a5f; font-size: 20px;">CONFIDENTIAL MEDICAL DISCHARGE SUMMARY</h2>
            <span style="font-size: 11px; color: #64748b;">Patient Record ID: [PII REMOVED]</span>
          </div>
          <div style="font-size: 13px; line-height: 1.8; color: #334155;">
            <p><strong>Patient Name:</strong> <span style="background: #0f172a; color: #0f172a; padding: 2px 28px; border-radius: 2px; user-select: none;">John Doe</span></p>
            <p><strong>Date of Birth:</strong> <span style="background: #0f172a; color: #0f172a; padding: 2px 24px; border-radius: 2px; user-select: none;">04/12/1982</span> &nbsp;&nbsp; <strong>SSN:</strong> <span style="background: #0f172a; color: #0f172a; padding: 2px 30px; border-radius: 2px; user-select: none;">123-45-6789</span></p>
            <p><strong>Home Address:</strong> <span style="background: #0f172a; color: #0f172a; padding: 2px 50px; border-radius: 2px; user-select: none;">442 Elm Street, Springfield IL</span></p>
            <p><strong>Billing Card:</strong> <span style="background: #0f172a; color: #0f172a; padding: 2px 42px; border-radius: 2px; user-select: none;">****-****-****-4242</span></p>
            <div style="margin-top: 24px; padding: 12px; background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 4px; font-size: 11px; color: #64748b;">
              ✓ Pixel-Level Verified Redaction • Flattened In-Memory • Zero Network Transmission
            </div>
          </div>
        </div>
      `;
      const btn = document.getElementById("print-btn");
      if (btn) btn.disabled = false;
      const pdf = document.getElementById("pdf-btn");
      if (pdf) pdf.disabled = false;
      const count = document.getElementById("print-count");
      if (count) {
        count.hidden = false;
        count.textContent = "1 page verified";
      }
    }
  });
  await redactPage.waitForTimeout(600);
  await captureElementOrPage(redactPage, null, join(DESKTOP_OUT, "28_print_pdf_redaction_view.png"), { x: 0, y: 0, width: 1280, height: 850 });

  // Landing Page (landing.html)
  const landingPage = await context.newPage();
  await landingPage.setViewportSize({ width: 1280, height: 900 });
  await landingPage.goto(`chrome-extension://${extensionId}/landing.html`, { waitUntil: "load" });
  await landingPage.waitForTimeout(600);
  await captureElementOrPage(landingPage, null, join(DESKTOP_OUT, "29_landing_page.png"), { x: 0, y: 0, width: 1280, height: 850 });

  // Privacy Policy (privacy.html)
  const privacyPage = await context.newPage();
  await privacyPage.setViewportSize({ width: 1280, height: 900 });
  await privacyPage.goto(`chrome-extension://${extensionId}/privacy.html`, { waitUntil: "load" });
  await privacyPage.waitForTimeout(600);
  await captureElementOrPage(privacyPage, null, join(DESKTOP_OUT, "30_privacy_policy.png"), { x: 0, y: 0, width: 1280, height: 850 });

  // Legal Terms (legal.html)
  const legalPage = await context.newPage();
  await legalPage.setViewportSize({ width: 1280, height: 900 });
  await legalPage.goto(`chrome-extension://${extensionId}/legal.html`, { waitUntil: "load" });
  await legalPage.waitForTimeout(600);
  await captureElementOrPage(legalPage, null, join(DESKTOP_OUT, "31_legal_terms.png"), { x: 0, y: 0, width: 1280, height: 850 });

  console.log(`\nAll individual screens successfully captured! Total: ${capturedFiles.length}`);

  // --- Visual Contact Sheet Generation ---
  console.log("\nGenerating master visual contact sheet...");
  const contactSheetHtmlPath = join(DESKTOP_OUT, "00_visual_contact_sheet.html");
  const contactSheetPngPath = join(DESKTOP_OUT, "00_visual_contact_sheet.png");

  // Read images as base64 so HTML contact sheet is completely self-contained and portable!
  const imgData = {};
  for (const file of readdirSync(DESKTOP_OUT)) {
    if (file.endsWith(".png") && !file.startsWith("00_")) {
      const b64 = readFileSync(join(DESKTOP_OUT, file)).toString("base64");
      imgData[file] = `data:image/png;base64,${b64}`;
    }
  }

  const contactHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>GovernWorld Extension — Visual Contact Sheet</title>
  <style>
    :root {
      --bg: #090d16;
      --card-bg: #111827;
      --card-border: #1f293d;
      --accent: #3b82f6;
      --accent-glow: rgba(59, 130, 246, 0.2);
      --text: #f1f5f9;
      --text-muted: #94a3b8;
      --highlight: #10b981;
      --warn: #f59e0b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      padding: 32px;
      line-height: 1.5;
    }
    .header {
      background: linear-gradient(135deg, #111827 0%, #1e293b 100%);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 24px 32px;
      margin-bottom: 32px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5);
    }
    .header__title h1 {
      font-size: 26px;
      font-weight: 700;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .badge {
      display: inline-block;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      padding: 3px 8px;
      border-radius: 4px;
      letter-spacing: 0.5px;
    }
    .badge--blue { background: rgba(59, 130, 246, 0.2); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.4); }
    .badge--green { background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.4); }
    .header__meta {
      text-align: right;
      font-size: 13px;
      color: var(--text-muted);
    }
    .section-title {
      font-size: 20px;
      font-weight: 700;
      color: #e2e8f0;
      margin: 36px 0 16px;
      padding-bottom: 8px;
      border-bottom: 2px solid #243049;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
      gap: 24px;
      margin-bottom: 28px;
    }
    .grid--wide {
      grid-template-columns: repeat(auto-fit, minmax(560px, 1fr));
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 10px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      box-shadow: 0 4px 15px rgba(0,0,0,0.3);
      transition: transform 0.2s ease, border-color 0.2s ease;
    }
    .card__header {
      padding: 12px 16px;
      background: #172033;
      border-bottom: 1px solid var(--card-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .card__name {
      font-size: 14px;
      font-weight: 600;
      color: #f8fafc;
    }
    .card__preview {
      padding: 16px;
      background: #0b0f19;
      display: flex;
      justify-content: center;
      align-items: flex-start;
      min-height: 380px;
      overflow: hidden;
    }
    .card__preview img {
      max-width: 100%;
      height: auto;
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      border: 1px solid #1f2937;
    }
    .card__body {
      padding: 14px 16px;
      font-size: 12px;
      color: var(--text-muted);
      background: #111827;
      border-top: 1px solid var(--card-border);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .tag-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 4px;
    }
    .tag {
      background: #1e293b;
      color: #cbd5e1;
      padding: 2px 7px;
      border-radius: 4px;
      font-size: 11px;
      border: 1px solid #334155;
    }
    .arch-panel {
      background: #0f172a;
      border: 1px solid #1e293b;
      border-radius: 10px;
      padding: 24px;
      margin-top: 40px;
    }
    .arch-panel h2 {
      font-size: 18px;
      margin-bottom: 12px;
      color: #60a5fa;
    }
    .arch-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
      font-size: 13px;
      color: #cbd5e1;
    }
    .arch-box {
      background: #172033;
      padding: 16px;
      border-radius: 8px;
      border: 1px solid #243049;
    }
    .arch-box h3 {
      font-size: 14px;
      color: #f1f5f9;
      margin-bottom: 8px;
    }
    ul.check-list {
      list-style: none;
      padding-left: 0;
    }
    ul.check-list li {
      margin-bottom: 6px;
      position: relative;
      padding-left: 18px;
    }
    ul.check-list li::before {
      content: "•";
      color: #3b82f6;
      position: absolute;
      left: 4px;
      font-size: 16px;
    }
  </style>
</head>
<body>

  <header class="header">
    <div class="header__title">
      <h1>
        GovernWorld Extension
        <span class="badge badge--blue">main branch</span>
        <span class="badge badge--green">v0.1.1 production</span>
      </h1>
      <p style="color: var(--text-muted); font-size: 13px; margin-top: 4px;">
        Complete Visual Screen Topology, Shared Component Mapping &amp; Popup-to-Side Panel Sync Architecture
      </p>
    </div>
    <div class="header__meta">
      <div>Engine: <strong>Local-First / Zero Network Egress</strong></div>
      <div>Platform: <strong>Chrome / Chromium MV3 (ESM + IIFE)</strong></div>
      <div>Build Target: <strong>dist/</strong></div>
    </div>
  </header>

  <!-- 1. POPUP: PRIMARY SURFACES -->
  <h2 class="section-title">1. Current Extension Popup: Primary Surfaces</h2>
  <div class="grid">
    <div class="card">
      <div class="card__header">
        <span class="card__name">01. Protection Tab (Standby / Default)</span>
        <span class="badge badge--blue">tab-protection</span>
      </div>
      <div class="card__preview">
        <img src="${imgData['01_popup_protection_standby.png'] || ''}" alt="Popup Standby" />
      </div>
      <div class="card__body">
        <strong>Default Action Surface</strong>
        <span>Live status indicator of Page, Paste, and Document protection services. Includes primary Scan button, secondary action grid, dropzone, and OCR language picker.</span>
        <div class="tag-row">
          <span class="tag">#scanner-shield-status</span>
          <span class="tag">#scan-btn</span>
          <span class="tag">#doc-dropzone</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card__header">
        <span class="card__name">02. Findings Detected (Scan Results)</span>
        <span class="badge badge--green">#results-section</span>
      </div>
      <div class="card__preview">
        <img src="${imgData['02_popup_protection_findings.png'] || ''}" alt="Popup Findings" />
      </div>
      <div class="card__body">
        <strong>Detected Findings &amp; Action Bar</strong>
        <span>Rendered after live page scan. Populates detected PII/PHI categories (SSN, Email, Cards), preview snippets, confidence rating, Select All, and Apply/Undo mask controls.</span>
        <div class="tag-row">
          <span class="tag">#findings-list</span>
          <span class="tag">#apply-masks-btn</span>
          <span class="tag">#export-findings-btn</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card__header">
        <span class="card__name">03. Document Studio Workspace</span>
        <span class="badge badge--blue">#doc-workspace</span>
      </div>
      <div class="card__preview">
        <img src="${imgData['03_popup_document_studio.png'] || ''}" alt="Document Studio" />
      </div>
      <div class="card__body">
        <strong>Local Document Redaction Studio</strong>
        <span>Multi-page thumbnail rail, manual box drawing tools, redaction style picker (Blackout, Whiteout, Text Stamp with presets), findings list, and Full-Screen Review action.</span>
        <div class="tag-row">
          <span class="tag">#doc-thumbs</span>
          <span class="tag">#doc-style-select</span>
          <span class="tag">#doc-open-review-btn</span>
        </div>
      </div>
    </div>
  </div>

  <!-- 2. PROTECTION & LOCATION CONTROLS -->
  <h2 class="section-title">2. Protection &amp; Location Controls (Site Access &amp; Permissions)</h2>
  <div class="grid">
    <div class="card">
      <div class="card__header">
        <span class="card__name">07. Protection &amp; Location Controls (Popup)</span>
        <span class="badge badge--blue">settings-page-protection</span>
      </div>
      <div class="card__preview">
        <img src="${imgData['07_popup_settings_protection_location.png'] || ''}" alt="Protection & Location Settings" />
      </div>
      <div class="card__body">
        <strong>Location &amp; Domain Protection Authority</strong>
        <span>Controls "Always protect all sites" (Location/Site Access via optional host permission), "Grant site access" button, Paste Shield toggle, Context Menus, and Session Timeout.</span>
        <div class="tag-row">
          <span class="tag">#always-on-toggle</span>
          <span class="tag">#grant-access-btn</span>
          <span class="tag">#paste-guard-toggle</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card__header">
        <span class="card__name">25. Protection &amp; Location Controls (Side Panel)</span>
        <span class="badge badge--green">sidepanel-protection-settings</span>
      </div>
      <div class="card__preview">
        <img src="${imgData['25_sidepanel_settings_protection.png'] || ''}" alt="Sidepanel Protection Settings" />
      </div>
      <div class="card__body">
        <strong>Side Panel Site Access Mirror</strong>
        <span>Byte-for-byte synced counterpart in sidepanel.html. Changing site access or always-on in either view instantly updates chrome.storage.local and synchronizes both interfaces.</span>
        <div class="tag-row">
          <span class="tag">siteProtection.ts</span>
          <span class="tag">siteAccess.ts</span>
          <span class="tag">live-sync</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card__header">
        <span class="card__name">20. Verification Notice Dialog</span>
        <span class="badge badge--blue">#verify-dialog</span>
      </div>
      <div class="card__preview">
        <img src="${imgData['20_dialog_verify_work.png'] || ''}" alt="Verify Work Dialog" />
      </div>
      <div class="card__body">
        <strong>Site Verification &amp; Accuracy Disclosure</strong>
        <span>One-time mandatory verification modal. Enforces user review before sharing or submitting data, explaining probabilistic local ML detection guarantees.</span>
        <div class="tag-row">
          <span class="tag">#verify-dialog</span>
          <span class="tag">#verify-understood</span>
          <span class="tag">fail-closed</span>
        </div>
      </div>
    </div>
  </div>

  <!-- 3. LOGIC CONTROLS: CUSTOM RULES & WIZARD -->
  <h2 class="section-title">3. Logic Controls: Personal Logic, Community Logic &amp; Rule Wizard</h2>
  <div class="grid">
    <div class="card">
      <div class="card__header">
        <span class="card__name">04. My Logic Tab (Popup)</span>
        <span class="badge badge--blue">tab-logic</span>
      </div>
      <div class="card__preview">
        <img src="${imgData['04_popup_logic_tab.png'] || ''}" alt="Logic Tab" />
      </div>
      <div class="card__body">
        <strong>Custom Logic &amp; Personal Rules</strong>
        <span>User-defined detection logic rules list, local pattern compilation, "+ Create Personal Logic" launcher, and Community Logic status.</span>
        <div class="tag-row">
          <span class="tag">#custom-patterns-list</span>
          <span class="tag">#open-wizard-btn-2</span>
          <span class="tag">customPatterns.ts</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card__header">
        <span class="card__name">14. Logic Wizard: Step 1 (Examples)</span>
        <span class="badge badge--green">#wizard-step-1</span>
      </div>
      <div class="card__preview">
        <img src="${imgData['14_dialog_wizard_step1.png'] || ''}" alt="Wizard Step 1" />
      </div>
      <div class="card__body">
        <strong>Interactive Rule Generation</strong>
        <span>Accepts positive and negative sample lines from the user. Runs wizardAnalyzer locally on CPU without external API calls.</span>
        <div class="tag-row">
          <span class="tag">#wizard-pos-input</span>
          <span class="tag">#wizard-analyze-btn</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card__header">
        <span class="card__name">15. Logic Wizard: Step 2 (Proposals)</span>
        <span class="badge badge--green">#wizard-step-2</span>
      </div>
      <div class="card__preview">
        <img src="${imgData['15_dialog_wizard_step2.png'] || ''}" alt="Wizard Step 2" />
      </div>
      <div class="card__body">
        <strong>Proposed Regular Expressions</strong>
        <span>Surfaces synthesized regex options based on extracted token boundaries and character class distributions.</span>
        <div class="tag-row">
          <span class="tag">#wizard-proposals-container</span>
          <span class="tag">wizardAnalyzer.ts</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card__header">
        <span class="card__name">16. Logic Wizard: Step 3 (Refine)</span>
        <span class="badge badge--green">#wizard-step-3</span>
      </div>
      <div class="card__preview">
        <img src="${imgData['16_dialog_wizard_step3.png'] || ''}" alt="Wizard Step 3" />
      </div>
      <div class="card__body">
        <strong>Live Testing Sandbox</strong>
        <span>Real-time regex evaluation against test text input. Displays live match counts and visual highlights before saving.</span>
        <div class="tag-row">
          <span class="tag">#wizard-regex-input</span>
          <span class="tag">#wizard-test-sample</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card__header">
        <span class="card__name">17. Logic Wizard: Step 4 (Save Rule)</span>
        <span class="badge badge--green">#wizard-step-4</span>
      </div>
      <div class="card__preview">
        <img src="${imgData['17_dialog_wizard_step4.png'] || ''}" alt="Wizard Step 4" />
      </div>
      <div class="card__body">
        <strong>Persist Rule &amp; Category Attribution</strong>
        <span>Configures rule name, detection category attribution (PII, Financial, Secrets, etc.), and minimum confidence threshold.</span>
        <div class="tag-row">
          <span class="tag">#wizard-rule-name</span>
          <span class="tag">#wizard-save-btn</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card__header">
        <span class="card__name">23. Logic Tab (Side Panel)</span>
        <span class="badge badge--blue">sidepanel-logic</span>
      </div>
      <div class="card__preview">
        <img src="${imgData['23_sidepanel_logic.png'] || ''}" alt="Sidepanel Logic Tab" />
      </div>
      <div class="card__body">
        <strong>Side Panel Logic Counterpart</strong>
        <span>Side panel docked view of personal logic. Synchronizes custom rule definitions across popup and sidepanel via chrome.storage.local.</span>
        <div class="tag-row">
          <span class="tag">sidepanel.html</span>
          <span class="tag">storage.onChanged</span>
        </div>
      </div>
    </div>
  </div>

  <!-- 4. SETTINGS INTERFACE -->
  <h2 class="section-title">4. Settings Interface: Compliance Presets, 20 Categories &amp; Privacy</h2>
  <div class="grid">
    <div class="card">
      <div class="card__header">
        <span class="card__name">08. Detection &amp; Compliance Presets</span>
        <span class="badge badge--blue">settings-page-detection</span>
      </div>
      <div class="card__preview">
        <img src="${imgData['08_popup_settings_detection_categories.png'] || ''}" alt="Detection Settings" />
      </div>
      <div class="card__body">
        <strong>Presets &amp; 20 Detection Categories</strong>
        <span>Compliance presets: HIPAA, PCI DSS, GDPR, PIPEDA, UK GDPR, India DPDP, Australia Privacy, Brazil LGPD, Developer Secrets. Checkboxes for all 23 built-in detectors.</span>
        <div class="tag-row">
          <span class="tag">#preset-select</span>
          <span class="tag">#category-list</span>
          <span class="tag">ALL_CATEGORIES</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card__header">
        <span class="card__name">06. Profile &amp; Account</span>
        <span class="badge badge--blue">settings-page-profile</span>
      </div>
      <div class="card__preview">
        <img src="${imgData['06_popup_settings_profile.png'] || ''}" alt="Profile Settings" />
      </div>
      <div class="card__body">
        <strong>Identity &amp; Enterprise Managed Policy</strong>
        <span>Server-verified identity display, organization name, role, license status, and enterprise policy restriction indicators.</span>
        <div class="tag-row">
          <span class="tag">#account-identity</span>
          <span class="tag">enterprisePolicy.ts</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card__header">
        <span class="card__name">09. Appearance &amp; Accessibility</span>
        <span class="badge badge--blue">settings-page-appearance</span>
      </div>
      <div class="card__preview">
        <img src="${imgData['09_popup_settings_appearance.png'] || ''}" alt="Appearance Settings" />
      </div>
      <div class="card__body">
        <strong>A11y, Theming &amp; Internationalization</strong>
        <span>UI Language (EN, ES, FR, DE, JA, PT, ZH), font size scaling (default, medium, large, xlarge), High Contrast, Dyslexia-Friendly mode, Reduced Motion, and Speech.</span>
        <div class="tag-row">
          <span class="tag">#lang-select</span>
          <span class="tag">#dyslexia-toggle</span>
          <span class="tag">#high-contrast-toggle</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card__header">
        <span class="card__name">11. Privacy &amp; Local-First Guard</span>
        <span class="badge badge--blue">settings-page-privacy</span>
      </div>
      <div class="card__preview">
        <img src="${imgData['11_popup_settings_privacy.png'] || ''}" alt="Privacy Settings" />
      </div>
      <div class="card__body">
        <strong>Zero Egress Guarantee</strong>
        <span>Detailed breakdown of required Chrome permissions (activeTab, scripting, storage, downloads, offscreen). Processing mode locked to Local Only (Cloud disabled).</span>
        <div class="tag-row">
          <span class="tag">#mode-local</span>
          <span class="tag">#mode-cloud (disabled)</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card__header">
        <span class="card__name">12. Advanced OCR Architecture</span>
        <span class="badge badge--blue">settings-page-advanced</span>
      </div>
      <div class="card__preview">
        <img src="${imgData['12_popup_settings_advanced.png'] || ''}" alt="Advanced Settings" />
      </div>
      <div class="card__body">
        <strong>Engine Configuration</strong>
        <span>Document OCR Language picker (bundled English traineddata), WASM Tesseract architecture explanation, and fail-closed diagnostic flags.</span>
        <div class="tag-row">
          <span class="tag">#ocr-language-select</span>
          <span class="tag">tesseract.js WASM</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card__header">
        <span class="card__name">10. Notifications</span>
        <span class="badge badge--blue">settings-page-notifications</span>
      </div>
      <div class="card__preview">
        <img src="${imgData['10_popup_settings_notifications.png'] || ''}" alt="Notifications Settings" />
      </div>
      <div class="card__body">
        <strong>Alert Configuration</strong>
        <span>Controls whether the browser surfaces native notifications when sensitive data or high-risk findings are identified on web pages.</span>
        <div class="tag-row">
          <span class="tag">#notifications-toggle</span>
        </div>
      </div>
    </div>
  </div>

  <!-- 5. AUDIT INTERFACE -->
  <h2 class="section-title">5. Audit Interface: ECDSA Signed Trail, Metrics &amp; Operational Diagnostics</h2>
  <div class="grid">
    <div class="card">
      <div class="card__header">
        <span class="card__name">05. Review Tab (Metrics &amp; Activity)</span>
        <span class="badge badge--blue">tab-review</span>
      </div>
      <div class="card__preview">
        <img src="${imgData['05_popup_review_audit_tab.png'] || ''}" alt="Review Tab Audit" />
      </div>
      <div class="card__body">
        <strong>Audit Metrics &amp; Activity Trail</strong>
        <span>Recent protection metrics cards (Findings detected, Protected, Pages scanned), Coverage checklist (Visible text, Images, Docs, OCR), and chronological activity history.</span>
        <div class="tag-row">
          <span class="tag">#review-findings-count</span>
          <span class="tag">#coverage-grid</span>
          <span class="tag">#activity-list</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card__header">
        <span class="card__name">13. About, Diagnostics &amp; Audit Trail</span>
        <span class="badge badge--blue">settings-page-about</span>
      </div>
      <div class="card__preview">
        <img src="${imgData['13_popup_settings_about_audit.png'] || ''}" alt="Settings About Audit" />
      </div>
      <div class="card__body">
        <strong>ECDSA Signed Audit Log Controls</strong>
        <span>6-engine operational diagnostics grid, "Export signed audit log" (JSONL + ECDSA P-256 signature), "Clear audit trail", and author/license disclosures.</span>
        <div class="tag-row">
          <span class="tag">#export-audit-btn</span>
          <span class="tag">#clear-audit-btn</span>
          <span class="tag">.diag-grid</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card__header">
        <span class="card__name">18. Clear Audit Trail Dialog</span>
        <span class="badge badge--blue">#clear-audit-dialog</span>
      </div>
      <div class="card__preview">
        <img src="${imgData['18_dialog_clear_audit.png'] || ''}" alt="Clear Audit Dialog" />
      </div>
      <div class="card__body">
        <strong>Audit Trail Deletion Confirmation</strong>
        <span>Permanent deletion confirmation dialog for audit records and signing keys stored in chrome.storage.local.</span>
        <div class="tag-row">
          <span class="tag">#clear-audit-confirm</span>
          <span class="tag">chrome.storage.local</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card__header">
        <span class="card__name">24. Review &amp; Audit (Side Panel)</span>
        <span class="badge badge--green">sidepanel-review</span>
      </div>
      <div class="card__preview">
        <img src="${imgData['24_sidepanel_review_audit.png'] || ''}" alt="Sidepanel Review Audit" />
      </div>
      <div class="card__body">
        <strong>Side Panel Audit View</strong>
        <span>Continuous audit metrics viewer in the side dock, reflecting live scan activity across active tabs without switching popup views.</span>
        <div class="tag-row">
          <span class="tag">sidepanel.html</span>
          <span class="tag">POPUP_STATE</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card__header">
        <span class="card__name">26. About &amp; Diagnostics (Side Panel)</span>
        <span class="badge badge--green">sidepanel-about</span>
      </div>
      <div class="card__preview">
        <img src="${imgData['26_sidepanel_settings_about.png'] || ''}" alt="Sidepanel About" />
      </div>
      <div class="card__body">
        <strong>Side Panel Operational Diagnostics</strong>
        <span>Complete operational diagnostics grid and audit export triggers accessible directly from the browser sidebar.</span>
        <div class="tag-row">
          <span class="tag">sidepanel.js</span>
          <span class="tag">POPUP_EXPORT_AUDIT</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card__header">
        <span class="card__name">19. Document Page-Window Chooser</span>
        <span class="badge badge--blue">#doc-window-dialog</span>
      </div>
      <div class="card__preview">
        <img src="${imgData['19_dialog_doc_page_window.png'] || ''}" alt="Page Window Dialog" />
      </div>
      <div class="card__body">
        <strong>Audited 20-Page Window Chooser</strong>
        <span>Prevents partial document misrepresentation. Lets user select an audited 20-page window for documents exceeding the single-pass processing cap.</span>
        <div class="tag-row">
          <span class="tag">#doc-window-dialog</span>
          <span class="tag">MAX_DOC_PAGES</span>
        </div>
      </div>
    </div>
  </div>

  <!-- 6. SIDE PANEL ARCHITECTURE -->
  <h2 class="section-title">6. Side Panel Surface (Persistent Browser Dock)</h2>
  <div class="grid">
    <div class="card">
      <div class="card__header">
        <span class="card__name">22. Side Panel: Protection View</span>
        <span class="badge badge--green">sidepanel.html</span>
      </div>
      <div class="card__preview">
        <img src="${imgData['22_sidepanel_protection.png'] || ''}" alt="Sidepanel Protection" />
      </div>
      <div class="card__body">
        <strong>Side Panel Main Interface</strong>
        <span>Vertical browser sidebar layout generated via scripts/sync-sidepanel.mjs. Maintains strict ID and functional parity with popup.html while adapting to full vertical dock.</span>
        <div class="tag-row">
          <span class="tag">chrome.sidePanel</span>
          <span class="tag">sync:sidepanel</span>
        </div>
      </div>
    </div>
  </div>

  <!-- 7. DEDICATED FULL-SCREEN WORKSPACES -->
  <h2 class="section-title">7. Dedicated Full-Screen Surfaces &amp; Documents</h2>
  <div class="grid grid--wide">
    <div class="card">
      <div class="card__header">
        <span class="card__name">27. Full-Screen Document Review Studio</span>
        <span class="badge badge--blue">review.html</span>
      </div>
      <div class="card__preview">
        <img src="${imgData['27_fullscreen_document_review.png'] || ''}" alt="Full-Screen Review" />
      </div>
      <div class="card__body">
        <strong>High-Resolution Canvas Review &amp; Drawing</strong>
        <span>Two-column desktop application. Left stage: native 100% resolution document page canvas with zoom controls. Right sidebar: findings list, manual bounding box drawing, redaction style selector, and Redact &amp; Download action.</span>
        <div class="tag-row">
          <span class="tag">review.html</span>
          <span class="tag">chrome.storage.session</span>
          <span class="tag">PAGE_IMAGE_MAX_EDGE</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card__header">
        <span class="card__name">28. Print &amp; PDF Flattened Redaction View</span>
        <span class="badge badge--green">redact.html</span>
      </div>
      <div class="card__preview">
        <img src="${imgData['28_print_pdf_redaction_view.png'] || ''}" alt="Print & PDF Redact View" />
      </div>
      <div class="card__body">
        <strong>Pixel-Verified Redaction Output Renderer</strong>
        <span>Pure renderer. Reads verified redacted pages from the local document store and triggers window.print(). Never redacts at print time to avoid unverified output reaching printers.</span>
        <div class="tag-row">
          <span class="tag">redact.html</span>
          <span class="tag">docStore.ts</span>
          <span class="tag">window.print()</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card__header">
        <span class="card__name">29. Landing Page</span>
        <span class="badge badge--blue">landing.html</span>
      </div>
      <div class="card__preview">
        <img src="${imgData['29_landing_page.png'] || ''}" alt="Landing Page" />
      </div>
      <div class="card__body">
        <strong>Architectural Showcase &amp; Zero-Egress Explainer</strong>
        <span>Complete architectural walkthrough, live terminal audit log illustration, compliance matrix, and security guarantees.</span>
        <div class="tag-row">
          <span class="tag">landing.html</span>
          <span class="tag">auditable-architecture</span>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card__header">
        <span class="card__name">30. Privacy Policy</span>
        <span class="badge badge--blue">privacy.html</span>
      </div>
      <div class="card__preview">
        <img src="${imgData['30_privacy_policy.png'] || ''}" alt="Privacy Policy" />
      </div>
      <div class="card__body">
        <strong>Local-First Legal Guarantees</strong>
        <span>Formal disclosure of zero data collection, CPU/GPU local execution, and optional site access mechanics.</span>
        <div class="tag-row">
          <span class="tag">privacy.html</span>
          <span class="tag">no-third-party-tracking</span>
        </div>
      </div>
    </div>
  </div>

  <!-- ARCHITECTURAL SUMMARY PANEL -->
  <div class="arch-panel">
    <h2>GovernWorld Architecture: Shared Components &amp; Popup-to-Side Panel Sync</h2>
    <div class="arch-grid">
      <div class="arch-box">
        <h3>1. Shared Components</h3>
        <ul class="check-list">
          <li><strong>Header Bar:</strong> Brand emblem (icons/icon-128.png), title, version tag, "LOCAL SHIELD" pill.</li>
          <li><strong>Tab Navigation:</strong> 4 root tabs (Protection, My Logic, Review, Settings) with exact aria-selected and data-tab attributes.</li>
          <li><strong>Settings Sub-Navigation:</strong> 8 sub-pages (Profile, Protection, Detection, Appearance, Notifications, Privacy, Advanced, About).</li>
          <li><strong>Findings List:</strong> Shared item layout with checkbox, severity tag, category badge, and text snippet.</li>
          <li><strong>Document Dropzone &amp; OCR Selector:</strong> Identical upload target and language options.</li>
          <li><strong>Modal Dialogs:</strong> Clear Audit, Document Window Chooser, Work Verification, Copy Redacted, and Rule Wizard.</li>
          <li><strong>Styling System:</strong> Byte-for-byte CSS parity between popup.css and sidepanel.css.</li>
        </ul>
      </div>

      <div class="arch-box">
        <h3>2. Popup-to-Side Panel Sync Mechanism</h3>
        <ul class="check-list">
          <li><strong>Automated Source Sync:</strong> <code>src/sidepanel/sidepanel.html</code> is deterministically generated from <code>src/popup/index.html</code> via <code>npm run sync:sidepanel</code>.</li>
          <li><strong>Live State Broadcasting:</strong> The background service worker broadcasts <code>POPUP_STATE</code> messages across all active extension views simultaneously.</li>
          <li><strong>Storage Reactivity:</strong> Changes to settings, custom logic, or site access write to <code>chrome.storage.local</code>; both popup and sidepanel listen to <code>chrome.storage.onChanged</code> for instant re-render.</li>
          <li><strong>Shared Session Store:</strong> Scan sessions live in <code>chrome.storage.session</code> (key <code>scan:&lt;tabId&gt;</code>), so focusing any tab renders the exact same findings in both popup and sidepanel.</li>
          <li><strong>Binary Store (IndexedDB):</strong> Heavy document buffers and page previews are referenced by key in IndexedDB (<code>gw-documents</code>), preventing message buffer limits.</li>
        </ul>
      </div>
    </div>
  </div>

</body>
</html>
`;

  writeFileSync(contactSheetHtmlPath, contactHtml, "utf8");
  console.log(`[GENERATED] ${contactSheetHtmlPath}`);

  // Now render the contact sheet HTML into 00_visual_contact_sheet.png using Playwright
  const contactPage = await context.newPage();
  await contactPage.setViewportSize({ width: 1920, height: 1080 });
  await contactPage.goto(`file:///${contactSheetHtmlPath.replace(/\\/g, "/")}`, { waitUntil: "load" });
  await contactPage.waitForTimeout(1000);
  await contactPage.screenshot({ path: contactSheetPngPath, fullPage: true });
  console.log(`[CAPTURED MASTER CONTACT SHEET] ${contactSheetPngPath}`);

  console.log("\n✓ SUCCESS: All screens reconstructed and visual contact sheet generated!");

} catch (err) {
  console.error("Error capturing screens:", err);
} finally {
  await context.close();
  server.close();
  rmSync(WORK, { recursive: true, force: true });
}
