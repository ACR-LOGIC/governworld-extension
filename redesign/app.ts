// Copyright (c) 2026 Andres Chavez Ramirez / ACR LOGIC. All rights reserved.
/**
 * Master Application Shell & Interactive Experience Controller.
 *
 * Coordinates:
 * - Viewport framing (Browser Popup 380x600, Side Panel 420x820, Full Workspace 1280x850)
 * - Navigation routing between all 10 required screens (A through J)
 * - Design system tokens & dynamic accessibility adjustments (High Contrast, Reduced Motion)
 * - Integration adapters (Demo Mode with live simulation hooks)
 */

import { demoAdapters } from "./adapters/demoAdapter.js";
import type { ScreenId, ViewportMode } from "./types/index.js";

// Screen Renderers
import { renderScreenA_Popup } from "./screens/ScreenA_Popup.js";
import { renderScreenB_ProtectionWorkspace } from "./screens/ScreenB_ProtectionWorkspace.js";
import { renderScreenC_DetectionProfiles } from "./screens/ScreenC_DetectionProfiles.js";
import { renderScreenD_DocumentStudio } from "./screens/ScreenD_DocumentStudio.js";
import { renderScreenE_MyLogic } from "./screens/ScreenE_MyLogic.js";
import { renderScreenF_ReviewAudit } from "./screens/ScreenF_ReviewAudit.js";
import { renderScreenG_CentralSettings } from "./screens/ScreenG_CentralSettings.js";
import { renderScreenH_PrivacyGovernance } from "./screens/ScreenH_PrivacyGovernance.js";
import { renderScreenI_AccountEnterprise } from "./screens/ScreenI_AccountEnterprise.js";
import { renderScreenJ_DiagnosticsMaintenance } from "./screens/ScreenJ_DiagnosticsMaintenance.js";

export class GovernWorldApp {
  private currentScreen: ScreenId = "popup";
  private currentViewport: ViewportMode = "popup";
  private rootEl: HTMLElement;
  private stageEl: HTMLElement;
  private screenContainerEl: HTMLElement;

  constructor(mountPoint: HTMLElement) {
    this.rootEl = mountPoint;
    this.buildShell();
    this.stageEl = this.rootEl.querySelector("#gw-viewport-stage") as HTMLElement;
    this.screenContainerEl = this.rootEl.querySelector("#gw-screen-mount") as HTMLElement;
    this.bindEvents();
    this.navigate("popup");
  }

  private buildShell(): void {
    this.rootEl.innerHTML = `
      <!-- Redesign Top Environment & Viewport Bar -->
      <header style="background: #060910; border-bottom: 1px solid var(--gw-border-subtle); padding: 10px 20px; display: flex; justify-content: space-between; align-items: center; position: sticky; top: 0; z-index: 1000;">
        <div style="display: flex; align-items: center; gap: 14px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <path d="M12 2L3 6V12C3 17.5 7 21 12 22C17 21 21 17.5 21 12V6L12 2Z" stroke="#3b82f6" stroke-width="2"/>
              <path d="M9 12L11 14L15 10" stroke="#10b981" stroke-width="2"/>
            </svg>
            <strong style="font-size: 14px; letter-spacing: -0.01em;">GovernWorld Architecture</strong>
          </div>
          <span class="gw-badge gw-badge--demo" title="Interactive Simulator">PROD-SPEC REDESIGN • DEMO MODE</span>
        </div>

        <!-- Viewport Switcher Controls -->
        <div style="display: flex; align-items: center; gap: 6px; background: var(--gw-bg-surface); padding: 4px; border-radius: var(--gw-radius-sm); border: 1px solid var(--gw-border-subtle);">
          <span style="font-size: 11px; color: var(--gw-text-muted); padding: 0 6px;">SURFACE:</span>
          <button class="gw-btn gw-btn--sm gw-btn--primary vp-btn" data-vp="popup" title="Extension Toolbar Popup (380x600)">
            📱 Popup
          </button>
          <button class="gw-btn gw-btn--sm gw-btn--ghost vp-btn" data-vp="sidepanel" title="Browser Side Panel (420x820)">
            📑 Side Panel
          </button>
          <button class="gw-btn gw-btn--sm gw-btn--ghost vp-btn" data-vp="workspace" title="Full Desktop Workspace (1280x850)">
            🖥️ Full Workspace
          </button>
        </div>

        <!-- Screen Quick Links Menu & Accessibility Toggles -->
        <div style="display: flex; align-items: center; gap: 8px;">
          <select id="gw-screen-select" style="background: var(--gw-bg-interactive); color: var(--gw-text-primary); border: 1px solid var(--gw-border-base); border-radius: 4px; padding: 5px 10px; font-size: 12px; cursor: pointer;">
            <option value="popup">Screen A: Browser Popup</option>
            <option value="protection-workspace">Screen B: Protection Workspace</option>
            <option value="detection-profiles">Screen C: Shared Detection Profiles</option>
            <option value="document-studio">Screen D: Document Studio</option>
            <option value="my-logic">Screen E: My Logic (Rules)</option>
            <option value="review-audit">Screen F: Review & Audit Evidence</option>
            <option value="central-settings">Screen G: Central Settings</option>
            <option value="privacy-governance">Screen H: Privacy & Governance</option>
            <option value="account-enterprise">Screen I: Account & Enterprise</option>
            <option value="diagnostics-maintenance">Screen J: Diagnostics & Health</option>
          </select>

          <button id="gw-toggle-contrast" class="gw-btn gw-btn--ghost gw-btn--sm" title="Toggle High Contrast">
            👁️ Contrast
          </button>
        </div>
      </header>

      <!-- Main Stage Container -->
      <main style="display: flex; justify-content: center; align-items: flex-start; padding: 24px; min-height: calc(100vh - 60px); background: radial-gradient(circle at 50% 20%, rgba(37, 99, 235, 0.08), transparent 70%);">
        <div id="gw-viewport-stage" style="width: 380px; min-height: 580px; background: var(--gw-bg-surface); border: 1px solid var(--gw-border-base); border-radius: var(--gw-radius-lg); box-shadow: var(--gw-shadow-lg); padding: 18px; transition: all 280ms var(--gw-ease-spring);">
          <div id="gw-screen-mount"></div>
        </div>
      </main>
    `;
  }

