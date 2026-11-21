# Benchmark Record — GW-BENCH-2026-001

**Directive:** `GW-DEV-DIRECTIVE-2026-001` (v1.0)  
**Baseline Commit:** `da2024e6aae8f1906c9f9743ce3c8821751cafa1`  
**Reference Benchmark Document:** `GW-BENCH-2026-001` v1.0 (Linux VM, 4 vCPU shared, 7.7 GB RAM, Node `v24.22.1`, Chrome for Testing `159.0.8154.6`)  
**Phase 0 Reproduction Environment:** Windows (`win32`), Node `v22.22.2`, Playwright Chrome for Testing `159.0.8154.6`  
**Raw Results:** [`docs/benchmarks/results-run1.json`](results-run1.json) · [`docs/benchmarks/results-run2.json`](results-run2.json) · [`docs/benchmarks/results-run2-network.json`](results-run2-network.json)  
**Test Data Policy:** Synthetic data only (RFC 2606 `.test` domains, never-issued SSNs such as `219-09-9999`, documented test cards). Zero real PII/PHI.

> This is a living record maintained under Standard S4 across Phases 0–7. Reference values from `GW-BENCH-2026-001 v1.0` are preserved alongside every new measured baseline and candidate run; **native process RSS** is never merged with JavaScript heap figures (`P14` / `M5`), and synthetic-bitmap OCR output is never presented as a real-scan accuracy measurement (`P8` / `M1`).

---

## 1. Consolidated Gate Matrix (Phase 0 Baseline)

| Gate | Requirement (`GW-DEV-DIRECTIVE-2026-001` §4) | `GW-BENCH-2026-001 v1.0` Reference | Phase 0 Baseline (`da2024e`) | Status | Target Task |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **G1** | Exact-span recall = 100% on strict corpus (22 cases, 16 categories) | 95.5% (21/22; miss `josé.maría@example.test`) | **Baseline:** 95.5% (21/22) → **After P5/P12/C1:** **`100% (22/22)`**, `0` misses, `4/4` multi-entity; enforced in `npm run gates:ci` (break test exit `1`) | PASS (Hard CI Gate G1) | `P5`, `P12`, `C1` (Done) |
| **G2** | Zero escapes in input guard | 0 escapes: 5 cases (Run 1); 15 trials (Run 2) | **0 escapes**: 5/5 cases (Run 1); 15/15 trials (Run 2) + 57/57 unit/adversarial tests; enforced in `npm run gates:ci` (break test exit `1`) | PASS (Hard CI Gate G2; C8/M2 extend later) | `C1` (Done), `C8`, `M2` |
| **G3** | No missed changed text (live `characterData`, mask <= ~2s, 5/5) | 0/5 edits in 12s (control 3/3 in 829–859 ms, p50 841 ms) | **Baseline:** 0/5 edits → **After P1/P7/C1:** **5/5 `characterData` masked** (`p50 62.3 ms`, `max 63.7 ms <= 2000 ms`); enforced in `npm run gates:ci` (break test exit `1`) | PASS (Hard CI Gate G3) | `P1`, `P7`, `P12`, `C1` (Done) |
| **G4** | Redaction results identical | Exact match | `tests/redaction-output.test.ts` (17/17) + `tests/redaction-golden-gate.test.ts` (3/3); enforced in `npm run gates:ci` (break test exit `1`) | PASS (Hard CI Gate G4) | `C1` (Done) |
| **G5** | No recoverable test secrets in export | 0 `/Font` dicts; 0 secrets in raw bytes | `tests/export-secret-recovery-gate.test.ts` re-decodes finished PDF via `pdf-lib` (`0` fonts/metadata/strings), `pdfjs-dist` (`0` text items), and XObject RGB pixels (`0` non-black pixels in redacted boxes); enforced in `npm run gates:ci` (break test exit `1`; OCR re-decode under `P9`) | PASS (Hard CI Gate G5; OCR under `P9`) | `C1` (Done), `P9`, `C5` |
| **G6** | Detection of 1 MB text < 200 ms p50 | 125.6 ms p50 (variance re-run 116.6 ms) | **Baseline:** 128.145 ms p50 → **C1 standalone (`gates:ci`):** **`115.918–125.174 ms p50`** (`< 200 ms`; break test `337.018 ms` exit `1`) | PASS (Hard CI Gate G6) | `C1` (Done), `C10` |
| **G7** | 1,000-node page scan < 75 ms p50 | 40.7 ms p50 (variance re-run 42.6 ms) | **Baseline:** 30.413 ms p50 → **C1 standalone (`gates:ci`):** **`26.908–27.685 ms p50`** (`< 75 ms`, `30/30` 1k, `300/300` 10k; break test `112.383 ms` exit `1`) | PASS (Hard CI Gate G7) | `C1` (Done), `C10` |
| **G8** | Paste dialog < 100 ms p50 | 47–59 ms p50 across 3 sizes | **C1 live Chrome (`gates:ci`):** `short=24.97 ms`, `10KB=19.58 ms`, `68KB=32.98 ms` (`< 100 ms`; break test `138.11–150.81 ms` exit `1`) | PASS (Hard CI Gate G8) | `C1` (Done), `C10` |
| **G9** | Performance regression > 20% fails CI | Baseline tracking required | Recorded in `docs/benchmarks/ci-baselines.json` (`125.6 -> 150.72 ms`, `42.0 -> 50.4 ms`, `50.0 -> 60.0 ms`); enforced in `npm run gates:ci` (break test `150.935 ms > 150.72 ms` exit `1`) | PASS (Hard CI Gate G9) | `C1` (Done), `C10` |

