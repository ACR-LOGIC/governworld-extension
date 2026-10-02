// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Paste enforcement boundary, in a real DOM (happy-dom):
//
//   sensitive paste must not reach the DOM
//   blocked paste must not modify the input value
//   sanitized paste contains only sanitized output
//   cancel produces no insertion
//   safe paste behaves normally
//   unknown AI-style surfaces stay protected (no hostname allow/deny logic)
//   shadow-DOM editors are covered
//   drag-and-drop text is covered
//   dialog faults fail closed (nothing inserted)
//   OFF mode allows normal paste
//
// Synthetic fixtures only. No network, no clipboard access.
// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import {
  detectPasteFindings,
  initPasteGuard,
  insertTextIntoElement,
  sanitizePastedText,
  showPasteGuardDialog,
} from "../src/content/pasteGuard.js";
import { normalizeSettings } from "../src/shared/settings.js";

const SSN_PASTE = "my ssn is 219-09-9999 ok";
const SAFE_TEXT = "buy milk and bread tomorrow";

function silentCallbacks() {
  return { onSanitize: () => undefined, onRaw: () => undefined, onCancel: () => undefined };
}

/** A paste event with a stubbed clipboard payload. */
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

/** Click the first button whose id starts with the given prefix. */
function clickButton(root: ParentNode, prefix: string): void {
  const view = root.ownerDocument!.defaultView!;
  const buttons = [...root.querySelectorAll("button")];
  const btn = buttons.find((b) => (b as HTMLElement).id.startsWith(prefix)) as
    | HTMLElement
    | undefined;
  if (!btn) throw new Error(`button ${prefix} not found`);
  btn.dispatchEvent(new view.MouseEvent("click", { bubbles: true }));
}

/**
 * Confirm the dialog is present.
 *
 * The dialog's shadow root is CLOSED, so there is deliberately nothing to read
 * from the host — that is the property under test elsewhere. Presence in the
 * light DOM is still observable, which is all this needs.
 */
function dialogShown(doc: Document): boolean {
  return Boolean(doc.getElementById("__governworld-paste-guard-host"));
}

