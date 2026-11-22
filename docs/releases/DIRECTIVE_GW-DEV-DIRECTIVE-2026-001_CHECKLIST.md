# Master Checklist & Sign-off — Directive GW-DEV-DIRECTIVE-2026-001

**Directive:** GW-DEV-DIRECTIVE-2026-001 (Version 1.0, 21 November 2026)  
**Baseline Commit:** `da2024e6aae8f1906c9f9743ce3c8821751cafa1`  
**Integration Branch:** `directive/GW-DEV-DIRECTIVE-2026-001`  

Tick a box only when the task's Definition of Done (S9) is fully met and its S6 report exists.

## Section 6 — Master checklist

- [x] **Phase 0** — Baseline confirmed and reported. Ref: `docs/releases/directive-reports/Phase-0.md` (commit `task/phase-0-baseline`)
- [x] **S1–S10** — Standards followed for every task; Windows host `G6`/`G8`/`G9` variance vs Linux VM baselines noted under S7. Ref: `docs/releases/directive-reports/`
- [x] **A1** Auto-mask single names, default OFF (D1) Ref: `docs/releases/directive-reports/A1.md` (branch `task/A1-auto-mask-single-names`)
- [x] **A2** Pinned tab picker, no auto-follow (D2) Ref: `docs/releases/directive-reports/A2.md` (branch `task/A2-pinned-tab-picker`)
- [x] **A3** Medical dictionary, separate toggle, lazy (D3) Ref: `tests/medical-dictionary-a3.test.ts`
- [x] **A4** Accent folding, lazy-load, measured trim only Ref: `tests/name-accent-lazy-a4-a5.test.ts` (`dist/content.js` 250.0 kb)
- [x] **A5** Boost-only rule, never a detection gate Ref: `tests/name-accent-lazy-a4-a5.test.ts`
- [x] **P1** `characterData` blind spot fixed Ref: `docs/releases/directive-reports/P1.md` (branch `task/P1-characterdata-blind-spot`)
- [x] **P2** Unique segment IDs, no ghost masks Ref: `docs/releases/directive-reports/P2.md` (branch `task/P2-unique-segment-ids`)
- [x] **P3** Popup / badge counts current Ref: `docs/releases/directive-reports/P3.md` (branch `task/P3-incremental-scan-result`)
- [x] **P4** Staged bytes cleared; Cancel stops OCR Ref: `docs/releases/directive-reports/P4.md` (branch `task/P4-cancel-and-staged-bytes`)
- [x] **P5** Unicode email, exact-span 100% Ref: `docs/releases/directive-reports/P5.md` (branch `task/P5-unicode-email-exact-span`)
- [x] **P6** Chunked scanning, complete coverage (D4) Ref: `docs/releases/directive-reports/P6.md` (branch `task/P6-chunked-windowed-scanning`)
- [x] **P7** Adaptive debounce, under 250 ms Ref: `docs/releases/directive-reports/P7.md` (branch `task/P7-adaptive-debounce`)
- [x] **P8 / M1** Real-scan OCR accuracy measured Ref: `docs/benchmarks/results-m1-m5.json` (`342.53 ms`, conf `86`, `4/5` serif scan)
- [x] **P9** Finished-PDF re-decode gate Ref: `tests/export-secret-recovery-gate.test.ts`
- [x] **P10** Completed via A4 Ref: `tests/name-accent-lazy-a4-a5.test.ts`
- [x] **P11** Single version source, CI-checked Ref: `docs/releases/directive-reports/P11.md` (branch `task/P11-single-version-source`)
- [x] **P12** Vacuous tests replaced, fail-on-revert proven Ref: `docs/releases/directive-reports/P12.md` (branch `task/P12-audit-vacuous-tests`)
- [x] **P13 / M2** Submit / Enter measured live Ref: `docs/benchmarks/results-m1-m5.json` (`228.73 ms`, `submittedAfterEnter=false`)
- [x] **P14 / M3** DOCX timing measured Ref: `docs/benchmarks/results-m1-m5.json` (`1p=15.17ms`, `5p=2.85ms`, `20p=3.65ms`)
- [x] **P14 / M4** SPA / iframe scanning measured Ref: `docs/benchmarks/results-m1-m5.json` (`scanAck=true`)
- [x] **P14 / M5** Peak RSS measured, reported separately from heap Ref: `docs/benchmarks/results-m1-m5.json` (`Node RSS 108.71 MB` vs `Heap 51.13 MB`; `Chrome WorkingSet 1871.56 MB` vs `JS Heap 5.94 MB`)
- [x] **C1 / G1–G9** All gates hard failures in CI (D5) Ref: `docs/releases/directive-reports/C1.md` (branch `task/C1-ci-hard-gates`)
- [x] **C2** Startup purge + staged-data display and purge button Ref: `docs/releases/directive-reports/C2.md` (branch `task/C2-startup-purge-and-studio-audit`)
- [x] **C3** Coverage warnings in popup Ref: `docs/releases/directive-reports/C3.md` (branch `task/C3-coverage-warnings`)
- [x] **C4** Label-free name recall measured Ref: `tests/name-recall-c4.test.ts`
- [x] **C5** Export metadata verified / stripped Ref: `tests/export-metadata-c5.test.ts`
- [x] **C6** Box alignment matrix passed Ref: `tests/box-alignment-matrix-c6.test.ts`
- [x] **C7** Low OCR confidence = uncertain, never clean Ref: `tests/ocr-confidence-c7.test.ts`
- [x] **C8** Rich-text / shadow-DOM guard matrix, 0 escapes Ref: `tests/guard-matrix-c8.test.ts`
- [x] **C9** MANAGE mode verified fail-closed in test tenant Ref: `tests/pairing-and-heartbeat.test.ts`, `tests/m3-fail-closed-hardening.test.ts`
- [x] **C10** Budgets recorded; over-20% regression fails CI Ref: `docs/benchmarks/ci-baselines.json`, `scripts/run-ci-gates.mjs`
- [x] **C11** Review-flow accessibility complete Ref: `tests/review-a11y-c11.test.ts`
- [x] **Documentation** — `README.md`, `CHANGELOG.md`, `docs/`, `AGENTS.md` / `CONTRIBUTING.md` / `SECURITY.md` as applicable, in-product text, and benchmark record all fully updated to final state (S4). Ref: `CHANGELOG.md`, `docs/benchmarks/GW-BENCH-2026-001-RECORD.md`
- [x] **Final benchmarks** — Both benchmark passes re-run in Phase 7; final numbers recorded (`npm test -- --maxWorkers=2` 140/140 + `ux-redesign-flows` 13/13 = 141/141 files, 2,420/2,420 tests; `gates:ci` G1–G5 & G7 pass on Windows, G6/G8/G9 Windows host variance vs Linux baseline noted; `M1`–`M5` recorded in `docs/benchmarks/results-m1-m5.json`). Ref: `docs/benchmarks/GW-BENCH-2026-001-RECORD.md`

## Section 7 — Sign-off

> By signing, each person attests to the statement beside their name. Do not sign a statement that is not true; raise the gap under S7 instead.

**Developer:** I attest that every ticked task in Section 6 meets the Definition of Done (S9), that every S6 report is complete and truthful, that no known regression, limitation, or scope cut exists that is not recorded in those reports, and that all documentation listed in S4 is fully updated to the final state of the code.

Name: \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_  Signature: \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_  Date: \_\_\_\_\_\_\_\_\_\_\_\_\_\_

**Andres (acceptance):** I accept the handover as reported, including any S8-approved cuts recorded in Section 6 and the task reports.

Name: \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_  Signature: \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_  Date: \_\_\_\_\_\_\_\_\_\_\_\_\_\_
