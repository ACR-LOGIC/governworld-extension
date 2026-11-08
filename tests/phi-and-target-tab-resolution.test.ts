// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, expect, it, beforeAll } from "vitest";
import { detect } from "../src/content/detect.js";
import { isExcludedElement } from "../src/content/extract.js";
import { validateMessage } from "../src/shared/messages.js";
import { evaluateComplianceScore } from "../src/shared/complianceScore.js";
import { classifyDestination } from "../src/shared/destinationClassifier.js";

type Tab = { id?: number; url?: string; active?: boolean };
const tab = (id: number, url: string, active = false): Tab => ({ id, url, active });

let tabs: Tab[] = [];

(globalThis as unknown as { chrome: unknown }).chrome = {
  runtime: {
    id: "test",
    onMessage: { addListener: () => undefined },
    onConnect: { addListener: () => undefined },
    onStartup: { addListener: () => undefined },
    onInstalled: { addListener: () => undefined },
    sendMessage: async () => undefined,
    connect: () => ({
      onMessage: { addListener: () => undefined },
      onDisconnect: { addListener: () => undefined },
      postMessage: () => undefined,
    }),
    getURL: (path: string) => `chrome-extension://test/${path}`,
  },
  storage: {
    session: {
      get: async () => ({}),
      set: async () => undefined,
      remove: async () => undefined,
    },
    local: {
      get: async () => ({}),
      set: async () => undefined,
      remove: async () => undefined,
    },
  },
  tabs: {
    query: async (q: { active?: boolean; lastFocusedWindow?: boolean; currentWindow?: boolean }) =>
      tabs.filter((t) => (q.active === undefined ? true : t.active === q.active)),
    get: async (tabId: number) => tabs.find((t) => t.id === tabId),
    sendMessage: async () => undefined,
    onRemoved: { addListener: () => undefined },
    onUpdated: { addListener: () => undefined },
  },
  scripting: { executeScript: async () => undefined },
  commands: { onCommand: { addListener: () => undefined } },
  offscreen: { closeDocument: async () => undefined, createDocument: async () => undefined },
  downloads: { download: async () => undefined },
  windows: { onFocusChanged: { addListener: () => undefined } },
  sidePanel: { setPanelBehavior: async () => undefined },
  contextMenus: { create: () => undefined, onClicked: { addListener: () => undefined } },
};

let resolveTargetTab: (explicitTabId?: number) => Promise<unknown>;
let isInternalExtensionUrl: (url?: string) => boolean;

beforeAll(async () => {
  const worker = await import("../src/service-worker/index.js");
  resolveTargetTab = worker.resolveTargetTab as (explicitTabId?: number) => Promise<unknown>;
  isInternalExtensionUrl = worker.isInternalExtensionUrl;
});

describe("resolveTargetTab & extension URL guarding", () => {
  it("recognizes internal extension URLs across Chromium, Firefox, and Safari", () => {
    expect(isInternalExtensionUrl("chrome-extension://abcdef/popup.html")).toBe(true);
    expect(isInternalExtensionUrl("moz-extension://abcdef/sidepanel.html")).toBe(true);
    expect(isInternalExtensionUrl("safari-web-extension://abcdef/review.html")).toBe(true);
    expect(isInternalExtensionUrl("chrome://settings")).toBe(true);
    expect(isInternalExtensionUrl("edge://extensions")).toBe(true);
    expect(isInternalExtensionUrl("about:blank")).toBe(true);
    expect(isInternalExtensionUrl("https://ehr.clinic.org/patient/123")).toBe(false);
  });

  it("resolves explicit tabId when it points to an ordinary scannable web page", async () => {
    tabs = [
      tab(10, "chrome-extension://abcdef/popup.html", true),
      tab(20, "https://hospital.org/chart", false),
    ];
    const resolved = (await resolveTargetTab(20)) as Tab | undefined;
    expect(resolved?.id).toBe(20);
    expect(resolved?.url).toBe("https://hospital.org/chart");
  });

  it("rejects explicit tabId if pointing to an internal extension URL and falls back to scannable tab", async () => {
    tabs = [
      tab(10, "chrome-extension://abcdef/popup.html", false),
      tab(20, "https://hospital.org/chart", true),
    ];
    const resolved = (await resolveTargetTab(10)) as Tab | undefined;
    expect(resolved?.id).toBe(20);
  });
});

describe("POPUP_SCAN message contract with tabId", () => {
  it("validates and preserves optional tabId", () => {
    const res = validateMessage({ type: "POPUP_SCAN", requestId: "req-1", mode: "local", tabId: 42 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.message as { tabId?: number }).tabId).toBe(42);
    }
  });

  it("rejects invalid tabId", () => {
    const res = validateMessage({ type: "POPUP_SCAN", requestId: "req-1", mode: "local", tabId: -5 });
    expect(res.ok).toBe(false);

    const res2 = validateMessage({ type: "POPUP_SCAN", requestId: "req-1", mode: "local", tabId: "42" });
    expect(res2.ok).toBe(false);
  });
});

