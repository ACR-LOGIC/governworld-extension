# Chrome Web Store Listing — GovernWorld Redaction

> **Last Updated:** 2026-11-28  
> **Extension Name:** GovernWorld Redaction  
> **Extension Version:** 0.5.0  
> **Target Manifest Version:** Manifest V3  
> **Status:** Ready for Submission

---

## 1. Store Listing Details

### Product Details
- **Name:** GovernWorld Redaction
- **Summary (up to 132 chars):** Local-first PII/PHI detection and redaction for pages and documents. On-device processing keeps your data private.
- **Category:** Productivity / Privacy & Security
- **Language:** English (United States)

### Detailed Description
**GovernWorld Redaction** finds sensitive values in the visible text of the page you are viewing and in the PDF, image, and Word files you open, then lets you redact or mask them directly on your device:

- **Scan on demand.** Nothing scans automatically. Open the popup or side panel and press **Scan this page** to analyze the visible text of the current tab.
- **Local only — enforced.** Scanning, detection, OCR, and redaction all run on your device in default standalone `LOCAL` mode with zero network requests. Your page text and documents never leave your device, and the local pipeline has no network path at all. Optional organizational pairing (`MANAGE` mode via email-bound token or OS policy) synchronizes signed organization policies and lightweight health metadata only (never scan content), and optional account linking contacts GovernWorld for billing metadata only.
- **Review, then act.** Findings are listed with masked previews (for example, `phone: ***-***-1234`). Choose what to cover.
- **Temporary page masks.** Masks are an on-screen overlay only. They do not change or store anything on the website you are viewing.
- **Preset policies.** 10 compliance presets — Custom, HIPAA, PCI DSS, GDPR, PIPEDA, UK GDPR / NHS, India DPDP, Australia Privacy, Brazil LGPD, and Developer (API keys & secrets) — auto-select the categories they cover across 24 detection categories.
- **Custom Redaction Wizard.** Step-by-step wizard to define custom regex, test against live sample text, and activate custom detection rules locally.
- **Document Processing.** Open a PDF, image, or Word document, review detected values, and download a flattened, securely redacted copy.
- **Dedicated Instructions & Deep Links.** Comprehensive documentation with contextual in-app guidance jumping straight to relevant instruction cards.
- **Signed audit export.** Every scan, mask, document, and preset change is recorded as a metadata-only audit entry, and exported logs are ECDSA-signed so an edit to an export is detectable. The signature proves the export was produced by this extension and has not been altered since; it does not prove the log is a complete history.

---

## 2. Permissions Justification

Every permission declared in `manifest.json` is strictly required for core local functionality:

| Permission | Category / Justification |
| :--- | :--- |
| `activeTab` | Required to access and scan the active tab's visible text solely upon direct user action (clicking "Scan this page"). |
| `scripting` | Required to inject the local scanning script and display non-destructive masking overlays in the active tab upon user request. |
| `storage` | Required to store user configuration, custom redaction rules, preset selections, and local signed audit records on the device. |
| `downloads` | Required to save locally flattened and redacted document files (PDFs/images) directly to the user's download directory. |
| `offscreen` | Required to execute CPU-intensive local OCR extraction (Tesseract.js) and PDF canvas rendering in an isolated offscreen context without stalling UI responsiveness. |
| `sidePanel` | Required to provide a persistent side panel interface (`Alt+Shift+P`) for document scanning, live wizard rule creation, and in-depth instruction viewing. |
| `contextMenus` | Required to add context menu entries — "Open GovernWorld Side Panel", "Scan page for sensitive data", "Redact selection to clipboard", and "Mask selected text" — so users can open the workspace or trigger user-initiated actions directly from a right-click. The selection/page scan entries are created only while the setting is enabled and are removed when it is disabled, and each runs the existing click-to-scan path with on-screen confirmation. |
| `alarms` | Required to schedule periodic lightweight compliance status checks and policy synchronization strictly when an employee explicitly pairs the extension in organizational `MANAGE` mode. Completely inactive with zero network calls in default standalone `LOCAL` mode. |
| `notifications` *(optional)* | Requested only if the user explicitly opts into a desktop notification when a scan finds sensitive data. |
| `http://*/*`, `https://*/*` *(optional host access)* | Requested only if the user switches the always-on paste mode on, so it can guard pages on every visited site. The default this-tab mode needs no site access. Revoking the grant stops always-on coverage. |

