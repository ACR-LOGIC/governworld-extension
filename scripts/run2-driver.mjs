// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Run 2 Live Browser Benchmark & Gate Driver (Chrome for Testing 159) — GW-BENCH-2026-001.
// Runs against the built extension in dist/ (copied into a temp dir with local loopback host permission).
// Synthetic data only.

import { chromium } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { createWorker } from "tesseract.js";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { waitForPopupReady } from "./browser-launch.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");

if (!existsSync(join(DIST, "manifest.json"))) {
  console.error("dist/ is missing — run `npm run build` first.");
  process.exit(1);
}

const args = process.argv.slice(2);
const modeArg = (args.find((a) => a.startsWith("--mode=")) || "--mode=baseline").split("=")[1];
const stageArg = (args.find((a) => a.startsWith("--stage=")) || "--stage=all").split("=")[1];
const outArg = args.find((a) => a.startsWith("--out="))?.slice(6);
const TAKE_SCREENSHOTS = args.includes("--screenshot") || ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p11"].includes(modeArg);
const SCREENSHOT_DIR = join(ROOT, "docs", "releases", "directive-reports", "screenshots");
const RESULTS_PATH = outArg ? resolve(ROOT, outArg) : join(ROOT, "docs", "benchmarks", "results-run2.json");
const IS_GATE = ["gate", "p1", "p2", "p3", "p4", "p5", "p6", "p7", "p11"].includes(modeArg);

const executablePath = (process.env.GW_BROWSER_EXECUTABLE || "").trim() || chromium.executablePath();

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[idx].toFixed(2));
}

function summarize(samples) {
  const s = [...samples].sort((a, b) => a - b);
  return {
    n: s.length,
    p50: percentile(s, 50),
    p95: percentile(s, 95),
    min: s.length ? Number(s[0].toFixed(2)) : null,
    max: s.length ? Number(s[s.length - 1].toFixed(2)) : null,
    samples: samples.map((x) => Number(x.toFixed(2))),
  };
}

// --- Synthetic 5x7 bitmap PNG encoder (for baseline Run 2 scanned fixtures) ---
const GLYPHS = {
  H: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  E: ["####.", "#....", "####.", "#....", "#....", "#....", "####."],
  L: ["#....", "#....", "#....", "#....", "#....", "#....", "####."],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  "0": [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
  "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  "2": [".###.", "#...#", "....#", "..##.", ".#...", "#....", "#####"],
  "3": ["####.", "....#", "....#", ".###.", "....#", "....#", "####."],
  "4": ["#...#", "#...#", "#...#", "#####", "....#", "....#", "....#"],
  "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  "6": [".###.", "#....", "####.", "#...#", "#...#", "#...#", ".###."],
  "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  "9": [".###.", "#...#", "#...#", ".####", "....#", "#...#", ".###."],
  "-": [".....", ".....", ".....", "#####", ".....", ".....", "....."],
  " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
};

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return ~c >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, "ascii");
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function makeBitmapPng(text) {
  const scale = 6;
  const pad = 16;
  const glyphs = [...text.toUpperCase()].map((c) => GLYPHS[c] ?? GLYPHS[" "]);
  const gw = 5;
  const gh = 7;
  const spacing = 2 * scale;
  const w = gw * scale * glyphs.length + spacing * (glyphs.length - 1) + pad * 2;
  const h = gh * scale + pad * 2;
  const px = new Uint8Array(w * h * 3).fill(255);
  glyphs.forEach((g, gi) => {
    const gx = pad + gi * (gw * scale + spacing);
    const gy = pad;
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        if (g[y][x] !== "#") continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const idx = ((gy + y * scale + sy) * w + (gx + x * scale + sx)) * 3;
            px[idx] = 0;
            px[idx + 1] = 0;
            px[idx + 2] = 0;
          }
        }
      }
    }
  });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const scanlines = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    scanlines[y * (w * 3 + 1)] = 0;
    px.subarray(y * w * 3, (y + 1) * w * 3).forEach((v, i) => {
      scanlines[y * (w * 3 + 1) + 1 + i] = v;
    });
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

async function makeNativePdf(pagesCount) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < pagesCount; p++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`Synthetic Hospital Record Page ${p + 1}`, { x: 60, y: 720, size: 12, font });
    page.drawText(`SSN: 219-09-${String(9990 + (p % 9)).padStart(4, "0")}`, { x: 60, y: 690, size: 11, font });
    page.drawText(`Contact: patient${p + 1}@example.test`, { x: 60, y: 660, size: 11, font });
  }
  return Buffer.from(await doc.save());
}

async function makeScannedPdf(pagesCount, pngBytes) {
  const doc = await PDFDocument.create();
  const img = await doc.embedPng(pngBytes);
  for (let p = 0; p < pagesCount; p++) {
    const page = doc.addPage([612, 792]);
    page.drawImage(img, { x: 60, y: 620, width: 420, height: 80 });
  }
  return Buffer.from(await doc.save());
}

/** Pierce closed shadow root via CDP to count painted overlay masks and collect their labels. */
async function readOverlayMasksViaCdp(cdp) {
  const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  const masks = [];
  function walk(node) {
    if (!node) return;
    if (node.nodeName === "DIV" && Array.isArray(node.attributes)) {
      const attrs = {};
      for (let i = 0; i < node.attributes.length; i += 2) {
        attrs[node.attributes[i]] = node.attributes[i + 1];
      }
      if (attrs["data-kind"] === "mask") {
        masks.push({ label: attrs["data-label"] || "" });
      }
    }
    if (Array.isArray(node.shadowRoots)) {
      for (const sr of node.shadowRoots) walk(sr);
    }
    if (Array.isArray(node.children)) {
      for (const c of node.children) walk(c);
    }
  }
  walk(root);
  return masks;
}

async function readIndexedDbKeys(page) {
  return await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("governworld-redaction", 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains("docfiles")) {
          req.result.createObjectStore("docfiles");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const keys = await new Promise((resolve, reject) => {
      const tx = db.transaction("docfiles", "readonly");
      const req = tx.objectStore("docfiles").getAllKeys();
      req.onsuccess = () => resolve(req.result.map(String));
      req.onerror = () => reject(req.error);
    });
    db.close();
    return keys;
  });
}

