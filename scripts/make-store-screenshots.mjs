// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
//
// Chrome Web Store screenshot generation.
//
// The store requires "at least one 1280x800 px screenshot, up to 5 total"
// (https://developer.chrome.com/docs/webstore/cws-dashboard-listing). The UI
// walkthrough in capture-ui-session.mjs is deliberately not reusable for that:
// it shoots fullPage at a 1280x900 viewport, so any surface that overflows gains
// a scrollbar and captures at 1265px wide, which the store will reject. This
// script shoots a fixed 1280x800 viewport with fullPage disabled, then verifies
// every emitted PNG's real pixel dimensions before declaring success.
//
// Fixtures are synthetic by construction (tests/fixtures/), so no real PII can
// reach a listing asset. Nothing here touches the real site or a user account.
//
//   npm run capture:store      # needs a display (headless: false)
//
// Output: release/screenshots/*.png
import { chromium } from "@playwright/test";
import { browserChannelArgs, browserProfileDir, waitForPopupReady } from "./browser-launch.mjs";
import { createServer } from "node:http";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = join(root, "dist");
const fixtures = join(root, "tests", "fixtures");
const WORK = join(root, ".tmp-store-shots");
const EXT = join(WORK, "ext");
const OUT = join(root, "release", "screenshots");

// The store's exact requirement. Emitted images are verified against this.
const W = 1280;
const H = 800;
const MAX_SHOTS = 5;
const PORT = 8082;
const ORIGIN = `http://localhost:${PORT}`;

if (!existsSync(join(dist, "manifest.json"))) {
  console.error("dist/manifest.json missing - run `npm run build` first.");
  process.exit(1);
}

