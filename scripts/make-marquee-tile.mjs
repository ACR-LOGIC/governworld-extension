// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Generates the Chrome Web Store Marquee Promo Tile (1400x560 PNG, 24-bit RGB, no alpha).
// Follows Google Chrome Web Store developer image specifications.

import { chromium } from "playwright";
import { browserChannelArgs } from "./browser-launch.mjs";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(root, "release", "images");
mkdirSync(OUT_DIR, { recursive: true });

const W = 1400;
const H = 560;

const emblem = join(root, "icons", "icon-128.png");
if (!existsSync(emblem)) {
  console.error("icons/icon-128.png missing");
  process.exit(1);
}
const emblemB64 = readFileSync(emblem).toString("base64");

// 1400x560 Marquee Tile HTML Template
const page = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: ${W}px; height: ${H}px; overflow: hidden; }
  body {
    background: radial-gradient(circle at 75% 30%, #152238 0%, #0c1424 45%, #070c16 100%);
    color: #f1f5f9;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 60px 80px;
    position: relative;
  }

  /* Grid overlay effect */
  body::before {
    content: "";
    position: absolute;
    inset: 0;
    background-image: 
      linear-gradient(to right, rgba(34, 211, 238, 0.04) 1px, transparent 1px),
      linear-gradient(to bottom, rgba(34, 211, 238, 0.04) 1px, transparent 1px);
    background-size: 40px 40px;
    pointer-events: none;
  }

  /* Subtle cyan glow behind emblem */
  .glow {
    position: absolute;
    width: 480px;
    height: 480px;
    right: 80px;
    top: 40px;
    background: radial-gradient(circle, rgba(34, 211, 238, 0.12) 0%, rgba(34, 211, 238, 0) 70%);
    border-radius: 50%;
    pointer-events: none;
  }

  .left {
    max-width: 720px;
    z-index: 2;
    display: flex;
    flex-direction: column;
    gap: 22px;
  }

  .badge-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 14px;
    border-radius: 9999px;
    background: rgba(34, 211, 238, 0.1);
    border: 1px solid rgba(34, 211, 238, 0.25);
    color: #22d3ee;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .badge-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #22d3ee;
    box-shadow: 0 0 10px #22d3ee;
  }

  h1 {
    font-size: 54px;
    font-weight: 800;
    line-height: 1.1;
    letter-spacing: -0.02em;
    color: #ffffff;
  }

  h1 span {
    background: linear-gradient(135deg, #22d3ee 0%, #38bdf8 50%, #818cf8 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .desc {
    font-size: 20px;
    line-height: 1.5;
    color: #94a3b8;
    max-width: 660px;
  }

  .pills {
    display: flex;
    gap: 14px;
    margin-top: 10px;
  }

  .pill {
    padding: 8px 18px;
    background: rgba(15, 23, 42, 0.8);
    border: 1px solid #1e293b;
    border-radius: 8px;
    font-size: 14px;
    color: #cbd5e1;
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .pill-check {
    color: #22d3ee;
    font-weight: bold;
  }

  .right {
    z-index: 2;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding-right: 40px;
  }

  .mark-container {
    width: 220px;
    height: 220px;
    border-radius: 44px;
    background: linear-gradient(145deg, #0f1c33 0%, #070e1b 100%);
    border: 2px solid rgba(34, 211, 238, 0.35);
    box-shadow: 
      0 20px 50px rgba(0, 0, 0, 0.6),
      0 0 40px rgba(34, 211, 238, 0.15);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }

  .mark {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  .brand-sub {
    margin-top: 20px;
    font-size: 15px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #64748b;
    font-weight: 600;
  }
</style>
</head>
<body>
  <div class="glow"></div>
  <div class="left">
    <div class="badge-row">
      <div class="badge"><span class="badge-dot"></span> 100% On-Device Security</div>
      <div class="badge" style="border-color: rgba(148, 163, 184, 0.3); color: #cbd5e1; background: rgba(255,255,255,0.05);">Zero Data Egress</div>
    </div>
    <h1>Private PII & PHI Redaction<br><span>Directly in Your Browser.</span></h1>
    <p class="desc">
      Scan active webpages, intercept clipboard pastes, and redact PDF documents locally. Your sensitive data never touches a cloud server.
    </p>
    <div class="pills">
      <div class="pill"><span class="pill-check">&#10003;</span> In-Line DOM Masking</div>
      <div class="pill"><span class="pill-check">&#10003;</span> Offline OCR & PDF Studio</div>
      <div class="pill"><span class="pill-check">&#10003;</span> Signed Audit Proof</div>
    </div>
  </div>
  <div class="right">
    <div class="mark-container">
      <img class="mark" src="data:image/png;base64,${emblemB64}" alt="GovernWorld Emblem" />
    </div>
    <div class="brand-sub">GovernWorld Redaction</div>
  </div>
</body>
</html>`;

const browser = await chromium.launch({ headless: false, ...browserChannelArgs() });
try {
  const tab = await browser.newPage({ viewport: { width: W, height: H } });
  await tab.setContent(page, { waitUntil: "load" });
  await tab.waitForTimeout(500);

  const out = join(OUT_DIR, "marquee-promo-tile-1400x560.png");
  // omitBackground: false ensures 24-bit RGB with no alpha channel
  await tab.screenshot({ path: out, omitBackground: false });

  console.log(`marquee promo tile created: ${out} (1400x560)`);
} finally {
  await browser.close();
}
