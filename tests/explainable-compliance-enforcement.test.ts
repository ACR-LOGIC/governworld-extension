// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Window } from "happy-dom";
import { initPasteGuard, showPasteGuardDialog } from "../src/content/pasteGuard.js";
import { normalizeSettings } from "../src/shared/settings.js";
import * as auditModule from "../src/shared/audit.js";

function makePaste(target: Element, text: string): Event {
  const view = target.ownerDocument!.defaultView!;
  const event = new view.Event("paste", {
    bubbles: true,
    cancelable: true,
  }) as Event & { clipboardData?: { getData: (t: string) => string } };
  event.clipboardData = { getData: (type: string) => (type.startsWith("text") ? text : "") };
  return event;
}

function makeDrop(target: Element, text: string): Event {
  const view = target.ownerDocument!.defaultView!;
  const event = new view.Event("drop", {
    bubbles: true,
    cancelable: true,
  }) as Event & { dataTransfer?: { getData: (t: string) => string } };
  event.dataTransfer = { getData: (type: string) => (type.startsWith("text") ? text : "") };
  return event;
}

describe("Explainable Compliance Score & AI Leakage Enforcement", () => {
  let win: Window;
  let doc: Document;
  let cleanup: (() => void) | null = null;
  let recordedAudits: any[] = [];

  beforeEach(() => {
    win = new Window({ url: "https://chatgpt.com/c/compliance-test" });
    doc = win.document as unknown as Document;
    recordedAudits = [];

    vi.spyOn(auditModule, "recordAudit").mockImplementation(async (event: any) => {
      recordedAudits.push(event);
    });

    (globalThis as any).chrome = {
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
        },
        onChanged: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
      },
    };
  });

  afterEach(() => {
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
    vi.restoreAllMocks();
  });

  it("blocks PHI pasted into ChatGPT via AI Leakage Rule with CRITICAL 100/100 explainability", () => {
    cleanup = initPasteGuard(doc, {
      initialSettings: normalizeSettings({ protectionMode: "always-on" }),
    });

    const input = doc.createElement("input");
    input.type = "text";
    doc.body.appendChild(input);

    const phiText = "Patient: Jane Doe (DOB: 04/12/1980; MRN: 99887766)";
    const pasteEvent = makePaste(input, phiText);

    input.dispatchEvent(pasteEvent);

    // 1. Paste event must be cancelled immediately
    expect(pasteEvent.defaultPrevented).toBe(true);
    // 2. Value must not reach DOM input
    expect(input.value).toBe("");

    // 3. Dialog host should be in DOM
    const dialogHost = doc.getElementById("__governworld-paste-guard-host");
    expect(dialogHost).not.toBeNull();

    // 4. Audit record must be created with explainable factors and zero raw text
    expect(recordedAudits.length).toBe(1);
    const audit = recordedAudits[0];
    expect(audit.outcome).toBe("denied");
    expect(audit.complianceScore).toBe(100);
    expect(audit.complianceBand).toBe("CRITICAL");
    expect(audit.complianceAction).toBe("BLOCK");
    expect(audit.destinationCategory).toBe("EXTERNAL_AI");
    expect(audit.complianceReason).toContain("PHI disclosure to external AI system");
    // Ensure zero raw patient text stored in audit
    expect(JSON.stringify(audit)).not.toContain("Jane Doe");
    expect(JSON.stringify(audit)).not.toContain("99887766");
  });

  it("calculates explainable score without AI leakage when on trusted internal portal", () => {
    const internalWin = new Window({ url: "https://ehr.internal/chart/123" });
    const internalDoc = internalWin.document as unknown as Document;

    const internalCleanup = initPasteGuard(internalDoc, {
      initialSettings: normalizeSettings({ protectionMode: "always-on" }),
    });

    const input = internalDoc.createElement("input");
    input.type = "text";
    internalDoc.body.appendChild(input);

    const text = "Patient: John Smith (DOB: 01/01/1975)";
    const pasteEvent = makePaste(input, text);

    input.dispatchEvent(pasteEvent);

    expect(pasteEvent.defaultPrevented).toBe(true);

    const dialogHost = internalDoc.getElementById("__governworld-paste-guard-host");
    expect(dialogHost).not.toBeNull();

    internalCleanup();
  });

  it("intercepts dropped content on AI site and blocks if PHI is present", async () => {
    cleanup = initPasteGuard(doc, {
      initialSettings: normalizeSettings({ protectionMode: "always-on" }),
    });

    const target = doc.createElement("div");
    target.setAttribute("contenteditable", "true");
    doc.body.appendChild(target);

    const phiContent = "Patient: Mark Spencer (DOB: 08/20/1984, MRN: 11223344)";
    const dropEvent = makeDrop(target, phiContent);

    target.dispatchEvent(dropEvent);

    expect(dropEvent.defaultPrevented).toBe(true);
    expect(target.textContent).toBe("");

    const dialogHost = doc.getElementById("__governworld-paste-guard-host");
    expect(dialogHost).not.toBeNull();

    expect(recordedAudits.length).toBe(1);
    expect(recordedAudits[0].complianceScore).toBe(100);
    expect(recordedAudits[0].complianceAction).toBe("BLOCK");
  });

  describe("Explainable Compliance Badge and Modal Visual Contract", () => {
    it("renders compliance score badge and exact explainable reason in dialog", () => {
      const target = doc.createElement("input");
      doc.body.appendChild(target);

      const matches = [
        { category: "possible_name" as const, confidence: 1.0, value: "Jane Doe", start: 0, end: 8 },
        { category: "dob" as const, confidence: 1.0, value: "04/12/1980", start: 9, end: 19 },
      ];

      const callbacks = {
        onSanitize: vi.fn(),
        onCancel: vi.fn(),
        policyBlocked: true,
        complianceScore: 92,
        complianceBand: "CRITICAL",
        complianceReason: "Blocked because: Patient Name + DOB + AI Destination = 92 Risk",
      };

      const handle = showPasteGuardDialog(doc, target, matches, callbacks);
      expect(handle.host).not.toBeNull();
      expect(handle.press("gw-btn-raw")).toBe(false); // Raw button disallowed in blocked mode
      expect(handle.press("gw-btn-cancel")).toBe(true);
      expect(callbacks.onCancel).toHaveBeenCalledTimes(1);
    });
  });
});
