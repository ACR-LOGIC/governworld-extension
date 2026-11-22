// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { validateMessage, chunkFindingsByByteBudget, DEFAULT_FINDINGS_CHUNK_BYTES, type ImageCandidate } from "../shared/messages.js";
import { loadSettings, saveSettings, isCloudAllowed, isAllowedGatewayOrigin, meetsThreshold } from "../shared/settings.js";
import { recordAudit, exportSignedAuditLog, handlePopupRecordAudit } from "./auditService.js";
import type { Settings } from "../shared/settings.js";
import { MAX_MESSAGE_BYTES, type DocKind, type PopupState, type ScanMode, type WorkerMessage, type ExtensionMessage, type Finding, type FindingCategory, type PopupFromWorker, type Rect, type RedactionOptions, type ScanSettingsMessage, type ScanCoverageStatus, type IncompleteWindowInfo } from "../shared/types.js";
import {
  previewDocument,
  redactDocument,
  countDocument,
  restoreLastSession,
  clearSession as clearDocSession,
  cancelDocument as cancelDocSession,
  purgeOrphanedStagedKeys,
  getStagedStorageAudit,
  purgeStagedData,
  clearAllFiles,
  storeFile,
  deleteFile,
  hasStagedDocument,
} from "./documents.js";
import { DocumentCancelledError } from "../document-pipeline/contract.js";
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
import { parseAccountView, NO_ACCOUNT } from "../shared/account.js";
import type { AccountView } from "../shared/account.js";
import {
  loadCustomPatterns,
  saveCustomPattern,
  deleteCustomPattern,
  loadCommunityAccount,
  unlinkCommunityAccount,
} from "../shared/customPatterns.js";
import { syncSiteProtection } from "./siteProtection.js";
import { loadEnterprisePolicy, resolveEffectiveProtection } from "../shared/enterprisePolicy.js";
import { MAX_DOC_BYTES } from "../shared/docLimits.js";
import { evaluateDestinationPolicy, fetchWithPolicy, readBoundedArrayBuffer } from "../shared/networkGuard.js";
import { sanitizeErrorForLog } from "../shared/errorSanitizer.js";
import { runOAuthConnectFlow, runOAuthCallbackFlow } from "./oauthService.js";
import {
  loadManagementEnrollment,
  saveManagementEnrollment,
  clearManagementEnrollment,
  loadLastAppliedManagedPolicy,
  ManagementEnrollment,
} from "../shared/managedPolicy.js";
import { syncManagedPolicy } from "./policySyncService.js";
import {
  scheduleHeartbeatAlarm,
  clearHeartbeatAlarm,
  sendHeartbeatStatusCheck,
  ALARM_NAME_HEARTBEAT,
} from "./heartbeatService.js";
import { getInstallationId } from "../api/config.js";

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
    confidenceThresholds: settings.confidenceThresholds,
    autoMaskSingleNames: settings.autoMaskSingleNames,
    medicalDictionaryEnabled: settings.medicalDictionaryEnabled,
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
    attrChars?: number;
    truncated: boolean;
    windowsScanned?: number;
    windowsTotal?: number;
    incompleteWindows?: IncompleteWindowInfo[];
    findingsTruncated?: boolean;
    totalFindings?: number;
    imageCandidates?: ImageCandidate[];
    coverageStatus?: ScanCoverageStatus;
    deferredMediaCount?: number;
    coverageWarnings?: import("../shared/types.js").CoverageWarning[];
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
const pendingResultChunks = new Map<
  string,
  { tabId: number; sessionId: string; totalChunks: number; chunks: Map<number, Finding[]> }
>();

function clearPendingChunksForTab(tabId: number): void {
  for (const [key, entry] of pendingResultChunks) {
    if (entry.tabId === tabId) pendingResultChunks.delete(key);
  }
}

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
    (v.stats.windowsScanned === undefined || (typeof v.stats.windowsScanned === "number" && Number.isSafeInteger(v.stats.windowsScanned) && v.stats.windowsScanned >= 0)) &&
    (v.stats.windowsTotal === undefined || (typeof v.stats.windowsTotal === "number" && Number.isSafeInteger(v.stats.windowsTotal) && v.stats.windowsTotal >= 0)) &&
    (v.stats.incompleteWindows === undefined || Array.isArray(v.stats.incompleteWindows)) &&
    (v.stats.coverageWarnings === undefined || Array.isArray(v.stats.coverageWarnings)) &&
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

