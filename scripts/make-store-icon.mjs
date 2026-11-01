// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Generates the Chrome Web Store Store Icon (128x128 canvas with 96x96 centered artwork + 16px padding).
// Conforms to Google Chrome Web Store developer image guidelines:
// https://developer.chrome.com/webstore/images#icons

import { chromium } from "playwright";
import { browserChannelArgs } from "./browser-launch.mjs";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(root, "release", "images");
mkdirSync(OUT_DIR, { recursive: true });

const emblem = join(root, "icons", "icon-128.png");
if (!existsSync(emblem)) {
  console.error("icons/icon-128.png missing");
  process.exit(1);
}
const emblemB64 = readFileSync(emblem).toString("base64");

// 128x128 Canvas with 96x96 centered artwork (16px padding)
const page = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 128px; height: 128px; overflow: hidden; background: transparent; }
  body {
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .tile {
    width: 96px;
    height: 96px;
    border-radius: 20px;
    background: linear-gradient(145deg, #0f1c33 0%, #070e1b 100%);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }
  .mark {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
</style>
</head>
<body>
  <div class="tile">
    <img class="mark" src="data:image/png;base64,${emblemB64}" alt="" />
  </div>
</body>
</html>`;

const browser = await chromium.launch({ headless: false, ...browserChannelArgs() });
try {
  const tab = await browser.newPage({ viewport: { width: 128, height: 128 } });
  await tab.setContent(page, { waitUntil: "load" });
  await tab.waitForTimeout(300);

  const out = join(OUT_DIR, "store-icon-128x128.png");
  await tab.screenshot({ path: out, omitBackground: true });

  console.log(`store icon created: ${out} (128x128 with 96x96 artwork + 16px padding)`);
} finally {
  await browser.close();
}
