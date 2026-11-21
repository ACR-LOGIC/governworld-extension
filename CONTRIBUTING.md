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

`package.json` (`"version"`) is the **single source of truth** for the extension version (`0.4.1`). Do not edit version strings manually across manifests, source files, or documentation:

1. Bump `"version"` in `package.json` only.
2. Synchronize all derived surfaces (`package-lock.json`, `manifest.json`, `manifest.firefox.json`, `src/api/config.ts`, `src/landing/index.html`, `src/popup/privacy.html`, `README.md`, and `AGENTS.md`) via:
   ```bash
   npm run sync:version
   ```
3. Popup & About UI read the runtime version from `chrome.runtime.getManifest().version` / `CURRENT_EXTENSION_VERSION`.
4. Verify parity locally (and enforced as a hard CI failure in `.github/workflows/ci.yml` and `release.yml`):
   ```bash
   npm run sync:version:check
   npx vitest run tests/version-parity.test.ts
   ```
