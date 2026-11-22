// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Measures M1 (real-scan OCR), M2 (live Submit/Enter), M3 (DOCX timing),
// M4 (SPA + same/cross-origin iframe), and M5 (Native OS RSS vs JS Heap).

import { createServer } from "node:http";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { chromium } from "playwright";
import { createWorker } from "tesseract.js";
import mammoth from "mammoth";

const root = process.cwd();
const executablePath = chromium.executablePath();
const work = mkdtempSync(join(tmpdir(), "gw-m1-m5-"));

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function buildStoredZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    localParts.push(local, data);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centralParts.push(central);
    offset += local.length + data.length;
  }
  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralBuf, eocd]);
}

function buildSyntheticDocx(pages) {
  const paras = [];
  for (let p = 1; p <= pages; p++) {
    paras.push(`<w:p><w:r><w:t>Page ${p}: Patient SSN 219-09-9999, Email test.user@example.test</w:t></w:r></w:p>`);
  }
  const docXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras.join("")}</w:body></w:document>`;
  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `</Types>`;
  const rels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`;
  return buildStoredZip([
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(rels, "utf8") },
    { name: "word/document.xml", data: Buffer.from(docXml, "utf8") },
  ]);
}

function getChromeRssBytes() {
  try {
    const out = execSync(
      'powershell -NoProfile -Command "(Get-Process chrome -ErrorAction SilentlyContinue | Measure-Object -Property WorkingSet64 -Sum).Sum"',
      { encoding: "utf8", timeout: 5000 }
    ).trim();
    return Number(out) || 0;
  } catch {
    return 0;
  }
}

const results = {
  generatedAt: new Date().toISOString(),
  M1_realScanOcr: null,
  M2_liveSubmitEnter: null,
  M3_docxTiming: {},
  M4_spaAndIframe: null,
  M5_memorySeparate: null,
};

// M3: DOCX timing (1p, 5p, 20p)
for (const pages of [1, 5, 20]) {
  const buf = buildSyntheticDocx(pages);
  const t0 = performance.now();
  const { value } = await mammoth.extractRawText({ buffer: buf });
  const ms = Number((performance.now() - t0).toFixed(2));
  const ssnCount = (value.match(/219-09-9999/g) || []).length;
  const emailCount = (value.match(/test\.user@example\.test/g) || []).length;
  results.M3_docxTiming[`${pages}p`] = {
    extractMs: ms,
    chars: value.length,
    ssnCount,
    emailCount,
  };
}

// Local HTTP servers for M2 + M4 (two origins for cross-origin iframe)
const server1 = createServer((req, res) => {
  if (req.url === "/same-frame") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<!doctype html><html><body><p>Same-origin frame SSN: 219-09-9999</p></body></html>");
    return;
  }
  if (req.url === "/submit-test") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      `<!doctype html><html><body><form id="f" action="/submitted"><input id="i" type="text"/><button id="sub" type="submit">Send</button></form><script>window.__submitted=false;document.getElementById("f").addEventListener("submit",e=>{e.preventDefault();window.__submitted=true;});</script></body></html>`
    );
    return;
  }
  if (req.url === "/ocr-scan") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!doctype html><html><body style="margin:0;background:#f7f5ef;font-family:Georgia,serif;color:#1b1b1b;padding:80px;">
      <div style="width:900px;border:1px solid #bbb;padding:48px;background:#fffdf8;">
        <h1 style="font-size:32px;margin:0 0 24px;">CLINICAL INTAKE RECORD</h1>
        <p style="font-size:24px;line-height:1.8;">Patient: Maria Gonzalez</p>
        <p style="font-size:24px;line-height:1.8;">DOB: 04/22/1990</p>
        <p style="font-size:24px;line-height:1.8;">SSN: 219-09-9999</p>
        <p style="font-size:24px;line-height:1.8;">Email: jane.doe@example.test</p>
        <p style="font-size:24px;line-height:1.8;">Phone: 555-234-5678</p>
      </div></body></html>`);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<!doctype html><html><body>
    <div id="app"><p>Initial route: Phone 555-234-5678</p></div>
    <iframe id="same" src="/same-frame"></iframe>
    <iframe id="xorigin" src="http://127.0.0.1:__PORT2__/x-frame"></iframe>
  </body></html>`);
});

const server2 = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<!doctype html><html><body><p>Cross-origin secret: 219-09-9999</p></body></html>");
});

await new Promise((r) => server1.listen(0, "localhost", r));
await new Promise((r) => server2.listen(0, "127.0.0.1", r));
const port1 = server1.address().port;
const port2 = server2.address().port;

const extDir = join(work, "ext");
cpSync(resolve(root, "dist"), extDir, { recursive: true });
const mfPath = join(extDir, "manifest.json");
const mf = JSON.parse(readFileSync(mfPath, "utf8"));
mf.host_permissions = [`http://localhost:${port1}/*`];
writeFileSync(mfPath, JSON.stringify(mf, null, 2));

const context = await chromium.launchPersistentContext(join(work, "profile"), {
  headless: false,
  executablePath,
  args: [
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ],
});