### Host Permissions Justification
- **Pinned coordinator origin (`https://lkgcehdwasewwoieyoip.supabase.co/*`):** Declared in `host_permissions` solely for optional organizational `MANAGE` mode (email-bound pairing redemption, signed policy delivery, and planned closed-schema health/uninstall status checks). Completely unused with zero network requests in default standalone `LOCAL` mode; no broad or wildcard install-time site access is declared.
- **Runtime site access (`http://*/*`, `https://*/*` via `optional_host_permissions`):** Granted only if the user explicitly enables Always-On Paste Shield across websites.

---

## 3. Privacy & Data Use Disclosures (Three-Way Alignment)

- **Single Purpose:** Provide local-first detection and redaction of sensitive data in web pages and local files.
- **Remote Code:** The extension does NOT execute remote code or download scripts dynamically. All scripts and WebAssembly modules are bundled locally within the extension.
- **Data Collection:** In standalone `LOCAL` mode (default on install), the extension makes zero network requests and collects **NO user data, NO page content, and NO document bytes**. Your page text and documents never leave your device.

### Data Use Disclosure Table

| Data Type | Collected? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
| :--- | :--- | :--- | :--- | :--- |
| Website content / page text | No | Never (page text and documents never leave this device) | Local detection & redaction only | No |
| Personally identifiable info / Health info / Financial info (scanned content) | No | Never | Local on-device detection & redaction | No |
| Web history / browsing activity | No | Never | N/A | No |
| Optional enterprise pairing metadata (`MANAGE` mode only) | When explicitly paired | Only email hash, browser family enum, device activation hash, policy version, and status enum | Single-seat licensing & compliance health status | No (pinned coordinator backend only) |
| Optional billing / gateway account link | When explicitly linked | Gateway auth / license tier metadata | Account status verification | User-configured gateway only |

**Data Use Certification:**
- Data is NOT sold to third parties.
- Data is NOT used or transferred for purposes unrelated to the extension's single purpose.
- Data is NOT used for creditworthiness or lending purposes.

In accordance with Chrome Web Store Developer Program Policies (Limited Use and Data Minimization requirements):

1. **Manifest Alignment:** Install-time `host_permissions` is pinned strictly to the optional enterprise coordinator origin (`https://lkgcehdwasewwoieyoip.supabase.co/*`) with zero install-time site access to web pages. `activeTab` grants ephemeral page access solely upon explicit user interaction, and `http://*/*` + `https://*/*` remain optional runtime grants for always-on paste coverage. All code and WebAssembly binaries (pdf.js, Tesseract.js) are strictly bundled locally within the extension.
2. **Developer Dashboard Privacy Practices:** 
   - **Local Page & Document Processing:** Not collected, not transmitted. Executed locally on the user's CPU/GPU without cloud transmission.
   - **Optional Organizational Pairing (`MANAGE` Mode):** Disabled by default. Only after explicit pairing with an organization pairing code or OS-managed policy does the extension synchronize signed policy JSON envelopes and emit lightweight status checks (device UUID, browser metadata, extension/policy versions, timestamp, health status). Browsing history, visited URLs, search queries, page text, credentials, chats, and personal files are never transmitted.
   - **Optional Account / Cloud Integration:** Disabled by default. If explicitly configured by the user, only billing tier metadata and authentication tokens are transmitted over TLS to the user-specified gateway origin. No scanned text or document bytes are ever included.
   - **Community Packs:** Disabled by default. No outgoing tracking.
   - **Audit Logs:** Stored locally in browser storage with ECDSA digital signature and SHA-256 hash chaining; exported only when the user explicitly clicks "Export Audit Log".
3. **Hosted Privacy Policy Alignment:** Matches `PRIVACY.md` and the hosted notice at `https://governworld.acrlogic.com/chrome-extension-privacy`. Packaged as `privacy.html` in the extension.

---

## 4. Version History

- **0.5.0 (2026-11-28):** Single-entry Office Manager pairing, non-reversible admin lock, telemetry isolation, dual-state health detection, and multi-browser single-seat licensing release.
  - Consolidated organizational pairing into single-entry Office Manager Coordination (Settings → Profile & Account) with a mandatory pre-pairing administrator-lock consent dialog (`#pairing-consent-dialog`) and non-reversible post-pairing enforcement (admin-only revocation).
  - Added dedicated isolated telemetry worker (`telemetry-worker.js`) enforcing a closed-schema payload (status enums, UTC timestamps, browser family enum, and policy version/integrity hashes only).
  - Added dual-state lifecycle detection distinguishing active Online heartbeats, clean-shutdown Offline state, and Uninstalled / Terminated uninstall signals.
  - Implemented 1-user = 1-seat multi-browser licensing across distinct browser families with email-bound pairing tokens, duplicate-browser conflict resolution, per-feature admin "Unlock for User" delegation, and fail-closed local continuity on lapsed subscriptions.
  - Hardened Manifest V3 service-worker user-gesture preservation for optional notification permission requests, single-flight offscreen document creation locking, batched overlay rendering, and context-menu feedback + side panel triggers.
