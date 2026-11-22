// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Section 4 CI Hard Gates Driver (G1–G9) — Decision D5 / Task C1.
// All gates are hard failures (exit 1); zero warnings or silent skips.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINES_PATH = join(ROOT, "docs", "benchmarks", "ci-baselines.json");

const VITEST_BIN = join("node_modules", "vitest", "vitest.mjs");
const TSC_BIN = join("node_modules", "typescript", "bin", "tsc");
const ESLINT_BIN = join("node_modules", "eslint", "bin", "eslint.js");

const ALL_GATES = ["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9"];
const VALID_GATES = new Set(ALL_GATES);

const args = process.argv.slice(2);
const onlyArg = args.find((a) => a.startsWith("--only="))?.slice(7).trim() || "";
const skipBuild = args.includes("--skip-build");

if (onlyArg && !VALID_GATES.has(onlyArg)) {
  console.error(`Unknown gate "${onlyArg}". Valid gates: ${ALL_GATES.join(", ")}`);
  process.exit(1);
}

const targetGates = onlyArg ? [onlyArg] : [...ALL_GATES];
const isTargeted = Boolean(onlyArg);

function runNode(scriptRel, scriptArgs = [], extraEnv = {}) {
  execFileSync(process.execPath, [join(ROOT, scriptRel), ...scriptArgs], {
    stdio: "inherit",
    cwd: ROOT,
    env: {
      ...process.env,
      ...extraEnv,
    },
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const baselinesDoc = readJson(BASELINES_PATH);
const maxRatio = baselinesDoc.maxRegressionRatio;
const { baselines, hardLimits } = baselinesDoc;

const tmpDir = mkdtempSync(join(tmpdir(), "gw-ci-gates-"));
const run1Out = join(tmpDir, "results-run1.json");
const run2Out = join(tmpDir, "results-run2.json");

const gateResults = [];
let hasFailure = false;

function recordGate(gate, passed, detail) {
  gateResults.push({ gate, passed, detail });
  if (!passed) hasFailure = true;
}

try {
  // 1. Static parity & security checks (run cleanly whenever running full CI gates)
  if (!isTargeted) {
    console.log("\n=== CI Hard Gates: Static Parity, Typecheck, Security Lint & Build ===");
    runNode(TSC_BIN, ["--noEmit"]);
    runNode(ESLINT_BIN, ["scripts/", "build.mjs"]);
    runNode("scripts/sync-sidepanel.mjs", ["--check"]);
    runNode("scripts/sync-version.mjs", ["--check"]);
    runNode("scripts/verify-release-digests.mjs", []);
  }

  const needsBuild =
    !skipBuild &&
    (!isTargeted || ["G2", "G3", "G8", "G9"].includes(onlyArg));
  if (needsBuild) {
    console.log("\n=== CI Hard Gates: Building Chromium dist/ ===");
    runNode("build.mjs", []);
  }

  if (!isTargeted) {
    runNode(VITEST_BIN, ["run", "--maxWorkers=2", "tests/dist-manifest.test.ts", "tests/offline-assets.test.ts", "tests/version-parity.test.ts"]);
  }

  const needsRun1 =
    !isTargeted || ["G1", "G2", "G6", "G7", "G9"].includes(onlyArg);
  let run1 = null;
  let run1Err = null;
  if (needsRun1) {
    console.log("\n=== CI Hard Gates: Run 1 Strict Benchmark ===");
    try {
      runNode(VITEST_BIN, ["run", "tests/benchmark-measured.test.ts"], {
        GW_BENCH_STRICT: "1",
        GW_BENCH_STRICT_COVERAGE: "1",
        GW_BENCH_OUT: run1Out,
      });
    } catch (err) {
      run1Err = err instanceof Error ? err.message : String(err);
      hasFailure = true;
    }
    if (existsSync(run1Out)) run1 = readJson(run1Out);
  }

  const needsRun2Scan = !isTargeted || onlyArg === "G3";
  const needsRun2Paste = !isTargeted || ["G2", "G8", "G9"].includes(onlyArg);
  let run2 = null;
  let run2Err = null;
  if (needsRun2Scan || needsRun2Paste) {
    const stages = [];
    if (needsRun2Scan) stages.push("scan");
    if (needsRun2Paste) stages.push("paste");
    console.log(`\n=== CI Hard Gates: Live Chrome Run 2 (--stage=${stages.join(",")}) ===`);
    try {
      runNode("scripts/run2-driver.mjs", ["--mode=gate", `--stage=${stages.join(",")}`, `--out=${run2Out}`]);
    } catch (err) {
      run2Err = err instanceof Error ? err.message : String(err);
      hasFailure = true;
    }
    if (existsSync(run2Out)) run2 = readJson(run2Out);
  }

  // Evaluate each selected gate strictly — never swallow failures
  for (const gate of targetGates) {
    try {
      if (gate === "G1") {
        runNode(VITEST_BIN, ["run", "--maxWorkers=2", "tests/detection-benchmark.test.ts"]);
        const recall = run1?.exactSpanRecall;
        const ok =
          Boolean(recall) &&
          recall.exactMatched === recall.total &&
          recall.total === 22 &&
          Array.isArray(recall.misses) &&
          recall.misses.length === 0 &&
          recall.multiEntityMatched === recall.multiEntityTotal;
        recordGate(
          "G1",
          ok,
          ok
            ? `exact-span ${recall.exactMatched}/${recall.total} (100%), multi-entity ${recall.multiEntityMatched}/${recall.multiEntityTotal}, 0 misses`
            : `exact-span recall failure: ${JSON.stringify(recall ?? run1Err)}`
        );
      } else if (gate === "G2") {
        runNode(VITEST_BIN, [
          "run",
          "--maxWorkers=2",
          "tests/paste-guard.test.ts",
          "tests/paste-enforcement.test.ts",
          "tests/paste-shield-adversarial.test.ts",
        ]);
        const r1Escapes = run1?.inputGuard?.escapes ?? -1;
        const r2Trials = run2?.paste?.totalTrials ?? 0;
        const r2Escapes = run2?.paste?.totalEscapes ?? -1;
        const ok = r1Escapes === 0 && r2Trials === 15 && r2Escapes === 0;
        recordGate(
          "G2",
          ok,
          ok
            ? `Run 1 escapes=0/5; live Chrome escapes=0/${r2Trials}`
            : `Input guard escape detected (run1=${r1Escapes}, run2=${r2Escapes}/${r2Trials}${run2Err ? `; ${run2Err}` : ""})`
        );
      } else if (gate === "G3") {
        runNode(VITEST_BIN, [
          "run",
          "--maxWorkers=2",
          "tests/content-rescan.test.ts",
          "tests/e2e-audit-tier2-boundaries.test.ts",
          "tests/adversarial-m2-rescan.test.ts",
        ]);
        const cd = run2?.scan?.charData;
        const ok =
          Boolean(cd) &&
          cd.detectedCount === 5 &&
          cd.trials === 5 &&
          typeof cd.latencies?.max === "number" &&
          cd.latencies.max <= hardLimits.charDataMaxMs;
        recordGate(
          "G3",
          ok,
          ok
            ? `live characterData ${cd.detectedCount}/${cd.trials} masked (p50=${cd.latencies.p50} ms, max=${cd.latencies.max} ms <= ${hardLimits.charDataMaxMs} ms)`
            : `live characterData failed: ${JSON.stringify(cd ?? run2Err)}`
        );
      } else if (gate === "G4") {
        runNode(VITEST_BIN, ["run", "--maxWorkers=2", "tests/redaction-output.test.ts", "tests/redaction-golden-gate.test.ts"]);
        recordGate("G4", true, "golden deterministic maskValue, text redaction, and applyBoxes clamping identical");
      } else if (gate === "G5") {
        runNode(VITEST_BIN, ["run", "--maxWorkers=2", "tests/export-secret-recovery-gate.test.ts"]);
        recordGate("G5", true, "finished PDF re-decoded via pdf-lib & pdfjs-dist with 0 fonts, 0 text, and 0 unredacted pixels");
      } else if (gate === "G6") {
        const p50 = run1?.detectThroughput?.["1MB"]?.p50;
        const ok = typeof p50 === "number" && p50 < hardLimits.detect1MbP50Ms;
        recordGate(
          "G6",
          ok,
          ok
            ? `detect 1 MB p50 = ${p50} ms < ${hardLimits.detect1MbP50Ms} ms`
            : `detect 1 MB p50 = ${p50} ms exceeds ${hardLimits.detect1MbP50Ms} ms cap`
        );
      } else if (gate === "G7") {
        const s1k = run1?.pageScan?.["1000"];
        const s10k = run1?.pageScan?.["10000"];
        const ok =
          typeof s1k?.p50 === "number" &&
          s1k.p50 < hardLimits.scan1kP50Ms &&
          s10k?.findings === 300 &&
          s10k?.truncated === false;
        recordGate(
          "G7",
          ok,
          ok
            ? `1,000-node scan p50 = ${s1k.p50} ms < ${hardLimits.scan1kP50Ms} ms; 10,000-node findings=${s10k.findings}/300`
            : `scan gate failed (1k p50=${s1k?.p50}, 10k=${JSON.stringify(s10k)})`
        );
      } else if (gate === "G8") {
        const bySize = run2?.paste?.bySize || {};
        const entries = Object.entries(bySize);
        const bad = entries.filter(([, st]) => typeof st?.p50 !== "number" || st.p50 >= hardLimits.pasteDialogP50Ms);
        const ok = entries.length >= 3 && bad.length === 0;
        const summary = entries.map(([k, st]) => `${k}=${st.p50}ms`).join(", ");
        recordGate(
          "G8",
          ok,
          ok
            ? `live paste dialog p50 (${summary}) < ${hardLimits.pasteDialogP50Ms} ms`
            : `paste dialog p50 exceeded ${hardLimits.pasteDialogP50Ms} ms (${summary})`
        );
      } else if (gate === "G9") {
        const detect1Mb = run1?.detectThroughput?.["1MB"]?.p50;
        const scan1k = run1?.pageScan?.["1000"]?.p50;
        const pasteValues = Object.values(run2?.paste?.bySize || {}).map((st) => st.p50);
        const maxPaste = pasteValues.length ? Math.max(...pasteValues) : NaN;

        const detectLimit = Number((baselines.detect1MbP50Ms * maxRatio).toFixed(2));
        const scanLimit = Number((baselines.scan1kP50Ms * maxRatio).toFixed(2));
        const pasteLimit = Number((baselines.pasteDialogP50Ms * maxRatio).toFixed(2));

        const detectOk = typeof detect1Mb === "number" && detect1Mb <= detectLimit;
        const scanOk = typeof scan1k === "number" && scan1k <= scanLimit;
        const pasteOk = typeof maxPaste === "number" && !Number.isNaN(maxPaste) && maxPaste <= pasteLimit;
        const ok = detectOk && scanOk && pasteOk;
        recordGate(
          "G9",
          ok,
          `detect1MB=${detect1Mb}/${detectLimit}ms (${detectOk ? "OK" : "FAIL"}), scan1k=${scan1k}/${scanLimit}ms (${scanOk ? "OK" : "FAIL"}), pasteMax=${maxPaste}/${pasteLimit}ms (${pasteOk ? "OK" : "FAIL"})`
        );
      }
    } catch (err) {
      recordGate(gate, false, err instanceof Error ? err.message : String(err));
    }
  }
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

console.log("\n=== Section 4 CI Hard Gate Summary ===");
for (const r of gateResults) {
  console.log(`  [${r.passed ? "PASS" : "FAIL"}] ${r.gate}: ${r.detail}`);
}

if (hasFailure || gateResults.length !== targetGates.length) {
  console.error("\nCI Hard Gates FAILED.");
  process.exit(1);
}
console.log(`\nAll ${gateResults.length}/${targetGates.length} CI hard gate(s) PASSED.`);
