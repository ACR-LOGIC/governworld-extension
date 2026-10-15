// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { validateMessage, type ImageCandidate } from "../shared/messages.js";
import { loadSettings, saveSettings, isCloudAllowed, isAllowedGatewayOrigin, meetsThreshold } from "../shared/settings.js";
import { recordAudit, exportSignedAuditLog } from "../shared/audit.js";
import type { Settings } from "../shared/settings.js";
import type { DocKind, PopupState, ScanMode, WorkerMessage, ExtensionMessage, Finding, FindingCategory, PopupFromWorker, Rect, RedactionOptions, ScanSettingsMessage, ScanCoverageStatus } from "../shared/types.js";
import { previewDocument, redactDocument, countDocument, restoreLastSession, clearSession as clearDocSession, clearAllFiles, storeFile, deleteFile, hasStagedDocument } from "./documents.js";
import { analyzeExamples, testPattern } from "../shared/wizardAnalyzer.js";
import { captureImage, stageCapturedImage, ImageCaptureError } from "./captureImage.js";
import {
  GovernWorldApiClient,
  getApiUrl,
  setApiUrl,
  getStoredTokens,
  saveAuthSession,
  clearAuthSession,
  getAuthMetadata,
  checkHealth,
  performBootstrap,
  syncPolicy,
  submitLogic,
  getCachedCapabilities,
} from "../api/index.js";
import type { AuthTokens } from "../api/types.js";
import {
  generateOAuthState,
  verifyOAuthState,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
} from "../api/auth.js";
import { buildAccountView, parseAccountView, NO_ACCOUNT } from "../shared/account.js";
import type { AccountView } from "../shared/account.js";
import {
  loadCustomPatterns,
  saveCustomPattern,
  deleteCustomPattern,
  loadCommunityAccount,
  unlinkCommunityAccount,
  saveCommunityAccount,
} from "../shared/customPatterns.js";
import { syncSiteProtection } from "./siteProtection.js";
import { loadEnterprisePolicy, resolveEffectiveProtection } from "../shared/enterprisePolicy.js";

/**
 * Scan settings with admin-mandated categories merged in. Page scans must not
 * narrow below the enterprise floor: without this, a locked policy would hold
 * for pastes but silently miss mandated categories on scans.
 */
async function buildEffectiveScanSettingsMessage(settings: Settings): Promise<ScanSettingsMessage> {
  try {
    const policy = await loadEnterprisePolicy();
    return buildScanSettingsMessage(
      settings,
      resolveEffectiveProtection(settings, policy).enabledCategories
    );
  } catch {
    return buildScanSettingsMessage(settings);
  }
}

/**
 * Extension service worker (MV3). Permission-aware orchestration: owns all
 * network requests (none in local mode), enforces consent gating, injects the
 * content script only after a deliberate user action, and validates every
 * message from popup/content scripts before acting on it.
 */

const SESSION_KEY_PREFIX = "scan:";
const SCAN_TIMEOUT_MS = 60_000;
/** How long a transient outcome marker stays on the badge. */
const TAB_STATUS_MS = 4_000;
const FETCH_TIMEOUT_MS = 10_000;

function buildScanSettingsMessage(
  settings: Settings,
  enabledCategories: ScanSettingsMessage["enabledCategories"] = settings.enabledCategories
): ScanSettingsMessage {
  return {
    enabledCategories,
    maxVisibleChars: settings.maxVisibleChars,
    maxNodeChars: settings.maxNodeChars,
    maskPlaceholders: settings.maskPlaceholders,
    sessionTimeoutMs:
      settings.sessionTimeout === "never"
        ? 0
        : settings.sessionTimeout === "5m"
          ? 5 * 60 * 1000
          : settings.sessionTimeout === "15m"
            ? 15 * 60 * 1000
            : 30 * 60 * 1000,
  };
}

async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface SessionState {
  sessionId: string;
  mode: ScanMode;
  findings: Finding[];
  /**
   * Carries the honest scan verdict across the worker lifetime. It is stored
   * rather than recomputed because the worker is terminated between the scan
   * and the popup opening, and a coverage panel that fell back to "unknown" on
   * every reopen would be worse than useless.
   */
  stats: {
    visibleChars: number;
    truncated: boolean;
    findingsTruncated?: boolean;
    totalFindings?: number;
    imageCandidates?: ImageCandidate[];
    coverageStatus?: ScanCoverageStatus;
    deferredMediaCount?: number;
  };
  scannedAt: number;
  scanning: boolean;
  /** Stack of previously-applied finding-id sets for undo. Newest last. */
  maskHistory?: string[][];
}

const MAX_MASK_HISTORY = 10;

function pushMaskHistory(state: SessionState, appliedIds: string[]): SessionState {
  const history = [...(state.maskHistory ?? []), appliedIds];
  return { ...state, maskHistory: history.slice(-MAX_MASK_HISTORY) };
}

const pendingScans = new Map<number, { requestId: string; sessionId: string; timer: ReturnType<typeof setTimeout> }>();

function sessionKey(tabId: number): string {
  return `${SESSION_KEY_PREFIX}${tabId}`;
}

/**
 * Runtime guard for a value read back out of chrome.storage.session.
 *
 * Storage is a trust boundary: any extension page can write to it, and the
 * value may be absent, truncated, or written by an older version of the
 * extension. Returning it unvalidated would let a malformed session drive the
 * scan flow, so an unrecognisable value is treated as "no session" and the
 * caller starts fresh.
 */
function isSessionState(value: unknown): value is SessionState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<SessionState>;
  return (
    typeof v.sessionId === "string" &&
    (v.mode === "local" || v.mode === "cloud") &&
    Array.isArray(v.findings) &&
    typeof v.stats === "object" &&
    v.stats !== null &&
    typeof v.stats.visibleChars === "number" &&
    typeof v.stats.truncated === "boolean" &&
    (v.stats.findingsTruncated === undefined || typeof v.stats.findingsTruncated === "boolean") &&
    (v.stats.totalFindings === undefined ||
      (typeof v.stats.totalFindings === "number" &&
        Number.isSafeInteger(v.stats.totalFindings) &&
        v.stats.totalFindings >= 0)) &&
    // A stored verdict from an older build, or one written by a future build
    // with a different enum, must not be surfaced as-is. Dropping it makes the
    // panel show "not completed", which is the safe direction.
    (v.stats.coverageStatus === undefined || SCAN_COVERAGE_STATUS_VALUES.has(v.stats.coverageStatus)) &&
    (v.stats.deferredMediaCount === undefined ||
      (typeof v.stats.deferredMediaCount === "number" &&
        Number.isSafeInteger(v.stats.deferredMediaCount) &&
        v.stats.deferredMediaCount >= 0)) &&
    typeof v.scannedAt === "number" &&
    typeof v.scanning === "boolean"
  );
}

const SCAN_COVERAGE_STATUS_VALUES: ReadonlySet<string> = new Set<ScanCoverageStatus>([
  "FULLY_SCANNED",
  "PARTIALLY_SCANNED",
  "UNSUPPORTED_CONTENT_PRESENT",
  "BLOCKED_BY_BROWSER_SECURITY",
  "NO_SENSITIVE_DATA_DETECTED",
  "SCAN_FAILED",
]);

async function readSession(tabId: number): Promise<SessionState | null> {
  const key = sessionKey(tabId);
  const raw: unknown = await chrome.storage.session.get(key);
  if (typeof raw !== "object" || raw === null) return null;
  const value = (raw as Record<string, unknown>)[key];
  return isSessionState(value) ? value : null;
}

async function writeSession(tabId: number, state: SessionState): Promise<void> {
  await chrome.storage.session.set({ [sessionKey(tabId)]: state });
}

async function clearSession(tabId: number): Promise<void> {
  await chrome.storage.session.remove(sessionKey(tabId));
  clearBadgeForTab(tabId);
}

export function updateBadgeForTab(tabId: number, count: number): void {
  try {
    if (chrome.action?.setBadgeText) {
      void chrome.action.setBadgeText({
        tabId,
        text: count > 0 ? (count > 99 ? "99+" : String(count)) : "",
      }).catch(() => undefined);
    }
    if (chrome.action?.setBadgeBackgroundColor) {
      void chrome.action.setBadgeBackgroundColor({
        tabId,
        color: count > 0 ? "#E53E3E" : "#2563EB",
      }).catch(() => undefined);
    }
  } catch {
    // Best-effort badge update
  }
}

export function clearBadgeForTab(tabId: number): void {
  try {
    if (chrome.action?.setBadgeText) {
      void chrome.action.setBadgeText({ tabId, text: "" }).catch(() => undefined);
    }
  } catch {
    // Best-effort badge clear
  }
}

/** Transient per-tab badge markers for actions that have no open UI. */
type TabStatus = "ok" | "failed";

const TAB_STATUS_PREFIX = "action-status:";
const tabStatusTimers = new Map<number, ReturnType<typeof setTimeout>>();

function tabStatusKey(tabId: number): string {
  return `${TAB_STATUS_PREFIX}${tabId}`;
}

/**
 * The marker deadline lives in storage.session, not just in a timer, because
 * MV3 terminates an idle worker at will. A timer alone would leave a `!` stuck
 * on the toolbar for the rest of the browser session if the worker happened to
 * be reclaimed in the four seconds the marker was meant to last — replacing one
 * kind of dishonesty with another. The deadline is read back at worker start so
 * an abandoned marker is put right even then.
 */
async function persistTabStatus(tabId: number, expiresAt: number): Promise<void> {
  try {
    await chrome.storage.session.set({ [tabStatusKey(tabId)]: expiresAt });
  } catch {
    // The in-memory timer still restores the badge; storage is the belt.
  }
}

/**
 * Report the outcome of an action the user started from somewhere with no
 * surface to show it on — a right-click menu item, a keyboard shortcut.
 *
 * A context-menu click never has the popup open, and a successful action is
 * self-evident: masks appear on the page, the redacted text lands on the
 * clipboard. A FAILURE is not self-evident at all. The worker used to discard
 * the content script's reply entirely, so "no text selected" and the genuine
 * work of redacting a selection were indistinguishable — the menu item that
 * cannot possibly succeed (it is registered for the `page` context) sat there
 * doing nothing, silently, forever.
 *
 * The badge is the only always-available per-tab surface: it needs no
 * permission, is not gated on a setting, and clears itself on navigation. The
 * finding count it normally shows is restored when the marker expires, so the
 * two never disagree for longer than the marker is meant to be read.
 */
function flashTabStatus(tabId: number, status: TabStatus): void {
  const text = status === "ok" ? "\u2713" : "!";
  const color = status === "ok" ? "#2563EB" : "#E53E3E";
  try {
    void chrome.action?.setBadgeText?.({ tabId, text }).catch(() => undefined);
    void chrome.action?.setBadgeBackgroundColor?.({ tabId, color }).catch(() => undefined);
  } catch {
    // Best-effort
  }
  const existing = tabStatusTimers.get(tabId);
  if (existing) clearTimeout(existing);
  const expiresAt = Date.now() + TAB_STATUS_MS;
  void persistTabStatus(tabId, expiresAt);
  tabStatusTimers.set(
    tabId,
    setTimeout(() => {
      tabStatusTimers.delete(tabId);
      void restoreFindingBadge(tabId);
    }, TAB_STATUS_MS)
  );
}

/**
 * Put right any status marker whose worker was reclaimed before its timer
 * fired. Runs at worker start, next to the site-protection reconciliation.
 */
