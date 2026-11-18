# GovernWorld Chrome Extension — UI/UX & User-Flow Redesign Plan

**Branch:** `feat/ux-redesign-user-flows` (branched from `main` at `eaa16b3`)  
**Target Emphasis:** Individual-First with Unified Progressive Disclosure  
**Status:** Design Specification & Implementation Blueprint

---

## 1. Executive Summary & Design Goals

GovernWorld Redaction (`v0.3.0`) ships a mature privacy, detection, OCR, document redaction, Paste Shield, and cryptographic audit engine. However, auditing the shipped extension UI on `main` (`eaa16b3`) in real Chromium revealed critical UX, layout, markup, and state-honesty defects:

1. **Header Collision & Non-Standard Controls:** The `"Open side panel"` button collides directly with the `"GovernWorld / PRIVACY INTELLIGENCE"` brand text at `380px` width, remains visible inside the already-open Side Panel, and duplicates Settings navigation (`#settings-gear-btn` + `#tab-btn-settings`), while lacking a standard top-right circular user/profile avatar icon.
2. **Side Panel Space-Utilization Trap:** `html, body { width: 360px; }` pins the entire UI to a 360px column even inside wide Chrome Side Panels (`420px–760px`) and leaks into `redact.html` (a full browser tab).
3. **Above-the-Fold Bloat & Static Fake-Green Statuses:** Three hardcoded `.service-row` cards (`Page protection: Active`, `Paste protection: Active`, `Document protection: Ready`) plus a duplicate `#scanner-shield-status` banner and `#cloud-notice` consume ~170px before the primary scan/document actions or scan findings appear. Worse, `.service-status` never updates dynamically when Paste Shield is off or when `offscreen` is unavailable in Firefox.
4. **Broken Markup & Dead/Unwired States:**
   - Seven Settings sub-navigation buttons (`index.html:411-438`) contain a stray `>` character (`aria-label="..."> id="settings-nav-...">`), rendering raw `id="settings-nav-..."` text inside the UI and breaking button IDs.
   - `body[data-high-contrast="true"] .shield-banner,{` (`popup.css:137`) has a trailing comma syntax error.
   - Review tab counters (`#review-findings-count`, `#review-protected-count`, `#review-pages-count`) and `#activity-list` are never populated from storage; `#coverage-details-btn` fails to switch to the `settings` tab; `#clear-audit-btn` removes `"audit_log"` / `"audit_key"` instead of `"auditLog"` / `"auditCheckpointState"`.
   - Clicking `#open-doc-btn` or `#doc-dropzone` inside an ephemeral popup opens the OS file picker directly, causing Chrome to dismiss the popup before file selection completes (unlike `wizardImportFileBtn`, which hands off to Side Panel).
   - Office Manager pairing (`popup.ts:3125-3147`) silently applies a simulated `"GovernWorld Medical Practice"` lock when `127.0.0.1:4820` is unreachable.
   - Native `window.confirm()` / `alert()` dialogs interrupt flows instead of inline UI controls.

This redesign resolves all of these defects across the **real shipped extension surfaces** while preserving every Manifest V3, CSP, fail-closed `MANAGE`, zero-egress, accessibility, and contract-test invariant.

---

## 2. Target-User Emphasis: Individual-First with Unified Progressive Disclosure

### Primary Experience (Default / Day-1)
- Optimized for **individual privacy & AI-safety users** (ChatGPT/Claude/Gemini prompt protection), **healthcare/finance/legal practitioners** (HIPAA/PCI/GDPR/international PII & PDF/DOCX/image redaction), and **developers** (`secrets` + Logic Wizard) running in standalone **`LOCAL` mode**.
- Zero account creation, zero subscription wall, and zero install-time host permissions.
- Immediately surfaces the 3 core daily workflows (**Page Scan & Mask**, **Paste Shield**, **Document Redaction**) with honest live status and zero enterprise jargon cluttering the home view.

### Secondary / Progressive Layer (Enterprise `MANAGE` & Account)
- Enterprise `MANAGE` mode (`chrome.storage.managed`, Office Manager pairing, Gateway linking) lives cleanly inside the **circular top-right Profile Avatar Popover** and **Settings -> Profile & Account**, never intimidating standalone users on first launch.
- When `MANAGE` mode is active (`chrome.storage.managed` or verified pairing), the header badge (`MANAGE`), profile avatar status ring, and locked Settings notices surface clear `"Managed by [Org]"` indicators and enforce fail-closed controls.
- Strict privilege separation (`#org-settings` for `owner`/`admin` vs `#org-settings-wall` for `member`/`viewer`) and session-only `accountApiKey` storage (`chrome.storage.session`) remain untouched.