async function clearIndexedDb(page) {
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("governworld-redaction", 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains("docfiles")) {
          req.result.createObjectStore("docfiles");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("docfiles", "readwrite");
      tx.objectStore("docfiles").clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
}

const FIXTURE_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Run 2 Live Fixture</title></head>
<body>
  <h1>Synthetic Live Test Page</h1>
  <div id="stage">
    <p id="editable-node">Initial clean clinical status line.</p>
  </div>
  <div id="batch-container"></div>
  <form id="paste-form" action="#submitted">
    <textarea id="paste-target" rows="6" cols="60"></textarea>
    <button type="submit">Submit</button>
  </form>
</body>
</html>`;

const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(FIXTURE_HTML);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const fixtureUrl = `http://127.0.0.1:${port}/`;

const work = mkdtempSync(join(tmpdir(), "gw-run2-"));
const extDir = join(work, "ext");
mkdirSync(extDir, { recursive: true });
cpSync(DIST, extDir, { recursive: true });
const mfPath = join(extDir, "manifest.json");
const mf = JSON.parse(readFileSync(mfPath, "utf8"));
mf.host_permissions = [`http://127.0.0.1:${port}/*`];
writeFileSync(mfPath, JSON.stringify(mf, null, 2));

const out = {
  generatedAt: new Date().toISOString(),
  mode: modeArg,
  stage: stageArg,
  executablePath,
  browserVersion: null,
  nodeVersion: process.version,
  scan: {},
  paste: {},
  docs: {},
  ocrNode: {},
  network: {},
  gateFailures: [],
};

const recordedRequests = [];

const runAllStages = stageArg === "all";
const stageSet = new Set(stageArg.split(",").map((s) => s.trim()).filter(Boolean));
const shouldRun = (name) => runAllStages || stageSet.has(name);

const context = await chromium.launchPersistentContext(join(work, "profile"), {
  headless: false,
  executablePath,
  acceptDownloads: true,
  args: [
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ],
  permissions: ["clipboard-read", "clipboard-write"],
});

try {
  context.on("request", (req) => {
    recordedRequests.push({ url: req.url(), method: req.method() });
  });

  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 25_000 }));
  const extId = new URL(sw.url()).host;
  const page = await context.newPage();
  await page.goto(fixtureUrl, { waitUntil: "load" });
  const cdp = await context.newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("Performance.enable");
  const ver = await cdp.send("Browser.getVersion").catch(() => ({ product: "unknown" }));
  out.browserVersion = ver.product;

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: "load" });
  await waitForPopupReady(popup);

  const fixtureTabId = await sw.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((t) => t.url?.startsWith(url))?.id ?? null;
  }, fixtureUrl);

  async function injectAndScan() {
    await page.bringToFront();
    await sw.evaluate(async (tabId) => {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    }, fixtureTabId);
    return await popup.evaluate((tabId) => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Scan timeout")), 30_000);
        const chunks = new Map();
        const progressEvents = [];
        const reqId = `r2-${Date.now()}`;
        const listener = (msg) => {
          if (msg?.type === "POPUP_SCAN_PROGRESS") {
            progressEvents.push(msg);
            return;
          }
          if (msg?.type === "POPUP_STATE_CHUNK") {
            chunks.set(msg.chunkIndex, msg.findings || []);
            return;
          }
          if (msg?.type !== "POPUP_STATE") return;
          if (msg?.state?.scanning) return;
          clearTimeout(timer);
          chrome.runtime.onMessage.removeListener(listener);
          let state = msg.state;
          if (msg.totalChunks && msg.totalChunks > 1) {
            const merged = [];
            const finalIdx = msg.chunkIndex ?? msg.totalChunks - 1;
            for (let i = 0; i < msg.totalChunks; i++) {
              if (i === finalIdx) merged.push(...(state.findings || []));
              else merged.push(...(chunks.get(i) || []));
            }
            state = { ...state, findings: merged, _progressEvents: progressEvents };
          } else {
            state = { ...state, _progressEvents: progressEvents };
          }
          resolve(state);
        };
        chrome.runtime.onMessage.addListener(listener);
        chrome.runtime.sendMessage({ type: "POPUP_SCAN", requestId: reqId, mode: "local", tabId });
      });
    }, fixtureTabId);
  }

  async function applyMasks(findingIds) {
    await page.bringToFront();
    return await popup.evaluate(({ ids, tabId }) => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Apply masks timeout")), 10_000);
        const listener = (msg) => {
          if (msg?.type !== "POPUP_STATE") return;
          clearTimeout(timer);
          chrome.runtime.onMessage.removeListener(listener);
          resolve(msg.state);
        };
        chrome.runtime.onMessage.addListener(listener);
        chrome.runtime.sendMessage({ type: "POPUP_APPLY_MASKS", requestId: `r2-m-${Date.now()}`, findingIds: ids, tabId });
      });
    }, { ids: findingIds, tabId: fixtureTabId });
  }

  // -------------------------------------------------------------------------
  // STAGE: SCAN (P1 characterData, control added-node, P2 batch removal, P3 stale counts)
  // -------------------------------------------------------------------------
  if (shouldRun("scan")) {
    console.log("\n[Run 2 - Scan Stage]");

    // Seed an initial masked finding on a fresh page load so overlay controller exists and session is active
    async function resetFixtureWithSeed() {
      await page.goto(fixtureUrl, { waitUntil: "load" });
      await page.evaluate(() => {
        document.getElementById("stage").innerHTML =
          '<p id="seed-node">Seed record: test.user@example.test</p><p id="editable-node">Initial clean clinical status line.</p>';
        document.getElementById("batch-container").innerHTML = "";
      });
      const st = await injectAndScan();
      await applyMasks((st.findings || []).map((f) => f.id));
      await page.waitForTimeout(100);
      return st;
    }

    // 1. P1: 5 trials of characterData edit in place
    const charDataResults = [];
    for (let t = 0; t < 5; t++) {
      await resetFixtureWithSeed();
      const baseSsnMasks = (await readOverlayMasksViaCdp(cdp)).filter((m) => m.label.startsWith("ssn:")).length;
      const t0 = performance.now();
      await page.evaluate((idx) => {
        const p = document.getElementById("editable-node");
        p.firstChild.data = `Patient SSN 219-09-999${idx % 10} updated in place.`;
      }, t);
      const waitLimitMs = IS_GATE ? 2500 : 12000;
      let appearedMs = null;
      while (performance.now() - t0 < waitLimitMs) {
        const ssnMasks = (await readOverlayMasksViaCdp(cdp)).filter((m) => m.label.startsWith("ssn:"));
        if (ssnMasks.length > baseSsnMasks) {
          appearedMs = Number((performance.now() - t0).toFixed(1));
          break;
        }
        await page.waitForTimeout(20);
      }
      charDataResults.push({ trial: t + 1, detected: appearedMs !== null, latencyMs: appearedMs });
      console.log(`  characterData trial ${t + 1}: detected=${appearedMs !== null} (${appearedMs ?? "timeout"} ms)`);
      if (TAKE_SCREENSHOTS && (modeArg === "p1" || modeArg === "p7") && t === 4 && appearedMs !== null) {
        mkdirSync(SCREENSHOT_DIR, { recursive: true });
        const shotName = modeArg === "p7" ? "P7-sub-250ms-mask.png" : "P1-characterdata-masked.png";
        await page.screenshot({ path: join(SCREENSHOT_DIR, shotName), fullPage: false });
      }
    }

    // 2. Added-node control: 3 trials
    const addedNodeResults = [];
    for (let t = 0; t < 3; t++) {
      await resetFixtureWithSeed();
      const baseSsnMasks = (await readOverlayMasksViaCdp(cdp)).filter((m) => m.label.startsWith("ssn:")).length;
      const t0 = performance.now();
      await page.evaluate((idx) => {
        const n = document.createElement("p");
        n.textContent = `Added node SSN 219-09-999${idx % 10}`;
        document.getElementById("batch-container").appendChild(n);
      }, t);
      let appearedMs = null;
      while (performance.now() - t0 < 5000) {
        const ssnMasks = (await readOverlayMasksViaCdp(cdp)).filter((m) => m.label.startsWith("ssn:"));
        if (ssnMasks.length > baseSsnMasks) {
          appearedMs = Number((performance.now() - t0).toFixed(1));
          break;
        }
        await page.waitForTimeout(20);
      }
      addedNodeResults.push({ trial: t + 1, detected: appearedMs !== null, latencyMs: appearedMs });
      console.log(`  added-node control ${t + 1}: detected=${appearedMs !== null} (${appearedMs ?? "timeout"} ms)`);
    }

    // 3. P2: 3-node batch (NPI, email, SSN), then remove first node
    const batchCollisionResults = [];
    for (let t = 0; t < 3; t++) {
      await page.goto(fixtureUrl, { waitUntil: "load" });
      await page.evaluate(() => {
        document.getElementById("stage").innerHTML = '<p id="editable-node">Baseline clean text.</p>';
        document.getElementById("batch-container").innerHTML = "";
      });
      await injectAndScan();
      await page.evaluate(() => {
        const c = document.getElementById("batch-container");
        const n1 = document.createElement("p");
        n1.id = "b-npi";
        n1.textContent = "Provider NPI: 1234567893";
        const n2 = document.createElement("p");
        n2.id = "b-email";
        n2.textContent = "Email: batch.user@example.test";
        const n3 = document.createElement("p");
        n3.id = "b-ssn";
        n3.textContent = "SSN: 219-09-9999";
        c.append(n1, n2, n3);
      });
      await page.waitForTimeout(1000);
      const beforeMasks = await readOverlayMasksViaCdp(cdp);
      await page.evaluate(() => {
        document.getElementById("b-npi")?.remove();
      });
      await page.waitForTimeout(1000);
      const afterMasks = await readOverlayMasksViaCdp(cdp);
      const ghostNpiRemains = afterMasks.some((m) => m.label.includes("npi"));
      const survivorsIntact =
        afterMasks.some((m) => m.label.includes("email")) &&
        afterMasks.some((m) => m.label.includes("ssn"));
      batchCollisionResults.push({
        trial: t + 1,
        beforeCount: beforeMasks.length,
        afterCount: afterMasks.length,
        ghostNpiRemains,
        survivorsIntact,
      });
      console.log(
        `  P2 batch removal trial ${t + 1}: before=${beforeMasks.length} after=${afterMasks.length} ghostNpi=${ghostNpiRemains} survivors=${survivorsIntact}`
      );
      if (TAKE_SCREENSHOTS && modeArg === "p2" && t === 2) {
        mkdirSync(SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: join(SCREENSHOT_DIR, "P2-no-ghost-masks.png"), fullPage: false });
      }
    }

    // 4. P3: Popup & badge sync across 5 incremental additions
    const staleCountResults = [];
    for (let t = 0; t < 5; t++) {
      await page.goto(fixtureUrl, { waitUntil: "load" });
      await page.evaluate(() => {
        document.getElementById("stage").innerHTML = '<p id="editable-node">Clean start page.</p>';
        document.getElementById("batch-container").innerHTML = "";
      });
      const initState = await injectAndScan();
      expectOrRecord("init clean", (initState.findings || []).length === 0);
      await page.evaluate((idx) => {
        const p = document.createElement("p");
        p.textContent = `Incremental SSN 219-09-999${idx % 10}`;
        document.getElementById("batch-container").appendChild(p);
      }, t);
      await page.waitForTimeout(1000);
      const sessionFindings = await sw.evaluate(async (tabId) => {
        const raw = await chrome.storage.session.get(`scan:${tabId}`);
        return raw[`scan:${tabId}`]?.findings?.length ?? 0;
      }, fixtureTabId);
      const badgeText = await sw.evaluate(async (tabId) => {
        return await chrome.action.getBadgeText({ tabId });
      }, fixtureTabId);
      const popupCount = await popup.evaluate(() => {
        const rows = document.querySelectorAll("#findings-list li").length;
        const txt = (document.getElementById("results-count")?.textContent || "0").trim();
        const parsed = Number.parseInt(txt, 10) || 0;
        return Math.max(rows, parsed);
      });
      staleCountResults.push({
        trial: t + 1,
        sessionFindings,
        badgeText,
        popupCount,
        synced: sessionFindings > 0 && popupCount > 0 && Number(badgeText || 0) > 0,
      });
      console.log(
        `  P3 sync trial ${t + 1}: session=${sessionFindings} badge="${badgeText}" popup=${popupCount}`
      );
      if (TAKE_SCREENSHOTS && modeArg === "p3" && t === 4) {
        mkdirSync(SCREENSHOT_DIR, { recursive: true });
        await popup.screenshot({ path: join(SCREENSHOT_DIR, "P3-popup-badge-synced.png"), fullPage: false });
      }
    }

    out.scan = {
      charData: {
        trials: charDataResults.length,
        detectedCount: charDataResults.filter((r) => r.detected).length,
        latencies: summarize(charDataResults.filter((r) => r.latencyMs !== null).map((r) => r.latencyMs)),
        details: charDataResults,
      },
      addedNodeControl: {
        trials: addedNodeResults.length,
        detectedCount: addedNodeResults.filter((r) => r.detected).length,
        latencies: summarize(addedNodeResults.filter((r) => r.latencyMs !== null).map((r) => r.latencyMs)),
      },
      batchRemoval: {
        trials: batchCollisionResults.length,
        ghostCount: batchCollisionResults.filter((r) => r.ghostNpiRemains || r.afterCount >= r.beforeCount).length,
        details: batchCollisionResults,
      },
      popupBadgeSync: {
        trials: staleCountResults.length,
        syncedCount: staleCountResults.filter((r) => r.synced).length,
        details: staleCountResults,
      },
    };
  }

  // -------------------------------------------------------------------------
  // STAGE: P5 (Unicode email exact-span detection & overlay mask in Chrome)
  // -------------------------------------------------------------------------
  if (shouldRun("p5")) {
    console.log("\n[Run 2 - P5 Unicode Email Stage]");
    await page.goto(fixtureUrl, { waitUntil: "load" });
    const sampleText = "Direct care notice to josé.maría@example.test and élise.müller@klinik.example.de today.";
    await page.evaluate((text) => {
      document.getElementById("stage").innerHTML = `<p id="unicode-email" style="font-size:20px;padding:16px">${text}</p>`;
      document.getElementById("batch-container").innerHTML = "";
    }, sampleText);
    const st = await injectAndScan();
    await applyMasks((st.findings || []).map((f) => f.id));
    await page.waitForTimeout(150);
    const overlayMasks = await readOverlayMasksViaCdp(cdp);
    const popupCount = await popup.evaluate(() => document.querySelectorAll("#findings-list li").length);
    const emailFindings = (st.findings || []).filter((f) => f.category === "email");
    const prefixLen = "Synthetic Live Test Page\n".length;
    const expected = [
      { value: "josé.maría@example.test", preview: "j***@example.test" },
      { value: "élise.müller@klinik.example.de", preview: "é***@klinik.example.de" },
    ].map((item) => {
      const start = prefixLen + sampleText.indexOf(item.value);
      const end = start + item.value.length;
      const hit = emailFindings.find((f) => f.startOffset === start && f.endOffset === end && f.preview === item.preview);
      return { value: item.value, expectedStart: start, expectedEnd: end, matched: Boolean(hit), got: hit ?? null };
    });
    out.scan.unicodeEmailP5 = {
      exactMatched: expected.filter((e) => e.matched).length,
      total: expected.length,
      overlayEmailMasks: overlayMasks.filter((m) => m.label.startsWith("email:")).length,
      popupCount,
      details: expected,
    };
    console.log(
      `  P5 unicode email: exact=${out.scan.unicodeEmailP5.exactMatched}/${out.scan.unicodeEmailP5.total} masks=${out.scan.unicodeEmailP5.overlayEmailMasks} popup=${popupCount}`
    );
    if (TAKE_SCREENSHOTS) {
      mkdirSync(SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: join(SCREENSHOT_DIR, "P5-unicode-email-span.png"), fullPage: false });
    }
  }

  // -------------------------------------------------------------------------
  // STAGE: P6 (10,000-node windowed complete scan + incomplete window warning)
  // -------------------------------------------------------------------------
  if (shouldRun("p6")) {
    console.log("\n[Run 2 - P6 Chunked Windowed Scan Stage]");
    await page.goto(fixtureUrl, { waitUntil: "load" });
    await page.evaluate(() => {
      const stage = document.getElementById("stage");
      stage.innerHTML = "";
      const frag = document.createDocumentFragment();
      for (let i = 0; i < 10000; i++) {
        const p = document.createElement("p");
        const hasSecret = i % 100 < 3;
        p.textContent = hasSecret
          ? `Synthetic patient intake node ${i}: SSN 219-09-9999 recorded for synthetic chart verify.`
          : `Synthetic patient routine status note ${i}: general non-identifying review line in log.`;
        frag.appendChild(p);
      }
      stage.appendChild(frag);
      document.getElementById("batch-container").innerHTML = "";
    });
    const st10k = await injectAndScan();
    await popup.waitForTimeout(300);
    const ui10k = await popup.evaluate(() => ({
      statusText: (document.getElementById("status")?.textContent || "").trim(),
      summaryChars: (document.getElementById("summary-chars")?.textContent || "").trim(),
      coverageStatement: (document.getElementById("scan-coverage-statement")?.textContent || "").trim(),
      resultsCount: (document.getElementById("results-count")?.textContent || "").trim(),
      renderedFindings: document.querySelectorAll("#findings-list li").length,
    }));
    const session10k = await sw.evaluate(async (tabId) => {
      const raw = await chrome.storage.session.get(`scan:${tabId}`);
      const s = raw[`scan:${tabId}`];
      return {
        findingsCount: s?.findings?.length ?? 0,
        stats: s?.stats ?? null,
      };
    }, fixtureTabId);
    if (TAKE_SCREENSHOTS) {
      mkdirSync(SCREENSHOT_DIR, { recursive: true });
      await popup.screenshot({ path: join(SCREENSHOT_DIR, "P6-10k-complete.png"), fullPage: false });
    }

    // Trigger technical window ceiling (maxTotalWindows=200 with maxVisibleChars=100 on 220 blocks)
    const prevSettings = await sw.evaluate(async () => {
      const raw = await chrome.storage.local.get("settings");
      const current = raw.settings || {};
      await chrome.storage.local.set({ settings: { ...current, maxVisibleChars: 100 } });
      return current;
    });
    await page.goto(fixtureUrl, { waitUntil: "load" });
    await page.evaluate(() => {
      const stage = document.getElementById("stage");
      stage.innerHTML = "";
      const frag = document.createDocumentFragment();
      for (let i = 0; i < 220; i++) {
        const p = document.createElement("p");
        p.textContent = `Window ceiling check block ${String(i).padStart(3, "0")}: ${i === 10 ? "SSN 219-09-9999 recorded" : "routine clinical review note"}.`;
        frag.appendChild(p);
      }
      stage.appendChild(frag);
    });
    const stLimit = await injectAndScan();
    await popup.waitForTimeout(250);
    const uiLimit = await popup.evaluate(() => ({
      statusText: (document.getElementById("status")?.textContent || "").trim(),
      coverageStatement: (document.getElementById("scan-coverage-statement")?.textContent || "").trim(),
      coverageStatementHidden: document.getElementById("scan-coverage-statement")?.hidden ?? true,
    }));
    if (TAKE_SCREENSHOTS) {
      mkdirSync(SCREENSHOT_DIR, { recursive: true });
      await popup.screenshot({ path: join(SCREENSHOT_DIR, "P6-incomplete-window-warning.png"), fullPage: false });
    }
    // Restore original settings
    await sw.evaluate(async (prev) => {
      if (Object.keys(prev || {}).length > 0) {
        await chrome.storage.local.set({ settings: prev });
      } else {
        await chrome.storage.local.remove("settings");
      }
    }, prevSettings);

    out.scan.windowedP6 = {
      full10k: {
        findingsCount: st10k.findings?.length ?? 0,
        sessionFindingsCount: session10k.findingsCount,
        windowsScanned: st10k.windowsScanned ?? session10k.stats?.windowsScanned ?? 0,
        windowsTotal: st10k.windowsTotal ?? session10k.stats?.windowsTotal ?? 0,
        truncated: st10k.truncated,
        findingsTruncated: st10k.findingsTruncated,
        coverageStatus: st10k.coverageStatus,
        progressEventsCount: (st10k._progressEvents || []).length,
        progressEvents: (st10k._progressEvents || []).map((e) => ({
          windowsCompleted: e.windowsCompleted,
          windowsTotal: e.windowsTotal,
          charsScanned: e.charsScanned,
          findingsSoFar: e.findingsSoFar,
        })),
        ui: ui10k,
      },
      incompleteCeiling: {
        windowsScanned: stLimit.windowsScanned ?? 0,
        windowsTotal: stLimit.windowsTotal ?? 0,
        truncated: stLimit.truncated,
        coverageStatus: stLimit.coverageStatus,
        incompleteWindows: stLimit.incompleteWindows ?? [],
        ui: uiLimit,
      },
    };
    console.log(
      `  P6 10k-node: findings=${out.scan.windowedP6.full10k.findingsCount}/300 windows=${out.scan.windowedP6.full10k.windowsScanned}/${out.scan.windowedP6.full10k.windowsTotal} progressEvents=${out.scan.windowedP6.full10k.progressEventsCount} truncated=${out.scan.windowedP6.full10k.truncated}`
    );
    console.log(
      `  P6 ceiling: windows=${out.scan.windowedP6.incompleteCeiling.windowsScanned}/${out.scan.windowedP6.incompleteCeiling.windowsTotal} truncated=${out.scan.windowedP6.incompleteCeiling.truncated} status=${out.scan.windowedP6.incompleteCeiling.coverageStatus} statement="${uiLimit.coverageStatement}"`
    );
  }

  // -------------------------------------------------------------------------
  // STAGE: P11 (About & Diagnostics live version parity)
  // -------------------------------------------------------------------------
  if (shouldRun("p11")) {
    console.log("\n[Run 2 - P11 About Version Stage]");
    await popup.evaluate(() => {
      document.querySelector('[data-tab="settings"]')?.click();
      document.getElementById('settings-nav-about')?.click();
    });
    await popup.waitForTimeout(200);
    const aboutInfo = await popup.evaluate(() => ({
      diagVersionText: (document.getElementById("diag-version-value")?.textContent || "").trim(),
      manifestVersion: chrome.runtime.getManifest().version,
    }));
    out.scan.p11About = aboutInfo;
    console.log(`  P11 About UI: version="${aboutInfo.diagVersionText}" manifest="${aboutInfo.manifestVersion}"`);
    if (TAKE_SCREENSHOTS) {
      mkdirSync(SCREENSHOT_DIR, { recursive: true });
      await popup.screenshot({ path: join(SCREENSHOT_DIR, "P11-about-version.png"), fullPage: false });
    }
  }

  // -------------------------------------------------------------------------
  // STAGE: PASTE (Real clipboard Ctrl+V, 15 trials, dialog latency + 0 escapes)
  // -------------------------------------------------------------------------
  if (shouldRun("paste")) {
    console.log("\n[Run 2 - Paste Stage]");
    await page.bringToFront();
    await sw.evaluate(async (tabId) => {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    }, fixtureTabId);

    const payloads = [
      { label: "short", text: "SSN 219-09-9999" },
      { label: "10KB", text: ("Routine memo sentence for size test. ".repeat(300)).slice(0, 10 * 1024 - 15) + "SSN 219-09-9999" },
      { label: "68KB", text: ("Routine narrative payload sizing check. ".repeat(1750)).slice(0, 68 * 1024 - 15) + "SSN 219-09-9999" },
    ];

    const pasteResults = {};
    let totalEscapes = 0;
    for (const p of payloads) {
      const latencies = [];
      let escapes = 0;
      for (let t = 0; t < 5; t++) {
        await page.evaluate(async (clipText) => {
          const ta = document.getElementById("paste-target");
          ta.value = "";
          ta.focus();
          await navigator.clipboard.writeText(clipText);
        }, p.text);
        const t0 = performance.now();
        await page.keyboard.press("Control+V");
        await page.waitForSelector("#__governworld-paste-guard-host", { state: "attached", timeout: 5000 }).catch(() => null);
        const dt = performance.now() - t0;
        const fieldValue = await page.evaluate(() => document.getElementById("paste-target").value);
        const hostExists = await page.evaluate(() => Boolean(document.getElementById("__governworld-paste-guard-host")));
        if (fieldValue.includes("219-09-9999") || !hostExists) {
          escapes++;
          totalEscapes++;
        }
        latencies.push(dt);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(50);
      }
      pasteResults[p.label] = { ...summarize(latencies), escapes };
      console.log(`  paste ${p.label}: p50=${pasteResults[p.label].p50} ms range=[${pasteResults[p.label].min}, ${pasteResults[p.label].max}] escapes=${escapes}/5`);
    }
    out.paste = { trialsPerSize: 5, totalTrials: 15, totalEscapes, bySize: pasteResults };
  }

  // -------------------------------------------------------------------------
  // STAGE: DOCS (PDF native/scanned/PNG timing + heap + Start Over / Cancel keys)
  // -------------------------------------------------------------------------
  if (shouldRun("docs")) {
    console.log("\n[Run 2 - Docs Stage]");
    const scanPng = makeBitmapPng("HELLO 219-09-9999");
    const docsMatrix = [
      { label: "native-1p", name: "native-1p.pdf", mime: "application/pdf", bytes: await makeNativePdf(1), pages: 1 },
      { label: "native-5p", name: "native-5p.pdf", mime: "application/pdf", bytes: await makeNativePdf(5), pages: 5 },
      { label: "native-20p", name: "native-20p.pdf", mime: "application/pdf", bytes: await makeNativePdf(20), pages: 20 },
      { label: "scanned-5p", name: "scanned-5p.pdf", mime: "application/pdf", bytes: await makeScannedPdf(5, scanPng), pages: 5 },
      { label: "scanned-20p", name: "scanned-20p.pdf", mime: "application/pdf", bytes: await makeScannedPdf(20, scanPng), pages: 20 },
      { label: "single-png", name: "scan.png", mime: "image/png", bytes: scanPng, pages: 1 },
    ];

    const popupCdp = await context.newCDPSession(popup);
    await popupCdp.send("Performance.enable");
    const readHeapMb = async () => {
      const m = await popupCdp.send("Performance.getMetrics");
      const used = m.metrics.find((x) => x.name === "JSHeapUsedSize")?.value ?? 0;
      return Number((used / (1024 * 1024)).toFixed(2));
    };

    const heapBaselineMb = await readHeapMb();
    let heapPeakMb = heapBaselineMb;
    const docTimings = [];

    for (const d of docsMatrix) {
      await clearIndexedDb(popup);
      await popup.reload({ waitUntil: "load" });
      await waitForPopupReady(popup);

      const t0 = performance.now();
      await popup.evaluate(
        ({ b64, fileName, type }) => {
          const input = document.getElementById("doc-file-input");
          const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const dt = new DataTransfer();
          dt.items.add(new File([bin], fileName, { type }));
          input.files = dt.files;
          input.dispatchEvent(new Event("change", { bubbles: true }));
        },
        { b64: d.bytes.toString("base64"), fileName: d.name, type: d.mime }
      );

      await popup.evaluate(() => document.querySelector('[data-tab="documents"]')?.click());
      await popup.waitForFunction(
        () => {
          const w = document.getElementById("doc-workspace");
          const s = document.getElementById("doc-status");
          return (w && !w.hasAttribute("hidden")) || (s && s.classList.contains("status--error"));
        },
        null,
        { timeout: 120_000 }
      );
      const elapsedMs = Number((performance.now() - t0).toFixed(1));
      const findingsCount = await popup.evaluate(() => Number.parseInt((document.getElementById("doc-findings-count")?.textContent || "0").trim(), 10) || 0);
      const h = await readHeapMb();
      if (h > heapPeakMb) heapPeakMb = h;

      const keysBeforeClear = await readIndexedDbKeys(popup);
      await popup.click("#doc-clear-btn").catch(() => {});
      await popup.waitForTimeout(450);
      const keysAfterClear = await readIndexedDbKeys(popup);
      if (TAKE_SCREENSHOTS && modeArg === "p4" && d.label === "native-5p") {
        mkdirSync(SCREENSHOT_DIR, { recursive: true });
        await popup.screenshot({ path: join(SCREENSHOT_DIR, "P4-start-over-clean.png"), fullPage: false });
      }

      docTimings.push({
        label: d.label,
        pages: d.pages,
        stageToFindingsMs: elapsedMs,
        perPageMs: Number((elapsedMs / d.pages).toFixed(1)),
        findings: findingsCount,
        keysBeforeStartOver: keysBeforeClear.length,
        keysAfterStartOver: keysAfterClear.length,
      });
      console.log(
        `  doc ${d.label}: ${elapsedMs} ms, findings=${findingsCount}, keys before/after Start Over=${keysBeforeClear.length}/${keysAfterStartOverLength(keysAfterClear)}`
      );
    }

    // Mid-job Cancel verification at 1, 5, and 20 pages
    const cancelMatrix = [
      { label: "scanned-1p", pages: 1, bytes: await makeScannedPdf(1, scanPng), minKeysBeforeCancel: 1 },
      { label: "scanned-5p", pages: 5, bytes: docsMatrix.find((x) => x.label === "scanned-5p").bytes, minKeysBeforeCancel: 4 },
      { label: "scanned-20p", pages: 20, bytes: docsMatrix.find((x) => x.label === "scanned-20p").bytes, minKeysBeforeCancel: 6 },
    ];
    const cancelRuns = [];
    for (const c of cancelMatrix) {
      await clearIndexedDb(popup);
      await popup.reload({ waitUntil: "load" });
      await waitForPopupReady(popup);
      await popup.evaluate(() => document.querySelector('[data-tab="documents"]')?.click());
      await popup.evaluate(
        ({ b64, fileName, type }) => {
          const input = document.getElementById("doc-file-input");
          const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const dt = new DataTransfer();
          dt.items.add(new File([bin], fileName, { type }));
          input.files = dt.files;
          input.dispatchEvent(new Event("change", { bubbles: true }));
        },
        { b64: c.bytes.toString("base64"), fileName: `${c.label}.pdf`, type: "application/pdf" }
      );
      const pollStart = performance.now();
      let keysBeforeClick = 0;
      while (performance.now() - pollStart < 45_000) {
        const curKeys = await readIndexedDbKeys(popup);
        keysBeforeClick = curKeys.length;
        const progressVisible = await popup.evaluate(() => {
          const p = document.getElementById("doc-progress");
          return Boolean(p && !p.hasAttribute("hidden"));
        });
        if (progressVisible && keysBeforeClick >= c.minKeysBeforeCancel) {
          break;
        }
        await popup.waitForTimeout(80);
      }
      const keysAtCancel = (await readIndexedDbKeys(popup)).length;
      await popup.click("#doc-cancel-btn").catch(() => {});
      await popup.waitForTimeout(1000);
      const keysAfter1000Ms = (await readIndexedDbKeys(popup)).length;
      await popup.waitForTimeout(3500);
      const keysAfterWait = (await readIndexedDbKeys(popup)).length;
      const cancelUi = await popup.evaluate(() => ({
        workspaceHidden: document.getElementById("doc-workspace")?.hasAttribute("hidden") ?? true,
        statusText: (document.getElementById("doc-status-text")?.textContent || "").trim(),
      }));
      cancelRuns.push({
        label: c.label,
        pages: c.pages,
        keysAtCancel,
        keysAfter1000Ms,
        keysAfterWait,
        ...cancelUi,
      });
      console.log(
        `  mid-job Cancel (${c.label}): atCancel=${keysAtCancel} +1s=${keysAfter1000Ms} +4.5s=${keysAfterWait} status="${cancelUi.statusText}" workspaceHidden=${cancelUi.workspaceHidden}`
      );
      if (TAKE_SCREENSHOTS && modeArg === "p4" && c.label === "scanned-20p") {
        mkdirSync(SCREENSHOT_DIR, { recursive: true });
        await popup.screenshot({ path: join(SCREENSHOT_DIR, "P4-cancel-truthful.png"), fullPage: false });
      }
    }
    const mid20 = cancelRuns.find((r) => r.label === "scanned-20p") ?? cancelRuns[cancelRuns.length - 1];

    out.docs = {
      timings: docTimings,
      jsHeapBaselineMb: heapBaselineMb,
      jsHeapPeakMb: heapPeakMb,
      cancelRuns,
      midJobCancel: {
        keysAtCancel: mid20.keysAtCancel,
        keysAfter1500Ms: mid20.keysAfter1000Ms,
        keysAfterWait: mid20.keysAfterWait,
        workspaceHidden: mid20.workspaceHidden,
        statusText: mid20.statusText,
      },
    };
  }

  // -------------------------------------------------------------------------
  // STAGE: OCR NODE (Node Tesseract init + 5 recognition trials)
  // -------------------------------------------------------------------------
  if (shouldRun("ocr")) {
    console.log("\n[Run 2 - Node OCR Stage]");
    const png = makeBitmapPng("HELLO 219-09-9999");
    const tInit0 = performance.now();
    const worker = await createWorker("eng", 1, {
      langPath: join(DIST, "assets", "tessdata"),
      logger: () => {},
    });
    const initMs = Number((performance.now() - tInit0).toFixed(1));
    const recogSamples = [];
    let lastText = "";
    try {
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        const { data } = await worker.recognize(png, undefined, { blocks: true, text: true });
        recogSamples.push(performance.now() - t0);
        lastText = data.text.trim();
      }
    } finally {
      await worker.terminate();
    }
    out.ocrNode = {
      initMs,
      recognition: summarize(recogSamples),
      sampleBitmapText: lastText,
    };
    console.log(`  Node OCR init=${initMs} ms, recog p50=${out.ocrNode.recognition.p50} ms, output=${JSON.stringify(lastText)}`);
  }

  // -------------------------------------------------------------------------
  // STAGE: NETWORK (wire-level local inspection)
  // -------------------------------------------------------------------------
  if (shouldRun("network")) {
    console.log("\n[Run 2 - Wire-level Network Inspection]");
    execFileSync("node", ["scripts/verify-network-inspection.mjs"], {
      cwd: ROOT,
      env: { ...process.env, GW_BROWSER_EXECUTABLE: executablePath },
      stdio: "inherit",
    });
    const externalReqs = recordedRequests.filter((r) => {
      if (
        r.url.startsWith(`http://127.0.0.1:${port}`) ||
        r.url.startsWith(`chrome-extension://${extId}`) ||
        r.url.startsWith(`blob:chrome-extension://${extId}`) ||
        r.url.startsWith(`blob:http://127.0.0.1:${port}`) ||
        r.url.startsWith("data:") ||
        r.url.startsWith("about:")
      ) {
        return false;
      }
      return true;
    });
    const inMemoryOrExtensionUrls = recordedRequests.filter(
      (r) => r.url.startsWith(`blob:`) || r.url.startsWith("data:")
    ).length;
    out.network = {
      driverTotalRequests: recordedRequests.length,
      driverInMemoryBlobOrData: inMemoryOrExtensionUrls,
      driverExternalRequests: externalReqs.length,
      driverExternalSample: externalReqs.slice(0, 10),
      verifyNetworkInspectionPassed: true,
    };
  }
} finally {
  await context.close().catch(() => {});
  server.close();
  rmSync(work, { recursive: true, force: true });
}