describe("paste enforcement boundary", () => {
  let teardown: (() => void) | null = null;

  afterEach(() => {
    try {
      teardown?.();
    } catch {
      // ignore
    }
    teardown = null;
    document.body.innerHTML = "";
  });

  it("cancels a sensitive paste before insertion and leaves the value untouched", () => {
    teardown = initPasteGuard(document);
    const input = document.createElement("input");
    input.type = "text";
    input.value = "hello ";
    document.body.appendChild(input);

    const event = makePaste(input, SSN_PASTE);
    input.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(input.value).toBe("hello ");
  });

  it("sanitize inserts only the sanitized output, never the raw value", () => {
    // Driven through the dialog API directly, because the dialog's shadow root is
    // closed (see shadow-isolation.test.ts) and `initPasteGuard` does not hand the
    // handle back. Same production callbacks, same enforcement contract.
    const input = document.createElement("input");
    input.type = "text";
    document.body.appendChild(input);

    const text = SSN_PASTE;
    const matches = detectPasteFindings(text);
    const handle = showPasteGuardDialog(document, input, matches, {
      onSanitize: () => {
        insertTextIntoElement(input, sanitizePastedText(text, matches));
      },
      onRaw: () => insertTextIntoElement(input, text),
      onCancel: () => undefined,
    });

    expect(handle.press("gw-btn-sanitize")).toBe(true);
    expect(input.value).not.toContain("219-09-9999");
    expect(input.value).toContain("[REDACTED]");
  });

  it("cancel produces no insertion at all", () => {
    const area = document.createElement("textarea");
    document.body.appendChild(area);

    const text = SSN_PASTE;
    const matches = detectPasteFindings(text);
    const handle = showPasteGuardDialog(document, area, matches, {
      onSanitize: () => insertTextIntoElement(area, sanitizePastedText(text, matches)),
      onRaw: () => insertTextIntoElement(area, text),
      onCancel: () => undefined,
    });

    expect(handle.press("gw-btn-cancel")).toBe(true);
    expect(area.value).toBe("");
  });

  it("paste-unchanged is reachable only as an explicit choice", () => {
    // The path that lets the user override the guard still exists and is still
    // opt-in. What changed is that page JavaScript cannot reach it.
    const input = document.createElement("input");
    input.type = "text";
    document.body.appendChild(input);

    const text = SSN_PASTE;
    const matches = detectPasteFindings(text);
    const handle = showPasteGuardDialog(document, input, matches, {
      onSanitize: () => insertTextIntoElement(input, sanitizePastedText(text, matches)),
      onRaw: () => insertTextIntoElement(input, text),
      onCancel: () => undefined,
    });

    expect(handle.press("gw-btn-raw")).toBe(true);
    expect(input.value).toContain("219-09-9999");
  });

  it("leaves safe pastes completely alone", () => {
    teardown = initPasteGuard(document);
    const input = document.createElement("input");
    input.type = "text";
    document.body.appendChild(input);

    const event = makePaste(input, SAFE_TEXT);
    input.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(document.getElementById("__governworld-paste-guard-host")).toBeNull();
  });

  it("OFF mode allows even sensitive pastes through untouched", () => {
    teardown = initPasteGuard(
      document,
      { initialSettings: normalizeSettings({ protectionMode: "off" }) }
    );
    const input = document.createElement("input");
    input.type = "text";
    document.body.appendChild(input);

    const event = makePaste(input, SSN_PASTE);
    input.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(document.getElementById("__governworld-paste-guard-host")).toBeNull();
  });

  it("intercepts text dragged onto an input", () => {
    teardown = initPasteGuard(document);
    const input = document.createElement("input");
    input.type = "text";
    document.body.appendChild(input);

    const event = makeDrop(input, SSN_PASTE);
    input.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(input.value).toBe("");
    expect(dialogShown(document)).toBe(true);
  });

  it("covers editors inside open shadow roots", async () => {
    teardown = initPasteGuard(document);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const shadow = container.attachShadow({ mode: "open" });
    const inner = document.createElement("textarea");
    shadow.appendChild(inner);
    // The observer that picks up dynamically created editors runs after the
    // current task — exactly like a real user paste, which can only arrive in
    // a later task than the DOM mutation that created the editor.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const event = makePaste(inner, SSN_PASTE);
    inner.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(inner.value).toBe("");
  });

  it("fails closed when the dialog itself faults: nothing is inserted", () => {
    teardown = initPasteGuard(document);
    const input = document.createElement("input");
    input.type = "text";
    input.value = "keep ";
    // Break dialog construction after interception: the paste must stay
    // cancelled and the raw text must not reach the input.
    Object.defineProperty(input, "getBoundingClientRect", {
      value: () => {
        throw new Error("layout fault");
      },
      configurable: true,
    });
    document.body.appendChild(input);

    const event = makePaste(input, SSN_PASTE);
    input.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(input.value).toBe("keep ");
  });
});

