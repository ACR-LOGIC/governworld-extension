# Changelog

All notable changes to the GovernWorld Extension are documented in this file.
Historical release notes prior to directive `GW-DEV-DIRECTIVE-2026-001` are preserved in [`docs/releases/RELEASE_NOTES.md`](docs/releases/RELEASE_NOTES.md).

## [Unreleased] — Directive GW-DEV-DIRECTIVE-2026-001

*(Entries added task-by-task in execution order under Standard S4.)*

- **P3**: Incremental DOM rescans in `src/content/content.ts` now emit updated `SCAN_RESULT` messages via `emitScanResult()` with current session stats, and `handleContentScanResult()` in `src/service-worker/index.ts` accepts matching active-session incremental results when no `pendingScans` entry is open, pushing `POPUP_STATE` and calling `updateBadgeForTab()` (`5/5` live Chrome trials synchronized: `session=1`, `badge="1"`, `popup=1`).
- **P4**: Implemented full staged-document prefix deletion (`docDeleteByPrefix` / `deleteDocBytesByPrefix`), cooperative `AbortController`/`AbortSignal` + offscreen `"cancel"` cancellation through `pdf.ts`/`ocr.ts`/`impl.ts`/`browser.ts`, orphan-only startup purge (`purgeOrphanedStagedKeys`), and truthful popup cancelled state (`Start Over` leaves `0` keys across 1/5/20p; mid-job `Cancel` stops OCR/key growth within 1 s and leaves `0` keys).
- **P2**: Eliminated the `rescan_seg_0` segment/finding ID collision in `src/content/content.ts` by introducing session-scoped monotonic `nextRescanSegId` (`rescan_seg_<N>`) and `nextRescanFindingSeq` (`rescan_<cat>_<N>`) counters reset on `clearSession()` (`3/3` live Chrome batch-removal trials left `0` ghost masks and kept surviving Email/SSN masks aligned).
- **P1**: Fixed the `characterData` mutation blind spot in `src/content/content.ts` (`rescanAffectedRegions`) and `src/content/extract.ts`: in-place text-node edits now re-extract, re-detect (with `enrichAndBoostNames`), rebase surviving findings' combined offsets after segment splices, merge coalesced mutation batches, clear pending batches in `clearSession()`, and update/clear overlay masks cleanly (`5/5` live Chrome trials masked in `669.2–694.1 ms`, `p50 679.2 ms`).
- **Phase 0**: Confirmed baseline at commit `da2024e6aae8f1906c9f9743ce3c8821751cafa1`, added reproducible Run 1 (`tests/benchmark-measured.test.ts`) and Run 2 (`scripts/run2-driver.mjs`) benchmark harnesses, created root `CHANGELOG.md`, benchmark record (`docs/benchmarks/GW-BENCH-2026-001-RECORD.md`), and directive tracking checklist (`docs/releases/DIRECTIVE_GW-DEV-DIRECTIVE-2026-001_CHECKLIST.md`).

## [0.4.0] - 2026-11-19

- Baseline release prior to `v0.4.1` tag discrepancy (`GW-BENCH-2026-001`); see [`docs/releases/RELEASE_NOTES.md`](docs/releases/RELEASE_NOTES.md) for full details.