function keysAfterStartOverLength(arr) {
  return Array.isArray(arr) ? arr.length : 0;
}

function expectOrRecord(label, cond) {
  if (!cond) {
    out.gateFailures.push(label);
  }
}

const runP1Check = modeArg === "gate" || modeArg === "p1" || modeArg === "p7";
const runP2Check = modeArg === "gate" || modeArg === "p2";
const runP3Check = modeArg === "gate" || modeArg === "p3";
const runP4Check = modeArg === "gate" || modeArg === "p4";
const runP5Check = modeArg === "p5";
const runP6Check = modeArg === "p6";
const runP11Check = modeArg === "p11";
const runPasteCheck = modeArg === "gate";
const runLatencyP7Check = modeArg === "p7";

if (IS_GATE) {
  if (runP11Check) {
    const a = out.scan.p11About;
    if (!a || !a.diagVersionText || a.diagVersionText !== a.manifestVersion) {
      out.gateFailures.push(`P11 About version mismatch: ${JSON.stringify(a)}`);
    }
  }
  if (runP6Check) {
    const p6 = out.scan.windowedP6;
    if (
      !p6 ||
      p6.full10k.findingsCount !== 300 ||
      p6.full10k.sessionFindingsCount !== 300 ||
      p6.full10k.truncated !== false ||
      p6.full10k.findingsTruncated !== false ||
      p6.full10k.windowsTotal < 3 ||
      p6.full10k.windowsScanned !== p6.full10k.windowsTotal ||
      p6.full10k.progressEventsCount < 2 ||
      !p6.incompleteCeiling.truncated ||
      p6.incompleteCeiling.coverageStatus !== "PARTIALLY_SCANNED" ||
      !(p6.incompleteCeiling.incompleteWindows || []).length ||
      !p6.incompleteCeiling.ui.coverageStatement.includes("201")
    ) {
      out.gateFailures.push(`P6 windowed scan check failed: ${JSON.stringify(p6)}`);
    }
  }
  if (runP5Check) {
    const p5 = out.scan.unicodeEmailP5;
    if (!p5 || p5.exactMatched < p5.total || p5.overlayEmailMasks < p5.total || p5.popupCount < p5.total) {
      out.gateFailures.push(`P5 unicode email check failed: ${JSON.stringify(p5)}`);
    }
  }
  if (runP1Check && out.scan.charData && out.scan.charData.detectedCount < 5) {
    out.gateFailures.push(`G3 characterData: ${out.scan.charData.detectedCount}/5`);
  }
  if (runLatencyP7Check && out.scan.charData && out.scan.charData.latencies.max >= 250) {
    out.gateFailures.push(`P7 charData latency max=${out.scan.charData.latencies.max}ms >= 250ms`);
  }
  if (runLatencyP7Check && out.scan.addedNodeControl && out.scan.addedNodeControl.latencies.max >= 250) {
    out.gateFailures.push(`P7 added-node latency max=${out.scan.addedNodeControl.latencies.max}ms >= 250ms`);
  }
  if (
    runP2Check &&
    out.scan.batchRemoval &&
    (out.scan.batchRemoval.ghostCount > 0 ||
      out.scan.batchRemoval.details?.some((d) => !d.survivorsIntact || d.afterCount !== d.beforeCount - 1))
  ) {
    out.gateFailures.push(`P2 ghost masks or survivor loss: ${JSON.stringify(out.scan.batchRemoval)}`);
  }
  if (runP3Check && out.scan.popupBadgeSync && out.scan.popupBadgeSync.syncedCount < 5) {
    out.gateFailures.push(`P3 popup/badge sync: ${out.scan.popupBadgeSync.syncedCount}/5`);
  }
  if (runPasteCheck && out.paste.totalEscapes > 0) {
    out.gateFailures.push(`G2 paste escapes: ${out.paste.totalEscapes}`);
  }
  if (runPasteCheck && out.paste.bySize) {
    for (const [sz, st] of Object.entries(out.paste.bySize)) {
      if (st.p50 >= 100) out.gateFailures.push(`G8 paste dialog ${sz} p50=${st.p50}ms >= 100ms`);
    }
  }
  if (runP4Check && out.docs.timings) {
    for (const d of out.docs.timings) {
      if (d.keysAfterStartOver > 0) out.gateFailures.push(`P4 Start Over leaked ${d.keysAfterStartOver} keys (${d.label})`);
    }
  }
  if (runP4Check && out.docs.cancelRuns) {
    for (const c of out.docs.cancelRuns) {
      if (
        c.keysAfter1000Ms > 0 ||
        c.keysAfterWait > 0 ||
        !c.workspaceHidden ||
        !c.statusText.toLowerCase().includes("cancel")
      ) {
        out.gateFailures.push(
          `P4 cancel failed (${c.label}): keys1s=${c.keysAfter1000Ms} keysWait=${c.keysAfterWait} status="${c.statusText}" hidden=${c.workspaceHidden}`
        );
      }
    }
  } else if (
    runP4Check &&
    out.docs.midJobCancel &&
    (out.docs.midJobCancel.keysAfterWait > 0 || !out.docs.midJobCancel.workspaceHidden)
  ) {
    out.gateFailures.push(`P4 mid-job cancel leaked keys=${out.docs.midJobCancel.keysAfterWait}`);
  }
}

mkdirSync(dirname(RESULTS_PATH), { recursive: true });
writeFileSync(RESULTS_PATH, JSON.stringify(out, null, 2));
console.log(`\nSaved Run 2 results to ${RESULTS_PATH}`);

if (IS_GATE && out.gateFailures.length > 0) {
  console.error("\nRun 2 Gate Failures:", out.gateFailures);
  process.exit(1);
}
