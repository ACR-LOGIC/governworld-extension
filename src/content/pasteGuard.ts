// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { detect, maskValue, placeholderLabelFor } from "./detect.js";
import { showToast } from "./toast.js";
import type { RawMatch } from "./detect.js";
import { DEFAULT_SETTINGS, normalizeSettings } from "../shared/settings.js";
import type { FindingCategory, ProtectionMode, Settings } from "../shared/settings.js";
import {
  NO_ENTERPRISE_POLICY,
  parseEnterprisePolicy,
  resolveEffectiveProtection,
  type EnterprisePolicy,
} from "../shared/enterprisePolicy.js";
import type { CustomPattern } from "../shared/customPatterns.js";
import { recordAudit } from "../shared/audit.js";
import { evaluateSitePolicies, parseSitePolicy, SITE_POLICIES_KEY, type SitePolicy } from "../shared/policyStudio.js";

/**
 * Feature Area 2: Proactive 'Paste & Prompt' Shield / Chat & LLM Guard.
 *
 * Intercepts clipboard paste and beforeinput events on input, textarea,
 * and contenteditable elements (optimized for ChatGPT, Claude, Slack, Jira, forms).
 * When sensitive data (API keys, SSNs, credit cards, PHI, etc.) is detected,
 * it intercepts the paste and presents a floating Shadow DOM dialog with
 * masked previews and 3 actions: [Sanitize & Paste], [Paste Unchanged], and [Cancel].
 */

export const CATEGORY_LABELS: Record<string, string> = {
  email: "Email Address",
  phone: "Phone Number",
  ssn: "SSN",
  dob: "Date of Birth",
  medical_record_number: "Medical Record Number (MRN)",
  member_id: "Member ID",
  npi: "Provider NPI",
  dea: "DEA Number",
  mbi: "Medicare ID (MBI)",
  address: "Street Address",
  payment_card: "Payment Card",
  secrets: "API Key / Secret",
  possible_name: "Personal Name",
  custom: "Custom Pattern",
  canadian_sin: "Canadian SIN",
  uk_nhs: "UK NHS Number",
  aadhaar: "Indian Aadhaar",
  pan_india: "Indian PAN Card",
  australian_tfn: "Australian TFN",
  cpf: "Brazilian CPF",
  ip_address: "IP Address",
  username: "Username",
  bank_account: "Bank Account / Routing Number",
  financial: "Salary / Compensation",
};

/** Specific secret label resolver to make the preview dialog crystal clear */
export function getFindingDisplayName(category: FindingCategory, value?: string): string {
  if (category === "secrets" && value) {
    if (/^sk-ant-/.test(value)) return "Anthropic API Key";
    if (/^sk-[A-Za-z0-9]/.test(value)) return "OpenAI API Key";
    if (/^AIza/.test(value)) return "Google API Key";
    if (/^(?:rk|sk|pk)_(?:live|test)_/.test(value)) return "Stripe API Key";
    if (/^(?:ghp_|github_pat_)/.test(value)) return "GitHub Token";
    if (/^xox[baprs]-/.test(value)) return "Slack Token";
    if (/^SG\./.test(value)) return "SendGrid Key";
    if (/^npm_/.test(value)) return "npm Token";
    if (/^SK[0-9a-fA-F]{32}/.test(value)) return "Twilio Key";
    if (/^dapi-/.test(value)) return "Databricks Token";
    if (/^eyJ/.test(value)) return "JSON Web Token (JWT)";
    if (/BEGIN.*PRIVATE KEY/.test(value)) return "Private Key";
    if (/^(?:postgres|mysql|mongodb|redis|amqp|mssql):/i.test(value)) return "Database Connection String";
  }
  return CATEGORY_LABELS[category] ?? category;
}

/** Pure detector helper for paste inspection */
export function detectPasteFindings(
  text: string,
  enabledCategories: FindingCategory[] = DEFAULT_SETTINGS.enabledCategories,
  customPatterns: CustomPattern[] = []
): RawMatch[] {
  if (!text || typeof text !== "string" || text.trim().length === 0) return [];
  return detect(text, enabledCategories, customPatterns);
}

/** Pure sanitization helper replacing detected spans with [REDACTED] placeholders */
export function sanitizePastedText(
  text: string,
  matches: RawMatch[],
  placeholder = "[REDACTED]"
): string {
  if (!matches || matches.length === 0) return text;
  // Sort descending by start to safely slice from end to beginning
  const sorted = [...matches].sort((a, b) => b.start - a.start);
  let result = text;
  for (const match of sorted) {
    result = result.slice(0, match.start) + placeholder + result.slice(match.end);
  }
  return result;
}

function isHtmlElement(node: unknown): node is HTMLElement {
  if (!node || typeof node !== "object") return false;
  if (typeof HTMLElement !== "undefined") return node instanceof HTMLElement;
  return (node as any).nodeType === 1;
}

function isInputElement(node: unknown): node is HTMLInputElement {
  if (!node || typeof node !== "object") return false;
  if (typeof HTMLInputElement !== "undefined") return node instanceof HTMLInputElement;
  return isHtmlElement(node) && (node as any).tagName === "INPUT";
}

function isTextAreaElement(node: unknown): node is HTMLTextAreaElement {
  if (!node || typeof node !== "object") return false;
  if (typeof HTMLTextAreaElement !== "undefined") return node instanceof HTMLTextAreaElement;
  return isHtmlElement(node) && (node as any).tagName === "TEXTAREA";
}