export async function reconcileTabStatuses(): Promise<void> {
  try {
    const stored = await chrome.storage.session.get(null);
    const now = Date.now();
    const expired: number[] = [];
    const expiredKeys: string[] = [];
    const garbageKeys: string[] = [];
    for (const [key, value] of Object.entries(stored)) {
      if (!key.startsWith(TAB_STATUS_PREFIX)) continue;
      const tabId = Number(key.slice(TAB_STATUS_PREFIX.length));
      if (!Number.isSafeInteger(tabId) || tabId < 0) {
        // Not something we wrote. Left alone rather than deleted: this worker
        // is not the only writer of chrome.storage.session.
        garbageKeys.push(key);
        continue;
      }
      // A marker whose deadline has passed needs its badge put right. A marker
      // whose deadline has NOT passed is still legitimately on screen — the
      // failure it reports has not been read yet — so it is kept and its timer
      // rescheduled. Clearing it here would drop the only record that the badge
      // is showing a failure, leaving a "!" nothing can ever clear.
      if (typeof value !== "number" || !Number.isFinite(value) || value <= now) {
        expired.push(tabId);
        expiredKeys.push(key);
      }
    }
    void garbageKeys;
    if (expiredKeys.length === 0) return;
    await chrome.storage.session.remove(expiredKeys);
    for (const tabId of expired) await restoreFindingBadge(tabId);
  } catch {
    // Housekeeping is best-effort: a failure must never block the worker.
  }
}

/** Put the finding count back after a transient status marker expires. */
async function restoreFindingBadge(tabId: number): Promise<void> {
  const session = await readSession(tabId);
  if (session) updateBadgeForTab(tabId, session.findings.length);
  else clearBadgeForTab(tabId);
}

/**
 * Tell the user an action failed, out loud when they have asked to be told.
 *
 * The badge marker is the floor: it always happens. A notification is additive
 * and stays behind the same gates as every other notification this extension
 * sends (the setting AND the optional permission), because a failure notice is
 * not worth overriding a user's stated preference for.
 */
async function reportActionFailure(tabId: number, userMessage: string): Promise<void> {
  flashTabStatus(tabId, "failed");
  console.warn(`[governworld] ${userMessage}`);
  try {
    const settings = await loadSettings();
    if (!settings.notificationsEnabled) return;
    if (!(await notificationsGranted())) return;
    await chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
      title: "GovernWorld \u2014 action not completed",
      message: userMessage,
      priority: 0,
    });
  } catch {
    // A failed notice must never escalate into a failed action.
  }
}

/** True when the content script confirmed the action rather than refusing it. */
function actionOk(response: unknown): boolean {
  return typeof response === "object" && response !== null && (response as { ok?: unknown }).ok === true;
}

/** The content script's error string, when it refused. Never page content. */
function actionError(response: unknown): string | undefined {
  if (actionOk(response)) return undefined;
  const error = (response as { error?: unknown } | null)?.error;
  return typeof error === "string" && error.length > 0 && error.length <= 200 ? error : undefined;
}

/**
 * Category counts from a content-script reply, for a metadata-only audit
 * record. Storage is a trust boundary, so the shape is re-validated rather than
 * trusted: a malformed counts object is dropped, never coerced.
 */
function actionCounts(response: unknown): Record<string, number> | undefined {
  const counts = (response as { counts?: unknown } | null)?.counts;
  if (typeof counts !== "object" || counts === null) return undefined;
  const clean: Record<string, number> = {};
  for (const [key, value] of Object.entries(counts as Record<string, unknown>)) {
    if (typeof key !== "string" || key.length === 0 || key.length > 64) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
    clean[key] = value;
  }
  return Object.keys(clean).length > 0 ? clean : undefined;
}

export function isInternalExtensionUrl(url?: string): boolean {
  if (!url) return false;
  return (
    url.startsWith("chrome-extension://") ||
    url.startsWith("chrome://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:") ||
    url.startsWith("view-source:")
  );
}

/**
 * A tab GovernWorld can actually scan: an identified, ordinary web page.
 * Internal extension pages and the extension's own URLs are never scannable.
 */
export function isScannableTab(tab: chrome.tabs.Tab | undefined): tab is chrome.tabs.Tab {
  if (!tab?.id || !tab.url) return false;
  if (isInternalExtensionUrl(tab.url)) return false;
  return tab.url.startsWith("http://") || tab.url.startsWith("https://");
}

/**
 * Resolve the web page a scan should target.
 *
 * Only a real web page is ever returned. Earlier this fell back to the focused
 * tab after filtering extension URLs out, which meant an extension page (the
 * popup, or landing/privacy opened as a tab) could be handed back as a scan
 * target. Scan sessions are keyed by tab id, so the worker then looked for a
 * session belonging to the extension and reported "Run a scan first" for a scan
 * that had in fact succeeded. Returning nothing is the honest answer: there is
 * no page to scan. Callers already treat undefined as "no session".
 */
export async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  // Strategy 1: Active tab in last focused window
  const [focusedTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (isScannableTab(focusedTab)) {
    return focusedTab;
  }

  // Strategy 2: Active tab in current window
  const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (isScannableTab(currentTab)) {
    return currentTab;
  }

  // Strategy 3: Any active HTTP/HTTPS tab in any window
  const allTabs = await chrome.tabs.query({});
  return allTabs.find((t) => t.active && isScannableTab(t));
}

function notifyPopup(message: PopupFromWorker): void {
  void chrome.runtime.sendMessage(message).catch(() => {
    // Popup may be closed; state lives in storage.session for the next open.
  });
}

/**
 * Base64-encode bytes without blowing the argument limit.
 *
 * `String.fromCharCode(...bytes)` throws "Maximum call stack size exceeded" on
 * anything but small inputs, and a 24-megapixel image is far past that. The
 * buffer is walked in chunks instead.
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function ensureContentScriptReady(tabId: number): Promise<boolean> {
  // Step 1: PING first — the content script may already be loaded.
  try {
    const response = (await chrome.tabs.sendMessage(tabId, { type: "PING" })) as { ok?: boolean } | undefined;
    if (response?.ok) return true;
  } catch {
    // No content script responding — fall through to injection.
  }
  // Step 2: Inject content.js.
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch (error) {
    console.warn(`[governworld] Unable to dynamically inject content script on tab ${tabId}:`, error);
    return false;
  }
  // Step 3: PING again with retry — injection completion does not guarantee
  // the content script has finished loading and registered its listener.
  // The old code waited a fixed 80ms and returned true unconditionally, which
  // raced the content script startup and intermittently failed with
  // "Could not establish connection. Receiving end does not exist."
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      const response = (await chrome.tabs.sendMessage(tabId, { type: "PING" })) as { ok?: boolean } | undefined;
      if (response?.ok) return true;
    } catch {
      // Not ready yet — retry.
    }
  }
  console.warn(`[governworld] Content script on tab ${tabId} did not become ready after injection`);
  return false;
}

async function sendToTab(tabId: number, message: unknown): Promise<unknown> {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // Content script may have been uninitialized or destroyed by navigation; inject dynamically and retry.
    await ensureContentScriptReady(tabId);
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

/** A mask command succeeded only when the content script explicitly said so. */
function maskCommandOk(response: unknown): boolean {
  return typeof response === "object" && response !== null && (response as { ok?: boolean }).ok === true;
}

function buildPopupState(
  settings: Settings,
  session: SessionState | null,
  error?: { code: string; userMessage: string }
): PopupState {
  return {
    mode: settings.mode,
    scanning: session?.scanning ?? false,
    findings: session?.findings ?? [],
    scanned: session !== null,
    truncated: (session?.stats.truncated ?? false) || (session?.stats.findingsTruncated ?? false),
    findingsTruncated: session?.stats.findingsTruncated,
    totalFindings: session?.stats.totalFindings,
    visibleChars: session?.stats.visibleChars ?? 0,
    // Only meaningful when the scan read nothing: the page's document-sized
    // images, which the popup offers to send through the Document Studio.
    imageCandidates: session?.stats.imageCandidates,
    error,
    consentRequired: settings.mode === "cloud" && !isCloudAllowed(settings),
    sessionId: session?.sessionId,
    // Carried so the coverage panel reports the real outcome. Without these the
    // panel's five tick marks are static markup asserting a clean bill of
    // health the scan never gave.
    coverageStatus: session?.stats.coverageStatus,
    deferredMediaCount: session?.stats.deferredMediaCount,
  };
}

async function stateForActiveTab(): Promise<PopupState> {
  const settings = await loadSettings();
  const tab = await getActiveTab();
  const session = tab ? await readSession(tab.id ?? -1) : null;
  return buildPopupState(settings, session);
}

async function handlePopupScan(mode: ScanMode, requestId: string): Promise<void> {
  const settings = await loadSettings();

  if (mode === "cloud" && !isCloudAllowed(settings)) {
    notifyPopup({
      type: "POPUP_STATE",
      requestId,
      state: buildPopupState(settings, null, {
        code: "CLOUD_NOT_ALLOWED",
        userMessage: "Cloud analysis is disabled. Scans run locally on this device.",
      }),
    });
    return;
  }

  const tab = await getActiveTab();
  if (!tab?.id) {
    notifyPopup({
      type: "POPUP_STATE",
      requestId,
      state: buildPopupState(settings, null, {
        code: "NO_ACTIVE_TAB",
        userMessage: "No active tab to scan.",
      }),
    });
    return;
  }

  const sessionId = crypto.randomUUID();
  const tabId = tab.id;
  const timer = setTimeout(() => {
    pendingScans.delete(tabId);
    void (async () => {
      await clearSession(tabId);
      notifyPopup({
        type: "POPUP_STATE",
        requestId,
        state: buildPopupState(settings, null, {
          code: "SCAN_TIMEOUT",
          userMessage: "Scan timed out. Try again.",
        }),
      });
    })().catch(() => undefined);
  }, SCAN_TIMEOUT_MS);
  pendingScans.set(tab.id, { requestId, sessionId, timer });

  await writeSession(tab.id, { sessionId, mode, findings: [], stats: { visibleChars: 0, truncated: false, findingsTruncated: false, totalFindings: 0, imageCandidates: undefined, coverageStatus: undefined, deferredMediaCount: 0 }, scannedAt: Date.now(), scanning: true });

  const message: WorkerMessage = {
    type: "SCAN_PAGE",
    requestId,
    mode,
    sessionId,
    settings: await buildEffectiveScanSettingsMessage(settings),
  };
  await sendToTab(tab.id, message);
}

/** True when the action ran; false when the popup was told it could not. */
async function handlePopupApplyMasks(findingIds: string[], requestId: string): Promise<boolean> {
  const tab = await getActiveTab();
  const settings = await loadSettings();
  const session = tab?.id ? await readSession(tab.id) : null;
  if (!tab?.id || !session) {
    notifyPopup({ type: "POPUP_STATE", requestId, state: buildPopupState(settings, session, { code: "NO_SESSION", userMessage: "Run a scan first." }) });
    return false;
  }
  const response = await sendToTab(tab.id, { type: "APPLY_MASKS", requestId, sessionId: session.sessionId, findingIds });
  if (!maskCommandOk(response)) {
    notifyPopup({ type: "POPUP_STATE", requestId, state: buildPopupState(settings, session, { code: "STALE_SESSION", userMessage: "This scan session is no longer active. Run a scan again." }) });
    return false;
  }
  const idSet = new Set(findingIds);
  const withHistory = pushMaskHistory(session, findingIds);
  const updated: SessionState = { ...withHistory, findings: withHistory.findings.map((f) => ({ ...f, selected: idSet.has(f.id) })) };
  await writeSession(tab.id, updated);
  void recordAudit({
    ts: new Date().toISOString(),
    action: "masks_applied",
    counts: countByCategory(updated.findings.filter((f) => idSet.has(f.id))),
    outcome: "ok",
  });
  notifyPopup({ type: "POPUP_STATE", requestId, state: buildPopupState(settings, updated) });
  return true;
}

