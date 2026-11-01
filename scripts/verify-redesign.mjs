// Copyright (c) 2026 Andres Chavez Ramirez / ACR LOGIC. All rights reserved.
import { chromium } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Quick static file server
function startServer(port = 8089) {
  const mimeTypes = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".png": "image/png",
    ".json": "application/json",
  };

  const server = createServer((req, res) => {
    let reqPath = req.url.split("?")[0];
    if (reqPath === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (reqPath === "/") reqPath = "/redesign/index.html";
    if (!reqPath.startsWith("/redesign")) reqPath = "/redesign" + reqPath;

    const fullPath = join(root, reqPath);
    if (existsSync(fullPath)) {
      const ext = "." + fullPath.split(".").pop();
      res.writeHead(200, { "Content-Type": mimeTypes[ext] || "text/plain" });
      res.end(readFileSync(fullPath));
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  return new Promise((resolve) => {
    server.listen(port, () => resolve(server));
  });
}

async function verify() {
  console.log("Starting local test server on :8089...");
  const server = await startServer(8089);

  console.log("Launching Chromium to verify redesign application...");
  const browser = await chromium.launch({
    headless: false,
    args: ["--no-sandbox", "--disable-gpu"],
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  await page.goto("http://localhost:8089/redesign/index.html", { waitUntil: "networkidle" });

  const title = await page.title();
  console.log("Page title:", title);

  await page.waitForSelector("#gw-viewport-stage", { timeout: 5000 });
  console.log("✓ Viewport stage found and mounted!");

  const screens = [
    "popup",
    "protection-workspace",
    "detection-profiles",
    "document-studio",
    "my-logic",
    "review-audit",
    "central-settings",
    "privacy-governance",
    "account-enterprise",
    "diagnostics-maintenance",
  ];

  for (const s of screens) {
    await page.selectOption("#gw-screen-select", s);
    await page.waitForTimeout(100);
    const content = await page.$("#gw-screen-mount");
    if (!content) throw new Error(`Mount failed for screen ${s}`);
    console.log(`✓ Screen verified in browser: ${s}`);
  }

  // Test scan trigger on popup
  await page.selectOption("#gw-screen-select", "popup");
  const scanBtn = await page.$("#popup-scan-btn");
  if (scanBtn) {
    await scanBtn.click();
    console.log("✓ Clicked scan on popup");
    await page.waitForTimeout(700);
  }

  // Test viewport switching
  await page.click('button[data-vp="workspace"]');
  const stageWidth = await page.evaluate(() => document.getElementById("gw-viewport-stage")?.style.maxWidth);
  console.log("✓ Switched to workspace viewport, max-width:", stageWidth);

  // Take screenshot of the redesign in action
  const screenshotPath = join(root, "redesign", "redesign-preview.png");
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(`✓ Saved redesign preview screenshot to: ${screenshotPath}`);

  await browser.close();
  server.close();

  if (errors.length > 0) {
    console.error("Errors encountered:", errors);
    process.exit(1);
  } else {
    console.log("✓ ALL REDESIGN VERIFICATIONS PASSED WITH ZERO CONSOLE ERRORS!");
  }
}

verify().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
