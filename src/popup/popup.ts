import { sanitizeErrorForLog } from "../shared/errorSanitizer.js";
// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { validateMessage } from "../shared/messages.js";
import { previewObjectUrl } from "../shared/docStore.js";
import { docStoreFile, docDeleteByPrefix, docGetStagedStats, getStagedFileKey, markDocumentStaged, clearStagedMarker } from "../shared/docDb.js";
import type { PurgeStagedDataResult, StagedStorageAudit } from "../shared/types.js";
import {
  ALL_CATEGORIES,
  loadSettings,
  saveSettings,
  resetSettings,
  PRESET_CATEGORIES,
  PRESET_LABELS,
  type PresetId,
  type ProtectionMode,
  type Settings,
  type LanguageCode,
  type FontSizeScale,
  type SessionTimeoutOption,
  DEFAULT_NOTIFICATION_PREFS,
  isNotificationPrivacyMode,
  type NotificationPreferences,
} from "../shared/settings.js";
import {
  loadEnterprisePolicy,
  resolveEffectiveProtection,
  type EffectiveProtection,
} from "../shared/enterprisePolicy.js";
import {
  saveManagementEnrollment,
  clearManagementEnrollment,
  type ManagementEnrollment,
} from "../shared/managedPolicy.js";
import { getInstallationId } from "../api/config.js";
import {
  ALWAYS_ON_ORIGINS,
  describeProtectionState,
  queryAlwaysOnCapability,
  type AlwaysOnCapability,
} from "../shared/siteAccess.js";
import { AUDIT_KEY, recordAudit, type AuditEvent } from "../shared/audit.js";
import {
  DOCUMENT_PIPELINE_UNAVAILABLE_MESSAGE,
  isDocumentPipelineSupported,
} from "../shared/platform.js";
import {
  loadSitePolicies,
  saveSitePolicies,
  saveSitePolicy,
  deleteSitePolicy,
  toggleSitePolicy,
  parseSitePolicy,
  type SitePolicy,
  type PolicyScope,
  type PolicyAction,
} from "../shared/policyStudio.js";
import { evaluateComplianceScore, type ComplianceAction } from "../shared/complianceScore.js";
import { classifyDestination } from "../shared/destinationClassifier.js";
import { BUNDLED_OCR_LANGUAGES } from "../shared/ocrLanguages.js";
import { t, getCategoryLabel, getPresetLabel } from "../shared/i18n.js";
import { MAX_DOC_PAGES, MAX_DOC_BYTES, MAX_DOC_BYTES_LABEL, MAX_DOCX_CHARS, resolvePageWindow, pageWindowLabel } from "../shared/docLimits.js";
import type { AccountView } from "../shared/account.js";
import type {
  DocKind,
  Finding,
  FindingCategory,
  PopupState,
  PopupMessage,
  ScanMode,
  DocPageMeta,
  PopupFromWorker,
  Rect,
  RedactionStyle,
} from "../shared/types.js";
import type { ParsedName } from "../content/detectors/nameParser.js";
import { CURRENT_EXTENSION_VERSION } from "../api/config.js";
import { loadCustomPatterns, saveCustomPatterns, parseCustomPattern, type CustomPattern, type CommunityAccount, type CommunityRule } from "../shared/customPatterns.js";
import { inferLocationRule, type SelectionSample } from "../shared/locationAwareWizard.js";
import { parseSampleLines, type WizardAnalysis } from "../shared/wizardAnalyzer.js";
import type { ImageCandidate } from "../shared/messages.js";

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
 * A tab GovernWorld can actually act on: an identified, ordinary web page.
 * Internal extension pages and the extension's own URLs are never eligible.
 */
export function isScannableTab(tab: chrome.tabs.Tab | undefined): tab is chrome.tabs.Tab {
  if (!tab?.id || !tab.url) return false;
  if (isInternalExtensionUrl(tab.url)) return false;
  return tab.url.startsWith("http://") || tab.url.startsWith("https://");
}

/**
 * Resolve the web page the user is looking at. Only a real web page is ever
 * returned: the earlier version fell back to the focused tab after filtering
 * extension URLs out, so one of our own pages could be returned as a scan
 * target. Callers already treat undefined as "nothing to act on".
 */
export async function getActiveWebTab(): Promise<chrome.tabs.Tab | undefined> {
  const [focusedTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (isScannableTab(focusedTab)) {
    return focusedTab;
  }
  const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (isScannableTab(currentTab)) {
    return currentTab;
  }
  const allTabs = await chrome.tabs.query({});
  return allTabs.find((t) => t.active && isScannableTab(t));
}

export async function ensureContentScriptReady(tabId: number): Promise<boolean> {
  try {
    const response = (await chrome.tabs.sendMessage(tabId, { type: "PING" })) as { ok?: boolean } | undefined;
    if (response?.ok) return true;
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      await new Promise((resolve) => setTimeout(resolve, 80));
      return true;
    } catch (error) {
      console.warn(`[governworld] Unable to dynamically inject content script on tab ${tabId}:`, sanitizeErrorForLog(error));
      return false;
    }
  }
  return false;
}


export let currentLang: LanguageCode = "en";
export let currentWebTabUrl: string | undefined = undefined;

/**
 * The last scan state seen by the popup.
 *
 * Declared here because both `renderState` and the image-capture flow need it:
 * a capture clears the scan surface, and it has to know which mode was in use
 * to leave the popup in a valid state rather than inventing one.
 */
let lastState: PopupState | null = null;
const pendingStateChunks = new Map<
  string,
  { sessionId: string; totalChunks: number; chunks: Map<number, Finding[]> }
>();

export const CATEGORY_LABELS: Record<string, string> = {
  email: "Email address",
  phone: "US phone number",
  ssn: "Social Security number (SSN / ITIN)",
  dob: "Date of birth",
  medical_record_number: "Medical record number (MRN)",
  member_id: "Member / patient ID",
  npi: "Provider NPI",
  dea: "DEA registration",
  mbi: "Medicare Beneficiary ID (MBI)",
  address: "US street address",
  payment_card: "Payment card (Luhn)",
  secrets: "API keys & secrets",
  possible_name: "Possible name",
  canadian_sin: "Canadian SIN",
  uk_nhs: "UK NHS Number",
  aadhaar: "Indian Aadhaar",
  pan_india: "Indian PAN Card",
  australian_tfn: "Australian TFN",
  cpf: "Brazilian CPF",
  ip_address: "IP address",
  username: "Username / login",
  bank_account: "Bank account / routing number",
  financial: "Salary / compensation",
  custom: "Custom pattern",
};

export const HEALTHCARE_CATEGORIES: FindingCategory[] = [
  "medical_record_number",
  "member_id",
  "npi",
  "dea",
  "mbi",
  "ssn",
  "dob",
  "address",
  "phone",
  "email",
  "possible_name",
  "uk_nhs",
  "ip_address",
];

export const INTERNATIONAL_CATEGORIES: FindingCategory[] = [
  "canadian_sin",
  "uk_nhs",
  "aadhaar",
  "pan_india",
  "australian_tfn",
  "cpf",
  "email",
  "phone",
  "address",
  "dob",
  "possible_name",
  "payment_card",
];

export const FINANCIAL_CATEGORIES: FindingCategory[] = [
  "payment_card",
  "ssn",
  "canadian_sin",
  "pan_india",
  "australian_tfn",
  "cpf",
  "bank_account",
  "financial",
  "address",
  "phone",
  "email",
];

function confidenceLabel(confidence: number): string {
  if (confidence >= 0.9) return "High";
  if (confidence >= 0.7) return "Medium";
  return "Low";
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function requestId(): string {
  return crypto.randomUUID();
}

/**
 * Stage the chosen file for the worker to read.
 *
 * `markDocumentStaged` runs BEFORE the write, not after: the worker's
 * install-time purge empties the whole store, and if it started first it would
 * delete a document the popup had already written. Marking first means the purge
 * sees a staged document and skips, whichever of the two runs first.
 */
async function storeFile(fileKey: string, bytes: ArrayBuffer): Promise<void> {
  await markDocumentStaged(fileKey);
  await docStoreFile(fileKey, bytes);
  void refreshStagedStorageAudit();
}

async function deleteFile(fileKey: string, options?: { keepRedacted?: boolean }): Promise<void> {
  await docDeleteByPrefix(fileKey, options);
  void refreshStagedStorageAudit();
}

function formatStagedByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

let lastStagedStats: StagedStorageAudit = {
  totalKeys: 0,
  totalBytes: 0,
  liveKeys: 0,
  liveBytes: 0,
  orphanKeys: 0,
  orphanBytes: 0,
  hasInFlightJob: false,
};

function renderStagedStorageAudit(stats: StagedStorageAudit, purged?: PurgeStagedDataResult): void {
  lastStagedStats = stats;
  const summaryEl = document.getElementById("doc-staged-summary");
  const confirmMsgEl = document.getElementById("doc-staged-confirm-msg");
  if (summaryEl) {
    summaryEl.setAttribute("data-total-keys", String(stats.totalKeys));
    summaryEl.setAttribute("data-total-bytes", String(stats.totalBytes));
    summaryEl.setAttribute("data-live-keys", String(stats.liveKeys));
    summaryEl.setAttribute("data-orphan-keys", String(stats.orphanKeys));
    if (stats.totalKeys <= 0) {
      summaryEl.textContent = t(currentLang, "doc_staged_zero");
    } else if (stats.liveKeys > 0 && stats.orphanKeys <= 0) {
      summaryEl.textContent = t(currentLang, "doc_staged_live_only", {
        keys: String(stats.totalKeys),
        size: formatStagedByteSize(stats.totalBytes),
      });
    } else if (stats.liveKeys <= 0 && stats.orphanKeys > 0) {
      summaryEl.textContent = t(currentLang, "doc_staged_orphan_only", {
        keys: String(stats.totalKeys),
        size: formatStagedByteSize(stats.totalBytes),
      });
    } else {
      summaryEl.textContent = t(currentLang, "doc_staged_mixed", {
        keys: String(stats.totalKeys),
        size: formatStagedByteSize(stats.totalBytes),
        liveKeys: String(stats.liveKeys),
        liveSize: formatStagedByteSize(stats.liveBytes),
        orphanKeys: String(stats.orphanKeys),
        orphanSize: formatStagedByteSize(stats.orphanBytes),
      });
    }
  }
  if (confirmMsgEl && purged) {
    confirmMsgEl.hidden = false;
    if (purged.remaining.totalKeys <= 0) {
      confirmMsgEl.textContent = t(currentLang, "doc_purge_done_zero", {
        deletedKeys: String(purged.deletedKeys),
        deletedSize: formatStagedByteSize(purged.deletedBytes),
      });
    } else {
      confirmMsgEl.textContent = t(currentLang, "doc_purge_done_live_kept", {
        deletedKeys: String(purged.deletedKeys),
        deletedSize: formatStagedByteSize(purged.deletedBytes),
        liveKeys: String(purged.remaining.liveKeys),
        liveSize: formatStagedByteSize(purged.remaining.liveBytes),
      });
    }
  }
}

async function refreshStagedStorageAudit(): Promise<void> {
  try {
    const [rawStats, stagedMarkerKey] = await Promise.all([
      docGetStagedStats().catch(() => ({ keyCount: 0, totalBytes: 0, byPrefix: {} })),
      getStagedFileKey().catch(() => null),
    ]);
    const liveSet = new Set<string>();
    if (stagedMarkerKey) liveSet.add(stagedMarkerKey);
    let liveKeys = 0;
    let liveBytes = 0;
    let orphanKeys = 0;
    let orphanBytes = 0;
    for (const [prefix, entry] of Object.entries(rawStats.byPrefix)) {
      if (liveSet.has(prefix)) {
        liveKeys += entry.keyCount;
        liveBytes += entry.bytes;
      } else {
        orphanKeys += entry.keyCount;
        orphanBytes += entry.bytes;
      }
    }
    renderStagedStorageAudit({
      totalKeys: rawStats.keyCount,
      totalBytes: rawStats.totalBytes,
      liveKeys,
      liveBytes,
      orphanKeys,
      orphanBytes,
      hasInFlightJob: false,
    });
  } catch {
    // best-effort local snapshot before SW authoritative response
  }
  void sendMessage({
    type: "POPUP_GET_STAGED_STATS",
    requestId: requestId(),
  }).catch(() => undefined);
}

/** Web Speech API Speech Synthesis and Screen Reader Live Region for audio announcements */
export function speakAnnouncement(text: string, settings?: Settings): void {
  // Update dedicated ARIA live region for screen reader accessibility
  let liveRegion = document.getElementById("sr-announcements");
  if (!liveRegion) {
    liveRegion = document.createElement("div");
    liveRegion.id = "sr-announcements";
    liveRegion.className = "visually-hidden";
    liveRegion.setAttribute("role", "status");
    liveRegion.setAttribute("aria-live", "polite");
    liveRegion.setAttribute("aria-atomic", "true");
    document.body.appendChild(liveRegion);
  }
  liveRegion.textContent = "";
  liveRegion.textContent = text;

  if (!settings?.speechAnnouncements) return;
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const langMap: Record<LanguageCode, string> = {
      en: "en-US",
      es: "es-ES",
      fr: "fr-FR",
      de: "de-DE",
      ja: "ja-JP",
      pt: "pt-BR",
      zh: "zh-CN",
    };
    utterance.lang = langMap[settings.language] || "en-US";
    utterance.rate = 1.0;
    window.speechSynthesis.speak(utterance);
  } catch {
    // Non-blocking catch
  }
}

export function applyUiLanguage(lang: LanguageCode): void {
  currentLang = lang;
  // Kept in sync so a synchronous renderer (the account surface) reads the same
  // language instead of falling back to English.
  uiLanguage = lang;
  document.documentElement.lang = lang;
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((element) => {
    const key = element.getAttribute("data-i18n");
    if (key) {
      element.textContent = t(lang, key);
    }
  });
  document.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((element) => {
    const key = element.getAttribute("data-i18n-title");
    if (key) {
      element.title = t(lang, key);
    }
  });
  document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-i18n-placeholder]").forEach((element) => {
    const key = element.getAttribute("data-i18n-placeholder");
    if (key) {
      element.placeholder = t(lang, key);
    }
  });
  document.querySelectorAll<HTMLElement>("[data-i18n-aria-label]").forEach((element) => {
    const key = element.getAttribute("data-i18n-aria-label");
    if (key) {
      element.setAttribute("aria-label", t(lang, key));
    }
  });

  const presetSelect = document.getElementById("preset-select") as HTMLSelectElement | null;
  if (presetSelect) {
    Array.from(presetSelect.options).forEach((opt) => {
      opt.textContent = getPresetLabel(lang, opt.value);
    });
  }
}

export function applyAccessibilitySettings(settings: Settings): void {
  const root = document.documentElement;
  const body = document.body;

  root.setAttribute("data-font-size", settings.fontSize);
  body.setAttribute("data-font-size", settings.fontSize);

  root.setAttribute("data-high-contrast", String(settings.highContrast));
  body.setAttribute("data-high-contrast", String(settings.highContrast));

  root.setAttribute("data-dyslexia", String(settings.dyslexiaMode));
  body.setAttribute("data-dyslexia", String(settings.dyslexiaMode));

  root.setAttribute("data-reduced-motion", String(settings.reducedMotion));
  body.setAttribute("data-reduced-motion", String(settings.reducedMotion));

  // Handle Verbose ARIA Mode
  const scanBtn = document.getElementById("scan-btn");
  const applyMasksBtn = document.getElementById("apply-masks-btn");
  const docDropzone = document.getElementById("doc-dropzone");
  const docRedactBtn = document.getElementById("doc-redact-btn");

  if (settings.ariaVerboseMode) {
    scanBtn?.setAttribute(
      "aria-label",
      "Scan current webpage for protected health information, financial data, and personal identifiers"
    );
    applyMasksBtn?.setAttribute(
      "aria-label",
      "Applies non-destructive visual privacy overlays over sensitive text on the active page"
    );
    docDropzone?.setAttribute(
      "aria-label",
      "Upload PDF, Word document, or image to redact sensitive data locally with pixel-level verification"
    );
    docRedactBtn?.setAttribute(
      "aria-label",
      "Permanently redacts selected sensitive findings into a flattened downloadable file copy"
    );
  } else {
    scanBtn?.setAttribute("aria-label", "Scan Page (Alt+Shift+S)");
    applyMasksBtn?.setAttribute("aria-label", "Apply selected masks");
    docDropzone?.setAttribute("aria-label", "Document upload dropzone");
    docRedactBtn?.setAttribute("aria-label", "Redact selected and download");
  }
}

export async function renderCategories(settings: {
  enabledCategories: FindingCategory[];
  lockedCategories?: FindingCategory[];
  language?: LanguageCode;
}): Promise<void> {
  const list = document.getElementById("category-list") as HTMLFieldSetElement | null;
  if (!list) return;
  const lang = settings.language || currentLang || "en";
  const locked = new Set<FindingCategory>(settings.lockedCategories ?? []);
  // The sidepanel transform moves the "Protection Categories" heading into a
  // <legend> inside this fieldset. replaceChildren() would delete it and leave
  // the generated sidepanel with an unlabelled checkbox group.
  const legend = list.querySelector(":scope > legend");
  list.replaceChildren();
  if (legend) list.appendChild(legend);
  for (const category of ALL_CATEGORIES) {
    const label = el("label");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.value = category;
    check.checked = settings.enabledCategories.includes(category);
    check.setAttribute("role", "switch");
    check.setAttribute("aria-checked", check.checked ? "true" : "false");
    if (locked.has(category)) {
      // Admin-mandated: visible but not switchable. Enforcement does not rely
      // on this attribute — the change handler below re-adds locked
      // categories and the content guard merges them independently.
      check.disabled = true;
      check.title = t(lang, "managed_lock_notice");
    }
    const span = el("span", undefined, getCategoryLabel(lang, category));
    label.append(check, span);
    check.addEventListener("change", async () => {
      if (check.disabled) {
        check.checked = true;
        return;
      }
      check.setAttribute("aria-checked", check.checked ? "true" : "false");
      const current = await loadSettings();
      const priorPreset = presetForCategories(current.enabledCategories);
      const set = new Set(current.enabledCategories);
      if (check.checked) set.add(category);
      else set.delete(category);
      // A locked category can never be removed, even programmatically.
      for (const mandated of (await loadEnterprisePolicy()).enforcedCategories) set.add(mandated);
      const next = ALL_CATEGORIES.filter((c) => set.has(c));
      await saveSettings({ ...current, enabledCategories: next });
      await renderCategories({ enabledCategories: next, language: current.language });
      if (priorPreset !== "custom") {
        await recordAudit({
          ts: new Date().toISOString(),
          action: "preset_overridden",
          presetId: priorPreset,
          enabledCategories: next,
          outcome: "ok",
        });
      }
    });
    list.appendChild(label);
  }
  updatePresetSelector(settings.enabledCategories);

  const thresholdCatSelect = document.getElementById("threshold-category-select") as HTMLSelectElement | null;
  const thresholdValSelect = document.getElementById("threshold-value-select") as HTMLSelectElement | null;
  if (thresholdCatSelect) {
    const prevCat = (thresholdCatSelect.value as FindingCategory) || "email";
    thresholdCatSelect.replaceChildren();
    for (const category of ALL_CATEGORIES) {
      const opt = document.createElement("option");
      opt.value = category;
      opt.textContent = getCategoryLabel(lang, category);
      thresholdCatSelect.appendChild(opt);
    }
    thresholdCatSelect.value = ALL_CATEGORIES.includes(prevCat) ? prevCat : "email";
    if (thresholdValSelect) {
      const storedSettings = await loadSettings();
      const currentThresh = storedSettings.confidenceThresholds[thresholdCatSelect.value as FindingCategory] ?? 0;
      thresholdValSelect.value = String(currentThresh);
    }
  }
}

/** The preset whose category set exactly matches the given set, else "custom". */
export function presetForCategories(enabledCategories: FindingCategory[]): PresetId {
  let matchedPreset: PresetId = "custom";
  for (const [presetId, categories] of Object.entries(PRESET_CATEGORIES)) {
    const presetSet = new Set(categories);
    const enabledSet = new Set(enabledCategories);
    if (presetSet.size === enabledSet.size && [...presetSet].every((c) => enabledSet.has(c))) {
      matchedPreset = presetId as PresetId;
      break;
    }
  }
  return matchedPreset;
}

function updatePresetSelector(enabledCategories: FindingCategory[]): void {
  const select = document.getElementById("preset-select") as HTMLSelectElement | null;
  if (!select) return;
  select.value = presetForCategories(enabledCategories);
}

export async function applyPreset(presetId: PresetId): Promise<void> {
  if (presetId === "custom") return;
  const categories = PRESET_CATEGORIES[presetId];
  if (!categories) return;
  const current = await loadSettings();
  const previousPreset = presetForCategories(current.enabledCategories);
  // Admin-mandated categories survive preset switches.
  const enforced = (await loadEnterprisePolicy()).enforcedCategories;
  const merged = ALL_CATEGORIES.filter((c) => categories.includes(c) || enforced.includes(c));
  await saveSettings({ ...current, enabledCategories: merged });
  await renderCategories({ enabledCategories: merged, language: current.language });
  if (previousPreset !== presetId) {
    await recordAudit({
      ts: new Date().toISOString(),
      action: "preset_applied",
      presetId,
      enabledCategories: merged,
      outcome: "ok",
    });
  }
}

export async function applyCategoryFilter(categories: FindingCategory[]): Promise<void> {
  const current = await loadSettings();
  const valid = ALL_CATEGORIES.filter((c) => categories.includes(c));
  const enforced = (await loadEnterprisePolicy()).enforcedCategories;
  const merged = ALL_CATEGORIES.filter((c) => valid.includes(c) || enforced.includes(c));
  await saveSettings({ ...current, enabledCategories: merged });
  await renderCategories({ enabledCategories: merged, language: current.language });
}

function updateComplianceScorecard(
  cardEl: HTMLElement | null,
  scoreEl: HTMLElement | null,
  bandEl: HTMLElement | null,
  actionEl: HTMLElement | null,
  reasonEl: HTMLElement | null,
  rulesEl: HTMLElement | null,
  findings: Array<{ category: string; confidence?: number; preview?: string; count?: number }>,
  url?: string,
  action: ComplianceAction = "view"
): void {
  if (!cardEl || !scoreEl || !bandEl || !actionEl || !reasonEl || !rulesEl) return;
  if (!findings || findings.length === 0) {
    cardEl.hidden = true;
    return;
  }

  const destination = classifyDestination(url);
  const evaluation = evaluateComplianceScore(
    findings.map((f: any) => ({ category: f.entityType || f.category, confidence: f.confidence, value: f.preview })),
    destination,
    action
  );

  cardEl.hidden = false;
  scoreEl.textContent = String(evaluation.riskScore);

  bandEl.textContent = evaluation.riskBand;
  bandEl.className = "compliance-card__band";
  if (evaluation.riskBand === "CRITICAL") {
    bandEl.classList.add("compliance-card__band--critical");
  } else if (evaluation.riskBand === "HIGH") {
    bandEl.classList.add("compliance-card__band--high");
  } else if (evaluation.riskBand === "MEDIUM") {
    bandEl.classList.add("compliance-card__band--medium");
  } else if (evaluation.riskBand === "LOW") {
    bandEl.classList.add("compliance-card__band--low");
  } else {
    bandEl.classList.add("compliance-card__band--informational");
  }

  actionEl.textContent = `Action: ${evaluation.decision}`;
  reasonEl.textContent = evaluation.reason;

  rulesEl.replaceChildren();
  for (const rule of evaluation.factors.appliedRules) {
    const pill = document.createElement("span");
    pill.className = "compliance-card__rule-pill";
    pill.textContent = rule;
    rulesEl.appendChild(pill);
  }
  if (evaluation.factors.aiLeakageTriggered) {
    const pill = document.createElement("span");
    pill.className = "compliance-card__rule-pill";
    pill.textContent = "AI Leakage Rule";
    rulesEl.appendChild(pill);
  }
  if (destination.isAi) {
    const pill = document.createElement("span");
    pill.className = "compliance-card__rule-pill";
    pill.textContent = `AI: ${destination.serviceName || destination.hostname}`;
    rulesEl.appendChild(pill);
  } else if (destination.category === "TRUSTED_INTERNAL") {
    const pill = document.createElement("span");
    pill.className = "compliance-card__rule-pill";
    pill.textContent = `EHR: ${destination.serviceName || destination.hostname}`;
    rulesEl.appendChild(pill);
  }
}

function nameDetailText(p: ParsedName): string {
  const parts: string[] = [];
  if (p.prefix) parts.push(`Title: ${p.prefix}`);
  if (p.first) parts.push(`First: ${p.first}`);
  if (p.middle.length) parts.push(`Middle: ${p.middle.join(", ")}`);
  if (p.last) parts.push(`Last: ${p.last}`);
  if (p.suffix) parts.push(`Suffix: ${p.suffix}`);
  if (p.credentials.length) parts.push(`Credentials: ${p.credentials.join(", ")}`);
  if (p.gender) parts.push(`Gender: ${p.gender}`);
  if (p.age != null) parts.push(`Age: ${p.age}`);
  if (p.dob) parts.push(`DOB: ${p.dob}`);
  return parts.join(" · ");
}

export function renderFindings(findings: Finding[]): void {
  const list = document.getElementById("findings-list") as HTMLUListElement | null;
  const count = document.getElementById("results-count") as HTMLSpanElement | null;
  const applyBtn = document.getElementById("apply-masks-btn") as HTMLButtonElement | null;
  if (!list || !count || !applyBtn) return;
  list.replaceChildren();
  count.textContent = t(currentLang, "findings_detected_count", { count: findings.length });
  let selected = 0;
  let selectable = 0;
  for (const finding of findings) {
    const reportOnly = finding.source === "attr";
    if (!reportOnly) selectable += 1;
    if (finding.selected) selected += 1;
    const item = el("li", "finding");
    if (reportOnly) item.classList.add("finding--report-only");
    let check: HTMLInputElement | null = null;
    if (!reportOnly) {
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "finding__check";
      checkbox.value = finding.id;
      checkbox.checked = finding.selected;
      checkbox.setAttribute("aria-checked", finding.selected ? "true" : "false");
      checkbox.setAttribute("aria-label", `Select ${getCategoryLabel(currentLang, finding.category)} finding`);
      checkbox.addEventListener("change", () => {
        checkbox.setAttribute("aria-checked", checkbox.checked ? "true" : "false");
        const checked = [...list.querySelectorAll("input[type='checkbox']:checked")].map(
          (c) => (c as HTMLInputElement).value
        );
        void sendMessage({ type: "POPUP_APPLY_MASKS", requestId: requestId(), findingIds: checked });
      });
      check = checkbox;
    }

    const main = el("div", "finding__main");
    const head = el("div", "finding__head");
    const category = el("div", "finding__category", getCategoryLabel(currentLang, finding.category));
    head.append(category);
    if (finding.entityType && finding.entityType !== finding.category) {
      const entityBadge = el("span", "finding__badge-attr", finding.entityType.toUpperCase());
      head.append(entityBadge);
    }
    if (reportOnly) {
      const attrBadge = el(
        "span",
        "finding__badge-attr",
        `Attribute${finding.attribute ? ` · ${finding.attribute}` : ""} — report only`
      );
      head.append(attrBadge);
    } else {
      const severity = el("span", "finding__severity", confidenceLabel(finding.confidence));
      severity.dataset.level = confidenceLabel(finding.confidence).toLowerCase();
      head.append(severity);
    }
    const preview = el("div", "finding__preview", finding.preview);
    const meta = el("div", "finding__meta");
    const confidence = el("span", "finding__confidence", `${Math.round(finding.confidence * 100)}% confidence`);
    meta.append(confidence);
    if (finding.contextPreview) {
      const ctxSpan = el("span", "finding__confidence", `Context: ${finding.contextPreview}`);
      meta.append(ctxSpan);
    }
    if (finding.category === "possible_name" && finding.parsedName) {
      const detail = el("div", "finding__name-detail", nameDetailText(finding.parsedName));
      meta.append(detail);
    }
    main.append(head, preview, meta);

    if (check) item.append(check, main);
    else {
      main.style.paddingLeft = "0";
      item.append(main);
    }
    list.appendChild(item);
  }
  if (selected > 0) {
    applyBtn.textContent = `${t(currentLang, "apply_masks_btn")} (${selected})`;
  } else {
    applyBtn.textContent = t(currentLang, "apply_masks_btn");
  }
  const hasFindings = findings.length > 0;
  const toggleAllBtn = document.getElementById("toggle-all-findings-btn") as HTMLButtonElement | null;
  const exportFindingsBtn = document.getElementById("export-findings-btn") as HTMLButtonElement | null;
  const undoMasksBtn = document.getElementById("undo-masks-btn") as HTMLButtonElement | null;
  const removeMasksBtn = document.getElementById("remove-masks-btn") as HTMLButtonElement | null;
  const copyBtn = document.getElementById("copy-redacted-btn") as HTMLButtonElement | null;
  const exportMenu = document.getElementById("export-format-menu") as HTMLElement | null;
  if (toggleAllBtn) toggleAllBtn.disabled = selectable === 0;
  if (exportFindingsBtn) exportFindingsBtn.disabled = !hasFindings;
  applyBtn.disabled = !hasFindings || selected === 0;
  if (undoMasksBtn) undoMasksBtn.disabled = !hasFindings;
  if (removeMasksBtn) removeMasksBtn.disabled = !hasFindings;
  if (copyBtn) copyBtn.disabled = !hasFindings || selected === 0;
  if (!hasFindings && exportMenu) exportMenu.hidden = true;
}