async function handlePopupUndoMasks(requestId: string): Promise<void> {
  const tab = await getActiveTab();
  const settings = await loadSettings();
  const session = tab?.id ? await readSession(tab.id) : null;
  if (!tab?.id || !session || !session.maskHistory || session.maskHistory.length === 0) {
    notifyPopup({ type: "POPUP_STATE", requestId, state: buildPopupState(settings, session, { code: "NO_HISTORY", userMessage: "Nothing to undo." }) });
    return;
  }
  const history = [...session.maskHistory];
  const previousIds = history.pop() as string[];
  const undoResponse = await sendToTab(tab.id, { type: "APPLY_MASKS", requestId, sessionId: session.sessionId, findingIds: previousIds });
  if (!maskCommandOk(undoResponse)) {
    notifyPopup({ type: "POPUP_STATE", requestId, state: buildPopupState(settings, session, { code: "STALE_SESSION", userMessage: "This scan session is no longer active. Run a scan again." }) });
    return;
  }
  const idSet = new Set(previousIds);
  const updated: SessionState = { ...session, maskHistory: history, findings: session.findings.map((f) => ({ ...f, selected: idSet.has(f.id) })) };
  await writeSession(tab.id, updated);
  notifyPopup({ type: "POPUP_STATE", requestId, state: buildPopupState(settings, updated) });
}

/** True when the action ran; false when the popup was told it could not. */
async function handlePopupRemoveMasks(requestId: string): Promise<boolean> {
  const tab = await getActiveTab();
  const settings = await loadSettings();
  const session = tab?.id ? await readSession(tab.id) : null;
  if (!tab?.id || !session) {
    notifyPopup({ type: "POPUP_STATE", requestId, state: buildPopupState(settings, session, { code: "NO_SESSION", userMessage: "Run a scan first." }) });
    return false;
  }
  const removeResponse = await sendToTab(tab.id, { type: "REMOVE_MASKS", requestId, sessionId: session.sessionId });
  if (!maskCommandOk(removeResponse)) {
    notifyPopup({ type: "POPUP_STATE", requestId, state: buildPopupState(settings, session, { code: "STALE_SESSION", userMessage: "This scan session is no longer active. Run a scan again." }) });
    return false;
  }
  const updated: SessionState = { ...session, findings: session.findings.map((f) => ({ ...f, selected: false })) };
  await writeSession(tab.id, updated);
  void recordAudit({ ts: new Date().toISOString(), action: "masks_removed", outcome: "ok" });
  notifyPopup({ type: "POPUP_STATE", requestId, state: buildPopupState(settings, updated) });
  return true;
}

async function handlePopupCopyRedacted(findingIds: string[], requestId: string): Promise<void> {
  const tab = await getActiveTab();
  const session = tab?.id ? await readSession(tab.id) : null;
  if (!tab?.id || !session) {
    const settings = await loadSettings();
    notifyPopup({ type: "POPUP_STATE", requestId, state: buildPopupState(settings, session, { code: "NO_SESSION", userMessage: "Run a scan first." }) });
    return;
  }
  await sendToTab(tab.id, { type: "COPY_REDACTED_TEXT", requestId, sessionId: session.sessionId, findingIds });
}

async function handlePopupClearData(requestId: string): Promise<void> {
  const tab = await getActiveTab();
  const settings = await loadSettings();
  if (tab?.id) {
    const session = await readSession(tab.id);
    if (session) {
      await sendToTab(tab.id, { type: "REMOVE_MASKS", requestId, sessionId: session.sessionId });
      await clearSession(tab.id);
    }
  }
  await clearAllFiles();
  const cleared: Settings = { ...settings, disclosureAcknowledged: false };
  await saveSettings(cleared);
  void recordAudit({ ts: new Date().toISOString(), action: "session_cleared", outcome: "ok" });
  notifyPopup({ type: "POPUP_STATE", requestId, state: buildPopupState(cleared, null) });
}

async function handlePopupSetMode(mode: ScanMode, requestId: string): Promise<void> {
  const settings = await loadSettings();
  if (mode === "cloud" && !isCloudAllowed(settings)) {
    // No gateway deployment exists. Fail closed: never allow a cloud mode that
    // could imply network transmission. The seam stays deny-by-default.
    notifyPopup({
      type: "POPUP_STATE",
      requestId,
      state: buildPopupState(settings, null, {
        code: "CLOUD_NOT_ALLOWED",
        userMessage: "Cloud analysis is unavailable until a gateway is deployed and enabled.",
      }),
    });
    return;
  }
  settings.mode = mode;
  await saveSettings(settings);
  const tab = await getActiveTab();
  const session = tab?.id ? await readSession(tab.id) : null;
  notifyPopup({ type: "POPUP_STATE", requestId, state: buildPopupState(settings, session) });
}

async function handlePopupDocPreview(
  fileKey: string,
  name: string,
  mimeType: string,
  kind: DocKind,
  requestId: string,
  /** 0-based index of the first page to scan; the user's chosen window. */
  pageOffset = 0,
  /** The document's page count from the count pass, when one ran. */
  totalPages?: number
): Promise<void> {
  // Do not race the lifecycle purge: it clears the very store this file lives
  // in, which is how a just-picked file turned into "The selected file is no
  // longer available." The wait is bounded, because housekeeping must never be
  // able to block the feature indefinitely.
  await Promise.race([startupPurge, new Promise((r) => setTimeout(r, PURGE_WAIT_MS))]);
  try {
    const { docId, pages, pageOffset: offset, totalPages: total, truncated } = await previewDocument(fileKey, name, mimeType, kind, pageOffset, totalPages);
    notifyPopup({ type: "POPUP_DOC_STATE", requestId, docId, name, fileKey, mimeType, kind, pages, pageOffset: offset, totalPages: total, ...(truncated ? { truncated: true } : {}) });
    void recordAudit({
      ts: new Date().toISOString(),
      action: "doc_previewed",
      counts: countByCategory(pages.flatMap((p) => p.findings)),
      pages: pages.length,
      outcome: "ok",
    });
  } catch (error) {
    const userMessage = error instanceof Error ? error.message : "The document could not be processed.";
    notifyPopup({ type: "POPUP_DOC_ERROR", requestId, code: "DOC_ERROR", userMessage });
    void recordAudit({ ts: new Date().toISOString(), action: "doc_previewed", outcome: "error" });
  }
}

/**
 * Count a document's pages, cheaply, so the popup can ask the user which
 * window to scan before doing the slow pass.
 *
 * This is the difference between a long document being silently reduced to its
 * first 20 pages and the user choosing the range. It also fails fast: a
 * corrupt or encrypted document is rejected here in about a second rather than
 * after a minute of rendering.
 */
async function handlePopupDocCount(
  fileKey: string,
  name: string,
  mimeType: string,
  kind: DocKind,
  requestId: string
): Promise<void> {
  await Promise.race([startupPurge, new Promise((r) => setTimeout(r, PURGE_WAIT_MS))]);
  try {
    const totalPages = await countDocument({ fileKey, name, mimeType, kind });
    notifyPopup({ type: "POPUP_DOC_COUNT_RESULT", requestId, totalPages });
  } catch (error) {
    const userMessage = error instanceof Error ? error.message : "The document could not be read.";
    notifyPopup({ type: "POPUP_DOC_ERROR", requestId, code: "DOC_ERROR", userMessage });
    void recordAudit({ ts: new Date().toISOString(), action: "doc_previewed", outcome: "error" });
  }
}

/**
 * Lift an image off the active page and hand it to the Document Studio.
 *
 * A page scan reads text, so an image-only page scans to nothing. Rather than
 * leaving the user with a false all-clear, the popup offers the page's images
 * and this stages the chosen one, then previews it through the ordinary
 * document path - so OCR, review, redaction, download and print all work
 * exactly as they do for an uploaded file, and there is no second redaction
 * surface to keep in step with the first.
 */
async function handlePopupDocCaptureImage(src: string, name: string, requestId: string): Promise<void> {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab || activeTab.id == null || !isScannableTab(activeTab)) {
    notifyPopup({
      type: "POPUP_DOC_ERROR",
      requestId,
      code: "DOC_ERROR",
      userMessage: "No active page to capture. Open the image, then try again.",
    });
    return;
  }

  // The same bounded wait the ordinary document path uses, so a capture can
  // never be deleted by the lifecycle purge that is still settling.
  await Promise.race([startupPurge, new Promise((r) => setTimeout(r, PURGE_WAIT_MS))]);

  let captured: Awaited<ReturnType<typeof captureImage>>;
  try {
    captured = await captureImage(src, activeTab.windowId);
  } catch (error) {
    const userMessage = error instanceof ImageCaptureError ? error.userMessage : "This image could not be read from the page.";
    notifyPopup({ type: "POPUP_DOC_ERROR", requestId, code: "DOC_ERROR", userMessage });
    void recordAudit({ ts: new Date().toISOString(), action: "doc_previewed", outcome: "error" });
    return;
  }

  const fileKey = crypto.randomUUID().replace(/-/g, "");
  const fileName = name && name !== "page-image.png" ? name : captured.name;
  try {
    await stageCapturedImage(captured, fileKey);
  } catch {
    notifyPopup({
      type: "POPUP_DOC_ERROR",
      requestId,
      code: "DOC_ERROR",
      userMessage: "That image could not be prepared on this device.",
    });
    return;
  }

  notifyPopup({
    type: "POPUP_DOC_CAPTURE_READY",
    requestId,
    fileKey,
    name: fileName,
    mimeType: captured.mimeType,
    kind: "image",
    source: captured.source,
    degraded: captured.degraded,
  });
  void recordAudit({
    ts: new Date().toISOString(),
    action: "doc_previewed",
    counts: {},
    pages: 0,
    outcome: "ok",
  });
}

/**
 * Redaction audit records whose delivery outcome the popup still owes us.
 *
 * The audit chain has to describe what happened to the USER'S FILE, not what
 * happened inside the worker. When the worker's own `chrome.downloads` call
 * fails and the popup takes over the download, only the popup knows whether the
 * file arrived - so the record is deferred until the popup reports back, and a
 * missing report is recorded as a failure rather than assumed successful.
 */
interface PendingDeliveryAudit {
  requestId: string;
  docHash: string;
  timer: ReturnType<typeof setTimeout>;
}

const pendingDeliveryAudits = new Map<string, PendingDeliveryAudit>();

/** How long to wait for the popup's delivery report before failing closed. */
const DELIVERY_REPORT_TIMEOUT_MS = 60_000;