  private bindEvents(): void {
    // Viewport Switcher
    this.rootEl.querySelectorAll(".vp-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const vp = (btn as HTMLElement).dataset.vp as ViewportMode;
        this.setViewport(vp);
      });
    });

    // Screen Select Dropdown
    const select = this.rootEl.querySelector("#gw-screen-select") as HTMLSelectElement;
    select.addEventListener("change", () => {
      this.navigate(select.value as ScreenId);
    });

    // High Contrast Switcher
    const contrastBtn = this.rootEl.querySelector("#gw-toggle-contrast") as HTMLButtonElement;
    contrastBtn.addEventListener("click", () => {
      const isHigh = document.body.getAttribute("data-high-contrast") === "true";
      document.body.setAttribute("data-high-contrast", String(!isHigh));
      contrastBtn.textContent = !isHigh ? "✓ High Contrast" : "👁️ Contrast";
    });
  }

  public setViewport(mode: ViewportMode): void {
    this.currentViewport = mode;

    this.rootEl.querySelectorAll(".vp-btn").forEach((b) => {
      const active = (b as HTMLElement).dataset.vp === mode;
      b.className = `gw-btn gw-btn--sm vp-btn ${active ? "gw-btn--primary" : "gw-btn--ghost"}`;
    });

    if (mode === "popup") {
      this.stageEl.style.width = "380px";
      this.stageEl.style.minHeight = "580px";
      this.stageEl.style.maxWidth = "380px";
    } else if (mode === "sidepanel") {
      this.stageEl.style.width = "440px";
      this.stageEl.style.minHeight = "800px";
      this.stageEl.style.maxWidth = "440px";
    } else if (mode === "workspace") {
      this.stageEl.style.width = "100%";
      this.stageEl.style.minHeight = "850px";
      this.stageEl.style.maxWidth = "1180px";
    }
  }

  public navigate(screen: ScreenId): void {
    this.currentScreen = screen;

    // Update screen selector
    const select = this.rootEl.querySelector("#gw-screen-select") as HTMLSelectElement;
    if (select && select.value !== screen) {
      select.value = screen;
    }

    // Auto-adjust viewport suggestion if user picks a large workspace
    if (screen === "document-studio" || screen === "review-audit" || screen === "central-settings") {
      if (this.currentViewport === "popup") {
        this.setViewport("workspace");
      }
    } else if (screen === "protection-workspace") {
      if (this.currentViewport === "popup") {
        this.setViewport("sidepanel");
      }
    }

    // Mount screen
    this.screenContainerEl.innerHTML = "";
    let rendered: HTMLElement;

    switch (screen) {
      case "popup":
        rendered = renderScreenA_Popup(demoAdapters, (s) => this.navigate(s));
        break;
      case "protection-workspace":
        rendered = renderScreenB_ProtectionWorkspace(demoAdapters, (s) => this.navigate(s));
        break;
      case "detection-profiles":
        rendered = renderScreenC_DetectionProfiles(demoAdapters, (s) => this.navigate(s));
        break;
      case "document-studio":
        rendered = renderScreenD_DocumentStudio(demoAdapters, (s) => this.navigate(s));
        break;
      case "my-logic":
        rendered = renderScreenE_MyLogic(demoAdapters, (s) => this.navigate(s));
        break;
      case "review-audit":
        rendered = renderScreenF_ReviewAudit(demoAdapters, (s) => this.navigate(s));
        break;
      case "central-settings":
        rendered = renderScreenG_CentralSettings(demoAdapters, (s) => this.navigate(s));
        break;
      case "privacy-governance":
        rendered = renderScreenH_PrivacyGovernance(demoAdapters, (s) => this.navigate(s));
        break;
      case "account-enterprise":
        rendered = renderScreenI_AccountEnterprise(demoAdapters, (s) => this.navigate(s));
        break;
      case "diagnostics-maintenance":
        rendered = renderScreenJ_DiagnosticsMaintenance(demoAdapters, (s) => this.navigate(s));
        break;
      default:
        rendered = document.createElement("div");
        rendered.textContent = `Screen not found: ${screen}`;
    }

    this.screenContainerEl.appendChild(rendered);
  }
}

function init() {
  const mount = document.getElementById("app");
  if (mount) {
    new GovernWorldApp(mount);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