/**
 * Offer the page's images to the Document Studio when a scan read no text.
 *
 * A page that is an image has nothing to scan, and the honest report is
 * "nothing to read" - but that alone is a dead end, because the document the
 * user cares about is right there in pixels and OCR already exists. Each image
 * becomes a button that hands the file to the studio, where the ordinary
 * review, redaction and download flow applies unchanged.
 *
 * The colour states the honest limit: green means the original file will be
 * read at full resolution, amber means only a rendered capture is possible, so
 * what is scanned is bounded by the viewport and the current zoom. A user
 * redactioning a scan needs to know which one they are getting.
 */
function renderImageCapture(candidates: ImageCandidate[] | undefined): void {
  const panel = document.getElementById("image-capture") as HTMLElement | null;
  const options = document.getElementById("image-capture-options") as HTMLElement | null;
  if (!panel || !options) return;
  if (!candidates || candidates.length === 0) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  options.textContent = "";
  for (const candidate of candidates) {
    // A same-origin image can be read directly. A cross-origin one cannot,
    // because the extension holds no host permissions, so it falls back to
    // capturing the page - and the button says so rather than implying the
    // original is being read.
    const fullResolution = candidate.sameOrigin;
    const button = document.createElement("button");
    button.type = "button";
    // Assigned rather than templated: the DOM contract test discovers
    // runtime-created classes by scanning this file for literals, and a
    // template literal hides the two variants from it.
    const qualityClass = fullResolution ? "image-capture__btn--ok" : "image-capture__btn--warn";
    button.className = "image-capture__btn " + qualityClass;
    button.setAttribute(
      "aria-label",
      `${t(currentLang, fullResolution ? "image_capture_full" : "image_capture_screen")}: ${candidate.width}x${candidate.height}`
    );

    const badge = document.createElement("span");
    badge.className = "image-capture__badge";
    badge.textContent = t(currentLang, fullResolution ? "image_capture_full" : "image_capture_screen");

    const size = document.createElement("span");
    size.className = "image-capture__size";
    size.textContent = `${candidate.width}x${candidate.height}`;

    button.append(badge, size);
    if (!fullResolution) {
      const note = document.createElement("span");
      note.className = "footnote";
      note.textContent = t(currentLang, "image_capture_capture_note");
      button.append(note);
    }
    button.addEventListener("click", () => {
      void startImageCapture(candidate);
    });
    options.append(button);
  }
}

async function startImageCapture(candidate: ImageCandidate): Promise<void> {
  // Capture opens the Document Studio, so the panel and any scan results are
  // cleared first: leaving a "0 findings, scan complete" summary above a
  // document under review would be exactly the confusing overlap this feature
  // exists to remove.
  clearDocUi();
  setDocStatus(t(currentLang, "doc_processing"), false);
  showDocProgress();
  lastState = null;
  renderState(clearScanStateForCapture());
  try {
    await sendDocMessage({
      type: "POPUP_DOC_CAPTURE_IMAGE",
      requestId: requestId(),
      src: candidate.src,
      name: "page-image.png",
    });
  } catch {
    // sendDocMessage has already surfaced the failure in the status line.
  }
}

/** Reset the scan surface so a capture starts from a clean, honest state. */
function clearScanStateForCapture(): PopupState {
  return {
    mode: lastState?.mode ?? "local",
    scanning: false,
    findings: [],
    scanned: false,
    truncated: false,
    visibleChars: 0,
    consentRequired: false,
  };
}

/** True when a completed scan read no text, which is the only case that offers capture. */
function nothingToReadOrAbsent(state: PopupState): boolean {
  return !state.scanned || state.visibleChars === 0 || (state.visibleChars < 300 && state.findings.length === 0);
}

let lastAccountView: AccountView | null = null;
let lastOperatingMode: "LOCAL" | "MANAGE" = "LOCAL";

function createProfileSilhouetteSvg(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2");
  const circle = document.createElementNS(ns, "circle");
  circle.setAttribute("cx", "12");
  circle.setAttribute("cy", "7");
  circle.setAttribute("r", "4");
  svg.append(path, circle);
  return svg;
}

function syncProfilePopoverSummary(): void {
  const lang = currentLang;
  const view = lastAccountView;
  const connected = view?.connected === true;
  const isManaged = lastOperatingMode === "MANAGE";
  const badge = document.getElementById("mode-badge") as HTMLSpanElement | null;
  const avatarBtn = document.getElementById("profile-avatar-btn");
  const avatarInitials = document.getElementById("profile-avatar-initials");
  const popoverAvatar = document.getElementById("profile-popover-avatar");
  const popoverName = document.getElementById("profile-popover-name");
  const popoverSubtitle = document.getElementById("profile-popover-subtitle");
  const popoverMode = document.getElementById("profile-popover-mode");

  if (badge) {
    if (isManaged) {
      badge.textContent = "MANAGE";
      badge.classList.add("badge--managed");
      badge.classList.remove("badge--cloud");
    } else {
      badge.textContent = "LOCAL";
      badge.classList.remove("badge--managed");
      badge.classList.remove("badge--cloud");
    }
  }

  if (connected && view?.userEmail) {
    const initials = view.userEmail.slice(0, 2).toUpperCase();
    const modeAttr = isManaged ? "managed" : "linked";
    if (avatarInitials) avatarInitials.textContent = initials;
    if (popoverAvatar) {
      popoverAvatar.textContent = initials;
      popoverAvatar.dataset.mode = modeAttr;
    }
    if (popoverName) popoverName.textContent = view.userEmail;
    if (popoverSubtitle) popoverSubtitle.textContent = view.tenantName ?? view.tenantId ?? t(lang, "profile_linked_workspace");
    if (popoverMode) {
      popoverMode.textContent = isManaged ? t(lang, "profile_mode_managed") : t(lang, "profile_mode_linked");
      popoverMode.dataset.mode = modeAttr;
    }
    avatarBtn?.classList.add("profile-avatar-btn--linked");
    avatarBtn?.classList.toggle("profile-avatar-btn--managed", isManaged);
    avatarBtn?.classList.remove("profile-avatar-btn--local");
  } else if (isManaged) {
    if (avatarInitials) avatarInitials.replaceChildren(createProfileSilhouetteSvg());
    if (popoverAvatar) {
      popoverAvatar.textContent = "M";
      popoverAvatar.dataset.mode = "managed";
    }
    if (popoverName) popoverName.textContent = t(lang, "profile_managed_title");
    if (popoverSubtitle) popoverSubtitle.textContent = t(lang, "profile_managed_subtitle");
    if (popoverMode) {
      popoverMode.textContent = t(lang, "profile_mode_managed");
      popoverMode.dataset.mode = "managed";
    }
    avatarBtn?.classList.remove("profile-avatar-btn--linked");
    avatarBtn?.classList.remove("profile-avatar-btn--local");
    avatarBtn?.classList.add("profile-avatar-btn--managed");
  } else {
    if (avatarInitials) avatarInitials.replaceChildren(createProfileSilhouetteSvg());
    if (popoverAvatar) {
      popoverAvatar.textContent = "L";
      popoverAvatar.dataset.mode = "local";
    }
    if (popoverName) popoverName.textContent = t(lang, "profile_local_title");
    if (popoverSubtitle) popoverSubtitle.textContent = t(lang, "profile_local_subtitle");
    if (popoverMode) {
      popoverMode.textContent = t(lang, "profile_mode_local");
      popoverMode.dataset.mode = "local";
    }
    avatarBtn?.classList.remove("profile-avatar-btn--linked");
    avatarBtn?.classList.remove("profile-avatar-btn--managed");
    avatarBtn?.classList.add("profile-avatar-btn--local");
  }
}

function renderState(state: PopupState): void {
  const status = document.getElementById("status") as HTMLParagraphElement | null;
  const scanBtn = document.getElementById("scan-btn") as HTMLButtonElement | null;
  const resultsSection = document.getElementById("results-section") as HTMLElement | null;
  const cloudNotice = document.getElementById("cloud-notice") as HTMLParagraphElement | null;
  const summary = document.getElementById("scan-summary") as HTMLElement | null;
  const summaryChars = document.getElementById("summary-chars") as HTMLElement | null;

  lastOperatingMode = state.operatingMode === "MANAGE" ? "MANAGE" : "LOCAL";
  syncProfilePopoverSummary();

  const liveScanVal = document.getElementById("live-scan-value");
  if (liveScanVal) {
    if (state.scanning) {
      liveScanVal.textContent = t(currentLang, "status_val_scanning");
      liveScanVal.setAttribute("data-tone", "warn");
    } else if (state.error) {
      liveScanVal.textContent = t(currentLang, "status_val_check_page");
      liveScanVal.setAttribute("data-tone", "warn");
    } else if (state.scanned) {
      if (state.findings.length > 0) {
        liveScanVal.textContent = t(currentLang, "status_val_found", { count: state.findings.length });
        liveScanVal.setAttribute("data-tone", "warn");
      } else {
        liveScanVal.textContent = t(currentLang, "status_val_clean");
        liveScanVal.removeAttribute("data-tone");
      }
    } else {
      liveScanVal.textContent = t(currentLang, "status_val_ready");
      liveScanVal.setAttribute("data-tone", "muted");
    }
  }
  if (scanBtn) {
    scanBtn.disabled = state.scanning;
    scanBtn.textContent = state.scanning ? t(currentLang, "scanning_btn") : t(currentLang, "scan_page_btn");
  }

  if (summary && status && summaryChars) {
    summary.hidden = !(state.scanning || state.scanned || Boolean(state.error));
    if (state.error) {
      status.textContent = state.error.userMessage;
      status.classList.add("status--error");
      summaryChars.textContent = "";
    } else if (state.scanning) {
      status.textContent = t(currentLang, "status_scanning_text");
      status.classList.remove("status--error");
      summaryChars.textContent = "";
    } else if (state.scanned) {
      summaryChars.textContent = t(currentLang, "status_chars_analyzed", { count: state.visibleChars.toLocaleString() });
      // A scan that examined no text at all must not be reported as a success.
      // The overwhelmingly common cause is a page that *is* an image - a
      // letterhead scan, a rendered PDF, a screenshot - where the only text on
      // the page is inside pixels, so textContent is legitimately empty. Saying
      // "Completed securely on-device" there reads as a clean bill of health for
      // a document full of PII, and the user has no way to guess that "0
      // characters" means "nothing was checked". Point them at OCR instead.
      const nothingToRead = state.visibleChars === 0;
      const hasCoverageWarnings = Boolean(state.coverageWarnings && state.coverageWarnings.length > 0);
      status.textContent = nothingToRead
        ? t(currentLang, "status_no_text_found")
        : state.truncated || hasCoverageWarnings
          ? t(currentLang, "status_partial_results")
          : t(currentLang, "status_completed_securely");
      status.classList.toggle("status--error", nothingToRead);
    } else {
      status.textContent = "";
      status.classList.remove("status--error");
    }
    // The offer only makes sense when there is genuinely nothing to read and
    // the page actually has an image worth lifting. A page with real text keeps
    // its normal results and no capture panel.
    renderImageCapture(nothingToReadOrAbsent(state) ? state.imageCandidates : undefined);
  } else {
    // The summary itself is collapsed (clearing a session, or a capture handing
    // over to the Document Studio), so the capture panel must go with it rather
    // than lingering with stale dimensions.
    renderImageCapture(undefined);
  }

  if (resultsSection) {
    const showResults = state.scanned && state.findings.length > 0;
    resultsSection.hidden = !showResults;
    if (showResults) {
      renderFindings(state.findings);
      updateComplianceScorecard(
        document.getElementById("scan-compliance-card"),
        document.getElementById("scan-compliance-score"),
        document.getElementById("scan-compliance-band"),
        document.getElementById("scan-compliance-action"),
        document.getElementById("scan-compliance-reason"),
        document.getElementById("scan-compliance-rules"),
        state.findings,
        currentWebTabUrl,
        "view"
      );
    } else {
      renderFindings([]);
      const card = document.getElementById("scan-compliance-card");
      if (card) card.hidden = true;
      const exportMenu = document.getElementById("export-format-menu") as HTMLElement | null;
      if (exportMenu) exportMenu.hidden = true;
    }
  }

  if (cloudNotice) {
    cloudNotice.hidden = state.mode !== "cloud" || !state.consentRequired;
    if (!cloudNotice.hidden) {
      cloudNotice.textContent = t(currentLang, "cloud_notice_text");
    }
  }

  const localRadio = document.getElementById("mode-local") as HTMLInputElement | null;
  const cloudRadio = document.getElementById("mode-cloud") as HTMLInputElement | null;
  if (localRadio && localRadio.checked !== (state.mode === "local")) localRadio.checked = state.mode === "local";
  if (cloudRadio && cloudRadio.checked !== (state.mode === "cloud")) cloudRadio.checked = state.mode === "cloud";

  renderCoverage(state);
  void refreshReviewTelemetry(state);
}

async function refreshReviewTelemetry(currentState?: PopupState | null): Promise<void> {
  const findingsCountEl = document.getElementById("review-findings-count");
  const protectedCountEl = document.getElementById("review-protected-count");
  const pagesCountEl = document.getElementById("review-pages-count");
  const activityEmpty = document.getElementById("activity-empty");
  const activityList = document.getElementById("activity-list");

  let events: AuditEvent[] = [];
  try {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      const stored = (await chrome.storage.local.get(AUDIT_KEY)) as Record<string, unknown>;
      const raw = stored?.[AUDIT_KEY];
      if (Array.isArray(raw)) {
        events = raw.filter((e): e is AuditEvent => Boolean(e && typeof e === "object" && "action" in e));
      }
    }
  } catch {
    // Ignore storage read errors in restricted unit-test contexts
  }

  const sumCounts = (counts?: Record<string, number>): number =>
    counts ? Object.values(counts).reduce((acc, n) => acc + (typeof n === "number" ? n : 0), 0) : 0;

  let totalFindings = 0;
  let totalProtected = 0;
  let totalPages = 0;

  for (const ev of events) {
    const count = sumCounts(ev.counts);
    if (ev.action === "page_scan_completed") {
      totalFindings += count;
      totalPages += 1;
    } else if (ev.action === "doc_previewed") {
      totalFindings += count;
      totalPages += ev.pages ?? 1;
    } else if (
      ev.action === "masks_applied" ||
      ev.action === "selection_redacted" ||
      ev.action === "selection_masked" ||
      ev.action === "doc_redacted" ||
      ev.action === "policy_enforced"
    ) {
      totalProtected += Math.max(count, ev.action === "doc_redacted" ? 1 : 0);
      if (ev.action === "doc_redacted") totalPages += ev.pages ?? 1;
    }
  }

  const stateToUse = currentState ?? lastState;
  if (events.length === 0 && stateToUse?.scanned) {
    totalFindings = stateToUse.findings.length;
    totalPages = 1;
  }

  if (findingsCountEl) findingsCountEl.textContent = String(totalFindings);
  if (protectedCountEl) protectedCountEl.textContent = String(totalProtected);
  if (pagesCountEl) pagesCountEl.textContent = String(totalPages);

  if (activityList && activityEmpty) {
    activityList.replaceChildren();
    const recent = [...events].reverse().slice(0, 12);
    activityEmpty.hidden = recent.length > 0;
    const actionKeys: Record<string, string> = {
      page_scan_completed: "activity_action_page_scan_completed",
      masks_applied: "activity_action_masks_applied",
      masks_removed: "activity_action_masks_removed",
      selection_redacted: "activity_action_selection_redacted",
      selection_masked: "activity_action_selection_masked",
      doc_previewed: "activity_action_doc_previewed",
      doc_redacted: "activity_action_doc_redacted",
      doc_cleared: "activity_action_doc_cleared",
      session_cleared: "activity_action_session_cleared",
      preset_applied: "activity_action_preset_applied",
      preset_overridden: "activity_action_preset_overridden",
      account_linked: "activity_action_account_linked",
      policy_created: "activity_action_policy_created",
      policy_deleted: "activity_action_policy_deleted",
      policy_enforced: "activity_action_policy_enforced",
    };

    for (const ev of recent) {
      const li = document.createElement("li");
      li.className = "activity-item";

      const main = document.createElement("div");
      main.className = "activity-item__main";

      const title = document.createElement("span");
      title.className = "activity-item__title";
      const key = actionKeys[ev.action];
      title.textContent = key ? t(currentLang, key) : ev.action;

      const meta = document.createElement("span");
      meta.className = "activity-item__meta";
      const timeStr = ev.ts ? new Date(ev.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
      const parts = [ev.host, ev.pages ? `${ev.pages}p` : "", timeStr].filter(Boolean);
      meta.textContent = parts.join(" · ");

      main.append(title, meta);

      const badge = document.createElement("span");
      badge.className = "count-badge";
      const n = sumCounts(ev.counts);
      badge.textContent = n > 0 ? String(n) : ev.outcome.toUpperCase();

      li.append(main, badge);
      activityList.appendChild(li);
    }
  }
}

/**
 * Report what the scan actually inspected.
 *
 * The panel previously shipped five hardcoded green ticks that no code ever
 * updated: a page with a cross-origin frame, a DRM video or a truncated DOM
 * showed the same "everything covered" panel as a fully clean scan. The worker
 * computes an honest `coverageStatus`; this is where it becomes visible.
 *
 * Only `FULLY_SCANNED` and `NO_SENSITIVE_DATA_DETECTED` are green. Everything
 * else is amber or red, because "we could not read some of this" and "this is
 * clean" are different claims and only one of them is safe to imply.
 */
function renderCoverage(state: PopupState): void {
  const el = document.getElementById("coverage-status");
  const deferred = document.getElementById("coverage-deferred");
  const scanCoverageEl = document.getElementById("scan-coverage-statement");
  const windowsDetailEl = document.getElementById("coverage-windows-detail");
  const warningsBannerEl = document.getElementById("coverage-warnings-banner");
  const warningsListEl = document.getElementById("coverage-warnings-list");
  const warningsCountEl = document.getElementById("coverage-warnings-findings-count");

  if (deferred) {
    const count = state.deferredMediaCount ?? 0;
    deferred.hidden = count <= 0;
    if (count > 0) deferred.textContent = t(currentLang, "coverage_deferred", { count: String(count) });
  }

  if (!el) return;

  // No completed scan, or a scan still running: there is no verdict to show.
  if (!state.scanned || state.scanning || state.error) {
    el.hidden = true;
    el.textContent = "";
    el.removeAttribute("data-tone");
    if (scanCoverageEl) {
      scanCoverageEl.hidden = true;
      scanCoverageEl.textContent = "";
      scanCoverageEl.classList.remove("status--error");
    }
    if (windowsDetailEl) {
      windowsDetailEl.hidden = true;
      windowsDetailEl.textContent = "";
      windowsDetailEl.removeAttribute("data-tone");
    }
    if (warningsBannerEl) {
      warningsBannerEl.hidden = true;
    }
    if (warningsListEl) {
      warningsListEl.replaceChildren();
    }
    return;
  }

  el.hidden = false;
  const verdict = coverageVerdict(state);
  el.textContent = verdict.text;
  el.setAttribute("data-tone", verdict.tone);

  let statement = "";
  let statementWarn = false;
  if (state.incompleteWindows && state.incompleteWindows.length > 0) {
    const reasons = state.incompleteWindows.map((w) => `Window ${w.windowIndex}: ${w.reason}`).join("; ");
    statement = t(currentLang, "coverage_windows_incomplete", {
      scanned: String(state.windowsScanned ?? 0),
      total: String(state.windowsTotal ?? 0),
      reasons,
    });
    statementWarn = true;
  } else if ((state.windowsTotal ?? 0) > 0 && !state.truncated) {
    statement = t(currentLang, "coverage_windows_complete", {
      scanned: String(state.windowsScanned ?? state.windowsTotal),
      total: String(state.windowsTotal),
      chars: state.visibleChars.toLocaleString(),
    });
  } else if (state.truncated) {
    statement = t(currentLang, "status_partial_results");
    statementWarn = true;
  }

  if (scanCoverageEl) {
    scanCoverageEl.hidden = statement.length === 0;
    scanCoverageEl.textContent = statement;
    scanCoverageEl.classList.toggle("status--error", statementWarn);
  }
  if (windowsDetailEl) {
    windowsDetailEl.hidden = statement.length === 0;
    windowsDetailEl.textContent = statement;
    if (statementWarn) windowsDetailEl.setAttribute("data-tone", "warn");
    else windowsDetailEl.removeAttribute("data-tone");
  }

  const effectiveWarnings: import("../shared/types.js").CoverageWarning[] =
    state.coverageWarnings && state.coverageWarnings.length > 0
      ? [...state.coverageWarnings]
      : state.incompleteWindows && state.incompleteWindows.length > 0
        ? [
            {
              cause: "incomplete_window",
              count: state.incompleteWindows.length,
              detail: state.incompleteWindows.map((w) => `Window ${w.windowIndex}: ${w.reason}`).join("; "),
            },
          ]
        : state.truncated
          ? [{ cause: "truncated", count: 1 }]
          : [];

  if (warningsBannerEl && warningsListEl) {
    warningsListEl.replaceChildren();
    if (effectiveWarnings.length === 0) {
      warningsBannerEl.hidden = true;
    } else {
      warningsBannerEl.hidden = false;
      if (warningsCountEl) {
        const findingTotal = state.totalFindings ?? state.findings.length;
        warningsCountEl.textContent = t(currentLang, "coverage_warning_findings_badge", {
          count: String(findingTotal),
        });
      }
      for (const w of effectiveWarnings) {
        const li = document.createElement("li");
        li.className = "coverage-warning-banner__item";
        li.setAttribute("data-cause", w.cause);
        if (w.cause === "incomplete_window") {
          li.textContent = t(currentLang, "coverage_warn_incomplete_window", {
            count: String(w.count),
            detail: w.detail || "",
          });
        } else if (w.cause === "truncated") {
          li.textContent = t(currentLang, "coverage_warn_truncated");
        } else if (w.cause === "cross_origin_iframe") {
          li.textContent = t(currentLang, "coverage_warn_cross_origin_iframe", {
            count: String(w.count),
          });
        } else if (w.cause === "closed_shadow_root") {
          li.textContent = t(currentLang, "coverage_warn_closed_shadow_root", {
            count: String(w.count),
          });
        } else if (w.cause === "canvas_only") {
          li.textContent = t(currentLang, "coverage_warn_canvas_only", {
            count: String(w.count),
          });
        }
        warningsListEl.appendChild(li);
      }
    }
  }
}

type CoverageTone = "ok" | "warn" | "error";

function coverageVerdict(state: PopupState): { text: string; tone: CoverageTone } {
  // Truncation is an independent signal of incompleteness and is checked before
  // any status: findings past the character cap were never looked for, so no
  // worker verdict can make a truncated scan read as clean.
  if (state.truncated) {
    return { text: t(currentLang, "coverage_status_partial"), tone: "warn" };
  }

  switch (state.coverageStatus) {
    case "FULLY_SCANNED":
      return { text: t(currentLang, "coverage_status_full"), tone: "ok" };
    case "NO_SENSITIVE_DATA_DETECTED":
      // Only reachable when every discovered region was inspected, so this is
      // a genuine all-clear and may read as one.
      return { text: t(currentLang, "coverage_status_clean"), tone: "ok" };
    case "PARTIALLY_SCANNED":
      return { text: t(currentLang, "coverage_status_partial"), tone: "warn" };
    case "UNSUPPORTED_CONTENT_PRESENT":
      return { text: t(currentLang, "coverage_status_unsupported"), tone: "warn" };
    case "BLOCKED_BY_BROWSER_SECURITY":
      return { text: t(currentLang, "coverage_status_blocked"), tone: "error" };
    case "SCAN_FAILED":
      return { text: t(currentLang, "coverage_status_failed"), tone: "error" };
    default:
      // No verdict reached us: a session from an older build, or a value the
      // worker's storage guard rejected. Say so rather than assuming clean.
      return { text: t(currentLang, "coverage_status_unknown"), tone: "warn" };
  }
}

async function sendMessage(message: PopupMessage): Promise<unknown> {
  return chrome.runtime.sendMessage(message);
  }

/**
 * Send a Document Studio message and surface anything the worker refuses.
 *
 * The worker answers with `{ ok: false, error }` for a dispatch failure - a
 * rejected sender, a message that failed validation, or a failed local-storage
 * purge. Every document call site fired and forgot the reply, so those failures
 * reached the user as no feedback at all: the popup sat on "Scanning document
 * on this device." forever with nothing to indicate the request was refused.
 */
async function sendDocMessage(message: PopupMessage): Promise<void> {
  try {
    const response = (await sendMessage(message)) as { ok?: boolean; error?: unknown } | undefined;
    if (response && response.ok === false) {
      hideDocProgress();
      setDocStatus(typeof response.error === "string" ? response.error : "The document could not be processed.", true);
    }
  } catch (error) {
    hideDocProgress();
    setDocStatus(error instanceof Error ? error.message : "The document could not be processed.", true);
  }
}

function currentSelectedIds(state: PopupState): string[] {
  return state.findings.filter((f) => f.selected).map((f) => f.id);
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    if (!ok) throw new Error("clipboard unavailable");
  }
}