### Additional Confirmed Defects (Phase 0 Reproduction)

| Finding | Reference (`GW-BENCH-2026-001`) | Phase 0 Baseline Observed | Target Task |
| :--- | :--- | :--- | :--- |
| Large-page completeness (10,000 nodes) | 87/300 findings (truncated at `maxVisibleChars=250,000`) | **Baseline:** 87/300 findings (`252,944` chars, `truncated=true`, `p50=95.902 ms`) → **After P6 (`results-run1.json` / `results-p6.json`):** Run 1 **`300/300` findings** (`869,190` chars across `4` windows, `truncated=false`, `p50=331.326 ms`); Chrome 159 live **`300/300` findings** across `4/4` windows (`5` progress events, `879,221` chars, `"All 4 of 4 windows scanned"`); 200-window ceiling explicitly names `Window 201` & sets `PARTIALLY_SCANNED` | `P6` (D4, Fixed & verified) |
| Batch `rescan_seg_0` collision (`P2`) | 3/3 ghost NPI mask after node-1 removal | **Baseline:** 3/3 ghost NPI remains (`beforeCount=3`, `afterCount=3`) → **After P2 (`results-p2.json`):** **0/3 ghost masks** (`before=3, after=2, survivors=true` across 3/3 trials) | `P2` (Fixed & verified) |
| Stale popup & badge counts (`P3`) | SW session 0 findings in 2/3 trials (1/3 intermittent) | **Baseline:** 0/5 synced (`sessionFindings=0`, `badge=""`, `popup=0`) → **After P3 (`results-p3.json`):** **5/5 synced** (`sessionFindings=1`, `badgeText="1"`, `popupCount=1` on all 5 trials) | `P3` (Fixed & verified) |
| Staged-byte cleanup on Start Over & Cancel (`P4`) | Surviving `::page::`/`::preview::` keys: 2 / 10 / 40 across 1/5/20p; mid-job cancel at 8.1 s ran to completion (40 keys) | **Baseline:** 2 / 10 / 40 surviving keys after Start Over across 1/5/20p → **After P4 (`results-p4.json`):** Start Over leaves **`0` keys** across all tested sizes (`1/5/20p` PDF + PNG); mid-job Cancel aborts OCR/key growth within 1 s (`1p`: `1->0`, `5p`: `5->0`, `20p`: `7->0`, stays `0` after +4.5 s, truthful cancelled UI) | `P4` (Fixed & verified) |
| Version parity (`P11`) | `v0.4.1` git tag vs `0.4.0` package.json/README | **Baseline:** `0.4.0` out of sync across manifests/README → **After P11 (`results-p11.json`):** Single source `package.json = 0.4.1` synced across 9 targets + About UI `#diag-version-value = 0.4.1`; CI `sync:version:check` fails (`exit 1`) on drift | `P11` (Fixed & verified) |
| Vacuous / weak tests (`P12`) | Boundary test B5.5 asserts `52 > 50`; overlap recall | **Baseline:** Vacuous/inline-stub tests in 6 files + `.includes()` overlap in `tests/detection-benchmark.test.ts` → **After P12:** All replaced with live `content.ts`/`mutation.ts`/`pasteGuard.ts` assertions, Unicode email + exact-span matching in `detection-benchmark.test.ts`, and fail-on-revert proven against P1 (`6/101` failures, exit `1`) and P2 (`2/15` failures, exit `1`) | `P12` (Fixed & verified) |
| Name dictionary size & accent bug (`P10`/`A4`) | ~2.05 MB (~91% of `dist/content.js`), `Hernández` mis-parses as first name | `dist/content.js` = `2,252,700` bytes; baseline confirmed | `A4`, `P10` |