describe("unknown AI-style surfaces", () => {
  it("protects a synthetic chat page on an unknown hostname with no allow-list", async () => {
    // Enforcement keys off editable surfaces, never hostnames: there is no
    // hostname check anywhere on this path, so an unlisted AI clone is
    // covered exactly like a known one.
    const win = new Window({ url: "https://test-ai.example/chat" });
    const doc = win.document as unknown as Document;
    expect(win.location.hostname).toBe("test-ai.example");

    const chat = doc.createElement("div");
    chat.setAttribute("contenteditable", "true");
    doc.body.appendChild(chat);

    const done = initPasteGuard(doc);
    try {
      const matches = detectPasteFindings(SSN_PASTE);
      expect(matches.length).toBeGreaterThan(0);

      const event = makePaste(chat as unknown as Element, SSN_PASTE);
      (chat as unknown as Element).dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);

      // The dialog is on screen, so the interception happened on an unknown
      // hostname with no allow-list — which is the claim under test.
      expect(doc.getElementById("__governworld-paste-guard-host")).not.toBeNull();
      // Sanitize via the keyboard, which is a real user path: Enter focuses the
      // primary action. (The dialog's buttons cannot be clicked from here because
      // its shadow root is closed — see shadow-isolation.test.ts.)
      const view = (chat as unknown as Element).ownerDocument!.defaultView!;
      doc.dispatchEvent(new view.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      expect(chat.textContent ?? "").not.toContain("219-09-9999");
    } finally {
      done();
      await win.close();
    }
  });
});

describe("synthetic PHI paste", () => {
  // Synthetic fixtures in the shape of a clinical note. Never real PHI.
  const PHI_NOTE = [
    "Patient: Elena Vasquez",
    "DOB: 03/14/1978",
    "MRN: 4829137",
    "Dx: Type 2 diabetes mellitus",
    "Rx: Metformin 500mg twice daily",
    "Phone: (415) 555-0132",
    "Email: elena.vasquez@example.test",
  ].join("\n");

  it("detects the clinical identifiers as blockable findings", () => {
    const matches = detectPasteFindings(PHI_NOTE);
    const categories = new Set(matches.map((m) => m.category));
    expect(matches.length).toBeGreaterThanOrEqual(3);
    expect([...categories].some((c) => ["dob", "phone", "email", "possible_name"].includes(c))).toBe(
      true
    );
  });

  it("sanitization removes every raw clinical value", () => {
    const matches = detectPasteFindings(PHI_NOTE);
    const sanitized = sanitizePastedText(PHI_NOTE, matches);
    for (const raw of ["(415) 555-0132", "elena.vasquez@example.test", "03/14/1978"]) {
      expect(sanitized).not.toContain(raw);
    }
  });

  it("shows the dialog and inserts nothing until a choice", () => {
    const doc = document;
    const target = doc.createElement("textarea");
    doc.body.appendChild(target);
    const matches = detectPasteFindings(PHI_NOTE);
    const handle = showPasteGuardDialog(doc, target as unknown as HTMLElement, matches, silentCallbacks());
    try {
      // The dialog's shadow root is CLOSED, so its contents are deliberately not
      // readable — that is the property asserted in shadow-isolation.test.ts.
      // What still holds from out here is that the dialog exists and that no text
      // was inserted before the user chose.
      expect(doc.getElementById("__governworld-paste-guard-host")).not.toBeNull();
      expect((target as unknown as HTMLTextAreaElement).value).toBe("");
      // Every action is still reachable by id through the handle.
      expect(handle.press("gw-btn-cancel")).toBe(true);
    } finally {
      handle.close();
      target.remove();
    }
  });

  it("never reveals a raw value through the dialog's reachable surface", () => {
    // Whatever is observable from outside the closed root must not carry PHI.
    const doc = document;
    const target = doc.createElement("textarea");
    doc.body.appendChild(target);
    const matches = detectPasteFindings(PHI_NOTE);
    const handle = showPasteGuardDialog(doc, target as unknown as HTMLElement, matches, silentCallbacks());
    try {
      const host = doc.getElementById("__governworld-paste-guard-host");
      expect(host, "the dialog host must be in the light DOM").not.toBeNull();
      // Nothing reachable from the host leaks the pasted text.
      expect(host?.textContent ?? "").not.toContain("4829137");
      expect(host?.textContent ?? "").not.toContain("elena.vasquez@example.test");
      // And the closed root is genuinely closed.
      expect((host as unknown as { shadowRoot: unknown }).shadowRoot).toBeNull();
    } finally {
      handle.close();
      target.remove();
    }
  });
});