function findingsToCsv(findings: Finding[]): string {
  const headers = [
    "Category",
    "Preview",
    "Confidence",
    "Source",
    "Attribute",
    "Page",
    "Start Offset",
    "End Offset",
    "Rect Count",
    "Name Title",
    "Name First",
    "Name Middle",
    "Name Last",
    "Name Suffix",
    "Name Credentials",
    "Name Gender",
    "Name Age",
    "Name DOB",
  ];
  const rows = findings.map((f) => {
    const pageMatch = f.nodeId.match(/^doc:(\d+):/);
    const page = pageMatch ? parseInt(pageMatch[1], 10) + 1 : "N/A";
    const p = f.parsedName;
    const middle = p?.middle?.join("; ") ?? "";
    const credentials = p?.credentials?.join("; ") ?? "";
    return [
      getCategoryLabel(currentLang, f.category),
      `"${f.preview.replace(/"/g, '""')}"`,
      `${Math.round(f.confidence * 100)}%`,
      f.source,
      f.attribute ? `"${f.attribute}"` : "",
      page.toString(),
      f.startOffset.toString(),
      f.endOffset.toString(),
      f.rects.length.toString(),
      `"${(p?.prefix ?? "").replace(/"/g, '""')}"`,
      `"${(p?.first ?? "").replace(/"/g, '""')}"`,
      `"${middle.replace(/"/g, '""')}"`,
      `"${(p?.last ?? "").replace(/"/g, '""')}"`,
      `"${(p?.suffix ?? "").replace(/"/g, '""')}"`,
      `"${credentials.replace(/"/g, '""')}"`,
      `"${(p?.gender ?? "").replace(/"/g, '""')}"`,
      `${p?.age ?? ""}`,
      `"${(p?.dob ?? "").replace(/"/g, '""')}"`,
    ];
  });
  return [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
}

function findingsToJson(findings: Finding[]): string {
  const exportData = {
    exportedAt: new Date().toISOString(),
    totalFindings: findings.length,
    findings: findings.map((f) => ({
      id: f.id,
      category: f.category,
      categoryLabel: getCategoryLabel(currentLang, f.category),
      confidence: f.confidence,
      source: f.source,
      attribute: f.attribute ?? null,
      preview: f.preview,
      nodeId: f.nodeId,
      startOffset: f.startOffset,
      endOffset: f.endOffset,
      rectCount: f.rects.length,
      contextPreview: f.contextPreview ?? null,
      parsedName: f.parsedName ?? null,
    })),
  };
  return JSON.stringify(exportData, null, 2);
}

async function exportFindings(findings: Finding[], format: "csv" | "json"): Promise<void> {
  const content = format === "csv" ? findingsToCsv(findings) : findingsToJson(findings);
  const mimeType = format === "csv" ? "text/csv" : "application/json";
  const extension = format === "csv" ? "csv" : "json";
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `governworld-findings-${new Date().toISOString().split("T")[0]}.${extension}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

interface DocUiState {
  docId: string;
  fileKey: string;
  name: string;
  mimeType: string;
  kind: DocKind;
  pages: DocPageMeta[];
  /**
   * The document's true length and where this pass started. A windowed pass
   * must be able to say "pages 21-40 of 45" rather than "20 pages", so a
   * partial scan can never be mistaken for a whole one.
   */
  totalPages?: number;
  pageOffset?: number;
  /** True when a Word document was cut at the character cap. */
  truncated?: boolean;
  /**
   * True when the bytes came from a screen capture rather than the original
   * file, so OCR quality is bounded by the on-screen size. Carried into the
   * review surface so it can say so instead of implying a full read.
   */
  degraded?: boolean;
  source?: "original" | "capture";
}

function detectDocKind(file: File, bytes: ArrayBuffer): DocKind {
  const name = file.name.toLowerCase();
  const mime = file.type.toLowerCase();
  const header = new Uint8Array(bytes.slice(0, 12));
  const startsWith = (...signature: number[]) => signature.every((value, index) => header[index] === value);
  if (name.endsWith(".pdf") || mime === "application/pdf") {
    if (!name.endsWith(".pdf") || (mime && mime !== "application/pdf") || !startsWith(0x25, 0x50, 0x44, 0x46, 0x2d)) throw new Error("Invalid PDF file.");
    return "pdf";
  }
  if (name.endsWith(".docx") || mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    if (!name.endsWith(".docx") || (mime && mime !== "application/vnd.openxmlformats-officedocument.wordprocessingml.document") || !startsWith(0x50, 0x4b, 0x03, 0x04)) throw new Error("Invalid DOCX file.");
    return "docx";
  }
  const isPng = startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  const isJpeg = startsWith(0xff, 0xd8, 0xff);
  const isWebp = startsWith(0x52, 0x49, 0x46, 0x46) && header[8] === 0x57 && header[9] === 0x45 && header[10] === 0x42 && header[11] === 0x50;
  if (isPng || isJpeg || isWebp) return "image";
  throw new Error("Unsupported file type.");
}

let lastDoc: DocUiState | null = null;
const selectedDocFindingIds = new Set<string>();
let currentStudioTool: "draw" | "erase" = "draw";

/**
 * Write a document-studio status line and reveal it.
 *
 * The message goes into `#doc-status-text` (the `<p>` the markup provides);
 * writing it to the `#doc-status` wrapper instead left the paragraph empty.
 * The wrapper ships with `hidden`, and nothing used to lift it, so every
 * status and every failure - including "no sensitive values were found" - was
 * rendered into a display:none element. An empty message hides the block again
 * so a stale "Scanning document on this device." does not outlive the run.
 */
function setDocStatus(message: string, isError: boolean): void {
  const status = document.getElementById("doc-status") as HTMLElement | null;
  if (!status) return;
  const text = document.getElementById("doc-status-text") as HTMLElement | null;
  if (text) {
    text.textContent = message;
  } else {
    status.textContent = message;
  }
  // The child sets its own colour, so the error colour has to reach it too.
  status.classList.toggle("status--error", isError);
  text?.classList.toggle("status--error", isError);
  status.hidden = message.length === 0;
}

/**
 * Hand the current document to the full-screen review page.
 *
 * The session is written to `chrome.storage.session` rather than sent as a
 * message, for the same reason document bytes never travel in one: the page
 * metadata for a long document is far larger than a runtime message may be.
 * The review page reads the store directly, exactly as redact.html reads
 * redacted pages.
 */
async function openFullScreenReview(
  doc: DocUiState,
  degraded: boolean,
  source: "original" | "capture"
): Promise<void> {
  const record = {
    docId: doc.docId,
    fileKey: doc.fileKey,
    name: doc.name,
    mimeType: doc.mimeType,
    kind: doc.kind,
    pages: doc.pages.map((p) => ({
      ...p,
      findings: p.findings.map((f) => ({
        ...f,
        selected: selectedDocFindingIds.has(f.id),
      })),
    })),
    // The review page shows the document at full size, so it is also where a
    // user decides whether the scan covered the document. It needs the same
    // window facts the popup has, or it would imply a partial pass was whole.
    totalPages: doc.totalPages ?? doc.pages.length,
    pageOffset: doc.pageOffset ?? 0,
    truncated: doc.truncated === true,
    degraded,
    source,
  };
  try {
    await chrome.storage.session.set({ reviewSession: record });
  } catch (error) {
    setDocStatus(
      error instanceof Error ? error.message : "The document could not be opened for review.",
      true
    );
    return;
  }
  const url = chrome.runtime.getURL("review.html");
  let opened = false;
  try {
    await chrome.tabs.create({ url, active: true });
    opened = true;
  } catch {
    opened = false;
  }
  if (!opened) {
    setDocStatus("Review could not be opened in a tab.", true);
  }
}

/** Reveal the Document Studio progress row for work that is actually running. */
function showDocProgress(): void {
  const progress = document.getElementById("doc-progress") as HTMLDivElement | null;
  if (progress) progress.hidden = false;
}

/** Hide the progress row once a run has finished, failed, or been cancelled. */
function hideDocProgress(): void {
  const progress = document.getElementById("doc-progress") as HTMLDivElement | null;
  if (progress) progress.hidden = true;
}

/**
 * True when the worker reported that a redaction could NOT be verified.
 *
 * `renderDocStage` surfaces that as an error, but the subsequent
 * `POPUP_DOC_DONE` used to overwrite it with a plain success line — so a file
 * whose boxes were measured as uncovered was reported to the user as safely
 * redacted. The failure must survive the success message.
 */
let docVerificationProblem = false;

/**
 * Last known UI language, so a synchronous render never has to await settings.
 *
 * `t()` already falls back to English for an unknown key, so the initial value is
 * safe. `initPopup` sets the real value once storage resolves, and the account
 * surface re-renders whenever a message arrives.
 */
let uiLanguage: LanguageCode = "en";

/** Current UI language, or "en" before settings have loaded. */
function accountLanguage(): LanguageCode {
  return uiLanguage;
}

function renderDocStage(message: Extract<PopupFromWorker, { type: "POPUP_DOC_STATUS" }>): void {
  const progress = document.getElementById("doc-progress") as HTMLDivElement | null;
  const progressText = document.getElementById("doc-progress-text") as HTMLSpanElement | null;
  if (!progress) return;

  if (message.problem) {
    docVerificationProblem = true;
    setDocStatus(message.problem, true);
    return;
  }

  progress.hidden = false;
  if (!progressText) return;
  if (message.stage === "detected") {
    progressText.textContent = t(currentLang, "doc_processing");
  } else if (message.stage === "redacted") {
    progressText.textContent =
      typeof message.paintedRegions === "number"
        ? `${message.paintedRegions} region${message.paintedRegions === 1 ? "" : "s"} blacked out`
        : "";
  } else {
    const verified = message.verifiedRegions ?? 0;
    const checked = message.checkedRegions ?? 0;
    const how = message.method === "page-pixels" ? "page bitmaps" : "the saved file";
    progressText.textContent = checked > 0 ? `${verified} of ${checked} regions confirmed in ${how}` : "";
  }
}

function resetDocStages(): void {
  const progress = document.getElementById("doc-progress") as HTMLDivElement | null;
  const progressText = document.getElementById("doc-progress-text") as HTMLSpanElement | null;
  if (progress) progress.hidden = true;
  if (progressText) progressText.textContent = t(currentLang, "doc_processing");
  // Cleared per run: otherwise one unverified redaction would suppress the
  // success message of every later, correctly verified one.
  docVerificationProblem = false;
}

/**
 * A file that has been staged and is waiting for its page count.
 *
 * The count pass sits between "user picks a file" and "scan it", because the
 * window the user is about to choose depends on how long the document really
 * is. Until the count arrives there is nothing to scan, so nothing is.
 */
let pendingCountFile: { fileKey: string; name: string; mimeType: string; kind: DocKind; degraded?: boolean } | null = null;

/**
 * Page count of the document whose window is being chosen.
 *
 * It is held separately from `pendingCountFile` because the chooser is also
 * opened from the rescan button for a document that is already loaded, where
 * there is no pending count - only a document whose length is known.
 */
let windowTotalPages = 1;

/**
 * Count the staged document's pages, then let the user choose the window if it
 * does not fit in one pass.
 *
 * This replaces a silent failure: a 45-page document used to be rendered as
 * its first 20 pages and then described as "20 pages", which is a complete
 * scan that never happened. The count is cheap - it parses the document and
 * renders nothing - and it is also a fail-fast, so a corrupt or encrypted file
 * is rejected in about a second instead of after a minute of work.
 */
let activeDocFileKey: string | null = null;
let activeDocRequestId: string | null = null;
const cancelledDocTokens = new Set<string>();

function startCount(fileKey: string, name: string, mimeType: string, kind: DocKind, degraded = false): void {
  pendingCountFile = { fileKey, name, mimeType, kind, degraded };
  activeDocFileKey = fileKey;
  cancelledDocTokens.delete(fileKey);
  resetDocStages();
  setDocStatus("Scanning document on this device…", false);
  showDocProgress();
  const reqId = requestId();
  activeDocRequestId = reqId;
  void sendDocMessage({ type: "POPUP_DOC_COUNT", requestId: reqId, fileKey, name, mimeType, kind });
}

/** Scan one window of the staged document. */
function startPreview(pageOffset: number, totalPages?: number): void {
  const pending = pendingCountFile;
  pendingCountFile = null;
  if (!pending) return;
  const { fileKey, name, mimeType, kind, degraded } = pending;
  activeDocFileKey = fileKey;
  cancelledDocTokens.delete(fileKey);
  resetDocStages();
  showDocProgress();
  beginDocSession({ fileKey, name, mimeType, kind, degraded });
  const reqId = requestId();
  activeDocRequestId = reqId;
  void sendDocMessage({
    type: "POPUP_DOC_PREVIEW",
    requestId: reqId,
    fileKey,
    name,
    mimeType,
    kind,
    pageOffset,
    ...(totalPages !== undefined ? { totalPages } : {}),
  });
}

/**
 * Show the page-window chooser for a document longer than one pass covers.
 *
 * `from` seeds the first page of the proposed window so a re-scan continues
 * where the last pass stopped instead of offering the same pages again.
 */
function openWindowDialog(totalPages: number, from: number): void {
  const dialog = document.getElementById("doc-window-dialog") as HTMLDialogElement | null;
  const desc = document.getElementById("doc-window-desc") as HTMLElement | null;
  const fromInput = document.getElementById("doc-window-from") as HTMLInputElement | null;
  const toInput = document.getElementById("doc-window-to") as HTMLInputElement | null;
  const error = document.getElementById("doc-window-error") as HTMLElement | null;
  if (!dialog) return;

  const proposed = resolvePageWindow(totalPages, from);
  if (desc) desc.textContent = t(currentLang, "doc_window_desc", { total: String(totalPages), max: String(MAX_DOC_PAGES) });
  if (fromInput) fromInput.value = String(proposed.from);
  if (toInput) toInput.value = String(proposed.to);
  if (error) error.hidden = true;
  dialog.showModal();
}

/** Read and validate the dialog's range, or explain why it cannot be used. */
function readWindowChoice(totalPages: number): number | null {
  const fromInput = document.getElementById("doc-window-from") as HTMLInputElement | null;
  const toInput = document.getElementById("doc-window-to") as HTMLInputElement | null;
  const error = document.getElementById("doc-window-error") as HTMLElement | null;
  const from = Number(fromInput?.value);
  const to = Number(toInput?.value);
  const valid =
    Number.isFinite(from) &&
    Number.isFinite(to) &&
    Number.isInteger(from) &&
    Number.isInteger(to) &&
    from >= 1 &&
    to >= from &&
    to <= totalPages &&
    to - from + 1 <= MAX_DOC_PAGES;
  if (!valid) {
    // The message names the actual bounds rather than "invalid input": a user
    // who typed 21-40 for a 22-page document needs to know which end is wrong.
    if (error) {
      error.textContent = t(currentLang, "doc_window_invalid", { total: String(totalPages), max: String(MAX_DOC_PAGES) });
      error.hidden = false;
    }
    return null;
  }
  if (error) error.hidden = true;
  return resolvePageWindow(totalPages, from).offset;
}

/**
 * Say, persistently, that this pass covered part of the document.
 *
 * It hides itself when the pass covers everything, so the common case is
 * unchanged; and it names the exact range, because "some pages were not
 * scanned" is not something anyone can act on.
 */
function renderWindowWarning(totalPages: number, pageOffset: number, scanned: number): void {
  const banner = document.getElementById("doc-window-warning") as HTMLElement | null;
  const text = document.getElementById("doc-window-warning-text") as HTMLElement | null;
  if (!banner || !text) return;
  const window = resolvePageWindow(totalPages, pageOffset + 1);
  // A full pass needs no banner, and neither does a document whose count never
  // arrived: "pages 1-20 of 20" is the whole document, and claiming otherwise
  // would be a false alarm - the exact failure this banner exists to prevent.
  if (!window.windowed) {
    banner.hidden = true;
    text.textContent = "";
    return;
  }
  banner.hidden = false;
  text.textContent = t(currentLang, "doc_window_warning", {
    from: String(window.from),
    to: String(Math.min(window.to, pageOffset + scanned)),
    total: String(window.total),
  });
}

function hideWindowWarning(): void {
  const banner = document.getElementById("doc-window-warning") as HTMLElement | null;
  const text = document.getElementById("doc-window-warning-text") as HTMLElement | null;
  if (banner) banner.hidden = true;
  if (text) text.textContent = "";
}

/**
 * Disclose that a Word document was cut at the character cap.
 *
 * A Word file has no pages of its own: mammoth returns one text blob and the
 * cap slices it. Everything past the cut is never laid out, never read and
 * never redacted, and the page count that remains is the count of the part that
 * was read. Without this the user is told a shorter document than the one they
 * opened - the same false completeness the page cap had.
 */
function renderTextLimitWarning(truncated: boolean): void {
  const banner = document.getElementById("doc-text-limit-warning") as HTMLElement | null;
  const text = document.getElementById("doc-text-limit-warning-text") as HTMLElement | null;
  if (!banner || !text) return;
  if (!truncated) {
    banner.hidden = true;
    text.textContent = "";
    return;
  }
  banner.hidden = false;
  text.textContent = t(currentLang, "doc_text_limit_warning", {
    chars: MAX_DOCX_CHARS.toLocaleString(),
  });
}

const overlayRedrawers: (() => void)[] = [];

export function redrawAllOverlays(): void {
  for (const redraw of overlayRedrawers) {
    try {
      redraw();
    } catch {
      // Ignored
    }
  }
}

function updateDocRedactBtn(): void {
  const redactBtn = document.getElementById("doc-redact-btn") as HTMLButtonElement | null;
  if (redactBtn) {
    redactBtn.disabled = selectedDocFindingIds.size === 0;
  }
}

function renderDocFindings(): void {
  const list = document.getElementById("doc-findings") as HTMLUListElement | null;
  const countBadge = document.getElementById("doc-findings-count") as HTMLSpanElement | null;
  const docCard = document.getElementById("doc-compliance-card");
  const docScore = document.getElementById("doc-compliance-score");
  const docBand = document.getElementById("doc-compliance-band");
  const docAction = document.getElementById("doc-compliance-action");
  const docReason = document.getElementById("doc-compliance-reason");
  const docRules = document.getElementById("doc-compliance-rules");
  if (!list) return;
  list.replaceChildren();
  if (!lastDoc) {
    if (countBadge) countBadge.textContent = "0";
    if (docCard) docCard.hidden = true;
    updateDocRedactBtn();
    return;
  }
  const totalFindings = lastDoc.pages.reduce((n, p) => n + p.findings.length, 0);
  if (countBadge) countBadge.textContent = `${totalFindings} detected`;

  const allDocFindings = lastDoc.pages.flatMap((p) => p.findings);
  updateComplianceScorecard(
    docCard,
    docScore,
    docBand,
    docAction,
    docReason,
    docRules,
    allDocFindings,
    undefined,
    "download"
  );

  for (const page of lastDoc.pages) {
    for (const finding of page.findings) {
      const item = el("li", "finding");
      const check = document.createElement("input");
      check.type = "checkbox";
      check.className = "finding__check";
      check.checked = selectedDocFindingIds.has(finding.id);
      check.setAttribute("aria-checked", check.checked ? "true" : "false");
      check.setAttribute("aria-label", `Select ${getCategoryLabel(currentLang, finding.category)} finding on page ${page.index + 1}`);
      check.addEventListener("change", () => {
        check.setAttribute("aria-checked", check.checked ? "true" : "false");
        finding.selected = check.checked;
        if (check.checked) selectedDocFindingIds.add(finding.id);
        else selectedDocFindingIds.delete(finding.id);
        updateDocRedactBtn();
        redrawAllOverlays();
      });

      const main = el("div", "finding__main");
      const head = el("div", "finding__head");
      const category = el("div", "finding__category", getCategoryLabel(currentLang, finding.category));
      head.append(category);
      if (finding.category === "custom") {
        const customBadge = el("span", "finding__badge-attr", "Drawn Box");
        head.append(customBadge);
      }
      const preview = el("div", "finding__preview", finding.preview);
      const meta = el("div", "finding__meta");
      const confidence = el("div", "finding__confidence", `${confidenceLabel(finding.confidence)} (${Math.round(finding.confidence * 100)}%)`);
      meta.append(confidence);
      main.append(head, preview, meta);

      const context = el("div", "finding__context", `Page ${page.index + 1} — ${finding.contextPreview ?? ""}`);
      item.append(check, main, context);
      list.appendChild(item);
    }
  }
  updateDocRedactBtn();
}

/**
 * Open a document session as soon as a preview is requested.
 *
 * The POPUP_DOC_STATE handler drops the first reply unless `lastDoc` already
 * describes the same document, and `lastDoc` was otherwise only ever assigned
 * inside `renderDoc` — which that same handler is the only caller of. Without
 * this, the guard could never be satisfied, so selecting a document left the
 * popup waiting on "Scanning document on this device…" with the Document Studio
 * never appearing. The worker assigns the real `docId` in its reply, which the
 * handler then copies in; the placeholder is matched on `fileKey`.
 */
function beginDocSession(seed: {
  fileKey: string;
  name: string;
  mimeType: string;
  kind: DocKind;
  /** True for a screen capture, whose OCR quality is bounded by what was shown. */
  degraded?: boolean;
}): void {
  lastDoc = {
    docId: "",
    fileKey: seed.fileKey,
    name: seed.name,
    mimeType: seed.mimeType,
    kind: seed.kind,
    pages: [],
    degraded: seed.degraded === true,
  };
  selectedDocFindingIds.clear();
  overlayRedrawers.length = 0;
}

/**
 * Point a page thumbnail at its persisted preview bitmap.
 *
 * The rendered page image is stored in the shared document store and referenced
 * by key, because a base64 page preview is far larger than a runtime message may
 * be. A missing preview degrades to alt text rather than breaking the studio.
 */
async function loadPreviewInto(img: HTMLImageElement, page: DocPageMeta): Promise<void> {
  try {
    const url = await previewObjectUrl(page.previewKey);
    if (url) {
      img.src = url;
      return;
    }
  } catch {
    // Fall through to the degraded state below.
  }
  img.alt = `Page ${page.index + 1} (preview unavailable)`;
}

/**
 * "47 pages", or "pages 21-40 of 47" for a partial pass.
 *
 * The distinction is the whole point: a window that covered a third of a
 * document must never be labelled as if it were the document.
 */
function pageCountLabel(state: DocUiState): string {
  const scanned = state.pages.length;
  const total = state.totalPages ?? scanned;
  const offset = state.pageOffset ?? 0;
  if (offset > 0 || offset + scanned < total) {
    return `pages ${offset + 1}\u2013${Math.min(offset + scanned, total)} of ${total}`;
  }
  return `${scanned} page${scanned === 1 ? "" : "s"}`;
}

function renderDoc(state: DocUiState): void {
  lastDoc = state;
  selectedDocFindingIds.clear();
  overlayRedrawers.length = 0;
  for (const page of state.pages) {
    for (const finding of page.findings) {
      if (finding.selected !== false) {
        selectedDocFindingIds.add(finding.id);
      }
    }
  }

  const workspace = document.getElementById("doc-workspace") as HTMLElement | null;
  const thumbs = document.getElementById("doc-thumbs") as HTMLElement | null;
  const docFilename = document.getElementById("doc-filename") as HTMLElement | null;
  const docPageCount = document.getElementById("doc-page-count") as HTMLElement | null;
  const docStyleSelect = document.getElementById("doc-style-select") as HTMLSelectElement | null;
  const docStampText = document.getElementById("doc-stamp-text") as HTMLInputElement | null;

  if (docFilename) docFilename.textContent = state.name;
  // "Pages 21-40 of 45" when a pass is partial, "47 pages" when it is the whole
  // document. The old text was always the latter - it described the pages that
  // happened to be rendered, which is how a 20-page window of a 45-page
  // document read as a complete scan.
  if (docPageCount) docPageCount.textContent = pageCountLabel(state);
  renderWindowWarning(state.totalPages ?? state.pages.length, state.pageOffset ?? 0, state.pages.length);
  renderTextLimitWarning(state.truncated === true);
  if (workspace) workspace.hidden = false;

  if (thumbs) {
    thumbs.replaceChildren();
    for (const page of state.pages) {
      const wrapper = el("div", "doc-thumb-wrapper");
      wrapper.setAttribute("title", "Click a finding to toggle, or drag to draw a custom redaction box");

      const img = document.createElement("img");
      img.alt = `Page ${page.index + 1}`;
      img.loading = "lazy";
      // The preview image is not carried in the message; it is persisted in the
      // shared document store and referenced by key, so it resolves asynchronously.
      void loadPreviewInto(img, page);

      const canvas = document.createElement("canvas");
      canvas.className = "doc-thumb-canvas";
      canvas.width = page.widthPx;
      canvas.height = page.heightPx;

      const redraw = () => {
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const style = (docStyleSelect?.value as RedactionStyle) || "blackout";
        const stampLabel = docStampText?.value?.trim() || "[REDACTED]";

        for (const finding of page.findings) {
          if (!selectedDocFindingIds.has(finding.id)) continue;
          for (const rect of finding.rects) {
            if (style === "blackout") {
              ctx.fillStyle = "#000000";
              ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
            } else if (style === "whiteout") {
              ctx.fillStyle = "#ffffff";
              ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
              ctx.strokeStyle = "#cccccc";
              ctx.lineWidth = 1;
              ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
            } else if (style === "stamp") {
              ctx.fillStyle = "#000000";
              ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
              ctx.fillStyle = "#ffffff";
              const fontSize = Math.max(10, Math.min(rect.height * 0.7, 16));
              ctx.font = `bold ${fontSize}px sans-serif`;
              ctx.textAlign = "center";
              ctx.textBaseline = "middle";
              ctx.fillText(stampLabel, rect.x + rect.width / 2, rect.y + rect.height / 2, rect.width - 4);
            }
          }
        }
      };

      overlayRedrawers.push(redraw);
      redraw();

      let isDrawing = false;
      let startX = 0;
      let startY = 0;

      const getCoords = (e: MouseEvent) => {
        const bounds = canvas.getBoundingClientRect();
        const scaleX = canvas.width / bounds.width;
        const scaleY = canvas.height / bounds.height;
        return {
          x: Math.round((e.clientX - bounds.left) * scaleX),
          y: Math.round((e.clientY - bounds.top) * scaleY),
        };
      };

      canvas.addEventListener("mousedown", (e) => {
        if (currentStudioTool === "draw") {
          isDrawing = true;
          const { x, y } = getCoords(e);
          startX = x;
          startY = y;
        }
      });

      canvas.addEventListener("mousemove", (e) => {
        if (!isDrawing) return;
        const { x, y } = getCoords(e);
        redraw();
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.strokeStyle = "#00ffff";
          ctx.lineWidth = 2;
          ctx.setLineDash([4, 2]);
          ctx.strokeRect(
            Math.min(startX, x),
            Math.min(startY, y),
            Math.abs(x - startX),
            Math.abs(y - startY)
          );
          ctx.setLineDash([]);
        }
      });

      const finishDraw = (e: MouseEvent) => {
        if (!isDrawing) return;
        isDrawing = false;
        const { x, y } = getCoords(e);
        const rx = Math.min(startX, x);
        const ry = Math.min(startY, y);
        const rw = Math.abs(x - startX);
        const rh = Math.abs(y - startY);

        if (rw < 8 || rh < 8) {
          const clickedFinding = page.findings.find((f) =>
            f.rects.some((r) => rx >= r.x && rx <= r.x + r.width && ry >= r.y && ry <= r.y + r.height)
          );
          if (clickedFinding) {
            if (selectedDocFindingIds.has(clickedFinding.id)) {
              selectedDocFindingIds.delete(clickedFinding.id);
            } else {
              selectedDocFindingIds.add(clickedFinding.id);
            }
            renderDocFindings();
            redrawAllOverlays();
          }
          return;
        }

        const customFinding: Finding = {
          // The `custom:` prefix is a contract, not decoration. The worker
          // validates every selected id against the session and only tolerates
          // one it does not recognise when it starts with `custom:` or
          // `user:`, so a bare UUID here was rejected at redaction time with
          // "The selected findings are no longer available." - after the user
          // had already drawn the box and seen it in the findings list.
          id: `custom:${requestId()}`,
          category: "custom",
          confidence: 1.0,
          source: "local-rules",
          preview: `Custom Area (${rw}x${rh})`,
          nodeId: `doc:${page.index}:custom`,
          startOffset: 0,
          endOffset: 0,
          rects: [{ x: rx, y: ry, width: rw, height: rh }],
          selected: true,
        };

        page.findings.push(customFinding);
        selectedDocFindingIds.add(customFinding.id);
        renderDocFindings();
        redrawAllOverlays();
      };

      canvas.addEventListener("mouseup", finishDraw);
      canvas.addEventListener("mouseleave", () => {
        if (isDrawing) {
          isDrawing = false;
          redraw();
        }
      });

      wrapper.append(img, canvas);
      thumbs.appendChild(wrapper);
    }
  }

  renderDocFindings();
}

function buildDocBoxes(): { pageIndex: number; rects: Rect[] }[] {
  if (!lastDoc) return [];
  const byPage = new Map<number, Rect[]>();
  for (const page of lastDoc.pages) {
    for (const finding of page.findings) {
      if (!selectedDocFindingIds.has(finding.id)) continue;
      const list = byPage.get(page.index) ?? [];
      list.push(...finding.rects);
      byPage.set(page.index, list);
    }
  }
  return Array.from(byPage.entries()).map(([pageIndex, rects]) => ({ pageIndex, rects }));
}

function clearDocUi(options?: { keepRedacted?: boolean }): void {
  const workspace = document.getElementById("doc-workspace") as HTMLElement | null;
  const thumbs = document.getElementById("doc-thumbs") as HTMLElement | null;
  const list = document.getElementById("doc-findings") as HTMLUListElement | null;
  const redactBtn = document.getElementById("doc-redact-btn") as HTMLButtonElement | null;
  const fileKeyToDelete = lastDoc?.fileKey ?? activeDocFileKey;
  if (fileKeyToDelete) void deleteFile(fileKeyToDelete, options).catch(() => undefined);
  if (!options?.keepRedacted) {
    activeDocFileKey = null;
    activeDocRequestId = null;
    void clearStagedMarker().catch(() => undefined);
  }
  lastDoc = null;
  selectedDocFindingIds.clear();
  overlayRedrawers.length = 0;
  if (workspace) workspace.hidden = true;
  if (thumbs) thumbs.replaceChildren();
  if (list) list.replaceChildren();
  if (redactBtn) redactBtn.disabled = true;
  // A window warning for a document that is no longer loaded would claim
  // something about nothing.
  hideWindowWarning();
  const textLimitBanner = document.getElementById("doc-text-limit-warning") as HTMLElement | null;
  const textLimitText = document.getElementById("doc-text-limit-warning-text") as HTMLElement | null;
  if (textLimitBanner) textLimitBanner.hidden = true;
  if (textLimitText) textLimitText.textContent = "";
}

/** Wire tab navigation and contextual guidance links. */
function initTabs(): { switchTab: (tabId: string) => void; switchSettingsPage: (pageId: string) => void } {
  const tabButtons = document.querySelectorAll<HTMLButtonElement>(".tab-btn");
  const tabPanels = document.querySelectorAll<HTMLElement>(".tab-panel");

  function switchTab(tabId: string): void {
    tabButtons.forEach((btn) => {
      const isActive = btn.dataset.tab === tabId;
      btn.classList.toggle("tab-btn--active", isActive);
      btn.setAttribute("aria-selected", isActive ? "true" : "false");
    });
    tabPanels.forEach((panel) => {
      const isActive = panel.id === `tab-${tabId}`;
      panel.hidden = !isActive;
      panel.classList.toggle("tab-panel--active", isActive);
    });
  }

  tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tabId = btn.dataset.tab;
      if (tabId) switchTab(tabId);
    });
  });

  const contextualGuideDialog = document.getElementById("contextual-guide-dialog") as HTMLDialogElement | null;
  const contextualGuideTitle = document.getElementById("contextual-guide-title") as HTMLHeadingElement | null;
  const contextualGuideBody = document.getElementById("contextual-guide-body") as HTMLDivElement | null;
  const contextualGuideOpenAbout = document.getElementById("contextual-guide-open-about") as HTMLButtonElement | null;
  const contextualGuideClose = document.getElementById("contextual-guide-close") as HTMLButtonElement | null;
  let activeGuideId: string | null = null;
  let lastGuideTrigger: HTMLElement | null = null;

  contextualGuideClose?.addEventListener("click", () => {
    contextualGuideDialog?.close();
    lastGuideTrigger?.focus();
  });

  contextualGuideOpenAbout?.addEventListener("click", () => {
    contextualGuideDialog?.close();
    switchTab("settings");
    switchSettingsPage("about");
    const guidesDetails = document.getElementById("about-guides-details") as HTMLDetailsElement | null;
    if (guidesDetails) guidesDetails.open = true;
    if (activeGuideId) {
      const targetEl = document.getElementById(activeGuideId);
      if (targetEl) {
        targetEl.scrollIntoView({ behavior: "smooth", block: "start" });
        targetEl.classList.remove("guide-card--highlight");
        void targetEl.offsetWidth;
        targetEl.classList.add("guide-card--highlight");
      }
    }
  });

  const helpLinks = document.querySelectorAll<HTMLElement>("[data-guide]");
  helpLinks.forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      const guideId = link.getAttribute("data-guide");
      if (!guideId) return;
      activeGuideId = guideId;
      lastGuideTrigger = link;
      const guidesDetails = document.getElementById("about-guides-details") as HTMLDetailsElement | null;
      if (guidesDetails) guidesDetails.open = true;
      const targetEl = document.getElementById(guideId);
      if (targetEl) {
        targetEl.classList.remove("guide-card--highlight");
        void targetEl.offsetWidth;
        targetEl.classList.add("guide-card--highlight");
      }
      if (contextualGuideDialog && contextualGuideTitle && contextualGuideBody && targetEl) {
        const heading = targetEl.querySelector("h4");
        contextualGuideTitle.textContent = heading?.textContent ?? "Feature Guide";
        contextualGuideBody.replaceChildren();
        for (const child of Array.from(targetEl.childNodes)) {
          if (child === heading) continue;
          contextualGuideBody.appendChild(child.cloneNode(true));
        }
        if (typeof contextualGuideDialog.showModal === "function") {
          contextualGuideDialog.showModal();
          return;
        }
      }
      switchTab("settings");
      switchSettingsPage("about");
      targetEl?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });

  const settingsNavBtns = document.querySelectorAll<HTMLButtonElement>(".settings-nav-btn");
  const settingsPages = document.querySelectorAll<HTMLElement>(".settings-page");

  function switchSettingsPage(pageId: string): void {
    settingsNavBtns.forEach((btn) => {
      const isActive = btn.dataset.settingsPage === pageId;
      btn.classList.toggle("settings-nav-btn--active", isActive);
      if (isActive) btn.setAttribute("aria-current", "page");
      else btn.removeAttribute("aria-current");
    });
    settingsPages.forEach((page) => {
      const isActive = page.dataset.settingsPage === pageId;
      page.hidden = !isActive;
      page.classList.toggle("settings-page--active", isActive);
    });
  }

  switchSettingsPage("profile");

  settingsNavBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const pageId = btn.dataset.settingsPage;
      if (pageId) switchSettingsPage(pageId);
    });
  });

  const openWizardBtn2 = document.getElementById("open-wizard-btn-2");
  openWizardBtn2?.addEventListener("click", () => {
    const wizardBtn = document.getElementById("open-wizard-btn") as HTMLButtonElement | null;
    wizardBtn?.click();
  });

  const coverageDetailsBtn = document.getElementById("coverage-details-btn");
  coverageDetailsBtn?.addEventListener("click", () => {
    switchTab("settings");
    switchSettingsPage("privacy");
  });

  return { switchTab, switchSettingsPage };
}