async function settleDeliveryAudit(requestId: string, delivered: boolean): Promise<void> {
  const pending = pendingDeliveryAudits.get(requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingDeliveryAudits.delete(requestId);
  await recordAudit({
    ts: new Date().toISOString(),
    action: "doc_redacted",
    docHash: pending.docHash,
    outcome: delivered ? "ok" : "error",
  });
}

function deferDeliveryAudit(requestId: string, docHash: string): void {
  const timer = setTimeout(() => {
    // No report arrived, so delivery is unconfirmed. Fail closed: an unverified
    // delivery must never be written into the chain as a success.
    void settleDeliveryAudit(requestId, false);
  }, DELIVERY_REPORT_TIMEOUT_MS);
  pendingDeliveryAudits.set(requestId, { requestId, docHash, timer });
}

async function handlePopupDocRedact(
  docId: string,
  fileKey: string,
  name: string,
  mimeType: string,
  kind: DocKind,
  boxes: { pageIndex: number; rects: Rect[] }[],
  findingIds: string[],
  requestId: string,
  options?: RedactionOptions
): Promise<void> {
  try {
    const { outputName, outputBytes, outputMimeType, verification, redactedRegions, printRef } = await redactDocument(
      docId,
      fileKey,
      name,
      mimeType,
      kind,
      boxes,
      findingIds,
      options
    );
    const docHash = await sha256Hex(outputBytes);

    // REDACTED: an artifact exists with boxes painted. This is a claim about
    // work performed, and it is reported as its own stage precisely because it
    // is weaker than what follows.
    notifyPopup({ type: "POPUP_DOC_STATUS", requestId, stage: "redacted", paintedRegions: redactedRegions });

    // VERIFIED: the output was re-read and the boxes confirmed covered. If the
    // check failed the user is told so here rather than being handed a file that
    // still shows the value, because a failed verification is the only signal
    // they would otherwise never see.
    notifyPopup({
      type: "POPUP_DOC_STATUS",
      requestId,
      stage: "verified",
      verifiedRegions: verification.darkRegions,
      checkedRegions: verification.checkedRegions,
      method: verification.method,
      ...(verification.verified ? {} : { problem: verification.failures[0] ?? "Output could not be verified." })
    });

    // Primary: service-worker download (fast, saveAs picker). Fallback: send bytes to popup for anchor download
    // so file outputs are always produced even if chrome.downloads is unavailable or the blob URL is revoked.
    //
    // A service worker has no URL.createObjectURL - it is not part of the
    // ServiceWorkerGlobalScope. Calling it threw a TypeError on every single
    // document redaction, so this primary path never once succeeded and every
    // redaction silently degraded to the popup fallback. chrome.downloads
    // accepts a data: URL, which needs no object URL, so the primary path works
    // from the worker again.
    let downloadOk = false;
    try {
      const dataUrl = `data:${outputMimeType};base64,${bytesToBase64(outputBytes)}`;
      await chrome.downloads.download({ url: dataUrl, filename: outputName, saveAs: true });
      downloadOk = true;
    } catch (error) {
      // Falling back to the popup is correct, but swallowing the reason makes a
      // delivery failure undiagnosable in the field: every incident looks
      // identical to a successful redaction. Record it, minus any payload bytes.
      console.warn("[governworld] service-worker download failed, using popup fallback:", error);
      downloadOk = false;
    }

    // The audit outcome must reflect what was actually established, not merely
    // that bytes were produced. A redaction whose boxes were measured as NOT
    // covered was recorded as "ok" and shown as a success, which is precisely the
    // false all-clear this product exists to prevent. The file is still delivered
    // — the user may want to inspect it — but the chain and the message must say
    // it was not verified.
    const verified = verification.verified;

    await clearDocSession(docId);
    // Only ship the bytes over the message port when the service-worker
    // download actually failed. Sending them unconditionally produced the file
    // twice on the happy path and pushed a full document through the extension
    // messaging channel for no reason.
    if (downloadOk) {
      // The browser accepted the file, so delivery is known here. It still says
      // nothing about whether the boxes were covered, which is why `verified`
      // gates the outcome rather than the download.
      void recordAudit({
        ts: new Date().toISOString(),
        action: "doc_redacted",
        docHash,
        outcome: verified ? "ok" : "error",
        ...(verified ? {} : { counts: { unverified: verification.checkedRegions - verification.darkRegions } }),
      });
      notifyPopup({ type: "POPUP_DOC_DONE", requestId, outputName, outputMimeType, printFileKey: printRef?.fileKey });
    } else {
      // The worker cannot know whether the popup's fallback download reached the
      // user, so it must not decide the audit outcome. Wait for the report.
      deferDeliveryAudit(requestId, docHash);
      notifyPopup({
        type: "POPUP_DOC_DONE",
        requestId,
        outputName,
        outputBytesBase64: bytesToBase64(outputBytes),
        outputMimeType,
        printFileKey: printRef?.fileKey,
      });
    }
  } catch (error) {
    const userMessage = error instanceof Error ? error.message : "The document could not be redacted.";
    notifyPopup({ type: "POPUP_DOC_STATUS", requestId, stage: "verified", problem: userMessage });
    notifyPopup({ type: "POPUP_DOC_ERROR", requestId, code: "DOC_ERROR", userMessage });
    void recordAudit({ ts: new Date().toISOString(), action: "doc_redacted", outcome: "error" });
  }
}

async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", view.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function countByCategory(findings: { category: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of findings) counts[f.category] = (counts[f.category] ?? 0) + 1;
  return counts;
}

/**
 * A short token that identifies a media element by its CSS selector, using only
 * the characters a finding id may contain.
 *
 * The id used to be `pdf_${cssSelector}_${findingId}`, and a cssSelector
 * legitimately contains `>`, `[`, `]`, `"`, `#`, `.` and `:`. None are permitted
 * by `FINDING_ID_RE`, and finding validation is all-or-nothing, so one such id
 * made the entire `POPUP_STATE` invalid. The popup dropped it silently, and
 * because the bad id was persisted into the session first, every later
 * `POPUP_GET_STATE` for that tab was rejected too — so the tab stopped receiving
 * state updates at all.
 *
 * A hash is used rather than a stripped selector because stripping characters
 * would collide two distinct elements into one id, and ids must stay unique per
 * finding. Deterministic, so the same element always yields the same id across
 * runs and the mapping remains explainable.
 */
function selectorToken(selector: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < selector.length; i += 1) {
    h ^= selector.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `e${h.toString(36)}`;
}

/**
 * Host of the scanned tab for the audit record, or undefined when Chrome
 * withheld the URL.
 *
 * `tab.url` is readable WITHOUT the broad `tabs` permission: the `activeTab`
 * grant (popup click or `Alt+Shift+S` command) already exposes sensitive tab
 * properties for that tab, so the extension deliberately never requests
 * `tabs` (see PERMISSIONS.md and tests/manifest.test.ts). The grant lapses on
 * navigation or browser restart, which is why this may legitimately yield
 * undefined — that degrades the audit record's `host` field to "not available"
 * and must never abort the scan, so URL parsing is guarded.
 */
function tabHost(tab: chrome.tabs.Tab | undefined): string | undefined {
  if (!tab?.url) return undefined;
  try {
    return new URL(tab.url).host || undefined;
  } catch {
    return undefined;
  }
}

async function handleContentScanResult(message: Extract<WorkerMessage, { type: "SCAN_RESULT" }>, tabId: number): Promise<void> {
  const pending = pendingScans.get(tabId);
  // Bind the result to the scan that produced it. A stale or mismatched result
  // is dropped fail-closed: never persisted, never surfaced as a success.
  if (!pending) {
    return;
  }
  if (message.sessionId !== pending.sessionId) {
    clearTimeout(pending.timer);
    pendingScans.delete(tabId);
    return;
  }
  clearTimeout(pending.timer);
  pendingScans.delete(tabId);
  const settings = await loadSettings();
  const findings = message.findings.filter((f) => meetsThreshold(settings, f.category, f.confidence));
  await writeSession(tabId, {
    sessionId: message.sessionId,
    mode: settings.mode,
    findings,
    stats: message.stats,
    scannedAt: Date.now(),
    scanning: false,
  });
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  void recordAudit({
    ts: new Date().toISOString(),
    action: "page_scan_completed",
    host: tabHost(tab),
    counts: countByCategory(findings),
    outcome: "ok",
  });
  const session = await readSession(tabId);
  notifyPopup({ type: "POPUP_STATE", requestId: pending.requestId, state: buildPopupState(settings, session) });
  updateBadgeForTab(tabId, findings.length);
  void maybeNotifyFindings(findings);

  // ── Async media dispatch (Layers 2–5) ─────────────────────────────────
  // Fire-and-forget: process the visual and PDF queues and merge findings back.
  // A failure here never affects the already-delivered DOM scan result.
  const visualQueue = message.stats.visualQueue ?? [];
  const pdfQueue = message.stats.pdfQueue ?? [];

  if (visualQueue.length === 0 && pdfQueue.length === 0) return;

  void (async () => {
    try {
      const newFindings: Finding[] = [];

      // ── Image / canvas / video-frame OCR ────────────────────────────
      for (const item of visualQueue) {
        try {
          let bytes: ArrayBuffer | null = null;
          let mimeType = "image/png";

          if (item.dataUrl) {
            // Pre-extracted canvas/small-data-URL: decode directly.
            const comma = item.dataUrl.indexOf(",");
            if (comma > 0) {
              const header = item.dataUrl.slice(0, comma);
              const m = /data:(image\/[a-z+]+);base64/i.exec(header);
              if (m) mimeType = m[1].toLowerCase();
              const binary = atob(item.dataUrl.slice(comma + 1));
              const buf = new Uint8Array(binary.length);
              for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
              bytes = buf.buffer;
            }
          } else if (item.resourceUrl) {
            // Attempt original-fetch then fall back to captureVisibleTab crop.
            const { tryFetchOriginal } = await import("./captureImage.js");
            const original = await tryFetchOriginal(item.resourceUrl).catch(() => null);
            if (original) {
              bytes = original.bytes;
              mimeType = original.mimeType;
            } else if (tab?.windowId) {
              const { captureActiveTab } = await import("./captureImage.js");
              const capture = await captureActiveTab(tab.windowId).catch(() => null);
              if (capture) {
                bytes = capture.bytes;
                mimeType = capture.mimeType;
              }
            }
          }

          if (!bytes) continue;

          // Stage as a temporary file and send to the offscreen OCR pipeline.
          const tmpKey = `vis_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
          await storeFile(tmpKey, bytes);
          try {
            const { previewDocument } = await import("./documents.js");
            const { docId, pages } = await previewDocument(tmpKey, item.cssSelector || "page-image.png", mimeType, "image");
            for (const page of pages) {
              for (const f of page.findings) {
                if (meetsThreshold(settings, f.category, f.confidence)) {
                  newFindings.push({
                    ...f,
                    id: `media_${item.sourceId}_${f.id}`,
                    source: "local-rules",
                    selected: false, // visual OCR findings are report-only
                  });
                }
              }
            }
            // Clean up the temporary staged file.
            await deleteFile(tmpKey).catch(() => undefined);
          } catch {
            await deleteFile(tmpKey).catch(() => undefined);
          }
        } catch {
          // Individual item failure is not fatal to the queue.
        }
      }

      // ── PDF extraction ────────────────────────────────────────────────
      for (const item of pdfQueue) {
        try {
          const { tryFetchOriginal } = await import("./captureImage.js");
          // For PDFs we fetch the bytes — pdf.ts handles them.
          let response: Response | null = null;
          try {
            response = await fetch(item.url, { credentials: "omit", redirect: "follow" });
          } catch { /* network error */ }
          if (!response?.ok) continue;
          const buffer = await response.arrayBuffer();
          if (buffer.byteLength === 0) continue;

          const tmpKey = `pdf_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
          await storeFile(tmpKey, buffer);
          try {
            const { previewDocument } = await import("./documents.js");
            const name = item.url.split("/").pop()?.slice(0, 80) || "document.pdf";
            const { docId, pages } = await previewDocument(tmpKey, name, "application/pdf", "pdf");
            for (const page of pages) {
              for (const f of page.findings) {
                if (meetsThreshold(settings, f.category, f.confidence)) {
                  newFindings.push({
                    ...f,
                    id: `pdf_${selectorToken(item.cssSelector)}_${f.id}`,
                    source: "local-rules",
                    selected: false,
                  });
                }
              }
            }
            await deleteFile(tmpKey).catch(() => undefined);
          } catch {
            await deleteFile(tmpKey).catch(() => undefined);
          }
        } catch { /* PDF item failure is not fatal */ }
      }

      if (newFindings.length === 0) return;

      // Merge new findings into the persisted session and push a POPUP_STATE update.
      const currentSession = await readSession(tabId);
      if (!currentSession || currentSession.sessionId !== message.sessionId) return;
      const merged = [...currentSession.findings, ...newFindings];
      await writeSession(tabId, { ...currentSession, findings: merged });
      const updatedSession = await readSession(tabId);
      notifyPopup({
        type: "POPUP_STATE",
        requestId: pending.requestId,
        state: buildPopupState(settings, updatedSession),
      });
    } catch {
      // Async media dispatch failure never affects the already-delivered scan result.
    }
  })();
}


