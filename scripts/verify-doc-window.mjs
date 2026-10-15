// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
//
// End-to-end check of the page-window flow in a real browser:
// pick a 45-page document -> the count discloses its real length -> the user
// chooses pages 21-40 -> the studio says "pages 21-40 of 45" and warns that
// the rest was not scanned -> redaction produces a file named for that window
// -> a download is actually created.
//
// The defect this pins: documents longer than the 20-page cap used to be
// silently rendered as their first 20 pages and reported as "20 pages", so a
// 45-page document could be "scanned" with 25 pages never looked at and the
// user told it was complete. Requires a prior `npm run build`. Runs headed,
// so it needs a display.
import { chromium } from "playwright";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { browserChannelArgs, browserProfileDir, stageFileInPopup } from "./browser-launch.mjs";
import { mkdtempSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ext = join(root, "dist");

if (!existsSync(ext)) {
  console.error("dist/ is missing - run `npm run build` first.");
  process.exit(1);
}

const STAGE_TIMEOUT_MS = 120_000;
const TOTAL_PAGES = 45;
const WINDOW_FROM = 21;
const WINDOW_TO = 40;

// A 45-page PDF with a real text layer on every page, so the flow exercises
// text-layer detection rather than waiting on OCR. Synthetic values only
// (RFC 2606 domain, never-issued SSN).
async function buildFixture() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= TOTAL_PAGES; i += 1) {
    const page = pdf.addPage([612, 792]);
    page.drawText(`Account statement ${i}`, { x: 72, y: 700, size: 14, font, color: rgb(0, 0, 0) });
    page.drawText("jane.doe@example.com", { x: 72, y: 660, size: 12, font, color: rgb(0, 0, 0) });
    page.drawText("SSN 219-09-9999", { x: 72, y: 630, size: 12, font, color: rgb(0, 0, 0) });
  }
  return pdf.save();
}

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

const fixture = await buildFixture();
const work = mkdtempSync(join(tmpdir(), "gw-docwindow-"));

const context = await chromium.launchPersistentContext(browserProfileDir(join(work, "profile")), {
  headless: false,
  ...browserChannelArgs(),
  acceptDownloads: true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--no-first-run"],
});

