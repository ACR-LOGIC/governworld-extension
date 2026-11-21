# Task Report — Phase 0: Baseline Confirmation & Benchmark Harnesses

## 1. Task ID and title
**Phase 0** — Confirm commit `da2024e` baseline, run full test suite and both benchmark harnesses, record starting numbers, and establish `CHANGELOG.md` and tracking artifacts.

## 2. What changed
- Verified clean baseline repository state at commit `da2024e6aae8f1906c9f9743ce3c8821751cafa1`.
- Added root `CHANGELOG.md` (Standard S4 requirement; none existed in the repository) and directive tracking checklist `docs/releases/DIRECTIVE_GW-DEV-DIRECTIVE-2026-001_CHECKLIST.md`.
- Implemented reproducible Run 1 harness (`tests/benchmark-measured.test.ts`, Node / `happy-dom`, covering `GW-BENCH-2026-001` Sections 4–9) and Run 2 live Chrome harness (`scripts/run2-driver.mjs`, Playwright Chrome for Testing `159.0.8154.6`, CDP closed-shadow-root overlay inspection, real clipboard `Ctrl+V`, IndexedDB key inspection, Document Studio staging, Node Tesseract OCR, and wire-level network audit).
- Reproduced all baseline numbers and gate verdicts from `GW-BENCH-2026-001` v1.0 in [`docs/benchmarks/GW-BENCH-2026-001-RECORD.md`](../../benchmarks/GW-BENCH-2026-001-RECORD.md). No production extension source files (`src/`) were modified in Phase 0.

## 3. Files changed
- **Code / Frontend:** None (baseline observation phase only).
- **Tests / Harnesses:**
  - `tests/benchmark-measured.test.ts` (Run 1 Vitest benchmark harness)
  - `scripts/run2-driver.mjs` (Run 2 live Chrome 159 harness)
- **Documentation / Records:**
  - `CHANGELOG.md` (created per S4)
  - `docs/benchmarks/GW-BENCH-2026-001-RECORD.md`
  - `docs/benchmarks/results-run1.json`
  - `docs/benchmarks/results-run2.json`
  - `docs/benchmarks/results-run2-network.json`
  - `docs/releases/DIRECTIVE_GW-DEV-DIRECTIVE-2026-001_CHECKLIST.md`
  - `docs/releases/directive-reports/Phase-0.md`

## 4. Tests run and results
- **Run 1 harness** (`npx vitest run tests/benchmark-measured.test.ts tests/detection-benchmark.test.ts`): **2/2 files, 14/14 tests passed**.
  - Exact-span recall (22 cases, 16 strict categories): **21/22 (95.5%)**; sole miss: `josé.maría@example.test` (matched `a@example.test` `[31, 45)`). Multi-entity 4-in-1 string: **4/4**.
  - Clean false positives: **0** in `10,120` chars; invalid identifiers flagged: **0/7**.
  - `detect()` p50 throughput: `1 KB 0.161 ms` (`~6.36M chars/s`), `10 KB 1.308 ms`, `100 KB 12.223 ms`, `1 MB 128.145 ms` (`p95 137.767 ms`).
  - Page scan p50: `100` nodes `4.544 ms` (`3/3`), `1,000` nodes `30.413 ms` (`30/30`), `10,000` nodes `95.902 ms` (`87/300` findings, `truncated=true` at `252,944` chars).
  - Delta detection p50: `1` node `0.05 ms`, `100`-node burst `0.301 ms`.
  - Input guard (Run 1): `5` enforcement cases, **0 escapes**; decision p50: `short 0.04 ms`, `0.9 KB 0.098 ms`, `7.5 KB 0.891 ms`, `68 KB 5.502 ms`.
  - Doc token path p50: `1p 0.082 ms`, `5p 0.332 ms`, `20p 1.174 ms`, `50p 2.815 ms`; `5p` PDF export `39.62 ms`, `0` `/Font` dictionaries, `0` test secrets in raw output bytes; box clamp `(0,0,18,18)` and `(191,91,9,9)`.
  - Static privacy scan: `39` files scanned, `1` local tessdata `fetch` (`src/document-pipeline/ocr.ts:76`), `0` forbidden calls, `host_permissions = []`.
