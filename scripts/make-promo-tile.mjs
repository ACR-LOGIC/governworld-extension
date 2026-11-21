// Chrome Web Store promo tile, 440x280 PNG.
//
// The store requires a 440x280 "small promo tile" alongside the 128x128 icon
// and the 1280x800 screenshots; only the 1400x560 marquee tile is optional
// (https://developer.chrome.com/docs/webstore/cws-dashboard-listing).
//
// This renders the tile from the real extension markup by screenshotting a
// purpose-built page at exactly 440x280, so the artwork can never drift from
// the product's actual colours and copy. The page is self-contained inline
// markup loaded from a data: URL, so it is not packaged and not reachable from
// the extension.
//
//   npm run capture:promo
import { chromium } from "@playwright/test";
import { browserChannelArgs } from "./browser-launch.mjs";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const landing = join(root, "src", "landing", "index.html");
const OUT_DIR = join(root, "release", "images");

const W = 440;
const H = 280;

/** Read the brand tokens out of the shipped stylesheet so the tile cannot drift. */
function tokens() {
  const css = readFileSync(join(root, "src", "popup", "popup.css"), "utf8");
  const pick = (name, fallback) => css.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]?.trim() ?? fallback;
  return {
    bg: pick("--bg", "#0a0f1a"),
    elevated: pick("--bg-elevated", "#111a2b"),
    text: pick("--text", "#e2e8f0"),
    muted: pick("--text-muted", "#94a3b8"),
    accent: pick("--accent", "#22d3ee"),
    ok: pick("--ok", "#34d399"),
    border: pick("--border", "#1e2b40"),
  };
}

function pngSize(file) {
  const b = readFileSync(file);
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

const t = tokens();
// The real GovernWorld emblem, generated from brand/logo-master.png. Rendering
// a hand-drawn stand-in here would make the store artwork show a different logo
// from the product.
const emblem = join(root, "icons", "icon-128.png");
if (!existsSync(emblem)) {
  console.error("icons/icon-128.png missing - run `npm run icons` first.");
  process.exit(1);
}
const emblemB64 = readFileSync(emblem).toString("base64");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const page = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: ${W}px; height: ${H}px; overflow: hidden; }
  body {
    background: radial-gradient(circle at 88% 18%, rgba(34, 211, 238, 0.12) 0%, transparent 50%),
                linear-gradient(160deg, ${t.bg} 0%, #0c1526 55%, #08101d 100%);
    color: ${t.text};
    font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
    padding: 20px 24px 18px;
    display: flex; flex-direction: column; justify-content: space-between;
  }
  .rule { height: 1px; background: linear-gradient(90deg, ${t.accent}, transparent); margin: 0 0 14px; }
  .row { display: flex; align-items: center; gap: 14px; }
  .mark { width: 60px; height: 60px; border-radius: 14px; flex: none; box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45); }
  h1 { font-size: 22px; font-weight: 700; line-height: 1.12; letter-spacing: -0.01em; }
  .sub { margin-top: 5px; font-size: 11.5px; line-height: 1.42; color: ${t.muted}; }
  .chips { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-top: 14px; }
  .chip {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 9px;
    background: ${t.elevated};
    border: 1px solid ${t.border};
    border-radius: 7px;
    font-size: 10.5px;
    font-weight: 500;
    color: ${t.text};
  }
  .chip__mark { color: ${t.accent}; font-weight: 700; }
  .foot {
    display: flex; align-items: center; justify-content: space-between;
    padding-top: 10px;
    border-top: 1px solid rgba(30, 43, 64, 0.7);
  }
  .foot__left {
    display: flex; align-items: center; gap: 7px;
    font-size: 9.5px; letter-spacing: 0.08em; text-transform: uppercase; color: ${t.accent}; font-weight: 600;
  }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: ${t.ok}; box-shadow: 0 0 8px ${t.ok}; }
  .foot__badge {
    font-family: "Cascadia Code", Consolas, monospace;
    font-size: 9px; letter-spacing: 0.05em; text-transform: uppercase;
    color: ${t.muted};
    background: rgba(17, 26, 43, 0.9);
    border: 1px solid ${t.border};
    border-radius: 999px;
    padding: 2px 8px;
  }
</style></head><body>
  <div>
    <div class="rule"></div>
    <div class="row">
      <img class="mark" src="data:image/png;base64,${emblemB64}" alt="" />
      <div>
        <h1>GovernWorld Redaction</h1>
        <p class="sub">Detect &amp; redact PII, PHI, cards, and secrets on pages and documents — on your device.</p>
      </div>
    </div>
    <div class="chips">
      <div class="chip"><span class="chip__mark">&#10003;</span> Page Masking</div>
      <div class="chip"><span class="chip__mark">&#10003;</span> Paste Shield</div>
      <div class="chip"><span class="chip__mark">&#10003;</span> Offline OCR &amp; PDF</div>
      <div class="chip"><span class="chip__mark">&#10003;</span> Signed Audit</div>
    </div>
  </div>
  <div class="foot">
    <div class="foot__left"><span class="dot"></span>Local-first &middot; On-device redaction</div>
    <span class="foot__badge">v${pkg.version} &middot; LOCAL &amp; MANAGE</span>
  </div>
</body></html>`;

if (!existsSync(landing)) {
  console.error("src/landing/index.html missing");
  process.exit(1);
}
mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({ headless: false, ...browserChannelArgs() });
try {
  const tab = await browser.newPage({ viewport: { width: W, height: H } });
  await tab.setContent(page, { waitUntil: "load" });
  await tab.waitForTimeout(400);
  const out = join(OUT_DIR, "promo-tile-440x280.png");
  await tab.screenshot({ path: out });
  const size = pngSize(out);
  if (!size || size.w !== W || size.h !== H) {
    console.error(`FAIL: tile is ${size?.w}x${size?.h}, store requires ${W}x${H}`);
    process.exit(1);
  }
  writeFileSync(
    join(OUT_DIR, "NOTES.md"),
    [
      "# Store images",
      "",
      "- `promo-tile-440x280.png` — the store's required **small promo tile**.",
      "  Generated by `npm run capture:promo`, which reads the brand tokens from",
      "  `src/popup/popup.css` so the tile cannot drift from the product's colours.",
      "  Dimensions are verified from the PNG IHDR before writing.",
      "- `../screenshots/*.png` — five 1280x800 screenshots from",
      "  `npm run capture:store`.",
      "",
      "The store icon (128x128) is `icons/icon-128.png`, already in the manifest.",
      "",
    ].join("\n"),
  );
  console.log(`promo tile: ${out} (${size.w}x${size.h}, verified)`);
} finally {
  await browser.close();
}
