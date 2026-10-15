// Guards the "scan found nothing" report.
//
// A page that IS an image (a letterhead scan, a rendered PDF, a screenshot) has
// no text nodes, so the content script legitimately extracts 0 characters. The
// popup used to report that as "Completed securely on-device" - a clean bill of
// health for a document full of PII - which is the single most misleading thing
// this extension can say to a user.
import { chromium } from "playwright";
import { browserChannelArgs, browserProfileDir, waitForPopupReady } from "./browser-launch.mjs";
import { mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "gw-notfext-"));
const png = readFileSync(join(root, "tests", "fixtures", "photo-pii.png"));

// Page 1 is a bare image: no text nodes at all. Page 2 is ordinary HTML text
// containing a synthetic SSN, so the "nothing found" branch must NOT trigger.
const htmlImage = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">
<img src="/letter.png" style="width:900px"></body></html>`;
const htmlText = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<p>Test record for QA only. SSN 219-09-9999 and card 4111111111111111.</p></body></html>`;

const server = createServer((req, res) => {
  if (req.url === "/letter.png") {
    res.writeHead(200, { "content-type": "image/png" });
    res.end(png);
  } else if (req.url === "/text.html") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(htmlText);
  } else {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(htmlImage);
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

// dist ships with no host_permissions by design; this harness adds a
// localhost-only entry to a throwaway copy, exactly as capture:ui does.
const extDir = join(work, "ext");
rmSync(extDir, { recursive: true, force: true });
mkdirSync(extDir, { recursive: true });
cpSync(join(root, "dist"), extDir, { recursive: true });
const mp = join(extDir, "manifest.json");
const manifest = JSON.parse(readFileSync(mp, "utf8"));
if (manifest.host_permissions?.length) {
  console.error("dist/ ships with host_permissions; aborting rather than testing a different build");
  process.exit(1);
}
manifest.host_permissions = [`http://127.0.0.1:${port}/*`];
writeFileSync(mp, JSON.stringify(manifest, null, 2));

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

const context = await chromium.launchPersistentContext(browserProfileDir(join(work, "profile")), {
  headless: false,
  ...browserChannelArgs(),
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--no-first-run"],
});
let sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 20_000 }));
const extId = new URL(sw.url()).host;

const page = await context.newPage();
const popup = await context.newPage();

const readStatus = () =>
  popup.evaluate(() => {
    const s = document.getElementById("status");
    return {
      text: (s?.textContent || "").trim().replace(/\s+/g, " "),
      isError: s?.classList.contains("status--error") ?? false,
    };
  });

/**
 * The coverage verdict. It used to be five hardcoded green ticks in the markup
 * that no code ever changed, so a page with a cross-origin frame, a DRM video
 * or no readable text at all displayed the same all-clear panel as a clean
 * scan. This reads what the panel actually says now.
 */
const readCoverage = () =>
  popup.evaluate(() => {
    const c = document.getElementById("coverage-status");
    return {
      hidden: c?.hidden ?? true,
      text: (c?.textContent || "").trim().replace(/\s+/g, " "),
      tone: c?.getAttribute("data-tone") ?? null,
    };
  });

async function scan(url) {
  await page.goto(url);
  await page.waitForTimeout(600);
  // The worker scans the ACTIVE tab, so the fixture must be in front.
  await page.bringToFront();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  // initPopup attaches its listeners after awaiting storage, which takes longer
  // than a fixed wait allows on a cold profile. Without this the click below hits
  // a button with no handler and the scan never runs.
  await waitForPopupReady(popup);
  await page.bringToFront();
  // Click through the popup's own DOM: page.click() would focus the popup tab.
  await popup.evaluate(() => document.getElementById("scan-btn")?.click());
  for (let i = 0; i < 40; i++) {
    await popup.waitForTimeout(400);
    const s = await readStatus();
    if (s.text && !/scanning/i.test(s.text)) return s;
  }
  return await readStatus();
}

console.log("\n1. A page that is only an image");
const imageScan = await scan(`http://127.0.0.1:${port}/letter.png`);
console.log(`     "${imageScan.text}"`);
check("does not claim success", !/completed securely/i.test(imageScan.text), imageScan.text);
check("is flagged as an error", imageScan.isError);
check("explains the image case and points at OCR", /OCR/i.test(imageScan.text));

// Nothing was read, so nothing can be called clean. "No sensitive data detected"
// is the worst possible thing to show here.
const imageCoverage = await readCoverage();
console.log(`     coverage: "${imageCoverage.text}" (tone=${imageCoverage.tone})`);
check(
  "coverage panel does not read green on a page it read nothing from",
  !(imageCoverage.tone === "ok" && /no sensitive data/i.test(imageCoverage.text)),
  `tone=${imageCoverage.tone} text="${imageCoverage.text}"`
);

console.log("\n2. An ordinary page with real text");
const textScan = await scan(`http://127.0.0.1:${port}/text.html`);
console.log(`     "${textScan.text}"`);
check("still reports success", /completed securely/i.test(textScan.text), textScan.text);
check("is not flagged as an error", !textScan.isError);

const textCoverage = await readCoverage();
console.log(`     coverage: "${textCoverage.text}" (tone=${textCoverage.tone})`);
check("coverage panel shows a verdict after a completed scan", !textCoverage.hidden);
check(
  "a fully readable page may read as fully scanned",
  textCoverage.tone === "ok",
  `tone=${textCoverage.tone} text="${textCoverage.text}"`
);

await context.close();
server.close();

console.log(failures.length === 0 ? "\nNo-text reporting: all checks passed." : `\nNo-text reporting: ${failures.length} failed: ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);
