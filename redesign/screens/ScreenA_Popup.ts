// Copyright (c) 2026 Andres Chavez Ramirez / ACR LOGIC. All rights reserved.
/**
 * SCREEN A — Browser Popup
 *
 * Compact, high-density toolbar experience designed for immediate user actions.
 * Features:
 * - GovernWorld Aegis identity with active health beacon
 * - Quick Protection toggles: Page Protection & Paste Shield
 * - Instant "Scan This Page" trigger with real-time feedback
 * - Session statistics overview
 * - Quick-jump shortcuts to specialized workspaces (Document Studio, My Logic, Settings)
 */

import type { IBackendAdapters } from "../adapters/contracts.js";
import type { ScreenId } from "../types/index.js";

export function renderScreenA_Popup(
  adapters: IBackendAdapters,
  onNavigate: (screen: ScreenId) => void
): HTMLElement {
  const container = document.createElement("div");
  container.className = "gw-screen-popup";
  container.style.cssText = "display: flex; flex-direction: column; gap: 14px; width: 100%; max-width: 380px; margin: 0 auto;";

  container.innerHTML = `
    <!-- Top Identity Bar -->
    <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--gw-border-subtle); padding-bottom: 10px;">
      <div style="display: flex; align-items: center; gap: 9px;">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <path d="M12 2L3 6V12C3 17.5 7 21 12 22C17 21 21 17.5 21 12V6L12 2Z" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M12 7V12L15 15" stroke="#10b981" stroke-width="2" stroke-linecap="round"/>
        </svg>
        <div>
          <span style="font-weight: 700; font-size: 14px; letter-spacing: -0.01em; color: var(--gw-text-primary);">GovernWorld</span>
          <span style="display: block; font-size: 10px; color: var(--gw-text-muted); font-family: var(--gw-font-mono);">LOCAL-FIRST • V2.0</span>
        </div>
      </div>
      <div style="display: flex; align-items: center; gap: 6px;">
        <span class="gw-badge gw-badge--demo">DEMO MODE</span>
        <button id="popup-settings-btn" class="gw-btn gw-btn--ghost gw-btn--sm" title="Open Settings" style="padding: 4px;">
          ⚙️
        </button>
      </div>
    </div>

    <!-- Active Protection Toggles -->
    <div class="gw-card gw-card--glass" style="display: flex; flex-direction: column; gap: 10px; padding: 12px;">
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <div>
          <strong style="font-size: 13px; color: var(--gw-text-primary); display: block;">Page Protection</strong>
          <span class="gw-caption">ActiveTab DOM inspection</span>
        </div>
        <label class="gw-switch">
          <input type="checkbox" id="popup-page-prot-toggle" checked />
          <span class="gw-switch__slider"></span>
        </label>
      </div>

      <div style="height: 1px; background: var(--gw-border-subtle);"></div>

      <div style="display: flex; align-items: center; justify-content: space-between;">
        <div>
          <strong style="font-size: 13px; color: var(--gw-text-primary); display: block;">Paste Shield</strong>
          <span class="gw-caption">Intercepts & prompts before leaking</span>
        </div>
        <label class="gw-switch">
          <input type="checkbox" id="popup-paste-toggle" checked />
          <span class="gw-switch__slider"></span>
        </label>
      </div>
    </div>

    <!-- Scan Action Box -->
    <div style="display: flex; flex-direction: column; gap: 8px;">
      <button id="popup-scan-btn" class="gw-btn gw-btn--primary" style="padding: 12px; font-size: 14px; font-weight: 700; width: 100%;">
        <span id="popup-scan-spinner" style="display: none;">🌀</span>
        <span id="popup-scan-label">⚡ Scan Current Page</span>
      </button>
      <div id="popup-scan-feedback" class="gw-caption" style="text-align: center; color: var(--gw-text-secondary); min-height: 18px;">
        Ready to scan active page for 20 sensitive categories.
      </div>
    </div>

    <!-- Session Stats Summary -->
    <div class="gw-card" style="padding: 10px; display: grid; grid-template-columns: 1fr 1fr 1fr; text-align: center; gap: 6px;">
      <div>
        <span style="font-size: 11px; color: var(--gw-text-muted); display: block;">Findings</span>
        <strong id="popup-stat-findings" style="font-size: 18px; color: #f59e0b; font-family: var(--gw-font-mono);">0</strong>
      </div>
      <div>
        <span style="font-size: 11px; color: var(--gw-text-muted); display: block;">Protected</span>
        <strong id="popup-stat-protected" style="font-size: 18px; color: #10b981; font-family: var(--gw-font-mono);">0</strong>
      </div>
      <div>
        <span style="font-size: 11px; color: var(--gw-text-muted); display: block;">Status</span>
        <strong id="popup-stat-status" style="font-size: 13px; color: var(--gw-text-primary); line-height: 24px;">Idle</strong>
      </div>
    </div>

    <!-- Quick Workspace Navigation Links -->
    <div style="display: flex; flex-direction: column; gap: 6px; margin-top: 2px;">
      <div style="display: flex; gap: 6px;">
        <button id="popup-nav-sidepanel" class="gw-btn gw-btn--ghost" style="flex: 1; font-size: 11px; padding: 7px;">
          🔍 Inspection Panel
        </button>
        <button id="popup-nav-docstudio" class="gw-btn gw-btn--ghost" style="flex: 1; font-size: 11px; padding: 7px;">
          📄 Document Studio
        </button>
      </div>
      <div style="display: flex; gap: 6px;">
        <button id="popup-nav-logic" class="gw-btn gw-btn--ghost" style="flex: 1; font-size: 11px; padding: 7px;">
          🧩 My Logic (Rules)
        </button>
        <button id="popup-nav-audit" class="gw-btn gw-btn--ghost" style="flex: 1; font-size: 11px; padding: 7px;">
          🛡️ Review & Audit
        </button>
      </div>
    </div>
  `;

  // Wire Interactions
  const scanBtn = container.querySelector("#popup-scan-btn") as HTMLButtonElement;
  const scanLabel = container.querySelector("#popup-scan-label") as HTMLSpanElement;
  const scanSpinner = container.querySelector("#popup-scan-spinner") as HTMLSpanElement;
  const scanFeedback = container.querySelector("#popup-scan-feedback") as HTMLDivElement;
  const statFindings = container.querySelector("#popup-stat-findings") as HTMLElement;
  const statProtected = container.querySelector("#popup-stat-protected") as HTMLElement;
  const statStatus = container.querySelector("#popup-stat-status") as HTMLElement;

  let scanning = false;
  scanBtn.addEventListener("click", async () => {
    if (scanning) return;
    scanning = true;
    scanBtn.disabled = true;
    scanSpinner.style.display = "inline-block";
    scanLabel.textContent = "Scanning Viewport...";
    statStatus.textContent = "Scanning";
    statStatus.style.color = "#3b82f6";

    const unsubscribe = adapters.scanning.onScanProgress(({ progress, stage, findingsCount }) => {
      scanFeedback.textContent = stage;
      statFindings.textContent = String(findingsCount);

      if (progress >= 100) {
        scanning = false;
        scanBtn.disabled = false;
        scanSpinner.style.display = "none";
        scanLabel.textContent = "⚡ Scan Again";
        statProtected.textContent = String(findingsCount);
        statStatus.textContent = "Protected";
        statStatus.style.color = "#10b981";
        scanFeedback.innerHTML = `<span style="color: #10b981;">✓ Scan complete. ${findingsCount} sensitive items detected & masked.</span>`;
        unsubscribe();
      }
    });

    await adapters.scanning.startScan();
  });

  // Navigation Links
  container.querySelector("#popup-settings-btn")?.addEventListener("click", () => onNavigate("central-settings"));
  container.querySelector("#popup-nav-sidepanel")?.addEventListener("click", () => onNavigate("protection-workspace"));
  container.querySelector("#popup-nav-docstudio")?.addEventListener("click", () => onNavigate("document-studio"));
  container.querySelector("#popup-nav-logic")?.addEventListener("click", () => onNavigate("my-logic"));
  container.querySelector("#popup-nav-audit")?.addEventListener("click", () => onNavigate("review-audit"));

  return container;
}
