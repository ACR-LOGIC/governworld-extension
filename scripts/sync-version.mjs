#!/usr/bin/env node
// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Single version source of truth: package.json -> all extension manifests,
// TypeScript constants, landing/privacy HTML, README.md, and AGENTS.md.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv.includes("--write") ? "write" : "check";

const pkgPath = join(ROOT, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const VERSION = String(pkg.version || "").trim();

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(VERSION)) {
  console.error(`FAIL: Invalid version "${VERSION}" in package.json`);
  process.exit(1);
}

const mismatched = [];

function checkOrWriteText(relPath, replacer) {
  const fullPath = join(ROOT, relPath);
  const before = readFileSync(fullPath, "utf8");
  const after = replacer(before);
  if (after === before) return;
  if (mode === "write") {
    writeFileSync(fullPath, after, "utf8");
    console.log(`SYNCED   ${relPath} -> ${VERSION}`);
  } else {
    mismatched.push(relPath);
    console.error(`MISMATCH ${relPath} does not match package.json (${VERSION})`);
  }
}

function checkOrWriteJson(relPath, updater) {
  checkOrWriteText(relPath, (raw) => {
    const parsed = JSON.parse(raw);
    const updated = updater(parsed);
    if (!updated) return raw;
    const newline = raw.includes("\r\n") ? "\r\n" : "\n";
    return JSON.stringify(parsed, null, 2).replace(/\n/g, newline) + (raw.endsWith("\n") ? newline : "");
  });
}

// 1. package-lock.json
checkOrWriteJson("package-lock.json", (obj) => {
  let changed = false;
  if (obj.version !== VERSION) {
    obj.version = VERSION;
    changed = true;
  }
  if (obj.packages?.[""] && obj.packages[""].version !== VERSION) {
    obj.packages[""].version = VERSION;
    changed = true;
  }
  return changed;
});

// 2. Chromium & Firefox manifests
for (const mf of ["manifest.json", "manifest.firefox.json"]) {
  checkOrWriteJson(mf, (obj) => {
    if (obj.version === VERSION) return false;
    obj.version = VERSION;
    return true;
  });
}

// 3. Runtime constant src/api/config.ts
checkOrWriteText("src/api/config.ts", (raw) =>
  raw.replace(
    /export const CURRENT_EXTENSION_VERSION = "[^"]+";/,
    `export const CURRENT_EXTENSION_VERSION = "${VERSION}";`
  )
);

// 4. Landing page spec table src/landing/index.html
checkOrWriteText("src/landing/index.html", (raw) =>
  raw.replace(
    /(<tr><td>Version<\/td><td>)[^<]+(<\/td><\/tr>)/,
    `$1${VERSION}$2`
  )
);

// 5. Privacy policy page src/popup/privacy.html
checkOrWriteText("src/popup/privacy.html", (raw) =>
  raw
    .replace(/(Extension v)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g, `$1${VERSION}`)
    .replace(/(GovernWorld Chrome Extension \(<code>v)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(<\/code>\))/g, `$1${VERSION}$2`)
);

// 6. README.md active version badge, release link, intro, and modes line
checkOrWriteText("README.md", (raw) =>
  raw
    .replace(/Version-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-blue\.svg/g, `Version-${VERSION}-blue.svg`)
    .replace(/(releases\/tag\/v)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g, `$1${VERSION}`)
    .replace(/(The \*\*GovernWorld Extension\*\* \(`v)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(`\))/g, `$1${VERSION}$2`)
    .replace(/(GovernWorld Extension v)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?( supports)/g, `$1${VERSION}$2`)
);

// 7. AGENTS.md current release version line
checkOrWriteText("AGENTS.md", (raw) =>
  raw.replace(
    /(Current release version: `)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(`\.)/,
    `$1${VERSION}$2`
  )
);

if (mode === "check" && mismatched.length > 0) {
  console.error(`\nVersion parity check FAILED (${mismatched.length} file(s) out of sync with package.json=${VERSION}). Run \`npm run sync:version\`.`);
  process.exit(1);
}

if (mode === "check") {
  console.log(`ok\tAll version targets match package.json (${VERSION})`);
}
