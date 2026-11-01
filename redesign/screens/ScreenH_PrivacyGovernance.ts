// Copyright (c) 2026 Andres Chavez Ramirez / ACR LOGIC. All rights reserved.
/**
 * SCREEN H — Privacy & Data Governance
 *
 * Transparent breakdown of the Local-First Zero-Egress Architecture:
 * - On-Device CPU/GPU/Memory hardware execution
 * - Permission audit with plain-language explanations
 * - Network disclosure confirming zero telemetry and locked cloud features
 * - Cryptographic ECDSA audit log integrity guarantee
 */

import type { IBackendAdapters } from "../adapters/contracts.js";
import type { ScreenId } from "../types/index.js";

export function renderScreenH_PrivacyGovernance(
  _adapters: IBackendAdapters,
  _onNavigate: (screen: ScreenId) => void
): HTMLElement {
  const container = document.createElement("div");
  container.className = "gw-screen-privacy";
  container.style.cssText = "display: flex; flex-direction: column; gap: 16px; width: 100%; max-width: 780px; margin: 0 auto;";

  container.innerHTML = `
    <!-- Top Header -->
    <div style="border-bottom: 1px solid var(--gw-border-subtle); padding-bottom: 12px;">
      <h2 class="gw-h2" style="display: flex; align-items: center; gap: 8px;">
        <span>Privacy & Data Governance Manifesto</span>
        <span class="gw-badge gw-badge--operational">LOCAL-FIRST</span>
      </h2>
      <span class="gw-caption">GovernWorld does not sell, upload, transmit, or monetize your data. All detection runs entirely on your device.</span>
    </div>

    <!-- Core Tenet Cards -->
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
      <div class="gw-card" style="padding: 14px;">
        <div style="font-size: 20px; margin-bottom: 6px;">💻</div>
        <strong style="font-size: 13px; color: var(--gw-text-primary); display: block;">Local Hardware Processing</strong>
        <p class="gw-caption" style="margin-top: 4px; line-height: 1.4;">
          OCR, regex evaluation, PDF vector parsing, and pixel verification execute inside Chrome's sandboxed offscreen document using WebAssembly.
        </p>
      </div>

      <div class="gw-card" style="padding: 14px;">
        <div style="font-size: 20px; margin-bottom: 6px;">🚫</div>
        <strong style="font-size: 13px; color: var(--gw-text-primary); display: block;">Zero Network Egress</strong>
        <p class="gw-caption" style="margin-top: 4px; line-height: 1.4;">
          No telemetry, no tracking pixels, and no remote AI endpoints. Raw webpage text and scanned files never cross any network boundary.
        </p>
      </div>
    </div>

    <!-- Manifest Permission Audit -->
    <div class="gw-card" style="padding: 14px; display: flex; flex-direction: column; gap: 10px;">
      <span class="gw-h4">Permission Audit & Justification</span>
      <div style="display: flex; flex-direction: column; gap: 6px;">
        <div style="padding: 8px 10px; background: var(--gw-bg-inset); border-radius: 4px; display: flex; justify-content: space-between; align-items: center;">
          <div>
            <code class="gw-code" style="color: #60a5fa;">activeTab</code>
            <span style="font-size: 12px; margin-left: 8px;">Accesses DOM only when user clicks Scan or uses hotkey.</span>
          </div>
          <span class="gw-badge gw-badge--operational">SANDBOXED</span>
        </div>

        <div style="padding: 8px 10px; background: var(--gw-bg-inset); border-radius: 4px; display: flex; justify-content: space-between; align-items: center;">
          <div>
            <code class="gw-code" style="color: #60a5fa;">scripting</code>
            <span style="font-size: 12px; margin-left: 8px;">Injects visual shadow DOM mask overlay on-demand.</span>
          </div>
          <span class="gw-badge gw-badge--operational">ISOLATED WORLD</span>
        </div>

        <div style="padding: 8px 10px; background: var(--gw-bg-inset); border-radius: 4px; display: flex; justify-content: space-between; align-items: center;">
          <div>
            <code class="gw-code" style="color: #60a5fa;">storage</code>
            <span style="font-size: 12px; margin-left: 8px;">Persists user settings and ECDSA audit records on local storage.</span>
          </div>
          <span class="gw-badge gw-badge--operational">ON-DISK LOCAL</span>
        </div>

        <div style="padding: 8px 10px; background: var(--gw-bg-inset); border-radius: 4px; display: flex; justify-content: space-between; align-items: center;">
          <div>
            <code class="gw-code" style="color: #60a5fa;">offscreen</code>
            <span style="font-size: 12px; margin-left: 8px;">Executes Tesseract WASM OCR in background without DOM clutter.</span>
          </div>
          <span class="gw-badge gw-badge--operational">ISOLATED OFFSCREEN</span>
        </div>
      </div>
    </div>
  `;

  return container;
}
