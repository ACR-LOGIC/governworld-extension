# Multi-Store Extension Publishing & CI/CD Guide

GovernWorld publishes multi-target browser extension artifacts from a single source tree:
- **Chromium / Chrome Web Store**: `dist/` packaged as `GovernWorld-Chromium-v<version>-<sha>.zip`
- **Firefox Add-ons (AMO)**: `dist-firefox/` packaged as `GovernWorld-Firefox-v<version>-<sha>.zip`
- **Microsoft Edge Add-ons**: Chromium-compatible bundle submitted to Edge Partner Center
- **Safari Web Extension**: Handoff bundle in `dist-safari/` for Xcode / App Store Connect packaging

---

## 1. Automated GitHub Actions Workflow

The workflow at `.github/workflows/release.yml` triggers automatically whenever a version tag matching `v*.*.*` is pushed, or manually via **Workflow Dispatch** in the GitHub Actions UI.

### Verification & Release Pipeline:
1. **Typecheck & Security Linter**: `npm run typecheck` (`tsc` from the TS6 compatibility alias) and `npm run lint:security` (covers `scripts/` and `src/**/*.ts`, with the security rules promoted to error for `src/**`)
2. **Sidepanel Sync Contract**: `npm run sync:sidepanel:check`
3. **Unit Tests**: Full test suite run (`npm test`)
4. **Multi-Target Builds**:
   - `npm run build` (Chromium MV3)
   - `npm run build:firefox` (Firefox MV3 with locked gecko id)
   - `npm run build:safari` (Safari handoff payload)
5. **Contract Tests**: Verifies `manifest.json`, offline WASM/tessdata assets, and Firefox package
6. **Package Generation**: Packages `dist/` into `artifacts/governworld-chrome-<tag>.zip`, `dist-firefox/` into `artifacts/governworld-firefox-<tag>.zip`, and writes `artifacts/SHA256SUMS.txt` (or run `npm run release:browsers <sha>` locally)
7. **Offline Zip Verification**: `node scripts/verify-release-zip.mjs <zip> --check-only`
8. **GitHub Release Creation**: Uses only SHA-pinned GitHub-owned actions (`actions/checkout`, `actions/setup-node`) and the built-in `gh release create` CLI (complying with the repository's `selected-actions` security policy) to publish the official GitHub Release with `governworld-chrome-<tag>.zip`, `governworld-firefox-<tag>.zip`, and `SHA256SUMS.txt`.
9. **Store Submissions**: Chrome Web Store, Firefox AMO, and Microsoft Edge Partner Center uploads are performed from those verified GitHub Release ZIPs (or via API upload steps once store secrets are configured and approved under the Actions policy).

---

## 2. Store Secrets Configuration

To automate store uploads from CI or local release scripts, configure the credentials below in **Settings > Secrets and variables > Actions** (and add approved upload steps when ready).

> [!NOTE]
> The repository's Actions policy currently permits GitHub-owned and verified actions only (`selected-actions`), so `.github/workflows/release.yml` intentionally excludes unverified third-party store-upload actions and publishes verified browser bundles directly to GitHub Releases.

### A. Chrome Web Store
| Secret Name | Description |
|---|---|
| `CHROME_CLIENT_ID` | OAuth2 Client ID from Google Cloud Console |
| `CHROME_CLIENT_SECRET` | OAuth2 Client Secret from Google Cloud Console |
| `CHROME_REFRESH_TOKEN` | Refresh token generated for Chrome Web Store API |
| `CHROME_EXTENSION_ID` | Item ID from Chrome Web Store Developer Dashboard |

**Generating Chrome Web Store credentials:**
1. In Google Cloud Console, enable **Chrome Web Store API**.
2. Create OAuth 2.0 Credentials (type: Desktop application).
3. Generate the refresh token:
   ```bash
   npx chrome-webstore-upload-cli get-token \
     --client-id "<CHROME_CLIENT_ID>" \
     --client-secret "<CHROME_CLIENT_SECRET>"
   ```

---

### B. Mozilla Firefox Add-ons (AMO)
| Secret Name | Description |
|---|---|
| `FIREFOX_ADDON_ID` | Add-on UUID / Gecko ID (`redaction@governworld.acrlogic.com`) |
| `FIREFOX_JWT_ISSUER` | AMO API Key (JWT Issuer) |
| `FIREFOX_JWT_SECRET` | AMO API Secret (JWT Secret) |

**Generating Firefox credentials:**
1. Sign in to [addons.mozilla.org](https://addons.mozilla.org).
2. Go to **Developer Hub > Manage API Keys** (`/developers/addon/api/key/`).
3. Generate new credentials to get your `JWT Issuer` and `JWT Secret`.

---

### C. Microsoft Edge Add-ons (Partner Center)
| Secret Name | Description |
|---|---|
| `EDGE_PRODUCT_ID` | Product ID of the extension in Partner Center |
| `EDGE_CLIENT_ID` | Azure Active Directory App Client ID |
| `EDGE_CLIENT_SECRET` | Azure Active Directory App Client Secret |
| `EDGE_ACCESS_TOKEN_URL` | OAuth token URL (`https://login.microsoftonline.com/<tenant_id>/oauth2/v2.0/token`) |

---

## 3. Release Lifecycle & Tagging

1. Ensure the working tree is clean and all tests pass:
   ```bash
   npm run typecheck
   npm test
   npm run build:all
   ```
2. Update the version across `package.json`, `package-lock.json`, `manifest.json`, `manifest.firefox.json`, `src/api/config.ts`, and release documentation (`RELEASE_NOTES.md`, `RELEASE_EVIDENCE.md`).
3. Commit (signed) and create a signed release tag:
   ```bash
   git commit -S -am "chore(release): vX.Y.Z"
   git tag -s vX.Y.Z -m "GovernWorld Extension vX.Y.Z"
   git push origin main --tags
   ```
4. GitHub Actions will execute `.github/workflows/release.yml`, packaging all artifacts, uploading to configured stores, and publishing the GitHub Release with SHA-256 sums.

---

Last verified on: November 28, 2026