export function updateBadgeForTab(tabId: number, count: number, forceColor?: string): void {
  try {
    void (async () => {
      const settings = await loadSettings().catch(() => null);
      const badgeEnabled = settings ? settings.notificationPrefs?.badgeEnabled ?? true : true;
      if (!badgeEnabled) {
        if (chrome.action?.setBadgeText) {
          void chrome.action.setBadgeText({ tabId, text: "" }).catch(() => undefined);
        }
        return;
      }
      if (chrome.action?.setBadgeText) {
        void chrome.action.setBadgeText({
          tabId,
          text: count > 0 ? (count > 99 ? "99+" : String(count)) : "",
        }).catch(() => undefined);
      }
      if (chrome.action?.setBadgeBackgroundColor) {
        void chrome.action.setBadgeBackgroundColor({
          tabId,
          color: forceColor ?? (count > 0 ? "#E53E3E" : "#2563EB"),
        }).catch(() => undefined);
      }
    })();
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
/** True when the user has granted the optional notifications permission. */
async function notificationsGranted(): Promise<boolean> {
  try {
    return (await chrome.permissions.contains({ permissions: ["notifications"] })) as boolean;
  } catch {
    return false;
  }
}

export interface ExtensionNotificationPayload {
  tabId?: number;
  event: "scan_findings" | "paste_intercept" | "policy_change" | "redaction_complete" | "action_failure";
  level?: "info" | "success" | "warning" | "danger";
  title: string;
  message: string;
  count?: number;
  categories?: Record<string, number>;
}

export async function dispatchExtensionNotification(payload: ExtensionNotificationPayload): Promise<void> {
  try {
    const settings = await loadSettings();
    const prefs = settings.notificationPrefs;

    if (payload.event === "scan_findings" && !prefs.notifyCriticalFindings) return;
    if (payload.event === "paste_intercept" && !prefs.notifyPasteInterception) return;
    if (payload.event === "policy_change" && !prefs.notifyPolicyChanges) return;
    if (payload.event === "redaction_complete" && !prefs.notifyRedactionComplete) return;

    let displayTitle = payload.title;
    let displayMessage = payload.message;

    if (prefs.privacyMode === "minimal" && payload.event === "scan_findings") {
      const c = payload.count ?? 1;
      displayTitle = "GovernWorld \u2014 Sensitive Data Detected";
      displayMessage = `${c} sensitive item${c === 1 ? "" : "s"} detected on this page.`;
    }

    // 1. In-page Toast HUD (closed shadow DOM in active tab)
    if (prefs.toastEnabled && payload.tabId !== undefined && payload.tabId > 0) {
      void chrome.tabs.sendMessage(payload.tabId, {
        type: "CONTENT_SHOW_TOAST",
        requestId: `toast-${Date.now()}`,
        level: payload.level ?? "info",
        title: displayTitle,
        message: displayMessage,
      }).catch(() => undefined);
    }

    // 2. Desktop OS notification (gated by optional permission)
    if (prefs.systemEnabled && (await notificationsGranted())) {
      await chrome.notifications.create({
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
        title: displayTitle,
        message: displayMessage,
        priority: payload.level === "danger" ? 1 : 0,
      });
    }

    // 3. Action badge counter/status
    if (prefs.badgeEnabled && payload.tabId !== undefined && payload.tabId > 0) {
      if (payload.event === "scan_findings" && payload.count !== undefined) {
        updateBadgeForTab(payload.tabId, payload.count);
      } else if (payload.event === "action_failure") {
        flashTabStatus(payload.tabId, "failed");
      } else if (payload.event === "redaction_complete") {
        flashTabStatus(payload.tabId, "ok");
      }
    }
  } catch {
    // Fail closed
  }
}

async function maybeNotifyFindings(findings: Finding[], tabId?: number): Promise<void> {
  if (findings.length === 0) return;
  const counts = countByCategory(findings);
  const top = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([category, n]) => `${n} ${category.replace(/_/g, " ")}`)
    .join(", ");
  await dispatchExtensionNotification({
    tabId,
    event: "scan_findings",
    level: "warning",
    title: "GovernWorld \u2014 sensitive data found",
    message: `${findings.length} value${findings.length === 1 ? "" : "s"} detected on this page: ${top}.`,
    count: findings.length,
    categories: counts,
  });
}

async function reportActionFailure(tabId: number, userMessage: string): Promise<void> {
  flashTabStatus(tabId, "failed");
  console.warn(`[governworld] ${userMessage}`);
  await dispatchExtensionNotification({
    tabId,
    event: "action_failure",
    level: "danger",
    title: "GovernWorld \u2014 action not completed",
    message: userMessage,
  });
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
    url.startsWith("moz-extension://") ||
    url.startsWith("safari-web-extension://") ||
    url.startsWith("chrome://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:") ||
    url.startsWith("view-source:") ||
    (typeof chrome !== "undefined" && typeof chrome.runtime?.getURL === "function" && url.startsWith(chrome.runtime.getURL("")))
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

const PINNED_TARGET_KEY = "pinnedScanTarget";

interface StoredPinnedTarget {
  status: import("../shared/types.js").PinnedTargetStatus;
  pinnedTabId: number | null;
  title?: string;
  url?: string;
  domain?: string;
  scannedUrl?: string;
  closedTitle?: string;
  closedDomain?: string;
}

let lastPinnedTargetInfo: import("../shared/types.js").PinnedTargetInfo | undefined;

function tabDomain(url?: string): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function tabDisplayTitle(tab: chrome.tabs.Tab | undefined, fallback?: string): string {
  const rawTitle = typeof tab?.title === "string" ? tab.title.trim() : "";
  if (rawTitle.length > 0) return rawTitle.slice(0, 140);
  const host = tabDomain(tab?.url);
  if (host.length > 0) return host;
  if (fallback && fallback.trim().length > 0) return fallback.trim().slice(0, 140);
  return tab?.id ? `Tab #${tab.id}` : "Untitled tab";
}

function isStoredPinnedTarget(value: unknown): value is StoredPinnedTarget {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<StoredPinnedTarget>;
  if (v.status !== "unpinned" && v.status !== "pinned" && v.status !== "navigated" && v.status !== "closed") {
    return false;
  }
  if (v.pinnedTabId !== null && (typeof v.pinnedTabId !== "number" || !Number.isSafeInteger(v.pinnedTabId) || v.pinnedTabId <= 0)) {
    return false;
  }
  return true;
}

async function readPinnedTarget(): Promise<StoredPinnedTarget | null> {
  try {
    const raw: unknown = await chrome.storage.session.get(PINNED_TARGET_KEY);
    if (typeof raw !== "object" || raw === null) return null;
    const value = (raw as Record<string, unknown>)[PINNED_TARGET_KEY];
    return isStoredPinnedTarget(value) ? value : null;
  } catch {
    return null;
  }
}

async function writePinnedTarget(target: StoredPinnedTarget): Promise<void> {
  try {
    await chrome.storage.session.set({ [PINNED_TARGET_KEY]: target });
  } catch {
    // Best-effort session storage persistence
  }
}

async function listScannableTabs(): Promise<import("../shared/types.js").ScannableTabSummary[]> {
  try {
    const allTabs = await chrome.tabs.query({});
    const out: import("../shared/types.js").ScannableTabSummary[] = [];
    for (const t of allTabs) {
      if (!isScannableTab(t) || !t.id || !t.url) continue;
      out.push({
        tabId: t.id,
        title: tabDisplayTitle(t),
        url: t.url,
        domain: tabDomain(t.url),
        active: Boolean(t.active),
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function refreshPinnedTargetInfo(options?: { autoPinInitialIfUnset?: boolean }): Promise<import("../shared/types.js").PinnedTargetInfo> {
  const [availableTabs, initialStored] = await Promise.all([listScannableTabs(), readPinnedTarget()]);
  let stored = initialStored;

  if (!stored && options?.autoPinInitialIfUnset) {
    const initialTab = await getActiveTab();
    if (initialTab?.id && initialTab.url) {
      stored = {
        status: "pinned",
        pinnedTabId: initialTab.id,
        title: tabDisplayTitle(initialTab),
        url: initialTab.url,
        domain: tabDomain(initialTab.url),
      };
      await writePinnedTarget(stored);
    }
  }

  if (stored && stored.pinnedTabId !== null) {
    let liveTab: chrome.tabs.Tab | undefined;
    try {
      liveTab = await chrome.tabs.get(stored.pinnedTabId);
    } catch {
      liveTab = undefined;
    }
    if (!liveTab || !isScannableTab(liveTab)) {
      stored = {
        status: "closed",
        pinnedTabId: null,
        closedTitle: stored.title,
        closedDomain: stored.domain,
      };
      await writePinnedTarget(stored);
    } else {
      const nextUrl = liveTab.url ?? stored.url;
      const nextTitle = tabDisplayTitle(liveTab, stored.title);
      const nextDomain = tabDomain(nextUrl) || stored.domain;
      const navigated =
        stored.status === "navigated" ||
        Boolean(stored.scannedUrl && nextUrl && nextUrl !== stored.scannedUrl);
      const nextStatus: import("../shared/types.js").PinnedTargetStatus = navigated ? "navigated" : "pinned";
      if (
        nextStatus !== stored.status ||
        nextUrl !== stored.url ||
        nextTitle !== stored.title ||
        nextDomain !== stored.domain
      ) {
        stored = {
          ...stored,
          status: nextStatus,
          url: nextUrl,
          title: nextTitle,
          domain: nextDomain,
        };
        await writePinnedTarget(stored);
      }
    }
  }

  const info: import("../shared/types.js").PinnedTargetInfo = {
    status: stored?.status ?? "unpinned",
    pinnedTabId: stored?.pinnedTabId ?? null,
    ...(stored?.title ? { title: stored.title } : {}),
    ...(stored?.url ? { url: stored.url } : {}),
    ...(stored?.domain ? { domain: stored.domain } : {}),
    ...(stored?.scannedUrl ? { scannedUrl: stored.scannedUrl } : {}),
    ...(stored?.closedTitle ? { closedTitle: stored.closedTitle } : {}),
    ...(stored?.closedDomain ? { closedDomain: stored.closedDomain } : {}),
    availableTabs,
  };
  lastPinnedTargetInfo = info;
  return info;
}

export async function resolveTargetTab(explicitTabId?: number): Promise<chrome.tabs.Tab | undefined> {
  const stored = await readPinnedTarget();
  if (stored) {
    if (stored.status === "closed" || stored.status === "unpinned" || stored.pinnedTabId === null) {
      return undefined;
    }
    try {
      const pinnedCandidate = await chrome.tabs.get(stored.pinnedTabId);
      if (pinnedCandidate && isScannableTab(pinnedCandidate)) {
        return pinnedCandidate;
      }
    } catch {
      // Tab no longer exists
    }
    await writePinnedTarget({
      status: "closed",
      pinnedTabId: null,
      closedTitle: stored.title,
      closedDomain: stored.domain,
    });
    return undefined;
  }

  if (typeof explicitTabId === "number" && explicitTabId > 0) {
    try {
      const candidate = await chrome.tabs.get(explicitTabId);
      if (candidate && isScannableTab(candidate)) {
        return candidate;
      }
    } catch {
      // Fall through to active tab resolution
    }
  }
  return await getActiveTab();
}

function notifyPopup(message: PopupFromWorker): void {
  if (message.type === "POPUP_STATE" && message.state.findings.length > 1) {
    const serialized = JSON.stringify(message);
    if (serialized.length > MAX_MESSAGE_BYTES - 1024) {
      const chunks = chunkFindingsByByteBudget(message.state.findings, DEFAULT_FINDINGS_CHUNK_BYTES);
      if (chunks.length > 1) {
        const sessionId = message.state.sessionId ?? "state";
        void (async () => {
          for (let i = 0; i < chunks.length - 1; i++) {
            await chrome.runtime.sendMessage({
              type: "POPUP_STATE_CHUNK",
              requestId: message.requestId,
              sessionId,
              chunkIndex: i,
              totalChunks: chunks.length,
              findings: chunks[i],
            }).catch(() => undefined);
          }
          await chrome.runtime.sendMessage({
            ...message,
            chunkIndex: chunks.length - 1,
            totalChunks: chunks.length,
            state: {
              ...message.state,
              findings: chunks[chunks.length - 1],
              findingsTruncated: false,
              totalFindings: message.state.findings.length,
            },
          }).catch(() => undefined);
        })();
        return;
      }
    }
  }
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
    console.warn(`[governworld] Unable to dynamically inject content script on tab ${tabId}:`, sanitizeErrorForLog(error));
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

let currentOperatingMode: "LOCAL" | "MANAGE" = "LOCAL";

export async function refreshOperatingMode(): Promise<"LOCAL" | "MANAGE"> {
  try {
    const policy = await loadEnterprisePolicy();
    const enrollment = await loadManagementEnrollment();
    if (policy.managed || (enrollment && enrollment.management_mode === "MANAGE")) {
      currentOperatingMode = "MANAGE";
    } else {
      currentOperatingMode = "LOCAL";
    }
  } catch {
    currentOperatingMode = "LOCAL";
  }
  return currentOperatingMode;
}

function buildPopupState(
  settings: Settings,
  session: SessionState | null,
  error?: { code: string; userMessage: string }
): PopupState {
  const incompleteWindows = session?.stats.incompleteWindows;
  const hasIncompleteWindows = Boolean(incompleteWindows && incompleteWindows.length > 0);
  return {
    mode: settings.mode,
    operatingMode: currentOperatingMode,
    scanning: session?.scanning ?? false,
    findings: session?.findings ?? [],
    scanned: session !== null,
    truncated: (session?.stats.truncated ?? false) || (session?.stats.findingsTruncated ?? false) || hasIncompleteWindows,
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
    coverageStatus: hasIncompleteWindows ? "PARTIALLY_SCANNED" : session?.stats.coverageStatus,
    deferredMediaCount: session?.stats.deferredMediaCount,
    ...(session?.stats.windowsScanned !== undefined ? { windowsScanned: session.stats.windowsScanned } : {}),
    ...(session?.stats.windowsTotal !== undefined ? { windowsTotal: session.stats.windowsTotal } : {}),
    ...(hasIncompleteWindows ? { incompleteWindows } : {}),
    ...(session?.stats.coverageWarnings && session.stats.coverageWarnings.length > 0
      ? { coverageWarnings: session.stats.coverageWarnings }
      : {}),
    ...(lastPinnedTargetInfo ? { pinnedTarget: lastPinnedTargetInfo } : {}),
  };
}

async function stateForActiveTab(explicitTabId?: number, autoPinInitial = false): Promise<PopupState> {
  await refreshOperatingMode();
  await refreshPinnedTargetInfo({ autoPinInitialIfUnset: autoPinInitial });
  const settings = await loadSettings();
  const tab = await resolveTargetTab(explicitTabId);
  const session = tab ? await readSession(tab.id ?? -1) : null;
  return buildPopupState(settings, session);
}

async function handlePopupPinTab(tabId: number | null, pinCurrent: boolean | undefined, requestId: string): Promise<void> {
  if (pinCurrent === true) {
    const active = await getActiveTab();
    if (active?.id && active.url) {
      const existingSession = await readSession(active.id);
      await writePinnedTarget({
        status: "pinned",
        pinnedTabId: active.id,
        title: tabDisplayTitle(active),
        url: active.url,
        domain: tabDomain(active.url),
        ...(existingSession ? { scannedUrl: active.url } : {}),
      });
    } else {
      await writePinnedTarget({ status: "unpinned", pinnedTabId: null });
    }
  } else if (tabId === null) {
    await writePinnedTarget({ status: "unpinned", pinnedTabId: null });
  } else {
    let target: chrome.tabs.Tab | undefined;
    try {
      target = await chrome.tabs.get(tabId);
    } catch {
      target = undefined;
    }
    if (target && isScannableTab(target) && target.id && target.url) {
      const existingSession = await readSession(target.id);
      await writePinnedTarget({
        status: "pinned",
        pinnedTabId: target.id,
        title: tabDisplayTitle(target),
        url: target.url,
        domain: tabDomain(target.url),
        ...(existingSession ? { scannedUrl: target.url } : {}),
      });
    } else {
      await writePinnedTarget({ status: "unpinned", pinnedTabId: null });
    }
  }
  const state = await stateForActiveTab();
  notifyPopup({ type: "POPUP_STATE", requestId, state });
}

async function handlePopupScan(mode: ScanMode, requestId: string, explicitTabId?: number): Promise<void> {
  const settings = await loadSettings();
  await refreshPinnedTargetInfo();

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

  const storedPin = await readPinnedTarget();
  if (storedPin?.status === "closed") {
    notifyPopup({
      type: "POPUP_STATE",
      requestId,
      state: buildPopupState(settings, null, {
        code: "TARGET_TAB_CLOSED",
        userMessage: "Pinned target tab closed. Choose a new target tab to scan.",
      }),
    });
    return;
  }
  if (storedPin?.status === "unpinned") {
    notifyPopup({
      type: "POPUP_STATE",
      requestId,
      state: buildPopupState(settings, null, {
        code: "NO_PINNED_TAB",
        userMessage: "No target tab is pinned. Select or pin a tab to scan.",
      }),
    });
    return;
  }

  const tab = await resolveTargetTab(explicitTabId);
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

  if (storedPin && storedPin.pinnedTabId === tab.id && tab.url) {
    await writePinnedTarget({
      ...storedPin,
      status: "pinned",
      url: tab.url,
      title: tabDisplayTitle(tab, storedPin.title),
      domain: tabDomain(tab.url) || storedPin.domain,
      scannedUrl: tab.url,
    });
    await refreshPinnedTargetInfo();
  }

  const sessionId = crypto.randomUUID();
  const tabId = tab.id;
  clearPendingChunksForTab(tabId);
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
async function handlePopupApplyMasks(findingIds: string[], requestId: string, explicitTabId?: number): Promise<boolean> {
  await refreshPinnedTargetInfo();
  const tab = await resolveTargetTab(explicitTabId);
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

async function handlePopupUndoMasks(requestId: string, explicitTabId?: number): Promise<void> {
  await refreshPinnedTargetInfo();
  const tab = await resolveTargetTab(explicitTabId);
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
async function handlePopupRemoveMasks(requestId: string, explicitTabId?: number): Promise<boolean> {
  await refreshPinnedTargetInfo();
  const tab = await resolveTargetTab(explicitTabId);
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

async function handlePopupCopyRedacted(findingIds: string[], requestId: string, explicitTabId?: number): Promise<void> {
  await refreshPinnedTargetInfo();
  const tab = await resolveTargetTab(explicitTabId);
  const session = tab?.id ? await readSession(tab.id) : null;
  if (!tab?.id || !session) {
    const settings = await loadSettings();
    notifyPopup({ type: "POPUP_STATE", requestId, state: buildPopupState(settings, session, { code: "NO_SESSION", userMessage: "Run a scan first." }) });
    return;
  }
  await sendToTab(tab.id, { type: "COPY_REDACTED_TEXT", requestId, sessionId: session.sessionId, findingIds });
}

async function handlePopupClearData(requestId: string, explicitTabId?: number): Promise<void> {
  await refreshPinnedTargetInfo();
  const tab = await resolveTargetTab(explicitTabId);
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
    if (error instanceof DocumentCancelledError || (error instanceof Error && error.name === "DocumentCancelledError")) {
      void recordAudit({ ts: new Date().toISOString(), action: "doc_cleared", outcome: "ok" });
      return;
    }
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
  }, { failClosed: true });
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

    let downloadOk = false;
    try {
      const dataUrl = `data:${outputMimeType};base64,${bytesToBase64(outputBytes)}`;
      await chrome.downloads.download({ url: dataUrl, filename: outputName, saveAs: true });
      downloadOk = true;
    } catch (error) {
      // Falling back to the popup is correct, but swallowing the reason makes a
      // delivery failure undiagnosable in the field: every incident looks
      // identical to a successful redaction. Record it, minus any payload bytes.
      console.warn("[governworld] service-worker download failed, using popup fallback:", sanitizeErrorForLog(error));
      downloadOk = false;
    }

    const verified = verification.verified;

    await clearDocSession(docId);
    if (downloadOk) {
      await recordAudit({
        ts: new Date().toISOString(),
        action: "doc_redacted",
        docHash,
        outcome: verified ? "ok" : "error",
        ...(verified ? {} : { counts: { unverified: verification.checkedRegions - verification.darkRegions } }),
      }, { failClosed: true });
      notifyPopup({ type: "POPUP_DOC_DONE", requestId, outputName, outputMimeType, printFileKey: printRef?.fileKey });
      void dispatchExtensionNotification({
        event: "redaction_complete",
        level: "success",
        title: "GovernWorld \u2014 Document Redacted",
        message: `Successfully redacted and verified ${outputName}.`,
      });
    } else {
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

function selectorToken(selector: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < selector.length; i += 1) {
    h ^= selector.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `e${h.toString(36)}`;
}

function tabHost(tab: chrome.tabs.Tab | undefined): string | undefined {
  if (!tab?.url) return undefined;
  try {
    return new URL(tab.url).host || undefined;
  } catch {
    return undefined;
  }
}

async function handleContentScanProgress(
  message: Extract<WorkerMessage, { type: "SCAN_PROGRESS" }>,
  tabId: number
): Promise<void> {
  const pending = pendingScans.get(tabId);
  if (!pending || pending.sessionId !== message.sessionId) return;
  notifyPopup({
    type: "POPUP_SCAN_PROGRESS",
    requestId: pending.requestId,
    sessionId: message.sessionId,
    windowsCompleted: message.windowsCompleted,
    windowsTotal: message.windowsTotal,
    charsScanned: message.charsScanned,
    charsTotal: message.charsTotal,
    findingsSoFar: message.findingsSoFar,
  });
}

async function handleContentScanResultChunk(
  message: Extract<WorkerMessage, { type: "SCAN_RESULT_CHUNK" }>,
  tabId: number
): Promise<void> {
  const pending = pendingScans.get(tabId);
  const existing = pending ? null : await readSession(tabId);
  const expectedSessionId = pending?.sessionId ?? existing?.sessionId;
  if (!expectedSessionId || expectedSessionId !== message.sessionId) {
    return;
  }
  const chunkKey = `${tabId}:${message.sessionId}:${message.requestId}`;
  let buffer = pendingResultChunks.get(chunkKey);
  if (!buffer) {
    buffer = {
      tabId,
      sessionId: message.sessionId,
      totalChunks: message.totalChunks,
      chunks: new Map(),
    };
    pendingResultChunks.set(chunkKey, buffer);
  }
  buffer.chunks.set(message.chunkIndex, message.findings);
}

function reassembleScanResult(
  message: Extract<WorkerMessage, { type: "SCAN_RESULT" }>,
  tabId: number
): { findings: Finding[]; stats: Extract<WorkerMessage, { type: "SCAN_RESULT" }>["stats"] } {
  const chunkKey = `${tabId}:${message.sessionId}:${message.requestId}`;
  const buffer = pendingResultChunks.get(chunkKey);
  pendingResultChunks.delete(chunkKey);

  if (!message.totalChunks || message.totalChunks <= 1) {
    return { findings: message.findings, stats: message.stats };
  }

  const combined: Finding[] = [];
  const missingChunkIndices: number[] = [];
  const finalIdx = message.chunkIndex ?? message.totalChunks - 1;
  for (let i = 0; i < message.totalChunks; i++) {
    if (i === finalIdx) {
      combined.push(...message.findings);
      continue;
    }
    const part = buffer?.chunks.get(i);
    if (!part) {
      missingChunkIndices.push(i);
      continue;
    }
    combined.push(...part);
  }

  if (missingChunkIndices.length === 0) {
    return {
      findings: combined,
      stats: {
        ...message.stats,
        findingsTruncated: false,
        totalFindings: combined.length,
      },
    };
  }

  const extraIncomplete: IncompleteWindowInfo[] = missingChunkIndices.map((idx) => ({
    windowIndex: idx + 1,
    reason: `IPC findings chunk ${idx + 1} of ${message.totalChunks} missing`,
  }));
  return {
    findings: combined,
    stats: {
      ...message.stats,
      truncated: true,
      findingsTruncated: true,
      coverageStatus: "PARTIALLY_SCANNED",
      incompleteWindows: [...(message.stats.incompleteWindows ?? []), ...extraIncomplete],
    },
  };
}

async function handleContentScanResult(message: Extract<WorkerMessage, { type: "SCAN_RESULT" }>, tabId: number): Promise<void> {
  const pending = pendingScans.get(tabId);
  if (!pending) {
    const existing = await readSession(tabId);
    if (!existing || existing.sessionId !== message.sessionId) {
      pendingResultChunks.delete(`${tabId}:${message.sessionId}:${message.requestId}`);
      return;
    }
    const reassembled = reassembleScanResult(message, tabId);
    const settings = await loadSettings();
    const findings = reassembled.findings.filter((f) => meetsThreshold(settings, f.category, f.confidence));
    await writeSession(tabId, {
      sessionId: message.sessionId,
      mode: settings.mode,
      findings,
      stats: {
        ...reassembled.stats,
        ...(existing.stats.imageCandidates ? { imageCandidates: existing.stats.imageCandidates } : {}),
      },
      scannedAt: Date.now(),
      scanning: false,
    });
    const session = await readSession(tabId);
    await refreshPinnedTargetInfo();
    const storedPin = await readPinnedTarget();
    if (!storedPin?.pinnedTabId || storedPin.pinnedTabId === tabId) {
      notifyPopup({ type: "POPUP_STATE", requestId: message.requestId, state: buildPopupState(settings, session) });
    }
    updateBadgeForTab(tabId, findings.length);
    return;
  }
  if (message.sessionId !== pending.sessionId) {
    clearTimeout(pending.timer);
    pendingScans.delete(tabId);
    clearPendingChunksForTab(tabId);
    return;
  }
  clearTimeout(pending.timer);
  pendingScans.delete(tabId);
  const reassembled = reassembleScanResult(message, tabId);
  const settings = await loadSettings();
  const findings = reassembled.findings.filter((f) => meetsThreshold(settings, f.category, f.confidence));
  await writeSession(tabId, {
    sessionId: message.sessionId,
    mode: settings.mode,
    findings,
    stats: reassembled.stats,
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
  await refreshPinnedTargetInfo();
  const storedPin = await readPinnedTarget();
  if (!storedPin?.pinnedTabId || storedPin.pinnedTabId === tabId) {
    notifyPopup({ type: "POPUP_STATE", requestId: pending.requestId, state: buildPopupState(settings, session) });
  }
  updateBadgeForTab(tabId, findings.length);
  void maybeNotifyFindings(findings, tabId);

  // ── Async media dispatch (Layers 2–5) ─────────────────────────────────
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
            const { tryFetchOriginal } = await import("./captureImage.js");
            const original = await tryFetchOriginal(item.resourceUrl).catch(() => null);
            if (original) {
              bytes = original.bytes;
              mimeType = original.mimeType;
            } else if (tab?.windowId) {
              const { captureActiveTab, cropCapturedImage } = await import("./captureImage.js");
              const capture = await captureActiveTab(tab.windowId).catch(() => null);
              if (capture) {
                bytes = item.cropRect ? await cropCapturedImage(capture.bytes, item.cropRect) : capture.bytes;
                mimeType = capture.mimeType;
              }
            }
          }

          if (!bytes) continue;

          const tmpKey = `vis_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
          await storeFile(tmpKey, bytes);
          try {
            const { previewDocument } = await import("./documents.js");
            const { pages } = await previewDocument(tmpKey, item.cssSelector || "page-image.png", mimeType, "image");
            for (const page of pages) {
              for (const f of page.findings) {
                if (meetsThreshold(settings, f.category, f.confidence)) {
                  const pageRects = (f.rects ?? []).map((r) => ({
                    ...r,
                    x: r.x + (item.cropRect?.x ?? 0),
                    y: r.y + (item.cropRect?.y ?? 0),
                  }));
                  newFindings.push({
                    ...f,
                    id: `media_${item.sourceId}_${f.id}`,
                    source: "local-rules",
                    nodeId: `media_${item.sourceId}`,
                    rects: pageRects.length > 0 ? pageRects : f.rects,
                    selected: false,
                  });
                }
              }
            }
            await deleteFile(tmpKey).catch(() => undefined);
          } catch {
            await deleteFile(tmpKey).catch(() => undefined);
          }
        } catch {
          // Individual item failure is not fatal to the queue.
        }
      }

      // ── PDF extraction ────────────────────────────────────────────────
      let skippedNetworkCount = 0;
      for (const item of pdfQueue) {
        try {
          const enterprisePolicy = await loadEnterprisePolicy();
          const destCheck = evaluateDestinationPolicy(item.url, enterprisePolicy.networkDestinationPolicy, enterprisePolicy.networkAllowlist);
          if (!destCheck.allowed) {
            skippedNetworkCount++;
            continue;
          }

          let response: Response | null = null;
          try {
            response = await fetchWithPolicy(item.url, {
              credentials: "omit",
              policy: enterprisePolicy.networkDestinationPolicy,
              allowlist: enterprisePolicy.networkAllowlist,
              timeoutMs: FETCH_TIMEOUT_MS,
            });
          } catch {
            skippedNetworkCount++;
            continue;
          }
          if (!response?.ok) {
            skippedNetworkCount++;
            continue;
          }

          const declaredType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
          if (declaredType && !declaredType.includes("pdf") && declaredType !== "application/octet-stream" && declaredType !== "binary/octet-stream") {
            continue;
          }

          const clHeader = response.headers.get("content-length");
          if (clHeader) {
            const cl = parseInt(clHeader, 10);
            if (Number.isFinite(cl) && cl > MAX_DOC_BYTES) continue;
          }

          const { buffer, exceeded } = await readBoundedArrayBuffer(response, MAX_DOC_BYTES);
          if (exceeded || buffer.byteLength === 0 || buffer.byteLength > MAX_DOC_BYTES) continue;

          const tmpKey = `pdf_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
          await storeFile(tmpKey, buffer);
          try {
            const { previewDocument } = await import("./documents.js");
            const name = item.url.split("/").pop()?.slice(0, 80) || "document.pdf";
            const { pages } = await previewDocument(tmpKey, name, "application/pdf", "pdf");
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

      if (newFindings.length === 0 && skippedNetworkCount === 0) return;

      const currentSession = await readSession(tabId);
      if (!currentSession || currentSession.sessionId !== message.sessionId) return;
      const updatedStats = { ...currentSession.stats };
      if (skippedNetworkCount > 0) {
        updatedStats.deferredMediaCount = (updatedStats.deferredMediaCount ?? 0) + skippedNetworkCount;
        updatedStats.coverageStatus = "PARTIALLY_SCANNED";
      }
      const merged = [...currentSession.findings, ...newFindings];
      await writeSession(tabId, { ...currentSession, findings: merged, stats: updatedStats });
      const updatedSession = await readSession(tabId);
      notifyPopup({
        type: "POPUP_STATE",
        requestId: pending.requestId,
        state: buildPopupState(settings, updatedSession),
      });
      if (newFindings.length > 0) {
        void sendToTab(tabId, {
          type: "SCAN_PAGE_VISUAL_RESULT",
          requestId: pending.requestId,
          sessionId: message.sessionId,
          sourceId: "all_media",
          findings: newFindings,
        }).catch(() => undefined);
      }
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

// ---------- Account (gateway identity binding) ----------

const ACCOUNT_KEY = "account";
const ACCOUNT_KEY_CREDENTIAL = "accountApiKey";

/** Non-secret account metadata persisted in chrome.storage.local. */
interface StoredAccount {
  gatewayOrigin: string;
  linked: boolean;
  accountLabel?: string;
  account?: AccountView;
}

/** Account link status (metadata) + live-credential availability (session). */
interface AccountState {
  linked: boolean;
  gatewayOrigin: string | null;
  accountLabel?: string;
  credentialAvailable: boolean;
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

async function clearAccount(requestId: string): Promise<void> {
  await Promise.all([
    chrome.storage.local.remove([ACCOUNT_KEY, ACCOUNT_KEY_CREDENTIAL]),
    chrome.storage.session.remove(ACCOUNT_KEY_CREDENTIAL),
  ]);
  const settings = await loadSettings();
  await saveSettings({ ...settings, gatewayOrigin: null, accountLabel: undefined });
  await notifyAccountState(requestId);
}

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

void chrome.storage.local.remove([ACCOUNT_KEY_CREDENTIAL]);

let startupCleanupError: unknown;
let startupPurge: Promise<void> = Promise.resolve();
const PURGE_WAIT_MS = 5_000;

async function enableCategoryForPattern(category: FindingCategory): Promise<void> {
  const settings = await loadSettings();
  if (settings.enabledCategories.includes(category)) return;
  await saveSettings({
    ...settings,
    enabledCategories: [...settings.enabledCategories, category],
  });
}

function purgeStagedFilesOnLifecycle(reason: string): void {
  startupPurge = (async () => {
    try {
      if (await hasStagedDocument()) {
        await purgeOrphanedStagedKeys();
        console.warn(`[governworld] active staged document preserved on ${reason}; orphaned keys purged.`);
        startupCleanupError = undefined;
        return;
      }
      await clearAllFiles();
      startupCleanupError = undefined;
    } catch (error) {
      startupCleanupError = error;
      console.warn(`[governworld] staged-file purge failed on ${reason}:`, sanitizeErrorForLog(error));
    }
  })();
}

chrome.runtime.onStartup?.addListener(() => {
  purgeStagedFilesOnLifecycle("browser startup");
  void syncManagedPolicy(false);
  void refreshOperatingMode();
  void scheduleHeartbeatAlarm();
});

chrome.runtime.onInstalled?.addListener(() => {
  purgeStagedFilesOnLifecycle("extension install/update");
  void syncManagedPolicy(false);
  void refreshOperatingMode();
  void scheduleHeartbeatAlarm();
});

// OAuth callback capture: when the provider redirects to chromiumapp.org,
// extract the authorization code and state, then close the tab.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading") clearBadgeForTab(tabId);
  if (changeInfo.url || changeInfo.title || changeInfo.status === "complete") {
    void (async () => {
      const stored = await readPinnedTarget();
      if (stored && stored.pinnedTabId === tabId) {
        const nextUrl = changeInfo.url ?? tab.url ?? stored.url;
        const urlChanged = Boolean(changeInfo.url && stored.url && changeInfo.url !== stored.url);
        const nextTitle = tabDisplayTitle(tab, stored.title);
        const nextDomain = tabDomain(nextUrl) || stored.domain;
        const nextStatus: import("../shared/types.js").PinnedTargetStatus =
          urlChanged || stored.status === "navigated" || Boolean(stored.scannedUrl && nextUrl && nextUrl !== stored.scannedUrl)
            ? "navigated"
            : "pinned";
        await writePinnedTarget({
          ...stored,
          status: nextStatus,
          url: nextUrl,
          title: nextTitle,
          domain: nextDomain,
        });
        const state = await stateForActiveTab();
        notifyPopup({ type: "POPUP_STATE", requestId: "pinned-tab-updated", state });
      }
    })().catch(() => undefined);
  }
  if (!tab.url) return;
  let url: URL;
  try {
    url = new URL(tab.url);
  } catch {
    return;
  }
  if (url.protocol !== "https:" || !url.hostname.endsWith(".chromiumapp.org")) return;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (code && state) {
    void chrome.tabs.remove(tabId).catch(() => undefined);
    void handleOAuthCallback(code, state, crypto.randomUUID());
  }
});

// Keyboard shortcuts (manifest "commands").
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

void syncSiteProtection();
void reconcileTabStatuses();
void syncManagedPolicy(false);
void refreshOperatingMode();
void scheduleHeartbeatAlarm();
void purgeOrphanedStagedKeys();

if (typeof chrome !== "undefined" && chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME_HEARTBEAT) {
      void sendHeartbeatStatusCheck();
      void syncManagedPolicy(false);
    }
  });
}

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
        const response = await sendToTab(tabId, msg);
        const error = actionError(response);
        const counts = actionCounts(response);
        let auditError: string | null = null;
        try {
          await recordAudit({
            ts: new Date().toISOString(),
            action: "selection_redacted",
            ...(host ? { host } : {}),
            ...(counts ? { counts } : {}),
            outcome: error ? "error" : "ok",
          }, { failClosed: true });
        } catch (err) {
          auditError = err instanceof Error ? err.message : String(err);
        }
        if (error || auditError) {
          await reportActionFailure(tabId, `Redact selection: ${error || `Audit persistence failed (${auditError})`}`);
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
      console.warn("[governworld] Context menu action failed:", sanitizeErrorForLog(error));
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

const oauthCallbacks = {
  notifyPopup,
  updateAccountMetadataView: async (view: AccountView) => {
    const metadata = await readAccountMetadata();
    if (metadata) {
      await chrome.storage.local.set({ [ACCOUNT_KEY]: { ...metadata, account: view } });
    }
  },
  notifyAccountState: (requestId: string) => notifyAccountState(requestId),
};

async function handleOAuthConnect(requestId: string): Promise<void> {
  await runOAuthConnectFlow(requestId, oauthCallbacks);
}

async function handleOAuthCallback(code: string, state: string, requestId: string): Promise<void> {
  await runOAuthCallbackFlow(code, state, requestId, oauthCallbacks);
}

async function handleManagementGetStatus(requestId: string): Promise<void> {
  await refreshOperatingMode();
  const enrollment = await loadManagementEnrollment();
  const lastApplied = await loadLastAppliedManagedPolicy();
  const deviceId = await getInstallationId();
  notifyPopup({
    type: "POPUP_MANAGEMENT_STATUS_STATE",
    requestId,
    mode: currentOperatingMode,
    enrolled: Boolean(enrollment && enrollment.management_mode === "MANAGE"),
    ...(enrollment?.organization_id ? { organizationId: enrollment.organization_id } : {}),
    ...(enrollment?.organization_name ? { organizationName: enrollment.organization_name } : {}),
    ...(enrollment?.employee_id ? { employeeId: enrollment.employee_id } : {}),
    ...(enrollment?.employee_email ? { employeeEmail: enrollment.employee_email } : {}),
    deviceId,
    ...(lastApplied?.policy_id ? { appliedPolicyId: lastApplied.policy_id } : {}),
    ...(lastApplied?.policy_version ? { appliedPolicyVersion: lastApplied.policy_version } : {}),
  });
}

async function handleManagementEnroll(
  msg: {
    organizationId: string;
    organizationName?: string;
    employeeId: string;
    employeeEmail?: string;
    coordinatorUrl?: string;
  },
  requestId: string,
): Promise<void> {
  const deviceId = await getInstallationId();
  const enrollment: ManagementEnrollment = {
    organization_id: msg.organizationId,
    organization_name: msg.organizationName,
    employee_id: msg.employeeId,
    employee_email: msg.employeeEmail,
    device_id: deviceId,
    enrolled_at: new Date().toISOString(),
    coordinator_url: msg.coordinatorUrl,
    management_mode: "MANAGE",
  };
  await saveManagementEnrollment(enrollment);
  await syncManagedPolicy(true);
  await scheduleHeartbeatAlarm();
  void sendHeartbeatStatusCheck();
  await handleManagementGetStatus(requestId);
}

async function handleManagementUnenroll(requestId: string): Promise<void> {
  await clearManagementEnrollment();
  await clearHeartbeatAlarm();
  void syncSiteProtection();
  await handleManagementGetStatus(requestId);
}

async function handleSyncManagedPolicy(force: boolean, requestId: string): Promise<void> {
  await syncManagedPolicy(force);
  await handleManagementGetStatus(requestId);
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

  if (target.strategy === "location" || !target.pattern || !target.flags) {
    notifyPopup({
      type: "POPUP_API_SUBMIT_RESULT",
      requestId,
      success: false,
      error: "This rule type cannot be contributed as a text pattern.",
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
  "SCAN_PROGRESS",
  "SCAN_RESULT_CHUNK",
  "SCAN_RESULT",
  "COPY_REDACTED_TEXT_RESULT",
  "CONTENT_ERROR",
  "CONTENT_GET_NAME_DICTIONARIES",
  "CONTENT_GET_MEDICAL_DICTIONARY",
]);

let cachedMedicalDictionary: { terms: string[] } | null = null;
async function getMedicalDictionaryPayload(): Promise<{ terms: string[] }> {
  if (cachedMedicalDictionary) return cachedMedicalDictionary;
  const resp = await fetch(chrome.runtime.getURL("assets/medical-dictionary.json"));
  if (!resp.ok) throw new Error(`Failed to load medical-dictionary.json (${resp.status})`);
  const parsed = (await resp.json()) as { terms?: unknown };
  cachedMedicalDictionary = {
    terms: Array.isArray(parsed.terms) ? parsed.terms.filter((t): t is string => typeof t === "string") : [],
  };
  return cachedMedicalDictionary;
}

let cachedNameDictionaries: { first: string; last: string } | null = null;
async function getNameDictionariesPayload(): Promise<{ first: string; last: string }> {
  if (cachedNameDictionaries) return cachedNameDictionaries;
  const resp = await fetch(chrome.runtime.getURL("assets/name-dictionaries.json"));
  if (!resp.ok) throw new Error(`Failed to load name-dictionaries.json (${resp.status})`);
  const parsed = (await resp.json()) as { first?: string; last?: string };
  cachedNameDictionaries = {
    first: typeof parsed.first === "string" ? parsed.first : "",
    last: typeof parsed.last === "string" ? parsed.last : "",
  };
  return cachedNameDictionaries;
}

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
  if (type === "POPUP_RECORD_AUDIT") {
    return isTrustedContentScriptSender(sender) || isTrustedExtensionPageSender(sender);
  }
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
    if (startupCleanupError) {
      sendResponse({ ok: false, error: "Local document storage cleanup failed." });
      return;
    }
    switch (msg.type) {
      case "CONTENT_GET_NAME_DICTIONARIES": {
        const payload = await getNameDictionariesPayload();
        sendResponse({ ok: true, ...payload });
        return;
      }
      case "CONTENT_GET_MEDICAL_DICTIONARY": {
        const payload = await getMedicalDictionaryPayload();
        sendResponse({ ok: true, ...payload });
        return;
      }
      case "SCAN_PROGRESS":
      case "SCAN_RESULT_CHUNK":
      case "SCAN_RESULT":
      case "COPY_REDACTED_TEXT_RESULT":
      case "CONTENT_ERROR":
        if (!sender.tab?.id) return;
        if (msg.type === "SCAN_PROGRESS") await handleContentScanProgress(msg, sender.tab.id);
        else if (msg.type === "SCAN_RESULT_CHUNK") await handleContentScanResultChunk(msg, sender.tab.id);
        else if (msg.type === "SCAN_RESULT") await handleContentScanResult(msg, sender.tab.id);
        else if (msg.type === "COPY_REDACTED_TEXT_RESULT") await handleContentCopyResult(msg, sender.tab.id);
        else await handleContentError(msg, sender.tab.id);
        return;
      default:
        break;
    }
    switch (msg.type) {
      case "POPUP_SCAN":
        await handlePopupScan(msg.mode, msg.requestId, msg.tabId);
        break;
      case "POPUP_PIN_TAB":
        await handlePopupPinTab(msg.tabId, msg.pinCurrent, msg.requestId);
        break;
      case "POPUP_APPLY_MASKS":
        await handlePopupApplyMasks(msg.findingIds, msg.requestId, msg.tabId);
        break;
      case "POPUP_REMOVE_MASKS":
        await handlePopupRemoveMasks(msg.requestId, msg.tabId);
        break;
      case "POPUP_COPY_REDACTED":
        await handlePopupCopyRedacted(msg.findingIds, msg.requestId, msg.tabId);
        break;
      case "POPUP_CLEAR_DATA":
        await handlePopupClearData(msg.requestId, msg.tabId);
        break;
      case "POPUP_GET_STATE": {
        notifyPopup({ type: "POPUP_STATE", requestId: msg.requestId, state: await stateForActiveTab(msg.tabId, true) });
        const docSession = await restoreLastSession();
        if (docSession) {
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
        await clearDocSession(msg.docId, msg.fileKey);
        void recordAudit({ ts: new Date().toISOString(), action: "doc_cleared", outcome: "ok" });
        break;
      case "POPUP_DOC_CAPTURE_IMAGE":
        await handlePopupDocCaptureImage(msg.src, msg.name, msg.requestId);
        break;
      case "POPUP_DOC_DELIVERY_REPORT":
        await settleDeliveryAudit(msg.requestId, msg.delivered);
        break;
      case "POPUP_DOC_PRINT": {
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
      case "POPUP_RECORD_AUDIT":
        await handlePopupRecordAudit(msg);
        break;
      case "POPUP_UNDO_MASKS":
        await handlePopupUndoMasks(msg.requestId, msg.tabId);
        break;
      case "POPUP_SET_NOTIFICATIONS": {
        if (msg.enabled) {
          const granted = (await chrome.permissions.request({ permissions: ["notifications"] })) as boolean;
          const settings = await loadSettings();
          const prefs = { ...settings.notificationPrefs, systemEnabled: granted };
          await saveSettings({ ...settings, notificationsEnabled: granted, notificationPrefs: prefs });
          notifyPopup({ type: "POPUP_NOTIFICATIONS_STATE", requestId: msg.requestId, granted });
        } else {
          await chrome.permissions.remove({ permissions: ["notifications"] });
          const settings = await loadSettings();
          const prefs = { ...settings.notificationPrefs, systemEnabled: false };
          await saveSettings({ ...settings, notificationsEnabled: false, notificationPrefs: prefs });
          notifyPopup({ type: "POPUP_NOTIFICATIONS_STATE", requestId: msg.requestId, granted: false });
        }
        break;
      }
      case "POPUP_SET_NOTIFICATION_PREFS": {
        const current = await loadSettings();
        const mergedPrefs = {
          ...current.notificationPrefs,
          ...msg.prefs,
        };
        let granted = await notificationsGranted();
        if (msg.prefs.systemEnabled === true && !granted) {
          try {
            granted = (await chrome.permissions.request({ permissions: ["notifications"] })) as boolean;
            mergedPrefs.systemEnabled = granted;
          } catch {
            mergedPrefs.systemEnabled = false;
          }
        } else if (msg.prefs.systemEnabled === false && granted) {
          try {
            await chrome.permissions.remove({ permissions: ["notifications"] });
            granted = false;
          } catch {
            // ignore
          }
        }
        const updatedSettings: Settings = {
          ...current,
          notificationsEnabled: mergedPrefs.systemEnabled,
          notificationPrefs: mergedPrefs,
        };
        await saveSettings(updatedSettings);
        notifyPopup({
          type: "POPUP_NOTIFICATION_PREFS_STATE",
          requestId: msg.requestId,
          prefs: updatedSettings.notificationPrefs,
          granted,
        });
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
        await cancelDocSession(msg.docId, msg.fileKey);
        void recordAudit({ ts: new Date().toISOString(), action: "doc_cleared", outcome: "ok" });
        break;
      case "POPUP_GET_STAGED_STATS": {
        const stats = await getStagedStorageAudit();
        notifyPopup({
          type: "POPUP_STAGED_STATS_STATE",
          requestId: msg.requestId,
          stats,
        });
        break;
      }
      case "POPUP_PURGE_STAGED_DATA": {
        const purged = await purgeStagedData({
          includeIdleSession: msg.includeIdleSession !== false,
        });
        void recordAudit({ ts: new Date().toISOString(), action: "doc_cleared", outcome: "ok" });
        notifyPopup({
          type: "POPUP_STAGED_STATS_STATE",
          requestId: msg.requestId,
          stats: purged.remaining,
          purged,
        });
        break;
      }
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
      case "POPUP_MANAGEMENT_GET_STATUS":
        await handleManagementGetStatus(msg.requestId);
        break;
      case "POPUP_MANAGEMENT_ENROLL":
        await handleManagementEnroll(msg, msg.requestId);
        break;
      case "POPUP_MANAGEMENT_UNENROLL":
        await handleManagementUnenroll(msg.requestId);
        break;
      case "POPUP_SYNC_MANAGED_POLICY":
        await handleSyncManagedPolicy(Boolean(msg.force), msg.requestId);
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
      sendResponse({ ok: false, error: sanitizeErrorForLog(error) });
    }
  })();
  return true; // async response
});

// Clean up stale sessions for closed tabs and update pinned target state (Task A2 / Decision D2).
chrome.tabs.onRemoved.addListener((tabId) => {
  const pending = pendingScans.get(tabId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingScans.delete(tabId);
  }
  clearPendingChunksForTab(tabId);
  void chrome.storage.session.remove(sessionKey(tabId));
  void (async () => {
    const stored = await readPinnedTarget();
    if (stored && stored.pinnedTabId === tabId) {
      await writePinnedTarget({
        status: "closed",
        pinnedTabId: null,
        closedTitle: stored.title,
        closedDomain: stored.domain,
      });
      const state = await stateForActiveTab();
      notifyPopup({ type: "POPUP_STATE", requestId: "pinned-tab-closed", state });
    } else if (stored) {
      await refreshPinnedTargetInfo();
      const state = await stateForActiveTab();
      notifyPopup({ type: "POPUP_STATE", requestId: "tabs-list-updated", state });
    }
  })().catch(() => undefined);
});