---

## 3. Included Surfaces

| Surface | Files | Redesign Scope |
|---|---|---|
| **Action Popup** | `src/popup/index.html`, `src/popup/popup.css`, `src/popup/popup.ts` | Header + circular profile avatar + popover, first-run welcome card, compact live status strip, streamlined Protection/Logic/Review/Settings flows, inline confirmations/messages, bug fixes |
| **Side Panel** | `src/sidepanel/sidepanel.html`, `src/sidepanel/sidepanel.css` (via `scripts/sync-sidepanel.mjs`) | Auto-hide `#open-side-panel-btn`, fluid width (`340px` to `880px`), 2-column responsive grids, Settings side-rail at `>= 520px`, side-by-side Review layout |
| **Document Review & Print View** | `src/popup/review.html`, `src/popup/review.css`, `src/popup/redact.html` | Harmonized obsidian-slate palette tokens, typography, and `redact.html` full-width fix |
| **In-Page Shadow DOM Overlays** | `src/content/toast.ts`, `src/content/pasteGuard.ts`, `src/content/overlay.ts` | Harmonized surface/accent/border tokens matching the popup/sidepanel palette while keeping `attachShadow({ mode: "closed" })` and security logic unchanged |
| **i18n** | `src/shared/i18n.ts` | Full 7-language parity (`en, es, fr, de, ja, pt, zh`) for all new and updated `data-i18n*` keys |

---

## 4. Header & Circular Profile Avatar Convention

```
┌──────────────────────────────────────────────────────────────────────┐
│ [Shield] GovernWorld                 [Side Panel] [LOCAL]  [ (JD) • ]│
│          Privacy Intelligence                                        │
└──────────────────────────────────────────────────────────────────────┘
```

1. **Brand Zone (Left):** Crisp 32px emblem + `GovernWorld` title + 1-line `Privacy Intelligence` subtitle with `min-width: 0; overflow: hidden` so it never collides with right-side actions.
2. **Utility & Identity Zone (Right):**
   - `#open-side-panel-btn`: Compact icon-and-label button (icon-only below `380px` if tight) that **automatically hides** when `isSidePanelContext === true` (`hidden = true`), eliminating the redundant button inside the Side Panel.
   - `#mode-badge`: Compact status pill (`LOCAL` or `MANAGE`) with glowing status dot.
   - `#profile-avatar-btn`: **Circular user/profile avatar button** (`32px × 32px`, `border-radius: 9999px`) in the top-right corner with a subtle status ring:
     - **Emerald ring (`LOCAL`)**: Standalone local user (`Local` silhouette / initials).
     - **Cobalt ring (`Linked`)**: Linked account with user initials.
     - **Amber/Cobalt Shield ring (`MANAGE`)**: Managed organization profile.
3. **Profile & Mode Popover (`#profile-popover`):**
   - Accessible `role="dialog"` / popover anchored to the top-right corner, toggled by clicking `#profile-avatar-btn`, dismissible via **`Esc`**, **outside click**, or close button, returning focus to `#profile-avatar-btn`.
   - Displays:
     - **Identity Row:** Avatar badge + Display title (`"Local Standalone"` or linked `userEmail` / `tenantName`) + Subtitle (`"No account required"` or role/plan summary).
     - **Mode & Storage Guarantee Pill:** Current mode (`LOCAL` or `MANAGE` enforced org) + honest local processing summary (`"Page text and documents stay on this device"`).
     - **Quick Actions:**
       - `"Account & Management"` button -> closes popover, opens `Settings -> Profile & Account`.
       - `"Protection & Preferences"` button -> closes popover, opens `Settings -> Protection`.
       - `"Appearance & Language"` button -> closes popover, opens `Settings -> Appearance`.
   - Preserves privilege boundaries: never exposes `#org-settings` or secrets in the popover; links directly to the guarded Settings section.

---

## 5. Responsive Space Utilization (Popup vs Side Panel)

