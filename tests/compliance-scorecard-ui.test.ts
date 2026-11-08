// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import { evaluateComplianceScore } from "../src/shared/complianceScore.js";
import { classifyDestination } from "../src/shared/destinationClassifier.js";

describe("Explainable Compliance Scorecard UI Component", () => {
  let doc: Document;
  let card: HTMLElement;
  let scoreEl: HTMLElement;
  let bandEl: HTMLElement;
  let actionEl: HTMLElement;
  let reasonEl: HTMLElement;
  let rulesEl: HTMLElement;

  function renderCard(
    findings: Array<{ category: string; confidence?: number; preview?: string; count?: number }>,
    url?: string,
    action: "view" | "download" | "paste" = "view"
  ) {
    if (!findings || findings.length === 0) {
      card.hidden = true;
      return;
    }
    const destination = classifyDestination(url);
    const evaluation = evaluateComplianceScore(
      findings.map((f) => ({ category: f.category, confidence: f.confidence, value: f.preview })),
      destination,
      action
    );

    card.hidden = false;
    scoreEl.textContent = String(evaluation.riskScore);

    bandEl.textContent = evaluation.riskBand;
    bandEl.className = "compliance-card__band";
    if (evaluation.riskBand === "CRITICAL") {
      bandEl.classList.add("compliance-card__band--critical");
    } else if (evaluation.riskBand === "HIGH") {
      bandEl.classList.add("compliance-card__band--high");
    } else if (evaluation.riskBand === "MEDIUM") {
      bandEl.classList.add("compliance-card__band--medium");
    } else if (evaluation.riskBand === "LOW") {
      bandEl.classList.add("compliance-card__band--low");
    } else {
      bandEl.classList.add("compliance-card__band--informational");
    }

    actionEl.textContent = `Action: ${evaluation.decision}`;
    reasonEl.textContent = evaluation.reason;

    rulesEl.replaceChildren();
    for (const rule of evaluation.factors.appliedRules) {
      const pill = doc.createElement("span");
      pill.className = "compliance-card__rule-pill";
      pill.textContent = rule;
      rulesEl.appendChild(pill);
    }
    if (evaluation.factors.aiLeakageTriggered) {
      const pill = doc.createElement("span");
      pill.className = "compliance-card__rule-pill";
      pill.textContent = "AI Leakage Rule";
      rulesEl.appendChild(pill);
    }
    if (destination.isAi) {
      const pill = doc.createElement("span");
      pill.className = "compliance-card__rule-pill";
      pill.textContent = `AI: ${destination.serviceName || destination.hostname}`;
      rulesEl.appendChild(pill);
    } else if (destination.category === "TRUSTED_INTERNAL") {
      const pill = doc.createElement("span");
      pill.className = "compliance-card__rule-pill";
      pill.textContent = `EHR: ${destination.serviceName || destination.hostname}`;
      rulesEl.appendChild(pill);
    }
  }

  beforeEach(() => {
    const win = new Window({ url: "https://example.com" });
    doc = win.document as unknown as Document;

    card = doc.createElement("div");
    card.id = "scan-compliance-card";
    card.className = "compliance-card";
    card.hidden = true;

    scoreEl = doc.createElement("span");
    scoreEl.id = "scan-compliance-score";
    scoreEl.className = "compliance-card__score";

    bandEl = doc.createElement("span");
    bandEl.id = "scan-compliance-band";
    bandEl.className = "compliance-card__band";

    actionEl = doc.createElement("span");
    actionEl.id = "scan-compliance-action";
    actionEl.className = "compliance-card__action";

    reasonEl = doc.createElement("p");
    reasonEl.id = "scan-compliance-reason";
    reasonEl.className = "compliance-card__reason";

    rulesEl = doc.createElement("div");
    rulesEl.id = "scan-compliance-rules";
    rulesEl.className = "compliance-card__rules";

    card.append(scoreEl, bandEl, actionEl, reasonEl, rulesEl);
    doc.body.appendChild(card);
  });

  it("remains hidden when there are zero findings", () => {
    renderCard([], "https://example.com");
    expect(card.hidden).toBe(true);
  });

  it("renders INFORMATIONAL risk card for single email on unknown site", () => {
    renderCard([{ category: "email", confidence: 0.95, preview: "test@example.com" }], "https://example.com");

    expect(card.hidden).toBe(false);
    expect(Number(scoreEl.textContent)).toBe(15);
    expect(bandEl.textContent).toBe("INFORMATIONAL");
    expect(bandEl.classList.contains("compliance-card__band--informational")).toBe(true);
    expect(actionEl.textContent).toBe("Action: LOG");
    expect(reasonEl.textContent).toContain("Email");
  });

  it("renders LOW risk card for address and phone on unknown site", () => {
    renderCard(
      [
        { category: "address", confidence: 0.9, preview: "123 Main St" },
        { category: "phone", confidence: 0.9, preview: "555-123-4567" },
      ],
      "https://example.com"
    );

    expect(card.hidden).toBe(false);
    expect(Number(scoreEl.textContent)).toBeGreaterThanOrEqual(25);
    expect(Number(scoreEl.textContent)).toBeLessThan(50);
    expect(bandEl.textContent).toBe("LOW");
    expect(bandEl.classList.contains("compliance-card__band--low")).toBe(true);
    expect(actionEl.textContent).toBe("Action: ALLOW");
  });

  it("renders CRITICAL risk card and rule tags for Patient Name + MRN + DOB on External AI site", () => {
    renderCard(
      [
        { category: "possible_name", confidence: 0.95, preview: "John Smith" },
        { category: "medical_record_number", confidence: 0.98, preview: "MRN-98421" },
        { category: "dob", confidence: 0.9, preview: "1984-05-12" },
      ],
      "https://chatgpt.com/c/patient-notes",
      "view"
    );

    expect(card.hidden).toBe(false);
    expect(Number(scoreEl.textContent)).toBeGreaterThanOrEqual(90);
    expect(bandEl.textContent).toBe("CRITICAL");
    expect(bandEl.classList.contains("compliance-card__band--critical")).toBe(true);
    expect(actionEl.textContent).toBe("Action: BLOCK");
    expect(reasonEl.textContent).toContain("Blocked because");

    const pills = Array.from(rulesEl.querySelectorAll(".compliance-card__rule-pill")).map((p) => p.textContent);
    expect(pills.some((p) => p?.includes("Patient Name + MRN"))).toBe(true);
    expect(pills.some((p) => p?.includes("AI: ChatGPT"))).toBe(true);
  });

  it("renders EHR portal badge for healthcare internal domains", () => {
    renderCard(
      [
        { category: "medical_record_number", confidence: 0.95, preview: "MRN-12345" },
        { category: "dob", confidence: 0.9, preview: "1990-01-01" },
      ],
      "https://ehr.epic.com/records",
      "view"
    );

    expect(card.hidden).toBe(false);
    const pills = Array.from(rulesEl.querySelectorAll(".compliance-card__rule-pill")).map((p) => p.textContent);
    expect(pills.some((p) => p?.includes("EHR"))).toBe(true);
  });

  it("renders Document Studio compliance evaluation with action=download", () => {
    renderCard(
      [
        { category: "ssn", confidence: 0.99, preview: "123-45-6789" },
        { category: "payment_card", confidence: 0.95, preview: "4111-2222-3333-4444" },
      ],
      undefined,
      "download"
    );

    expect(card.hidden).toBe(false);
    expect(Number(scoreEl.textContent)).toBeGreaterThanOrEqual(70);
    expect(bandEl.textContent).toMatch(/HIGH|CRITICAL/);
    expect(actionEl.textContent).toMatch(/Action: (MASK|BLOCK)/);
  });
});
