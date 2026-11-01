// Copyright (c) 2026 Andres Chavez Ramirez / ACR LOGIC. All rights reserved.
/**
 * SCREEN F — Combined Review & Audit
 *
 * Implements Non-Negotiable Decision B: Activity, metrics, and security evidence
 * belong under one destination with distinct sub-sections.
 *
 * Features:
 * - Activity Overview & aggregate telemetry metrics
 * - Tamper-Evident Audit Trail with on-device ECDSA signature verification
 * - Security Evidence breakdown
 * - Cryptographic export (JSON / CSV)
 * - Safe confirmation modal for history clearance
 */

import type { IBackendAdapters } from "../adapters/contracts.js";
import type { AuditRecord, ScreenId } from "../types/index.js";

export function renderScreenF_ReviewAudit(
  adapters: IBackendAdapters,
  _onNavigate: (screen: ScreenId) => void
): HTMLElement {
  const container = document.createElement("div");
  container.className = "gw-screen-review-audit";
  container.style.cssText = "display: flex; flex-direction: column; gap: 16px; width: 100%; max-width: 820px; margin: 0 auto;";

  container.innerHTML = `
    <!-- Header -->
    <div style="display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1px solid var(--gw-border-subtle); padding-bottom: 12px;">
      <div>
        <h2 class="gw-h2" style="display: flex; align-items: center; gap: 8px;">
          <span>Review & Audit Evidence</span>
          <span class="gw-badge gw-badge--operational">ECDSA SIGNED</span>
        </h2>
        <span class="gw-caption">Unified destination for local activity, performance metrics, and cryptographic audit records.</span>
      </div>
      <div style="display: flex; gap: 6px;">
        <button id="ra-btn-export-json" class="gw-btn gw-btn--ghost gw-btn--sm">📥 Export JSON</button>
        <button id="ra-btn-export-csv" class="gw-btn gw-btn--ghost gw-btn--sm">📊 Export CSV</button>
        <button id="ra-btn-clear" class="gw-btn gw-btn--danger gw-btn--sm">🗑️ Clear History</button>
      </div>
    </div>

    <!-- Section 1: Aggregate Telemetry Metrics -->
    <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px;">
      <div class="gw-card" style="padding: 12px; text-align: center;">
        <span class="gw-caption">Pages Scanned</span>
        <strong id="ra-stat-pages" style="display: block; font-size: 24px; color: var(--gw-primary-light); font-family: var(--gw-font-mono);">142</strong>
      </div>
      <div class="gw-card" style="padding: 12px; text-align: center;">
        <span class="gw-caption">Paste Intercepts</span>
        <strong id="ra-stat-intercepts" style="display: block; font-size: 24px; color: #f59e0b; font-family: var(--gw-font-mono);">38</strong>
      </div>
      <div class="gw-card" style="padding: 12px; text-align: center;">
        <span class="gw-caption">Documents Redacted</span>
        <strong id="ra-stat-docs" style="display: block; font-size: 24px; color: #10b981; font-family: var(--gw-font-mono);">19</strong>
      </div>
      <div class="gw-card" style="padding: 12px; text-align: center;">
        <span class="gw-caption">Regions Secured</span>
        <strong id="ra-stat-regions" style="display: block; font-size: 24px; color: #38bdf8; font-family: var(--gw-font-mono);">284</strong>
      </div>
    </div>

    <!-- Section 2: Audit Trail (Security Evidence) -->
    <div class="gw-card" style="padding: 14px; display: flex; flex-direction: column; gap: 10px;">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <span class="gw-h4">Cryptographic Audit Trail</span>
        <span class="gw-badge gw-badge--sm" style="font-family: var(--gw-font-mono);">SubtleCrypto P-256</span>
      </div>

      <div id="ra-audit-records-list" style="display: flex; flex-direction: column; gap: 8px;">
        <!-- Records populated dynamically -->
      </div>
    </div>

    <!-- Confirmation Modal (Hidden) -->
    <div id="ra-clear-modal" style="display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.7); backdrop-filter: blur(4px); z-index: 9999; align-items: center; justify-content: center;">
      <div class="gw-card" style="max-width: 400px; width: 90%; padding: 20px; display: flex; flex-direction: column; gap: 12px; border-color: var(--gw-crimson);">
        <strong style="font-size: 14px; color: #f87171;">Confirm Destructive Operation</strong>
        <p style="font-size: 12px; color: var(--gw-text-secondary); margin: 0; line-height: 1.4;">
          Are you sure you want to permanently clear the local activity and audit log history? Signed records on this device will be deleted.
        </p>
        <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px;">
          <button id="ra-modal-cancel" class="gw-btn gw-btn--ghost gw-btn--sm">Cancel</button>
          <button id="ra-modal-confirm" class="gw-btn gw-btn--danger gw-btn--sm">Confirm Delete</button>
        </div>
      </div>
    </div>
  `;

  const recordsList = container.querySelector("#ra-audit-records-list") as HTMLElement;
  const modal = container.querySelector("#ra-clear-modal") as HTMLElement;

  const renderRecords = (records: AuditRecord[]) => {
    recordsList.innerHTML = "";
    if (records.length === 0) {
      recordsList.innerHTML = `<div class="gw-caption" style="text-align: center; padding: 20px;">No audit records available.</div>`;
      return;
    }

    records.forEach((r) => {
      const row = document.createElement("div");
      row.style.cssText = "display: flex; justify-content: space-between; align-items: flex-start; padding: 10px; background: var(--gw-bg-inset); border: 1px solid var(--gw-border-subtle); border-radius: 6px; font-size: 12px;";

      const outcomeColor = r.outcome === "ok" ? "#10b981" : r.outcome === "blocked" ? "#ef4444" : "#f59e0b";

      row.innerHTML = `
        <div style="display: flex; flex-direction: column; gap: 4px; flex: 1;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-family: var(--gw-font-mono); font-size: 11px; color: var(--gw-text-muted);">${new Date(r.timestamp).toLocaleTimeString()}</span>
            <strong style="color: var(--gw-text-primary);">${r.action}</strong>
            <span class="gw-badge" style="border-color: ${outcomeColor}; color: ${outcomeColor};">${r.outcome.toUpperCase()}</span>
          </div>
          <div style="font-size: 11px; color: var(--gw-text-secondary);">
            Target: <code class="gw-code">${r.target}</code> • Actor: ${r.actor}
          </div>
          <div style="font-family: var(--gw-font-mono); font-size: 10px; color: var(--gw-text-muted);">
            SIG: ${r.signature}
          </div>
        </div>
        <button class="gw-btn gw-btn--ghost gw-btn--sm btn-verify-record" data-id="${r.id}" style="font-size: 10px; padding: 4px 8px;">
          ✓ Verify Signature
        </button>
      `;

      row.querySelector(".btn-verify-record")?.addEventListener("click", async (e) => {
        const btn = e.target as HTMLButtonElement;
        btn.textContent = "Verifying...";
        const res = await adapters.audit.verifyTamperEvidence(r.id);
        btn.textContent = res.valid ? "✓ Valid Signature" : "❌ Invalid";
        btn.style.color = res.valid ? "#10b981" : "#ef4444";
      });

      recordsList.appendChild(row);
    });
  };

  void adapters.audit.getAuditRecords().then(renderRecords);

  // Wire Export
  container.querySelector("#ra-btn-export-json")?.addEventListener("click", async () => {
    const json = await adapters.audit.exportAuditLog("json");
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `governworld_audit_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  container.querySelector("#ra-btn-export-csv")?.addEventListener("click", async () => {
    const csv = await adapters.audit.exportAuditLog("csv");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `governworld_audit_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // Wire Clear History Modal
  container.querySelector("#ra-btn-clear")?.addEventListener("click", () => {
    modal.style.display = "flex";
  });
  container.querySelector("#ra-modal-cancel")?.addEventListener("click", () => {
    modal.style.display = "none";
  });
  container.querySelector("#ra-modal-confirm")?.addEventListener("click", async () => {
    await adapters.audit.clearLocalHistory();
    modal.style.display = "none";
    renderRecords([]);
  });

  return container;
}
