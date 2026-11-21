# Master Checklist & Sign-off — Directive GW-DEV-DIRECTIVE-2026-001

**Directive:** GW-DEV-DIRECTIVE-2026-001 (Version 1.0, 21 November 2026)  
**Baseline Commit:** `da2024e6aae8f1906c9f9743ce3c8821751cafa1`  
**Integration Branch:** `directive/GW-DEV-DIRECTIVE-2026-001`  

Tick a box only when the task's Definition of Done (S9) is fully met and its S6 report exists.

## Section 6 — Master checklist

- [x] **Phase 0** — Baseline confirmed and reported. Ref: `docs/releases/directive-reports/Phase-0.md` (commit `task/phase-0-baseline`)
- [ ] **S1–S10** — Standards followed for every task; any S7 question or S8 cut recorded. Ref: `docs/releases/directive-reports/`
- [ ] **A1** Auto-mask single names, default OFF (D1) Ref: `docs/releases/directive-reports/A1.md`
- [ ] **A2** Pinned tab picker, no auto-follow (D2) Ref: `docs/releases/directive-reports/A2.md`
- [ ] **A3** Medical dictionary, separate toggle, lazy (D3) Ref: `docs/releases/directive-reports/A3.md`
- [ ] **A4** Accent folding, lazy-load, measured trim only Ref: `docs/releases/directive-reports/A4.md`
- [ ] **A5** Boost-only rule, never a detection gate Ref: `docs/releases/directive-reports/A5.md`
- [x] **P1** `characterData` blind spot fixed Ref: `docs/releases/directive-reports/P1.md` (branch `task/P1-characterdata-blind-spot`)
- [x] **P2** Unique segment IDs, no ghost masks Ref: `docs/releases/directive-reports/P2.md` (branch `task/P2-unique-segment-ids`)
- [x] **P3** Popup / badge counts current Ref: `docs/releases/directive-reports/P3.md` (branch `task/P3-incremental-scan-result`)
- [x] **P4** Staged bytes cleared; Cancel stops OCR Ref: `docs/releases/directive-reports/P4.md` (branch `task/P4-cancel-and-staged-bytes`)
- [x] **P5** Unicode email, exact-span 100% Ref: `docs/releases/directive-reports/P5.md` (branch `task/P5-unicode-email-exact-span`)
- [x] **P6** Chunked scanning, complete coverage (D4) Ref: `docs/releases/directive-reports/P6.md` (branch `task/P6-chunked-windowed-scanning`)
- [x] **P7** Adaptive debounce, under 250 ms Ref: `docs/releases/directive-reports/P7.md` (branch `task/P7-adaptive-debounce`)
- [ ] **P8 / M1** Real-scan OCR accuracy measured Ref: `docs/releases/directive-reports/M1.md`
- [ ] **P9** Finished-PDF re-decode gate Ref: `docs/releases/directive-reports/P9.md`
- [ ] **P10** Completed via A4 Ref: `docs/releases/directive-reports/A4.md`
- [ ] **P11** Single version source, CI-checked Ref: `docs/releases/directive-reports/P11.md`
- [ ] **P12** Vacuous tests replaced, fail-on-revert proven Ref: `docs/releases/directive-reports/P12.md`
- [ ] **P13 / M2** Submit / Enter measured live Ref: `docs/releases/directive-reports/M2.md`
- [ ] **P14 / M3** DOCX timing measured Ref: `docs/releases/directive-reports/M3.md`
- [ ] **P14 / M4** SPA / iframe scanning measured Ref: `docs/releases/directive-reports/M4.md`
- [ ] **P14 / M5** Peak RSS measured, reported separately from heap Ref: `docs/releases/directive-reports/M5.md`
- [ ] **C1 / G1–G9** All gates hard failures in CI (D5) Ref: `docs/releases/directive-reports/C1.md`
- [ ] **C2** Startup purge + staged-data display and purge button Ref: `docs/releases/directive-reports/C2.md`
- [ ] **C3** Coverage warnings in popup Ref: `docs/releases/directive-reports/C3.md`
- [ ] **C4** Label-free name recall measured Ref: `docs/releases/directive-reports/C4.md`
- [ ] **C5** Export metadata verified / stripped Ref: `docs/releases/directive-reports/C5.md`
- [ ] **C6** Box alignment matrix passed Ref: `docs/releases/directive-reports/C6.md`
- [ ] **C7** Low OCR confidence = uncertain, never clean Ref: `docs/releases/directive-reports/C7.md`
- [ ] **C8** Rich-text / shadow-DOM guard matrix, 0 escapes Ref: `docs/releases/directive-reports/C8.md`
- [ ] **C9** MANAGE mode verified fail-closed in test tenant Ref: `docs/releases/directive-reports/C9.md`
- [ ] **C10** Budgets recorded; over-20% regression fails CI Ref: `docs/releases/directive-reports/C10.md`
- [ ] **C11** Review-flow accessibility complete Ref: `docs/releases/directive-reports/C11.md`
- [ ] **Documentation** — `README.md`, `CHANGELOG.md`, `docs/`, `AGENTS.md` / `CONTRIBUTING.md` / `SECURITY.md` as applicable, in-product text, and benchmark record all fully updated to final state (S4). Ref: `docs/releases/directive-reports/Phase-7.md`
- [ ] **Final benchmarks** — Both benchmark passes re-run in Phase 7; final numbers recorded. Ref: `docs/releases/directive-reports/Phase-7.md`

## Section 7 — Sign-off

> By signing, each person attests to the statement beside their name. Do not sign a statement that is not true; raise the gap under S7 instead.

**Developer:** I attest that every ticked task in Section 6 meets the Definition of Done (S9), that every S6 report is complete and truthful, that no known regression, limitation, or scope cut exists that is not recorded in those reports, and that all documentation listed in S4 is fully updated to the final state of the code.

Name: \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_  Signature: \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_  Date: \_\_\_\_\_\_\_\_\_\_\_\_\_\_

**Andres (acceptance):** I accept the handover as reported, including any S8-approved cuts recorded in Section 6 and the task reports.

Name: \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_  Signature: \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_  Date: \_\_\_\_\_\_\_\_\_\_\_\_\_\_