describe("Injected DOM element exclusion", () => {
  it("excludes GovernWorld toast hosts and paste-guard shields from text extraction", () => {
    const fakeToastHost = {
      closest: (sel: string) => sel.includes("data-gw-toast-host") ? true : null,
      getAttribute: (attr: string) => attr === "data-gw-toast-host" ? "true" : null,
      id: "",
    } as unknown as Element;
    expect(isExcludedElement(fakeToastHost)).toBe(true);

    const fakePasteGuardHost = {
      closest: (sel: string) => sel.includes("__governworld-") ? true : null,
      getAttribute: () => null,
      id: "__governworld-paste-guard-host",
    } as unknown as Element;
    expect(isExcludedElement(fakePasteGuardHost)).toBe(true);

    const fakeNormalElement = {
      closest: () => null,
      getAttribute: () => null,
      id: "patient-name-field",
    } as unknown as Element;
    expect(isExcludedElement(fakeNormalElement)).toBe(false);
  });
});

describe("Clinical PHI detection enhancements", () => {
  it("detects ICD-10 diagnosis codes labeled with clinical terms", () => {
    const text = "Diagnosis: E11.9 (Type 2 diabetes mellitus without complications)\nCondition: M54.5\nICD-10: J45.909";
    const matches = detect(text, ["medical_record_number"]);
    const values = matches.map((m) => m.value);
    expect(values).toContain("E11.9");
    expect(values).toContain("M54.5");
    expect(values).toContain("J45.909");
  });

  it("detects Chart Number and Patient ID as medical records / member identifiers", () => {
    const text = "Chart Number: 984512\nPatient ID: PID-10492\nChart #: 88219";
    const matches = detect(text, ["medical_record_number", "member_id"]);
    const values = matches.map((m) => m.value);
    expect(values).toContain("984512");
    expect(values).toContain("PID-10492");
    expect(values).toContain("88219");
  });

  it("detects Policy Number and Subscriber ID as member identifiers", () => {
    const text = "Policy Number: POL-554421\nSubscriber ID: SUB-99214\nInsurance ID: INS-77112";
    const matches = detect(text, ["member_id"]);
    const values = matches.map((m) => m.value);
    expect(values).toContain("POL-554421");
    expect(values).toContain("SUB-99214");
    expect(values).toContain("INS-77112");
  });

  it("detects Patient names separated by hyphens, tabs, or colons", () => {
    const text = "Patient - Jane Doe\nPatient Name:\tRobert Smith\nAttending Physician | Gregory House";
    const matches = detect(text, ["possible_name"]);
    const values = matches.map((m) => m.value);
    expect(values).toContain("Jane Doe");
    expect(values).toContain("Robert Smith");
    expect(values).toContain("Gregory House");
  });
  it("accurately detects all PHI in synthetic clinical SOAP notes and escalates risk score", () => {
    const text = `
Discharge Summary / Progress Note (Synthetic Example)
• Patient Name: [John Doe] (Synthetic)
• Medical Record Number (MRN): [SYN-9876543]
• Date of Encounter: [11/08/2026]
• Attending Physician: [Dr. Jane Smith, MD]

1. Subjective (S)
• Chief Complaint: Shortness of breath and productive cough for 4 days.
• History of Present Illness (HPI):
The patient is a [58-year-old male] who presents with a 4-day history of worsening dyspnea on exertion, low-grade fever (max 101.2°F), and a cough producing green sputum. He denies chest pain, hemoptysis, or recent travel. Reports mild fatigue but is oriented to person, place, and time.
• Past Medical History (PMH): Hypertension, Type 2 Diabetes Mellitus.
• Allergies: Penicillin (causes generalized rash).
• Medications: Lisinopril 10 mg daily, Metformin 500 mg BID.

2. Objective (O)
• Vital Signs:
• Blood Pressure: 132/84 mmHg
`;
    const matches = detect(text, [
      "email", "phone", "ssn", "dob", "medical_record_number", "member_id",
      "npi", "dea", "mbi", "address", "payment_card", "secrets", "possible_name"
    ]);

    const values = matches.map((m) => m.value);
    // 1. Patient Name & Physician Name
    expect(values).toContain("John Doe");
    expect(values).toContain("Dr. Jane Smith, MD");
    expect(values).not.toContain("Medical Record Number");

    // 2. MRN
    expect(values).toContain("SYN-9876543");

    // 3. Date of Encounter (HIPAA Safe Harbor Date)
    expect(values).toContain("11/08/2026");

    // 4. Diagnoses & PMH
    expect(values).toContain("Hypertension");
    expect(values).toContain("Type 2 Diabetes Mellitus");
    expect(values).toContain("Penicillin (causes generalized rash)");

    // 5. Medications
    expect(values).toContain("Lisinopril 10 mg daily");
    expect(values).toContain("Metformin 500 mg BID");

    // 6. Explainable Compliance Scorecard Verification
    const destination = classifyDestination("https://chat.openai.com");
    const evaluation = evaluateComplianceScore(
      matches.map((m) => ({
        category: m.entityType || m.category,
        confidence: m.confidence,
        value: m.value,
      })),
      destination,
      "paste"
    );

    // AI Leakage + Combined PHI triggers maximum score and BLOCK
    expect(evaluation.riskScore).toBe(100);
    expect(evaluation.riskBand).toBe("CRITICAL");
    expect(evaluation.decision).toBe("BLOCK");
    expect(evaluation.factors.aiLeakageTriggered).toBe(true);
    expect(evaluation.factors.appliedRules).toContain("MRN + DOB + Diagnosis");
    expect(evaluation.factors.appliedRules).toContain("Patient Name + MRN");
    expect(evaluation.factors.appliedRules).toContain("Patient Name + DOB");
  });
});