### Fixing the `360px` Width Trap
- Replace `html, body { width: 360px; }` with:
  - `html, body { width: 100%; min-width: 340px; margin: 0; padding: 0; overflow-x: hidden; }`
  - In **Popup context** (`body:not([data-surface="sidepanel"])` at narrow popup viewport): `.app` sits cleanly at `min-width: 380px` / `width: 100%` (`390px–400px` natural Chrome popup width), eliminating cramped wrapping.
  - In **Side Panel context** (`body[data-surface="sidepanel"]` or wide viewport): `.app` expands fluidly up to `880px` with balanced padding (`16px` narrow, `20px 24px` at `>= 520px`).
  - `redact.html` inherits `width: 100%` cleanly instead of `360px`.

### Viewport Breakpoints
1. **Popup (`380px–410px`) & Narrow Side Panel (`340px–519px`):**
   - Single-column task flow with compact **Live Protection Status Strip** (`40px` tall vs `170px` previously), prominent `Scan This Page` primary CTA, and compact 2-column quick action row (`Document Redaction` | `Create Personal Logic`).
   - Settings navigation rendered as a **compact horizontal scrollable pill strip** (`.settings-nav` flex-wrap / horizontal pill row, ~44px tall instead of ~280px stacked list) so Settings controls appear immediately above the fold.
2. **Wide Side Panel (`>= 520px`):**
   - **Settings Split Rail:** Two-column grid (`grid-template-columns: 184px minmax(0, 1fr)`), placing `.settings-nav` as a sticky vertical left rail beside `.settings-pages`!
   - **Review Tab Grid:** `.review-overview-grid` places Stats + Coverage side-by-side (`2fr 3fr` or 2-column cards) with Activity below.
   - **Protection Tab Wide Grid:** `.findings-list` expands to `max-height: 420px`, `.doc-thumbs` expands to larger readable columns (`minmax(150px, 1fr)`), and action buttons align cleanly.

---

## 6. End-to-End User Flows

### Flow 1: First-Run & Onboarding (`settings.disclosureAcknowledged`)
- **Entry:** User opens GovernWorld for the first time (`disclosureAcknowledged === false`).
- **UI:** A compact, dismissible **First-Run Welcome Card (`#first-run-welcome`)** appears cleanly at the top of `Protection`:
  - Explains the 3 core protections concisely:
    1. **Scan pages on demand** (`Scan This Page` or `Alt+Shift+S`).
    2. **Paste Shield defaults to This Tab** — optionally switch to **Always On** (requires revocable browser site access) to guard AI chats across tabs.
    3. **Documents are processed on-device** — PDF, Word, and images stay on this device.
  - **Primary CTA:** `"Got it"` (`#welcome-dismiss-btn`) persists `disclosureAcknowledged: true`.
  - **Optional Quick CTA:** `"Enable Always-On Shield"` (`#welcome-always-on-btn`) triggers `requestSiteAccess()` and activates `always-on` if granted (or updates status honestly to `"Waiting for access"` if denied).

### Flow 2: Page Scan, Findings, Masking & Export
- **Entry:** Protection tab -> compact **Live Protection Status Strip** showing real-time pills for:
  - `Page Scan` (`Ready` / `Scanning` / `N findings` / `Restricted tab`)
  - `Paste Shield` (`This Tab` / `Always On` / `Waiting for access` / `Off` — clicking jumps to Settings -> Protection or triggers site access grant)
  - `Documents` (`Ready` on Chromium / `Desktop Chromium only` on Firefox via `isDocumentPipelineSupported()`)
- **Primary Action:** Click `Scan This Page` (`#scan-btn`) -> loading state (`Scanning...`) -> displays `#scan-summary` + `#scan-compliance-card` + `#results-section` above the fold.
- **Empty / No-Text State:** If `visibleChars === 0`, displays honest guidance + `#image-capture` buttons to send visible page images to Document Studio for OCR.
- **Error State:** Non-scannable pages (`chrome://`, Web Store) or permission errors show inline `.status--error` message with clear recovery.
- **Mask & Export:** Users toggle findings, click `Apply Masks` / `Undo` / `Remove All` / `Copy Redacted` (via accessible `<dialog id="copy-dialog">`), or export via an **inline CSV / JSON format popover/bar** (replacing `window.confirm`).

