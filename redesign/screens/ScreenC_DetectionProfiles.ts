// Copyright (c) 2026 Andres Chavez Ramirez / ACR LOGIC. All rights reserved.
/**
 * SCREEN C — Shared Detection Profiles
 *
 * Implements Non-Negotiable Decision A: Single Source of Truth for Detection.
 * Page Scanning, Paste Shield, and Document Studio consume this shared configuration.
 *
 * Features:
 * - 9 Compliance Presets (HIPAA, PCI, GDPR, PIPEDA, UK GDPR, DPDP, Australia, LGPD, Developer)
 * - 20 Detection Categories with individual toggles and confidence sliders
 * - Visual masking defaults (padding, placeholder stamps)
 * - Clear legal non-certification disclosure
 */

import type { IBackendAdapters } from "../adapters/contracts.js";
import type { CompliancePresetId, DetectionProfile, FindingCategory, ScreenId } from "../types/index.js";

const PRESET_DEFINITIONS: Record<Exclude<CompliancePresetId, "custom">, { label: string; categories: FindingCategory[] }> = {
  hipaa: {
    label: "HIPAA (Healthcare)",
    categories: ["medical_record_number", "member_id", "npi", "dea", "mbi", "ssn", "dob", "address", "phone", "email", "possible_name"],
  },
  pci: {
    label: "PCI DSS (Payments)",
    categories: ["payment_card", "ssn", "address", "phone", "email"],
  },
  gdpr: {
    label: "GDPR (EU Personal Data)",
    categories: ["email", "phone", "address", "ssn", "dob", "possible_name", "medical_record_number", "member_id"],
  },
  developer: {
    label: "Developer (API Keys & Secrets)",
    categories: ["secrets", "email", "phone"],
  },
  pipeda: {
    label: "PIPEDA (Canada)",
    categories: ["canadian_sin", "email", "phone", "address", "dob", "possible_name", "payment_card"],
  },
  uk_gdpr: {
    label: "UK GDPR / NHS (United Kingdom)",
    categories: ["uk_nhs", "email", "phone", "address", "dob", "possible_name", "medical_record_number", "member_id", "payment_card"],
  },
  india_dpdp: {
    label: "DPDP Act (India Privacy)",
    categories: ["aadhaar", "pan_india", "email", "phone", "address", "dob", "possible_name", "payment_card"],
  },
  australia_privacy: {
    label: "Privacy Act (Australia)",
    categories: ["australian_tfn", "email", "phone", "address", "dob", "possible_name", "payment_card"],
  },
  brazil_lgpd: {
    label: "LGPD (Brazil Personal Data)",
    categories: ["cpf", "email", "phone", "address", "dob", "possible_name", "payment_card"],
  },
};

const ALL_CATEGORIES: { id: FindingCategory; label: string; desc: string }[] = [
  { id: "ssn", label: "US Social Security Number (SSN)", desc: "9-digit government identifier with area-group validation" },
  { id: "payment_card", label: "Payment & Credit Cards", desc: "Visa, Mastercard, Amex, Discover verified by Luhn checksum" },
  { id: "secrets", label: "API Keys, Bearer Tokens & Secrets", desc: "JWTs, AWS keys, Stripe tokens, private cryptographic keys" },
  { id: "medical_record_number", label: "Medical Record Number (MRN)", desc: "Hospital and clinical health record identifiers" },
  { id: "npi", label: "National Provider Identifier (NPI)", desc: "10-digit CMS healthcare provider identifier" },
  { id: "dea", label: "DEA Number", desc: "Drug Enforcement Administration practitioner checksums" },
  { id: "mbi", label: "Medicare Beneficiary Identifier (MBI)", desc: "11-character CMS Medicare alphanumeric format" },
  { id: "member_id", label: "Health Plan Member ID", desc: "Insurance carrier identification numbers" },
  { id: "email", label: "Email Addresses", desc: "Standard RFC 5322 electronic mail endpoints" },
  { id: "phone", label: "Telephone Numbers", desc: "E.164 and localized international phone patterns" },
  { id: "dob", label: "Date of Birth", desc: "Birthdate records and contextual age representations" },
  { id: "address", label: "Street Addresses", desc: "Physical delivery addresses and street lines" },
  { id: "possible_name", label: "Personal Names (NER)", desc: "Contextual personal and patient names" },
  { id: "canadian_sin", label: "Canadian SIN", desc: "Canada Social Insurance Numbers with Luhn check" },
  { id: "uk_nhs", label: "UK NHS Number", desc: "National Health Service 10-digit Modulus 11 check" },
  { id: "aadhaar", label: "Aadhaar (India)", desc: "12-digit Indian national UIDAI identifier with Verhoeff check" },
  { id: "pan_india", label: "PAN (India)", desc: "10-digit Indian Permanent Account Number" },
  { id: "australian_tfn", label: "Australian TFN", desc: "8 or 9-digit Tax File Number with modulus check" },
  { id: "cpf", label: "Brazilian CPF", desc: "11-digit Brazilian Cadastro de Pessoas Físicas checksum" },
  { id: "custom", label: "My Logic Custom Rules", desc: "User-defined regular expressions and pattern packs" },
];