- **Run 2 live harness** (`node scripts/run2-driver.mjs --mode=baseline`, Chrome for Testing `159.0.8154.6`): **completed exit 0** (`results-run2.json` + `results-run2-network.json`):
  - `characterData` in-place edit: **0/5** detected; added-node control: **3/3** (`p50 = 683.6 ms`, range `670.7–684.6 ms`).
  - Batch node-1 removal (`P2`): **3/3 ghost NPI remains** (`before=3, after=3`).
  - Popup/badge incremental sync (`P3`): **0/5 synced**.
  - Paste guard (`Ctrl+V`, real clipboard): **0/15 escapes** (`short p50=24.19 ms`, `10 KB p50=17.65 ms`, `68 KB p50=33.26 ms`).
  - Document studio & IndexedDB Start Over retention (`n=1` per size): `native-1p 2251 ms (2 findings, 3->2 keys)`, `native-5p 635.2 ms (10, 11->10)`, `native-20p 41109.2 ms (40, 41->40)`, `scanned-5p 18067.6 ms (0*, 11->10)`, `scanned-20p 61341.4 ms (0*, 41->40)`, `single-png 3966.5 ms (1*, 3->2)`; JS heap `2.72 MB -> 12.02 MB` (native RSS unmeasured until `M5`).
  - Node Tesseract OCR: `init 374.9 ms`, `recog p50 54.64 ms`, `sampleBitmapText "AELLO 213-893-3333"` (synthetic bitmap artifact, not real-scan OCR accuracy).
  - Network inspection (LOCAL mode scope): `verify-network-inspection.mjs` passed (`5` requests, `0` external, `0` telemetry, `0` canary leaks); `driverExternalRequests = 0` in `results-run2-network.json`.
- **Full test suite** (`npm test -- --maxWorkers=2`): **124/124 test files, 2,312/2,312 tests passed** (`44.88s`). *(Note: running bare `npm test` with `vitest.config.ts` default `maxWorkers: 4` hits Windows worker fork spawn timeouts; `--maxWorkers=2` runs the complete 124-file suite cleanly without skipping any test.)*
- **Static / existing gates:**
  - `npm run typecheck`: PASS (exit 0)
  - `npm run lint:security`: PASS (exit 0)
  - `npm run sync:sidepanel:check`: PASS (`sidepanel.html` & `sidepanel.css` ok)
  - `npm run verify:digests`: PASS (`6/6` digests verified)

## 5. Documentation updated
- **Updated / created:** `CHANGELOG.md`, `docs/benchmarks/GW-BENCH-2026-001-RECORD.md`, `docs/releases/DIRECTIVE_GW-DEV-DIRECTIVE-2026-001_CHECKLIST.md`, `docs/releases/directive-reports/Phase-0.md`.
- **Checked and N/A for Phase 0 (no production behavior/UI changed):** `README.md`, `docs/DEV-MODE-INSTALL.md`, `docs/ENTERPRISE_DEPLOYMENT.md`, `docs/STORE-PUBLISHING.md`, `docs/ocr-languages.md`, `AGENTS.md`, `CONTRIBUTING.md`, `SECURITY.md`, in-product UI copy.

## 6. Frontend evidence
S3 statement: Phase 0 is a baseline verification and benchmark-harness establishment phase with **zero production source (`src/`) or UI changes**; live browser screenshots begin with UI/masking fixes in Phase 1.

## 7. Known limitations
- Confirmed baseline defects matching `GW-BENCH-2026-001`: `P1` (`0/5` `characterData`), `P2` (`3/3` ghost NPI), `P3` (`0/5` popup/badge sync), `P4` (`2/10/40` surviving IndexedDB keys on Start Over; baseline batches `::page::`/`::preview::` writes after OCR so pre-staging cancel happens at 1 key), `P5` (`josé.maría@example.test` miss), `P6` (`87/300` truncated at `250,000` chars).
- On Windows (`win32`, Node `22.22.2`), multi-page offscreen PDF rendering and Tesseract worker initialization run slower (`41.1s` `native-20p`, `61.3s` `scanned-20p`) than the Linux 4-vCPU VM in `GW-BENCH-2026-001 v1.0`; JS detection and live paste guard latency are equal or faster (`30.4 ms` 1k-node scan, `17.7–33.3 ms` paste dialog).
- Expressly unmeasured until Phase 6: real-scan OCR accuracy (`M1`), live submit/Enter (`M2`), DOCX timing (`M3`), SPA/cross-origin iframe (`M4`), peak OS native RSS (`M5`), MANAGE-mode wire audit (`C9`), label-free prose name recall (`C4`), and finished-PDF OCR export re-decode (`P9`).