async function handleContentCopyResult(message: Extract<WorkerMessage, { type: "COPY_REDACTED_TEXT_RESULT" }>, _tabId: number): Promise<void> {
  notifyPopup({ type: "POPUP_COPY_RESULT", requestId: message.requestId, text: message.text });
}

async function handleContentError(message: Extract<WorkerMessage, { type: "CONTENT_ERROR" }>, tabId: number): Promise<void> {
  const pending = pendingScans.get(tabId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingScans.delete(tabId);
  }
  const settings = await loadSettings();
  const session = await readSession(tabId);
  notifyPopup({
    type: "POPUP_STATE",
    requestId: pending?.requestId ?? "state",
    state: buildPopupState(settings, session, { code: message.code, userMessage: message.userMessage }),
  });
}

// ---------- Notifications (optional permission) ----------

/** True when the user has granted the optional notifications permission. */
async function notificationsGranted(): Promise<boolean> {
  return (await chrome.permissions.contains({ permissions: ["notifications"] })) as boolean;
}

/**
 * Surface a scan finding as a Chrome notification. Fail-closed: only fires when
 * the user enabled notifications in settings AND granted the optional
 * permission AND at least one finding was detected.
 */
async function maybeNotifyFindings(findings: Finding[]): Promise<void> {
  if (findings.length === 0) return;
  const settings = await loadSettings();
  if (!settings.notificationsEnabled) return;
  if (!(await notificationsGranted())) return;
  const counts = countByCategory(findings);
  const top = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([category, n]) => `${n} ${category.replace(/_/g, " ")}`)
    .join(", ");  await chrome.notifications.create({
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
    title: "GovernWorld — sensitive data found",
    message: `${findings.length} value${findings.length === 1 ? "" : "s"} detected on this page: ${top}.`,
    priority: 0,
  });
}

// ---------- Account (gateway identity binding) ----------

/**
 * The user-pasted `gw_*` API key is a long-lived bearer credential. It is
 * NEVER written to chrome.storage.local (unencrypted, persistent at rest, and
 * readable by any extension context). It is kept only in chrome.storage.session
 * (in-memory, cleared when the browser session ends) under ACCOUNT_KEY_CREDENTIAL.
 * chrome.storage.local stores only non-secret metadata (gateway origin, linked
 * flag, account label).
 *
 * Consequence: on a fresh browser start the account stays "linked" (metadata
 * survives) but the credential is absent until the user re-enters the key.
 * Privileged flows read the key lazily from session on every use and fail
 * closed with a clear re-entry message when it is missing — they never fall
 * back to any stored key, because none is ever persisted.
 */
const ACCOUNT_KEY = "account";
const ACCOUNT_KEY_CREDENTIAL = "accountApiKey";

/** Non-secret account metadata persisted in chrome.storage.local. */
interface StoredAccount {
  gatewayOrigin: string;
  linked: boolean;
  accountLabel?: string;
  /**
   * Organization identity from the last verified bootstrap.
   *
   * Cached non-secret data only. It is re-derived from the server on every
   * connection and is never the basis for an authorization decision on its own —
   * `saveAccount` re-checks the role before writing, and the API is authoritative.
   */
  account?: AccountView;
}

/** Account link status (metadata) + live-credential availability (session). */
interface AccountState {
  /** Metadata present in chrome.storage.local — survives browser restarts. */
  linked: boolean;
  gatewayOrigin: string | null;
  accountLabel?: string;
  /** A live credential is present in chrome.storage.session this browser session. */
  credentialAvailable: boolean;
  /** Server-decided identity, or the disconnected view when there is none. */
  account: AccountView;
}

async function readAccountMetadata(): Promise<StoredAccount | null> {
  const raw = await chrome.storage.local.get(ACCOUNT_KEY);
  const account = raw[ACCOUNT_KEY] as StoredAccount | undefined;
  return account?.linked ? account : null;
}

/** The live API key, read lazily from chrome.storage.session on every use. */
async function readAccountCredential(): Promise<string | null> {
  const raw = await chrome.storage.session.get(ACCOUNT_KEY_CREDENTIAL);
  const key = raw[ACCOUNT_KEY_CREDENTIAL];
  return typeof key === "string" && key.length > 0 ? key : null;
}

async function readAccount(): Promise<AccountState> {
  const [metadata, credential] = await Promise.all([readAccountMetadata(), readAccountCredential()]);
  return {
    linked: metadata !== null,
    gatewayOrigin: metadata?.gatewayOrigin ?? null,
    accountLabel: metadata?.accountLabel,
    credentialAvailable: credential !== null,
    // Re-validated on read. A cached view that fails validation — a shape from an
    // older build, or hand-edited local storage — resolves to the disconnected
    // view, so a tampered cache cannot present an admin identity.
    account: parseAccountView(metadata?.account) ?? NO_ACCOUNT,
  };
}

async function notifyAccountState(requestId: string, error?: { code: string; userMessage: string }): Promise<void> {
  const settings = await loadSettings();
  const account = await readAccount();
  notifyPopup({
    type: "POPUP_ACCOUNT_STATE",
    requestId,
    gatewayOrigin: settings.gatewayOrigin,
    linked: account.linked,
    credentialAvailable: account.credentialAvailable,
    ...(account.accountLabel !== undefined ? { accountLabel: account.accountLabel } : {}),
    account: account.account,
    ...(error ? { error } : {}),
  });
}

/**
 * Disconnect: remove the session credential AND the local metadata. Also purges
 * any legacy API key an earlier version may have persisted at rest.
 */
async function clearAccount(requestId: string): Promise<void> {
  await Promise.all([
    chrome.storage.local.remove([ACCOUNT_KEY, ACCOUNT_KEY_CREDENTIAL]),
    chrome.storage.session.remove(ACCOUNT_KEY_CREDENTIAL),
  ]);
  const settings = await loadSettings();
  await saveSettings({ ...settings, gatewayOrigin: null, accountLabel: undefined });
  await notifyAccountState(requestId);
}

/**
 * Persist + link an account. Metadata (non-secret) → chrome.storage.local; the
 * API key credential → chrome.storage.session only. Validates via bridge to the
 * workspace gateway (health check) so the project↔extension link is proven, not
 * just stored.
 */
function canonicalGatewayOrigin(value: string): string {
  return new URL(value).origin;
}

function isAllowedCheckoutUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "checkout.stripe.com" && !url.port && !url.username && !url.password;
  } catch {
    return false;
  }
}

async function saveAccount(gatewayOrigin: string, apiKey: string, requestId: string): Promise<void> {
  if (!isAllowedGatewayOrigin(gatewayOrigin)) {
    await notifyAccountState(requestId, {
      code: "GATEWAY_ORIGIN_NOT_ALLOWED",
      userMessage: "Use an approved GovernWorld gateway origin.",
    });
    return;
  }
  // Enforced here as well as in the UI.
  //
  // Organization settings are a privileged surface, and a hidden form is not a
  // control: the message that drives this save is still reachable from the popup,
  // the sidepanel and any other extension context. The API rejects a non-admin
  // write regardless, so this is defence in depth for the local write, which the
  // API never sees.
  const current = await readAccount();
  if (current.account.connected && !current.account.canManage) {
    await notifyAccountState(requestId, {
      code: "ORG_SETTINGS_FORBIDDEN",
      userMessage:
        "You don't have access to this page, please reach out to your organization admins for more information. This is managed by your organization.",
    });
    return;
  }
  const origin = canonicalGatewayOrigin(gatewayOrigin);
  try {
    const probe = await fetchWithTimeout(`${origin}/health`, { method: "GET", headers: { Accept: "application/json" } });
    if (!probe.ok) throw new Error(`Gateway health check failed (${probe.status})`);
  } catch (e) {
    await notifyAccountState(requestId, { code: "GATEWAY_UNREACHABLE", userMessage: e instanceof Error ? e.message : "Gateway is not reachable at that origin." });
    return;
  }
  try {
    await fetchPlans(origin, apiKey);
  } catch (e) {
    await notifyAccountState(requestId, {
      code: "API_KEY_REJECTED",
      userMessage: e instanceof Error ? e.message : "The gateway did not accept this API key.",
    });
    return;
  }
  const settings = await loadSettings();
  await saveSettings({ ...settings, gatewayOrigin: origin, accountLabel: undefined });
  // Credential first so local metadata can never claim "linked" before the
  // session credential exists.
  await chrome.storage.session.set({ [ACCOUNT_KEY_CREDENTIAL]: apiKey });
  await chrome.storage.local.set({ [ACCOUNT_KEY]: { gatewayOrigin: origin, linked: true } });
  await notifyAccountState(requestId);
  void recordAudit({ ts: new Date().toISOString(), action: "account_linked", gatewayOrigin: origin, outcome: "ok" });
}

/** Fetch the authenticated billing catalog from the linked gateway (metadata only). */
async function fetchPlans(gatewayOrigin: string, apiKey: string): Promise<{ id: string; name: string; priceId: string }[]> {
  const response = await fetchWithTimeout(`${gatewayOrigin}/v1/billing/plans`, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Plans request failed (${response.status})`);
  }
  const body = (await response.json()) as { plans?: unknown };
  if (!body || !Array.isArray(body.plans) || !body.plans.every(
    (plan) =>
      typeof plan === "object" &&
      plan !== null &&
      typeof (plan as { id?: unknown }).id === "string" &&
      typeof (plan as { name?: unknown }).name === "string" &&
      typeof (plan as { priceId?: unknown }).priceId === "string"
  )) {
    throw new Error("Gateway returned an invalid billing catalog.");
  }
  return body.plans as { id: string; name: string; priceId: string }[];
}

/**
 * Start a purchase for the given plan on the linked gateway. Resolves the
 * plan's price via the catalog, creates a Checkout Session, and surfaces the
 * checkout URL for the panel to open. Fail-closed: no account metadata, no
 * gateway origin, or no matching plan → error, never a fallback. The API key is
 * sourced ONLY from chrome.storage.session; when the account is linked but the
 * key is absent (browser restart), the purchase is blocked with a re-entry
 * message and no authenticated request is ever sent.
 */
async function purchasePlan(planId: string, requestId: string): Promise<void> {
  const [settings, account] = await Promise.all([loadSettings(), readAccount()]);
  const origin = settings.gatewayOrigin;
  if (!account.linked || !origin) {
    notifyPopup({
      type: "POPUP_ACCOUNT_STATE",
      requestId,
      gatewayOrigin: origin ?? null,
      linked: account.linked,
      credentialAvailable: account.credentialAvailable,
      error: { code: "ACCOUNT_NOT_LINKED", userMessage: "Link your GovernWorld account before purchasing." },
    });
    return;
  }
  const apiKey = await readAccountCredential();
  if (!apiKey) {
    notifyPopup({
      type: "POPUP_ACCOUNT_STATE",
      requestId,
      gatewayOrigin: origin,
      linked: true,
      credentialAvailable: false,
      error: {
        code: "ACCOUNT_CREDENTIAL_REQUIRED",
        userMessage: "Re-enter your key to continue purchases in this browser session.",
      },
    });
    return;
  }

  try {
    const plans = await fetchPlans(origin, apiKey);
    const plan = plans.find((p) => p.id === planId);
    if (!plan) {
      throw new Error(`Plan '${planId}' is not available on this gateway.`);
    }
    const successUrl = chrome.runtime.getURL("sidepanel.html");
    const cancelUrl = chrome.runtime.getURL("sidepanel.html");
    const response = await fetchWithTimeout(`${origin}/v1/billing/checkout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ priceId: plan.priceId, successUrl, cancelUrl }),
    });
    if (!response.ok) {
      throw new Error(`Checkout failed (${response.status})`);
    }
    const body = (await response.json()) as { url?: string };
    if (!body.url || !isAllowedCheckoutUrl(body.url)) {
      throw new Error("Gateway returned an invalid checkout URL.");
    }
    await chrome.tabs.create({ url: body.url });
    notifyPopup({ type: "POPUP_ACCOUNT_PURCHASE_URL", requestId, url: body.url });
  } catch (error) {
    notifyPopup({
      type: "POPUP_ACCOUNT_STATE",
      requestId,
      gatewayOrigin: origin,
      linked: account.linked,
      credentialAvailable: true,
      error: { code: "PURCHASE_FAILED", userMessage: error instanceof Error ? error.message : "Could not start checkout." },
    });
  }
}