/** Insert text safely into input, textarea, or contenteditable targets */
export function insertTextIntoElement(target: HTMLElement, text: string): boolean {
  target.focus?.();

  // 1. Text input or textarea
  if (isInputElement(target) || isTextAreaElement(target)) {
    const inputOrTextarea = target as HTMLInputElement | HTMLTextAreaElement;
    const start = inputOrTextarea.selectionStart ?? inputOrTextarea.value.length;
    const end = inputOrTextarea.selectionEnd ?? inputOrTextarea.value.length;

    let inserted = false;
    try {
      if (typeof document !== "undefined" && typeof document.execCommand === "function") {
        inserted = document.execCommand("insertText", false, text);
      }
    } catch (err) {
      console.error('SHOW DIALOG THREW:', err);
      inserted = false;
    }

    if (!inserted) {
      if (typeof inputOrTextarea.setRangeText === "function") {
        inputOrTextarea.setRangeText(text, start, end, "end");
      } else {
        inputOrTextarea.value = inputOrTextarea.value.slice(0, start) + text + inputOrTextarea.value.slice(end);
      }
      if (typeof Event !== "undefined") {
        inputOrTextarea.dispatchEvent(new Event("input", { bubbles: true }));
        inputOrTextarea.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    return true;
  }

  // 2. Contenteditable element or child of contenteditable
  const editable = target.isContentEditable
    ? target
    : (target.closest?.("[contenteditable='true'], [contenteditable='']") as HTMLElement | null);

  if (editable) {
    editable.focus();
    let inserted = false;
    try {
      if (typeof document.execCommand === "function") {
        inserted = document.execCommand("insertText", false, text);
      }
    } catch {
      inserted = false;
    }

    if (!inserted && typeof window.getSelection === "function") {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const textNode = (target.ownerDocument || document).createTextNode(text);
        range.insertNode(textNode);
        range.setStartAfter(textNode);
        range.setEndAfter(textNode);
        sel.removeAllRanges();
        sel.addRange(range);
        editable.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
    return true;
  }

  return false;
}


/** Get the current plain text content of an input, textarea, or contenteditable */
export function getElementText(target: HTMLElement): string {
  if (isInputElement(target) || isTextAreaElement(target)) {
    return (target as HTMLInputElement | HTMLTextAreaElement).value ?? "";
  }
  const editable = target.isContentEditable
    ? target
    : (target.closest?.("[contenteditable='true'], [contenteditable='']") as HTMLElement | null);
  if (editable) {
    return editable.innerText ?? editable.textContent ?? "";
  }
  return "";
}

/** Replace the entire text content of an input, textarea, or contenteditable */
export function replaceElementText(target: HTMLElement, text: string): boolean {
  target.focus?.();
  if (isInputElement(target) || isTextAreaElement(target)) {
    const el = target as HTMLInputElement | HTMLTextAreaElement;
    el.value = text;
    if (typeof Event !== "undefined") {
      try {
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } catch {
        // ignore
      }
    }
    return true;
  }
  const editable = target.isContentEditable
    ? target
    : (target.closest?.("[contenteditable='true'], [contenteditable='']") as HTMLElement | null);
  if (editable) {
    if (typeof editable.innerText === "string") {
      editable.innerText = text;
    } else {
      editable.textContent = text;
    }
    if (typeof Event !== "undefined") {
      try {
        editable.dispatchEvent(new Event("input", { bubbles: true }));
      } catch {
        // ignore
      }
    }
    return true;
  }
  return false;
}

/** Check if an editable element is a prompt input or sendable single-line field */
export function isPromptOrSendableInput(target: unknown): target is HTMLElement {
  if (!isHtmlElement(target)) return false;
  const tag = (target as any).tagName?.toUpperCase() || "";
  if (tag === "INPUT") {
    const type = ((target as any).type || "").toLowerCase();
    return ["text", "search", "url"].includes(type);
  }
  if (tag === "TEXTAREA") {
    const el = target as any;
    const hint = (el.getAttribute?.("enterkeyhint") || "").toLowerCase();
    if (hint === "send" || hint === "done" || hint === "go") return true;
    const ph = (el.placeholder || el.getAttribute?.("placeholder") || "").toLowerCase();
    const aria = (el.getAttribute?.("aria-label") || "").toLowerCase();
    const idOrClass = ((el.id || "") + " " + (el.className || "")).toLowerCase();
    if (/(?:prompt|message|chat|ask|question|query|composer)/.test(ph + " " + aria + " " + idOrClass)) return true;
    if (typeof el.closest === "function" && el.closest("form, [data-testid*='chat'], [class*='chat'], [class*='prompt'], [class*='composer']")) return true;
    return false;
  }
  if ((target as any).isContentEditable) {
    const role = ((target as any).getAttribute?.("role") || "").toLowerCase();
    const aria = ((target as any).getAttribute?.("aria-label") || "").toLowerCase();
    const ph = ((target as any).getAttribute?.("data-placeholder") || (target as any).getAttribute?.("placeholder") || (target as any).placeholder || "").toLowerCase();
    if (role === "textbox") return true;
    if (/(?:prompt|message|chat|ask|composer)/.test(aria + " " + ph)) return true;
    if (typeof (target as any).closest === "function" && (target as any).closest("[data-testid*='chat'], [class*='chat'], [class*='prompt'], [class*='composer']")) return true;
  }
  return false;
}

export interface PasteGuardDialogCallbacks {
  onSanitize: () => void;
  onRaw?: () => void;
  onCancel: () => void;
  title?: string;
  subtitle?: string;
  sanitizeLabel?: string;
  rawLabel?: string;
  policyBlocked?: boolean;
}

export interface ActiveDialogHandle {
  host: HTMLElement;
  close: () => void;
  /**
   * Invoke a dialog action by its stable id (`gw-btn-sanitize`, `gw-btn-raw`,
   * `gw-btn-cancel`).
   *
   * Exists because the shadow root is CLOSED. The tests need to drive the
   * dialog the way a user does — clicking a real button — and they used to do it
   * by walking `host.shadowRoot`, which is exactly the reachability that let
   * page JavaScript read the dialog and force "Paste Unchanged". This exposes the
   * three outcomes deliberately instead of the whole tree, so the tests keep
   * testing real behaviour while page script cannot reach them.
   *
   * Returns false when the action is unknown, so a renamed button fails the
   * test rather than silently passing.
   */
  press: (buttonId: "gw-btn-sanitize" | "gw-btn-raw" | "gw-btn-cancel") => boolean;
}

/** Stylesheet for the isolated Shadow DOM modal */
const MODAL_STYLES = `
:host {
  all: initial;
  position: fixed;
  z-index: 2147483647;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-size: 13px;
  line-height: 1.4;
  color: #e2e8f0;
  pointer-events: auto;
}

*, *::before, *::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

.gw-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  backdrop-filter: blur(2px);
  z-index: 1;
}

.gw-dialog {
  position: fixed;
  z-index: 2;
  width: 380px;
  max-width: calc(100vw - 32px);
  background: #0f172a;
  border: 1px solid #334155;
  border-radius: 12px;
  box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(34, 211, 238, 0.15);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  animation: gw-pop-in 0.15s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes gw-pop-in {
  from {
    opacity: 0;
    transform: scale(0.96) translateY(4px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

.gw-header {
  display: flex;
  align-items: center;
  gap: 10px;
}

.gw-shield-icon {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
}

.gw-header-text {
  flex: 1;
  min-width: 0;
}

.gw-title {
  font-size: 14px;
  font-weight: 600;
  color: #f8fafc;
  display: flex;
  align-items: center;
  gap: 6px;
}

.gw-badge {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(239, 68, 68, 0.15);
  color: #f87171;
  border: 1px solid rgba(239, 68, 68, 0.3);
}

.gw-subtitle {
  font-size: 11px;
  color: #94a3b8;
}

.gw-content {
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 8px;
  padding: 10px;
  max-height: 160px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.gw-finding-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-bottom: 6px;
  border-bottom: 1px solid rgba(51, 65, 85, 0.5);
}

.gw-finding-item:last-child {
  padding-bottom: 0;
  border-bottom: none;
}

.gw-finding-label {
  font-size: 11px;
  font-weight: 600;
  color: #38bdf8;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.gw-finding-preview {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  color: #f1f5f9;
  word-break: break-all;
  background: rgba(15, 23, 42, 0.6);
  padding: 2px 6px;
  border-radius: 4px;
}

.gw-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.gw-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 500;
  border-radius: 6px;
  cursor: pointer;
  border: 1px solid transparent;
  transition: all 0.12s ease;
  outline: none;
}

.gw-btn:focus-visible {
  box-shadow: 0 0 0 2px #0f172a, 0 0 0 4px #38bdf8;
}

.gw-btn-primary {
  background: #0284c7;
  color: #ffffff;
  border-color: #0369a1;
  font-weight: 600;
}

.gw-btn-primary:hover {
  background: #0369a1;
}

.gw-btn-ghost {
  background: transparent;
  color: #cbd5e1;
  border-color: #475569;
}

.gw-btn-ghost:hover {
  background: rgba(51, 65, 85, 0.4);
  color: #f8fafc;
}

.gw-btn-danger {
  background: transparent;
  color: #94a3b8;
  border-color: transparent;
}

.gw-btn-danger:hover {
  background: rgba(239, 68, 68, 0.1);
  color: #f87171;
}

.gw-kbd {
  font-size: 10px;
  font-family: inherit;
  opacity: 0.75;
  background: rgba(0, 0, 0, 0.2);
  padding: 1px 4px;
  border-radius: 3px;
  border: 1px solid rgba(255, 255, 255, 0.15);
}
`;

/** Create and show the floating Shadow DOM dialog */
export function showPasteGuardDialog(
  doc: Document,
  target: HTMLElement,
  matches: RawMatch[],
  callbacks: PasteGuardDialogCallbacks
): ActiveDialogHandle {
  // Clean up any existing instance first
  const existingHost = doc.getElementById("__governworld-paste-guard-host");
  if (existingHost) {
    existingHost.remove();
  }

    const host = doc.createElement("div");
  host.id = "__governworld-paste-guard-host";
  // CLOSED, not open. With an open root, page JavaScript could reach the dialog,
  // read the match count and masked previews, and — the real risk — dispatch a
  // click on `#gw-btn-raw` to choose "Paste Unchanged" on the user's behalf,
  // bypassing the guard entirely without them ever seeing it.
  //
  // Nothing here needs the root to be reachable: the handlers below close over
  // `btnSanitize`/`btnRaw`/`btnCancel` directly, and `shadow.activeElement` is
  // read from the retained `shadow` reference rather than from the host.
  const shadow = host.attachShadow({ mode: "closed" });

  const styleEl = doc.createElement("style");
  styleEl.textContent = MODAL_STYLES;
  shadow.appendChild(styleEl);

  const backdrop = doc.createElement("div");
  backdrop.className = "gw-backdrop";

  const dialog = doc.createElement("div");
  dialog.className = "gw-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "gw-pg-title");

  // Position calculation
  const targetRect = target.getBoundingClientRect();
  const viewportWidth = (doc.defaultView?.innerWidth) ?? 1024;
  const viewportHeight = (doc.defaultView?.innerHeight) ?? 768;
  const dialogWidth = 380;
  const approxDialogHeight = 260;

  let left = targetRect.left;
  if (left + dialogWidth > viewportWidth - 16) {
    left = Math.max(16, viewportWidth - dialogWidth - 16);
  }
  if (left < 16) left = 16;

  let top = targetRect.bottom + 8;
  if (top + approxDialogHeight > viewportHeight - 16) {
    // If overflowing viewport bottom, position above the target if space permits
    if (targetRect.top - approxDialogHeight - 8 >= 16) {
      top = targetRect.top - approxDialogHeight - 8;
    } else {
      top = Math.max(16, viewportHeight - approxDialogHeight - 16);
    }
  }

  dialog.style.left = `${Math.round(left)}px`;
  dialog.style.top = `${Math.round(top)}px`;

  // Header - constructed safely via DOM API (no innerHTML)
  const header = doc.createElement("div");
  header.className = "gw-header";

  const svgNS = "http://www.w3.org/2000/svg";
  const createSvg = (tag: string) =>
    typeof doc.createElementNS === "function" ? doc.createElementNS(svgNS, tag) : doc.createElement(tag);

  const svg = createSvg("svg");
  svg.setAttribute("class", "gw-shield-icon");
  svg.setAttribute("viewBox", "0 0 48 48");

  const defs = createSvg("defs");
  const grad = createSvg("linearGradient");
  grad.setAttribute("id", "gw-shield-grad");
  grad.setAttribute("x1", "0");
  grad.setAttribute("y1", "0");
  grad.setAttribute("x2", "0");
  grad.setAttribute("y2", "1");

  const stop1 = createSvg("stop");
  stop1.setAttribute("offset", "0");
  stop1.setAttribute("stop-color", "#22d3ee");

  const stop2 = createSvg("stop");
  stop2.setAttribute("offset", "1");
  stop2.setAttribute("stop-color", "#0ea5e9");

  grad.append(stop1, stop2);
  defs.appendChild(grad);

  const path1 = createSvg("path");
  path1.setAttribute("d", "M24 4 L41 10 V23 C41 35 34 42 24 46 C14 42 7 35 7 23 V10 Z");
  path1.setAttribute("fill", "#0f172a");
  path1.setAttribute("stroke", "url(#gw-shield-grad)");
  path1.setAttribute("stroke-width", "2.6");

  const path2 = createSvg("path");
  path2.setAttribute("d", "M24 11 L35 14.6 V23 C35 31 30.6 36.4 24 39 C17.4 36.4 13 31 13 23 V14.6 Z");
  path2.setAttribute("fill", "none");
  path2.setAttribute("stroke", "#22d3ee");
  path2.setAttribute("stroke-width", "1.6");
  path2.setAttribute("opacity", "0.85");

  const rect = createSvg("rect");
  rect.setAttribute("x", "16");
  rect.setAttribute("y", "24");
  rect.setAttribute("width", "16");
  rect.setAttribute("height", "4.4");
  rect.setAttribute("rx", "2.2");
  rect.setAttribute("fill", "#ef4444");

  const circle = createSvg("circle");
  circle.setAttribute("cx", "24");
  circle.setAttribute("cy", "32.4");
  circle.setAttribute("r", "1.8");
  circle.setAttribute("fill", "#34d399");

  svg.append(defs, path1, path2, rect, circle);

  const headerText = doc.createElement("div");
  headerText.className = "gw-header-text";

  const titleDiv = doc.createElement("div");
  titleDiv.className = "gw-title";
  titleDiv.id = "gw-pg-title";
  titleDiv.append(doc.createTextNode(callbacks.title ? (callbacks.title + " ") : "GovernWorld Paste Shield "));

  const badgeSpan = doc.createElement("span");
  badgeSpan.className = "gw-badge";
  badgeSpan.textContent = `${matches.length} Sensitive ${matches.length === 1 ? "Item" : "Items"}`;
  titleDiv.appendChild(badgeSpan);

  const subtitleDiv = doc.createElement("div");
  subtitleDiv.className = "gw-subtitle";
  subtitleDiv.textContent = callbacks.subtitle ?? "On-device privacy check intercepted sensitive data";

  headerText.append(titleDiv, subtitleDiv);
  header.append(svg, headerText);

  // Findings list
  const content = doc.createElement("div");
  content.className = "gw-content";

  for (const match of matches) {
    const item = doc.createElement("div");
    item.className = "gw-finding-item";
    const displayName = getFindingDisplayName(match.category, match.value);
    const masked = maskValue(match.category, match.value);

    // Page-derived values are rendered as text, never parsed as HTML: a
    // hostile page could otherwise inject markup into this dialog through a
    // crafted match value (e.g. an email domain or a secret's head character).
    const label = doc.createElement("div");
    label.className = "gw-finding-label";
    const nameSpan = doc.createElement("span");
    nameSpan.textContent = displayName;
    const confSpan = doc.createElement("span");
    confSpan.style.fontSize = "10px";
    confSpan.style.color = "#94a3b8";
    confSpan.textContent = `${Math.round(match.confidence * 100)}%`;
    label.append(nameSpan, confSpan);
    const preview = doc.createElement("div");
    preview.className = "gw-finding-preview";
    preview.textContent = masked;
    item.append(label, preview);
    content.appendChild(item);
  }

  // Action buttons
  const actions = doc.createElement("div");
  actions.className = "gw-actions";

  const btnSanitize = doc.createElement("button");
  btnSanitize.className = "gw-btn gw-btn-primary";
  btnSanitize.id = "gw-btn-sanitize";
  const kbdSanitize = doc.createElement("span");
  kbdSanitize.className = "gw-kbd";
  kbdSanitize.textContent = "↵ Enter";
  btnSanitize.append(doc.createTextNode((callbacks.sanitizeLabel ?? "Sanitize & Paste") + " "), kbdSanitize);

  const btnRaw = doc.createElement("button");
  btnRaw.className = "gw-btn gw-btn-ghost";
  btnRaw.id = "gw-btn-raw";
  btnRaw.textContent = callbacks.rawLabel ?? "Paste Unchanged";

  const btnCancel = doc.createElement("button");
  btnCancel.className = "gw-btn gw-btn-danger";
  btnCancel.id = "gw-btn-cancel";
  const kbdCancel = doc.createElement("span");
  kbdCancel.className = "gw-kbd";
  kbdCancel.textContent = "Esc";
  btnCancel.append(doc.createTextNode("Cancel "), kbdCancel);

  if (callbacks.policyBlocked) {
    btnCancel.textContent = "Dismiss";
    actions.append(btnCancel);
  } else {
    actions.append(btnSanitize);
    if (typeof callbacks.onRaw === "function") {
      actions.append(btnRaw);
    }
    actions.append(btnCancel);
  }
  dialog.append(header, content, actions);
  shadow.append(backdrop, dialog);

  (doc.body || doc.documentElement).appendChild(host);

  let isClosed = false;
  const close = () => {
    if (isClosed) return;
    isClosed = true;
    doc.removeEventListener("keydown", handleKeydown, true);
    backdrop.removeEventListener("click", handleBackdropClick);
    host.remove();
  };

  const handleKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      callbacks.onCancel();
    } else if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      if (callbacks.policyBlocked) {
        e.preventDefault();
        e.stopPropagation();
        close();
        callbacks.onCancel();
        return;
      }
      // If focus is specifically on btnRaw or btnCancel, activate that button
      const activeEl = shadow.activeElement;
      if (callbacks.onRaw && activeEl === btnRaw) {
        e.preventDefault();
        e.stopPropagation();
        close();
        callbacks.onRaw();
      } else if (activeEl === btnCancel) {
        e.preventDefault();
        e.stopPropagation();
        close();
        callbacks.onCancel();
      } else {
        e.preventDefault();
        e.stopPropagation();
        close();
        callbacks.onSanitize();
      }
    }
  };

  const handleBackdropClick = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    close();
    callbacks.onCancel();
  };

  btnSanitize.addEventListener("click", () => {
    close();
    callbacks.onSanitize();
  });

  btnRaw.addEventListener("click", () => {
    close();
    callbacks.onRaw?.();
  });

  btnCancel.addEventListener("click", () => {
    close();
    callbacks.onCancel();
  });

  // The single place a dialog action is dispatched, so `press` below and the real
  // click handlers cannot drift apart.
  const ACTIONS = {
    "gw-btn-sanitize": btnSanitize,
    "gw-btn-raw": btnRaw,
    "gw-btn-cancel": btnCancel,
  } as const;

  const press = (buttonId: keyof typeof ACTIONS): boolean => {
    const button = ACTIONS[buttonId];
    if (!button || !button.parentNode) return false;
    button.click();
    return true;
  };

  backdrop.addEventListener("click", handleBackdropClick);
  doc.addEventListener("keydown", handleKeydown, true);

  // Focus primary button for fast Enter response
  setTimeout(() => {
    try {
      if (callbacks.policyBlocked) {
        btnCancel.focus();
      } else {
        btnSanitize.focus();
      }
    } catch {
      // ignore
    }
  }, 0);

  return { host, close, press };
}