try {
  const worker =
    context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 20_000 }));
  const extId = new URL(worker.url()).host;
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(`chrome-extension://${extId}/popup.html`);
  await stageFileInPopup(page, Buffer.from(fixture), "window-45.pdf", "application/pdf");

  const state = () =>
    page.evaluate(() => {
      const g = (id) => document.getElementById(id);
      const banner = g("doc-window-warning");
      const bannerText = g("doc-window-warning-text");
      return {
        studio: g("doc-workspace") ? !g("doc-workspace").hasAttribute("hidden") : false,
        pageCount: (g("doc-page-count")?.textContent || "").trim(),
        findings: (g("doc-findings-count")?.textContent || "").trim(),
        windowOpen: g("doc-window-dialog")?.open ?? false,
        windowFrom: g("doc-window-from")?.value ?? "",
        windowTo: g("doc-window-to")?.value ?? "",
        windowDesc: (g("doc-window-desc")?.textContent || "").trim(),
        warningVisible: banner ? !banner.hasAttribute("hidden") : false,
        warningText: (bannerText?.textContent || "").trim(),
        statusText: (g("doc-status-text")?.textContent || "").trim(),
        statusIsError: g("doc-status")?.classList.contains("status--error") ?? false,
        redactEnabled: g("doc-redact-btn") ? !g("doc-redact-btn").disabled : false,
      };
    });

  console.log("\n1. The count discloses the document's real length");
  await page.waitForFunction(
    () => document.getElementById("doc-window-dialog")?.open === true,
    null,
    { timeout: STAGE_TIMEOUT_MS }
  );
  const dialog = await state();
  check("the window chooser opened for a 45-page document", dialog.windowOpen);
  check("the dialog states the real page total", /45/.test(dialog.windowDesc), dialog.windowDesc);
  check("the dialog states the per-pass cap", /20/.test(dialog.windowDesc), dialog.windowDesc);
  check("the default range is the first 20 pages", dialog.windowFrom === "1" && dialog.windowTo === "20", `${dialog.windowFrom}-${dialog.windowTo}`);

  console.log("\n2. The user chooses pages 21-40");
  await page.fill("#doc-window-from", String(WINDOW_FROM));
  await page.fill("#doc-window-to", String(WINDOW_TO));
  await page.click("#doc-window-confirm");

  await page.waitForFunction(
    () => {
      const w = document.getElementById("doc-workspace");
      return w && !w.hasAttribute("hidden");
    },
    null,
    { timeout: STAGE_TIMEOUT_MS }
  );
  const previewed = await state();
  check("the scanned window is named, not just its page count", /pages 21\D+40 of 45/.test(previewed.pageCount), previewed.pageCount);
  check("the findings of the chosen window were detected", /\d+ detected/.test(previewed.findings), previewed.findings);
  check("redaction is available for the window", previewed.redactEnabled);
  check(
    "a persistent warning discloses the unscanned pages",
    previewed.warningVisible && /NOT scanned/.test(previewed.warningText),
    previewed.warningText
  );
  check(
    "the warning names the document's true length",
    /45/.test(previewed.warningText),
    previewed.warningText
  );

  console.log("\n3. Re-scanning a different window is offered");
  const rescanVisible = await page.evaluate(
    () => !document.getElementById("doc-window-rescan-btn")?.hasAttribute("hidden")
  );
  check("the rescan control is reachable", rescanVisible);

  console.log("\n4. Redact the window and download");
  await page.click("#doc-redact-btn");
  await page.waitForTimeout(500);
  const confirmOpen = await page.evaluate(() => document.getElementById("doc-confirm-dialog")?.open ?? false);
  check("confirmation dialog opened", confirmOpen);
  if (confirmOpen) {
    await page.click("#doc-confirm");
    await page.waitForFunction(
      () => {
        const b = document.getElementById("doc-print-bar");
        const s = document.getElementById("doc-status");
        const isError = s && s.classList.contains("status--error");
        return (b && !b.hasAttribute("hidden")) || isError;
      },
      null,
      { timeout: STAGE_TIMEOUT_MS }
    );
  }
  const saved = await state();
  check("a success message is shown", /saved/i.test(saved.statusText), `"${saved.statusText}"`);
  check("the message is not an error", !saved.statusIsError);

  const downloads = await worker.evaluate(async () => {
    const items = await chrome.downloads.search({ limit: 5, orderBy: ["-startTime"] });
    return items.map((d) => ({ filename: d.filename, state: d.state, error: d.error, exists: d.exists }));
  });
  // The name carries the window, so a file covering pages 21-40 cannot be
  // mistaken for the whole document and two windows cannot collide on disk.
  //
  // It is asserted from the popup's status line rather than the download entry:
  // the redaction is requested with saveAs:true, so until someone answers the
  // native save dialog chrome.downloads reports a temp UUID filename, not the
  // one the worker asked for. The status line is the worker's own claim and is
  // exactly what the user reads.
  check(
    "the artifact is named for the window it covers",
    /window-45-redacted-p21-40\.pdf/.test(saved.statusText),
    saved.statusText
  );
  const produced = downloads.filter((d) => d.exists && !d.error && (d.state === "complete" || d.state === "in_progress"));
  check("a download was created and produced a file", produced.length > 0, JSON.stringify(downloads));
  const interrupted = downloads.filter((d) => d.state === "interrupted");
  check("no download was interrupted", interrupted.length === 0, JSON.stringify(interrupted));

  check("no uncaught page errors", pageErrors.length === 0, JSON.stringify(pageErrors));
} finally {
  await context.close();
}

console.log(
  failures.length === 0
    ? "\nDocument page-window flow: all checks passed."
    : `\nDocument page-window flow: ${failures.length} check(s) failed: ${failures.join(", ")}`
);
process.exit(failures.length === 0 ? 0 : 1);