try {
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 25_000 }));
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");

  // M1: Realistic scanned typography PNG + bundled Tesseract
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto(`http://localhost:${port1}/ocr-scan`, { waitUntil: "load" });
  const pngPath = join(work, "realistic-scan.png");
  await page.screenshot({ path: pngPath });

  const worker = await createWorker("eng", 1, {
    langPath: resolve(root, "vendor/tessdata"),
    gzip: true,
    cacheMethod: "none",
  });
  const tOcr0 = performance.now();
  const ocrRes = await worker.recognize(readFileSync(pngPath));
  const ocrMs = Number((performance.now() - tOcr0).toFixed(2));
  await worker.terminate();

  const text = ocrRes.data.text || "";
  const expectedTokens = ["Maria Gonzalez", "04/22/1990", "219-09-9999", "jane.doe@example.test", "555-234-5678"];
  const matchedTokens = expectedTokens.filter((tok) => text.includes(tok));
  results.M1_realScanOcr = {
    ocrMs,
    confidenceMean: Number((ocrRes.data.confidence ?? 0).toFixed(2)),
    matchedCount: matchedTokens.length,
    totalExpected: expectedTokens.length,
    matchedTokens,
  };

  // M2: Live Enter / Submit guard
  await page.goto(`http://localhost:${port1}/submit-test`, { waitUntil: "load" });
  await page.bringToFront();
  const submitTabId = await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const nonExt = tabs.filter((t) => !t.url?.startsWith("chrome://") && !t.url?.startsWith("chrome-extension://"));
    return (nonExt.find((t) => t.active) ?? nonExt[nonExt.length - 1])?.id ?? null;
  });
  await sw.evaluate(async (tabId) => {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  }, submitTabId);

  await page.fill("#i", "SSN 219-09-9999");
  const tEnter0 = performance.now();
  await page.press("#i", "Enter");
  await page.waitForTimeout(150);
  const enterLatencyMs = Number((performance.now() - tEnter0).toFixed(2));
  const shadowGuardCount = await page.evaluate(() => {
    return [...document.querySelectorAll("*")].filter((el) => el.shadowRoot?.textContent?.includes("Sensitive")).length;
  });
  const submittedAfterEnter = await page.evaluate(() => window.__submitted === true);
  results.M2_liveSubmitEnter = {
    enterLatencyMs,
    interceptedByGuard: shadowGuardCount > 0 || !submittedAfterEnter,
    shadowGuardCount,
    submittedAfterEnter,
  };

  // M4: SPA + same-origin / cross-origin iframe
  await page.goto(`http://localhost:${port1}/`, { waitUntil: "load" });
  await page.setContent(`<!doctype html><html><body>
    <div id="app"><p>Initial route: Phone 555-234-5678</p></div>
    <iframe id="same" src="http://localhost:${port1}/same-frame"></iframe>
    <iframe id="xorigin" src="http://127.0.0.1:${port2}/x-frame"></iframe>
  </body></html>`);
  await page.waitForTimeout(300);
  await page.bringToFront();
  const spaTabId = await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const nonExt = tabs.filter((t) => !t.url?.startsWith("chrome://") && !t.url?.startsWith("chrome-extension://"));
    return (nonExt.find((t) => t.active) ?? nonExt[nonExt.length - 1])?.id ?? null;
  });
  await sw.evaluate(async (tabId) => {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  }, spaTabId);
  const scanRes = await sw.evaluate(async (tabId) => {
    return await chrome.tabs.sendMessage(tabId, {
      type: "SCAN_PAGE",
      requestId: "m4_1",
      mode: "local",
      settings: {
        mode: "local",
        enabledCategories: ["email", "phone", "ssn"],
        maxVisibleChars: 250000,
        maxNodeChars: 10000,
        maskPlaceholders: false,
        sessionTimeoutMs: 0,
      },
    });
  }, spaTabId).catch(() => null);

  await page.evaluate(() => {
    history.pushState({}, "", "/next-route");
    document.getElementById("app").innerHTML = "<p>Next route: Email spa.user@example.test</p>";
  });
  await page.waitForTimeout(250);
  const overlayHostsAfterSpa = await page.evaluate(
    () => document.querySelectorAll("[data-gw-scan-overlay]").length
  );

  results.M4_spaAndIframe = {
    scanAck: scanRes !== null,
    overlayHostsAfterSpa,
    crossOriginIframePresent: true,
  };

  // M5: Native OS RSS vs JS Heap
  const perfMetrics = await cdp.send("Performance.getMetrics");
  const jsHeap = perfMetrics.metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? 0;
  const nodeMem = process.memoryUsage();
  results.M5_memorySeparate = {
    note: "Native OS RSS and JS Heap are strictly separate metrics",
    nodeProcessRssMB: Number((nodeMem.rss / (1024 * 1024)).toFixed(2)),
    nodeJsHeapUsedMB: Number((nodeMem.heapUsed / (1024 * 1024)).toFixed(2)),
    chromeRendererJsHeapMB: Number((jsHeap / (1024 * 1024)).toFixed(2)),
    chromeProcessesTotalWorkingSetMB: Number((getChromeRssBytes() / (1024 * 1024)).toFixed(2)),
  };
} finally {
  await context.close();
  server1.close();
  server2.close();
  rmSync(work, { recursive: true, force: true });
}

writeFileSync(resolve(root, "docs/benchmarks/results-m1-m5.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
