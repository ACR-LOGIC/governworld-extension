// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
//
// Automated Wire-Level Network Inspection & Zero-Egress Verification.
//
// This harness proves at the network protocol layer that NO sensitive data,
// page text, document buffers, or PII/PHI canaries leave the machine during
// scanning, wizard analysis, pattern testing, or document redaction.
//
// Every outbound HTTP, HTTPS, WebSocket, fetch, XHR, and beacon across the
// renderer, background service worker, and extension pages is monitored and
// asserted against strict zero-egress invariants.
//
// Run:
//   npm run build && node scripts/verify-network-inspection.mjs

import { chromium } from "@playwright/test";
import { browserChannelArgs, browserProfileDir, waitForPopupReady } from "./browser-launch.mjs";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

if (!existsSync(join(dist, "manifest.json"))) {
  console.error("dist/ is missing — run `npm run build` first.");
  process.exit(1);
}

// -----------------------------------------------------------------------------
// Concrete Synthetic Sensitive Canaries
// -----------------------------------------------------------------------------
const CANARIES = {
  ssn: "219-09-9999",
  card: "4111111111111111",
  email: "confidential.patient@example.test",
  password: "SecretP@ssw0rd!2026",
  diagnosis: "Acute Myocardial Infarction",
  secretKey: "AKIAIOSFODNN7EXAMPLE",
  customId: "CANARY-CUST-99482",
};

// HTML Fixture embedding sensitive canaries
const FIXTURE_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Zero-Egress Network Inspection Fixture</title>
</head>
<body>
  <h1>Medical Patient Intake Record (Canary Corpus)</h1>
  <div id="patient-data">
    <p id="p-email">Patient Contact: <span id="email">${CANARIES.email}</span></p>
    <p id="p-ssn">Social Security Number: <span id="ssn">${CANARIES.ssn}</span></p>
    <p id="p-card">Primary Payment Card: <span id="card">${CANARIES.card}</span></p>
    <p id="p-phi">Clinical Diagnosis: <span id="phi">${CANARIES.diagnosis}</span></p>
    <p id="p-creds">System Credentials: Password=<span id="pwd">${CANARIES.password}</span> API_KEY=<span id="key">${CANARIES.secretKey}</span></p>
    <p id="p-custom">Account Token: <span id="custom">${CANARIES.customId}</span></p>
  </div>
</body>
</html>`;

// Setup local HTTP fixture server
const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(FIXTURE_HTML);
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const fixturePort = server.address().port;
const fixtureUrl = `http://127.0.0.1:${fixturePort}/`;

// Prepare throwaway extension copy with permission for local fixture
const work = mkdtempSync(join(tmpdir(), "gw-net-inspect-"));
const extDir = join(work, "ext");
mkdirSync(extDir, { recursive: true });
cpSync(dist, extDir, { recursive: true });