- **0.4.0 (2026-11-19):** Post-pairing governance, UI/UX redesign, and structured name enrichment release.
  - Added pairing-gated lightweight heartbeat service (`src/service-worker/heartbeatService.ts`) using `chrome.alarms`, strictly inactive in standalone `LOCAL` mode.
  - Wired 6-digit Office Manager pairing code flow directly to persistent `ManagementEnrollment` and locked admin-mandated policy controls while preserving employee accessibility accommodations.
  - Shipped popup and sidepanel UI/UX redesign with circular Profile Avatar Popover, honest live protection status strips, first-run onboarding card, and full 7-language parity.
  - Added census-backed structured name parsing and enrichment (`Finding.parsedName`) across detection and exports.
  - Resolved CodeQL alerts and updated dependencies cleanly.
- **0.3.0 (2026-11-09):** Enterprise managed policy, operating modes (`LOCAL` vs. `MANAGE`), Ed25519 signature verification, anti-rollback protection, and 3-tier setting ownership enforcement.
- **0.2.0 (2026-11-08):** Explainable compliance scoring, AI leakage prevention, and clinical SOAP intelligence release.
  - Implemented the GovernWorld Explainable Compliance Scorecard (0–100 Risk Formula v1) with deterministic factors: Base Sensitivity, Destination Risk, Action Risk, Volume Risk, and Confidence Modifier.
  - Added HIPAA Combination Rules (e.g. `Patient Name + DOB`, `Patient Name + MRN`, `MRN + DOB + Diagnosis`, and `Complete Patient Profile`).
  - Added Secret Weapon AI Leakage Rule: automatically escalates to CRITICAL (100) and blocks PHI clipboard paste/prompt disclosure to external AI services (`chatgpt.com`, `claude.ai`, `gemini.google.com`, `perplexity.ai`, `deepseek.com`, etc.).
  - Implemented 8-Layer PHI Evidence Graph covering structured clinical identifiers (MRN with brackets/parentheticals, encounter dates, service dates, admission dates), medical vocabulary density, ICD-10 codes, labeled diagnoses (PMH, allergies), top 150+ prescription medications & dosages (`Lisinopril 10 mg daily`, `Metformin 500 mg BID`), physician credentials (`MD`, `DO`, `NP`, `PA`, `RN`, `PhD`), and healthcare portal domains.
  - Added Policy Studio for granular URL governance: full website access blocking, quick policy templates, custom category scopes, and shadow DOM barrier screens.
  - Enhanced target tab resolution and isolated internal extension URLs from DOM text extraction.
  - Interactive compliance scorecards in Page Scan results, Document Studio, and Full-Screen Review.
- **0.1.1 (2026-10-30):** Hardened privacy and compliance release.
  - Implemented cryptographic SHA-256 hash chaining for the audit log, with independent CLI verification tool (`scripts/verify-audit.mjs`).
  - Added fail-closed audit enforcement for protected document redaction and clipboard release.
  - Enforced strict session storage isolation (`chrome.storage.session` accessible only to trusted contexts).
  - Sanitized shadow-root injection in Paste Shield (100% innerHTML-free).
  - Added drag-and-drop file inspection to Paste Shield.
  - Added Firefox AMO `data_collection_permissions` declaration (`"required": ["none"]`).
  - Added enterprise policy deployment and configuration guide (`docs/ENTERPRISE_DEPLOYMENT.md`).
  - Updated dependencies to `pdfjs-dist@6.4.299`.
- **0.1.0 (2026-09-27):** Initial release featuring local-first detection engine,
  document scanning & redaction, interactive Redaction Wizard, 10-part instruction
  suite with deep linking, zero host permissions, and locked API-ready cloud
  integration boundary.

  GovernWorld is released under **Business Source License 1.1 (BSL 1.1)**
  (transitions to Apache License 2.0 on November 13, 2030). It is
  source-available and is *not* an OSI-approved open-source licence, so this
  listing describes it as free for non-commercial use rather than as open
  source. The third-party libraries it builds on (pdf.js, Tesseract,
  tesseract.js, pdf-lib, and mammoth) are separately licensed under
  Apache-2.0, MIT, and BSD-2-Clause and are credited in the extension's About
  page.

---

Last verified on: November 28, 2026