export interface ProtectionStatusSnapshot {
  settings: Settings;
  policy: import("../shared/enterprisePolicy.js").EnterprisePolicy;
  effective: EffectiveProtection;
  capability: AlwaysOnCapability;
}

/** Load the full protection picture: user settings, admin policy, site access. */
export async function loadProtectionStatus(): Promise<ProtectionStatusSnapshot> {
  const [settings, policy, capability] = await Promise.all([
    loadSettings(),
    loadEnterprisePolicy(),
    queryAlwaysOnCapability(),
  ]);
  return { settings, policy, effective: resolveEffectiveProtection(settings, policy), capability };
}

/** Request optional site access for always-on. False when denied or unavailable. */
export async function requestSiteAccess(): Promise<boolean> {
  try {
    if (typeof chrome === "undefined" || !chrome.permissions?.request) return false;
    return await chrome.permissions.request({ origins: [...ALWAYS_ON_ORIGINS] });
  } catch {
    return false;
  }
}

function setModeToggle(el: HTMLInputElement | null, checked: boolean, disabled: boolean): void {
  if (!el) return;
  el.checked = checked;
  el.setAttribute("aria-checked", checked ? "true" : "false");
  el.disabled = disabled;
}

/**
 * Render the honest protection state across the popup and side panel (they
 * share this controller). The banner names the verified mode: "always on"
 * appears ONLY with proof (registration possible AND site access granted);
 * otherwise it names the missing piece. A locked enterprise policy disables
 * the mode controls so no toggle can override it.
 */
export async function refreshProtectionStatus(): Promise<ProtectionStatusSnapshot> {
  const snapshot = await loadProtectionStatus();
  const { settings, policy, effective, capability } = snapshot;
  const lang = settings.language;
  const state = describeProtectionState(effective.mode, capability);

  const stateKey =
    state === "off"
      ? "protection_state_off"
      : state === "always-on-active"
        ? "protection_state_always_on"
        : state === "always-on-waiting-access"
          ? "protection_state_waiting"
          : "protection_state_this_tab";

  const banner = document.getElementById("scanner-shield-status");
  const label = document.getElementById("scanner-shield-label");
  if (label) label.textContent = t(lang, stateKey);
  if (banner) {
    banner.classList.toggle("shield-banner--inactive", state === "off" || state === "always-on-waiting-access");
  }

  const stateLine = document.getElementById("protection-state");
  if (stateLine) stateLine.textContent = t(lang, stateKey);

  const livePasteVal = document.getElementById("live-paste-value");
  if (livePasteVal) {
    if (state === "off") {
      livePasteVal.textContent = t(lang, "status_val_off");
      livePasteVal.setAttribute("data-tone", "muted");
    } else if (state === "always-on-waiting-access") {
      livePasteVal.textContent = t(lang, "status_val_waiting");
      livePasteVal.setAttribute("data-tone", "warn");
    } else if (state === "always-on-active") {
      livePasteVal.textContent = t(lang, "status_val_always_on");
      livePasteVal.removeAttribute("data-tone");
    } else {
      livePasteVal.textContent = t(lang, "status_val_this_tab");
      livePasteVal.removeAttribute("data-tone");
    }
  }

  const docsSupported = isDocumentPipelineSupported();
  const liveDocsVal = document.getElementById("live-docs-value");
  if (liveDocsVal) {
    liveDocsVal.textContent = docsSupported ? t(lang, "status_val_ready") : t(lang, "status_val_chromium_only");
    if (docsSupported) liveDocsVal.removeAttribute("data-tone");
    else liveDocsVal.setAttribute("data-tone", "muted");
  }
  const diagDocVal = document.getElementById("diag-doc-value");
  const diagOcrVal = document.getElementById("diag-ocr-value");
  if (!docsSupported) {
    if (diagDocVal) diagDocVal.textContent = t(lang, "status_val_chromium_only");
    if (diagOcrVal) diagOcrVal.textContent = t(lang, "status_val_chromium_only");
  }
  const diagVersionVal = document.getElementById("diag-version-value");
  if (diagVersionVal) {
    const manifestVer = typeof chrome !== "undefined" ? chrome.runtime?.getManifest?.()?.version : undefined;
    diagVersionVal.textContent = manifestVer || CURRENT_EXTENSION_VERSION;
  }

  const managedNotice = document.getElementById("managed-lock-notice");
  if (managedNotice) {
    managedNotice.hidden = !effective.locked;
    if (effective.locked) managedNotice.textContent = t(lang, "managed_lock_notice");
  }

  setModeToggle(
    document.getElementById("paste-guard-toggle") as HTMLInputElement | null,
    effective.mode !== "off",
    effective.locked
  );
  setModeToggle(
    document.getElementById("always-on-toggle") as HTMLInputElement | null,
    effective.mode === "always-on",
    effective.locked
  );

  const grantBtn = document.getElementById("grant-access-btn") as HTMLButtonElement | null;
  if (grantBtn) {
    grantBtn.hidden = effective.mode !== "always-on" || capability.siteAccessGranted;
  }

  const isLocked = effective.locked;

  // Lock admin-mandated sections when under managed policy
  const presetSelect = document.getElementById("preset-select") as HTMLSelectElement | null;
  if (presetSelect) {
    presetSelect.disabled = isLocked;
    if (isLocked) presetSelect.title = t(lang, "managed_lock_notice");
    else presetSelect.removeAttribute("title");
  }

  for (const btnId of ["cat-filter-all", "cat-filter-health", "cat-filter-intl", "cat-filter-finance", "cat-filter-none"]) {
    const btn = document.getElementById(btnId) as HTMLButtonElement | null;
    if (btn) {
      btn.disabled = isLocked;
      if (isLocked) btn.title = t(lang, "managed_lock_notice");
      else btn.removeAttribute("title");
    }
  }

  for (const elId of ["threshold-category-select", "threshold-value-select", "threshold-apply-all-btn"]) {
    const el = document.getElementById(elId) as HTMLSelectElement | HTMLButtonElement | null;
    if (el) {
      el.disabled = isLocked;
      if (isLocked) el.title = t(lang, "managed_lock_notice");
      else el.removeAttribute("title");
    }
  }

  const openWiz = document.getElementById("open-wizard-btn") as HTMLButtonElement | null;
  if (openWiz) {
    openWiz.disabled = isLocked;
    if (isLocked) openWiz.title = t(lang, "managed_lock_notice");
    else openWiz.removeAttribute("title");
  }

  await renderCategories({
    enabledCategories: effective.enabledCategories,
    lockedCategories: effective.lockedCategories,
    language: lang,
  });
  lastOperatingMode = policy.managed ? "MANAGE" : (lastState?.operatingMode === "MANAGE" ? "MANAGE" : "LOCAL");
  syncProfilePopoverSummary();
  return snapshot;
}

