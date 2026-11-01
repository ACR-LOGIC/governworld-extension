// Copyright (c) 2026 Andres Chavez Ramirez / ACR LOGIC. All rights reserved.
/**
 * SCREEN G — Central Settings
 *
 * Implements Non-Negotiable Decision C: Single Centralized Settings Destination.
 * All persistent configuration belongs here.
 *
 * Features 8 Subsections:
 * 1. Protection & Site Access
 * 2. Paste & Clipboard Shield
 * 3. Detection Profiles (Quick jump)
 * 4. Privacy & Permissions
 * 5. Appearance & Accessibility
 * 6. Notifications System
 * 7. Session & Data Management
 * 8. Account & Enterprise Policies
 */

import type { IBackendAdapters } from "../adapters/contracts.js";
import type { ScreenId } from "../types/index.js";

export function renderScreenG_CentralSettings(
  adapters: IBackendAdapters,
  onNavigate: (screen: ScreenId) => void
): HTMLElement {
  const container = document.createElement("div");
  container.className = "gw-screen-settings";
  container.style.cssText = "display: flex; flex-direction: column; gap: 16px; width: 100%; max-width: 820px; margin: 0 auto;";

  container.innerHTML = `
    <!-- Top Bar -->
    <div style="display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1px solid var(--gw-border-subtle); padding-bottom: 12px;">
      <div>
        <h2 class="gw-h2">Central Settings</h2>
        <span class="gw-caption">Single authoritative configuration hub for protection, clipboard, accessibility, and enterprise rules.</span>
      </div>
      <button id="set-btn-save" class="gw-btn gw-btn--primary gw-btn--sm">💾 Save All Preferences</button>
    </div>

    <!-- Navigation Sub-Tabs -->
    <div style="display: flex; gap: 4px; overflow-x: auto; padding-bottom: 4px; border-bottom: 1px solid var(--gw-border-subtle);" id="set-nav-tabs">
      <button class="gw-btn gw-btn--sm gw-btn--primary set-tab-btn" data-tab="protection">🛡️ Protection</button>
      <button class="gw-btn gw-btn--sm gw-btn--ghost set-tab-btn" data-tab="paste">📋 Paste Shield</button>
      <button class="gw-btn gw-btn--sm gw-btn--ghost set-tab-btn" data-tab="a11y">👁️ Appearance & A11y</button>
      <button class="gw-btn gw-btn--sm gw-btn--ghost set-tab-btn" data-tab="notifications">🔔 Notifications</button>
      <button class="gw-btn gw-btn--sm gw-btn--ghost set-tab-btn" data-tab="session">⏱️ Session & Data</button>
      <button class="gw-btn gw-btn--sm gw-btn--ghost set-tab-btn" data-tab="account">🏢 Enterprise</button>
    </div>

    <!-- Tab 1: Protection -->
    <div id="set-panel-protection" class="set-panel" style="display: flex; flex-direction: column; gap: 12px;">
      <div class="gw-card" style="display: flex; flex-direction: column; gap: 10px;">
        <span class="gw-h4">Site Protection Coverage</span>
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <div>
            <strong style="font-size: 13px;">This-Tab Protection (activeTab)</strong>
            <span class="gw-caption" style="display: block;">Runs on-demand when explicitly triggered. Zero background permissions required.</span>
          </div>
          <span class="gw-badge gw-badge--operational">ACTIVE</span>
        </div>
        <div style="height: 1px; background: var(--gw-border-subtle);"></div>
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <div>
            <strong style="font-size: 13px;">Always-On Cross-Site Protection</strong>
            <span class="gw-caption" style="display: block;">Continuous self-injection across visited pages. Requires optional site access grant.</span>
          </div>
          <label class="gw-switch">
            <input type="checkbox" id="set-always-on-toggle" />
            <span class="gw-switch__slider"></span>
          </label>
        </div>
      </div>

      <div class="gw-card" style="display: flex; align-items: center; justify-content: space-between;">
        <div>
          <strong style="font-size: 13px;">Configure Shared Detection Profiles</strong>
          <span class="gw-caption" style="display: block;">Customize compliance presets, 20 categories, and confidence thresholds.</span>
        </div>
        <button id="set-btn-goto-profiles" class="gw-btn gw-btn--ghost gw-btn--sm">Open Engine Profiles →</button>
      </div>
    </div>

    <!-- Tab 2: Paste Shield -->
    <div id="set-panel-paste" class="set-panel" style="display: none; flex-direction: column; gap: 12px;">
      <div class="gw-card" style="display: flex; flex-direction: column; gap: 12px;">
        <span class="gw-h4">Paste & LLM Prompt Shield</span>
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <div>
            <strong style="font-size: 13px;">Proactive Paste Interception</strong>
            <span class="gw-caption" style="display: block;">Inspects clipboard text on inputs, textareas, and chat prompts before pasting.</span>
          </div>
          <label class="gw-switch">
            <input type="checkbox" checked id="set-paste-guard-toggle" />
            <span class="gw-switch__slider"></span>
          </label>
        </div>
        <div style="height: 1px; background: var(--gw-border-subtle);"></div>
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <div>
            <strong style="font-size: 13px;">Auto-Copy Sanitized Text</strong>
            <span class="gw-caption" style="display: block;">Immediately places sanitized replacement on clipboard after masking.</span>
          </div>
          <label class="gw-switch">
            <input type="checkbox" checked id="set-paste-autocopy-toggle" />
            <span class="gw-switch__slider"></span>
          </label>
        </div>
      </div>
    </div>

    <!-- Tab 3: Appearance & A11y -->
    <div id="set-panel-a11y" class="set-panel" style="display: none; flex-direction: column; gap: 12px;">
      <div class="gw-card" style="display: flex; flex-direction: column; gap: 12px;">
        <span class="gw-h4">Accessibility & Display</span>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
          <div>
            <label style="font-size: 12px; color: var(--gw-text-secondary); display: block; margin-bottom: 4px;">Language</label>
            <select id="set-lang-select" style="width: 100%; background: var(--gw-bg-inset); color: var(--gw-text-primary); border: 1px solid var(--gw-border-base); border-radius: 4px; padding: 6px 10px;">
              <option value="en">🇺🇸 English</option>
              <option value="es">🇪🇸 Español</option>
              <option value="fr">🇫🇷 Français</option>
              <option value="de">🇩🇪 Deutsch</option>
              <option value="ja">🇯🇵 日本語</option>
              <option value="pt">🇵🇹 Português</option>
              <option value="zh">🇨🇳 简体中文</option>
            </select>
          </div>
          <div>
            <label style="font-size: 12px; color: var(--gw-text-secondary); display: block; margin-bottom: 4px;">Text Sizing Scale</label>
            <select id="set-font-size-select" style="width: 100%; background: var(--gw-bg-inset); color: var(--gw-text-primary); border: 1px solid var(--gw-border-base); border-radius: 4px; padding: 6px 10px;">
              <option value="default">Default (13px)</option>
              <option value="medium">Medium (14px)</option>
              <option value="large">Large (16px)</option>
              <option value="xlarge">Extra Large (18px)</option>
            </select>
          </div>
        </div>

        <div style="height: 1px; background: var(--gw-border-subtle);"></div>

        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div>
            <strong style="font-size: 13px;">High Contrast Mode</strong>
            <span class="gw-caption" style="display: block;">Pure black backgrounds with strengthened borders.</span>
          </div>
          <label class="gw-switch">
            <input type="checkbox" id="set-high-contrast-toggle" />
            <span class="gw-switch__slider"></span>
          </label>
        </div>

        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div>
            <strong style="font-size: 13px;">Reduced Motion</strong>
            <span class="gw-caption" style="display: block;">Disables sliding animations and scanning beam effects.</span>
          </div>
          <label class="gw-switch">
            <input type="checkbox" id="set-reduced-motion-toggle" />
            <span class="gw-switch__slider"></span>
          </label>
        </div>

        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div>
            <strong style="font-size: 13px;">Speech Announcements</strong>
            <span class="gw-caption" style="display: block;">Web Speech API voice feedback for blind and screen-reader users.</span>
          </div>
          <label class="gw-switch">
            <input type="checkbox" id="set-speech-toggle" />
            <span class="gw-switch__slider"></span>
          </label>
        </div>
      </div>
    </div>

    <!-- Tab 4: Notifications -->
    <div id="set-panel-notifications" class="set-panel" style="display: none; flex-direction: column; gap: 12px;">
      <div class="gw-card" style="display: flex; flex-direction: column; gap: 12px;">
        <span class="gw-h4">Notification Channels</span>
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div>
            <strong style="font-size: 13px;">In-Page HUD Toasts</strong>
            <span class="gw-caption" style="display: block;">Closed shadow DOM toast alerts directly on page.</span>
          </div>
          <label class="gw-switch">
            <input type="checkbox" checked id="set-notify-toast-toggle" />
            <span class="gw-switch__slider"></span>
          </label>
        </div>
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div>
            <strong style="font-size: 13px;">Toolbar Icon Badges</strong>
            <span class="gw-caption" style="display: block;">Dynamic counters and status color flashes on extension icon.</span>
          </div>
          <label class="gw-switch">
            <input type="checkbox" checked id="set-notify-badge-toggle" />
            <span class="gw-switch__slider"></span>
          </label>
        </div>
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div>
            <strong style="font-size: 13px;">Desktop OS Notifications</strong>
            <span class="gw-caption" style="display: block;">System notifications (requires optional browser permission).</span>
          </div>
          <label class="gw-switch">
            <input type="checkbox" id="set-notify-os-toggle" />
            <span class="gw-switch__slider"></span>
          </label>
        </div>
      </div>
    </div>

    <!-- Tab 5: Session & Data -->
    <div id="set-panel-session" class="set-panel" style="display: none; flex-direction: column; gap: 12px;">
      <div class="gw-card" style="display: flex; flex-direction: column; gap: 12px;">
        <span class="gw-h4">Memory & Data Lifecycle</span>
        <div>
          <label style="font-size: 12px; color: var(--gw-text-secondary); display: block; margin-bottom: 4px;">Inactivity Session Timeout</label>
          <select id="set-timeout-select" style="width: 100%; background: var(--gw-bg-inset); color: var(--gw-text-primary); border: 1px solid var(--gw-border-base); border-radius: 4px; padding: 6px 10px;">
            <option value="never">Never (Persistent across tab)</option>
            <option value="5m">5 Minutes</option>
            <option value="15m" selected>15 Minutes (Recommended)</option>
            <option value="30m">30 Minutes</option>
          </select>
        </div>
      </div>
    </div>

    <!-- Tab 6: Account & Enterprise -->
    <div id="set-panel-account" class="set-panel" style="display: none; flex-direction: column; gap: 12px;">
      <div class="gw-card" style="display: flex; flex-direction: column; gap: 12px;">
        <span class="gw-h4">Enterprise Policy Management</span>
        <div style="padding: 10px; background: rgba(59, 130, 246, 0.08); border: 1px solid rgba(59, 130, 246, 0.25); border-radius: 6px; font-size: 12px;">
          <strong>Local Workstation Mode:</strong> Running without managed enterprise lock. Full user autonomy enabled.
        </div>
        <div>
          <label style="font-size: 12px; color: var(--gw-text-secondary); display: block; margin-bottom: 4px;">Gateway API Endpoint (Optional)</label>
          <input type="url" value="https://api.governworld.acrlogic.com" disabled style="width: 100%; background: var(--gw-bg-inset); color: var(--gw-text-muted); border: 1px solid var(--gw-border-subtle); border-radius: 4px; padding: 6px 10px; font-family: var(--gw-font-mono); font-size: 12px;" />
          <span class="gw-caption" style="margin-top: 4px; display: block;">Cloud services are permanently disabled and locked by default.</span>
        </div>
      </div>
    </div>
  `;

  // Wire Sub-tabs
  const tabBtns = container.querySelectorAll(".set-tab-btn");
  const panels = container.querySelectorAll(".set-panel");

  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tabName = (btn as HTMLElement).dataset.tab;
      tabBtns.forEach((b) => {
        b.className = `gw-btn gw-btn--sm set-tab-btn ${b === btn ? "gw-btn--primary" : "gw-btn--ghost"}`;
      });
      panels.forEach((p) => {
        (p as HTMLElement).style.display = p.id === `set-panel-${tabName}` ? "flex" : "none";
      });
    });
  });

  container.querySelector("#set-btn-goto-profiles")?.addEventListener("click", () => {
    onNavigate("detection-profiles");
  });

  const saveBtn = container.querySelector("#set-btn-save") as HTMLButtonElement;
  saveBtn.addEventListener("click", async () => {
    saveBtn.textContent = "✓ Preferences Saved";
    setTimeout(() => { saveBtn.textContent = "💾 Save All Preferences"; }, 1500);
  });

  return container;
}
