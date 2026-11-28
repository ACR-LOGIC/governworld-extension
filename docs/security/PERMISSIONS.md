# GovernWorld Redaction — Permission Justification

Chrome Web Store reviewers ask why an extension needs each permission. This
document maps every permission in `manifest.json` to the exact feature that
uses it, and lists permissions the extension deliberately does **not** request.

## Requested permissions

| Permission   | Why it is needed | Used by |
|--------------|------------------|---------|
| `activeTab`  | Grants one-time access to the current tab **only** after the user presses "Scan this page". The extension never gains background access to all tabs and never scans without user action. | `src/service-worker/index.ts` (injection orchestration) |
| `scripting`  | Injects the content script that extracts visible text and renders overlay masks into the active tab, only after the `activeTab` grant. | `src/service-worker/index.ts` |
| `storage`    | Persists user preferences (detection categories, mode) in `chrome.storage.local` and ephemeral scan session state in `chrome.storage.session`. Never stores raw content. | `src/shared/settings.ts`, `src/service-worker/index.ts` |
| `downloads`  | Saves the flattened redacted copy the user explicitly creates, with the browser's save dialog (`saveAs: true`). The original file is never touched. | `src/service-worker/documents.ts` |
| `offscreen`  | Runs document rendering (pdf.js) and OCR (tesseract.js) in a dedicated offscreen document, because MV3 service workers have no DOM or `Worker` API. | `src/offscreen/offscreen.ts` |
| `sidePanel`  | Shows the GovernWorld side panel, a persistent surface for scanning, findings review, document redaction, notifications, and account/extension-license management. It opens via the popup's "Open side panel" button and the `Alt+Shift+P` command. | `manifest.json` (`side_panel`, `commands`), `src/service-worker/index.ts` (`chrome.sidePanel.open`), `src/popup/popup.ts` |
| `contextMenus` | Adds on-demand entries to the browser context menu — "Open GovernWorld Side Panel", "Scan page for sensitive data", "Redact selection to clipboard", and "Mask selected text" — so users can open the side panel or start right-click redaction/scanning actions with immediate status/toast confirmation. Scan and selection entries are created only while the user setting is enabled and removed when disabled, and page/selection entries still require an explicit user click. | `src/service-worker/index.ts` (`syncContextMenus`, `chrome.contextMenus.onClicked`), `src/shared/settings.ts` (`contextMenusEnabled`) |
| `alarms`       | Schedules periodic lightweight status checks and policy synchronization strictly when paired in MANAGE mode. Completely inactive with zero network calls in standalone LOCAL mode. | `src/service-worker/heartbeatService.ts` |

## Optional permissions (requested at runtime, never at install)

| Permission      | Why it is requested | When |
|-----------------|---------------------|------|
| `notifications` | Raises a system notification when a scan finds sensitive data — only if the user enables the "Notify me" toggle. Denied requests simply stay off; no functionality depends on it. | Side panel → Notifications toggle |
| `http://*/*`, `https://*/*` (optional host access) | Lets the always-on paste-protection mode guard pages on every site the user visits. Requested only when the user switches always-on on; denied or revoked access leaves the default this-tab mode fully working. The registration is removed when always-on is off, so revoking genuinely stops coverage. | Protection settings → Always-on toggle |

## Declared `host_permissions`

**Pinned coordinator origin only (`https://lkgcehdwasewwoieyoip.supabase.co/*`).** Declared solely for optional organizational `MANAGE` mode (email-bound pairing redemption, Ed25519-signed policy synchronization, closed-schema heartbeats, and uninstall status checks). Default standalone `LOCAL` installs make zero network requests and hold **zero install-time access to websites**; optional `http://*/*` and `https://*/*` access is runtime-only for Always-On Paste Shield.

## Permissions the extension deliberately does NOT request

| Permission     | Why it is avoided |
|----------------|-------------------|
| Automatic (install-time) host permissions / `<all_urls>` | No background or automatic access to web traffic or sites. Page access for always-on is optional, runtime-granted http(s) only, and revocable. |
| `tabs`         | Unnecessary; `activeTab` covers the one user-chosen tab without requesting browsing history. |
| `webRequest`   | The extension must not observe or modify network traffic. |
| `clipboardRead`| Clipboard writes use the standard `navigator.clipboard.writeText` with no read permission. |
| `history` / `bookmarks` | No feature touches browsing history or bookmarks. |
| `cookies`      | No cookies are read or written. |
| `notifications`| Requested only as an optional permission (see above) — never required at install. |

## Data handling in LOCAL vs. MANAGE Modes

- **Zero Sensitive Data Transmission:** In both LOCAL and MANAGE modes, no raw scanned text, document contents, page snapshots, clipboard data, OCR text, or PHI/PII are ever transmitted over the network.
- **MANAGE Mode Policy Synchronization & Isolated Telemetry:** When explicitly paired in `MANAGE` mode via single-entry Office Manager Coordination (after accepting the pre-pairing administrator-lock consent dialog) or via OS-managed `chrome.storage.managed`, network communication is strictly limited to extension-initiated Ed25519-signed policy retrieval, periodic 15-minute `alarms` closed-schema health checks emitted from isolated `telemetryWorker.ts` (`telemetry-worker.js`), and `runtime.setUninstallURL` removal signaling (`status`, `browser_family`, UTC timestamps, policy/extension versions and integrity hashes — strictly rejecting dynamic/free-text fields). Admin-mandated baselines lock automatically (with separate per-feature administrator `"Unlock for User"` delegation) and cannot be unpaired locally by the user, while employee accessibility controls stay unlocked. Browsing history, visited URLs, search queries, page text, credentials, chats, and personal files are never transmitted.


- No raw scanned text or page snapshots are persisted to storage, logs, telemetry, analytics, or error reporting.
- Scan session state lives in `chrome.storage.session` (cleared on browser restart) and holds findings metadata with masked previews only.
- File bytes and derived `::preview::` / `::page::` / `::redacted::` keys for the document you open are staged in the extension's private IndexedDB only while you review or redact the file. Pressing **Cancel** aborts active rendering/OCR via `AbortSignal` and deletes all keys under that file's prefix; **Start Over**, clear-data, completed redaction, browser startup, and extension install/update remove them, and orphaned keys without a live session are purged on service-worker startup (active in-session documents survive routine MV3 wake cycles). Staged documents that outlive cleanup are bounded by a TTL (`STAGED_DOCUMENT_TTL_MS`, 7 days, with write timestamps in the document store); the TTL sweep runs on service-worker startup and skips documents with live sessions or in-flight jobs.
- No scan content or raw sensitive data is transmitted to the cloud. All detection, OCR, and redaction execute locally on your machine, and the document pipeline has no network path at all.

---

Last verified on: November 28, 2026