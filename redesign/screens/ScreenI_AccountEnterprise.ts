// Copyright (c) 2026 Andres Chavez Ramirez / ACR LOGIC. All rights reserved.
/**
 * SCREEN I — Account & Enterprise Controls
 *
 * Workspace management, organization policies, and role-based permissions:
 * - Organization identity & role badges
 * - Enterprise Policy enforcement visualizer (Locked vs User-Controlled)
 * - Cloud Gateway credential binding (disabled by default)
 */

import type { IBackendAdapters } from "../adapters/contracts.js";
import type { ScreenId } from "../types/index.js";

export function renderScreenI_AccountEnterprise(
  _adapters: IBackendAdapters,
  _onNavigate: (screen: ScreenId) => void
): HTMLElement {
  const container = document.createElement("div");
  container.className = "gw-screen-account";
  container.style.cssText = "display: flex; flex-direction: column; gap: 16px; width: 100%; max-width: 780px; margin: 0 auto;";

  container.innerHTML = `
    <!-- Top Header -->
    <div style="border-bottom: 1px solid var(--gw-border-subtle); padding-bottom: 12px;">
      <h2 class="gw-h2" style="display: flex; align-items: center; gap: 8px;">
        <span>Organization & Enterprise Controls</span>
        <span class="gw-badge gw-badge--medium">WORKSPACE</span>
      </h2>
      <span class="gw-caption">Manage organization identity, fleet policies, and centralized compliance mandates.</span>
    </div>

    <!-- Identity Summary Card -->
    <div class="gw-card gw-card--glass" style="display: flex; justify-content: space-between; align-items: center; padding: 16px;">
      <div style="display: flex; align-items: center; gap: 14px;">
        <div style="width: 44px; height: 44px; border-radius: 50%; background: #1e293b; display: flex; align-items: center; justify-content: center; font-size: 20px;">
          🏢
        </div>
        <div>
          <strong style="font-size: 14px; color: var(--gw-text-primary); display: block;">Apex Health Systems Enterprise</strong>
          <span style="font-size: 12px; color: var(--gw-text-muted);">Workspace ID: <code class="gw-code">apex-sec-prod-01</code></span>
        </div>
      </div>
      <div>
        <span class="gw-badge gw-badge--operational">ROLE: COMPLIANCE OFFICER</span>
      </div>
    </div>

    <!-- Enterprise Policy Lock Grid -->
    <div class="gw-card" style="padding: 14px; display: flex; flex-direction: column; gap: 10px;">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <span class="gw-h4">Managed Group Policies (GPO / InTune)</span>
        <span class="gw-badge gw-badge--critical">3 Mandatory Locks</span>
      </div>

      <div style="display: flex; flex-direction: column; gap: 8px;">
        <div style="padding: 10px; background: var(--gw-bg-inset); border: 1px solid rgba(239, 68, 68, 0.25); border-radius: 6px; display: flex; justify-content: space-between; align-items: center;">
          <div>
            <strong style="font-size: 13px; color: #f87171;">Mandatory PHI Category Enforcement</strong>
            <span class="gw-caption" style="display: block;">SSN, Medical Record Number, and NPI categories cannot be disabled by user.</span>
          </div>
          <span class="gw-badge gw-badge--critical">🔒 LOCKED</span>
        </div>

        <div style="padding: 10px; background: var(--gw-bg-inset); border: 1px solid rgba(239, 68, 68, 0.25); border-radius: 6px; display: flex; justify-content: space-between; align-items: center;">
          <div>
            <strong style="font-size: 13px; color: #f87171;">Enforce Zero Cloud Egress</strong>
            <span class="gw-caption" style="display: block;">Cloud mode toggle is permanently disabled. All scanning must run on-device.</span>
          </div>
          <span class="gw-badge gw-badge--critical">🔒 LOCKED</span>
        </div>

        <div style="padding: 10px; background: var(--gw-bg-inset); border: 1px solid rgba(239, 68, 68, 0.25); border-radius: 6px; display: flex; justify-content: space-between; align-items: center;">
          <div>
            <strong style="font-size: 13px; color: #f87171;">Cryptographic Audit Retention</strong>
            <span class="gw-caption" style="display: block;">Local audit log records cannot be cleared without compliance authorization.</span>
          </div>
          <span class="gw-badge gw-badge--critical">🔒 LOCKED</span>
        </div>
      </div>
    </div>
  `;

  return container;
}
