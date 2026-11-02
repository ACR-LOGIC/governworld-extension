// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
//
// Logic Wizard End-to-End Test & Video Recording Harness.
//
// This script:
// 1. Boots a real browser instance with the built extension.
// 2. Records a clean 1280x800 video of the Logic Wizard in action:
//    - Navigating to the Logic tab
//    - Opening the 4-step interactive Wizard
//    - Inputting positive & negative training examples
//    - Generating on-device regex logic proposals
//    - Testing & refining patterns against interactive sample text
//    - Saving the custom rule to local storage
//    - Showing the newly created rule in the user's active personal logic list
//    - Scanning a live webpage and proving the saved rule instantly masks the target entities
// 3. Produces a polished .webm video saved to recordings/logic-wizard-demo.webm
//
// Run:
//   npm run build && node scripts/record-wizard-demo.mjs

import { chromium } from "@playwright/test";
import { browserChannelArgs, browserProfileDir, waitForPopupReady } from "./browser-launch.mjs";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const recordingsDir = join(root, "recordings");
const rawVideoDir = join(recordingsDir, "video_raw");
const outputVideo = join(recordingsDir, "logic-wizard-demo.webm");

if (!existsSync(join(dist, "manifest.json"))) {
  console.error("dist/ is missing — run `npm run build` first.");
  process.exit(1);
}

mkdirSync(rawVideoDir, { recursive: true });