/** Shared popup/panel bootstrap. */
export async function initPopup(): Promise<void> {
  const { switchTab, switchSettingsPage } = initTabs();

  const isSidePanelContext =
    window.location.pathname.toLowerCase().includes("sidepanel") ||
    new URLSearchParams(window.location.search).get("view") === "sidepanel" ||
    window.innerHeight > 600;
  document.documentElement.dataset.surface = isSidePanelContext ? "sidepanel" : "popup";

  const openSidePanelHeaderBtn = document.getElementById("open-side-panel-btn") as HTMLButtonElement | null;
  if (openSidePanelHeaderBtn) {
    openSidePanelHeaderBtn.hidden = isSidePanelContext;
  }

  let currentWindowId: number | undefined;
  try {
    if (typeof chrome !== "undefined" && chrome.windows?.getCurrent) {
      const win = await chrome.windows.getCurrent();
      currentWindowId = win?.id;
    }
  } catch {
    // Ignore in unit-test environments without chrome.windows
  }

  const settings = await loadSettings();
  currentLang = settings.language;
  uiLanguage = settings.language;
  applyUiLanguage(settings.language);
  applyAccessibilitySettings(settings);
  await refreshProtectionStatus();
  await refreshReviewTelemetry();

  // First-Run Welcome Card (wired to settings.disclosureAcknowledged)
  const welcomeCard = document.getElementById("first-run-welcome") as HTMLElement | null;
  const welcomeDismissBtn = document.getElementById("welcome-dismiss-btn") as HTMLButtonElement | null;
  const welcomeAlwaysOnBtn = document.getElementById("welcome-always-on-btn") as HTMLButtonElement | null;
  if (welcomeCard) {
    welcomeCard.hidden = settings.disclosureAcknowledged === true;
  }
  welcomeDismissBtn?.addEventListener("click", async () => {
    if (welcomeCard) welcomeCard.hidden = true;
    const current = await loadSettings();
    await saveSettings({ ...current, disclosureAcknowledged: true });
  });
  welcomeAlwaysOnBtn?.addEventListener("click", async () => {
    const granted = await requestSiteAccess();
    const current = await loadSettings();
    if (granted) {
      await saveSettings({
        ...current,
        disclosureAcknowledged: true,
        protectionMode: "always-on",
        pasteGuardEnabled: true,
      });
    } else {
      await saveSettings({ ...current, disclosureAcknowledged: true });
      switchTab("settings");
      switchSettingsPage("protection");
    }
    if (welcomeCard) welcomeCard.hidden = true;
    await refreshProtectionStatus();
  });

  // Circular Profile Avatar & Popover
  const profileAvatarBtn = document.getElementById("profile-avatar-btn") as HTMLButtonElement | null;
  const profilePopover = document.getElementById("profile-popover") as HTMLElement | null;
  const setPopoverOpen = (open: boolean): void => {
    if (!profilePopover || !profileAvatarBtn) return;
    profilePopover.hidden = !open;
    profileAvatarBtn.setAttribute("aria-expanded", open ? "true" : "false");
  };
  profileAvatarBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    const nextOpen = Boolean(profilePopover?.hidden);
    setPopoverOpen(nextOpen);
  });
  document.addEventListener("click", (e) => {
    if (!profilePopover || profilePopover.hidden) return;
    const target = e.target as Node | null;
    if (target && !profilePopover.contains(target) && target !== profileAvatarBtn && !profileAvatarBtn?.contains(target)) {
      setPopoverOpen(false);
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && profilePopover && !profilePopover.hidden) {
      setPopoverOpen(false);
      profileAvatarBtn?.focus();
    }
  });
  document.getElementById("profile-goto-account-btn")?.addEventListener("click", () => {
    setPopoverOpen(false);
    switchTab("settings");
    switchSettingsPage("profile");
  });
  document.getElementById("profile-goto-protection-btn")?.addEventListener("click", () => {
    setPopoverOpen(false);
    switchTab("settings");
    switchSettingsPage("protection");
  });
  document.getElementById("profile-goto-appearance-btn")?.addEventListener("click", () => {
    setPopoverOpen(false);
    switchTab("settings");
    switchSettingsPage("appearance");
  });

  // Live Paste Shield pill shortcut
  document.getElementById("live-paste-pill")?.addEventListener("click", async () => {
    const snap = await loadProtectionStatus();
    if (snap.effective.mode === "always-on" && !snap.capability.siteAccessGranted) {
      await requestSiteAccess();
      await refreshProtectionStatus();
      return;
    }
    switchTab("settings");
    switchSettingsPage("protection");
  });
  try {
    const tab = await getActiveWebTab();
    if (tab?.url) currentWebTabUrl = tab.url;
  } catch {
    // Ignored in headless/test environments
  }

  const scanBtn = document.getElementById("scan-btn") as HTMLButtonElement | null;
  const clearDataBtn = document.getElementById("clear-data-btn") as HTMLButtonElement | null;
  const applyMasksBtn = document.getElementById("apply-masks-btn") as HTMLButtonElement | null;
  const removeMasksBtn = document.getElementById("remove-masks-btn") as HTMLButtonElement | null;
  const copyRedactedBtn = document.getElementById("copy-redacted-btn") as HTMLButtonElement | null;
  const copyDialog = document.getElementById("copy-dialog") as HTMLDialogElement | null;
  const copyCancel = document.getElementById("copy-cancel") as HTMLButtonElement | null;
  const copyConfirm = document.getElementById("copy-confirm") as HTMLButtonElement | null;
  const localRadio = document.getElementById("mode-local") as HTMLInputElement | null;
  const cloudRadio = document.getElementById("mode-cloud") as HTMLInputElement | null;

  const privacyLink = document.getElementById("privacy-link") as HTMLAnchorElement | null;
  if (privacyLink) {
    const privacyUrl = chrome.runtime.getURL("privacy.html");
    privacyLink.href = privacyUrl;
    privacyLink.target = "_blank";
    privacyLink.rel = "noopener noreferrer";
  }

  const termsLink = document.getElementById("terms-link") as HTMLAnchorElement | null;
  if (termsLink) {
    const termsUrl = chrome.runtime.getURL("legal.html");
    termsLink.href = termsUrl;
    termsLink.target = "_blank";
    termsLink.rel = "noopener noreferrer";
  }

  const aboutPrivacyLink = document.getElementById("about-privacy-link") as HTMLAnchorElement | null;
  if (aboutPrivacyLink) {
    aboutPrivacyLink.href = chrome.runtime.getURL("privacy.html");
    aboutPrivacyLink.target = "_blank";
    aboutPrivacyLink.rel = "noopener noreferrer";
  }

  const docFile = document.getElementById("doc-file-input") as HTMLInputElement | null;
  const docRedactBtn = document.getElementById("doc-redact-btn") as HTMLButtonElement | null;
  const docOpenReviewBtn = document.getElementById("doc-open-review-btn") as HTMLButtonElement | null;
  const docClearBtn = document.getElementById("doc-clear-btn") as HTMLButtonElement | null;
  const docConfirmDialog = document.getElementById("doc-confirm-dialog") as HTMLDialogElement | null;
  const docCancel = document.getElementById("doc-cancel") as HTMLButtonElement | null;
  const docConfirm = document.getElementById("doc-confirm") as HTMLButtonElement | null;
  const printBar = document.getElementById("doc-print-bar") as HTMLElement | null;
  const docPrintBtn = document.getElementById("doc-print-btn") as HTMLButtonElement | null;

  /** Store key of the last verified redaction, if one is still staged. */
  let lastPrintFileKey: string | null = null;

  scanBtn?.addEventListener("click", async () => {
    const current = await loadSettings();
    speakAnnouncement(t(current.language, "speech_scan_start"), current);
    const mode: ScanMode = lastState?.mode ?? current.mode;
    const targetTab = await getActiveWebTab();
    if (targetTab?.id) {
      if (targetTab.url) currentWebTabUrl = targetTab.url;
      void sendMessage({ type: "POPUP_SCAN", requestId: requestId(), mode, tabId: targetTab.id });
    } else {
      void sendMessage({ type: "POPUP_SCAN", requestId: requestId(), mode });
    }
  });

  clearDataBtn?.addEventListener("click", async () => {
    void sendMessage({ type: "POPUP_CLEAR_DATA", requestId: requestId() });
    const current = await loadSettings();
    speakAnnouncement(t(current.language, "speech_session_cleared"), current);
  });

  document.getElementById("open-side-panel-btn")?.addEventListener("click", async () => {
    try {
      if (typeof chrome !== "undefined" && chrome.sidePanel && typeof chrome.sidePanel.open === "function") {
        const windowId = currentWindowId ?? (await chrome.windows.getCurrent()).id;
        if (windowId != null) {
          await chrome.sidePanel.open({ windowId });
          return;
        }
      }
      // Cross-browser fallback for Firefox/Safari/older Chromium without sidePanel API
      if (typeof chrome !== "undefined" && chrome.windows && typeof chrome.windows.create === "function") {
        await chrome.windows.create({
          url: chrome.runtime.getURL("sidepanel.html"),
          type: "popup",
          width: 440,
          height: 680,
        });
      } else if (typeof chrome !== "undefined" && chrome.tabs && typeof chrome.tabs.create === "function") {
        await chrome.tabs.create({ url: chrome.runtime.getURL("sidepanel.html") });
      }
    } catch {
      try {
        window.open(chrome.runtime.getURL("sidepanel.html"), "_blank");
      } catch {
        // Ignored
      }
    }
  });

  applyMasksBtn?.addEventListener("click", async () => {
    if (!lastState) return;
    const ids = currentSelectedIds(lastState);
    void sendMessage({ type: "POPUP_APPLY_MASKS", requestId: requestId(), findingIds: ids });
    const current = await loadSettings();
    speakAnnouncement(t(current.language, "speech_masks_applied", { count: ids.length }), current);
    if (current.autoCopySanitized && ids.length > 0) {
      void sendMessage({ type: "POPUP_COPY_REDACTED", requestId: requestId(), findingIds: ids });
    }
  });

  removeMasksBtn?.addEventListener("click", async () => {
    void sendMessage({ type: "POPUP_REMOVE_MASKS", requestId: requestId() });
    const current = await loadSettings();
    speakAnnouncement(t(current.language, "speech_masks_removed"), current);
  });

  document.getElementById("undo-masks-btn")?.addEventListener("click", () => {
    void sendMessage({ type: "POPUP_UNDO_MASKS", requestId: requestId() });
  });

  copyRedactedBtn?.addEventListener("click", () => {
    if (!lastState || currentSelectedIds(lastState).length === 0) return;
    copyDialog?.showModal();
  });

  copyCancel?.addEventListener("click", () => copyDialog?.close());
  copyConfirm?.addEventListener("click", async () => {
    copyDialog?.close();
    if (!lastState) return;
    const ids = currentSelectedIds(lastState);
    void sendMessage({ type: "POPUP_COPY_REDACTED", requestId: requestId(), findingIds: ids });
    const current = await loadSettings();
    speakAnnouncement(t(current.language, "speech_copied_redacted"), current);
  });

  // Select / Deselect all findings in scanner
  const toggleAllFindingsBtn = document.getElementById("toggle-all-findings-btn") as HTMLButtonElement | null;
  toggleAllFindingsBtn?.addEventListener("click", () => {
    if (!lastState || lastState.findings.length === 0) return;
    const anyUnselected = lastState.findings.some((f) => !f.selected && f.source !== "attr");
    const findingIds = anyUnselected
      ? lastState.findings.filter((f) => f.source !== "attr").map((f) => f.id)
      : [];
    void sendMessage({ type: "POPUP_APPLY_MASKS", requestId: requestId(), findingIds });
  });

  const exportBtn = document.getElementById("export-findings-btn") as HTMLButtonElement | null;
  const exportFormatMenu = document.getElementById("export-format-menu") as HTMLElement | null;
  const exportCsvBtn = document.getElementById("export-csv-btn") as HTMLButtonElement | null;
  const exportJsonBtn = document.getElementById("export-json-btn") as HTMLButtonElement | null;
  const exportCancelBtn = document.getElementById("export-cancel-btn") as HTMLButtonElement | null;

  exportBtn?.addEventListener("click", () => {
    if (!lastState || lastState.findings.length === 0) return;
    if (exportFormatMenu) {
      exportFormatMenu.hidden = !exportFormatMenu.hidden;
    }
  });
  exportCsvBtn?.addEventListener("click", async () => {
    if (exportFormatMenu) exportFormatMenu.hidden = true;
    if (!lastState || lastState.findings.length === 0) return;
    await exportFindings(lastState.findings, "csv");
  });
  exportJsonBtn?.addEventListener("click", async () => {
    if (exportFormatMenu) exportFormatMenu.hidden = true;
    if (!lastState || lastState.findings.length === 0) return;
    await exportFindings(lastState.findings, "json");
  });
  exportCancelBtn?.addEventListener("click", () => {
    if (exportFormatMenu) exportFormatMenu.hidden = true;
  });

  docFile?.addEventListener("change", async () => {
    const file = docFile.files?.[0];
    if (!file) return;
    if (file.size > MAX_DOC_BYTES) {
      setDocStatus(t(currentLang, "doc_too_large", { size: MAX_DOC_BYTES_LABEL }), true);
      return;
    }
    const fileKey = requestId();
    try {
      const bytes = await file.arrayBuffer();
      const kind: DocKind = detectDocKind(file, bytes);
      const mimeType =
        file.type ||
        (kind === "pdf" ? "application/pdf" : kind === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "image/png");
      await storeFile(fileKey, bytes);
      docFile.value = "";
      // Count first, then scan: the count is what lets a document longer than
      // one pass offer the user a choice of pages instead of silently losing
      // everything past the cap.
      startCount(fileKey, file.name, mimeType, kind);
    } catch (error) {
      await deleteFile(fileKey).catch(() => undefined);
      docFile.value = "";
      setDocStatus(error instanceof Error ? error.message : "Could not read this file.", true);
    }
  });

  // Document Style & OCR Language Selectors
  const docStyleSelect = document.getElementById("doc-style-select") as HTMLSelectElement | null;
  const docStampContainer = document.getElementById("doc-stamp-container") as HTMLDivElement | null;
  const docStampText = document.getElementById("doc-stamp-text") as HTMLInputElement | null;
  const docStampPresets = document.getElementById("doc-stamp-presets") as HTMLSelectElement | null;
  const docOcrLangSelect = document.getElementById("doc-ocr-language-select") as HTMLSelectElement | null;
  const ocrLangSelect = document.getElementById("ocr-language-select") as HTMLSelectElement | null;

  const syncOcrLanguage = async (val: string) => {
    if (ocrLangSelect && ocrLangSelect.value !== val) ocrLangSelect.value = val;
    if (docOcrLangSelect && docOcrLangSelect.value !== val) docOcrLangSelect.value = val;
    const current = await loadSettings();
    await saveSettings({ ...current, ocrLanguage: val });
  };

  // Populate the language selectors from the bundled set at runtime, and drop any
  // option whose data is not in the package. The markup used to list six
  // languages while only English was vendored, so selecting another one silently
  // ran English OCR. Deriving the list from BUNDLED_OCR_LANGUAGES means the
  // selector can never advertise a language the extension cannot read offline.
  for (const select of [ocrLangSelect, docOcrLangSelect]) {
    if (!select) continue;
    const currentValue = select.value;
    select.replaceChildren(
      ...BUNDLED_OCR_LANGUAGES.map((lang) => {
        const opt = document.createElement("option");
        opt.value = lang.code;
        opt.textContent = `${lang.label} (${lang.code})`;
        return opt;
      })
    );
    const wanted = settings.ocrLanguage || "eng";
    select.value = BUNDLED_OCR_LANGUAGES.some((l) => l.code === wanted) ? wanted : currentValue || "eng";
    select.addEventListener("change", () => void syncOcrLanguage(select.value));
  }

  if (docStyleSelect) {
    docStyleSelect.value = settings.defaultRedactionStyle || "blackout";
    docStyleSelect.addEventListener("change", () => {
      if (docStampContainer) {
        docStampContainer.hidden = docStyleSelect.value !== "stamp";
      }
      redrawAllOverlays();
    });
  }

  if (docStampPresets && docStampText) {
    docStampPresets.addEventListener("change", () => {
      docStampText.value = docStampPresets.value;
      redrawAllOverlays();
    });
  }

  if (docStampText) {
    docStampText.value = settings.defaultStampText || "[REDACTED]";
    docStampText.addEventListener("input", () => {
      redrawAllOverlays();
    });
  }

  // Document Studio Canvas Tools
  const toolDrawBox = document.getElementById("tool-draw-box") as HTMLButtonElement | null;
  const toolClearCustom = document.getElementById("tool-clear-custom") as HTMLButtonElement | null;
  const toolToggleAllDoc = document.getElementById("tool-toggle-all-doc") as HTMLButtonElement | null;
  const toolSaveLocationRule = document.getElementById("tool-save-location-rule") as HTMLButtonElement | null;
  const docLocationRuleStatus = document.getElementById("doc-location-rule-status") as HTMLParagraphElement | null;

  toolDrawBox?.addEventListener("click", () => {
    currentStudioTool = "draw";
    toolDrawBox.classList.add("tool-btn--active");
  });

  toolSaveLocationRule?.addEventListener("click", () => {
    if (!lastDoc) return;
    const samples: SelectionSample[] = [];
    for (const page of lastDoc.pages) {
      for (const finding of page.findings) {
        if (finding.category === "custom" && finding.rects.length > 0) {
          const rect = finding.rects[0];
          if (rect) {
            samples.push({
              pageNumber: page.index + 1,
              pageWidth: page.widthPx,
              pageHeight: page.heightPx,
              rect,
            });
          }
        }
      }
    }
    const analysis = inferLocationRule(samples);
    if (docLocationRuleStatus) {
      docLocationRuleStatus.hidden = false;
      if (!analysis.eligible || !analysis.rule) {
        docLocationRuleStatus.textContent = analysis.reasons.join(" ");
        return;
      }
      const rulePattern: CustomPattern = {
        id: crypto.randomUUID(),
        name: `Document Region (${Math.round(analysis.rule.region.x * 100)}%, ${Math.round(analysis.rule.region.y * 100)}%)`,
        category: "custom",
        confidence: analysis.rule.confidence,
        createdAt: new Date().toISOString(),
        source: "local",
        contributionStatus: "local_only",
        strategy: "location",
        location: analysis.rule,
      };
      void chrome.runtime.sendMessage({
        type: "POPUP_CUSTOM_PATTERN_SAVE",
        requestId: requestId(),
        pattern: rulePattern,
      });
      docLocationRuleStatus.textContent = `Saved reusable Location Rule (${Math.round(analysis.rule.confidence * 100)}% consistency across ${samples.length} boxes).`;
    }
  });

  toolClearCustom?.addEventListener("click", () => {
    if (!lastDoc) return;
    for (const page of lastDoc.pages) {
      page.findings = page.findings.filter((f) => {
        if (f.category === "custom") {
          selectedDocFindingIds.delete(f.id);
          return false;
        }
        return true;
      });
    }
    renderDocFindings();
    redrawAllOverlays();
  });

  toolToggleAllDoc?.addEventListener("click", () => {
    if (!lastDoc) return;
    const allFindings = lastDoc.pages.flatMap((p) => p.findings);
    const anyUnselected = allFindings.some((f) => !selectedDocFindingIds.has(f.id));
    if (anyUnselected) {
      for (const f of allFindings) {
        selectedDocFindingIds.add(f.id);
        f.selected = true;
      }
    } else {
      selectedDocFindingIds.clear();
      for (const f of allFindings) {
        f.selected = false;
      }
    }
    renderDocFindings();
    redrawAllOverlays();
  });

  docRedactBtn?.addEventListener("click", () => {
    if (!lastDoc || selectedDocFindingIds.size === 0) return;
    docConfirmDialog?.showModal();
  });

  docCancel?.addEventListener("click", () => docConfirmDialog?.close());

  // Opens the read-only print view in a tab. The button is only revealed after a
  // redaction reported a staged print handle, so there is always a document to
  // show; the guard here covers the case where the staged pages were since
  // cleared from the store.
  docPrintBtn?.addEventListener("click", () => {
    if (!lastPrintFileKey) return;
    void sendDocMessage({ type: "POPUP_DOC_PRINT", requestId: requestId(), fileKey: lastPrintFileKey });
  });

  // Opens the full-screen review surface.
  //
  // The studio in a 360px popup renders a page of text at roughly a tenth of
  // its natural size, so drawing a box over it means drawing blind, and the
  // thumbnail is too small to check the words at all. review.html shows the
  // document at full size with every control beside it. It is opened from a
  // click handler, which is the gesture a popup needs to open a tab at all.
  docOpenReviewBtn?.addEventListener("click", () => {
    if (!lastDoc || lastDoc.pages.length === 0) {
      setDocStatus("Preview the document first, then open review.", true);
      return;
    }
    void openFullScreenReview(lastDoc, lastDoc.degraded === true, lastDoc.source === "capture" ? "capture" : "original");
  });

  docConfirm?.addEventListener("click", async () => {
    docConfirmDialog?.close();
    if (!lastDoc) return;
    const boxes = buildDocBoxes();
    const ids = [...selectedDocFindingIds];
    if (boxes.length === 0) return;
    setDocStatus("Preparing redacted copy…", false);
    const current = await loadSettings();
    const style = (docStyleSelect?.value as RedactionStyle) || current.defaultRedactionStyle || "blackout";
    const stampText = docStampText?.value?.trim() || current.defaultStampText || "[REDACTED]";
    void sendDocMessage({
      type: "POPUP_DOC_REDACT",
      requestId: requestId(),
      docId: lastDoc.docId,
      fileKey: lastDoc.fileKey,
      name: lastDoc.name,
      mimeType: lastDoc.mimeType,
      kind: lastDoc.kind,
      boxes,
      findingIds: ids,
      options: {
        style,
        stampText,
        padding: current.maskPadding,
        fillColor: current.maskColor,
      },
    });
  });

  docClearBtn?.addEventListener("click", () => {
    const targetDocId = lastDoc?.docId || undefined;
    const targetFileKey = lastDoc?.fileKey ?? activeDocFileKey ?? undefined;
    if (targetDocId || targetFileKey) {
      void sendDocMessage({
        type: "POPUP_DOC_CLEAR",
        requestId: requestId(),
        ...(targetDocId ? { docId: targetDocId } : {}),
        ...(targetFileKey ? { fileKey: targetFileKey } : {}),
      });
    }
    clearDocUi();
    setDocStatus("", false);
  });

  const docCancelBtn = document.getElementById("doc-cancel-btn") as HTMLButtonElement | null;

  docCancelBtn?.addEventListener("click", () => {
    const targetFileKey = lastDoc?.fileKey || pendingCountFile?.fileKey || activeDocFileKey || undefined;
    const targetDocId = lastDoc?.docId || undefined;
    const targetRequestId = activeDocRequestId || undefined;
    if (targetFileKey) cancelledDocTokens.add(targetFileKey);
    if (targetDocId) cancelledDocTokens.add(targetDocId);
    if (targetRequestId) cancelledDocTokens.add(targetRequestId);
    pendingCountFile = null;
    if (targetDocId || targetFileKey) {
      void sendDocMessage({
        type: "POPUP_DOC_CANCEL",
        requestId: requestId(),
        ...(targetDocId ? { docId: targetDocId } : {}),
        ...(targetFileKey ? { fileKey: targetFileKey } : {}),
      });
    }
    hideDocProgress();
    clearDocUi();
    setDocStatus("Document processing cancelled.", false);
    void refreshStagedStorageAudit();
  });

  const docPurgeStagedBtn = document.getElementById("doc-purge-staged-btn") as HTMLButtonElement | null;
  const docPurgeConfirmBar = document.getElementById("doc-purge-confirm-bar") as HTMLElement | null;
  const docPurgeConfirmYes = document.getElementById("doc-purge-confirm-yes") as HTMLButtonElement | null;
  const docPurgeConfirmNo = document.getElementById("doc-purge-confirm-no") as HTMLButtonElement | null;
  const docStagedConfirmMsg = document.getElementById("doc-staged-confirm-msg") as HTMLElement | null;

  docPurgeStagedBtn?.addEventListener("click", () => {
    if (docStagedConfirmMsg) {
      docStagedConfirmMsg.hidden = true;
      docStagedConfirmMsg.textContent = "";
    }
    if (docPurgeConfirmBar) {
      docPurgeConfirmBar.hidden = false;
    }
  });

  docPurgeConfirmNo?.addEventListener("click", () => {
    if (docPurgeConfirmBar) {
      docPurgeConfirmBar.hidden = true;
    }
  });

  docPurgeConfirmYes?.addEventListener("click", () => {
    if (docPurgeConfirmBar) {
      docPurgeConfirmBar.hidden = true;
    }
    const docProgressEl = document.getElementById("doc-progress");
    const isInFlight = Boolean(docProgressEl && !docProgressEl.hidden);
    if (!isInFlight) {
      clearDocUi();
      setDocStatus("", false);
    }
    void sendDocMessage({
      type: "POPUP_PURGE_STAGED_DATA",
      requestId: requestId(),
      includeIdleSession: !isInFlight,
    });
  });

  void refreshStagedStorageAudit();

  // ── Page-window chooser (documents longer than one pass) ────────────────
  const windowDialog = document.getElementById("doc-window-dialog") as HTMLDialogElement | null;
  const windowConfirm = document.getElementById("doc-window-confirm") as HTMLButtonElement | null;
  const windowCancel = document.getElementById("doc-window-cancel") as HTMLButtonElement | null;

  windowConfirm?.addEventListener("click", () => {
    const pending = pendingCountFile;
    if (!pending) return;
    // The document's length was learned from the worker's count; the choice is
    // validated against it, then converted to the offset the pipeline wants.
    const offset = readWindowChoice(windowTotalPages);
    if (offset === null) return;
    windowDialog?.close();
    startPreview(offset, windowTotalPages);
  });

  windowCancel?.addEventListener("click", () => {
    pendingCountFile = null;
    windowDialog?.close();
    hideDocProgress();
    clearDocUi();
    setDocStatus("Document scanning cancelled. Pick a file to start again.", false);
  });

  // Re-choose the window for a document already loaded, continuing after the
  // pass that just finished rather than offering the same pages again.
  const windowRescan = document.getElementById("doc-window-rescan-btn") as HTMLButtonElement | null;
  windowRescan?.addEventListener("click", () => {
    const doc = lastDoc;
    if (!doc) return;
    const total = doc.totalPages ?? doc.pages.length;
    if (total <= MAX_DOC_PAGES) return;
    pendingCountFile = { fileKey: doc.fileKey, name: doc.name, mimeType: doc.mimeType, kind: doc.kind };
    openWindowDialog(total, (doc.pageOffset ?? 0) + doc.pages.length + 1);
  });

  const persistHandoff = async (items: Record<string, unknown>): Promise<void> => {
    try {
      await chrome.storage?.local?.set(items);
    } catch {
      // Ignore storage persistence errors during handoff
    }
  };

  const openDocBtn = document.getElementById("open-doc-btn") as HTMLButtonElement | null;
  const triggerDocumentSelection = async (): Promise<void> => {
    if (!isDocumentPipelineSupported()) {
      setDocStatus(DOCUMENT_PIPELINE_UNAVAILABLE_MESSAGE, true);
      return;
    }
    if (
      !isSidePanelContext &&
      typeof chrome !== "undefined" &&
      chrome.sidePanel?.open &&
      currentWindowId !== undefined
    ) {
      const handoffWrite = persistHandoff({ docHandoffPending: { timestamp: Date.now() } });
      try {
        await chrome.sidePanel.open({ windowId: currentWindowId });
        await handoffWrite;
        window.close();
        return;
      } catch (err) {
        console.warn("[GovernWorld] SidePanel doc handoff fallback:", sanitizeErrorForLog(err));
        try {
          await chrome.storage?.local?.remove("docHandoffPending");
        } catch {
          // Ignore cleanup error
        }
        docFile?.click();
        setDocStatus(t(currentLang, "doc_picker_fallback_hint"), false);
        return;
      }
    }
    docFile?.click();
  };
  openDocBtn?.addEventListener("click", () => {
    void triggerDocumentSelection();
  });

  const dropzone = document.getElementById("doc-dropzone") as HTMLDivElement | null;
  if (dropzone && docFile) {
    if (!isDocumentPipelineSupported()) {
      setDocStatus(DOCUMENT_PIPELINE_UNAVAILABLE_MESSAGE, false);
    }
    const handleDroppedFile = async (file: File): Promise<void> => {
      if (!isDocumentPipelineSupported()) {
        setDocStatus(DOCUMENT_PIPELINE_UNAVAILABLE_MESSAGE, true);
        return;
      }
      if (file.size > MAX_DOC_BYTES) {
        setDocStatus(t(currentLang, "doc_too_large", { size: MAX_DOC_BYTES_LABEL }), true);
        return;
      }
      const fileKey = requestId();
      try {
        const bytes = await file.arrayBuffer();
        const kind: DocKind = detectDocKind(file, bytes);
        const mimeType =
          file.type ||
          (kind === "pdf" ? "application/pdf" : kind === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "image/png");
        await storeFile(fileKey, bytes);
        // Same count-then-window flow the file picker uses, so a dropped
        // document can never take a path the picked one does not.
        startCount(fileKey, file.name, mimeType, kind);
      } catch (error) {
        await deleteFile(fileKey).catch(() => undefined);
        setDocStatus(error instanceof Error ? error.message : "Could not read this file.", true);
      }
    };
    dropzone.addEventListener("click", (e) => {
      if (e.target === docFile) return;
      void triggerDocumentSelection();
    });
    dropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropzone.classList.add("doc-dropzone--active");
    });
    dropzone.addEventListener("dragleave", () => {
      dropzone.classList.remove("doc-dropzone--active");
    });
    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropzone.classList.remove("doc-dropzone--active");
      const file = e.dataTransfer?.files?.[0];
      if (file) void handleDroppedFile(file);
    });
    dropzone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        void triggerDocumentSelection();
      }
    });
  }

  localRadio?.addEventListener("change", () => {
    void sendMessage({ type: "POPUP_SET_MODE", requestId: requestId(), mode: "local" });
  });
  cloudRadio?.addEventListener("change", () => {
    void sendMessage({ type: "POPUP_SET_MODE", requestId: requestId(), mode: "cloud" });
  });

  const presetSelect = document.getElementById("preset-select") as HTMLSelectElement | null;
  presetSelect?.addEventListener("change", async () => {
    const presetId = presetSelect.value as PresetId;
    await applyPreset(presetId);
  });

  // Category Filter Buttons
  document.getElementById("cat-filter-all")?.addEventListener("click", () => void applyCategoryFilter(ALL_CATEGORIES));
  document.getElementById("cat-filter-health")?.addEventListener("click", () => void applyCategoryFilter(HEALTHCARE_CATEGORIES));
  document.getElementById("cat-filter-intl")?.addEventListener("click", () => void applyCategoryFilter(INTERNATIONAL_CATEGORIES));
  document.getElementById("cat-filter-finance")?.addEventListener("click", () => void applyCategoryFilter(FINANCIAL_CATEGORIES));
  document.getElementById("cat-filter-none")?.addEventListener("click", () => void applyCategoryFilter([]));

  const placeholderToggle = document.getElementById("placeholder-toggle") as HTMLInputElement | null;
  if (placeholderToggle) {
    placeholderToggle.checked = settings.maskPlaceholders;
    placeholderToggle.setAttribute("aria-checked", placeholderToggle.checked ? "true" : "false");
    placeholderToggle.addEventListener("change", async () => {
      placeholderToggle.setAttribute("aria-checked", placeholderToggle.checked ? "true" : "false");
      const current = await loadSettings();
      await saveSettings({ ...current, maskPlaceholders: placeholderToggle.checked });
    });
  }

  const pasteGuardToggle = document.getElementById("paste-guard-toggle") as HTMLInputElement | null;
  const alwaysOnToggle = document.getElementById("always-on-toggle") as HTMLInputElement | null;
  const grantAccessBtn = document.getElementById("grant-access-btn") as HTMLButtonElement | null;

  /** Persist a user mode change; locked policies reject it before storage. */
  async function saveUserMode(mode: ProtectionMode): Promise<void> {
    const policy = await loadEnterprisePolicy();
    if (policy.managed && !policy.userCanDisable) return;
    const current = await loadSettings();
    await saveSettings({ ...current, protectionMode: mode, pasteGuardEnabled: mode !== "off" });
    await refreshProtectionStatus();
  }

  if (pasteGuardToggle) {
    pasteGuardToggle.addEventListener("change", async () => {
      if (pasteGuardToggle.disabled) {
        await refreshProtectionStatus();
        return;
      }
      if (!pasteGuardToggle.checked) {
        const alwaysOn = document.getElementById("always-on-toggle") as HTMLInputElement | null;
        if (alwaysOn) setModeToggle(alwaysOn, false, alwaysOn.disabled);
        await saveUserMode("off");
        return;
      }
      const wantAlwaysOn =
        (document.getElementById("always-on-toggle") as HTMLInputElement | null)?.checked === true;
      if (wantAlwaysOn) {
        const granted = await requestSiteAccess();
        await saveUserMode(granted ? "always-on" : "this-tab");
      } else {
        await saveUserMode("this-tab");
      }
    });
  }

  if (alwaysOnToggle) {
    alwaysOnToggle.addEventListener("change", async () => {
      if (alwaysOnToggle.disabled) {
        await refreshProtectionStatus();
        return;
      }
      if (!alwaysOnToggle.checked) {
        const current = await loadSettings();
        await saveUserMode(current.protectionMode === "off" ? "off" : "this-tab");
        return;
      }
      // Checked: access first, mode second. A denied prompt leaves this-tab
      // armed rather than a dead always-on selection.
      const granted = await requestSiteAccess();
      if (granted) {
        await saveUserMode("always-on");
      } else {
        await refreshProtectionStatus();
      }
    });
  }

  grantAccessBtn?.addEventListener("click", async () => {
    await requestSiteAccess();
    // The worker arms a pending always-on request on the permission-added
    // event; refresh here so the banner reflects the grant immediately.
    await refreshProtectionStatus();
  });

  // --- General & Appearance Controls ---
  const langSelect = document.getElementById("lang-select") as HTMLSelectElement | null;
  if (langSelect) {
    langSelect.value = settings.language;
    langSelect.addEventListener("change", async () => {
      const newLang = langSelect.value as LanguageCode;
      const current = await loadSettings();
      const updated = { ...current, language: newLang };
      await saveSettings(updated);
      applyUiLanguage(newLang);
      await refreshProtectionStatus();
      if (lastState) {
        renderState(lastState);
      } else {
        await refreshReviewTelemetry();
      }
      await checkOfficeManagerPairingStatus();
      syncProfilePopoverSummary();
      speakAnnouncement(t(newLang, "speech_settings_saved"), updated);
    });
  }

  const fontSizeSelect = document.getElementById("font-size-select") as HTMLSelectElement | null;
  if (fontSizeSelect) {
    fontSizeSelect.value = settings.fontSize;
    fontSizeSelect.addEventListener("change", async () => {
      const newSize = fontSizeSelect.value as FontSizeScale;
      const current = await loadSettings();
      const updated = { ...current, fontSize: newSize };
      await saveSettings(updated);
      applyAccessibilitySettings(updated);
      speakAnnouncement(t(updated.language, "speech_settings_saved"), updated);
    });
  }

  const highContrastToggle = document.getElementById("high-contrast-toggle") as HTMLInputElement | null;
  if (highContrastToggle) {
    highContrastToggle.checked = settings.highContrast;
    highContrastToggle.setAttribute("aria-checked", settings.highContrast ? "true" : "false");
    highContrastToggle.addEventListener("change", async () => {
      highContrastToggle.setAttribute("aria-checked", highContrastToggle.checked ? "true" : "false");
      const current = await loadSettings();
      const updated = { ...current, highContrast: highContrastToggle.checked };
      await saveSettings(updated);
      applyAccessibilitySettings(updated);
      speakAnnouncement(t(updated.language, "speech_settings_saved"), updated);
    });
  }

  const dyslexiaToggle = document.getElementById("dyslexia-toggle") as HTMLInputElement | null;
  if (dyslexiaToggle) {
    dyslexiaToggle.checked = settings.dyslexiaMode;
    dyslexiaToggle.setAttribute("aria-checked", settings.dyslexiaMode ? "true" : "false");
    dyslexiaToggle.addEventListener("change", async () => {
      dyslexiaToggle.setAttribute("aria-checked", dyslexiaToggle.checked ? "true" : "false");
      const current = await loadSettings();
      const updated = { ...current, dyslexiaMode: dyslexiaToggle.checked };
      await saveSettings(updated);
      applyAccessibilitySettings(updated);
      speakAnnouncement(t(updated.language, "speech_settings_saved"), updated);
    });
  }

  const reducedMotionToggle = document.getElementById("reduced-motion-toggle") as HTMLInputElement | null;
  if (reducedMotionToggle) {
    reducedMotionToggle.checked = settings.reducedMotion;
    reducedMotionToggle.setAttribute("aria-checked", settings.reducedMotion ? "true" : "false");
    reducedMotionToggle.addEventListener("change", async () => {
      reducedMotionToggle.setAttribute("aria-checked", reducedMotionToggle.checked ? "true" : "false");
      const current = await loadSettings();
      const updated = { ...current, reducedMotion: reducedMotionToggle.checked };
      await saveSettings(updated);
      applyAccessibilitySettings(updated);
      speakAnnouncement(t(updated.language, "speech_settings_saved"), updated);
    });
  }

  // --- Accessibility & Assistive Tools Controls ---
  const speechToggle = document.getElementById("speech-toggle") as HTMLInputElement | null;
  if (speechToggle) {
    speechToggle.checked = settings.speechAnnouncements;
    speechToggle.setAttribute("aria-checked", settings.speechAnnouncements ? "true" : "false");
    speechToggle.addEventListener("change", async () => {
      speechToggle.setAttribute("aria-checked", speechToggle.checked ? "true" : "false");
      const current = await loadSettings();
      const updated = { ...current, speechAnnouncements: speechToggle.checked };
      await saveSettings(updated);
      speakAnnouncement(t(updated.language, "speech_settings_saved"), updated);
    });
  }

  const verboseAriaToggle = document.getElementById("verbose-aria-toggle") as HTMLInputElement | null;
  if (verboseAriaToggle) {
    verboseAriaToggle.checked = settings.ariaVerboseMode;
    verboseAriaToggle.setAttribute("aria-checked", settings.ariaVerboseMode ? "true" : "false");
    verboseAriaToggle.addEventListener("change", async () => {
      verboseAriaToggle.setAttribute("aria-checked", verboseAriaToggle.checked ? "true" : "false");
      const current = await loadSettings();
      const updated = { ...current, ariaVerboseMode: verboseAriaToggle.checked };
      await saveSettings(updated);
    });
  }

  // --- Mask Padding & Color Controls ---
  const maskPaddingSelect = document.getElementById("mask-padding-select") as HTMLSelectElement | null;
  if (maskPaddingSelect) {
    maskPaddingSelect.value = String(settings.maskPadding);
    maskPaddingSelect.addEventListener("change", async () => {
      const pad = parseInt(maskPaddingSelect.value, 10) ?? 4;
      const current = await loadSettings();
      await saveSettings({ ...current, maskPadding: pad });
    });
  }

  const maskColorSelect = document.getElementById("mask-color-select") as HTMLSelectElement | null;
  if (maskColorSelect) {
    maskColorSelect.value = settings.maskColor;
    maskColorSelect.addEventListener("change", async () => {
      const current = await loadSettings();
      await saveSettings({ ...current, maskColor: maskColorSelect.value });
    });
  }

  // --- Proactive Protection & Context Menus Controls ---
  const contextMenusToggle = document.getElementById("context-menus-toggle") as HTMLInputElement | null;
  if (contextMenusToggle) {
    contextMenusToggle.checked = settings.contextMenusEnabled;
    contextMenusToggle.setAttribute("aria-checked", settings.contextMenusEnabled ? "true" : "false");
    contextMenusToggle.addEventListener("change", async () => {
      contextMenusToggle.setAttribute("aria-checked", contextMenusToggle.checked ? "true" : "false");
      const current = await loadSettings();
      await saveSettings({ ...current, contextMenusEnabled: contextMenusToggle.checked });
    });
  }

  // --- Auto-Copy & Session Timeout Controls ---
  const autoCopyToggle = document.getElementById("auto-copy-toggle") as HTMLInputElement | null;
  if (autoCopyToggle) {
    autoCopyToggle.checked = settings.autoCopySanitized;
    autoCopyToggle.setAttribute("aria-checked", settings.autoCopySanitized ? "true" : "false");
    autoCopyToggle.addEventListener("change", async () => {
      autoCopyToggle.setAttribute("aria-checked", autoCopyToggle.checked ? "true" : "false");
      const current = await loadSettings();
      await saveSettings({ ...current, autoCopySanitized: autoCopyToggle.checked });
    });
  }

  const sessionTimeoutSelect = document.getElementById("session-timeout-select") as HTMLSelectElement | null;
  if (sessionTimeoutSelect) {
    sessionTimeoutSelect.value = settings.sessionTimeout;
    sessionTimeoutSelect.addEventListener("change", async () => {
      const current = await loadSettings();
      await saveSettings({ ...current, sessionTimeout: sessionTimeoutSelect.value as SessionTimeoutOption });
    });
  }

  // --- Document Studio Defaults ---
  const defaultDocStyleSelect = document.getElementById("default-doc-style-select") as HTMLSelectElement | null;
  if (defaultDocStyleSelect) {
    defaultDocStyleSelect.value = settings.defaultRedactionStyle;
    defaultDocStyleSelect.addEventListener("change", async () => {
      const current = await loadSettings();
      await saveSettings({ ...current, defaultRedactionStyle: defaultDocStyleSelect.value as RedactionStyle });
      if (docStyleSelect) docStyleSelect.value = defaultDocStyleSelect.value;
      if (docStampContainer) docStampContainer.hidden = docStyleSelect?.value !== "stamp";
      redrawAllOverlays();
    });
  }

  const defaultDocStampInput = document.getElementById("default-doc-stamp-input") as HTMLInputElement | null;
  const defaultDocStampPresets = document.getElementById("default-doc-stamp-presets") as HTMLSelectElement | null;

  const applyDefaultStampText = async (raw: string) => {
    const val = raw.trim() || "[REDACTED]";
    const current = await loadSettings();
    await saveSettings({ ...current, defaultStampText: val });
    if (docStampText) {
      docStampText.value = val;
      redrawAllOverlays();
    }
  };

  if (defaultDocStampInput) {
    defaultDocStampInput.value = settings.defaultStampText;
    defaultDocStampInput.addEventListener("change", () => void applyDefaultStampText(defaultDocStampInput.value));
  }
  if (defaultDocStampPresets && defaultDocStampInput) {
    defaultDocStampPresets.addEventListener("change", () => {
      defaultDocStampInput.value = defaultDocStampPresets.value;
      void applyDefaultStampText(defaultDocStampPresets.value);
    });
  }

  // --- Per-Category Confidence Thresholds & Scan Budget Controls ---
  const thresholdCategorySelect = document.getElementById("threshold-category-select") as HTMLSelectElement | null;
  const thresholdValueSelect = document.getElementById("threshold-value-select") as HTMLSelectElement | null;
  const thresholdApplyAllBtn = document.getElementById("threshold-apply-all-btn") as HTMLButtonElement | null;

  thresholdCategorySelect?.addEventListener("change", async () => {
    if (!thresholdValueSelect) return;
    const current = await loadSettings();
    const cat = thresholdCategorySelect.value as FindingCategory;
    const val = current.confidenceThresholds?.[cat] ?? 0.7;
    thresholdValueSelect.value = val.toFixed(2);
  });

  thresholdValueSelect?.addEventListener("change", async () => {
    if (!thresholdCategorySelect) return;
    const cat = thresholdCategorySelect.value as FindingCategory;
    const val = parseFloat(thresholdValueSelect.value) || 0.7;
    const current = await loadSettings();
    const updatedThresholds = { ...(current.confidenceThresholds ?? {}), [cat]: val } as Record<FindingCategory, number>;
    await saveSettings({ ...current, confidenceThresholds: updatedThresholds });
  });

  thresholdApplyAllBtn?.addEventListener("click", async () => {
    if (!thresholdValueSelect) return;
    const val = parseFloat(thresholdValueSelect.value) || 0.7;
    const current = await loadSettings();
    const updatedThresholds = { ...(current.confidenceThresholds ?? {}) } as Record<FindingCategory, number>;
    for (const cat of ALL_CATEGORIES) {
      updatedThresholds[cat] = val;
    }
    await saveSettings({ ...current, confidenceThresholds: updatedThresholds });
  });

  const maxVisibleCharsInput = document.getElementById("max-visible-chars-input") as HTMLInputElement | null;
  if (maxVisibleCharsInput) {
    maxVisibleCharsInput.value = String(settings.maxVisibleChars);
    maxVisibleCharsInput.addEventListener("change", async () => {
      const parsed = Math.max(1000, Math.min(2_000_000, parseInt(maxVisibleCharsInput.value, 10) || 250_000));
      maxVisibleCharsInput.value = String(parsed);
      const current = await loadSettings();
      await saveSettings({ ...current, maxVisibleChars: parsed });
    });
  }

  const maxNodeCharsInput = document.getElementById("max-node-chars-input") as HTMLInputElement | null;
  if (maxNodeCharsInput) {
    maxNodeCharsInput.value = String(settings.maxNodeChars);
    maxNodeCharsInput.addEventListener("change", async () => {
      const parsed = Math.max(200, Math.min(100_000, parseInt(maxNodeCharsInput.value, 10) || 4000));
      maxNodeCharsInput.value = String(parsed);
      const current = await loadSettings();
      await saveSettings({ ...current, maxNodeChars: parsed });
    });
  }

  // --- Reset Settings & Clear Audit Controls ---
  const resetSettingsBtn = document.getElementById("reset-settings-btn") as HTMLButtonElement | null;
  const resetConfirmDialog = document.getElementById("reset-confirm-dialog") as HTMLDialogElement | null;
  const resetCancel = document.getElementById("reset-cancel") as HTMLButtonElement | null;
  const resetConfirm = document.getElementById("reset-confirm") as HTMLButtonElement | null;

  resetSettingsBtn?.addEventListener("click", () => {
    resetConfirmDialog?.showModal();
  });
  resetCancel?.addEventListener("click", () => {
    resetConfirmDialog?.close();
  });
  resetConfirm?.addEventListener("click", async () => {
    resetConfirmDialog?.close();
    const defaults = await resetSettings();
    applyUiLanguage(defaults.language);
    applyAccessibilitySettings(defaults);
    await refreshProtectionStatus();

    if (langSelect) langSelect.value = defaults.language;
    if (fontSizeSelect) fontSizeSelect.value = defaults.fontSize;
    if (highContrastToggle) {
      highContrastToggle.checked = defaults.highContrast;
      highContrastToggle.setAttribute("aria-checked", "false");
    }
    if (dyslexiaToggle) {
      dyslexiaToggle.checked = defaults.dyslexiaMode;
      dyslexiaToggle.setAttribute("aria-checked", "false");
    }
    if (reducedMotionToggle) {
      reducedMotionToggle.checked = defaults.reducedMotion;
      reducedMotionToggle.setAttribute("aria-checked", "false");
    }
    if (speechToggle) {
      speechToggle.checked = defaults.speechAnnouncements;
      speechToggle.setAttribute("aria-checked", "false");
    }
    if (verboseAriaToggle) {
      verboseAriaToggle.checked = defaults.ariaVerboseMode;
      verboseAriaToggle.setAttribute("aria-checked", "false");
    }
    if (placeholderToggle) {
      placeholderToggle.checked = defaults.maskPlaceholders;
      placeholderToggle.setAttribute("aria-checked", "false");
    }
    // Mode toggles, banner, categories, and lock notice are synced by the
    // refreshProtectionStatus() call above.
    if (contextMenusToggle) {
      contextMenusToggle.checked = defaults.contextMenusEnabled;
      contextMenusToggle.setAttribute("aria-checked", "true");
    }
    if (maskPaddingSelect) maskPaddingSelect.value = String(defaults.maskPadding);
    if (maskColorSelect) maskColorSelect.value = defaults.maskColor;
    if (autoCopyToggle) {
      autoCopyToggle.checked = defaults.autoCopySanitized;
      autoCopyToggle.setAttribute("aria-checked", "false");
    }
    if (sessionTimeoutSelect) sessionTimeoutSelect.value = defaults.sessionTimeout;
    if (defaultDocStyleSelect) defaultDocStyleSelect.value = defaults.defaultRedactionStyle;
    if (defaultDocStampInput) defaultDocStampInput.value = defaults.defaultStampText;
    if (ocrLangSelect) ocrLangSelect.value = defaults.ocrLanguage;
    if (docOcrLangSelect) docOcrLangSelect.value = defaults.ocrLanguage;
    if (maxVisibleCharsInput) maxVisibleCharsInput.value = String(defaults.maxVisibleChars);
    if (maxNodeCharsInput) maxNodeCharsInput.value = String(defaults.maxNodeChars);
    if (thresholdCategorySelect && thresholdValueSelect) {
      const selectedCat = (thresholdCategorySelect.value as FindingCategory) || "email";
      const val = defaults.confidenceThresholds?.[selectedCat] ?? 0.7;
      thresholdValueSelect.value = val.toFixed(2);
    }

    speakAnnouncement(t(defaults.language, "speech_settings_reset"), defaults);
  });

  const clearAuditBtn = document.getElementById("clear-audit-btn") as HTMLButtonElement | null;
  const clearAuditDialog = document.getElementById("clear-audit-dialog") as HTMLDialogElement | null;
  const clearAuditCancel = document.getElementById("clear-audit-cancel") as HTMLButtonElement | null;
  const clearAuditConfirm = document.getElementById("clear-audit-confirm") as HTMLButtonElement | null;

  clearAuditBtn?.addEventListener("click", () => {
    clearAuditDialog?.showModal();
  });
  clearAuditCancel?.addEventListener("click", () => {
    clearAuditDialog?.close();
  });
  clearAuditConfirm?.addEventListener("click", async () => {
    clearAuditDialog?.close();
    await chrome.storage.local.remove(["auditLog", "auditCheckpointState"]);
    await refreshReviewTelemetry();
    const current = await loadSettings();
    speakAnnouncement(t(current.language, "audit_cleared"), current);
  });

  document.getElementById("export-audit-btn")?.addEventListener("click", () => {
    void sendMessage({ type: "POPUP_EXPORT_AUDIT", requestId: requestId() });
  });
  document.getElementById("review-export-audit-btn")?.addEventListener("click", () => {
    void sendMessage({ type: "POPUP_EXPORT_AUDIT", requestId: requestId() });
  });

  // ---------- Notifications & Account Settings ----------
  const notificationsToggle = document.getElementById("notifications-toggle") as HTMLInputElement | null;
  const notificationsStatus = document.getElementById("notifications-status") as HTMLParagraphElement | null;
  const notifyToastToggle = document.getElementById("notify-toast-toggle") as HTMLInputElement | null;
  const notifyBadgeToggle = document.getElementById("notify-badge-toggle") as HTMLInputElement | null;
  const notifySoundToggle = document.getElementById("notify-sound-toggle") as HTMLInputElement | null;
  const notifyFindingsToggle = document.getElementById("notify-findings-toggle") as HTMLInputElement | null;
  const notifyPasteToggle = document.getElementById("notify-paste-toggle") as HTMLInputElement | null;
  const notifyPolicyToggle = document.getElementById("notify-policy-toggle") as HTMLInputElement | null;
  const notifyRedactToggle = document.getElementById("notify-redact-toggle") as HTMLInputElement | null;
  const notifyPrivacySelect = document.getElementById("notify-privacy-select") as HTMLSelectElement | null;

  const currentPrefs = settings.notificationPrefs ?? DEFAULT_NOTIFICATION_PREFS;

  if (notificationsToggle) {
    notificationsToggle.checked = settings.notificationsEnabled;
    notificationsToggle.setAttribute("aria-checked", notificationsToggle.checked ? "true" : "false");
  }
  if (notifyToastToggle) {
    notifyToastToggle.checked = currentPrefs.toastEnabled;
    notifyToastToggle.setAttribute("aria-checked", notifyToastToggle.checked ? "true" : "false");
  }
  if (notifyBadgeToggle) {
    notifyBadgeToggle.checked = currentPrefs.badgeEnabled;
    notifyBadgeToggle.setAttribute("aria-checked", notifyBadgeToggle.checked ? "true" : "false");
  }
  if (notifySoundToggle) {
    notifySoundToggle.checked = currentPrefs.soundEnabled;
    notifySoundToggle.setAttribute("aria-checked", notifySoundToggle.checked ? "true" : "false");
  }
  if (notifyFindingsToggle) {
    notifyFindingsToggle.checked = currentPrefs.notifyCriticalFindings;
    notifyFindingsToggle.setAttribute("aria-checked", notifyFindingsToggle.checked ? "true" : "false");
  }
  if (notifyPasteToggle) {
    notifyPasteToggle.checked = currentPrefs.notifyPasteInterception;
    notifyPasteToggle.setAttribute("aria-checked", notifyPasteToggle.checked ? "true" : "false");
  }
  if (notifyPolicyToggle) {
    notifyPolicyToggle.checked = currentPrefs.notifyPolicyChanges;
    notifyPolicyToggle.setAttribute("aria-checked", notifyPolicyToggle.checked ? "true" : "false");
  }
  if (notifyRedactToggle) {
    notifyRedactToggle.checked = currentPrefs.notifyRedactionComplete;
    notifyRedactToggle.setAttribute("aria-checked", notifyRedactToggle.checked ? "true" : "false");
  }
  if (notifyPrivacySelect) {
    notifyPrivacySelect.value = currentPrefs.privacyMode;
  }

  const syncNotificationPrefs = () => {
    const updatedPrefs: NotificationPreferences = {
      systemEnabled: notificationsToggle ? notificationsToggle.checked : false,
      toastEnabled: notifyToastToggle ? notifyToastToggle.checked : true,
      badgeEnabled: notifyBadgeToggle ? notifyBadgeToggle.checked : true,
      soundEnabled: notifySoundToggle ? notifySoundToggle.checked : false,
      notifyCriticalFindings: notifyFindingsToggle ? notifyFindingsToggle.checked : true,
      notifyPasteInterception: notifyPasteToggle ? notifyPasteToggle.checked : true,
      notifyPolicyChanges: notifyPolicyToggle ? notifyPolicyToggle.checked : true,
      notifyRedactionComplete: notifyRedactToggle ? notifyRedactToggle.checked : true,
      privacyMode: notifyPrivacySelect && isNotificationPrivacyMode(notifyPrivacySelect.value) ? notifyPrivacySelect.value : "detailed",
    };

    void chrome.runtime.sendMessage({
      type: "POPUP_SET_NOTIFICATION_PREFS",
      requestId: requestId(),
      prefs: updatedPrefs,
    });
  };

  if (notificationsToggle) {
    notificationsToggle.addEventListener("change", () => {
      notificationsToggle.setAttribute("aria-checked", notificationsToggle.checked ? "true" : "false");
      void chrome.runtime.sendMessage({
        type: "POPUP_SET_NOTIFICATIONS",
        requestId: requestId(),
        enabled: notificationsToggle.checked,
      });
    });
  }

  [notifyToastToggle, notifyBadgeToggle, notifySoundToggle, notifyFindingsToggle, notifyPasteToggle, notifyPolicyToggle, notifyRedactToggle].forEach((toggle) => {
    toggle?.addEventListener("change", () => {
      toggle.setAttribute("aria-checked", toggle.checked ? "true" : "false");
      syncNotificationPrefs();
    });
  });

  notifyPrivacySelect?.addEventListener("change", () => {
    syncNotificationPrefs();
  });

  const originInput = document.getElementById("gateway-origin-input") as HTMLInputElement | null;
  const keyInput = document.getElementById("gateway-key-input") as HTMLInputElement | null;
  const saveBtn = document.getElementById("account-save-btn") as HTMLButtonElement | null;
  const purchaseBtn = document.getElementById("account-purchase-btn") as HTMLButtonElement | null;
  const accountStatus = document.getElementById("account-status") as HTMLParagraphElement | null;
  
  const accountIdentity = document.getElementById("account-identity");
  const accountEmail = document.getElementById("account-email") as HTMLParagraphElement | null;
  const accountOrg = document.getElementById("account-org") as HTMLParagraphElement | null;
  const accountRole = document.getElementById("account-role") as HTMLParagraphElement | null;
  const accountPlan = document.getElementById("account-plan") as HTMLParagraphElement | null;
  const accountManagedNote = document.getElementById("account-managed-note");
  const orgSettings = document.getElementById("org-settings");
  const orgSettingsWall = document.getElementById("org-settings-wall");

  const ROLE_LABEL_KEYS = {
    owner: "account_role_owner",
    admin: "account_role_admin",
    member: "account_role_member",
    viewer: "account_role_viewer",
  } as const;
  const TIER_LABEL_KEYS = {
    free: "account_plan_free",
    pro: "account_plan_pro",
    enterprise: "account_plan_enterprise",
  } as const;

  /**
   * Render the account surface for the current identity.
   *
   * Three states, chosen once here so every element agrees:
   *   signed out  → nothing shown; the connect button is the only affordance
   *   admin/owner → identity, subscription, and the editable settings form
   *   member      → identity, subscription, and the wall
   *
   * `canManage` arrives already re-derived in `shared/account.ts` from the
   * server-verified role. It is deliberately not recomputed here, and the worker
   * refuses the save regardless — this only decides what is on screen.
   */
  function renderAccountView(view: AccountView | undefined | null): void {
    // Language is read from the same source every other renderer uses. The account
    // surface must not fall back to English just because it renders before
    // `initPopup` has finished loading settings.
    const language = accountLanguage();
    const connected = view?.connected === true;

    if (accountIdentity) accountIdentity.hidden = !connected;
    if (accountEmail) accountEmail.textContent = connected ? (view?.userEmail ?? "—") : "";

    if (accountOrg) {
      // tenantName is server text, so it is assigned as textContent and never
      // interpolated into markup.
      accountOrg.textContent = connected ? (view?.tenantName ?? view?.tenantId ?? "—") : "";
    }

    if (accountRole) {
      const role = view?.role ?? null;
      accountRole.textContent = connected
        ? t(language, role ? ROLE_LABEL_KEYS[role] : "account_role_unknown")
        : "";
    }

    if (accountPlan) {
      accountPlan.textContent = connected ? t(language, TIER_LABEL_KEYS[view?.tier ?? "free"]) : "";
    }

    const canManage = connected && view?.canManage === true;
    if (orgSettings) orgSettings.hidden = !canManage;
    if (orgSettingsWall) orgSettingsWall.hidden = !connected || canManage;
    if (accountManagedNote) accountManagedNote.hidden = !canManage;

    lastAccountView = connected && view ? view : null;
    syncProfilePopoverSummary();
  }
  renderAccountView(null);

  purchaseBtn?.addEventListener("click", () => {
    if (accountStatus) {
      void (async () => {
        const current = await loadSettings();
        accountStatus.textContent = t(current.language, "opening_stripe");
      })();
    }
    void chrome.runtime.sendMessage({
      type: "POPUP_ACCOUNT_PURCHASE",
      requestId: requestId(),
      planId: "redaction-extension-addon",
    });
  });

  saveBtn?.addEventListener("click", () => {
    if (!originInput || !keyInput || !accountStatus) return;
    const gatewayOrigin = originInput.value.trim().replace(/\/+$/, "");
    const apiKey = keyInput.value.trim();
    if (!/^https:\/\/[^/]+$/.test(gatewayOrigin)) {
      accountStatus.textContent = "Gateway origin must be a bare https URL (no path).";
      return;
    }
    if (!/^gw_(live|test)_[A-Za-z0-9]{8,}$/.test(apiKey)) {
      accountStatus.textContent = "API key must start with gw_live_ or gw_test_.";
      return;
    }
    accountStatus.textContent = "Saving account…";
    void chrome.runtime.sendMessage({
      type: "POPUP_ACCOUNT_SAVE",
      requestId: requestId(),
      gatewayOrigin,
      apiKey,
    });
  });

  const accountClearBtn = document.getElementById("account-clear-btn") as HTMLButtonElement | null;
  accountClearBtn?.addEventListener("click", () => {
    if (accountStatus) accountStatus.textContent = "Disconnecting account…";
    void chrome.runtime.sendMessage({
      type: "POPUP_ACCOUNT_CLEAR",
      requestId: requestId(),
    });
  });

  // ---------- Enterprise Management Enrollment & Gateway API Controls ----------
  const mgmtStatusText = document.getElementById("mgmt-status-text") as HTMLParagraphElement | null;
  const mgmtOrgIdInput = document.getElementById("mgmt-org-id-input") as HTMLInputElement | null;
  const mgmtOrgNameInput = document.getElementById("mgmt-org-name-input") as HTMLInputElement | null;
  const mgmtEmpIdInput = document.getElementById("mgmt-emp-id-input") as HTMLInputElement | null;
  const mgmtCoordUrlInput = document.getElementById("mgmt-coord-url-input") as HTMLInputElement | null;
  const mgmtEnrollBtn = document.getElementById("mgmt-enroll-btn") as HTMLButtonElement | null;
  const mgmtSyncPolicyBtn = document.getElementById("mgmt-sync-policy-btn") as HTMLButtonElement | null;
  const mgmtUnenrollBtn = document.getElementById("mgmt-unenroll-btn") as HTMLButtonElement | null;

  mgmtEnrollBtn?.addEventListener("click", () => {
    const organizationId = mgmtOrgIdInput?.value.trim() || "";
    const organizationName = mgmtOrgNameInput?.value.trim() || undefined;
    const employeeId = mgmtEmpIdInput?.value.trim() || "";
    const coordinatorUrl = mgmtCoordUrlInput?.value.trim() || undefined;
    if (!organizationId || !employeeId) {
      if (mgmtStatusText) {
        mgmtStatusText.textContent = "Organization ID and Employee ID are required to enroll.";
      }
      return;
    }
    if (mgmtStatusText) mgmtStatusText.textContent = "Enrolling device in Enterprise MANAGE mode…";
    void chrome.runtime.sendMessage({
      type: "POPUP_MANAGEMENT_ENROLL",
      requestId: requestId(),
      organizationId,
      ...(organizationName ? { organizationName } : {}),
      employeeId,
      ...(coordinatorUrl ? { coordinatorUrl } : {}),
    });
  });

  mgmtSyncPolicyBtn?.addEventListener("click", () => {
    if (mgmtStatusText) mgmtStatusText.textContent = "Syncing signed enterprise policy…";
    void chrome.runtime.sendMessage({
      type: "POPUP_SYNC_MANAGED_POLICY",
      requestId: requestId(),
      force: true,
    });
  });

  mgmtUnenrollBtn?.addEventListener("click", () => {
    if (mgmtStatusText) mgmtStatusText.textContent = "Returning to standalone LOCAL mode…";
    void chrome.runtime.sendMessage({
      type: "POPUP_MANAGEMENT_UNENROLL",
      requestId: requestId(),
    });
  });

  const oauthConnectBtn = document.getElementById("oauth-connect-btn") as HTMLButtonElement | null;
  const apiSyncPolicyBtn = document.getElementById("api-sync-policy-btn") as HTMLButtonElement | null;
  const apiDisconnectBtn = document.getElementById("api-disconnect-btn") as HTMLButtonElement | null;
  const oauthStatus = document.getElementById("oauth-status") as HTMLParagraphElement | null;
  const apiConnectionStatus = document.getElementById("api-connection-status") as HTMLParagraphElement | null;

  oauthConnectBtn?.addEventListener("click", () => {
    if (oauthStatus) {
      oauthStatus.hidden = false;
      oauthStatus.textContent = "Checking OAuth connection status…";
    }
    void chrome.runtime.sendMessage({
      type: "POPUP_OAUTH_CONNECT",
      requestId: requestId(),
    });
  });

  apiSyncPolicyBtn?.addEventListener("click", () => {
    if (apiConnectionStatus) {
      apiConnectionStatus.textContent = "Requesting gateway policy sync…";
    }
    const gwOrigin = originInput?.value.trim().replace(/\/+$/, "");
    if (gwOrigin && /^https:\/\/[^/]+$/.test(gwOrigin)) {
      void chrome.runtime.sendMessage({
        type: "POPUP_API_CONNECT",
        requestId: requestId(),
        apiUrl: gwOrigin,
      });
    }
    void chrome.runtime.sendMessage({
      type: "POPUP_API_SYNC_POLICY",
      requestId: requestId(),
    });
  });

  apiDisconnectBtn?.addEventListener("click", () => {
    void chrome.runtime.sendMessage({
      type: "POPUP_API_DISCONNECT",
      requestId: requestId(),
    });
  });

  // ---------- Office Manager Pairing Controls ----------
  const officePairBtn = document.getElementById("office-pair-btn") as HTMLButtonElement | null;
  const officeUnpairBtn = document.getElementById("office-unpair-btn") as HTMLButtonElement | null;
  const officePairingInput = document.getElementById("office-pairing-input") as HTMLInputElement | null;
  const officeManagerStatus = document.getElementById("office-manager-status");

  async function checkOfficeManagerPairingStatus() {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      const stored = (await chrome.storage.local.get([
        "gw_coordinator_policy",
        "gw_coordinator_url",
        "gw_applied_managed_policy",
        "gw_management_enrollment",
      ])) as {
        gw_coordinator_policy?: { managed?: boolean; organizationName?: string; policyVersion?: number };
        gw_coordinator_url?: string;
        gw_applied_managed_policy?: { organization_name?: string; organization_id?: string; policy_version?: number };
        gw_management_enrollment?: { organization_name?: string; organization_id?: string };
      };
      const managedPolicy = stored.gw_applied_managed_policy;
      const enrollment = stored.gw_management_enrollment;
      const coordPolicy = stored.gw_coordinator_policy;

      if (managedPolicy || (enrollment && enrollment.organization_id) || (coordPolicy && coordPolicy.managed)) {
        const orgName =
          managedPolicy?.organization_name ||
          enrollment?.organization_name ||
          enrollment?.organization_id ||
          coordPolicy?.organizationName ||
          "Organization";
        const ver = managedPolicy?.policy_version || coordPolicy?.policyVersion || 1;
        if (officeManagerStatus) {
          officeManagerStatus.textContent = t(currentLang, "office_status_managed", { org: orgName, ver });
          officeManagerStatus.style.color = "var(--gw-emerald, #10b981)";
        }
        if (officePairingInput) officePairingInput.style.display = "none";
        if (officePairBtn) officePairBtn.style.display = "none";
        if (officeUnpairBtn) officeUnpairBtn.style.display = "inline-block";
        return;
      }
    }
    if (officeManagerStatus) {
      officeManagerStatus.textContent = t(currentLang, "office_status_local");
      officeManagerStatus.style.color = "inherit";
    }
    if (officePairingInput) officePairingInput.style.display = "block";
    if (officePairBtn) officePairBtn.style.display = "inline-block";
    if (officeUnpairBtn) officeUnpairBtn.style.display = "none";
  }

  void checkOfficeManagerPairingStatus();

  officePairBtn?.addEventListener("click", async () => {
    const code = officePairingInput?.value.trim().toUpperCase();
    if (!code || code.length !== 6) {
      if (officeManagerStatus) {
        officeManagerStatus.textContent = t(currentLang, "office_err_invalid_code");
        officeManagerStatus.style.color = "var(--gw-crimson, #ef4444)";
      }
      return;
    }

    if (officeManagerStatus) {
      officeManagerStatus.textContent = t(currentLang, "office_connecting");
      officeManagerStatus.style.color = "var(--gw-cobalt, #2563eb)";
    }

    try {
      // Connect to local coordinator
      const coordinatorUrl = "http://127.0.0.1:4820";
      const res = await fetch(`${coordinatorUrl}/api/v1/coordinator/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pairingCode: code }),
      });

      if (!res.ok) {
        throw new Error(`Coordinator returned HTTP ${res.status}`);
      }

      const data = await res.json();
      if (data && data.policy) {
        await chrome.storage.local.set({
          gw_coordinator_policy: data.policy,
          gw_coordinator_url: coordinatorUrl,
        });
        const deviceId = await getInstallationId();
        const orgId = data.organizationId || data.policy.organizationId || data.policy.organization_id || "org_office_manager";
        const orgName = data.organizationName || data.policy.organizationName || data.policy.organization_name || "Office Manager";
        const employeeId = data.employeeId || "employee";
        const enrollment: ManagementEnrollment = {
          organization_id: orgId,
          organization_name: orgName,
          employee_id: employeeId,
          device_id: deviceId,
          coordinator_url: coordinatorUrl,
          enrolled_at: new Date().toISOString(),
          management_mode: "MANAGE",
        };
        await saveManagementEnrollment(enrollment);
        try {
          if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
            await chrome.runtime.sendMessage({
              type: "POPUP_MANAGEMENT_ENROLL",
              organizationId: orgId,
              organizationName: orgName,
              employeeId,
              coordinatorUrl,
              requestId: requestId(),
            });
          }
        } catch {
          // Ignore messaging error if service worker is inactive
        }
        await checkOfficeManagerPairingStatus();
        await refreshProtectionStatus();
      }
    } catch (err: unknown) {
      if (officeManagerStatus) {
        const detail = err instanceof Error ? err.message : "Connection refused";
        officeManagerStatus.textContent = t(currentLang, "office_err_unreachable", { detail });
        officeManagerStatus.style.color = "var(--gw-crimson, #ef4444)";
      }
    }
  });

  officeUnpairBtn?.addEventListener("click", async () => {
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      await chrome.storage.local.remove([
        "gw_coordinator_policy",
        "gw_coordinator_url",
        "gw_applied_managed_policy",
        "gw_management_enrollment",
      ]);
      await clearManagementEnrollment();
      try {
        if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
          await chrome.runtime.sendMessage({
            type: "POPUP_MANAGEMENT_UNENROLL",
            requestId: requestId(),
          });
        }
      } catch {
        // Ignore messaging error
      }
      await checkOfficeManagerPairingStatus();
      await refreshProtectionStatus();
    }
  });

  // ---------- Redaction Wizard & Custom Rules Controller ----------
  const openWizardBtn = document.getElementById("open-wizard-btn") as HTMLButtonElement | null;
  const linkCommunityBtn = document.getElementById("link-community-btn") as HTMLButtonElement | null;
  const fetchCommunityRulesBtn = document.getElementById("fetch-community-rules-btn") as HTMLButtonElement | null;
  const customPatternsList = document.getElementById("custom-patterns-list") as HTMLUListElement | null;
  const noCustomPatterns = document.getElementById("no-custom-patterns") as HTMLParagraphElement | null;
  const communityRulesList = document.getElementById("community-rules-list") as HTMLUListElement | null;
  const communityAccountStatus = document.getElementById("community-account-status") as HTMLParagraphElement | null;
  const exportCustomRulesBtn = document.getElementById("export-custom-rules-btn") as HTMLButtonElement | null;
  const importCustomRulesBtn = document.getElementById("import-custom-rules-btn") as HTMLButtonElement | null;
  const importCustomRulesFile = document.getElementById("import-custom-rules-file") as HTMLInputElement | null;

  if (linkCommunityBtn) {
    linkCommunityBtn.disabled = true;
    linkCommunityBtn.title = "Community account linking is unavailable until server authorization is configured.";
  }
  if (fetchCommunityRulesBtn) {
    fetchCommunityRulesBtn.disabled = true;
    fetchCommunityRulesBtn.title = "Community rule retrieval is unavailable until the server integration is configured.";
  }

  const wizardDialog = document.getElementById("wizard-dialog") as HTMLDialogElement | null;
  const wizardStep1 = document.getElementById("wizard-step-1") as HTMLDivElement | null;
  const wizardStep2 = document.getElementById("wizard-step-2") as HTMLDivElement | null;
  const wizardStep3 = document.getElementById("wizard-step-3") as HTMLDivElement | null;
  const wizardStep4 = document.getElementById("wizard-step-4") as HTMLDivElement | null;

  const wizardPosInput = document.getElementById("wizard-pos-input") as HTMLTextAreaElement | null;
  const wizardNegInput = document.getElementById("wizard-neg-input") as HTMLTextAreaElement | null;
  const wizardFileInput = document.getElementById("wizard-file-input") as HTMLInputElement | null;
  const wizardImportFileBtn = document.getElementById("wizard-import-file-btn") as HTMLButtonElement | null;
  const wizardImportStatus = document.getElementById("wizard-import-status") as HTMLSpanElement | null;
  const wizardCancel1 = document.getElementById("wizard-cancel-1") as HTMLButtonElement | null;
  const wizardAnalyzeBtn = document.getElementById("wizard-analyze-btn") as HTMLButtonElement | null;

  const wizardProposalsContainer = document.getElementById("wizard-proposals-container") as HTMLDivElement | null;
  const wizardBack2 = document.getElementById("wizard-back-2") as HTMLButtonElement | null;
  const wizardNext2 = document.getElementById("wizard-next-2") as HTMLButtonElement | null;

  const wizardRegexInput = document.getElementById("wizard-regex-input") as HTMLInputElement | null;
  const wizardTestSample = document.getElementById("wizard-test-sample") as HTMLTextAreaElement | null;
  const wizardTestResultsBox = document.getElementById("wizard-test-results-box") as HTMLDivElement | null;
  const wizardBack3 = document.getElementById("wizard-back-3") as HTMLButtonElement | null;
  const wizardNext3 = document.getElementById("wizard-next-3") as HTMLButtonElement | null;

  const wizardRuleName = document.getElementById("wizard-rule-name") as HTMLInputElement | null;
  const wizardRuleCategory = document.getElementById("wizard-rule-category") as HTMLSelectElement | null;
  const wizardRuleConfidence = document.getElementById("wizard-rule-confidence") as HTMLInputElement | null;
  const wizardRuleCues = document.getElementById("wizard-rule-cues") as HTMLInputElement | null;
  const wizardRuleGroup = document.getElementById("wizard-rule-group") as HTMLInputElement | null;
  const wizardRuleMinLen = document.getElementById("wizard-rule-min-len") as HTMLInputElement | null;
  const wizardRuleMaxLen = document.getElementById("wizard-rule-max-len") as HTMLInputElement | null;
  const wizardBack4 = document.getElementById("wizard-back-4") as HTMLButtonElement | null;
  const wizardSaveBtn = document.getElementById("wizard-save-btn") as HTMLButtonElement | null;

  const contribConsentDialog = document.getElementById("contrib-consent-dialog") as HTMLDialogElement | null;
  const contribConsentCheckbox = document.getElementById("contrib-consent-checkbox") as HTMLInputElement | null;
  const contribCancelBtn = document.getElementById("contrib-cancel-btn") as HTMLButtonElement | null;
  const contribConfirmBtn = document.getElementById("contrib-confirm-btn") as HTMLButtonElement | null;

  let currentProposals: WizardAnalysis[] = [];
  let selectedProposalIndex = 0;
  let contributeTargetPatternId: string | null = null;
  let isCommunityLinked = false;

  function showWizardStep(step: 1 | 2 | 3 | 4) {
    if (!wizardStep1 || !wizardStep2 || !wizardStep3 || !wizardStep4) return;
    wizardStep1.hidden = step !== 1;
    wizardStep2.hidden = step !== 2;
    wizardStep3.hidden = step !== 3;
    wizardStep4.hidden = step !== 4;
  }

  const wizardStep1Error = document.getElementById("wizard-step1-error") as HTMLParagraphElement | null;
  const wizardStep4Error = document.getElementById("wizard-step4-error") as HTMLParagraphElement | null;

  openWizardBtn?.addEventListener("click", () => {
    if (!wizardPosInput || !wizardNegInput || !wizardRegexInput || !wizardTestSample || !wizardRuleName || !wizardRuleConfidence || !wizardDialog) return;
    wizardPosInput.value = "";
    wizardNegInput.value = "";
    wizardRegexInput.value = "";
    wizardTestSample.value = "";
    wizardRuleName.value = "";
    wizardRuleConfidence.value = "0.85";
    if (wizardRuleCues) wizardRuleCues.value = "";
    if (wizardRuleGroup) wizardRuleGroup.value = "0";
    if (wizardRuleMinLen) wizardRuleMinLen.value = "";
    if (wizardRuleMaxLen) wizardRuleMaxLen.value = "";
    if (wizardStep1Error) {
      wizardStep1Error.textContent = "";
      wizardStep1Error.hidden = true;
    }
    if (wizardStep4Error) {
      wizardStep4Error.textContent = "";
      wizardStep4Error.hidden = true;
    }
    if (wizardImportStatus) {
      wizardImportStatus.textContent = "";
      wizardImportStatus.hidden = true;
    }
    currentProposals = [];
    selectedProposalIndex = 0;
    showWizardStep(1);
    wizardDialog.showModal();
  });

  wizardCancel1?.addEventListener("click", () => wizardDialog?.close());

  function handleWizardFile(file: File) {
    if (!wizardPosInput) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = typeof reader.result === "string" ? reader.result : "";
        const parsed = parseSampleLines(text);
        if (parsed.length === 0) {
          if (wizardImportStatus) {
            wizardImportStatus.textContent = "No valid lines found in file.";
            wizardImportStatus.hidden = false;
          }
          return;
        }

        const existingLines = wizardPosInput.value
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
        const combined = Array.from(new Set([...existingLines, ...parsed]));
        wizardPosInput.value = combined.join("\n");

        if (wizardImportStatus) {
          wizardImportStatus.textContent = `Imported ${parsed.length} example${parsed.length === 1 ? "" : "s"}.`;
          wizardImportStatus.hidden = false;
        }
      } catch {
        if (wizardImportStatus) {
          wizardImportStatus.textContent = "Could not read sample file.";
          wizardImportStatus.hidden = false;
        }
      } finally {
        if (wizardFileInput) wizardFileInput.value = "";
      }
    };
    reader.onerror = () => {
      if (wizardImportStatus) {
        wizardImportStatus.textContent = "Failed to load file.";
        wizardImportStatus.hidden = false;
      }
      if (wizardFileInput) wizardFileInput.value = "";
    };
    reader.readAsText(file);
  }

  wizardImportFileBtn?.addEventListener("click", async (e) => {
    e.preventDefault();

    // If we are in the toolbar popup and Side Panel API is available, hand off immediately
    if (
      !isSidePanelContext &&
      typeof chrome !== "undefined" &&
      chrome.sidePanel?.open &&
      currentWindowId !== undefined
    ) {
      const draftExamples = wizardPosInput?.value || "";
      const draftNegative = wizardNegInput?.value || "";
      const ruleNameInput = wizardRuleName?.value || "";

      const handoffWrite = persistHandoff({
        wizardHandoffPending: {
          step: 1,
          draftPositiveExamples: draftExamples,
          draftNegativeExamples: draftNegative,
          draftRuleName: ruleNameInput,
          timestamp: Date.now(),
        },
      });

      try {
        await chrome.sidePanel.open({ windowId: currentWindowId });
        await handoffWrite;
        window.close(); // Cleanly close ephemeral toolbar popup once Side Panel opens
      } catch (err) {
        console.warn("[GovernWorld] SidePanel open fallback to native picker:", sanitizeErrorForLog(err));
        try {
          await chrome.storage?.local?.remove("wizardHandoffPending");
        } catch {
          // Ignore cleanup error
        }
        wizardFileInput?.click();
        if (wizardImportStatus) {
          wizardImportStatus.textContent = t(currentLang, "wizard_picker_fallback_hint");
          wizardImportStatus.hidden = false;
        }
      }

      return;
    }

    // Already in Side Panel (or fallback/tab): open the OS file picker directly
    wizardFileInput?.click();
  });

  wizardFileInput?.addEventListener("change", () => {
    const file = wizardFileInput.files?.[0];
    if (file) handleWizardFile(file);
  });

  wizardPosInput?.addEventListener("dragover", (e) => {
    e.preventDefault();
  });

  wizardPosInput?.addEventListener("drop", (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) handleWizardFile(file);
  });

  wizardAnalyzeBtn?.addEventListener("click", () => {
    if (!wizardPosInput || !wizardNegInput) return;
    const pos = wizardPosInput.value.split("\n").map((s) => s.trim()).filter(Boolean);
    const neg = wizardNegInput.value.split("\n").map((s) => s.trim()).filter(Boolean);
    if (pos.length === 0) {
      void (async () => {
        const current = await loadSettings();
        if (wizardStep1Error) {
          wizardStep1Error.textContent = t(current.language, "wizard_need_positive");
          wizardStep1Error.hidden = false;
        }
      })();
      return;
    }
    if (wizardStep1Error) {
      wizardStep1Error.textContent = "";
      wizardStep1Error.hidden = true;
    }
    void chrome.runtime.sendMessage({
      type: "POPUP_WIZARD_ANALYZE",
      requestId: requestId(),
      positiveExamples: pos,
      negativeExamples: neg,
    });
  });

  wizardBack2?.addEventListener("click", () => showWizardStep(1));
  wizardNext2?.addEventListener("click", () => {
    const selected = currentProposals[selectedProposalIndex];
    if (selected && wizardRegexInput) {
      wizardRegexInput.value = selected.proposedPattern;
    }
    const pos = wizardPosInput ? wizardPosInput.value.split("\n").map((s) => s.trim()).filter(Boolean) : [];
    if (pos.length > 0 && wizardTestSample) {
      wizardTestSample.value = pos.join("\n");
    }
    triggerWizardTest();
    showWizardStep(3);
  });

  function triggerWizardTest() {
    if (!wizardRegexInput || !wizardTestSample) return;
    const regex = wizardRegexInput.value.trim();
    const text = wizardTestSample.value;
    if (regex) {
      void chrome.runtime.sendMessage({
        type: "POPUP_WIZARD_TEST",
        requestId: requestId(),
        regex,
        sampleText: text,
      });
    }
  }

  wizardRegexInput?.addEventListener("input", triggerWizardTest);
  wizardTestSample?.addEventListener("input", triggerWizardTest);

  wizardBack3?.addEventListener("click", () => showWizardStep(2));
  wizardNext3?.addEventListener("click", () => showWizardStep(4));

  wizardBack4?.addEventListener("click", () => showWizardStep(3));
  wizardSaveBtn?.addEventListener("click", () => {
    if (!wizardRuleName || !wizardRegexInput || !wizardRuleCategory || !wizardRuleConfidence || !wizardDialog) return;
    const name = wizardRuleName.value.trim() || "Custom Pattern";
    const patternStr = wizardRegexInput.value.trim();
    if (!patternStr) {
      if (wizardStep4Error) {
        wizardStep4Error.textContent = t(currentLang, "wizard_need_pattern");
        wizardStep4Error.hidden = false;
      }
      return;
    }
    if (wizardStep4Error) {
      wizardStep4Error.textContent = "";
      wizardStep4Error.hidden = true;
    }
    const rawCues = wizardRuleCues?.value
      ? wizardRuleCues.value
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean)
      : [];
    const parsedGroup = wizardRuleGroup ? Math.max(0, Math.min(20, parseInt(wizardRuleGroup.value, 10) || 0)) : 0;
    const parsedMinLen = wizardRuleMinLen?.value ? Math.max(1, parseInt(wizardRuleMinLen.value, 10) || 0) : undefined;
    const parsedMaxLen = wizardRuleMaxLen?.value ? Math.max(1, parseInt(wizardRuleMaxLen.value, 10) || 0) : undefined;

    const pattern: CustomPattern = {
      id: crypto.randomUUID(),
      name,
      category: wizardRuleCategory.value as any,
      pattern: patternStr,
      flags: "gi",
      captureGroup: parsedGroup,
      confidence: parseFloat(wizardRuleConfidence.value) || 0.85,
      createdAt: new Date().toISOString(),
      source: "local",
      contributionStatus: "local_only",
      strategy: "text",
      ...(rawCues.length > 0 ? { contextCues: rawCues } : {}),
      ...(parsedMinLen !== undefined && parsedMinLen > 0 ? { minLength: parsedMinLen } : {}),
      ...(parsedMaxLen !== undefined && parsedMaxLen > 0 ? { maxLength: parsedMaxLen } : {}),
    };

    void chrome.runtime.sendMessage({
      type: "POPUP_CUSTOM_PATTERN_SAVE",
      requestId: requestId(),
      pattern,
    });
    wizardDialog.close();
  });

  contribConsentCheckbox?.addEventListener("change", () => {
    if (contribConfirmBtn) contribConfirmBtn.disabled = !contribConsentCheckbox.checked;
  });

  contribCancelBtn?.addEventListener("click", () => contribConsentDialog?.close());
  contribConfirmBtn?.addEventListener("click", () => {
    if (contributeTargetPatternId) {
      void chrome.runtime.sendMessage({
        type: "POPUP_COMMUNITY_CONTRIBUTE",
        requestId: requestId(),
        patternId: contributeTargetPatternId,
      });
    }
    contribConsentDialog?.close();
  });

  linkCommunityBtn?.addEventListener("click", () => {
    if (isCommunityLinked) {
      void chrome.runtime.sendMessage({ type: "POPUP_COMMUNITY_ACCOUNT_UNLINK", requestId: requestId() });
    } else {
      void chrome.runtime.sendMessage({ type: "POPUP_COMMUNITY_ACCOUNT_LINK_FREE", requestId: requestId() });
    }
  });

  fetchCommunityRulesBtn?.addEventListener("click", () => {
    void chrome.runtime.sendMessage({ type: "POPUP_COMMUNITY_FETCH_COMMUNITY_RULES", requestId: requestId() });
  });

  exportCustomRulesBtn?.addEventListener("click", async () => {
    const patterns = await loadCustomPatterns();
    const current = await loadSettings();
    if (patterns.length === 0) {
      speakAnnouncement("No personal logic rules to export", current);
      return;
    }
    const json = JSON.stringify(patterns, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "governworld-custom-rules-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    speakAnnouncement(t(current.language, "rules_exported"), current);
  });

  importCustomRulesBtn?.addEventListener("click", () => {
    importCustomRulesFile?.click();
  });

  importCustomRulesFile?.addEventListener("change", async () => {
    const file = importCustomRulesFile.files?.[0];
    if (!file) return;
    const current = await loadSettings();
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) {
        speakAnnouncement(t(current.language, "invalid_rules_file"), current);
        return;
      }
      const valid: CustomPattern[] = [];
      for (const item of parsed) {
        const res = parseCustomPattern(item);
        if (res.ok) valid.push(res.pattern);
      }
      if (valid.length === 0) {
        speakAnnouncement(t(current.language, "invalid_rules_file"), current);
        return;
      }
      const existing = await loadCustomPatterns();
      const map = new Map<string, CustomPattern>();
      for (const p of existing) map.set(p.id, p);
      for (const p of valid) map.set(p.id, p);
      const merged = [...map.values()];
      await saveCustomPatterns(merged);
      renderCustomPatterns(merged);

      const catSet = new Set(current.enabledCategories);
      let changed = false;
      for (const p of valid) {
        if (p.category !== "custom" && !catSet.has(p.category)) {
          catSet.add(p.category);
          changed = true;
        }
      }
      if (changed) {
        const next = ALL_CATEGORIES.filter((c) => catSet.has(c));
        await saveSettings({ ...current, enabledCategories: next });
        await renderCategories({ enabledCategories: next, language: current.language });
      }

      speakAnnouncement(t(current.language, "rules_imported"), current);
    } catch {
      speakAnnouncement(t(current.language, "invalid_rules_file"), current);
    } finally {
      importCustomRulesFile.value = "";
    }
  });

  function renderCustomPatterns(patterns: CustomPattern[]) {
    if (!customPatternsList || !noCustomPatterns) return;
    customPatternsList.replaceChildren();
    if (!patterns || patterns.length === 0) {
      noCustomPatterns.hidden = false;
      return;
    }
    noCustomPatterns.hidden = true;
    for (const pat of patterns) {
      const item = document.createElement("li");
      item.className = "finding";
      item.style.flexDirection = "column";
      item.style.alignItems = "stretch";

      const topRow = document.createElement("div");
      topRow.style.display = "flex";
      topRow.style.justifyContent = "space-between";
      topRow.style.alignItems = "center";

      const nameSpan = document.createElement("strong");
      nameSpan.textContent = pat.name;
      nameSpan.style.fontSize = "12px";

      const actionsDiv = document.createElement("div");
      actionsDiv.style.display = "flex";
      actionsDiv.style.gap = "6px";
      actionsDiv.style.alignItems = "center";

      const delBtn = document.createElement("button");
      delBtn.className = "btn btn--ghost btn--sm";
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", () => {
        void chrome.runtime.sendMessage({
          type: "POPUP_CUSTOM_PATTERN_DELETE",
          requestId: requestId(),
          patternId: pat.id,
        });
      });

      if (pat.contributionStatus === "submitted" || pat.contributionStatus === "accepted") {
        const badge = document.createElement("span");
        badge.className = "finding__severity";
        badge.textContent = "Contributed";
        badge.dataset.level = "high";
        actionsDiv.append(badge, delBtn);
      } else {
        const submitLogicBtn = document.createElement("button");
        submitLogicBtn.className = "btn btn--ghost btn--sm";
        submitLogicBtn.textContent = "Share Rule";
        submitLogicBtn.title = "Submit anonymized rule pattern (requires consent or connected gateway)";
        submitLogicBtn.addEventListener("click", () => {
          contributeTargetPatternId = pat.id;
          if (contribConsentDialog && typeof contribConsentDialog.showModal === "function") {
            if (contribConsentCheckbox) contribConsentCheckbox.checked = false;
            if (contribConfirmBtn) contribConfirmBtn.disabled = true;
            contribConsentDialog.showModal();
          } else {
            void chrome.runtime.sendMessage({
              type: "POPUP_API_SUBMIT_LOGIC",
              requestId: requestId(),
              patternId: pat.id,
            });
          }
        });
        actionsDiv.append(submitLogicBtn, delBtn);
      }

      topRow.append(nameSpan, actionsDiv);

      const codeBox = document.createElement("code");
      if (pat.strategy === "location" && pat.location) {
        codeBox.textContent = `Location Box (${Math.round(pat.location.region.x * 100)}%, ${Math.round(pat.location.region.y * 100)}%, ${Math.round(pat.location.region.width * 100)}×${Math.round(pat.location.region.height * 100)}%) [${pat.category}]`;
      } else {
        const cuesSuffix = pat.contextCues?.length ? ` cues: ${pat.contextCues.join(", ")}` : "";
        const lenSuffix =
          pat.minLength !== undefined || pat.maxLength !== undefined
            ? ` len: ${pat.minLength ?? 1}–${pat.maxLength ?? "∞"}`
            : "";
        codeBox.textContent = `/${pat.pattern}/${pat.flags} [${pat.category}]${cuesSuffix}${lenSuffix}`;
      }
      codeBox.style.fontSize = "11px";
      codeBox.style.color = "var(--text-muted)";
      codeBox.style.marginTop = "4px";

      item.append(topRow, codeBox);
      customPatternsList.appendChild(item);
    }
  }


  // ---------- Policy Studio Controller ----------
  const openPolicyBtn = document.getElementById("open-policy-btn") as HTMLButtonElement | null;
  const exportPoliciesBtn = document.getElementById("export-policies-btn") as HTMLButtonElement | null;
  const importPoliciesBtn = document.getElementById("import-policies-btn") as HTMLButtonElement | null;
  const importPoliciesFile = document.getElementById("import-policies-file") as HTMLInputElement | null;
  const policiesList = document.getElementById("policies-list") as HTMLUListElement | null;
  const noPolicies = document.getElementById("no-policies") as HTMLParagraphElement | null;

  const policyDialog = document.getElementById("policy-dialog") as HTMLDialogElement | null;
  const policyNameInput = document.getElementById("policy-name-input") as HTMLInputElement | null;
  const policyUrlInput = document.getElementById("policy-url-input") as HTMLInputElement | null;
  const policyBlockSiteCheckbox = document.getElementById("policy-block-site-checkbox") as HTMLInputElement | null;
  const policyScopeRow = document.getElementById("policy-scope-row") as HTMLDivElement | null;
  const policyScopeSelect = document.getElementById("policy-scope-select") as HTMLSelectElement | null;
  const policyCustomCategoriesContainer = document.getElementById("policy-custom-categories-container") as HTMLDivElement | null;
  const policyActionRow = document.getElementById("policy-action-row") as HTMLDivElement | null;
  const policyActionSelect = document.getElementById("policy-action-select") as HTMLSelectElement | null;
  const policyNotesInput = document.getElementById("policy-notes-input") as HTMLInputElement | null;
  const policyDialogError = document.getElementById("policy-dialog-error") as HTMLParagraphElement | null;
  const cancelPolicyBtn = document.getElementById("cancel-policy-btn") as HTMLButtonElement | null;
  const savePolicyBtn = document.getElementById("save-policy-btn") as HTMLButtonElement | null;
  const policyTemplateBtns = document.querySelectorAll<HTMLButtonElement>(".policy-template-btn");

  function initCustomCategoriesPicker() {
    if (!policyCustomCategoriesContainer) return;
    policyCustomCategoriesContainer.replaceChildren();
    for (const [catKey, label] of Object.entries(CATEGORY_LABELS)) {
      const labelEl = document.createElement("label");
      labelEl.className = "policy-cat-checkbox-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = catKey;
      const span = document.createElement("span");
      span.textContent = label;
      labelEl.append(cb, span);
      policyCustomCategoriesContainer.appendChild(labelEl);
    }
  }

  function updatePolicyDialogVisibility() {
    const isBlockSite = policyBlockSiteCheckbox?.checked ?? false;
    if (policyScopeRow) policyScopeRow.hidden = isBlockSite;
    if (policyActionRow) policyActionRow.hidden = isBlockSite;
    if (policyCustomCategoriesContainer) {
      policyCustomCategoriesContainer.hidden = isBlockSite || policyScopeSelect?.value !== "custom";
    }
  }

  policyBlockSiteCheckbox?.addEventListener("change", updatePolicyDialogVisibility);
  policyScopeSelect?.addEventListener("change", updatePolicyDialogVisibility);

  policyTemplateBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const template = btn.dataset.template;
      if (!policyNameInput || !policyUrlInput) return;
      if (template === "ai") {
        policyNameInput.value = "AI Chatbots Guard";
        policyUrlInput.value = "chatgpt.com, claude.ai, *.openai.com";
        if (policyBlockSiteCheckbox) policyBlockSiteCheckbox.checked = false;
        if (policyScopeSelect) policyScopeSelect.value = "secrets";
        if (policyActionSelect) policyActionSelect.value = "block";
        if (policyNotesInput) policyNotesInput.value = "Strict block on credentials and API tokens on AI web tools";
      } else if (template === "health") {
        policyNameInput.value = "HIPAA Health Portals";
        policyUrlInput.value = "*.mychart.com, *.epic.com";
        if (policyBlockSiteCheckbox) policyBlockSiteCheckbox.checked = false;
        if (policyScopeSelect) policyScopeSelect.value = "phi";
        if (policyActionSelect) policyActionSelect.value = "block";
        if (policyNotesInput) policyNotesInput.value = "Strict HIPAA compliance policy";
      } else if (template === "secrets") {
        policyNameInput.value = "Dev & Secret Guard";
        policyUrlInput.value = "github.com, gitlab.com, stackoverflow.com";
        if (policyBlockSiteCheckbox) policyBlockSiteCheckbox.checked = false;
        if (policyScopeSelect) policyScopeSelect.value = "secrets";
        if (policyActionSelect) policyActionSelect.value = "block";
        if (policyNotesInput) policyNotesInput.value = "Prevent secret token leaks to public developer portals";
      } else if (template === "block-site") {
        policyNameInput.value = "Restricted Website Barrier";
        policyUrlInput.value = "untrusted-site.com";
        if (policyBlockSiteCheckbox) policyBlockSiteCheckbox.checked = true;
        if (policyActionSelect) policyActionSelect.value = "block";
        if (policyNotesInput) policyNotesInput.value = "Full site interaction block enforced";
      }
      updatePolicyDialogVisibility();
    });
  });

  function renderSitePolicies(policies: SitePolicy[]) {
    if (!policiesList || !noPolicies) return;
    policiesList.replaceChildren();
    if (!policies || policies.length === 0) {
      noPolicies.hidden = false;
      return;
    }
    noPolicies.hidden = true;
    for (const pol of policies) {
      const item = document.createElement("li");
      item.className = "finding policy-card";
      item.style.flexDirection = "column";
      item.style.alignItems = "stretch";

      const topRow = document.createElement("div");
      topRow.style.display = "flex";
      topRow.style.justifyContent = "space-between";
      topRow.style.alignItems = "center";

      const titleGroup = document.createElement("div");
      titleGroup.style.display = "flex";
      titleGroup.style.alignItems = "center";
      titleGroup.style.gap = "6px";
      titleGroup.style.flexWrap = "wrap";

      const nameSpan = document.createElement("strong");
      nameSpan.textContent = pol.name;
      nameSpan.style.fontSize = "12px";

      if (pol.blockEntireSite) {
        const blockedBadge = document.createElement("span");
        blockedBadge.className = "policy-badge--blocked";
        blockedBadge.textContent = "FULL SITE BLOCKED";
        titleGroup.append(nameSpan, blockedBadge);
      } else {
        const actionBadge = document.createElement("span");
        actionBadge.className = "finding__severity";
        actionBadge.textContent = pol.action.toUpperCase();
        actionBadge.dataset.level = pol.action === "block" ? "critical" : pol.action === "redact" ? "high" : "low";
        titleGroup.append(nameSpan, actionBadge);
      }

      const actionsDiv = document.createElement("div");
      actionsDiv.style.display = "flex";
      actionsDiv.style.gap = "6px";
      actionsDiv.style.alignItems = "center";

      const toggleBtn = document.createElement("button");
      toggleBtn.className = "btn btn--ghost btn--sm";
      toggleBtn.textContent = pol.enabled ? "Disable" : "Enable";
      toggleBtn.addEventListener("click", async () => {
        const updated = await toggleSitePolicy(pol.id);
        const current = await loadSettings();
        renderSitePolicies(updated);
        speakAnnouncement(pol.enabled ? `Policy ${pol.name} disabled` : `Policy ${pol.name} enabled`, current);
      });

      const delBtn = document.createElement("button");
      delBtn.className = "btn btn--ghost btn--sm";
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", async () => {
        const updated = await deleteSitePolicy(pol.id);
        await recordAudit({
          ts: new Date().toISOString(),
          action: "policy_deleted",
          policyId: pol.id,
          outcome: "ok",
        });
        const current = await loadSettings();
        renderSitePolicies(updated);
        speakAnnouncement(`Policy ${pol.name} deleted`, current);
      });

      actionsDiv.append(toggleBtn, delBtn);
      topRow.append(titleGroup, actionsDiv);

      const metaRow = document.createElement("div");
      metaRow.className = "policy-card__meta";

      const urlCode = document.createElement("code");
      urlCode.textContent = pol.urlPattern;

      const scopeSpan = document.createElement("span");
      scopeSpan.className = "policy-badge--scope";
      if (pol.blockEntireSite) {
        scopeSpan.textContent = "Entire Site Interaction Block";
      } else {
        const scopeText = Array.isArray(pol.scope)
          ? `Custom (${pol.scope.length} categories)`
          : pol.scope.toUpperCase();
        scopeSpan.textContent = `Scope: ${scopeText}`;
      }

      metaRow.append(urlCode, scopeSpan);
      item.append(topRow, metaRow);

      if (pol.notes) {
        const notesDiv = document.createElement("div");
        notesDiv.className = "policy-card__notes";
        notesDiv.textContent = pol.notes;
        item.append(notesDiv);
      }

      policiesList.appendChild(item);
    }
  }

  openPolicyBtn?.addEventListener("click", () => {
    if (!policyNameInput || !policyUrlInput || !policyDialog) return;
    policyNameInput.value = "";
    policyUrlInput.value = "";
    if (policyBlockSiteCheckbox) policyBlockSiteCheckbox.checked = false;
    if (policyScopeSelect) policyScopeSelect.value = "phi";
    if (policyActionSelect) policyActionSelect.value = "block";
    if (policyNotesInput) policyNotesInput.value = "";
    if (policyDialogError) {
      policyDialogError.hidden = true;
      policyDialogError.textContent = "";
    }
    initCustomCategoriesPicker();
    updatePolicyDialogVisibility();
    policyDialog.showModal();
    policyNameInput.focus();
  });

  cancelPolicyBtn?.addEventListener("click", () => {
    policyDialog?.close();
  });

  savePolicyBtn?.addEventListener("click", async () => {
    if (!policyNameInput || !policyUrlInput || !policyScopeSelect || !policyActionSelect) return;
    const name = policyNameInput.value.trim();
    const urlPattern = policyUrlInput.value.trim();

    if (!name) {
      if (policyDialogError) {
        policyDialogError.textContent = "Policy name is required";
        policyDialogError.hidden = false;
      }
      return;
    }

    if (!urlPattern) {
      if (policyDialogError) {
        policyDialogError.textContent = "URL pattern is required";
        policyDialogError.hidden = false;
      }
      return;
    }

    const isBlockSite = policyBlockSiteCheckbox?.checked ?? false;
    let scope: PolicyScope = policyScopeSelect.value as PolicyScope;
    if (isBlockSite) {
      scope = "all";
    } else if (policyScopeSelect.value === "custom") {
      const checkedBoxes = policyCustomCategoriesContainer
        ? Array.from(policyCustomCategoriesContainer.querySelectorAll<HTMLInputElement>("input[type='checkbox']:checked"))
        : [];
      if (checkedBoxes.length === 0) {
        if (policyDialogError) {
          policyDialogError.textContent = "Select at least one category for custom scope";
          policyDialogError.hidden = false;
        }
        return;
      }
      scope = checkedBoxes.map((cb) => cb.value as FindingCategory);
    }

    const action = isBlockSite ? "block" : (policyActionSelect.value as PolicyAction);
    const notes = policyNotesInput?.value.trim() || undefined;

    const newPolicy: SitePolicy = {
      id: crypto.randomUUID(),
      name,
      urlPattern,
      scope,
      action,
      enabled: true,
      createdAt: new Date().toISOString(),
      blockEntireSite: isBlockSite,
      notes,
    };

    const updated = await saveSitePolicy(newPolicy);
    await recordAudit({
      ts: new Date().toISOString(),
      action: "policy_created",
      policyId: newPolicy.id,
      policyAction: newPolicy.action,
      outcome: "ok",
    });

    renderSitePolicies(updated);
    policyDialog?.close();

    const current = await loadSettings();
    speakAnnouncement(`Site policy ${name} saved`, current);
  });

  exportPoliciesBtn?.addEventListener("click", async () => {
    const policies = await loadSitePolicies();
    const current = await loadSettings();
    if (policies.length === 0) {
      speakAnnouncement("No site policies to export", current);
      return;
    }
    const json = JSON.stringify(policies, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "governworld-site-policies-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    speakAnnouncement(t(current.language, "policies_exported"), current);
  });

  importPoliciesBtn?.addEventListener("click", () => {
    importPoliciesFile?.click();
  });

  importPoliciesFile?.addEventListener("change", async () => {
    const file = importPoliciesFile.files?.[0];
    if (!file) return;
    const current = await loadSettings();
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) {
        speakAnnouncement(t(current.language, "invalid_policies_file"), current);
        return;
      }
      const valid: SitePolicy[] = [];
      for (const item of parsed) {
        const res = parseSitePolicy(item);
        if (res.ok) valid.push(res.policy);
      }
      if (valid.length === 0) {
        speakAnnouncement(t(current.language, "invalid_policies_file"), current);
        return;
      }
      const existing = await loadSitePolicies();
      const map = new Map<string, SitePolicy>();
      for (const p of existing) map.set(p.id, p);
      for (const p of valid) map.set(p.id, p);
      const merged = [...map.values()];
      await saveSitePolicies(merged);
      renderSitePolicies(merged);
      speakAnnouncement(t(current.language, "policies_imported"), current);
    } catch {
      speakAnnouncement(t(current.language, "invalid_policies_file"), current);
    } finally {
      importPoliciesFile.value = "";
    }
  });

  const initialPolicies = await loadSitePolicies();
  renderSitePolicies(initialPolicies);

  function renderCommunityAccount(_account: CommunityAccount | null) {
    isCommunityLinked = false;
    if (linkCommunityBtn) linkCommunityBtn.textContent = "Community Account Unavailable";
    if (communityAccountStatus) communityAccountStatus.textContent = "Community features are unavailable until server authorization is configured.";
  }

  function renderCommunityRules(rules: CommunityRule[]) {
    if (!communityRulesList) return;
    communityRulesList.replaceChildren();
    if (!rules || rules.length === 0) {
      const empty = document.createElement("p");
      empty.className = "footnote";
      empty.textContent = "No community rules fetched yet.";
      communityRulesList.appendChild(empty);
      return;
    }
    for (const rule of rules) {
      const item = document.createElement("li");
      item.className = "finding";
      item.style.flexDirection = "column";

      const title = document.createElement("strong");
      title.textContent = `${rule.name} (by ${rule.createdByHandle})`;
      title.style.fontSize = "12px";

      const code = document.createElement("code");
      code.textContent = `/${rule.pattern}/${rule.flags} [${rule.category}]`;
      code.style.fontSize = "11px";
      code.style.color = "var(--text-muted)";

      item.append(title, code);
      communityRulesList.appendChild(item);
    }
  }

  /** Show the one-time "verify your work" accuracy notice after a scan completes. */
  async function maybeShowVerifyNotice(): Promise<void> {
    const currentSettings = await loadSettings();
    if (currentSettings.verificationNoticeAcknowledged) return;
    const dialog = document.getElementById("verify-dialog") as HTMLDialogElement | null;
    if (!dialog) return;
    const dismiss = document.getElementById("verify-dismiss") as HTMLButtonElement | null;
    const understood = document.getElementById("verify-understood") as HTMLButtonElement | null;
    const acknowledge = async (): Promise<void> => {
      dialog.close();
      const current = await loadSettings();
      await saveSettings({ ...current, verificationNoticeAcknowledged: true });
    };
    dismiss?.addEventListener("click", () => void acknowledge());
    understood?.addEventListener("click", () => void acknowledge());
    dialog.showModal();
  }

  chrome.runtime.onMessage.addListener(async (raw: unknown) => {
    const validation = validateMessage(raw);
    if (!validation.ok) return;
    const message = validation.message;
    if (message.type === "POPUP_SCAN_PROGRESS") {
      const summary = document.getElementById("scan-summary") as HTMLDivElement | null;
      const status = document.getElementById("status") as HTMLParagraphElement | null;
      const summaryChars = document.getElementById("summary-chars") as HTMLParagraphElement | null;
      if (!lastState || lastState.scanning || !lastState.sessionId || lastState.sessionId === message.sessionId) {
        if (summary) summary.hidden = false;
        if (status) {
          status.textContent = t(currentLang, "status_scanning_window", {
            current: String(message.windowsCompleted),
            total: String(message.windowsTotal),
          });
          status.classList.remove("status--error");
        }
        if (summaryChars) {
          summaryChars.textContent = t(currentLang, "status_scanning_chars_progress", {
            scanned: message.charsScanned.toLocaleString(),
            total: message.charsTotal.toLocaleString(),
            findings: String(message.findingsSoFar),
          });
        }
      }
      return;
    }
    if (message.type === "POPUP_STATE_CHUNK") {
      const key = `${message.requestId}:${message.sessionId}`;
      let entry = pendingStateChunks.get(key);
      if (!entry) {
        entry = { sessionId: message.sessionId, totalChunks: message.totalChunks, chunks: new Map() };
        pendingStateChunks.set(key, entry);
      }
      entry.chunks.set(message.chunkIndex, message.findings);
      return;
    }
    if (message.type === "POPUP_STATE") {
      const priorState = lastState;
      let nextState = message.state;
      if (message.totalChunks && message.totalChunks > 1) {
        const key = `${message.requestId}:${message.state.sessionId ?? "state"}`;
        const entry = pendingStateChunks.get(key);
        pendingStateChunks.delete(key);
        const combinedFindings: Finding[] = [];
        const finalIdx = message.chunkIndex ?? message.totalChunks - 1;
        let missing = false;
        for (let i = 0; i < message.totalChunks; i++) {
          if (i === finalIdx) {
            combinedFindings.push(...message.state.findings);
          } else {
            const chunk = entry?.chunks.get(i);
            if (!chunk) missing = true;
            else combinedFindings.push(...chunk);
          }
        }
        nextState = {
          ...message.state,
          findings: combinedFindings,
          findingsTruncated: missing ? true : false,
          totalFindings: missing ? message.state.totalFindings : combinedFindings.length,
          ...(missing ? { truncated: true, coverageStatus: "PARTIALLY_SCANNED" } : {}),
        };
      }
      lastState = nextState;
      renderState(lastState);
      if (priorState?.scanning && !lastState.scanning && lastState.scanned) {
        void (async () => {
          const current = await loadSettings();
          if (lastState && lastState.findings.length > 0) {
            speakAnnouncement(t(current.language, "speech_scan_complete", { count: lastState.findings.length }), current);
          } else {
            speakAnnouncement(t(current.language, "speech_scan_none"), current);
          }
        })();
      }
      if (lastState.scanned && lastState.findings.length > 0) {
        void maybeShowVerifyNotice();
      }
      return;
    }
    if (message.type === "POPUP_COPY_RESULT") {
      const text = message.text;
      void (async () => {
        await copyToClipboard(text);
        const status = document.getElementById("status") as HTMLParagraphElement | null;
        if (status) {
          status.textContent = "Copied redacted text to clipboard.";
          status.classList.remove("status--error");
        }
      })();
      return;
    }
    if (message.type === "POPUP_AUDIT_EXPORT") {
      const download = (content: string, filename: string, mime: string): void => {
        const blob = new Blob([content], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
      };
      download(message.jsonl, `governworld-audit-${message.exportedAt.split("T")[0]}.jsonl`, "application/jsonl");
      download(
        JSON.stringify({ signature: message.signatureBase64, publicKeyJwk: message.publicKeyJwk, exportedAt: message.exportedAt }, null, 2),
        `governworld-audit-${message.exportedAt.split("T")[0]}.sig.json`,
        "application/json"
      );
      const eventCount = message.jsonl ? message.jsonl.split("\n").filter((l) => l.trim().length > 0).length : 0;
      const certHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>GovernWorld — Verifiable Compliance Certificate</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; padding: 40px; margin: 0; line-height: 1.5; }
  .cert { max-width: 760px; margin: 0 auto; background: #1e293b; border: 2px solid #38bdf8; border-radius: 12px; padding: 36px; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5); }
  h1 { margin: 0 0 8px; font-size: 24px; color: #38bdf8; letter-spacing: -0.5px; }
  .subtitle { font-size: 14px; color: #94a3b8; margin-bottom: 24px; border-bottom: 1px solid #334155; padding-bottom: 16px; }
  .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin-bottom: 24px; }
  .box { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 14px; }
  .label { font-size: 11px; text-transform: uppercase; color: #94a3b8; font-weight: 600; margin-bottom: 4px; }
  .val { font-size: 13px; color: #f1f5f9; font-family: ui-monospace, monospace; word-break: break-all; }
  .guarantee { background: rgba(34, 197, 94, 0.1); border: 1px solid rgba(34, 197, 94, 0.3); border-radius: 8px; padding: 14px; margin-bottom: 24px; font-size: 13px; color: #86efac; }
  .footer { font-size: 12px; color: #64748b; text-align: center; border-top: 1px solid #334155; padding-top: 16px; }
  @media print { body { background: #fff; color: #000; padding: 0; } .cert { border: 1px solid #000; box-shadow: none; background: #fff; color: #000; } .box { border: 1px solid #ccc; background: #fafafa; } .val { color: #000; } .guarantee { background: #f0fdf4; border-color: #86efac; color: #166534; } }
</style>
</head>
<body>
<div class="cert">
  <h1>GovernWorld Compliance Certificate</h1>
  <div class="subtitle">Cryptographic Audit Trail & Client-Side Zero-Egress Attestation</div>
  <div class="guarantee">
    <strong>Verified Local Execution:</strong> All redaction, optical character recognition (OCR), pattern detection, and cryptographic signing occurred exclusively on the user device. No raw documents or unmasked sensitive data were transmitted over external network boundaries.
  </div>
  <div class="grid">
    <div class="box"><div class="label">Export Timestamp</div><div class="val">${message.exportedAt}</div></div>
    <div class="box"><div class="label">Total Audited Events</div><div class="val">${eventCount}</div></div>
    <div class="box"><div class="label">Cryptographic Algorithm</div><div class="val">ECDSA P-256 (SHA-256)</div></div>
    <div class="box"><div class="label">Public Key Curve / Type</div><div class="val">${(message.publicKeyJwk as any)?.crv ?? "P-256"} / ${(message.publicKeyJwk as any)?.kty ?? "EC"}</div></div>
  </div>
  <div class="box" style="margin-bottom: 24px;">
    <div class="label">ECDSA Digital Signature (Base64)</div>
    <div class="val">${message.signatureBase64}</div>
  </div>
  <div class="footer">
    Independent verification: execute <code>node scripts/verify-audit.mjs &lt;export.sig.json&gt;</code> using any Node.js runtime.
  </div>
</div>
</body>
</html>`;
      download(
        certHtml,
        `governworld-compliance-certificate-${message.exportedAt.split("T")[0]}.html`,
        "text/html"
      );
      return;
    }
    if (message.type === "POPUP_DOC_COUNT_RESULT") {
      if (cancelledDocTokens.has(message.requestId)) return;
      // The document's real length, known before anything slow ran. One pass
      // covers it: scan from the top. Longer: let the user choose which window,
      // rather than silently dropping everything past the cap.
      hideDocProgress();
      const total = message.totalPages;
      if (total <= MAX_DOC_PAGES) {
        startPreview(0, total);
      } else if (pendingCountFile) {
        windowTotalPages = total;
        openWindowDialog(total, 1);
      }
      return;
    }
    if (message.type === "POPUP_DOC_CAPTURE_READY") {
      // The worker staged the image lifted off the page. Preview it through the
      // ordinary document path, so OCR, review, redaction, download and print
      // are exactly the ones an uploaded file gets - there is no second
      // redaction surface to keep in step with the first. It goes through the
      // same count pass as a picked file, so the two paths cannot diverge.
      hideDocProgress();
      startCount(message.fileKey, message.name, message.mimeType, message.kind, message.degraded);
      // State the limit of the source: a screen capture OCRs worse than the
      // original file, and the user must know which one they are looking at.
      setDocStatus(
        message.degraded ? t(currentLang, "image_capture_screen") : t(currentLang, "image_capture_full"),
        false
      );
      return;
    }
    if (message.type === "POPUP_DOC_STATE") {
      if (
        cancelledDocTokens.has(message.requestId) ||
        cancelledDocTokens.has(message.fileKey) ||
        cancelledDocTokens.has(message.docId)
      ) {
        return;
      }
      hideDocProgress();
      // Match on fileKey so the first reply can land on the placeholder session
      // created by beginDocSession(), which has no docId yet. Fall back to docId
      // for a session the worker has already identified.
      //
      // A null `lastDoc` is not a mismatch: it means the popup was just opened
      // and the worker is naming the document that is already loaded. Dropping
      // that message is what left the studio empty after a reload, so adopt it.
      if (!lastDoc) {
        lastDoc = {
          docId: message.docId,
          fileKey: message.fileKey,
          name: message.name,
          mimeType: message.mimeType,
          kind: message.kind,
          pages: [],
        };
      } else if (lastDoc.docId ? message.docId !== lastDoc.docId : message.fileKey !== lastDoc.fileKey) {
        return;
      }
      const doc = lastDoc;
      doc.docId = message.docId;
      doc.name = message.name;
      doc.fileKey = message.fileKey;
      doc.mimeType = message.mimeType;
      doc.kind = message.kind;
      doc.pages = message.pages;
      // The document's real length and where this pass started. Without them
      // the studio can only say "20 pages", which is how a window of a longer
      // document used to pass for the whole thing.
      doc.totalPages = message.totalPages ?? message.pages.length;
      doc.pageOffset = message.pageOffset ?? 0;
      doc.truncated = message.truncated === true;
      renderDoc(doc);
      void refreshStagedStorageAudit();
      const found = message.pages.reduce((n, p) => n + p.findings.length, 0);
      // The preview is finished, so the progress row must stay down. Calling
      // renderDocStage() unconditionally re-showed it with "Processing
      // document..." next to a Cancel button, leaving a spinner running forever
      // on an already-processed document. The studio itself now carries the
      // result (page count, per-page findings, and the findings badge).
      hideDocProgress();
      if (found === 0) {
        setDocStatus("No sensitive values were found in this document.", true);
      } else {
        setDocStatus("", false);
      }
      return;
    }
    if (message.type === "POPUP_DOC_DONE") {
      // The redaction is finished, so the progress row must come down. The
      // worker streams POPUP_DOC_STATUS verification updates, and each one
      // re-showed that row, leaving a spinner and a Cancel button next to a
      // document that had already been written. The verification result is the
      // most trust-relevant line for a redaction tool, so it is carried into
      // the status instead of being dropped with the row.
      const verificationNote = (() => {
        const progressText = (document.getElementById("doc-progress-text")?.textContent || "").trim();
        hideDocProgress();
        return /regions?/.test(progressText) ? progressText : "";
      })();
      const finishWith = (text: string, isError: boolean): void => {
        setDocStatus(verificationNote ? `${text} ${verificationNote}.` : text, isError);
      };
      void (async () => {
        const current = await loadSettings();
        speakAnnouncement(t(current.language, "speech_doc_redacted"), current);
      })();
      const reportDelivery = (delivered: boolean) => {
        void sendMessage({
          type: "POPUP_DOC_DELIVERY_REPORT",
          requestId: message.requestId,
          delivered,
        });
      };
      if ((message as any).outputBytesBase64 && (message as any).outputMimeType) {
        try {
          const b64 = (message as any).outputBytesBase64 as string;
          const mime = (message as any).outputMimeType as string;
          const binary = atob(b64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          const blob = new Blob([bytes], { type: mime });
          const url = URL.createObjectURL(blob);

          const deliverViaDownloads = async (): Promise<boolean> => {
            try {
              await chrome.downloads.download({ url, filename: message.outputName, saveAs: true });
              return true;
            } catch {
              return false;
            }
          };
          const deliverViaAnchor = async (): Promise<boolean> => {
            try {
              const a = document.createElement("a");
              a.href = url;
              a.download = message.outputName;
              a.click();
              return true;
            } catch {
              return false;
            }
          };

          void (async () => {
            const hasDownloadsApi = typeof chrome !== "undefined" && Boolean(chrome.downloads?.download);
            const delivered = hasDownloadsApi ? await deliverViaDownloads() : false;
            const finalOutcome = delivered ? true : await deliverViaAnchor();
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
            reportDelivery(finalOutcome);
          })();

          const current = await loadSettings();
          finishWith(t(current.language, "doc_downloaded", { name: message.outputName }), false);
        } catch {
          reportDelivery(false);
          const current = await loadSettings();
          finishWith(t(current.language, "doc_save_failed", { name: message.outputName }), true);
        }
      } else {
        // A verification failure is reported above as an error, but this success
        // line would immediately replace it — leaving the user believing a file
        // whose boxes were measured as uncovered was safely redacted. The failure
        // is the more important message, so it wins.
        if (!docVerificationProblem) {
          finishWith(`Saved ${message.outputName}. The original file was not changed.`, false);
        }
      }

      // Offer the print view only when the worker actually staged verified
      // pages. Absent printFileKey means staging failed; the download above is
      // still correct, so the redaction is not treated as a failure.
      if (printBar) {
        if (message.printFileKey) {
          lastPrintFileKey = message.printFileKey;
          printBar.hidden = false;
        } else {
          printBar.hidden = true;
          lastPrintFileKey = null;
        }
      }
      clearDocUi({ keepRedacted: Boolean(message.printFileKey) });
      void refreshStagedStorageAudit();
      return;
    }
    if (message.type === "POPUP_DOC_STATUS") {
      if (cancelledDocTokens.has(message.requestId)) return;
      renderDocStage(message);
      return;
    }
    if (message.type === "POPUP_DOC_ERROR") {
      if (cancelledDocTokens.has(message.requestId)) return;
      // The run is over, so the spinner has to stop; leaving it up would show
      // "Processing document..." next to an error.
      hideDocProgress();
      setDocStatus(message.userMessage, true);
      void refreshStagedStorageAudit();
      return;
    }
    if (message.type === "POPUP_STAGED_STATS_STATE") {
      renderStagedStorageAudit(message.stats, message.purged);
      return;
    }
    if (message.type === "POPUP_NOTIFICATIONS_STATE") {
      if (notificationsToggle) {
        notificationsToggle.checked = message.granted;
        notificationsToggle.setAttribute("aria-checked", message.granted ? "true" : "false");
      }
      if (notificationsStatus) {
        const current = await loadSettings();
        notificationsStatus.textContent = message.granted
          ? t(current.language, "notifications_enabled")
          : t(current.language, "notifications_denied");
      }
      return;
    }
    if (message.type === "POPUP_NOTIFICATION_PREFS_STATE") {
      if (notificationsToggle) {
        notificationsToggle.checked = message.prefs.systemEnabled;
        notificationsToggle.setAttribute("aria-checked", message.prefs.systemEnabled ? "true" : "false");
      }
      if (notifyToastToggle) {
        notifyToastToggle.checked = message.prefs.toastEnabled;
        notifyToastToggle.setAttribute("aria-checked", message.prefs.toastEnabled ? "true" : "false");
      }
      if (notifyBadgeToggle) {
        notifyBadgeToggle.checked = message.prefs.badgeEnabled;
        notifyBadgeToggle.setAttribute("aria-checked", message.prefs.badgeEnabled ? "true" : "false");
      }
      if (notifySoundToggle) {
        notifySoundToggle.checked = message.prefs.soundEnabled;
        notifySoundToggle.setAttribute("aria-checked", message.prefs.soundEnabled ? "true" : "false");
      }
      if (notifyFindingsToggle) {
        notifyFindingsToggle.checked = message.prefs.notifyCriticalFindings;
        notifyFindingsToggle.setAttribute("aria-checked", message.prefs.notifyCriticalFindings ? "true" : "false");
      }
      if (notifyPasteToggle) {
        notifyPasteToggle.checked = message.prefs.notifyPasteInterception;
        notifyPasteToggle.setAttribute("aria-checked", message.prefs.notifyPasteInterception ? "true" : "false");
      }
      if (notifyPolicyToggle) {
        notifyPolicyToggle.checked = message.prefs.notifyPolicyChanges;
        notifyPolicyToggle.setAttribute("aria-checked", message.prefs.notifyPolicyChanges ? "true" : "false");
      }
      if (notifyRedactToggle) {
        notifyRedactToggle.checked = message.prefs.notifyRedactionComplete;
        notifyRedactToggle.setAttribute("aria-checked", message.prefs.notifyRedactionComplete ? "true" : "false");
      }
      if (notifyPrivacySelect) {
        notifyPrivacySelect.value = message.prefs.privacyMode;
      }
      if (notificationsStatus) {
        const current = await loadSettings();
        notificationsStatus.textContent = t(current.language, "notifications_saved");
      }
      return;
    }
    if (message.type === "POPUP_ACCOUNT_STATE") {
      if (accountStatus) {
        if (message.error) {
          accountStatus.textContent = message.error.userMessage;
          return;
        }
        renderAccountView(message.account);
        if (message.linked) {
          if (originInput) originInput.value = message.gatewayOrigin ?? "";
          if (keyInput) keyInput.value = "";
          if (message.credentialAvailable === false) {
            if (purchaseBtn) purchaseBtn.hidden = true;
            accountStatus.textContent =
              "Linked — re-enter your key to continue purchases in this browser session.";
            return;
          }
          if (purchaseBtn) purchaseBtn.hidden = false;
          accountStatus.textContent = message.accountLabel
            ? `Linked: ${message.accountLabel}`
            : "Linked to your GovernWorld workspace.";
        } else {
          if (purchaseBtn) purchaseBtn.hidden = true;
          accountStatus.textContent = "No account linked.";
        }
      }
      return;
    }
    if (message.type === "POPUP_ACCOUNT_PURCHASE_URL") {
      if (accountStatus) {
        const current = await loadSettings();
        accountStatus.textContent = t(current.language, "stripe_checkout_opened");
      }
      return;
    }
    if (message.type === "POPUP_OAUTH_STATUS") {
      if (oauthStatus) {
        oauthStatus.hidden = false;
        oauthStatus.textContent = message.message || (message.connected ? `Connected (${message.tenantName ?? message.tenantId ?? "Workspace"})` : "Not connected via OAuth.");
      }
      return;
    }
    if (message.type === "POPUP_API_STATUS_STATE") {
      if (apiConnectionStatus) {
        const stateLabel = message.connectionState ? `Gateway API: ${message.connectionState}` : "Gateway API: disconnected";
        apiConnectionStatus.textContent = message.error ? `${stateLabel} (${message.error})` : stateLabel;
      }
      if (apiDisconnectBtn) {
        apiDisconnectBtn.hidden = message.connectionState !== "connected";
      }
      return;
    }
    if (message.type === "POPUP_API_POLICY_STATE") {
      if (apiConnectionStatus) {
        apiConnectionStatus.textContent = message.success
          ? `Policy synced (${message.rulesCount ?? 0} rules, v${message.policyVersion ?? "1"}).`
          : message.error || "Gateway policy sync unavailable.";
      }
      return;
    }
    if (message.type === "POPUP_API_SUBMIT_RESULT" || message.type === "POPUP_COMMUNITY_CONTRIBUTE_RESULT") {
      if (communityAccountStatus) {
        communityAccountStatus.textContent = message.success
          ? "Rule submitted for review."
          : message.error || "Rule submission unavailable.";
      }
      return;
    }
    if (message.type === "POPUP_MANAGEMENT_STATUS_STATE") {
      if (mgmtStatusText) {
        if (message.error) {
          mgmtStatusText.textContent = message.error;
        } else if (message.enrolled && message.mode === "MANAGE") {
          const orgLabel = message.organizationName || message.organizationId || "Organization";
          const verLabel = message.appliedPolicyVersion !== undefined ? ` (Policy v${message.appliedPolicyVersion})` : "";
          mgmtStatusText.textContent = `MANAGE Mode enrolled: ${orgLabel}${verLabel}`;
        } else {
          mgmtStatusText.textContent = "Standalone (LOCAL Mode)";
        }
      }
      if (mgmtUnenrollBtn) {
        mgmtUnenrollBtn.hidden = !message.enrolled;
      }
      void refreshProtectionStatus();
      return;
    }
    if (message.type === "POPUP_CUSTOM_PATTERNS_STATE") {
      renderCustomPatterns(message.patterns);
      return;
    }
    if (message.type === "POPUP_COMMUNITY_ACCOUNT_DETAILS_STATE") {
      renderCommunityAccount(message.account);
      return;
    }
    if (message.type === "POPUP_COMMUNITY_COMMUNITY_RULES_STATE") {
      renderCommunityRules(message.rules);
      return;
    }
    if (message.type === "POPUP_WIZARD_ANALYSIS_RESULT") {
      currentProposals = message.proposals;
      selectedProposalIndex = 0;
      if (wizardProposalsContainer) {
        wizardProposalsContainer.replaceChildren();
        if (currentProposals.length === 0) {
          const noProp = document.createElement("p");
          noProp.className = "footnote";
          noProp.textContent = "No regex proposals found for these examples.";
          wizardProposalsContainer.appendChild(noProp);
        } else {
          currentProposals.forEach((analysis, i) => {
            const card = document.createElement("div");
            card.style.padding = "8px";
            card.style.background = "var(--bg-inset)";
            card.style.border = "1px solid var(--border)";
            card.style.borderRadius = "var(--radius-sm)";
            card.style.cursor = "pointer";

            const title = document.createElement("strong");
            title.textContent = "Proposed pattern";
            title.style.fontSize = "12px";

            const code = document.createElement("code");
            code.textContent = `/${analysis.proposedPattern}/${analysis.proposedFlags}`;
            code.style.display = "block";
            code.style.fontSize = "11px";
            code.style.marginTop = "2px";

            const meta = document.createElement("p");
            meta.className = "footnote";
            meta.textContent = `Matches ${Math.round(analysis.qualityScore * 100)}% of positive examples`;

            card.append(title, code, meta);
            card.addEventListener("click", () => {
              selectedProposalIndex = i;
              Array.from(wizardProposalsContainer.children).forEach((c) => {
                (c as HTMLElement).style.borderColor = "var(--border)";
              });
              card.style.borderColor = "var(--accent)";
            });
            if (i === 0) card.style.borderColor = "var(--accent)";
            wizardProposalsContainer.appendChild(card);
          });
        }
      }
      showWizardStep(2);
      return;
    }
    if (message.type === "POPUP_WIZARD_TEST_RESULT") {
      if (wizardTestResultsBox) {
        const matchesCount = message.testResult.reduce(
          (sum, r) => sum + (r.matched ? r.matchCount : 0),
          0
        );
        wizardTestResultsBox.textContent = `Pattern matched ${matchesCount} instance(s) in sample text.`;
        wizardTestResultsBox.style.color = matchesCount > 0 ? "var(--ok)" : "var(--warning)";
      }
      return;
    }
  });

  const initialTab = await getActiveWebTab().catch(() => undefined);
  void sendMessage({ type: "POPUP_GET_STATE", requestId: requestId(), ...(initialTab?.id ? { tabId: initialTab.id } : {}) });
  const initialPatterns = await loadCustomPatterns().catch(() => null);
  if (initialPatterns) renderCustomPatterns(initialPatterns);
  void chrome.runtime.sendMessage({ type: "POPUP_CUSTOM_PATTERNS_GET", requestId: requestId() }).catch(() => {});
  void chrome.runtime.sendMessage({ type: "POPUP_COMMUNITY_ACCOUNT_GET", requestId: requestId() }).catch(() => {});
  void chrome.runtime.sendMessage({ type: "POPUP_MANAGEMENT_GET_STATUS", requestId: requestId() }).catch(() => {});
  void chrome.runtime.sendMessage({ type: "POPUP_API_GET_STATUS", requestId: requestId() }).catch(() => {});

  // Check for Side Panel handoff from toolbar popup
  async function checkWizardSidePanelHandoff(): Promise<void> {
    if (typeof chrome === "undefined" || !chrome.storage?.local) return;

    try {
      const data = await chrome.storage.local.get("wizardHandoffPending");
      const handoff = data?.wizardHandoffPending as {
        step?: number;
        draftPositiveExamples?: string;
        draftNegativeExamples?: string;
        draftRuleName?: string;
        timestamp?: number;
      } | undefined;

      if (!handoff || typeof handoff !== "object" || Date.now() - (handoff.timestamp ?? 0) > 30_000) return;

      await chrome.storage.local.remove("wizardHandoffPending");

      // 1. Switch to Logic tab
      document.querySelector<HTMLButtonElement>('.tab-btn[data-tab="logic"]')?.click();

      // 2. Open the Wizard modal to Step 1
      if (wizardDialog && !wizardDialog.open) {
        showWizardStep(1);
        wizardDialog.showModal();
      }

      // 3. Restore any draft inputs the user typed before clicking Import File
      if (wizardPosInput && handoff.draftPositiveExamples) {
        wizardPosInput.value = handoff.draftPositiveExamples;
        wizardPosInput.dispatchEvent(new Event("input", { bubbles: true }));
      }
      if (wizardNegInput && handoff.draftNegativeExamples) {
        wizardNegInput.value = handoff.draftNegativeExamples;
        wizardNegInput.dispatchEvent(new Event("input", { bubbles: true }));
      }
      if (wizardRuleName && handoff.draftRuleName) {
        wizardRuleName.value = handoff.draftRuleName;
      }

      // 4. Guide the user immediately to the import button & dropzone in the Side Panel
      if (wizardImportStatus) {
        wizardImportStatus.textContent = 'Side Panel active — click "Import File ↗" or drag your file below.';
        wizardImportStatus.hidden = false;
      }

      if (wizardImportFileBtn) {
        wizardImportFileBtn.classList.add("wizard-handoff-highlight");
        wizardPosInput?.classList.add("wizard-dropzone-highlight");

        wizardImportFileBtn.focus({ preventScroll: true });
        wizardImportFileBtn.scrollIntoView({ behavior: "smooth", block: "center" });

        const clearHighlight = (): void => {
          wizardImportFileBtn.classList.remove("wizard-handoff-highlight");
          wizardPosInput?.classList.remove("wizard-dropzone-highlight");
        };

        wizardImportFileBtn.addEventListener("click", clearHighlight, { once: true });
        wizardPosInput?.addEventListener("drop", clearHighlight, { once: true });
        window.setTimeout(clearHighlight, 4200);
      }
    } catch {
      // Ignore
    }
  }

  async function checkDocSidePanelHandoff(): Promise<void> {
    if (!isSidePanelContext || typeof chrome === "undefined" || !chrome.storage?.local) return;
    try {
      const data = await chrome.storage.local.get("docHandoffPending");
      const handoff = data?.docHandoffPending as { timestamp?: number } | undefined;
      if (!handoff || typeof handoff !== "object" || Date.now() - (handoff.timestamp ?? 0) > 30_000) return;
      await chrome.storage.local.remove("docHandoffPending");
      switchTab("protection");
      setDocStatus(t(currentLang, "doc_handoff_hint"), false);
      const dz = document.getElementById("doc-dropzone");
      if (dz) {
        dz.classList.add("wizard-dropzone-highlight");
        dz.focus({ preventScroll: true });
        dz.scrollIntoView({ behavior: "smooth", block: "center" });
        window.setTimeout(() => dz.classList.remove("wizard-dropzone-highlight"), 4200);
      }
    } catch {
      // Ignore
    }
  }

  void checkWizardSidePanelHandoff();
  void checkDocSidePanelHandoff();

  // Readiness marker for the automated harnesses, set only once every listener
  // above is bound.
  //
  // `initPopup` awaits settings and storage before it attaches anything, which
  // takes seconds on a cold profile. The harnesses used a fixed 2-2.5s sleep and
  // then drove the UI, so they dispatched events on inputs with nothing bound to
  // them and reported the resulting silence as a product failure. They now poll
  // for this instead of guessing.
  //
  // Placed at the very end deliberately: any earlier and it would claim the popup
  // is interactive while it is not.
  document.documentElement.dataset.gwReady = "1";
}