### Flow 3: Document Studio (Popup -> Side Panel Handoff & Full-Screen Review)
- **Entry:** Click `Document Redaction` (`#open-doc-btn`) or `#doc-dropzone` (or drag-and-drop directly).
- **Popup Handoff:** Inside an ephemeral popup (`!isSidePanelContext && chrome.sidePanel?.open`), clicking `#open-doc-btn` or `#doc-dropzone` opens the **Side Panel** (persisting `docHandoffPending` in `chrome.storage.local` so the Side Panel highlights and focuses `#doc-dropzone`), preventing Chrome from closing the popup when the OS file picker opens! Drag-and-drop directly onto `#doc-dropzone` continues to work in both popup and side panel.
- **Processing & Windowing:** Displays `#doc-progress` with `Cancel`, `#doc-window-dialog` for >20-page PDFs, `#doc-window-warning` & `#doc-text-limit-warning` disclosures, and `#doc-open-review-btn` (`Open full-screen review` -> `review.html`) as the primary review workspace, plus `Redact & Download` and `Print / Save as PDF…` (`redact.html`).
- **Firefox / Unsupported State:** On browsers without `chrome.offscreen`, the Live Status Strip and Document section clearly display the capability limitation (`DOCUMENT_PIPELINE_UNAVAILABLE_MESSAGE`) and disable unsupported upload triggers instead of failing silently.

### Flow 4: Logic (Personal Logic & Site Policy Studio)
- **Focus:** Keeps `Personal Logic` (4-step Wizard + JSON import/export, replacing native `alert()` with inline `#wizard-step1-error` / `#wizard-step4-error` validation messages) and `Policy Studio` (site-specific DLP rules + templates) front and center.
- **Unavailable Community Controls:** Tucked cleanly into a collapsed `<details class="community-disclosure">` footer noting `"Community rule packs are not active in this release"` (preserving DOM IDs and `claims-accuracy.test.ts` compliance without cluttering primary controls with disabled buttons).

### Flow 5: Review & Activity (Live Telemetry)
- **Live Counters:** `#review-findings-count`, `#review-protected-count`, and `#review-pages-count` compute real totals from `auditLog` in `chrome.storage.local` (plus current tab session findings), updating on init, scan completion, mask application, document redaction, and audit clear.
- **Activity Feed:** `#activity-list` renders the most recent local audit events (timestamp, action badge, masked count — never raw PII) or `#activity-empty` when empty.
- **Coverage Details:** `#coverage-details-btn` calls `switchTab("settings")` AND `switchSettingsPage("privacy")`.

### Flow 6: Settings (Clean Nav, Honest Pairing, Organized About)
- **Fix Broken Markup:** Fix all 7 malformed `> id="settings-nav-..."` attributes in `src/popup/index.html`.
- **Office Manager Pairing:** When `127.0.0.1:4820` pairing fails, display an honest connection error (`"Unable to reach local Office Coordinator at 127.0.0.1:4820. Check that the service is running."`) instead of writing a simulated `"GovernWorld Medical Practice"` lock.
- **Audit Clear Fix:** `#clear-audit-confirm` clears `"auditLog"` and `"auditCheckpointState"` (matching `src/shared/audit.ts`) and refreshes Review telemetry immediately.
- **Clean About & Diagnostics:** Keep Diagnostics grid, signed audit export, Reset/Clear actions, and Legal/Privacy links immediately accessible at the top, and organize the long-form explainers, open-source notices, Support card, and 21 `.guide-card` items into clean collapsible `<details>` sections (auto-opening the Guides `<details>` whenever a `[data-guide="guide-..."]` contextual link is clicked!).

---

## 7. Harmonized Design Tokens

Aligning `popup.css`, `review.css`, `redact.html`, `toast.ts`, and `pasteGuard.ts` around a single cohesive **Obsidian-Slate + Cyan Shield** palette:
- `--bg`: `#0a0f1a` (Canvas)
- `--bg-elevated`: `#111a2b` (Cards, Popovers, Modals)
- `--bg-inset`: `#0d1424` (Inputs, Nested Lists)
- `--border`: `#1e2b40` / `--border-strong`: `#2e405c`
- `--text`: `#e2e8f0` / `--text-muted`: `#94a3b8` / `--text-faint`: `#64748b`
- `--accent`: `#22d3ee` / `--accent-strong`: `#0ea5e9`
- `--ok`: `#34d399` / `--warning`: `#fbbf24` / `--danger`: `#f87171`
- Note on Claims Accuracy: All UI copy, HTML, and `i18n.ts` strings strictly avoid `"100% local"`, `"your data never leaves"`, `"proactive"`, `"tamper-evident"`, or unbundled OCR language names, using accurate statements (`"Page text and documents stay on this device"`, `"Local processing by default"`).