// Best-effort purge of any API key an earlier version persisted at rest. The
// gateway key is session-only going forward; if a legacy copy still exists in
// chrome.storage.local it is removed as soon as the service worker starts.
void chrome.storage.local.remove([ACCOUNT_KEY_CREDENTIAL]);

// Staged document bytes are purged when the BROWSER starts, not when this
// service worker wakes.
//
// MV3 terminates an idle service worker after ~30s and restarts it on the next
// event. Running the purge at module scope therefore wiped a user's staged
// document every time the worker cycled, so picking a file, spending longer
// than the idle timeout reviewing findings, and then clicking "Redact selected"
// failed with "The selected file is no longer available." The purge is scoped
// to real lifecycle events, where it belongs.
let startupCleanupError: unknown;

/**
 * Resolves when the lifecycle purge has finished.
 *
 * The purge used to run fire-and-forget at browser startup while the popup
 * could already be staging a document, so it could delete a file the user had
 * just picked. The worker then reported "The selected file is no longer
 * available. Please re-open it." for a file the user could see in the dialog.
 * Document work waits on this instead of racing it.
 */
let startupPurge: Promise<void> = Promise.resolve();

/** How long a document request will wait for that housekeeping before proceeding. */
const PURGE_WAIT_MS = 5_000;

/**
 * Clear the latched failure once the purge has actually succeeded.
 *
 * The flag used to be set on the first failure and never reset, so a single
 * transient IndexedDB hiccup during the browser-startup purge rejected *every*
 * later message with "Local document storage cleanup failed." for the rest of
 * the worker's life - the popup could not open a document, run a redaction, or
 * change a setting, and it showed the user nothing at all. The purge is
 * best-effort housekeeping, so a later success clears the condition.
 */
/**
 * Turn on a detection category the user just opted into by writing a rule for it.
 *
 * `detect()` only runs custom patterns whose category is enabled, and `custom` is
 * deliberately absent from DEFAULT_SETTINGS: it is not a detector, it is the
 * bucket authored rules land in. So a rule saved from the wizard — whose default
 * category IS `custom` — was stored, listed in the UI, and then silently never
 * executed until the user went to Detection settings and ticked a box that is
 * easy to miss and not mentioned anywhere the wizard is. The feature advertised
 * by the wizard did nothing by default.
 *
 * Saving a rule IS the user saying "detect this", so the category is enabled
 * here. Only ever adds; an enterprise-mandated category set is not overridden,
 * and the setting stays user-editable afterwards.
 */
async function enableCategoryForPattern(category: FindingCategory): Promise<void> {
  const settings = await loadSettings();
  if (settings.enabledCategories.includes(category)) return;
  await saveSettings({
    ...settings,
    enabledCategories: [...settings.enabledCategories, category],
  });
}

/**
 * Best-effort housekeeping: drop staged documents at a lifecycle boundary.
 *
 * It skips outright when a document is staged. The purge empties the entire
 * store, so running it while the popup has a file in flight destroyed that file
 * and the preview reported "The selected file is no longer available." for a
 * document the user could see selected. Waiting for the purge before reading the
 * document (which is what `handlePopupDocPreview` does) could not prevent that —
 * it only guaranteed the purge finished first.
 *
 * Skipping is safe: staged bytes are per-session state in IndexedDB, and the next
 * explicit document action overwrites them. Housekeeping exists to avoid unbounded
 * growth across restarts, not to guarantee an empty store.
 */
function purgeStagedFilesOnLifecycle(reason: string): void {
  // `startupPurge` must be assigned synchronously: document requests await it,
  // and awaiting a promise that is still undefined would let them run before the
  // skip decision below has been made.
  startupPurge = (async () => {
    try {
      if (await hasStagedDocument()) {
        console.warn(`[governworld] staged-file purge skipped on ${reason}: a document is staged.`);
        return;
      }
      await clearAllFiles();
      startupCleanupError = undefined;
    } catch (error) {
      startupCleanupError = error;
      console.warn(`[governworld] staged-file purge failed on ${reason}:`, error);
    }
  })();
}

chrome.runtime.onStartup?.addListener(() => {
  purgeStagedFilesOnLifecycle("browser startup");
});

chrome.runtime.onInstalled?.addListener(() => {
  purgeStagedFilesOnLifecycle("extension install/update");
});

// OAuth callback capture: when the provider redirects to chromiumapp.org,
// extract the authorization code and state, then close the tab.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading") clearBadgeForTab(tabId);
  if (!tab.url) return;
  if (!tab.url.includes(".chromiumapp.org/")) return;
  const url = new URL(tab.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (code && state) {
    void chrome.tabs.remove(tabId).catch(() => undefined);
    void handleOAuthCallback(code, state, crypto.randomUUID());
  }
});

// Keyboard shortcuts (manifest "commands"). A command is a deliberate user
// action, so it may inject the content script just like a popup button press.
// Results land in storage.session; the popup shows them on next open.
chrome.commands.onCommand.addListener((command) => {
  void (async () => {
    const requestId = crypto.randomUUID();
    if (command === "scan-page") {
      await handlePopupScan("local", requestId);
      return;
    }
    if (command === "toggle-masks") {
      const tab = await getActiveTab();
      const session = tab?.id ? await readSession(tab.id) : null;
      // The shortcut has no popup to report into: notifyPopup would post a
      // message nobody is listening for and the keypress would look inert. The
      // refusal has to reach the badge, because "Alt+Shift+M did nothing" and
      // "there is no scan on this tab" are otherwise the same event.
      if (!tab?.id || !session) {
        if (tab?.id) {
          await reportActionFailure(tab.id, "No scan on this tab yet. Run a scan first.");
        } else {
          console.warn("[governworld] toggle-masks: no scannable tab to act on");
        }
        return;
      }
      const anySelected = session.findings.some((f) => f.selected);
      const ran = anySelected
        ? await handlePopupRemoveMasks(requestId)
        : await handlePopupApplyMasks(session.findings.map((f) => f.id), requestId);
      if (ran && tab.id) flashTabStatus(tab.id, "ok");
      else if (tab.id) await reportActionFailure(tab.id, "This scan session is no longer active. Run a scan again.");
      return;
    }
    if (command === "open-side-panel") {
      const tab = await getActiveTab();
      const window = tab?.windowId != null ? tab.windowId : (await chrome.windows.getLastFocused()).id;
      if (window != null) {
        if (chrome.sidePanel && typeof chrome.sidePanel.open === "function") {
          await chrome.sidePanel.open({ windowId: window });
        } else if (chrome.windows && typeof chrome.windows.create === "function") {
          await chrome.windows.create({
            url: chrome.runtime.getURL("sidepanel.html"),
            type: "popup",
            width: 440,
            height: 680,
          });
        }
      }
    }
  })().catch(() => undefined);
});

async function syncContextMenus(): Promise<void> {
  if (!chrome.contextMenus) return;
  const settings = await loadSettings();
  await new Promise<void>((resolve) => {
    chrome.contextMenus.removeAll(() => {
      if (settings.contextMenusEnabled) {
        chrome.contextMenus.create({ id: "scan_page", title: "Scan page for sensitive data", contexts: ["page", "selection"] });
        chrome.contextMenus.create({ id: "redact_selection", title: "Redact selection to clipboard", contexts: ["selection"] });
        // Selection context ONLY. It was also registered for "page", where the
        // content script cannot possibly succeed — it reads
        // window.getSelection() and refuses a collapsed range — so the entry
        // appeared on every ordinary right-click and did nothing, silently. The
        // title said "element"; this handler masks a text selection and nothing
        // else, so the claim was false as well as the context.
        chrome.contextMenus.create({ id: "mask_selection", title: "Mask selected text", contexts: ["selection"] });
      }
      resolve();
    });
  });
}

if (chrome.runtime.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    void syncContextMenus();
  });
}

if (chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) {
      void syncContextMenus();
      void syncSiteProtection();
    } else if (area === "managed") {
      void syncSiteProtection();
    }
  });
}

// Site access for always-on is a runtime grant the user can give or revoke at
// any time (chrome://extensions or the permission prompt). Re-reconcile on
// both transitions so revoking access genuinely stops coverage and granting
// it arms a pending always-on request without another settings round-trip.
if (chrome.permissions?.onAdded) {
  chrome.permissions.onAdded.addListener(() => {
    void syncSiteProtection();
  });
}
if (chrome.permissions?.onRemoved) {
  chrome.permissions.onRemoved.addListener(() => {
    void syncSiteProtection();
  });
}

// Reconcile on every worker start: registrations persist across sessions, so
// a stale registration from before the user opted out must be removed, and a
// pending always-on request must be armed, even if no settings event fires.
void syncSiteProtection();

// A status marker written by a worker that was then reclaimed would otherwise
// stay on the toolbar indefinitely: its setTimeout died with the worker.
void reconcileTabStatuses();

if (chrome.contextMenus?.onClicked) {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    void (async () => {
      const tabId = tab?.id ?? (await getActiveTab())?.id;
      if (!tabId) return;

      if (info.menuItemId === "scan_page") {
        await handlePopupScan("local", crypto.randomUUID());
        return;
      }

      const settings = await loadSettings();
      const effectiveScanSettings = await buildEffectiveScanSettingsMessage(settings);
      const host = tabHost(await chrome.tabs.get(tabId).catch(() => undefined));

      if (info.menuItemId === "redact_selection") {
        const msg: WorkerMessage = {
          type: "CONTEXT_REDACT_SELECTION",
          requestId: crypto.randomUUID(),
          selectionText: info.selectionText,
          settings: effectiveScanSettings,
        };
        // The reply used to be dropped on the floor. "No text selected" and a
        // genuine redaction were indistinguishable to the user, so the entry
        // could fail forever without anyone noticing. It is also a REDACTION:
        // it writes redacted content to the clipboard, which is exactly the
        // operation the audit invariant exists to record.
        const response = await sendToTab(tabId, msg);
        const error = actionError(response);
        const counts = actionCounts(response);
        void recordAudit({
          ts: new Date().toISOString(),
          action: "selection_redacted",
          ...(host ? { host } : {}),
          ...(counts ? { counts } : {}),
          outcome: error ? "error" : "ok",
        });
        if (error) {
          await reportActionFailure(tabId, `Redact selection: ${error}`);
        } else {
          flashTabStatus(tabId, "ok");
          console.info(`[governworld] Redacted selection copied to the clipboard (${Object.values(counts ?? {}).reduce((a, b) => a + b, 0)} values masked)`);
        }
      } else if (info.menuItemId === "mask_selection") {
        const msg: WorkerMessage = {
          type: "CONTEXT_MASK_SELECTION",
          requestId: crypto.randomUUID(),
          selectionText: info.selectionText,
          settings: effectiveScanSettings,
        };
        const response = await sendToTab(tabId, msg);
        const error = actionError(response);
        void recordAudit({
          ts: new Date().toISOString(),
          action: "selection_masked",
          ...(host ? { host } : {}),
          outcome: error ? "error" : "ok",
        });
        if (error) {
          await reportActionFailure(tabId, `Mask selection: ${error}`);
        } else {
          flashTabStatus(tabId, "ok");
        }
      }
    })().catch((error) => {
      console.warn("[governworld] Context menu action failed:", error);
    });
  });
}