/** Check if an element is an editable target */
export function isEditableElement(el: unknown): el is HTMLElement {
  if (!isHtmlElement(el)) return false;
  if (isInputElement(el)) {
    const type = (el.type || "").toLowerCase();
    return !["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(type);
  }
  if (isTextAreaElement(el)) return true;
  if (el.isContentEditable) return true;
  if (typeof el.closest === "function" && el.closest("[contenteditable='true'], [contenteditable='']")) return true;
  if (el.ownerDocument && el.ownerDocument.designMode === "on") return true;
  return false;
}

/**
 * Initialize Paste Guard on a given Document context.
 *
 * Enforcement model: listeners run in the capture phase and call
 * preventDefault() synchronously after local detection, so a BLOCK/SANITIZE
 * decision lands BEFORE the destination receives the data. There is no
 * "paste, then clean up" path: once the event is cancelled the bytes never
 * enter the input.
 *
 * Coverage: the host document plus every reachable same-document surface —
 * open shadow roots and same-origin iframes, including ones created after
 * init (MutationObserver) and across SPA navigation (the script persists, the
 * observer keeps watching). Cross-origin iframes are unreachable by design;
 * that limitation is documented, not silently absorbed.
 *
 * Fail-closed: any dialog/handler fault inserts NOTHING. A previous revision
 * inserted the raw text on error, which turned a UI fault into a data leak.
 *
 * Returns a teardown function for clean cleanup in tests or page lifecycle.
 */
export interface InitPasteGuardOptions {
  /** Seed settings (normalized) instead of defaults; storage still overrides. */
  initialSettings?: Settings;
  /** Seed site policies instead of empty; storage still overrides. */
  initialSitePolicies?: SitePolicy[];
}

export function initPasteGuard(doc: Document = document, opts?: InitPasteGuardOptions): () => void {
  let cachedSettings: Settings = opts?.initialSettings
    ? normalizeSettings(opts.initialSettings)
    : { ...DEFAULT_SETTINGS };
  let cachedCustomPatterns: CustomPattern[] = [];
  let cachedSitePolicies: SitePolicy[] = opts?.initialSitePolicies ? [...opts.initialSitePolicies] : [];
  let cachedPolicy: EnterprisePolicy = { ...NO_ENTERPRISE_POLICY };
  let cachedMode: ProtectionMode = cachedSettings.protectionMode;
  let cachedEnabledCategories: FindingCategory[] = [...cachedSettings.enabledCategories];
  let isHandlingEvent = false;
  const attachedRoots = new WeakSet<Document | ShadowRoot>();
  const attachedList: Array<Document | ShadowRoot> = [];
  let observer: MutationObserver | null = null;

  const recompute = (): void => {
    const eff = resolveEffectiveProtection(cachedSettings, cachedPolicy);
    cachedMode = eff.mode;
    cachedEnabledCategories = eff.enabledCategories;
  };

  const refreshManaged = async (): Promise<void> => {
    try {
      if (typeof chrome !== "undefined" && chrome.storage?.managed) {
        const raw = await chrome.storage.managed.get(null);
        cachedPolicy = parseEnterprisePolicy(raw && Object.keys(raw).length > 0 ? raw : null);
        recompute();
      }
    } catch {
      // Managed storage unreadable: keep the last resolved policy rather than
      // flapping enforcement on a transient storage fault.
    }
  };

  // Load settings and custom patterns asynchronously from extension storage if available
  const loadStored = async () => {
    try {
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        const stored = await chrome.storage.local.get(["settings", "customPatterns", SITE_POLICIES_KEY]);
        if (stored.settings) {
          cachedSettings = normalizeSettings(stored.settings);
        }
        if (Array.isArray(stored.customPatterns)) {
          cachedCustomPatterns = stored.customPatterns;
        }
        if (Array.isArray(stored[SITE_POLICIES_KEY])) {
          const valid: SitePolicy[] = [];
          for (const item of stored[SITE_POLICIES_KEY]) {
            const res = parseSitePolicy(item);
            if (res.ok) valid.push(res.policy);
          }
          cachedSitePolicies = valid;
        }
        recompute();
      }
    } catch {
      // Fall back to defaults
    }
    await refreshManaged();
  };

  void loadStored();

  // Listen for real-time settings changes
  const storageListener = (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => {
    if (areaName === "local") {
      if (changes.settings) {
        cachedSettings = normalizeSettings(changes.settings.newValue);
        recompute();
      }
      if (changes.customPatterns && Array.isArray(changes.customPatterns.newValue)) {
        cachedCustomPatterns = changes.customPatterns.newValue;
      }
      if (changes[SITE_POLICIES_KEY] && Array.isArray(changes[SITE_POLICIES_KEY].newValue)) {
        const valid: SitePolicy[] = [];
        for (const item of changes[SITE_POLICIES_KEY].newValue) {
          const res = parseSitePolicy(item);
          if (res.ok) valid.push(res.policy);
        }
        cachedSitePolicies = valid;
      }
    } else if (areaName === "managed") {
      void refreshManaged();
    }
  };

  if (typeof chrome !== "undefined" && chrome.storage?.onChanged?.addListener) {
    chrome.storage.onChanged.addListener(storageListener);
  }

  const handlePastedContent = (
    text: string,
    target: HTMLElement,
    originalEvent: Event
  ) => {
    // OFF means off: no interception, normal paste proceeds untouched.
    if (cachedMode === "off") return;
    if (!text || text.trim().length === 0) return;

    const matches = detectPasteFindings(text, cachedEnabledCategories, cachedCustomPatterns);
    if (matches.length === 0) return;

    // Intercept event
    originalEvent.preventDefault();
    if (typeof originalEvent.stopImmediatePropagation === "function") {
      originalEvent.stopImmediatePropagation();
    } else {
      originalEvent.stopPropagation();
    }

    const currentUrl = doc.defaultView?.location?.href || (typeof location !== "undefined" ? location.href : "");
    const policyEval = evaluateSitePolicies(cachedSitePolicies, currentUrl, matches);

    if (policyEval.hasMatch && policyEval.action === "block") {
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        void recordAudit({
          ts: new Date().toISOString(),
          action: "policy_enforced",
          host: doc.defaultView?.location?.hostname,
          policyId: policyEval.matchedPolicy?.id,
          policyAction: "block",
          outcome: "denied",
        }).catch(() => {});
      }
      isHandlingEvent = true;
      try {
        showPasteGuardDialog(doc, target, matches, {
          title: "GovernWorld — Policy Blocked",
          subtitle: `Policy "${policyEval.matchedPolicy?.name}" strictly prohibits pasting ${policyEval.matchedCategories.join(", ")} on this site.`,
          policyBlocked: true,
          onSanitize: () => {
            isHandlingEvent = false;
          },
          onCancel: () => {
            isHandlingEvent = false;
          },
        });
        if (cachedSettings.notificationPrefs?.toastEnabled) {
          showToast({
            title: "GovernWorld — Policy Blocked",
            message: `Pasting blocked by policy "${policyEval.matchedPolicy?.name}".`,
            level: "danger",
            durationMs: 4000,
          });
        }
      } catch {
        isHandlingEvent = false;
      }
      return;
    }

    const isRedactOnly = policyEval.hasMatch && policyEval.action === "redact";
    const isWarnOnly = policyEval.hasMatch && policyEval.action === "warn";

    if (policyEval.hasMatch && (isRedactOnly || isWarnOnly)) {
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        void recordAudit({
          ts: new Date().toISOString(),
          action: "policy_enforced",
          host: doc.defaultView?.location?.hostname,
          policyId: policyEval.matchedPolicy?.id,
          policyAction: policyEval.action,
          outcome: "ok",
        }).catch(() => {});
      }
    }

    isHandlingEvent = true;
    try {
      const dHost = showPasteGuardDialog(doc, target, matches, {
        subtitle: isRedactOnly
          ? `Policy "${policyEval.matchedPolicy?.name}" enforces redaction of ${policyEval.matchedCategories.join(", ")}.`
          : isWarnOnly
          ? `Policy notice: "${policyEval.matchedPolicy?.name}" flagged sensitive data`
          : undefined,
    /* debug */
        onSanitize: () => {
          isHandlingEvent = false;
          const sanitized = sanitizePastedText(text, matches);
          insertTextIntoElement(target, sanitized);
          if (cachedSettings.notificationPrefs?.toastEnabled && cachedSettings.notificationPrefs?.notifyPasteInterception) {
            showToast({
              title: "GovernWorld — Paste Shield",
              message: "Sanitized text pasted safely.",
              level: "success",
              durationMs: 3500,
            });
          }
        },
        onRaw: isRedactOnly ? undefined : () => {
          isHandlingEvent = false;
          insertTextIntoElement(target, text);
        },
        onCancel: () => {
          isHandlingEvent = false;
        },
      });
      if (cachedSettings.notificationPrefs?.toastEnabled && cachedSettings.notificationPrefs?.notifyPasteInterception) {
        showToast({
          title: "GovernWorld — Paste Shield",
          message: `${matches.length} sensitive item${matches.length === 1 ? "" : "s"} intercepted from clipboard.`,
          level: "warning",
          durationMs: 4000,
        });
      }
    } catch {
      // Fail closed: a dialog fault must never become a raw-text insertion.
      // The paste stays cancelled and nothing reaches the destination.
      isHandlingEvent = false;
    }
  };

  const onPaste = (e: ClipboardEvent) => {
    if (isHandlingEvent) return;
    const target = e.target;
    if (!isEditableElement(target)) return;

    const text = e.clipboardData?.getData("text/plain") || e.clipboardData?.getData("text") || "";
    if (text) {
      handlePastedContent(text, target, e);
    }
  };

  const onBeforeInput = (e: InputEvent) => {
    if (isHandlingEvent) return;
    if (e.inputType !== "insertFromPaste" && e.inputType !== "insertFromDrop") return;
    const target = e.target;
    if (!isEditableElement(target)) return;

    // Note: most browsers expose no clipboard data on beforeinput; this is a
    // backstop for engines that do. The paste/drop handlers are authoritative.
    const text = e.dataTransfer?.getData("text/plain") || e.dataTransfer?.getData("text") || "";
    if (text) {
      handlePastedContent(text, target, e);
    }
  };

  const onDrop = async (e: DragEvent) => {
    if (isHandlingEvent) return;
    const target = e.target;
    if (!isEditableElement(target)) return;

    // Synchronous preventDefault to block the drop before any async work
    e.preventDefault();
    if (typeof e.stopImmediatePropagation === "function") {
      e.stopImmediatePropagation();
    } else {
      e.stopPropagation();
    }

    const text = e.dataTransfer?.getData("text/plain") || e.dataTransfer?.getData("text") || "";
    if (text) {
      handlePastedContent(text, target, e);
      return;
    }

    // Inspect dropped text/code/csv/json files (async but event already cancelled)
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      for (const file of Array.from(files)) {
        if (file.type.startsWith("text/") || /\.(txt|csv|json|md|tsv|log)$/i.test(file.name)) {
          try {
            if (typeof file.text === "function") {
              const fileText = await file.text();
              if (fileText) {
                handlePastedContent(fileText, target, e);
              }
              return;
            }
          } catch {
            // File read failure
          }
        }
      }
    }
  };

  const handleDropEvent = (e: Event): void => {
    void onDrop(e as DragEvent);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (isHandlingEvent || cachedMode === "off") return;
    if (e.key !== "Enter" || e.shiftKey || (e as any).isComposing) return;
    const target = e.target;
    if (!isHtmlElement(target) || !isEditableElement(target)) return;
    if (!isPromptOrSendableInput(target)) return;

    const text = getElementText(target);
    if (!text || text.trim().length === 0) return;

    const matches = detectPasteFindings(text, cachedEnabledCategories, cachedCustomPatterns);
    if (matches.length === 0) return;

    e.preventDefault();
    if (typeof e.stopImmediatePropagation === "function") {
      e.stopImmediatePropagation();
    } else {
      e.stopPropagation();
    }

    const currentUrl = doc.defaultView?.location?.href || (typeof location !== "undefined" ? location.href : "");
    const policyEval = evaluateSitePolicies(cachedSitePolicies, currentUrl, matches);

    if (policyEval.hasMatch && policyEval.action === "block") {
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        void recordAudit({
          ts: new Date().toISOString(),
          action: "policy_enforced",
          host: doc.defaultView?.location?.hostname,
          policyId: policyEval.matchedPolicy?.id,
          policyAction: "block",
          outcome: "denied",
        }).catch(() => {});
      }
      isHandlingEvent = true;
      try {
        showPasteGuardDialog(doc, target, matches, {
          title: "GovernWorld — Policy Blocked",
          subtitle: `Policy "${policyEval.matchedPolicy?.name}" strictly prohibits prompts containing ${policyEval.matchedCategories.join(", ")} on this site.`,
          policyBlocked: true,
          onSanitize: () => {
            isHandlingEvent = false;
          },
          onCancel: () => {
            isHandlingEvent = false;
          },
        });
        if (cachedSettings.notificationPrefs?.toastEnabled) {
          showToast({
            title: "GovernWorld — Policy Blocked",
            message: `Prompt blocked by policy "${policyEval.matchedPolicy?.name}".`,
            level: "danger",
            durationMs: 4000,
          });
        }
      } catch {
        isHandlingEvent = false;
      }
      return;
    }

    const isRedactOnly = policyEval.hasMatch && policyEval.action === "redact";
    const isWarnOnly = policyEval.hasMatch && policyEval.action === "warn";

    if (policyEval.hasMatch && (isRedactOnly || isWarnOnly)) {
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        void recordAudit({
          ts: new Date().toISOString(),
          action: "policy_enforced",
          host: doc.defaultView?.location?.hostname,
          policyId: policyEval.matchedPolicy?.id,
          policyAction: policyEval.action,
          outcome: "ok",
        }).catch(() => {});
      }
    }

    isHandlingEvent = true;
    try {
      showPasteGuardDialog(doc, target, matches, {
        title: "GovernWorld Prompt Shield",
        subtitle: isRedactOnly
          ? `Policy "${policyEval.matchedPolicy?.name}" enforces sanitization of ${policyEval.matchedCategories.join(", ")}.`
          : isWarnOnly
          ? `Policy notice: "${policyEval.matchedPolicy?.name}" flagged sensitive data in prompt`
          : `${matches.length} sensitive item${matches.length === 1 ? "" : "s"} intercepted before prompt submission`,
        sanitizeLabel: "Sanitize & Send",
        rawLabel: "Send Unchanged",
        onSanitize: () => {
          isHandlingEvent = false;
          const sanitized = sanitizePastedText(text, matches);
          replaceElementText(target, sanitized);
          if (cachedSettings.notificationPrefs?.toastEnabled) {
            showToast({
              title: "GovernWorld — Prompt Shield",
              message: "Prompt sanitized safely before submission.",
              level: "success",
              durationMs: 3500,
            });
          }
        },
        onRaw: isRedactOnly ? undefined : () => {
          isHandlingEvent = false;
        },
        onCancel: () => {
          isHandlingEvent = false;
        },
      });
      
    } catch (err) {
      console.error("REAL ERROR IN ONKEYDOWN:", err);
      isHandlingEvent = false;
    }
  };

  const onSubmit = (e: Event) => {
    if (isHandlingEvent || cachedMode === "off") return;
    const form = e.target as HTMLFormElement | null;
    if (!form || typeof form.querySelectorAll !== "function") return;

    const inputs: Array<HTMLInputElement | HTMLTextAreaElement> = [];
    if (typeof form.querySelectorAll === "function") {
      try {
        const found = form.querySelectorAll("input, textarea");
        if (found && found.length > 0) {
          inputs.push(...(Array.from(found) as any));
        }
      } catch {
        // ignore
      }
    }
    if (inputs.length === 0 && (form as any).children) {
      const walk = (n: any) => {
        const t = (n.tagName || "").toUpperCase();
        if (t === "INPUT" || t === "TEXTAREA") inputs.push(n);
        for (const ch of n.children || []) walk(ch);
      };
      walk(form);
    }

    const foundMatches: RawMatch[] = [];
    let culpritElement: HTMLElement | null = null;

    for (const input of inputs) {
      const type = (input.type || "").toLowerCase();
      if (["password", "hidden", "submit", "button", "checkbox", "radio", "file"].includes(type)) continue;
      const val = input.value || "";
      if (!val || val.length < 3) continue;
      const matches = detectPasteFindings(val, cachedEnabledCategories, cachedCustomPatterns);
      if (matches.length > 0) {
        foundMatches.push(...matches);
        if (!culpritElement) culpritElement = input;
      }
    }

    if (foundMatches.length === 0) return;

    e.preventDefault();
    if (typeof e.stopImmediatePropagation === "function") {
      e.stopImmediatePropagation();
    } else {
      e.stopPropagation();
    }

    const currentUrl = doc.defaultView?.location?.href || (typeof location !== "undefined" ? location.href : "");
    const policyEval = evaluateSitePolicies(cachedSitePolicies, currentUrl, foundMatches);

    if (policyEval.hasMatch && policyEval.action === "block") {
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        void recordAudit({
          ts: new Date().toISOString(),
          action: "policy_enforced",
          host: doc.defaultView?.location?.hostname,
          policyId: policyEval.matchedPolicy?.id,
          policyAction: "block",
          outcome: "denied",
        }).catch(() => {});
      }
      isHandlingEvent = true;
      try {
        showPasteGuardDialog(doc, culpritElement ?? form, foundMatches, {
          title: "GovernWorld — Policy Blocked",
          subtitle: `Policy "${policyEval.matchedPolicy?.name}" strictly prohibits form submission containing ${policyEval.matchedCategories.join(", ")} on this site.`,
          policyBlocked: true,
          onSanitize: () => {
            isHandlingEvent = false;
          },
          onCancel: () => {
            isHandlingEvent = false;
          },
        });
        if (cachedSettings.notificationPrefs?.toastEnabled) {
          showToast({
            title: "GovernWorld — Policy Blocked",
            message: `Form submission blocked by policy "${policyEval.matchedPolicy?.name}".`,
            level: "danger",
            durationMs: 4000,
          });
        }
      } catch {
        isHandlingEvent = false;
      }
      return;
    }

    const isRedactOnly = policyEval.hasMatch && policyEval.action === "redact";
    const isWarnOnly = policyEval.hasMatch && policyEval.action === "warn";

    if (policyEval.hasMatch && (isRedactOnly || isWarnOnly)) {
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        void recordAudit({
          ts: new Date().toISOString(),
          action: "policy_enforced",
          host: doc.defaultView?.location?.hostname,
          policyId: policyEval.matchedPolicy?.id,
          policyAction: policyEval.action,
          outcome: "ok",
        }).catch(() => {});
      }
    }

    isHandlingEvent = true;
    try {
      showPasteGuardDialog(doc, culpritElement ?? form, foundMatches, {
        title: "GovernWorld Form Shield",
        subtitle: isRedactOnly
          ? `Policy "${policyEval.matchedPolicy?.name}" enforces sanitization of ${policyEval.matchedCategories.join(", ")}.`
          : isWarnOnly
          ? `Policy notice: "${policyEval.matchedPolicy?.name}" flagged sensitive data in form`
          : `${foundMatches.length} sensitive item${foundMatches.length === 1 ? "" : "s"} detected before form submission`,
        sanitizeLabel: "Sanitize & Submit",
        rawLabel: "Submit Unchanged",
        onSanitize: () => {
          isHandlingEvent = false;
          for (const input of inputs) {
            const matches = detectPasteFindings(input.value || "", cachedEnabledCategories, cachedCustomPatterns);
            if (matches.length > 0) {
              input.value = sanitizePastedText(input.value, matches);
              try {
                input.dispatchEvent(new Event("input", { bubbles: true }));
                input.dispatchEvent(new Event("change", { bubbles: true }));
              } catch {
                // ignore
              }
            }
          }
          if (cachedSettings.notificationPrefs?.toastEnabled) {
            showToast({
              title: "GovernWorld — Form Shield",
              message: "Form fields sanitized safely.",
              level: "success",
              durationMs: 3500,
            });
          }
          try {
            if (typeof form.requestSubmit === "function") {
              form.requestSubmit();
            } else {
              form.submit();
            }
          } catch {
            // ignore
          }
        },
        onRaw: isRedactOnly ? undefined : () => {
          isHandlingEvent = false;
          try {
            if (typeof form.requestSubmit === "function") {
              form.requestSubmit();
            } else {
              form.submit();
            }
          } catch {
            // ignore
          }
        },
        onCancel: () => {
          isHandlingEvent = false;
        },
      });
    } catch {
      isHandlingEvent = false;
    }
  };


  const attachToRoot = (root: Document | ShadowRoot): void => {
    if (attachedRoots.has(root)) return;
    attachedRoots.add(root);
    attachedList.push(root);
    root.addEventListener("paste", onPaste as EventListener, true);
    root.addEventListener("beforeinput", onBeforeInput as EventListener, true);
    root.addEventListener("drop", handleDropEvent, true);
    root.addEventListener("keydown", onKeyDown as EventListener, true);
    root.addEventListener("submit", onSubmit as EventListener, true);
  };

  const detachFromRoot = (root: Document | ShadowRoot): void => {
    root.removeEventListener("paste", onPaste as EventListener, true);
    root.removeEventListener("beforeinput", onBeforeInput as EventListener, true);
    root.removeEventListener("drop", handleDropEvent, true);
    root.removeEventListener("keydown", onKeyDown as EventListener, true);
    root.removeEventListener("submit", onSubmit as EventListener, true);
  };

  /** Attach to every reachable same-document surface under a scope. */
  const scanScope = (scope: Document | Element | ShadowRoot): void => {
    const elements: ArrayLike<Element> =
      scope instanceof Document || scope instanceof ShadowRoot
        ? scope.querySelectorAll("*")
        : scope.querySelectorAll("*");
    const visit = (el: Element): void => {
      const shadow = (el as unknown as { shadowRoot?: unknown }).shadowRoot;
      if (shadow && typeof (shadow as ShadowRoot).addEventListener === "function") {
        const root = shadow as ShadowRoot;
        attachToRoot(root);
        scanScope(root);
      }
      if (el.tagName === "IFRAME") {
        try {
          const frameDoc = (el as unknown as { contentDocument?: unknown }).contentDocument;
          if (frameDoc && typeof (frameDoc as Document).addEventListener === "function") {
            attachToRoot(frameDoc as Document);
          }
        } catch {
          // Cross-origin iframe: unreachable by platform design. The top-level
          // document guard still stands; the limitation is documented.
        }
      }
    };
    if (scope instanceof Element) visit(scope);
    for (const el of Array.from(elements)) visit(el);
  };

  attachToRoot(doc);
  // Best-effort: minimal DOM shims in tests may not implement traversal.
  try {
    scanScope(doc);
  } catch {
    // Host-document listeners above are the enforcement floor.
  }

  // Keep covering editors created after init (rich-text editors, SPA views,
  // dynamically injected inputs) without polling.
  try {
    if (typeof MutationObserver !== "undefined" && doc.documentElement) {
      observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of Array.from(mutation.addedNodes)) {
            if (node && (node as Node).nodeType === 1) {
              try {
                scanScope(node as unknown as Element);
              } catch {
                // A single unscannable subtree must not break the observer.
              }
            }
          }
        }
      });
      observer.observe(doc.documentElement, { childList: true, subtree: true });
    }
  } catch {
    observer = null;
  }

  return () => {
    try {
      observer?.disconnect();
    } catch {
      // ignore
    }
    observer = null;
    for (const root of attachedList) {
      try {
        detachFromRoot(root);
      } catch {
        // ignore
      }
    }
    if (typeof chrome !== "undefined" && chrome.storage?.onChanged?.removeListener) {
      chrome.storage.onChanged.removeListener(storageListener);
    }
    const host = doc.getElementById("__governworld-paste-guard-host");
    if (host) host.remove();
  };
}
