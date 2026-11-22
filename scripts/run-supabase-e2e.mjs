// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// CLI runner for GovernWorld Supabase Pairing E2E & Section 8 Acceptance Tests.
// Supports --mode=mock|live, --tier=all|tier1|tier2|tier3|tier4, --filter=<pattern>, --headed, --build.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VITEST_BIN = join(ROOT, "node_modules", "vitest", "vitest.mjs");
const E2E_CONFIG = "tests/e2e-supabase/vitest.e2e.config.mjs";
const DIST_MANIFEST = join(ROOT, "dist", "manifest.json");

const TIER_MAP = new Map([
  ["all", []],
  ["tier1", ["tests/e2e-supabase/tier1-feature-coverage.e2e.spec.ts"]],
  ["tier2", ["tests/e2e-supabase/tier2-boundary-security.e2e.spec.ts"]],
  ["tier3", ["tests/e2e-supabase/tier3-pairwise-combinations.e2e.spec.ts"]],
  ["tier4", ["tests/e2e-supabase/tier4-real-world-e2e.e2e.spec.ts"]],
]);

function hasNonEmptyEnv(name) {
  const val = process.env[name];
  return typeof val === "string" && val.trim().length > 0;
}

function parseCliArgs(argv) {
  let mode = "mock";
  let tier = "all";
  let filter = "";
  let headed = false;
  let forceBuild = false;
  let showHelp = false;

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      showHelp = true;
    } else if (arg.startsWith("--mode=")) {
      mode = arg.slice("--mode=".length).trim();
    } else if (arg.startsWith("--tier=")) {
      tier = arg.slice("--tier=".length).trim();
    } else if (arg.startsWith("--filter=")) {
      filter = arg.slice("--filter=".length);
    } else if (arg === "--headed") {
      headed = true;
    } else if (arg === "--build") {
      forceBuild = true;
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }

  return { mode, tier, filter, headed, forceBuild, showHelp };
}

function printUsage() {
  console.log(
    [
      "Usage: node scripts/run-supabase-e2e.mjs [options]",
      "",
      "Options:",
      "  --mode=mock|live                    Execution mode (default: mock)",
      "  --tier=all|tier1|tier2|tier3|tier4  Test tier subset (default: all)",
      "  --filter=<pattern>                  Vitest test name pattern (-t)",
      "  --headed                            Launch Chromium headed instead of --headless=new",
      "  --build                             Rebuild dist/ via build.mjs before running",
      "  -h, --help                          Show this help message",
    ].join("\n"),
  );
}

const opts = parseCliArgs(process.argv.slice(2));

if (opts.showHelp) {
  printUsage();
  process.exit(0);
}

if (opts.mode !== "mock" && opts.mode !== "live") {
  console.error(`Invalid --mode="${opts.mode}". Expected "mock" or "live".`);
  process.exit(1);
}

if (!TIER_MAP.has(opts.tier)) {
  console.error(`Invalid --tier="${opts.tier}". Expected one of: ${[...TIER_MAP.keys()].join(", ")}.`);
  process.exit(1);
}

if (!existsSync(VITEST_BIN)) {
  console.error(`Missing Vitest binary at ${VITEST_BIN}. Run npm install first.`);
  process.exit(1);
}

const distMissing = !existsSync(DIST_MANIFEST);
if (opts.forceBuild || distMissing) {
  console.log(
    opts.forceBuild
      ? "[run-supabase-e2e] --build specified: running node build.mjs..."
      : "[run-supabase-e2e] dist/manifest.json missing: running node build.mjs...",
  );
  execFileSync(process.execPath, [join(ROOT, "build.mjs")], {
    stdio: "inherit",
    cwd: ROOT,
  });
}

if (opts.mode === "live") {
  const hasJwt = hasNonEmptyEnv("GW_E2E_ADMIN_JWT");
  const hasEmailPass = hasNonEmptyEnv("GW_E2E_ADMIN_EMAIL") && hasNonEmptyEnv("GW_E2E_ADMIN_PASSWORD");
  if (!hasJwt && !hasEmailPass) {
    console.error(
      "[run-supabase-e2e] FAIL-CLOSED: --mode=live requires GW_E2E_ADMIN_JWT or both GW_E2E_ADMIN_EMAIL and GW_E2E_ADMIN_PASSWORD.",
    );
    process.exit(1);
  }
  if (!existsSync(DIST_MANIFEST)) {
    console.error("[run-supabase-e2e] FAIL-CLOSED: dist/manifest.json is required for --mode=live.");
    process.exit(1);
  }
}

const targetFiles = TIER_MAP.get(opts.tier) ?? [];
for (const relFile of targetFiles) {
  if (!existsSync(join(ROOT, relFile))) {
    console.error(`[run-supabase-e2e] Target tier file does not exist: ${relFile}`);
    process.exit(1);
  }
}

console.log(`[run-supabase-e2e] Mode: ${opts.mode} | Tier: ${opts.tier} | Headed: ${opts.headed ? "yes" : "no (--headless=new)"}`);
console.log("[run-supabase-e2e] Coverage note: Section 8 A22 (Azure cross-backend parity) is DEFERRED (Section 7.6).");

const vitestArgs = ["run", "--config", E2E_CONFIG, ...targetFiles];
if (opts.filter.length > 0) {
  vitestArgs.push("-t", opts.filter);
}

const childEnv = {
  ...process.env,
  GW_SUPABASE_E2E_MODE: opts.mode,
  GW_SUPABASE_E2E_HEADED: opts.headed ? "1" : "0",
};

const result = spawnSync(process.execPath, [VITEST_BIN, ...vitestArgs], {
  stdio: "inherit",
  cwd: ROOT,
  env: childEnv,
});

if (result.error) {
  console.error("[run-supabase-e2e] Failed to execute Vitest:", result.error);
  process.exit(1);
}

process.exit(typeof result.status === "number" ? result.status : 1);