async function handleApiGetStatus(requestId: string): Promise<void> {
  const meta = await getAuthMetadata();
  const apiUrl = await getApiUrl();
  if (!meta || !meta.connected) {
    notifyPopup({
      type: "POPUP_API_STATUS_STATE",
      requestId,
      connectionState: "LOCAL_ONLY",
      apiUrl,
      capabilities: [],
    });
    return;
  }

  const client = new GovernWorldApiClient(apiUrl);
  const health = await checkHealth(client);
  if (!health.reachable) {
    notifyPopup({
      type: "POPUP_API_STATUS_STATE",
      requestId,
      connectionState: "OFFLINE",
      tenantId: meta.tenant_id,
      tenantName: meta.tenant_name,
      apiUrl,
      capabilities: await getCachedCapabilities(),
      error: "GovernWorld API unreachable. Local protection continues active.",
    });
    return;
  }

  if (!health.compatible) {
    notifyPopup({
      type: "POPUP_API_STATUS_STATE",
      requestId,
      connectionState: "INCOMPATIBLE_VERSION",
      tenantId: meta.tenant_id,
      tenantName: meta.tenant_name,
      apiUrl,
      capabilities: [],
      error: "Extension update required for cloud connectivity. Local protection remains active.",
    });
    return;
  }

  if (health.killSwitch === "DISABLED") {
    notifyPopup({
      type: "POPUP_API_STATUS_STATE",
      requestId,
      connectionState: "DISABLED",
      apiUrl,
      capabilities: [],
      error: "Cloud connectivity is disabled by server policy. Local protection remains active.",
    });
    return;
  }

  const tokens = await getStoredTokens();
  if (!tokens?.access_token) {
    notifyPopup({
      type: "POPUP_API_STATUS_STATE",
      requestId,
      connectionState: "AUTHENTICATION_REQUIRED",
      tenantId: meta.tenant_id,
      tenantName: meta.tenant_name,
      apiUrl,
      capabilities: await getCachedCapabilities(),
    });
    return;
  }

  notifyPopup({
    type: "POPUP_API_STATUS_STATE",
    requestId,
    connectionState: "CONNECTED",
    tenantId: meta.tenant_id,
    tenantName: meta.tenant_name,
    apiUrl,
    capabilities: await getCachedCapabilities(),
  });
}

async function handleApiConnect(apiUrl: string | undefined, token: string | undefined, requestId: string): Promise<void> {
  if (apiUrl) {
    const check = await setApiUrl(apiUrl);
    if (!check.success) {
      notifyPopup({
        type: "POPUP_API_STATUS_STATE",
        requestId,
        connectionState: "LOCAL_ONLY",
        apiUrl: await getApiUrl(),
        capabilities: [],
        error: check.error,
      });
      return;
    }
  }

  const currentApiUrl = await getApiUrl();
  const client = new GovernWorldApiClient(currentApiUrl);

  const health = await checkHealth(client);
  if (!health.reachable) {
    notifyPopup({
      type: "POPUP_API_STATUS_STATE",
      requestId,
      connectionState: "OFFLINE",
      apiUrl: currentApiUrl,
      capabilities: [],
      error: "Cannot reach GovernWorld API. Local protection continues active.",
    });
    return;
  }

  if (!health.compatible) {
    notifyPopup({
      type: "POPUP_API_STATUS_STATE",
      requestId,
      connectionState: "INCOMPATIBLE_VERSION",
      apiUrl: currentApiUrl,
      capabilities: [],
      error: "Extension version incompatible with API. Local protection continues active.",
    });
    return;
  }

  if (health.killSwitch === "DISABLED") {
    notifyPopup({
      type: "POPUP_API_STATUS_STATE",
      requestId,
      connectionState: "DISABLED",
      apiUrl: currentApiUrl,
      capabilities: [],
      error: "Cloud connectivity disabled by server policy.",
    });
    return;
  }

  if (!token) {
    notifyPopup({
      type: "POPUP_API_STATUS_STATE",
      requestId,
      connectionState: "AUTHENTICATION_REQUIRED",
      apiUrl: currentApiUrl,
      capabilities: [],
    });
    return;
  }

  const bootstrap = await performBootstrap(client, token);
  if (!bootstrap.success || !bootstrap.tenant) {
    notifyPopup({
      type: "POPUP_API_STATUS_STATE",
      requestId,
      connectionState: bootstrap.connectionState,
      apiUrl: currentApiUrl,
      capabilities: [],
      error: bootstrap.error,
    });
    return;
  }

  const tokens = {
    access_token: token,
    token_type: "Bearer",
    expires_in: 3600,
    expires_at: Date.now() + 3600 * 1000,
  };

  await saveAuthSession(tokens, {
    connected: true,
    tenant_id: bootstrap.tenant.tenant_id,
    tenant_name: bootstrap.tenant.tenant_name,
    connected_at: new Date().toISOString(),
  });

  notifyPopup({
    type: "POPUP_API_STATUS_STATE",
    requestId,
    connectionState: "CONNECTED",
    tenantId: bootstrap.tenant.tenant_id,
    tenantName: bootstrap.tenant.tenant_name,
    apiUrl: currentApiUrl,
    capabilities: bootstrap.capabilities ?? [],
  });
}

async function handleApiDisconnect(requestId: string): Promise<void> {
  await clearAuthSession();
  const apiUrl = await getApiUrl();
  notifyPopup({
    type: "POPUP_API_STATUS_STATE",
    requestId,
    connectionState: "LOCAL_ONLY",
    apiUrl,
    capabilities: [],
  });
}

async function handleOAuthConnect(requestId: string): Promise<void> {
  try {
    const state = await generateOAuthState();
    const authorizeUrl = await buildAuthorizeUrl(state);
    await chrome.tabs.create({ url: authorizeUrl });
    notifyPopup({
      type: "POPUP_OAUTH_STATUS",
      requestId,
      connected: false,
      message: "OAuth authorization page opened. Complete sign-in to connect.",
    });
  } catch (error) {
    notifyPopup({
      type: "POPUP_OAUTH_STATUS",
      requestId,
      connected: false,
      message: error instanceof Error ? error.message : "Failed to start OAuth flow.",
    });
  }
}

async function handleOAuthCallback(code: string, state: string, requestId: string): Promise<void> {
  const valid = await verifyOAuthState(state);
  if (!valid) {
    notifyPopup({
      type: "POPUP_OAUTH_STATUS",
      requestId,
      connected: false,
      message: "OAuth state mismatch. Connection denied.",
    });
    return;
  }
  const client = new GovernWorldApiClient(await getApiUrl());
  const result = await exchangeCodeForTokens(client, code);
  if (!result.ok) {
    notifyPopup({
      type: "POPUP_OAUTH_STATUS",
      requestId,
      connected: false,
      message: result.error,
    });
    return;
  }
  const bootstrap = await performBootstrap(client, result.tokens.access_token);
  if (!bootstrap.success || !bootstrap.tenant) {
    notifyPopup({
      type: "POPUP_OAUTH_STATUS",
      requestId,
      connected: false,
      message: bootstrap.error ?? "Bootstrap failed after OAuth.",
    });
    return;
  }
  // The identity read once and used for both the session metadata and the cached
  // account view, so the two can never disagree.
  const userEmail = tokensUserEmail(result.tokens);
  await saveAuthSession(result.tokens, {
    connected: true,
    ...(userEmail !== null ? { user_email: userEmail } : {}),
    tenant_id: bootstrap.tenant.tenant_id,
    tenant_name: bootstrap.tenant.tenant_name,
    connected_at: new Date().toISOString(),
  });
  // Cache the identity so the popup can render account, organization, role and
  // subscription on open without a second round trip. Re-derived here from the
  // verified bootstrap, and re-validated on every read.
  const view = buildAccountView({
    connected: true,
    userEmail,
    tenant: bootstrap.tenant,
    entitlements: bootstrap.entitlements,
    capabilities: bootstrap.capabilities,
  });
  const metadata = await readAccountMetadata();
  if (metadata) {
    await chrome.storage.local.set({ [ACCOUNT_KEY]: { ...metadata, account: view } });
  }
  notifyPopup({
    type: "POPUP_OAUTH_STATUS",
    requestId,
    connected: true,
    tenantId: bootstrap.tenant.tenant_id,
    tenantName: bootstrap.tenant.tenant_name,
    apiUrl: await getApiUrl(),
    capabilities: bootstrap.capabilities ?? [],
  });
  await notifyAccountState(requestId);
}

/**
 * Non-secret user identity carried alongside the access token.
 *
 * Read from the JWT `email` claim WITHOUT verifying the signature. That is safe
 * here and only here: the value came over TLS from the gateway we just exchanged a
 * code with, it is displayed, and `canManage` is derived from `tenant.roles` in the
 * bootstrap body rather than from any claim. A forged claim could therefore
 * mislabel whose account is on screen, never grant access.
 */
function tokensUserEmail(tokens: AuthTokens): string | null {
  const parts = tokens.access_token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const decoded = atob(payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), "="));
    const claims: unknown = JSON.parse(decoded);
    if (typeof claims !== "object" || claims === null) return null;
    const email = (claims as Record<string, unknown>).email;
    return typeof email === "string" && email.length > 0 && email.length <= 320 ? email : null;
  } catch {
    return null;
  }
}

async function handleApiSyncPolicy(requestId: string): Promise<void> {
  const tokens = await getStoredTokens();
  const client = new GovernWorldApiClient(await getApiUrl());
  const syncResult = await syncPolicy(client, tokens?.access_token);
  if (!syncResult.ok) {
    notifyPopup({
      type: "POPUP_API_POLICY_STATE",
      requestId,
      success: false,
      error: syncResult.error,
    });
    return;
  }

  notifyPopup({
    type: "POPUP_API_POLICY_STATE",
    requestId,
    success: true,
    policyId: syncResult.policy.policy_id,
    policyVersion: syncResult.policy.policy_version,
    rulesCount: syncResult.policy.rules.length,
  });
}

async function handleApiSubmitLogic(patternId: string, requestId: string): Promise<void> {
  const patterns = await loadCustomPatterns();
  const target = patterns.find((p) => p.id === patternId);
  if (!target) {
    notifyPopup({
      type: "POPUP_API_SUBMIT_RESULT",
      requestId,
      success: false,
      error: "Pattern not found.",
    });
    return;
  }

  const tokens = await getStoredTokens();
  const client = new GovernWorldApiClient(await getApiUrl());
  const res = await submitLogic(
    client,
    {
      rule_name: target.name,
      category: target.category,
      pattern: target.pattern,
      cues: target.contextCues ?? [],
      description: target.name,
    },
    tokens?.access_token
  );

  if (!res.ok) {
    notifyPopup({
      type: "POPUP_API_SUBMIT_RESULT",
      requestId,
      success: false,
      error: res.error,
    });
    return;
  }

  notifyPopup({
    type: "POPUP_API_SUBMIT_RESULT",
    requestId,
    success: true,
    submissionId: res.response.submission_id,
  });
}

const CONTENT_MESSAGE_TYPES = new Set<ExtensionMessage["type"]>([
  "SCAN_RESULT",
  "COPY_REDACTED_TEXT_RESULT",
  "CONTENT_ERROR",
]);

function isTrustedExtensionPageSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && Boolean(sender.url?.startsWith(chrome.runtime.getURL("")));
}

