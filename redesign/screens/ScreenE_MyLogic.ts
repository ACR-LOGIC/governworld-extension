// Copyright (c) 2026 Andres Chavez Ramirez / ACR LOGIC. All rights reserved.
/**
 * SCREEN E — My Logic
 *
 * Custom detection-rule management and 4-stage creation wizard:
 * 1. Examples (Positive & Negative samples)
 * 2. Proposals (Generated regex pattern candidates with confidence)
 * 3. Refine (Interactive live tester with matches feedback)
 * 4. Save (Integration into shared detection engine + local-only vs community consent)
 */

import type { IBackendAdapters } from "../adapters/contracts.js";
import type { CustomLogicRule, ScreenId } from "../types/index.js";

export function renderScreenE_MyLogic(
  adapters: IBackendAdapters,
  _onNavigate: (screen: ScreenId) => void
): HTMLElement {
  const container = document.createElement("div");
  container.className = "gw-screen-mylogic";
  container.style.cssText = "display: flex; flex-direction: column; gap: 16px; width: 100%; max-width: 780px; margin: 0 auto;";

  container.innerHTML = `
    <!-- Top Bar -->
    <div style="display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1px solid var(--gw-border-subtle); padding-bottom: 12px;">
      <div>
        <h2 class="gw-h2" style="display: flex; align-items: center; gap: 8px;">
          <span>My Logic & Custom Rules</span>
          <span class="gw-badge gw-badge--medium">REGEX ENGINE</span>
        </h2>
        <span class="gw-caption">Design custom proprietary detection patterns that integrate directly into the shared engine.</span>
      </div>
      <button id="ml-btn-new-rule" class="gw-btn gw-btn--primary gw-btn--sm">+ Create Rule</button>
    </div>

    <!-- 4-Stage Wizard Container (Hidden by default, shown on "+ Create Rule") -->
    <div id="ml-wizard-card" class="gw-card gw-card--glass" style="display: none; flex-direction: column; gap: 14px; border-color: var(--gw-primary-light);">
      <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--gw-border-subtle); padding-bottom: 8px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <strong style="font-size: 13px; color: var(--gw-primary-light);" id="ml-wizard-step-title">Stage 1: Input Examples</strong>
          <span class="gw-badge" id="ml-wizard-step-badge">Step 1 of 4</span>
        </div>
        <button id="ml-wizard-cancel" class="gw-btn gw-btn--ghost gw-btn--sm">Cancel</button>
      </div>

      <!-- Step 1: Examples -->
      <div id="ml-step-1" class="ml-wizard-step" style="display: flex; flex-direction: column; gap: 10px;">
        <div>
          <label style="font-size: 12px; color: var(--gw-text-secondary); display: block; margin-bottom: 4px;">Positive Examples (Things to detect, one per line):</label>
          <textarea id="ml-pos-input" rows="3" style="width: 100%; background: var(--gw-bg-inset); color: var(--gw-text-primary); border: 1px solid var(--gw-border-base); border-radius: 4px; padding: 8px; font-family: var(--gw-font-mono); font-size: 12px;">EMP-48201-US\nEMP-91823-CA</textarea>
        </div>
        <div>
          <label style="font-size: 12px; color: var(--gw-text-secondary); display: block; margin-bottom: 4px;">Negative Examples (Things to IGNORE, one per line):</label>
          <textarea id="ml-neg-input" rows="2" style="width: 100%; background: var(--gw-bg-inset); color: var(--gw-text-primary); border: 1px solid var(--gw-border-base); border-radius: 4px; padding: 8px; font-family: var(--gw-font-mono); font-size: 12px;">EMP-123\nemp-48201</textarea>
        </div>
        <div style="display: flex; justify-content: flex-end;">
          <button id="ml-btn-to-step2" class="gw-btn gw-btn--primary gw-btn--sm">Analyze & Generate Proposals →</button>
        </div>
      </div>

      <!-- Step 2: Proposals -->
      <div id="ml-step-2" class="ml-wizard-step" style="display: none; flex-direction: column; gap: 10px;">
        <span class="gw-caption">Select a proposed regex pattern candidate generated from your examples:</span>
        <div id="ml-proposals-container" style="display: flex; flex-direction: column; gap: 8px;">
          <!-- Dynamically populated -->
        </div>
        <div style="display: flex; justify-content: space-between;">
          <button id="ml-btn-back-to-step1" class="gw-btn gw-btn--ghost gw-btn--sm">← Back</button>
          <button id="ml-btn-to-step3" class="gw-btn gw-btn--primary gw-btn--sm">Refine & Test Pattern →</button>
        </div>
      </div>

      <!-- Step 3: Refine -->
      <div id="ml-step-3" class="ml-wizard-step" style="display: none; flex-direction: column; gap: 10px;">
        <div>
          <label style="font-size: 12px; color: var(--gw-text-secondary); display: block; margin-bottom: 4px;">Pattern Regex & Flags:</label>
          <div style="display: flex; gap: 6px;">
            <input type="text" id="ml-pattern-input" value="\\bEMP-[0-9]{5}-[A-Z]{2}\\b" style="flex: 1; background: var(--gw-bg-inset); color: #60a5fa; border: 1px solid var(--gw-border-base); border-radius: 4px; padding: 6px 10px; font-family: var(--gw-font-mono); font-size: 12px;" />
            <input type="text" id="ml-flags-input" value="g" style="width: 50px; background: var(--gw-bg-inset); color: var(--gw-text-primary); border: 1px solid var(--gw-border-base); border-radius: 4px; padding: 6px; font-family: var(--gw-font-mono); font-size: 12px; text-align: center;" />
          </div>
        </div>

        <div>
          <label style="font-size: 12px; color: var(--gw-text-secondary); display: block; margin-bottom: 4px;">Live Test Sample:</label>
          <textarea id="ml-sample-input" rows="3" style="width: 100%; background: var(--gw-bg-inset); color: var(--gw-text-primary); border: 1px solid var(--gw-border-base); border-radius: 4px; padding: 8px; font-family: var(--gw-font-mono); font-size: 12px;">Staff member assigned EMP-48201-US with badge ID EMP-91823-CA, not EMP-123.</textarea>
        </div>

        <div style="display: flex; align-items: center; justify-content: space-between; padding: 8px; background: var(--gw-bg-surface-elevated); border-radius: 6px;">
          <span style="font-size: 12px;">Test Feedback:</span>
          <span id="ml-test-result-badge" class="gw-badge gw-badge--operational">2 Matches Found</span>
        </div>

        <div style="display: flex; justify-content: space-between;">
          <button id="ml-btn-back-to-step2" class="gw-btn gw-btn--ghost gw-btn--sm">← Back</button>
          <button id="ml-btn-to-step4" class="gw-btn gw-btn--primary gw-btn--sm">Proceed to Save →</button>
        </div>
      </div>

      <!-- Step 4: Save -->
      <div id="ml-step-4" class="ml-wizard-step" style="display: none; flex-direction: column; gap: 10px;">
        <div>
          <label style="font-size: 12px; color: var(--gw-text-secondary); display: block; margin-bottom: 4px;">Rule Display Name:</label>
          <input type="text" id="ml-rule-name-input" value="Employee ID Badge Rule" style="width: 100%; background: var(--gw-bg-inset); color: var(--gw-text-primary); border: 1px solid var(--gw-border-base); border-radius: 4px; padding: 6px 10px; font-size: 12px;" />
        </div>

        <div>
          <label style="font-size: 12px; color: var(--gw-text-secondary); display: block; margin-bottom: 4px;">Associated Category:</label>
          <select id="ml-rule-category-select" style="width: 100%; background: var(--gw-bg-inset); color: var(--gw-text-primary); border: 1px solid var(--gw-border-base); border-radius: 4px; padding: 6px 10px; font-size: 12px;">
            <option value="custom">Custom Internal Pattern</option>
            <option value="secrets">Secrets & Credentials</option>
            <option value="member_id">Member Identification</option>
          </select>
        </div>

        <div class="gw-card" style="padding: 10px; background: rgba(148, 163, 184, 0.04); border-color: var(--gw-border-subtle);">
          <label style="display: flex; align-items: flex-start; gap: 8px; font-size: 11px; cursor: pointer;">
            <input type="checkbox" id="ml-consent-toggle" checked style="margin-top: 2px;" />
            <span style="color: var(--gw-text-secondary);">
              <strong>Keep strictly local on device (Recommended).</strong> Rule patterns will never be uploaded to any central server.
            </span>
          </label>
        </div>

        <div style="display: flex; justify-content: space-between;">
          <button id="ml-btn-back-to-step3" class="gw-btn gw-btn--ghost gw-btn--sm">← Back</button>
          <button id="ml-btn-save-final" class="gw-btn gw-btn--emerald gw-btn--sm">💾 Commit Rule to Shared Engine</button>
        </div>
      </div>
    </div>

    <!-- Active Rules List -->
    <div class="gw-card" style="padding: 14px; display: flex; flex-direction: column; gap: 10px;">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <span class="gw-h4">Configured Custom Rules</span>
        <span class="gw-caption" id="ml-rules-count">2 Active</span>
      </div>
      <div id="ml-rules-list" style="display: flex; flex-direction: column; gap: 8px;">
        <!-- Dynamically rendered -->
      </div>
    </div>
  `;

  // Wizard state & elements
  const wizardCard = container.querySelector("#ml-wizard-card") as HTMLElement;
  const newRuleBtn = container.querySelector("#ml-btn-new-rule") as HTMLButtonElement;
  const cancelBtn = container.querySelector("#ml-wizard-cancel") as HTMLButtonElement;
  const rulesListEl = container.querySelector("#ml-rules-list") as HTMLElement;

  const step1 = container.querySelector("#ml-step-1") as HTMLElement;
  const step2 = container.querySelector("#ml-step-2") as HTMLElement;
  const step3 = container.querySelector("#ml-step-3") as HTMLElement;
  const step4 = container.querySelector("#ml-step-4") as HTMLElement;

  const stepTitle = container.querySelector("#ml-wizard-step-title") as HTMLElement;
  const stepBadge = container.querySelector("#ml-wizard-step-badge") as HTMLElement;

  const showStep = (stepNumber: 1 | 2 | 3 | 4) => {
    step1.style.display = stepNumber === 1 ? "flex" : "none";
    step2.style.display = stepNumber === 2 ? "flex" : "none";
    step3.style.display = stepNumber === 3 ? "flex" : "none";
    step4.style.display = stepNumber === 4 ? "flex" : "none";

    stepBadge.textContent = `Step ${stepNumber} of 4`;
    if (stepNumber === 1) stepTitle.textContent = "Stage 1: Input Examples";
    if (stepNumber === 2) stepTitle.textContent = "Stage 2: Proposal Candidates";
    if (stepNumber === 3) stepTitle.textContent = "Stage 3: Refine & Live Test";
    if (stepNumber === 4) stepTitle.textContent = "Stage 4: Commit & Save Rule";
  };

  newRuleBtn.addEventListener("click", () => {
    wizardCard.style.display = "flex";
    showStep(1);
  });

  cancelBtn.addEventListener("click", () => {
    wizardCard.style.display = "none";
  });

  // Step 1 -> 2
  container.querySelector("#ml-btn-to-step2")?.addEventListener("click", async () => {
    const pos = (container.querySelector("#ml-pos-input") as HTMLTextAreaElement).value.split("\n").filter(Boolean);
    const neg = (container.querySelector("#ml-neg-input") as HTMLTextAreaElement).value.split("\n").filter(Boolean);
    const result = await adapters.logic.analyzeExamples(pos, neg);

    const propContainer = container.querySelector("#ml-proposals-container") as HTMLElement;
    propContainer.innerHTML = "";

    result.proposals.forEach((prop, i) => {
      const card = document.createElement("div");
      card.style.cssText = `padding: 10px; background: var(--gw-bg-inset); border: 1px solid ${i === 0 ? "var(--gw-primary)" : "var(--gw-border-subtle)"}; border-radius: 6px; cursor: pointer;`;
      card.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <code class="gw-code" style="color: #60a5fa;">/${prop.pattern}/${prop.flags}</code>
          <span class="gw-badge gw-badge--operational">${Math.round(prop.confidence * 100)}% Match</span>
        </div>
        <div class="gw-caption" style="margin-top: 4px;">${prop.rationale}</div>
      `;
      card.addEventListener("click", () => {
        (container.querySelector("#ml-pattern-input") as HTMLInputElement).value = prop.pattern;
        (container.querySelector("#ml-flags-input") as HTMLInputElement).value = prop.flags;
        showStep(3);
      });
      propContainer.appendChild(card);
    });

    showStep(2);
  });

  // Step transitions
  container.querySelector("#ml-btn-back-to-step1")?.addEventListener("click", () => showStep(1));
  container.querySelector("#ml-btn-to-step3")?.addEventListener("click", () => showStep(3));
  container.querySelector("#ml-btn-back-to-step2")?.addEventListener("click", () => showStep(2));
  container.querySelector("#ml-btn-to-step4")?.addEventListener("click", () => showStep(4));
  container.querySelector("#ml-btn-back-to-step3")?.addEventListener("click", () => showStep(3));

  // Live pattern test in step 3
  const patternInput = container.querySelector("#ml-pattern-input") as HTMLInputElement;
  const flagsInput = container.querySelector("#ml-flags-input") as HTMLInputElement;
  const sampleInput = container.querySelector("#ml-sample-input") as HTMLTextAreaElement;
  const testBadge = container.querySelector("#ml-test-result-badge") as HTMLElement;

  const runTest = async () => {
    const res = await adapters.logic.testPattern(patternInput.value, flagsInput.value, sampleInput.value);
    testBadge.textContent = `${res.matches} Match${res.matches === 1 ? "" : "es"} Found`;
    testBadge.className = res.matches > 0 ? "gw-badge gw-badge--operational" : "gw-badge gw-badge--critical";
  };

  patternInput.addEventListener("input", runTest);
  flagsInput.addEventListener("input", runTest);
  sampleInput.addEventListener("input", runTest);

  // Step 4 Save
  container.querySelector("#ml-btn-save-final")?.addEventListener("click", async () => {
    const name = (container.querySelector("#ml-rule-name-input") as HTMLInputElement).value;
    const category = (container.querySelector("#ml-rule-category-select") as HTMLSelectElement).value;

    await adapters.logic.createRule({
      name,
      category,
      pattern: patternInput.value,
      flags: flagsInput.value,
      confidence: 0.95,
      positiveExamples: [],
      negativeExamples: [],
      enabled: true,
      source: "local",
      contributionConsent: false,
    });

    wizardCard.style.display = "none";
    await loadRules();
  });

  // Load rules list
  const loadRules = async () => {
    const rules = await adapters.logic.listRules();
    (container.querySelector("#ml-rules-count") as HTMLElement).textContent = `${rules.length} Active`;
    rulesListEl.innerHTML = "";

    rules.forEach((r) => {
      const card = document.createElement("div");
      card.style.cssText = "display: flex; align-items: center; justify-content: space-between; padding: 10px; background: var(--gw-bg-inset); border: 1px solid var(--gw-border-subtle); border-radius: 6px;";
      card.innerHTML = `
        <div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <strong style="font-size: 13px;">${r.name}</strong>
            <span class="gw-badge gw-badge--sm">${r.category}</span>
          </div>
          <code class="gw-code" style="color: #60a5fa; margin-top: 4px; display: inline-block;">/${r.pattern}/${r.flags}</code>
        </div>
        <div style="display: flex; gap: 6px;">
          <button class="gw-btn gw-btn--ghost gw-btn--sm btn-delete-rule" data-id="${r.id}">Delete</button>
        </div>
      `;
      card.querySelector(".btn-delete-rule")?.addEventListener("click", async () => {
        await adapters.logic.deleteRule(r.id);
        await loadRules();
      });
      rulesListEl.appendChild(card);
    });
  };

  void loadRules();

  return container;
}