---

## 2. Phase 0 Measured Details

### Run 1 — Node / happy-dom (`tests/benchmark-measured.test.ts`, `npx vitest run tests/benchmark-measured.test.ts tests/detection-benchmark.test.ts`)

- **Exact-span recall:** `21/22` (`95.5%`), multi-entity 4-in-1 string: `4/4`. Sole miss: `"josé.maría@example.test"` matched `"a@example.test"` `[31, 45)`.
- **False positives:** Clean prose `0` false positives in `10,120` characters across strict categories; `0` of `7` checksum/format-invalid identifiers flagged.
- **`detect()` throughput:**
  - `1 KB` (`1,024` chars): `p50 = 0.161 ms`, `p95 = 0.171 ms` (`~6,360,248 chars/s`)
  - `10 KB` (`10,240` chars): `p50 = 1.308 ms`, `p95 = 1.751 ms` (`~7,828,746 chars/s`)
  - `100 KB` (`102,400` chars): `p50 = 12.223 ms`, `p95 = 14.324 ms` (`~8,377,649 chars/s`)
  - `1 MB` (`1,048,576` chars): `p50 = 128.145 ms`, `p95 = 137.767 ms` (`~8,182,731 chars/s`)
- **Initial DOM scan (`extractVisibleText` + `buildScanText` + `detect`):**
  - `100` nodes (`8,592` chars): `p50 = 4.544 ms`, `p95 = 10.105 ms`, `3/3` findings (`truncated: false`)
  - `1,000` nodes (`86,919` chars): `p50 = 30.413 ms`, `p95 = 38.332 ms`, `30/30` findings (`truncated: false`)
  - `10,000` nodes (`252,944` chars read): `p50 = 95.902 ms`, `p95 = 99.987 ms`, `87/300` findings (`truncated: true`)
- **Incremental delta detection:** `1` node `p50 = 0.05 ms` (`p95 = 0.134 ms`); `100`-node burst `p50 = 0.301 ms` (`p95 = 0.416 ms`).
- **Input guard (Run 1):** `5` enforcement cases, `0` escapes. Decision latency: `short p50 = 0.04 ms`, `0.9 KB p50 = 0.098 ms`, `7.5 KB p50 = 0.891 ms`, `68 KB p50 = 5.502 ms` (`p95 = 6.096 ms`).
- **Document token detection & export (Run 1):** Token detection `1p p50 = 0.082 ms`, `5p p50 = 0.332 ms`, `20p p50 = 1.174 ms`, `50p p50 = 2.815 ms`. `5p` PDF export: `39.62 ms`, `0` `/Font` dictionaries, `0` secret strings in raw output bytes; box clamp `(0,0,18,18)` and `(191,91,9,9)`.
- **Static privacy scan:** `39` source files scanned; `1` `fetch` call site (`src/document-pipeline/ocr.ts:76` local tessdata fetch), `0` XHR/WebSocket/`sendBeacon` calls, `manifest.json` `host_permissions` empty (`[]`).

### Run 2 — Live Chrome for Testing `159.0.8154.6` (`node scripts/run2-driver.mjs --mode=baseline`)

- **Scan / Mutation stages:**
  - `characterData` in-place edit (`5` trials): `0/5` detected/masked.
  - Added-node control (`3` trials): `3/3` detected/masked (`p50 = 683.6 ms`, `p95 = 684.6 ms`, range `670.7–684.6 ms`).
  - Batch node-1 removal (`3` trials): `3/3` ghost NPI mask remaining (`beforeCount = 3`, `afterCount = 3`).
  - Incremental popup/badge sync (`5` trials): `0/5` synced (`sessionFindings = 0`, `badgeText = ""`, `popupCount = 0`).