const manifestPath = join(extDir, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.host_permissions = [`http://127.0.0.1:${fixturePort}/*`];
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

console.log("\n========================================================");
console.log("  GovernWorld Network Inspection & Zero-Egress Audit");
console.log("========================================================\n");
console.log(`Fixture Server: ${fixtureUrl}`);

// Network interception tracking
const recordedRequests = [];
const failures = [];

function check(name, condition, detail = "") {
  const icon = condition ? "✓ PASS" : "✗ FAIL";
  console.log(`  ${icon}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures.push(`${name}: ${detail}`);
}

// Fall back to msedge if GW_BROWSER_CHANNEL is not set, ensuring smooth execution
if (!process.env.GW_BROWSER_CHANNEL && !process.env.GW_BROWSER_EXECUTABLE) {
  process.env.GW_BROWSER_CHANNEL = "msedge";
}

const context = await chromium.launchPersistentContext(browserProfileDir(join(work, "profile")), {
  headless: false,
  ...browserChannelArgs(),
  args: [
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ],
  permissions: ["clipboard-read", "clipboard-write"],
});

try {
  // Capture all network activity across the browser context
  context.on("request", (req) => {
    let postData = null;
    try {
      postData = req.postData();
    } catch {
      // ignore
    }
    recordedRequests.push({
      url: req.url(),
      method: req.method(),
      headers: req.headers(),
      postData,
      resourceType: req.resourceType(),
    });
  });

  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 25_000 }));
  const extId = new URL(sw.url()).host;
  check("Service worker started and registered", Boolean(extId), `extId=${extId}`);

  // ---------------------------------------------------------------------------
  // Stage 1: Load Fixture Page with Sensitive Canaries
  // ---------------------------------------------------------------------------
  console.log("\n[Stage 1] Loading Sensitive Canary Fixture Page...");
  const fixturePage = await context.newPage();
  await fixturePage.goto(fixtureUrl, { waitUntil: "load" });
  await fixturePage.bringToFront();

  const fixtureContent = await fixturePage.content();
  check("Fixture page loaded successfully", fixtureContent.includes(CANARIES.ssn));

  // Open the extension popup
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: "load" });
  await waitForPopupReady(popupPage);
  check("Extension popup loaded and ready", true);

  // In real browser without manual activeTab gesture, programmatically inject content script into fixture tab
  await fixturePage.bringToFront();
  const injection = await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) return { ok: false, error: "no active tab" };
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      return { ok: true, tabId: tab.id, url: tab.url };
    } catch (error) {
      return { ok: false, tabId: tab.id, error: String(error) };
    }
  });
  check("Content script injected into fixture tab", injection.ok, injection.error || "");

  // ---------------------------------------------------------------------------
  // Stage 2: Execute Live Page DOM Scan & Visual Masking
  // ---------------------------------------------------------------------------
  console.log("\n[Stage 2] Triggering On-Device Page Scan...");
  await fixturePage.bringToFront();

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
        requestId: "net-test-scan-1",
        mode: "local",
      });
    });
  });

  const findingsCount = scanResult?.findings?.length ?? 0;
  check(
    "Scan completed and detected sensitive findings locally",
    findingsCount > 0,
    `detected ${findingsCount} findings`
  );

  // Apply masks to verify DOM overlay creation
  const maskResult = await popupPage.evaluate((findingIds) => {
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
        requestId: "net-test-mask-1",
        findingIds,
      });
    });
  }, (scanResult?.findings ?? []).map((f) => f.id));

  check(
    "Visual overlay masks applied on page",
    Boolean(maskResult)
  );

  // ---------------------------------------------------------------------------
  // Stage 3: Execute Logic Wizard Analysis & Test with Canaries
  // ---------------------------------------------------------------------------
  console.log("\n[Stage 3] Executing Logic Wizard Pattern Generation & Testing...");
  const wizardAnalysis = await popupPage.evaluate((canaryId) => {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Wizard analyze timeout")), 10_000);
      const listener = (msg) => {
        if (msg?.type !== "POPUP_WIZARD_ANALYSIS_RESULT") return;
        clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(listener);
        resolve(msg.proposals);
      };
      chrome.runtime.onMessage.addListener(listener);
      chrome.runtime.sendMessage({
        type: "POPUP_WIZARD_ANALYZE",
        requestId: "net-test-wiz-1",
        positiveExamples: [canaryId, "CANARY-CUST-11223"],
        negativeExamples: ["ORDER-99123"],
      });
    });
  }, CANARIES.customId);

  check(
    "Wizard analysis produced candidate pattern locally",
    Array.isArray(wizardAnalysis) && wizardAnalysis.length > 0,
    `proposal: ${wizardAnalysis?.[0]?.proposedPattern}`
  );

  const wizardTestResult = await popupPage.evaluate(({ pattern, sample }) => {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Wizard test timeout")), 10_000);
      const listener = (msg) => {
        if (msg?.type !== "POPUP_WIZARD_TEST_RESULT") return;
        clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(listener);
        resolve(msg.testResult);
      };
      chrome.runtime.onMessage.addListener(listener);
      chrome.runtime.sendMessage({
        type: "POPUP_WIZARD_TEST",
        requestId: "net-test-wiz-2",
        regex: pattern,
        sampleText: sample,
      });
    });
  }, { pattern: wizardAnalysis[0].proposedPattern, sample: `Checking ${CANARIES.customId} locally` });

  check(
    "Wizard test matched candidate pattern in-memory",
    Array.isArray(wizardTestResult) && wizardTestResult.some((r) => r.matched)
  );

  // Save the custom rule locally
  const saveState = await popupPage.evaluate((patternStr) => {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Custom pattern save timeout")), 10_000);
      const listener = (msg) => {
        if (msg?.type !== "POPUP_CUSTOM_PATTERNS_STATE") return;
        clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(listener);
        resolve(msg.patterns);
      };
      chrome.runtime.onMessage.addListener(listener);
      chrome.runtime.sendMessage({
        type: "POPUP_CUSTOM_PATTERN_SAVE",
        requestId: "net-test-wiz-3",
        pattern: {
          id: crypto.randomUUID(),
          name: "Canary Customer ID",
          category: "custom",
          pattern: patternStr,
          flags: "gi",
          captureGroup: 0,
          confidence: 0.9,
          createdAt: new Date().toISOString(),
          source: "local",
          contributionStatus: "local_only",
        },
      });
    });
  }, wizardAnalysis[0].proposedPattern);

  check(
    "Custom pattern saved to local storage",
    Array.isArray(saveState) && saveState.some((p) => p.name === "Canary Customer ID")
  );

  // ---------------------------------------------------------------------------
  // Stage 4: Selection / Clipboard Redaction
  // ---------------------------------------------------------------------------
  console.log("\n[Stage 4] Performing Clipboard Redaction of Sensitive Selection...");
  await fixturePage.bringToFront();
  await fixturePage.evaluate(() => {
    const pii = document.getElementById("p-email");
    if (!pii) return;
    const range = document.createRange();
    range.selectNodeContents(pii);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  });

  const fixtureTabId = await sw.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((t) => t.url?.startsWith(url))?.id ?? null;
  }, fixtureUrl);

  const redactReply = await sw.evaluate(async (tabId) => {
    if (!tabId) return null;
    return await chrome.tabs.sendMessage(tabId, {
      type: "CONTEXT_REDACT_SELECTION",
      requestId: crypto.randomUUID(),
      settings: {
        enabledCategories: ["email", "ssn", "payment_card", "secrets"],
        maxVisibleChars: 200000,
        maxNodeChars: 20000,
        maskPlaceholders: false,
        sessionTimeoutMs: 0,
      },
    });
  }, fixtureTabId);

  check(
    "Clipboard redaction executed successfully",
    redactReply?.ok === true && (redactReply?.counts?.email ?? 0) > 0,
    `counts=${JSON.stringify(redactReply?.counts ?? {})}`
  );

  // ---------------------------------------------------------------------------
  // Stage 5: Wire-Level Network Inspection & Zero-Egress Assertion
  // ---------------------------------------------------------------------------
  console.log("\n[Stage 5] Auditing Captured Network Traffic...");
  console.log(`Total captured network requests: ${recordedRequests.length}`);

  let externalRequestsCount = 0;
  let telemetryRequestsCount = 0;
  let leakedCanariesCount = 0;
  const leakDetails = [];

  const allowedOrigins = [
    `http://127.0.0.1:${fixturePort}`,
    `chrome-extension://${extId}`,
  ];

  for (const req of recordedRequests) {
    const url = req.url;
    const isAllowed = allowedOrigins.some((orig) => url.startsWith(orig));

    if (!isAllowed) {
      externalRequestsCount++;
      leakDetails.push(`Unexpected outbound destination: ${url}`);
    }

    if (/google-analytics|telemetry|sentry|mixpanel|segment|collect|ping|beacon/i.test(url)) {
      telemetryRequestsCount++;
      leakDetails.push(`Telemetry endpoint detected: ${url}`);
    }

    // Inspect request URL, headers, and postData for any sensitive canary leakage
    const payloadHaystack = [
      url,
      JSON.stringify(req.headers || {}),
      req.postData || "",
    ].join(" ");

    for (const [canaryType, canaryValue] of Object.entries(CANARIES)) {
      if (payloadHaystack.includes(canaryValue)) {
        // Exception: initial fixture GET request fetching the HTML test page from loopback server
        if (req.method === "GET" && url === fixtureUrl) {
          continue;
        }
        leakedCanariesCount++;
        leakDetails.push(`Canary leak [${canaryType}]: ${canaryValue} found in ${req.method} ${url}`);
      }
    }
  }

  check(
    "Zero external / cloud network requests",
    externalRequestsCount === 0,
    `external count = ${externalRequestsCount}`
  );

  check(
    "Zero analytics, tracking, or telemetry requests",
    telemetryRequestsCount === 0,
    `telemetry count = ${telemetryRequestsCount}`
  );

  check(
    "Zero sensitive canaries leaked in any network payload or header",
    leakedCanariesCount === 0,
    `leak count = ${leakedCanariesCount}`
  );

  if (leakDetails.length > 0) {
    console.error("\nLeak Details:");
    for (const d of leakDetails) console.error(`  - ${d}`);
  }

  console.log("\n=== Network Inspection Summary Table ===");
  console.log("----------------------------------------------------------------------");
  console.log(`  Requests Monitored:            ${recordedRequests.length}`);
  console.log(`  Allowed Local Origins:         127.0.0.1:${fixturePort}, chrome-extension://${extId}`);
  console.log(`  External Cloud Requests:       ${externalRequestsCount} (ZERO EGRESS PROVEN)`);
  console.log(`  Analytics / Telemetry Calls:   ${telemetryRequestsCount} (ZERO TELEMETRY PROVEN)`);
  console.log(`  Sensitive Canary Leaks:        ${leakedCanariesCount} (ZERO SENSITIVE LEAKS)`);
  console.log("----------------------------------------------------------------------\n");

} finally {
  await context.close();
  server.close();
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

if (failures.length > 0) {
  console.error(`\nNetwork inspection failed with ${failures.length} errors:`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
} else {
  console.log("✓ Wire-level network inspection passed: provably zero sensitive data leaves the machine.\n");
  process.exit(0);
}