export function renderScreenC_DetectionProfiles(
  adapters: IBackendAdapters,
  _onNavigate: (screen: ScreenId) => void
): HTMLElement {
  const container = document.createElement("div");
  container.className = "gw-screen-detection-profiles";
  container.style.cssText = "display: flex; flex-direction: column; gap: 16px; width: 100%; max-width: 720px; margin: 0 auto;";

  container.innerHTML = `
    <!-- Top Header -->
    <div style="display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1px solid var(--gw-border-subtle); padding-bottom: 12px;">
      <div>
        <h2 class="gw-h2">Shared Detection Engine</h2>
        <p class="gw-caption" style="margin-top: 4px;">
          Architectural Core: Page Scanning, Paste Shield, and Document Studio all consume this single profile.
        </p>
      </div>
      <button id="dp-btn-save" class="gw-btn gw-btn--primary gw-btn--sm">💾 Save Profile</button>
    </div>

    <!-- Compliance Presets Selector -->
    <div class="gw-card gw-card--glass" style="display: flex; flex-direction: column; gap: 12px;">
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <strong style="font-size: 13px;">Compliance & Industry Presets</strong>
        <span class="gw-caption">Select preset to configure recommended categories</span>
      </div>
      <div id="dp-preset-pills" style="display: flex; flex-wrap: wrap; gap: 6px;">
        <!-- Preset pills populated dynamically -->
      </div>
    </div>

    <!-- Categories Grid -->
    <div class="gw-card" style="padding: 14px; display: flex; flex-direction: column; gap: 12px;">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <span class="gw-h4">Detection Categories (20 Built-in)</span>
        <div style="display: flex; gap: 6px;">
          <button id="dp-select-all" class="gw-btn gw-btn--ghost gw-btn--sm">Select All</button>
          <button id="dp-select-none" class="gw-btn gw-btn--ghost gw-btn--sm">Clear All</button>
        </div>
      </div>

      <div id="dp-categories-list" style="display: flex; flex-direction: column; gap: 8px;">
        <!-- Category rows populated dynamically -->
      </div>
    </div>

    <!-- Masking & Redaction Defaults -->
    <div class="gw-card" style="display: flex; flex-direction: column; gap: 12px;">
      <span class="gw-h4">Visual Masking Defaults</span>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
        <div>
          <label style="font-size: 12px; color: var(--gw-text-secondary); display: block; margin-bottom: 4px;">Edge Padding (px)</label>
          <input type="number" id="dp-mask-padding" min="0" max="20" value="4" style="background: var(--gw-bg-inset); color: var(--gw-text-primary); border: 1px solid var(--gw-border-base); border-radius: 4px; padding: 6px 10px; width: 100%; font-family: var(--gw-font-mono);" />
        </div>
        <div>
          <label style="font-size: 12px; color: var(--gw-text-secondary); display: block; margin-bottom: 4px;">Overlay Style</label>
          <select id="dp-mask-style" style="background: var(--gw-bg-inset); color: var(--gw-text-primary); border: 1px solid var(--gw-border-base); border-radius: 4px; padding: 6px 10px; width: 100%;">
            <option value="blackout">Blackout (Solid Black)</option>
            <option value="whiteout">Whiteout (Solid White)</option>
            <option value="stamp">Text Stamp ([REDACTED])</option>
          </select>
        </div>
      </div>
    </div>

    <!-- Non-Certification Legal Disclaimer -->
    <div class="gw-card" style="background: rgba(148, 163, 184, 0.04); border-color: var(--gw-border-subtle); padding: 12px;">
      <span style="font-size: 11px; color: var(--gw-text-muted); line-height: 1.4; display: block;">
        <strong>Legal Disclosure:</strong> Compliance presets (HIPAA, PCI DSS, GDPR, etc.) represent pattern groupings aligned with regulatory data definitions. Selection of a preset assists with technical data handling but does not constitute legal compliance certification or warranty.
      </span>
    </div>
  `;

  let currentProfile: DetectionProfile;

  const presetContainer = container.querySelector("#dp-preset-pills") as HTMLElement;
  const categoriesList = container.querySelector("#dp-categories-list") as HTMLElement;
  const paddingInput = container.querySelector("#dp-mask-padding") as HTMLInputElement;
  const styleSelect = container.querySelector("#dp-mask-style") as HTMLSelectElement;
  const saveBtn = container.querySelector("#dp-btn-save") as HTMLButtonElement;

  void adapters.settings.getProfile().then((profile) => {
    currentProfile = profile;
    paddingInput.value = String(profile.maskPadding);
    styleSelect.value = profile.defaultRedactionStyle;
    renderPresets();
    renderCategories();
  });

  function renderPresets() {
    presetContainer.innerHTML = "";

    const allPresets: { id: CompliancePresetId; label: string }[] = [
      { id: "custom", label: "Custom" },
      ...Object.entries(PRESET_DEFINITIONS).map(([id, def]) => ({ id: id as CompliancePresetId, label: def.label })),
    ];

    allPresets.forEach((p) => {
      const btn = document.createElement("button");
      btn.className = `gw-btn gw-btn--sm ${currentProfile.activePreset === p.id ? "gw-btn--primary" : "gw-btn--ghost"}`;
      btn.textContent = p.label;
      btn.addEventListener("click", () => {
        currentProfile.activePreset = p.id;
        if (p.id !== "custom") {
          currentProfile.enabledCategories = [...PRESET_DEFINITIONS[p.id].categories];
        }
        renderPresets();
        renderCategories();
      });
      presetContainer.appendChild(btn);
    });
  }

  function renderCategories() {
    categoriesList.innerHTML = "";

    ALL_CATEGORIES.forEach((cat) => {
      const row = document.createElement("div");
      row.style.cssText = "display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; background: var(--gw-bg-inset); border: 1px solid var(--gw-border-subtle); border-radius: 6px;";

      const isEnabled = currentProfile.enabledCategories.includes(cat.id);
      const conf = currentProfile.confidenceThresholds[cat.id] ?? 0.85;

      row.innerHTML = `
        <div style="display: flex; align-items: center; gap: 10px; flex: 1;">
          <input type="checkbox" class="dp-cat-toggle" data-cat="${cat.id}" ${isEnabled ? "checked" : ""} style="cursor: pointer;" />
          <div>
            <strong style="font-size: 13px; color: var(--gw-text-primary); display: block;">${cat.label}</strong>
            <span style="font-size: 11px; color: var(--gw-text-muted);">${cat.desc}</span>
          </div>
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 11px; font-family: var(--gw-font-mono); color: var(--gw-text-secondary);">CONF: ${Math.round(conf * 100)}%</span>
        </div>
      `;

      const toggle = row.querySelector(".dp-cat-toggle") as HTMLInputElement;
      toggle.addEventListener("change", () => {
        if (toggle.checked) {
          if (!currentProfile.enabledCategories.includes(cat.id)) currentProfile.enabledCategories.push(cat.id);
        } else {
          currentProfile.enabledCategories = currentProfile.enabledCategories.filter((c) => c !== cat.id);
        }
        currentProfile.activePreset = "custom";
        renderPresets();
      });

      categoriesList.appendChild(row);
    });
  }

  container.querySelector("#dp-select-all")?.addEventListener("click", () => {
    currentProfile.enabledCategories = ALL_CATEGORIES.map((c) => c.id);
    currentProfile.activePreset = "custom";
    renderPresets();
    renderCategories();
  });

  container.querySelector("#dp-select-none")?.addEventListener("click", () => {
    currentProfile.enabledCategories = [];
    currentProfile.activePreset = "custom";
    renderPresets();
    renderCategories();
  });

  saveBtn.addEventListener("click", async () => {
    currentProfile.maskPadding = parseInt(paddingInput.value, 10) || 4;
    currentProfile.defaultRedactionStyle = styleSelect.value as "blackout" | "whiteout" | "stamp";
    await adapters.settings.updateProfile(currentProfile);
    saveBtn.textContent = "✓ Saved";
    setTimeout(() => { saveBtn.textContent = "💾 Save Profile"; }, 1500);
  });

  return container;
}