- **Paste guard (`15` real clipboard Ctrl+V trials):** `0/15` escapes (`short p50 = 24.19 ms [16.92–131.58]`; `10 KB p50 = 17.65 ms [17.24–27.60]`; `68 KB p50 = 33.26 ms [31.18–40.80]`).
- **Documents & Retention (`n = 1` per size):**
  - `native-1p`: `2,251.0 ms`, findings `2`, IndexedDB keys before/after Start Over `3 -> 2`
  - `native-5p`: `635.2 ms`, findings `10`, IndexedDB keys before/after Start Over `11 -> 10`
  - `native-20p`: `41,109.2 ms`, findings `40`, IndexedDB keys before/after Start Over `41 -> 40`
  - `scanned-5p`: `18,067.6 ms`, findings `0*`, IndexedDB keys before/after Start Over `11 -> 10`
  - `scanned-20p`: `61,341.4 ms`, findings `0*`, IndexedDB keys before/after Start Over `41 -> 40`
  - `single-png`: `3,966.5 ms`, findings `1*`, IndexedDB keys before/after Start Over `3 -> 2`
  - *Note on synthetic-bitmap OCR:* In Node, bundled Tesseract read the synthetic 5×7 bitmap `"HELLO 219-09-9999"` as `"AELLO 213-893-3333"` (`init = 374.9 ms`, `recog p50 = 54.64 ms`, `p95 = 117.39 ms`), which matched 1 phone candidate on `single-png` and `0` on the PDFs. This is an artifact of the synthetic bitmap font and SHALL NOT be cited as real-scan OCR accuracy (`P8` / `M1`).
  - *Extension JS Heap (`Performance.getMetrics`):* baseline `2.72 MB`, peak `12.02 MB`. Native OS RSS is separate and unmeasured until `M5`.
  - *Mid-job Cancel variance note:* In Run 2 `scanned-20p`, `midJobCancel` waited 30s for `>= 6` IndexedDB keys before clicking `#doc-cancel-btn`; because baseline `runDocumentPreview` batches key staging (`putDocBytes`) at the end of OCR (`impl.ts:198-216`), `keysAtCancel` was still `1` (pre-staging) when clicked after the 30s wait (`docId` not yet assigned, matching `GW-BENCH-2026-001 §7.4`'s observation on pre-processing cancel vs active mid-OCR cancel). Task `P4` will make OCR cancellation + per-page key abort verifiable directly during active OCR.
- **Wire-level network inspection (LOCAL mode scope only):**
  - `scripts/verify-network-inspection.mjs`: `5` requests captured, `0` external/cloud requests, `0` telemetry, `0` canary leaks across page scan, wizard analysis, and clipboard redaction in LOCAL mode. In the full `--stage=all` Run 2 run, Playwright also observed `52` local `blob:` / `data:` URLs generated during in-memory document rendering; isolated wire check ([`results-run2-network.json`](results-run2-network.json)) confirms `driverTotalRequests = 5`, `driverExternalRequests = 0`. MANAGE mode and full document OCR wire inspection remain unmeasured until `C9`.
  - *Platform variance vs `GW-BENCH-2026-001`:* JS detection and DOM/paste timings are comparable or faster on this host (`30.4 ms` vs `40.7 ms` 1k-node scan; `17.7–33.3 ms` vs `47–59 ms` paste dialog), whereas multi-page offscreen PDF rendering + Tesseract initialization on Windows (`win32`, Node `22.22.2`) runs slower (`41.1s` vs `1.27s` on `native-20p`; `61.3s` vs `6.93s` on `scanned-20p`). Every functional defect and gate verdict matches `GW-BENCH-2026-001` identically.

---

## 3. Expressly Unmeasured Until Scheduled Tasks Run

Per `GW-BENCH-2026-001 §13.3` and `GW-DEV-DIRECTIVE-2026-001` Section 5:
- Real-scan OCR accuracy (printed, handwritten, rotated, low-res) — **Target: `P8 / M1`**
- Live submit / Enter interception — **Target: `P13 / M2`** (and rich-text / shadow-DOM / drag-drop under `C8`)
- DOCX end-to-end processing timing — **Target: `P14 / M3`**
- Live SPA navigation and cross-origin iframe scanning — **Target: `P14 / M4`**
- Peak OS native RSS during OCR (separate from JS heap) — **Target: `P14 / M5`**
- MANAGE-mode pairing, policy lockdown, fail-closed offline continuity, and wire heartbeat inspection — **Target: `C9`**
- Label-free clinical prose name recall — **Target: `C4`**
- PDF/image export metadata stripping and finished-PDF OCR re-decode — **Target: `C5`, `P9`**
- Multi-zoom/DPI/rotation redaction-box alignment — **Target: `C6`**