function isTrustedContentScriptSender(sender: chrome.runtime.MessageSender): sender is chrome.runtime.MessageSender & { tab: chrome.tabs.Tab } {
  return (
    sender.id === chrome.runtime.id &&
    sender.tab?.id !== undefined &&
    typeof sender.url === "string" &&
    /^https?:\/\//.test(sender.url)
  );
}

function isAuthorizedMessageSender(type: ExtensionMessage["type"], sender: chrome.runtime.MessageSender): boolean {
  return CONTENT_MESSAGE_TYPES.has(type)
    ? isTrustedContentScriptSender(sender)
    : isTrustedExtensionPageSender(sender);
}

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  const validation = validateMessage(raw);
  if (!validation.ok) {
    sendResponse({ ok: false, error: validation.error });
    return;
  }
  const msg = validation.message;
  if (!isAuthorizedMessageSender(msg.type, sender)) {
    sendResponse({ ok: false, error: "Unauthorized sender" });
    return;
  }

  const run = async () => {
    // Staged-file bytes live for the browser session, so a purge failure here
    // is recorded rather than awaited. Fail closed so a stale document from a
    // previous session can never be redacted against a fresh one.
    if (startupCleanupError) {
      sendResponse({ ok: false, error: "Local document storage cleanup failed." });
      return;
    }
    // Route by message type, not by sender shape: a popup opened as a tab sets
    // sender.tab, and must still reach the popup handlers. Only content-script
    // results genuinely originate from a tab.
    switch (msg.type) {
      case "SCAN_RESULT":
      case "COPY_REDACTED_TEXT_RESULT":
      case "CONTENT_ERROR":
        if (!sender.tab?.id) return;
        if (msg.type === "SCAN_RESULT") await handleContentScanResult(msg, sender.tab.id);
        else if (msg.type === "COPY_REDACTED_TEXT_RESULT") await handleContentCopyResult(msg, sender.tab.id);
        else await handleContentError(msg, sender.tab.id);
        return;
      default:
        break;
    }
    switch (msg.type) {
      case "POPUP_SCAN":
        await handlePopupScan(msg.mode, msg.requestId);
        break;
      case "POPUP_APPLY_MASKS":
        await handlePopupApplyMasks(msg.findingIds, msg.requestId);
        break;
      case "POPUP_REMOVE_MASKS":
        await handlePopupRemoveMasks(msg.requestId);
        break;
      case "POPUP_COPY_REDACTED":
        await handlePopupCopyRedacted(msg.findingIds, msg.requestId);
        break;
      case "POPUP_CLEAR_DATA":
        await handlePopupClearData(msg.requestId);
        break;
      case "POPUP_GET_STATE": {
        notifyPopup({ type: "POPUP_STATE", requestId: msg.requestId, state: await stateForActiveTab() });
        const docSession = await restoreLastSession();
        if (docSession) {
          // The window rides along so a restored session still says "pages
          // 21-40 of 45" instead of claiming 20 pages is the whole document.
          notifyPopup({ type: "POPUP_DOC_STATE", requestId: msg.requestId, docId: docSession.docId, name: docSession.name, fileKey: docSession.fileKey, mimeType: docSession.mimeType, kind: docSession.kind, pages: docSession.pages, pageOffset: docSession.pageOffset, totalPages: docSession.totalPages, ...(docSession.truncated ? { truncated: true } : {}) });
        }
        void notifyAccountState(msg.requestId);
        void handleApiGetStatus(msg.requestId);
        notifyPopup({ type: "POPUP_NOTIFICATIONS_STATE", requestId: msg.requestId, granted: await notificationsGranted() });
        notifyPopup({ type: "POPUP_CUSTOM_PATTERNS_STATE", requestId: msg.requestId, patterns: await loadCustomPatterns() });
        notifyPopup({ type: "POPUP_COMMUNITY_ACCOUNT_DETAILS_STATE", requestId: msg.requestId, account: await loadCommunityAccount() });
        break;
      }
      case "POPUP_SET_MODE":
        await handlePopupSetMode(msg.mode, msg.requestId);
        break;
      case "POPUP_DOC_PREVIEW":
        await handlePopupDocPreview(msg.fileKey, msg.name, msg.mimeType, msg.kind, msg.requestId, msg.pageOffset ?? 0, msg.totalPages);
        break;
      case "POPUP_DOC_COUNT":
        await handlePopupDocCount(msg.fileKey, msg.name, msg.mimeType, msg.kind, msg.requestId);
        break;
      case "POPUP_DOC_REDACT":
        await handlePopupDocRedact(msg.docId, msg.fileKey, msg.name, msg.mimeType, msg.kind, msg.boxes, msg.findingIds, msg.requestId, msg.options);
        break;
      case "POPUP_DOC_CLEAR":
        await clearDocSession(msg.docId);
        void recordAudit({ ts: new Date().toISOString(), action: "doc_cleared", outcome: "ok" });
        break;
      case "POPUP_DOC_CAPTURE_IMAGE":
        await handlePopupDocCaptureImage(msg.src, msg.name, msg.requestId);
        break;
      case "POPUP_DOC_DELIVERY_REPORT":
        // Closes the audit loop for a fallback delivery the worker handed off.
        await settleDeliveryAudit(msg.requestId, msg.delivered);
        break;
      case "POPUP_DOC_PRINT": {
        // Opens the read-only print/PDF view in a normal tab. It is an extension
        // page, so it is same-origin with the store holding the redacted pages.
        try {
          await chrome.tabs.create({
            url: chrome.runtime.getURL(`redact.html?key=${encodeURIComponent(msg.fileKey)}`),
          });
        } catch (error) {
          notifyPopup({
            type: "POPUP_DOC_ERROR",
            requestId: msg.requestId,
            code: "DOC_ERROR",
            userMessage: error instanceof Error ? error.message : "The print view could not be opened.",
          });
        }
        break;
      }
      case "POPUP_EXPORT_AUDIT": {
        try {
          const exported = await exportSignedAuditLog();
          notifyPopup({ type: "POPUP_AUDIT_EXPORT", requestId: msg.requestId, ...exported });
        } catch {
          notifyPopup({
            type: "POPUP_STATE",
            requestId: msg.requestId,
            state: buildPopupState(await loadSettings(), null, {
              code: "AUDIT_EXPORT_FAILED",
              userMessage: "Could not export the audit log.",
            }),
          });
        }
        break;
      }
      case "POPUP_UNDO_MASKS":
        await handlePopupUndoMasks(msg.requestId);
        break;
      case "POPUP_SET_NOTIFICATIONS": {
        if (msg.enabled) {
          const granted = (await chrome.permissions.request({ permissions: ["notifications"] })) as boolean;
          const settings = await loadSettings();
          await saveSettings({ ...settings, notificationsEnabled: granted });
          notifyPopup({ type: "POPUP_NOTIFICATIONS_STATE", requestId: msg.requestId, granted });
        } else {
          await chrome.permissions.remove({ permissions: ["notifications"] });
          const settings = await loadSettings();
          await saveSettings({ ...settings, notificationsEnabled: false });
          notifyPopup({ type: "POPUP_NOTIFICATIONS_STATE", requestId: msg.requestId, granted: false });
        }
        break;
      }
      case "POPUP_ACCOUNT_SAVE":
        await saveAccount(msg.gatewayOrigin, msg.apiKey, msg.requestId);
        break;
      case "POPUP_ACCOUNT_CLEAR":
        await clearAccount(msg.requestId);
        break;
      case "POPUP_ACCOUNT_PURCHASE":
        await purchasePlan(msg.planId, msg.requestId);
        break;
      case "POPUP_WIZARD_ANALYZE": {
        const analysis = analyzeExamples(msg.positiveExamples, "custom", msg.negativeExamples);
        notifyPopup({ type: "POPUP_WIZARD_ANALYSIS_RESULT", requestId: msg.requestId, proposals: [analysis] });
        break;
      }
      case "POPUP_WIZARD_TEST": {
        const testResult = testPattern(msg.regex, "g", [msg.sampleText]);
        notifyPopup({ type: "POPUP_WIZARD_TEST_RESULT", requestId: msg.requestId, testResult });
        break;
      }
      case "POPUP_CUSTOM_PATTERNS_GET": {
        const patterns = await loadCustomPatterns();
        notifyPopup({ type: "POPUP_CUSTOM_PATTERNS_STATE", requestId: msg.requestId, patterns });
        break;
      }
case "POPUP_CUSTOM_PATTERN_SAVE": {
        const patterns = await saveCustomPattern(msg.pattern);
        await enableCategoryForPattern(msg.pattern.category);
        notifyPopup({ type: "POPUP_CUSTOM_PATTERNS_STATE", requestId: msg.requestId, patterns });
        break;
      }
      case "POPUP_CUSTOM_PATTERN_DELETE": {
        const patterns = await deleteCustomPattern(msg.patternId);
        notifyPopup({ type: "POPUP_CUSTOM_PATTERNS_STATE", requestId: msg.requestId, patterns });
        break;
      }
      case "POPUP_COMMUNITY_ACCOUNT_GET": {
        const account = await loadCommunityAccount();
        notifyPopup({ type: "POPUP_COMMUNITY_ACCOUNT_DETAILS_STATE", requestId: msg.requestId, account });
        break;
      }
      case "POPUP_COMMUNITY_ACCOUNT_LINK_FREE": {
        notifyPopup({ type: "POPUP_COMMUNITY_ACCOUNT_DETAILS_STATE", requestId: msg.requestId, account: null });
        notifyPopup({ type: "POPUP_COMMUNITY_CONTRIBUTE_RESULT", requestId: msg.requestId, success: false, error: "Community account linking is unavailable until server authorization is configured." });
        break;
      }
      case "POPUP_COMMUNITY_ACCOUNT_UNLINK": {
        await unlinkCommunityAccount();
        notifyPopup({ type: "POPUP_COMMUNITY_ACCOUNT_DETAILS_STATE", requestId: msg.requestId, account: null });
        break;
      }
      case "POPUP_COMMUNITY_CONTRIBUTE": {
        notifyPopup({ type: "POPUP_COMMUNITY_CONTRIBUTE_RESULT", requestId: msg.requestId, success: false, error: "Community contributions are unavailable until server authorization and consent recording are configured." });
        break;
      }
      case "POPUP_COMMUNITY_FETCH_COMMUNITY_RULES": {
        notifyPopup({ type: "POPUP_COMMUNITY_COMMUNITY_RULES_STATE", requestId: msg.requestId, rules: [], error: "Community rule retrieval is unavailable until the server integration is configured." });
        break;
      }
      case "POPUP_API_CONNECT":
        await handleApiConnect(msg.apiUrl, msg.token, msg.requestId);
        break;
      case "POPUP_API_DISCONNECT":
        await handleApiDisconnect(msg.requestId);
        break;
      case "POPUP_DOC_CANCEL":
        await clearDocSession(msg.docId);
        break;
      case "POPUP_API_GET_STATUS":
        await handleApiGetStatus(msg.requestId);
        break;
      case "POPUP_API_SYNC_POLICY":
        await handleApiSyncPolicy(msg.requestId);
        break;
      case "POPUP_API_SUBMIT_LOGIC":
        await handleApiSubmitLogic(msg.patternId, msg.requestId);
        break;
      case "POPUP_OAUTH_CONNECT":
        await handleOAuthConnect(msg.requestId);
        break;
      case "POPUP_OAUTH_CALLBACK":
        await handleOAuthCallback(msg.code, msg.state, msg.requestId);
        break;
      default:
        break;
    }
  };

  void (async () => {
    try {
      await run();
      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({ ok: false, error: String(error) });
    }
  })();
  return true; // async response
});

// Clean up stale sessions for closed tabs.
chrome.tabs.onRemoved.addListener((tabId) => {
  const pending = pendingScans.get(tabId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingScans.delete(tabId);
  }
  void chrome.storage.session.remove(sessionKey(tabId));
});