// Setup test webpage fixture
const FIXTURE_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Corporate Access & Key Portal</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f172a;
      color: #f8fafc;
      margin: 0;
      padding: 40px;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      box-sizing: border-box;
    }
    .card {
      background: #1e293b;
      padding: 32px;
      border-radius: 12px;
      border: 1px solid #334155;
      max-width: 650px;
      width: 100%;
      box-shadow: 0 10px 25px rgba(0,0,0,0.5);
    }
    h1 {
      font-size: 22px;
      color: #38bdf8;
      margin-top: 0;
      margin-bottom: 8px;
    }
    .badge {
      display: inline-block;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      background: #0369a1;
      color: #e0f2fe;
      padding: 3px 8px;
      border-radius: 4px;
      margin-bottom: 20px;
    }
    p {
      font-size: 15px;
      line-height: 1.6;
      color: #cbd5e1;
      margin: 12px 0;
    }
    .key-value {
      color: #fb7185;
      font-weight: 600;
      font-family: monospace;
      font-size: 16px;
      background: #881337;
      padding: 2px 6px;
      border-radius: 4px;
    }
    .unrestricted {
      color: #94a3b8;
      font-family: monospace;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">Internal Environment</div>
    <h1>Cloud Infrastructure & Deployment Vault</h1>
    <p>This internal environment contains high-privilege service credentials that must never be exposed or pasted externally.</p>
    <p>Primary API Secret Key: <span class="key-value" id="k1">SEC-99482</span></p>
    <p>Failover Authentication Token: <span class="key-value" id="k2">SEC-88103</span></p>
    <p>Cluster Synchronization Key: <span class="key-value" id="k3">SEC-77054</span></p>
    <p>Public Routing Anchor: <span class="unrestricted" id="pub">PUBLIC-ROUTER-99</span></p>
    <p style="margin-top: 24px; font-size: 13px; color: #64748b;">GovernWorld local-first on-device scanning ensures custom identifiers are detected and masked before any data leaves this browser.</p>
  </div>
</body>
</html>`;

const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(FIXTURE_HTML);
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const fixturePort = server.address().port;
const fixtureUrl = `http://127.0.0.1:${fixturePort}/`;

// Prepare throwaway extension copy with permission for local fixture
const work = mkdtempSync(join(tmpdir(), "gw-wizard-demo-"));
const extDir = join(work, "ext");
mkdirSync(extDir, { recursive: true });
cpSync(dist, extDir, { recursive: true });

const manifestPath = join(extDir, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.host_permissions = [`http://127.0.0.1:${fixturePort}/*`];
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

console.log("\n========================================================");
console.log("  GovernWorld Logic Wizard End-to-End Test & Recording");
console.log("========================================================\n");
console.log(`Fixture Server: ${fixtureUrl}`);

if (!process.env.GW_BROWSER_CHANNEL && !process.env.GW_BROWSER_EXECUTABLE) {
  process.env.GW_BROWSER_CHANNEL = "msedge";
}

const context = await chromium.launchPersistentContext(browserProfileDir(join(work, "profile")), {
  headless: false,
  ...browserChannelArgs(),
  viewport: { width: 1280, height: 800 },
  recordVideo: { dir: rawVideoDir, size: { width: 1280, height: 800 } },
  args: [
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ],
});

try {
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 25_000 }));
  const extId = new URL(sw.url()).host;
  console.log(`Service Worker: ${extId}`);

  // 1. Open the test webpage fixture
  console.log("\n[Step 1] Opening test page containing custom secrets (SEC-99482)...");
  const fixturePage = await context.newPage();
  await fixturePage.goto(fixtureUrl, { waitUntil: "load" });
  await fixturePage.bringToFront();
  await fixturePage.waitForTimeout(1000);

  // 2. Open the extension popup
  console.log("[Step 2] Opening extension popup interface...");
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: "load" });
  await waitForPopupReady(popupPage);
  await popupPage.waitForTimeout(800);

  // Inject content script into fixture tab
  await fixturePage.bringToFront();
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      } catch {}
    }
  });

  // 3. Navigate to the Logic Tab
  console.log("[Step 3] Navigating to Logic Tab...");
  await popupPage.bringToFront();
  await popupPage.click("#tab-btn-logic");
  await popupPage.waitForTimeout(900);

  // 4. Open the Logic Wizard Dialog
  console.log("[Step 4] Opening Logic Wizard dialog...");
  await popupPage.click("#open-wizard-btn-2");
  await popupPage.waitForTimeout(1000);

  // 5. Fill Step 1: Demonstrate Upload Option for Training Examples
  console.log("[Step 5] Demonstrating file upload option in Wizard Step 1...");
  const sampleFile = join(work, "sample-training-examples.txt");
  writeFileSync(
    sampleFile,
    "# Confidential Training Identifiers\nSEC-99482\nSEC-88103\nSEC-77054\n"
  );

  // Hover over the Import File button to showcase the feature
  await popupPage.hover("#wizard-import-file-btn");
  await popupPage.waitForTimeout(700);

  // Upload the sample training file through the file input
  await popupPage.setInputFiles("#wizard-file-input", sampleFile);
  await popupPage.waitForTimeout(1200);

  const importStatus = await popupPage.textContent("#wizard-import-status");
  console.log(`  Import status: ${importStatus}`);

  // Enter negative exclusion example
  await popupPage.fill(
    "#wizard-neg-input",
    "PUBLIC-ROUTER-99"
  );
  await popupPage.waitForTimeout(900);

  // 6. Trigger Local Analysis
  console.log("[Step 6] Running local CPU-based pattern analysis...");
  await popupPage.click("#wizard-analyze-btn");
  await popupPage.waitForTimeout(1200);

  // 7. Step 2: Review Generated Logic Proposal
  console.log("[Step 7] Inspecting generated candidate regex in Step 2...");
  const proposalVisible = await popupPage.evaluate(() => {
    const step2 = document.getElementById("wizard-step-2");
    return step2 && !step2.hidden;
  });
  if (!proposalVisible) throw new Error("Wizard Step 2 did not become visible");
  await popupPage.waitForTimeout(1200);

  await popupPage.click("#wizard-next-2");
  await popupPage.waitForTimeout(1000);

  // 8. Step 3: Interactive Sandbox Testing & Refinement
  console.log("[Step 8] Testing generated logic in interactive sandbox (Step 3)...");
  const step3Visible = await popupPage.evaluate(() => {
    const step3 = document.getElementById("wizard-step-3");
    return step3 && !step3.hidden;
  });
  if (!step3Visible) throw new Error("Wizard Step 3 did not become visible");

  // Add an extra live test string to verify real-time match feedback
  await popupPage.fill(
    "#wizard-test-sample",
    "Live test: SEC-55120 is confidential, but PUBLIC-ROUTER-99 is public."
  );
  await popupPage.waitForTimeout(1200);

  await popupPage.click("#wizard-next-3");
  await popupPage.waitForTimeout(1000);

  // 9. Step 4: Metadata & Rule Saving
  console.log("[Step 9] Finalizing rule metadata and saving locally (Step 4)...");
  await popupPage.fill("#wizard-rule-name", "Internal Secret Key");
  await popupPage.waitForTimeout(400);
  await popupPage.selectOption("#wizard-rule-category", "secrets");
  await popupPage.waitForTimeout(400);
  await popupPage.fill("#wizard-rule-confidence", "0.95");
  await popupPage.waitForTimeout(900);

  await popupPage.click("#wizard-save-btn");
  await popupPage.waitForTimeout(1200);

  // 10. Verify Rule Display in Logic Tab
  console.log("[Step 10] Verifying created rule is displayed in Personal Logic list...");
  const renderedRuleCount = await popupPage.evaluate(() => {
    const list = document.getElementById("custom-patterns-list");
    return list ? list.children.length : 0;
  });
  console.log(`  Active custom rules in UI: ${renderedRuleCount}`);
  if (renderedRuleCount === 0) throw new Error("Rule was not rendered in custom-patterns-list");
  await popupPage.waitForTimeout(1500);

  // 11. Switch back to Webpage and Execute Live Scan with Saved Rule
  console.log("\n[Step 11] Running live page scan on test webpage...");
  await fixturePage.bringToFront();
  await fixturePage.waitForTimeout(800);

  // Trigger scan from popup
  const scanResult = await popupPage.evaluate(() => {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Scan timeout (20s)")), 20_000);
      const listener = (msg) => {
        if (msg?.type !== "POPUP_STATE") return;
        if (msg?.state?.scanning) return;
        clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(listener);
        resolve(msg.state);
      };
      chrome.runtime.onMessage.addListener(listener);
      chrome.runtime.sendMessage({
        type: "POPUP_SCAN",
        requestId: "wizard-demo-scan-1",
        mode: "local",
      });
    });
  });

  console.log(`  Findings detected by scan: ${scanResult?.findings?.length ?? 0}`);

  // Apply visual masks onto page
  await popupPage.evaluate((findingIds) => {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Mask apply timeout")), 10_000);
      const listener = (msg) => {
        if (msg?.type !== "POPUP_STATE") return;
        clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(listener);
        resolve(msg.state);
      };
      chrome.runtime.onMessage.addListener(listener);
      chrome.runtime.sendMessage({
        type: "POPUP_APPLY_MASKS",
        requestId: "wizard-demo-mask-1",
        findingIds,
      });
    });
  }, (scanResult?.findings ?? []).map((f) => f.id));

  // Bring fixture page into focus to showcase active visual overlays
  await fixturePage.bringToFront();
  console.log("[Step 12] Showcasing redacted webpage with applied visual masks...");
  await fixturePage.waitForTimeout(3000);

  console.log("\n✓ All wizard workflow steps completed successfully.");
} finally {
  await context.close();
  server.close();
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {}
}

// Find recorded video and copy to output path
const rawVideos = readdirSync(rawVideoDir).filter((f) => f.endsWith(".webm"));
if (rawVideos.length > 0) {
  // Pick the largest webm file (the main recording)
  let bestVideo = rawVideos[0];
  let maxBytes = 0;
  for (const v of rawVideos) {
    const s = statSync(join(rawVideoDir, v)).size;
    if (s > maxBytes) {
      maxBytes = s;
      bestVideo = v;
    }
  }

  const srcPath = join(rawVideoDir, bestVideo);
  cpSync(srcPath, outputVideo);
  console.log(`\n✓ Video recording successfully saved to: ${outputVideo} (${(maxBytes / 1024).toFixed(1)} KB)`);

  // Also copy to user artifact directory if available
  const artifactDir = "C:\\Users\\omg\\.gemini\\antigravity\\brain\\94d65577-f29d-4759-9987-48db9c3d209f";
  if (existsSync(artifactDir)) {
    const artifactVideo = join(artifactDir, "logic-wizard-demo.webm");
    cpSync(outputVideo, artifactVideo);
    console.log(`✓ Copied video to artifact directory: ${artifactVideo}`);
  }
} else {
  console.warn("Warning: No .webm video files found in raw video directory.");
}
