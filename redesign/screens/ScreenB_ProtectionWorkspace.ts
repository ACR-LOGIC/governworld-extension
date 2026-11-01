// Copyright (c) 2026 Andres Chavez Ramirez / ACR LOGIC. All rights reserved.
/**
 * SCREEN B — Protection Workspace (Side Panel / Inspection Workspace)
 *
 * Provides comprehensive in-depth inspection of the current page:
 * - Real-time canvas laser scanning visualizer
 * - Tab origin disclosure & coverage limitations
 * - Interactive findings list with category badges & masked values
 * - Action controls: Apply Masks, Copy Redacted Text, Remove Masks
 */

import type { IBackendAdapters } from "../adapters/contracts.js";
import { ScanVisualizer } from "../components/ScanVisualizer.js";
import type { Finding, ScreenId } from "../types/index.js";

export function renderScreenB_ProtectionWorkspace(
  adapters: IBackendAdapters,
  _onNavigate: (screen: ScreenId) => void
): HTMLElement {
  const container = document.createElement("div");
  container.className = "gw-screen-workspace";
  container.style.cssText = "display: flex; flex-direction: column; gap: 16px; width: 100%; max-width: 680px; margin: 0 auto;";

  container.innerHTML = `
    <!-- Header & Page Meta -->
    <div style="display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1px solid var(--gw-border-subtle); padding-bottom: 12px;">
      <div>
        <h2 class="gw-h2" style="display: flex; align-items: center; gap: 8px;">
          <span>Inspection Workspace</span>
          <span class="gw-badge gw-badge--operational">LIVE</span>
        </h2>
        <div style="display: flex; align-items: center; gap: 6px; margin-top: 4px;">
          <span style="font-size: 11px; color: var(--gw-text-muted);">TARGET HOST:</span>
          <code class="gw-code" style="color: #60a5fa;">app.healthportal.example/patient/8421</code>
        </div>
      </div>
      <div style="display: flex; gap: 6px;">
        <button id="ws-trigger-scan" class="gw-btn gw-btn--primary gw-btn--sm">⚡ Start Live Scan</button>
      </div>
    </div>

    <!-- Scanning Radar / Canvas Visualizer -->
    <div class="gw-card gw-card--glass" style="position: relative; overflow: hidden; padding: 0; border-radius: var(--gw-radius-md);">
      <canvas id="ws-scan-canvas" style="width: 100%; height: 180px; display: block;"></canvas>
      <div style="position: absolute; bottom: 8px; left: 12px; display: flex; gap: 12px; font-size: 11px; font-family: var(--gw-font-mono); color: var(--gw-text-muted);">
        <span>NODES: <strong style="color: var(--gw-text-primary);" id="ws-stat-nodes">1,248</strong></span>
        <span>VISIBLE CHARS: <strong style="color: var(--gw-text-primary);" id="ws-stat-chars">48,290</strong></span>
        <span>COVERAGE: <strong style="color: #10b981;">100% (DOM & Forms)</strong></span>
      </div>
    </div>

    <!-- Findings Control Bar -->
    <div style="display: flex; align-items: center; justify-content: space-between;">
      <div style="display: flex; align-items: center; gap: 8px;">
        <span class="gw-h4">Detected Findings</span>
        <span id="ws-findings-count-badge" class="gw-badge gw-badge--high">5 Identified</span>
      </div>
      <div style="display: flex; gap: 6px;">
        <button id="ws-btn-apply-masks" class="gw-btn gw-btn--emerald gw-btn--sm">🛡️ Apply Visual Masks</button>
        <button id="ws-btn-copy-sanitized" class="gw-btn gw-btn--ghost gw-btn--sm">📋 Copy Redacted</button>
        <button id="ws-btn-clear" class="gw-btn gw-btn--ghost gw-btn--sm" title="Clear all masks">Clear</button>
      </div>
    </div>

    <!-- Findings List Container -->
    <div id="ws-findings-list" style="display: flex; flex-direction: column; gap: 8px;">
      <!-- Populated dynamically -->
    </div>

    <!-- Coverage Limitations Notice -->
    <div class="gw-card" style="background: rgba(245, 158, 11, 0.06); border-color: rgba(245, 158, 11, 0.25); padding: 12px;">
      <div style="display: flex; gap: 8px;">
        <span style="font-size: 16px;">ℹ️</span>
        <div style="font-size: 12px; color: var(--gw-text-secondary); line-height: 1.4;">
          <strong style="color: #f59e0b;">Zero-Egress Security Invariant:</strong>
          All inspections, token matchings, and mask computations execute in local browser memory.
          External cross-origin iframes with strict CSP are disclosed rather than bypassed.
        </div>
      </div>
    </div>
  `;

  // Initialize Canvas Visualizer
  const canvas = container.querySelector("#ws-scan-canvas") as HTMLCanvasElement;
  let visualizer: ScanVisualizer | null = null;
  setTimeout(() => {
    visualizer = new ScanVisualizer(canvas);
  }, 50);

  const findingsListEl = container.querySelector("#ws-findings-list") as HTMLElement;
  const countBadgeEl = container.querySelector("#ws-findings-count-badge") as HTMLElement;
  const scanBtn = container.querySelector("#ws-trigger-scan") as HTMLButtonElement;
  const applyBtn = container.querySelector("#ws-btn-apply-masks") as HTMLButtonElement;
  const copyBtn = container.querySelector("#ws-btn-copy-sanitized") as HTMLButtonElement;
  const clearBtn = container.querySelector("#ws-btn-clear") as HTMLButtonElement;

  let currentFindings: Finding[] = [];

  const renderFindings = (findings: Finding[]) => {
    currentFindings = findings;
    countBadgeEl.textContent = `${findings.length} Identified`;
    findingsListEl.innerHTML = "";

    if (findings.length === 0) {
      findingsListEl.innerHTML = `
        <div class="gw-card" style="text-align: center; padding: 24px; color: var(--gw-text-muted);">
          No sensitive data detected on this page. Click "Start Live Scan" to inspect.
        </div>
      `;
      return;
    }

    findings.forEach((f) => {
      const item = document.createElement("div");
      item.className = "gw-card";
      item.style.cssText = "display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 12px;";

      const badgeClass = f.severity === "critical" ? "gw-badge--critical" : f.severity === "high" ? "gw-badge--high" : "gw-badge--medium";

      item.innerHTML = `
        <div style="display: flex; align-items: flex-start; gap: 10px; flex: 1;">
          <input type="checkbox" class="ws-finding-check" data-id="${f.id}" ${f.selected ? "checked" : ""} style="margin-top: 3px; cursor: pointer;" />
          <div style="display: flex; flex-direction: column; gap: 4px; flex: 1;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span class="gw-badge ${badgeClass}">${f.severity.toUpperCase()}</span>
              <strong style="font-size: 13px; color: var(--gw-text-primary);">${f.label}</strong>
              <span style="font-size: 11px; color: var(--gw-text-muted); font-family: var(--gw-font-mono);">
                CONF: ${Math.round(f.confidence * 100)}%
              </span>
            </div>
            <div style="font-size: 12px; font-family: var(--gw-font-mono); color: #cbd5e1;">
              ${f.contextSnippet}
            </div>
            ${f.location?.nodePath ? `<div style="font-size: 10px; color: var(--gw-text-muted);">${f.location.nodePath}</div>` : ""}
          </div>
        </div>
        <div style="text-align: right;">
          <code class="gw-code" style="color: #60a5fa;">${f.maskedValue}</code>
        </div>
      `;

      const check = item.querySelector(".ws-finding-check") as HTMLInputElement;
      check.addEventListener("change", () => {
        f.selected = check.checked;
      });

      findingsListEl.appendChild(item);
    });
  };

  // Populate initial findings
  void adapters.scanning.getFindings("current").then(renderFindings);

  // Scan Trigger
  scanBtn.addEventListener("click", async () => {
    scanBtn.disabled = true;
    scanBtn.textContent = "Scanning...";
    visualizer?.start();

    // Trigger synthetic particle hits
    visualizer?.addHit(0.3, 0.4, "critical");
    visualizer?.addHit(0.65, 0.7, "high");

    const unsubscribe = adapters.scanning.onScanProgress(async ({ progress }) => {
      if (progress >= 100) {
        scanBtn.disabled = false;
        scanBtn.textContent = "⚡ Rescan Page";
        visualizer?.stop();
        const findings = await adapters.scanning.getFindings("current");
        renderFindings(findings);
        unsubscribe();
      }
    });

    await adapters.scanning.startScan();
  });

  // Action Buttons
  applyBtn.addEventListener("click", async () => {
    const selectedIds = currentFindings.filter((f) => f.selected).map((f) => f.id);
    await adapters.scanning.applyMasks("current", selectedIds);
    applyBtn.textContent = "✓ Masks Applied";
    setTimeout(() => { applyBtn.textContent = "🛡️ Apply Visual Masks"; }, 2000);
  });

  copyBtn.addEventListener("click", () => {
    const redactedText = currentFindings.map((f) => `[${f.label} REDACTED]`).join("\n");
    void navigator.clipboard?.writeText(redactedText);
    copyBtn.textContent = "✓ Copied!";
    setTimeout(() => { copyBtn.textContent = "📋 Copy Redacted"; }, 1500);
  });

  clearBtn.addEventListener("click", async () => {
    await adapters.scanning.removeMasks("current");
    currentFindings.forEach((f) => { f.selected = false; });
    renderFindings(currentFindings);
  });

  return container;
}