rmSync(WORK, { recursive: true, force: true });
rmSync(OUT, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
mkdirSync(OUT, { recursive: true });

// Same constraint as the walkthrough: dist/ ships with no host permissions
// because activeTab needs a real toolbar gesture. Load a throwaway copy that
// adds a localhost-only permission. dist/ is never modified.
cpSync(dist, EXT, { recursive: true });
const manifestPath = join(EXT, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.host_permissions) {
  console.error("refusing to run: dist/manifest.json already has host_permissions");
  process.exit(1);
}
manifest.host_permissions = [`${ORIGIN}/*`];
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

const MIME = { ".html": "text/html; charset=utf-8", ".png": "image/png", ".pdf": "application/pdf" };
const server = createServer((req, res) => {
  const name = decodeURIComponent((req.url ?? "/").replace(/^\/+/, "")) || "page.html";
  const file = join(fixtures, name);
  if (!file.startsWith(fixtures) || !existsSync(file)) return void res.writeHead(404).end("not found");
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
const FIXTURE = `${ORIGIN}/page.html`;

/** Read real pixel dimensions from a PNG IHDR, so the check cannot lie. */
function pngSize(file) {
  const b = readFileSync(file);
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

const emitted = [];
async function shoot(page, name, note) {
  const file = join(OUT, `${name}.png`);
  // fullPage MUST stay false. It is what produced 1265px-wide captures before.
  await page.screenshot({ path: file, fullPage: false });
  const size = pngSize(file);
  if (!size) throw new Error(`${name}: not a PNG`);
  if (size.w !== W || size.h !== H) {
    throw new Error(`${name}: ${size.w}x${size.h}, store requires ${W}x${H}`);
  }
  emitted.push({ name, note, ...size });
  console.log(`  [ok] ${name} ${size.w}x${size.h}  ${note}`);
}

const PROFILE = browserProfileDir(join(WORK, `profile-${Date.now()}`));
const context = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  ...browserChannelArgs(),
  viewport: { width: W, height: H },
  acceptDownloads: true,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    "--no-first-run",
    "--no-default-browser-check",
  ],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 30_000 }));
  const extensionId = new URL(worker.url()).host;
  const sidepanelUrl = `chrome-extension://${extensionId}/sidepanel.html`;
  console.log(`extension id: ${extensionId}\nfixture: ${FIXTURE}\noutput: ${OUT}\n`);

  // The fixture must be the focused tab: POPUP_SCAN resolves the browser's active
  // tab, so a real page scan only works while the page is in front.
  const fixture = await context.newPage();
  await fixture.goto(FIXTURE, { waitUntil: "load" });
  await fixture.bringToFront();
  await sleep(400);

  // The content script is normally injected by an activeTab grant, which only a
  // real toolbar click produces. Automation cannot synthesise that gesture, so
  // inject it from the worker first — the same route the UI walkthrough takes.
  const injection = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) return { ok: false, error: "no active tab" };
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      return { ok: true, tabId: tab.id, url: tab.url };
    } catch (error) {
      return { ok: false, tabId: tab.id, error: String(error) };
    }
  });
  if (!injection?.ok) throw new Error(`content script injection failed: ${injection?.error}`);

  // Open sidepanel.html so the fluid responsive layout fills 1280x800 cleanly
  // without trapping #doc-file-input into chrome.sidePanel.open().
  const popup = await context.newPage();
  await popup.goto(sidepanelUrl, { waitUntil: "load" });
  await waitForPopupReady(popup);
  await sleep(500);

  const click = (sel) =>
    popup.$eval(sel, (el) => {
      if (!(el instanceof HTMLElement) || el.hasAttribute("disabled")) return false;
      el.click();
      return true;
    });

  /**
   * Close any modal still blocking pointer events. The one-time accuracy notice
   * ("please verify your work") raises after the first scan and is a real dialog
   * element, so a driver-level click on a tab underneath it times out.
   */
  const clearModals = async () => {
    const open = await popup.$$eval("dialog[open]", (ds) => ds.map((d) => d.id));
    for (const id of open) {
      const btn = await popup.$(`#${id} [id^="verify-"], #${id} [id$="-cancel"]`);
      if (btn) await btn.click().catch(() => undefined);
      await popup
        .$eval(`#${id}`, (d) => (d.open ? d.close() : undefined))
        .catch(() => undefined);
      await sleep(250);
    }
  };

  // 1. Landing surface: the redesigned Protection tab in standalone LOCAL mode.
  await fixture.bringToFront();
  await sleep(250);
  await shoot(popup, "01-protection-idle", "Redesigned Protection surface: standalone LOCAL mode, live status strip, Scan & Document Studio");

  // 2. Page scan -> Compliance Risk Scorecard & findings with masked previews (unobstructed).
  if (!(await click("#scan-btn"))) throw new Error("#scan-btn missing or disabled");
  for (let i = 0; i < 120 && (await popup.evaluate(() => document.querySelectorAll("#findings-list .finding").length)) === 0; i++) {
    await sleep(500);
  }
  await sleep(900);
  await clearModals();
  const rows = await popup.evaluate(() => document.querySelectorAll("#findings-list .finding").length);
  if (rows === 0) throw new Error("no findings rendered; cannot build a findings screenshot");
  await popup.evaluate(() => {
    document.getElementById("results-section")?.scrollIntoView({ block: "start" });
  });
  await sleep(400);
  await shoot(popup, "02-findings-masked", `${rows} findings with Compliance Risk Scorecard and masked previews before applying masks`);

  // 3. Masks applied to the page itself.
  await fixture.bringToFront();
  await sleep(250);
  await click("#apply-masks-btn");
  await sleep(800);
  await fixture.bringToFront();
  // The scan overlay lives inside a closed shadow root (mode: "closed") so page
  // JS cannot enumerate masked coordinates. Verify the light-DOM host exists and
  // confirm the worker recorded applied masks in the tab's session maskHistory.
  const hasOverlayHost = await fixture.evaluate(() => Boolean(document.querySelector("div[data-gw-scan-overlay]")));
  if (!hasOverlayHost) throw new Error("scan overlay host is absent from the page");
  let appliedMasks = 0;
  for (let i = 0; i < 20; i++) {
    appliedMasks = await worker.evaluate(async () => {
      const all = await chrome.storage.session.get(null);
      for (const value of Object.values(all)) {
        const history = value?.maskHistory;
        if (Array.isArray(history) && history.length > 0) {
          const latest = history[history.length - 1];
          if (Array.isArray(latest) && latest.length > 0) return latest.length;
        }
      }
      return 0;
    });
    if (appliedMasks > 0) break;
    await sleep(250);
  }
  if (appliedMasks === 0) throw new Error("no mask elements were recorded in session maskHistory");
  await sleep(500);
  await shoot(fixture, "03-page-masks-applied", `${appliedMasks} overlay masks drawn on the page (closed shadow DOM; source page unmodified)`);

  // 4. Document studio + full-screen Document Review on an image.
  await clearModals();
  await popup.bringToFront();
  await sleep(400);
  await popup.click("#tab-btn-protection");
  await sleep(600);

  // The worker purges staged files on chrome.runtime.onInstalled, which can race
  // the first write on a fresh profile. Retry once, as the UI walkthrough does.
  let opened = false;
  let status = "";
  for (let attempt = 1; attempt <= 2 && !opened; attempt++) {
    await popup.setInputFiles("#doc-file-input", join(fixtures, "photo-pii.png"));
    try {
      await popup.waitForSelector("#doc-workspace:not([hidden])", { timeout: 180_000 });
      opened = true;
    } catch {
      status = await popup.$eval("#doc-status", (el) => el.textContent ?? "").catch(() => "");
      console.log(`  attempt ${attempt}: studio did not open (status: "${status}")`);
      await sleep(2500);
    }
  }
  if (!opened) throw new Error(`document studio never opened; last status: "${status}"`);

  // Detection runs after the workspace opens, so wait for a non-zero count rather
  // than for the workspace alone: the element starts at "0".
  const docCount = await popup
    .waitForFunction(
      () => {
        const raw = (document.getElementById("doc-findings-count")?.textContent ?? "").trim();
        const n = Number.parseInt(raw, 10);
        return Number.isFinite(n) && n > 0 ? raw : false;
      },
      null,
      { timeout: 180_000 },
    )
    .then(() => popup.evaluate(() => document.getElementById("doc-findings-count")?.textContent?.trim() ?? ""))
    .catch(() => "");
  if (!docCount) throw new Error("document studio opened but detected no findings");
  await sleep(1200);

  // Open full-screen review page (review.html) to showcase full-resolution document review.
  let reviewPage = null;
  try {
    const pagePromise = context.waitForEvent("page", { timeout: 15_000 });
    await click("#doc-open-review-btn");
    const candidate = await pagePromise;
    await candidate.waitForLoadState("load");
    if (candidate.url().includes("review.html")) {
      await candidate.waitForFunction(
        () =>
          document.querySelectorAll("#pages canvas").length > 0 &&
          document.querySelectorAll("#findings li").length > 0,
        null,
        { timeout: 30_000 },
      );
      await candidate.bringToFront();
      await sleep(1200);
      reviewPage = candidate;
    }
  } catch {
    reviewPage = null;
  }

  if (reviewPage) {
    await shoot(
      reviewPage,
      "04-document-studio",
      `Full-screen Document Review: local OCR (${docCount}) on a synthetic medical image`,
    );
    await reviewPage.close().catch(() => {});
  } else {
    await popup.evaluate(() => {
      const w = document.getElementById("doc-workspace");
      w?.scrollIntoView({ block: "start" });
    });
    await sleep(600);
    await shoot(popup, "04-document-studio", `Document review: local OCR found ${docCount} on an image`);
  }

  // 5. Settings / About: responsive 2-column layout, BSL 1.1 licence credits & sponsorship card.
  await popup.bringToFront();
  await clearModals();
  await popup.click("#tab-btn-settings");
  await sleep(500);
  await popup.click('[data-settings-page="about"]');
  await sleep(500);
  await popup.evaluate(() => {
    const credits = document.getElementById("about-credits-details");
    const contrib = document.getElementById("contributions-details");
    const guides = document.getElementById("about-guides-details");
    if (credits) credits.setAttribute("open", "");
    if (contrib) contrib.setAttribute("open", "");
    if (guides) guides.removeAttribute("open");
    if (contrib) {
      const rect = contrib.getBoundingClientRect();
      const targetBottom = rect.bottom + window.scrollY + 18;
      window.scrollTo(0, Math.max(0, targetBottom - window.innerHeight));
    }
  });
  await sleep(500);
  await shoot(popup, "05-settings-about", "Settings / About: diagnostics, legal links, BSL 1.1 credits & sponsorship support");

  if (emitted.length > MAX_SHOTS) {
    throw new Error(`${emitted.length} screenshots emitted; the store accepts at most ${MAX_SHOTS}`);
  }
  if (emitted.length < 1) throw new Error("no screenshots produced");

  writeFileSync(
    join(OUT, "NOTES.md"),
    [
      "# Store screenshot notes",
      "",
      "Generated by `npm run capture:store`. Every image is verified to be",
      `exactly ${W}x${H} px, which is the Chrome Web Store requirement`,
      "(https://developer.chrome.com/docs/webstore/cws-dashboard-listing).",
      "",
      "All content is synthetic: it comes from `tests/fixtures/`, which uses RFC 2606",
      "`.test` domains, a never-issued SSN, and a documented test card. No real PII,",
      "no browser chrome, and no real user data appear in these images.",
      "",
      ...emitted.map((s, i) => `${i + 1}. **${s.name}.png** (${s.w}x${s.h}) — ${s.note}`),
      "",
    ].join("\n"),
  );

  console.log(`\nwrote ${emitted.length} screenshot(s) to ${OUT} (all ${W}x${H})`);
  console.log("NEXT: these are upload candidates only. Nothing was uploaded.");
} finally {
  await context.close().catch(() => {});
  server.close();
  rmSync(WORK, { recursive: true, force: true });
}
