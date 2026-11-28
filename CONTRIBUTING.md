# Contributing to GovernWorld Chrome Extension

Thank you for your interest in contributing to the GovernWorld Chrome Extension! We welcome community contributions, bug reports, feature enhancements, and community sponsorship.

---

## 💛 Free for Non-Commercial Use, Local-First & Community Supported

GovernWorld is built on an uncompromising commitment to privacy and **Business Source License 1.1 (BSL 1.1)** source-available licensing (free for personal, educational, academic, government, and internal non-commercial use; transitions to Apache License 2.0 on November 13, 2030):
* **Local processing by default:** All scanning, OCR, pattern matching, and document flattening happen on your local device, and protected content never leaves it during local scanning and redaction.
* **Zero Data Monetization:** We never sell, track, monetize, or transmit user data or document contents.
* **Free Non-Commercial Access:** Every core protection capability is free for non-commercial use without paywalls (commercial hosting/resale requires a commercial license from `andres@acr-logic.com`).

### Sponsoring Development
If GovernWorld helps protect your privacy or workflow, you can support ongoing maintenance, offline OCR models, and validator improvements via GitHub Sponsors or Buy Me a Coffee:

💖 **[Sponsor ACR-LOGIC on GitHub](https://github.com/sponsors/ACR-LOGIC)** (`https://github.com/sponsors/ACR-LOGIC`)
☕ **[Support GovernWorld on Buy Me a Coffee](https://buymeacoffee.com/governworld)** (`https://buymeacoffee.com/governworld`)

---

## Ways to Contribute

1. **Submit New Detection Patterns & Validators:**
   - Add algorithmic checksums or regex definitions to [`src/validators/index.ts`](src/validators/index.ts) or [`src/content/detect.ts`](src/content/detect.ts).
   - Author and share custom rules created in the Redaction Wizard.
2. **Improve Document & Visual Redaction:**
   - Enhance PDF, Word (DOCX), or image canvas processing pipelines under [`src/document-pipeline/`](src/document-pipeline/).
3. **Enhance UI & Accessibility:**
   - Improve keyboard navigation, high-contrast themes, and screen reader labels.
4. **Report Bugs & Suggest Features:**
   - Open an issue on our [GitHub Issue Tracker](https://github.com/ACR-LOGIC/governworld-extension/issues).
5. **Financial Sponsorship:**
   - Sponsor on GitHub at [github.com/sponsors/ACR-LOGIC](https://github.com/sponsors/ACR-LOGIC) or support development at [buymeacoffee.com/governworld](https://buymeacoffee.com/governworld).

---

## Development Workflow

### Prerequisites
- Node.js 22.13+
- npm 10+
- Google Chrome (or Chromium-based browser)

### Setup & Local Development
1. Clone this repository:
   ```bash
   git clone https://github.com/ACR-LOGIC/governworld-extension.git
   cd governworld-extension
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build the extension:
   ```bash
   npm run build
   ```
4. Run tests:
   ```bash
   npm test
   ```
5. Typecheck:
   ```bash
   npm run typecheck
   ```
6. Run browser end-to-end photo redaction benchmark:
   ```bash
   npm run test:photo-e2e
   ```

### Loading in Chrome
1. Navigate to `chrome://extensions/` in Chrome.
2. Toggle **Developer mode** in the upper right corner.
3. Click **Load unpacked** and select the `dist/` directory inside this repository.
4. Pin the extension to your toolbar.

---

## Architecture & Privacy Invariants

- **Local-First Invariant:** No feature may send raw page text, document bytes, or unmasked sensitive values across the network. All detection and redaction must execute on-device.
- **Zero Host Permissions:** Do not add broad host permissions (`*://*` or domain-specific wildcards). All tab interactions must occur through explicit user action (`activeTab`).
- **Fail-Closed Audit:** Any operation affecting redaction policies or document outputs must generate an immutable, ECDSA-signed audit record.
- **Clean Code & Testing:** Every new detection pattern or feature must include unit tests under `tests/` and maintain 100% test pass rates.

---

## Release Versioning & Single-Source Parity

`package.json` (`"version"`) is the **single source of truth** for the extension version (`0.5.0`). Do not edit version strings manually across manifests, source files, or documentation:

1. Bump `"version"` in `package.json` only.
2. Synchronize all derived surfaces (`package-lock.json`, `manifest.json`, `manifest.firefox.json`, `src/api/config.ts`, `src/popup/privacy.html`, `README.md`, and `AGENTS.md`) via:
   ```bash
   npm run sync:version
   ```
3. Popup & About UI read the runtime version from `chrome.runtime.getManifest().version` / `CURRENT_EXTENSION_VERSION`.
4. Verify parity locally (and enforced as a hard CI failure in `.github/workflows/ci.yml` and `release.yml`):
   ```bash
   npm run sync:version:check
   npx vitest run tests/version-parity.test.ts
   ```

---

## Testing Standards & Anti-Vacuity Policy (P12)

Every automated test in `tests/` SHALL exercise real module code and fail when the underlying fix is reverted:

1. **No Vacuous Constants or Tautologies:** Never assert properties of local literals (`expect(52).toBeGreaterThan(50)`, `if (0) {}`, `expect(true).toBe(false)` inside early returns).
2. **No Inline Bug Simulations:** Tests must import and execute the real production modules (`src/content/content.ts`, `src/content/normalization/mutation.ts`, `src/content/pasteGuard.ts`, etc.) rather than duplicating stale logic inline.
3. **Exact-Span Recall:** Detection benchmarks (`tests/benchmark-measured.test.ts`, `tests/detection-benchmark.test.ts`) SHALL assert exact character offsets (`m.start === expectedStart && m.end === expectedEnd`), never substring `.includes()` overlap checks.
4. **Fail-on-Revert Proof:** Every bug-fix test must be verified to **fail** (`exit 1`) when its corresponding production fix is reverted, and **pass** when restored.

---

## Section 4 Measured CI Hard Gates (`C1 / G1–G9`)

All pull requests and release builds execute `npm run gates:ci` (`scripts/run-ci-gates.mjs`, wired as a blocking step in `.github/workflows/ci.yml` and `.github/workflows/release.yml`). No gate is advisory or skippable:

| Gate | Requirement | Enforcement Surface |
| :--- | :--- | :--- |
| **G1** | Exact-span recall = `100%` on strict corpus (`22/22` + `4/4` multi-entity; overlap does not count) | `tests/benchmark-measured.test.ts` (`GW_BENCH_STRICT=1`) + `tests/detection-benchmark.test.ts` |
| **G2** | Zero escapes (`0`) in input guard | Run 1 (`5/5` cases) + live Chrome Run 2 (`15/15` trials) + `tests/paste-*.test.ts` |
| **G3** | No missed changed text (`characterData` mutation masked live in `<= 2000 ms`, `5/5` trials) | Live Chrome Run 2 (`--stage=scan`) + `tests/content-rescan.test.ts` + `tests/e2e-audit-tier2-boundaries.test.ts` |
| **G4** | Redaction results identical | `tests/redaction-golden-gate.test.ts` + `tests/redaction-output.test.ts` |
| **G5** | No recoverable test secrets in finished export | `tests/export-secret-recovery-gate.test.ts` (`pdf-lib` + `pdfjs-dist` text extraction + XObject RGB pixel check) |
| **G6** | Detection of `1 MB` text `< 200 ms` at `p50` | `tests/benchmark-measured.test.ts` (`detectThroughput["1MB"].p50`) |
| **G7** | `1,000`-node page scan `< 75 ms` at `p50` (`300/300` at `10,000` nodes) | `tests/benchmark-measured.test.ts` (`pageScan["1000"].p50`) |
| **G8** | Live paste dialog `< 100 ms` at `p50` across all sizes | Live Chrome Run 2 (`--stage=paste`, `short` / `10KB` / `68KB`) |
| **G9** | Performance regression `> 20%` against `docs/benchmarks/ci-baselines.json` fails CI | `scripts/run-ci-gates.mjs` (`125.6 ms` -> `<= 150.72 ms`; `42.0 ms` -> `<= 50.4 ms`; `50.0 ms` -> `<= 60.0 ms`) |

---

Last verified on: November 28, 2026
