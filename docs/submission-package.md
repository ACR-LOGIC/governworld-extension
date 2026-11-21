# Chrome Web Store submission package

Everything needed to submit, in the order the dashboard asks for it. Every value
below is verified against the built artifact; nothing here needs to be
re-derived at upload time.

- **Target:** Chrome Web Store, single purpose, listing type "Extension"
- **Artifact:** `governworld-chrome-v0.4.0.zip` (attached to the GitHub Release; or produced locally via `npm run release:zip <sha>`)
- **Version:** 0.4.0
- **Published:** https://github.com/ACR-LOGIC/governworld-extension/releases/tag/v0.4.0
- **Checksums:** `SHA256SUMS.txt` on the GitHub Release and `docs/releases/RELEASE_EVIDENCE.md`
- **Digests for committed store assets:** `npm run verify:digests`

---

## 1. Package

Upload `governworld-chrome-v0.4.0.zip` (from the `v0.4.0` GitHub Release) or the locally built `release/governworld-redaction-<sha>.zip`. That is the file the
dashboard wants — not the tarball, and not `dist/`.

Verified via `node scripts/verify-release-zip.mjs <zip> --check-only`: `manifest_version: 3`, `manifest.json` at
the archive root with no wrapping folder, all manifest references, offline WASM/tessdata assets, and legal pages present.

> If you rebuild before submitting, the filename and both digests change.
> Re-run `npm run release:zip <sha>` and `npm run verify:digests` first.

## 2. Store listing fields

| Field | Value | Limit | Status |
|---|---|---|---|
| Name | `GovernWorld Redaction` | 45 | 21 ✅ |
| Short description | `Local-first PII/PHI detection and redaction for pages and documents you choose to scan. Content stays on this device.` | 132 | 117 ✅ |
| Category | Productivity | — | — |
| Language | English (UI ships in 7) | — | — |

**Detailed description:** the body of `STORE_DESCRIPTION.md`, minus its two
header lines ("Draft listing copy…" and "Review before submission…"). That is
5,084 characters against a 16,000 limit.

## 3. Graphics

| Asset | File | Size | Requirement |
|---|---|---|---|
| Small promo tile | `release/images/promo-tile-440x280.png` | 440×280 | ✅ |
| Screenshots (5) | `release/screenshots/01..05-*.png` | 1280×800 each | ✅ at least one required |

All images are generated from synthetic fixtures by `npm run capture:store` and
`npm run capture:promo`. No real PII, no browser chrome, no user data.

> **v0.4.0 assets regenerated.** All five 1280×800 screenshots (covering the
> redesigned `v0.4.0` UI, full-screen Document Review, and Settings → About) and
> the 440×280 small promo tile were regenerated via `npm run capture:store` and
> `npm run capture:promo` with matching SHA-256 digests recorded in
> `RELEASE_EVIDENCE.md`.

## 4. Privacy practices questionnaire

Answer as written. These are the defensible answers, and they match the shipped
permissions exactly — a mismatch here is the most common cause of a rejection
and a bad look.

| Question | Answer | Why |
|---|---|---|
| Single purpose | Detect and redact sensitive data in a page or document the user explicitly opens | No other purpose exists in the code |
| Collect user data? | **No (standalone `LOCAL` mode); device/policy metadata only in opt-in `MANAGE` mode** | Standalone `LOCAL` mode makes zero network requests and collects nothing. Optional `MANAGE` pairing transmits only device/policy health metadata (`device_id`, `organization_id`, `employee_id`, `browser_info`, `extension_version`, `policy_version`, `policy_status`, `timestamp`, `status`) — never browsing history, URLs, page text, or documents |
| Remote code? | **No** | All OCR/PDF/worker assets are vendored into the package; nothing is fetched or evaluated at runtime |
| Data collection disclosure | Disclose standalone zero-collection default vs. optional `MANAGE` / account metadata | Consistent with `PRIVACY.md` (§7 & §18) and Chrome Web Store Limited Use |
| Privacy policy URL | `https://governworld.acrlogic.com/chrome-extension-privacy` | Verified HTTP 200 |

## 5. Single-purpose justification

Worth writing out, because a reviewer decides the listing on this.

> GovernWorld Redaction does one thing: it finds sensitive values — PII, PHI,
> financial data, and credentials — in the web page the user is currently
> viewing or in a document the user explicitly opens, and lets the user cover
> them. It requests no install-time host permissions, so a default install has
> no access to any site until the user acts on that site; the always-on paste
> mode adds optional, runtime-granted http(s) access only. It does not modify
> pages, track browsing, sync data, or communicate with an advertising or
> analytics network. Everything it detects, it detects locally.

## 6. Permission justifications

Copy from `PERMISSIONS.md`. The manifest requests `activeTab`, `scripting`,
`storage`, `downloads`, `offscreen`, `sidePanel`, `contextMenus`, `alarms`, plus optional
`notifications` and optional http(s) host access for the always-on paste mode —
and **no install-time host permissions at all**, which is the strongest
privacy statement the listing can make.

## 7. Data safety section

| Field | Value |
|---|---|
| Data usage | No data collected, no data sold, no data used for advertising |
| Remote code | None — all assets vendored |
| Data handling | All processing local; staged document bytes never leave the device |
| Privacy policy | `https://governworld.acrlogic.com/chrome-extension-privacy` |

## 8. Before you press submit

- [ ] `npm run typecheck` clean
- [ ] `npm test` passing cleanly
- [ ] `npm run build` clean
- [ ] `npm run release:zip <sha>` and `npm run verify:zip <zip>`
- [ ] `npm run verify:digests` — every recorded digest matches
- [ ] Zip SHA-256 above matches the file you are about to upload
- [ ] `dist/manifest.json` declares no `host_permissions`, and
  `optional_host_permissions` is exactly `http://*/*` + `https://*/*`
- [ ] Read the Terms, Privacy Policy, and STORE_DESCRIPTION once more as a
      reviewer would

## 9. Known limitations to accept, not fix before launch

These are already stated in the legal pages, the privacy policy, and the in-app
notice. They are not blockers; they are the honest scope of the product.

- **Detection is not exhaustive.** A deliberately formatted value can evade the
  patterns. Detection can also produce false positives — a well-formed random
  number such as `123-45-6789` satisfies every SSA structural rule and is
  indistinguishable from a real SSN by shape alone.
- **No independent third-party security assessment.** The sign-off in
  `RELEASE_EVIDENCE.md` is first-party, recorded as such.
- **Community rules are inert.** Both network paths refuse, the UI says so, and
  the pack verifier is tree-shaken out of the shipped bundle.
- **Paste Shield defaults to this-tab**, not always-on: it is absent from any
  tab the user has not activated, because a default install has no site
  access. Always-on is an explicit opt-in behind a runtime permission grant.
- **English only for image OCR.** Detection is language-agnostic regex, so
  structured identifiers in other languages are still found.
- **Chromium first.** The Firefox package (`npm run build:firefox`) ships page
  protection; its Document Studio reports an explicit error where the offscreen
  API is absent. Safari has a handoff payload only — packaging needs Apple
  tooling (see `BROWSER_SUPPORT.md`).
