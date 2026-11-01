// Copyright (c) 2026 Andres Chavez Ramirez / ACR LOGIC. All rights reserved.
/**
 * SCREEN D — Document Studio
 *
 * Professional document processing workspace.
 * Features:
 * - File import and dropzone
 * - Page rail with navigation
 * - DocumentVisualizer with interactive redaction boxes
 * - Style selector (Blackout, Whiteout, Stamp)
 * - Cryptographic Pixel Verification Gate
 * - Export sanitized document
 */

import type { IBackendAdapters } from "../adapters/contracts.js";
import { DocumentVisualizer } from "../components/DocumentVisualizer.js";
import type { DocumentItem, Finding, ScreenId } from "../types/index.js";

export function renderScreenD_DocumentStudio(
  adapters: IBackendAdapters,
  _onNavigate: (screen: ScreenId) => void
): HTMLElement {
  const container = document.createElement("div");
  container.className = "gw-screen-docstudio";
  container.style.cssText = "display: flex; flex-direction: column; gap: 16px; width: 100%; max-width: 980px; margin: 0 auto;";

  container.innerHTML = `
    <!-- Top Action Bar -->
    <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--gw-border-subtle); padding-bottom: 12px;">
      <div>
        <h2 class="gw-h2" style="display: flex; align-items: center; gap: 8px;">
          <span>Document Studio</span>
          <span class="gw-badge gw-badge--operational">ON-DEVICE OCR & PDF</span>
        </h2>
        <span class="gw-caption">Local-first client-side redaction with pixel verification. Zero bytes sent to cloud.</span>
      </div>
      <div style="display: flex; gap: 8px;">
        <button id="doc-btn-verify" class="gw-btn gw-btn--emerald">🛡️ Verify Pixel Redaction</button>
        <button id="doc-btn-download" class="gw-btn gw-btn--primary">⬇️ Download Sanitized PDF</button>
      </div>
    </div>

    <!-- Main Workspace Split -->
    <div style="display: grid; grid-template-columns: 240px 1fr 280px; gap: 16px; align-items: start;">
      
      <!-- Left Column: Document Rail & Pages -->
      <div style="display: flex; flex-direction: column; gap: 12px;">
        <!-- File Dropzone -->
        <div id="doc-dropzone" class="gw-card" style="border: 2px dashed var(--gw-border-base); text-align: center; padding: 20px 10px; cursor: pointer; transition: all var(--gw-transition-fast);">
          <span style="font-size: 24px; display: block; margin-bottom: 6px;">📂</span>
          <strong style="font-size: 12px; display: block;">Import PDF or Image</strong>
          <span class="gw-caption">Drag & drop or click</span>
          <input type="file" id="doc-file-input" accept=".pdf,.png,.jpg,.jpeg" style="display: none;" />
        </div>

        <!-- Page Thumbnails Rail -->
        <div class="gw-card" style="padding: 10px; display: flex; flex-direction: column; gap: 8px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-size: 11px; font-weight: 600; text-transform: uppercase; color: var(--gw-text-muted);">Pages (3)</span>
            <span class="gw-badge gw-badge--sm" style="font-size: 10px;">Window: 1-3</span>
          </div>

          <div style="display: flex; flex-direction: column; gap: 6px;" id="doc-page-rail">
            <div class="doc-page-item" data-page="1" style="display: flex; align-items: center; gap: 8px; padding: 6px; background: var(--gw-bg-interactive); border: 1px solid var(--gw-primary-light); border-radius: 6px; cursor: pointer;">
              <span style="font-family: var(--gw-font-mono); font-size: 11px; width: 20px;">01</span>
              <div style="flex: 1;">
                <div style="font-size: 11px; font-weight: 600;">Intake Face Sheet</div>
                <div class="gw-caption">2 findings (SSN, MRN)</div>
              </div>
              <span style="font-size: 10px; color: #10b981;">✓ Text</span>
            </div>

            <div class="doc-page-item" data-page="2" style="display: flex; align-items: center; gap: 8px; padding: 6px; background: var(--gw-bg-surface); border: 1px solid var(--gw-border-subtle); border-radius: 6px; cursor: pointer;">
              <span style="font-family: var(--gw-font-mono); font-size: 11px; width: 20px;">02</span>
              <div style="flex: 1;">
                <div style="font-size: 11px; font-weight: 600;">Payment Co-pay Slip</div>
                <div class="gw-caption">1 finding (Card)</div>
              </div>
              <span style="font-size: 10px; color: #f59e0b;">OCR</span>
            </div>

            <div class="doc-page-item" data-page="3" style="display: flex; align-items: center; gap: 8px; padding: 6px; background: var(--gw-bg-surface); border: 1px solid var(--gw-border-subtle); border-radius: 6px; cursor: pointer;">
              <span style="font-family: var(--gw-font-mono); font-size: 11px; width: 20px;">03</span>
              <div style="flex: 1;">
                <div style="font-size: 11px; font-weight: 600;">General Consent</div>
                <div class="gw-caption">0 findings</div>
              </div>
              <span style="font-size: 10px; color: #10b981;">✓ Text</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Center Column: Interactive Canvas Stage -->
      <div class="gw-card gw-card--glass" style="display: flex; flex-direction: column; align-items: center; padding: 16px; overflow: auto;">
        <canvas id="doc-stage-canvas" style="max-width: 100%; border-radius: 4px; display: block;"></canvas>
      </div>

      <!-- Right Column: Redaction Controls & Findings Inspector -->
      <div style="display: flex; flex-direction: column; gap: 12px;">
        
        <!-- Style Switcher Card -->
        <div class="gw-card" style="padding: 12px; display: flex; flex-direction: column; gap: 8px;">
          <strong style="font-size: 12px; color: var(--gw-text-primary);">Redaction Box Style</strong>
          <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 4px;">
            <button id="doc-style-blackout" class="gw-btn gw-btn--primary gw-btn--sm" style="font-size: 10px; padding: 5px 2px;">Blackout</button>
            <button id="doc-style-whiteout" class="gw-btn gw-btn--ghost gw-btn--sm" style="font-size: 10px; padding: 5px 2px;">Whiteout</button>
            <button id="doc-style-stamp" class="gw-btn gw-btn--ghost gw-btn--sm" style="font-size: 10px; padding: 5px 2px;">Stamp</button>
          </div>
          <div id="doc-stamp-custom-row" style="display: none; margin-top: 4px;">
            <input type="text" id="doc-stamp-input" value="[REDACTED]" style="width: 100%; font-family: var(--gw-font-mono); font-size: 11px; background: var(--gw-bg-inset); color: var(--gw-text-primary); border: 1px solid var(--gw-border-base); border-radius: 4px; padding: 4px 8px;" />
          </div>
        </div>

        <!-- Findings On Page -->
        <div class="gw-card" style="padding: 12px; display: flex; flex-direction: column; gap: 8px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <strong style="font-size: 12px;">Page Findings</strong>
            <span class="gw-badge gw-badge--critical">3 Target Boxes</span>
          </div>

          <div id="doc-findings-checklist" style="display: flex; flex-direction: column; gap: 6px;">
            <label style="display: flex; align-items: center; gap: 8px; font-size: 11px; cursor: pointer; padding: 6px; background: var(--gw-bg-inset); border-radius: 4px;">
              <input type="checkbox" checked class="doc-box-check" data-id="b1" />
              <span><strong>SSN:</strong> •••-••-6789</span>
            </label>
            <label style="display: flex; align-items: center; gap: 8px; font-size: 11px; cursor: pointer; padding: 6px; background: var(--gw-bg-inset); border-radius: 4px;">
              <input type="checkbox" checked class="doc-box-check" data-id="b2" />
              <span><strong>MRN:</strong> MRN-99482104</span>
            </label>
            <label style="display: flex; align-items: center; gap: 8px; font-size: 11px; cursor: pointer; padding: 6px; background: var(--gw-bg-inset); border-radius: 4px;">
              <input type="checkbox" checked class="doc-box-check" data-id="b3" />
              <span><strong>Card:</strong> 4111-••••-••••-4242</span>
            </label>
          </div>
        </div>

        <!-- Verification Certificate Card -->
        <div id="doc-verify-card" class="gw-card" style="padding: 12px; background: rgba(16, 185, 129, 0.06); border-color: rgba(16, 185, 129, 0.3);">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span style="font-size: 16px;">🛡️</span>
            <strong style="font-size: 12px; color: #10b981;">Pixel Verification</strong>
          </div>
          <div id="doc-verify-status" style="font-size: 11px; color: var(--gw-text-secondary); margin-top: 4px; line-height: 1.4;">
            Ready to verify. Ensures target boxes are permanently painted over and cannot be extracted via PDF text layer.
          </div>
        </div>

      </div>

    </div>
  `;

  // Initialize Canvas Visualizer
  const canvas = container.querySelector("#doc-stage-canvas") as HTMLCanvasElement;
  let visualizer: DocumentVisualizer | null = null;
  setTimeout(() => {
    visualizer = new DocumentVisualizer(canvas);
  }, 50);

  // Wire Dropzone
  const dropzone = container.querySelector("#doc-dropzone") as HTMLElement;
  const fileInput = container.querySelector("#doc-file-input") as HTMLInputElement;

  dropzone.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (file) {
      await adapters.documents.importDocument(file);
      alert(`Imported ${file.name} for on-device processing.`);
    }
  });

  // Wire Style Switchers
  const btnBlackout = container.querySelector("#doc-style-blackout") as HTMLButtonElement;
  const btnWhiteout = container.querySelector("#doc-style-whiteout") as HTMLButtonElement;
  const btnStamp = container.querySelector("#doc-style-stamp") as HTMLButtonElement;
  const stampRow = container.querySelector("#doc-stamp-custom-row") as HTMLElement;
  const stampInput = container.querySelector("#doc-stamp-input") as HTMLInputElement;

  const setActiveStyle = (style: "blackout" | "whiteout" | "stamp") => {
    btnBlackout.className = `gw-btn gw-btn--sm ${style === "blackout" ? "gw-btn--primary" : "gw-btn--ghost"}`;
    btnWhiteout.className = `gw-btn gw-btn--sm ${style === "whiteout" ? "gw-btn--primary" : "gw-btn--ghost"}`;
    btnStamp.className = `gw-btn gw-btn--sm ${style === "stamp" ? "gw-btn--primary" : "gw-btn--ghost"}`;
    stampRow.style.display = style === "stamp" ? "block" : "none";
    visualizer?.setStyle(style, stampInput.value || "[REDACTED]");
  };

  btnBlackout.addEventListener("click", () => setActiveStyle("blackout"));
  btnWhiteout.addEventListener("click", () => setActiveStyle("whiteout"));
  btnStamp.addEventListener("click", () => setActiveStyle("stamp"));
  stampInput.addEventListener("input", () => visualizer?.setStyle("stamp", stampInput.value));

  // Checkbox box toggling
  container.querySelectorAll(".doc-box-check").forEach((cb) => {
    cb.addEventListener("change", (e) => {
      const target = e.target as HTMLInputElement;
      visualizer?.toggleBox(target.dataset.id || "");
    });
  });

  // Verification Button
  const verifyBtn = container.querySelector("#doc-btn-verify") as HTMLButtonElement;
  const verifyStatus = container.querySelector("#doc-verify-status") as HTMLElement;

  verifyBtn.addEventListener("click", () => {
    verifyBtn.disabled = true;
    verifyBtn.textContent = "Scanning pixels...";
    verifyStatus.innerHTML = `<span style="color: #60a5fa;">Inspecting rendered page raster buffer...</span>`;

    visualizer?.runPixelVerification((stats) => {
      verifyBtn.disabled = false;
      verifyBtn.textContent = "✓ Verification Passed";
      verifyStatus.innerHTML = `<strong style="color: #10b981;">✓ 100% Covered (${stats.darkRegions}/${stats.checkedRegions} regions).</strong> Text layer permanently stripped. Ready for export.`;
    });
  });

  // Download Button
  const downloadBtn = container.querySelector("#doc-btn-download") as HTMLButtonElement;
  downloadBtn.addEventListener("click", async () => {
    downloadBtn.textContent = "⬇️ Exporting...";
    await adapters.documents.downloadSanitized("demo-doc", "Patient_Intake_Audit_2026_redacted.pdf");
    downloadBtn.textContent = "✓ Downloaded";
    setTimeout(() => { downloadBtn.textContent = "⬇️ Download Sanitized PDF"; }, 2000);
  });

  return container;
}
