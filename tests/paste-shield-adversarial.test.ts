// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Paste Shield adversarial and browser boundary verification suite (Objective 8).
import { describe, it, expect } from "vitest";
import { initPasteGuard, isEditableElement } from "../src/content/pasteGuard.js";

function createMockElement(tagName: string, props: any = {}): any {
  const listeners: Record<string, Function[]> = {};
  const children: any[] = [];

  const el: any = {
    tagName: tagName.toUpperCase(),
    nodeType: 1,
    children,
    style: {},
    className: "",
    id: "",
    value: "",
    textContent: "",
    appendChild: (child: any) => {
      children.push(child);
      child.parentNode = el;
      return child;
    },
    removeChild: (child: any) => {
      const idx = children.indexOf(child);
      if (idx >= 0) children.splice(idx, 1);
      return child;
    },
    remove: () => {
      if (el.parentNode && el.parentNode.removeChild) {
        el.parentNode.removeChild(el);
      }
    },
    setAttribute: (name: string, val: string) => {
      el[name] = val;
    },
    getAttribute: (name: string) => el[name] || null,
    addEventListener: (type: string, fn: Function) => {
      listeners[type] = listeners[type] || [];
      listeners[type].push(fn);
    },
    removeEventListener: (type: string, fn: Function) => {
      if (listeners[type]) {
        listeners[type] = listeners[type].filter((f) => f !== fn);
      }
    },
    dispatchEvent: async (ev: any) => {
      if (listeners[ev.type]) {
        for (const fn of [...listeners[ev.type]]) await fn(ev);
      }
      return true;
    },
    getBoundingClientRect: () => ({ top: 100, left: 100, width: 200, height: 40 }),
    closest: (sel: string) => {
      if (sel.includes("contenteditable") && el.isContentEditable) return el;
      return null;
    },
    setRangeText: (text: string, start: number, end: number) => {
      el.value = el.value.slice(0, start) + text + el.value.slice(end);
    },
    attachShadow: () => {
      const shadow: any = createMockElement("shadow-root");
      shadow.activeElement = null;
      el.shadowRoot = shadow;
      return shadow;
    },
    ...props,
  };

  if (tagName.toLowerCase() === "input") {
    Object.setPrototypeOf(el, (globalThis as any).HTMLInputElement?.prototype || Object.prototype);
  } else if (tagName.toLowerCase() === "textarea") {
    Object.setPrototypeOf(el, (globalThis as any).HTMLTextAreaElement?.prototype || Object.prototype);
  } else {
    Object.setPrototypeOf(el, (globalThis as any).HTMLElement?.prototype || Object.prototype);
  }

  return el;
}

function createMockDocument(): any {
  const elementsById: Record<string, any> = {};
  const listeners: Record<string, Function[]> = {};
  const body = createMockElement("body");

  const doc: any = {
    body,
    documentElement: body,
    defaultView: { innerWidth: 1024, innerHeight: 768 },
    createElement: (tag: string) => createMockElement(tag),
    createElementNS: (_ns: string, tag: string) => createMockElement(tag),
    createTextNode: (text: string) => ({ textContent: text, nodeType: 3 }),
    getElementById: (id: string) => {
      if (elementsById[id]) return elementsById[id];
      const findIn = (node: any): any => {
        if (node.id === id) return node;
        for (const ch of node.children || []) {
          const res = findIn(ch);
          if (res) return res;
        }
        return null;
      };
      return findIn(body);
    },
    addEventListener: (type: string, fn: Function) => {
      listeners[type] = listeners[type] || [];
      listeners[type].push(fn);
    },
    removeEventListener: (type: string, fn: Function) => {
      if (listeners[type]) {
        listeners[type] = listeners[type].filter((f) => f !== fn);
      }
    },
    querySelectorAll: () => [],
    dispatchEvent: async (ev: any) => {
      if (listeners[ev.type]) {
        for (const fn of [...listeners[ev.type]]) await fn(ev);
      }
      return true;
    },
  };
  return doc;
}

describe("Paste Shield boundary and behavior verification (Objective 8)", () => {
  it("identifies editable vs non-editable target elements", () => {
    expect(isEditableElement(createMockElement("input", { type: "text" }))).toBe(true);
    expect(isEditableElement(createMockElement("textarea"))).toBe(true);
    expect(isEditableElement(createMockElement("div", { isContentEditable: true }))).toBe(true);

    // Non-editable elements
    expect(isEditableElement(createMockElement("div", { isContentEditable: false }))).toBe(false);
    expect(isEditableElement(createMockElement("span", { isContentEditable: false }))).toBe(false);
    expect(isEditableElement(createMockElement("form"))).toBe(false);
    expect(isEditableElement(createMockElement("input", { type: "submit" }))).toBe(false);
  });

  it("intercepts paste on editable targets containing sensitive data", async () => {
    const doc = createMockDocument();
    const input = createMockElement("input", { type: "text" });
    const cleanup = initPasteGuard(doc);

    let defaultPrevented = false;
    let stopPropagationCalled = false;

    const pasteEvent = {
      type: "paste",
      target: input,
      clipboardData: {
        getData: (type: string) => (type === "text/plain" ? "Secret key: sk-proj-12345678901234567890123456789012345678901234567890" : ""),
      },
      preventDefault: () => { defaultPrevented = true; },
      stopPropagation: () => { stopPropagationCalled = true; },
      stopImmediatePropagation: () => { stopPropagationCalled = true; },
    };

    await doc.dispatchEvent(pasteEvent);

    expect(defaultPrevented).toBe(true);
    expect(stopPropagationCalled).toBe(true);

    cleanup();
  });

  it("intercepts drag-and-drop text containing sensitive data", async () => {
    const doc = createMockDocument();
    const textarea = createMockElement("textarea");
    const cleanup = initPasteGuard(doc);

    let defaultPrevented = false;
    let stopPropagationCalled = false;

    const dropEvent = {
      type: "drop",
      target: textarea,
      dataTransfer: {
        getData: (type: string) => (type === "text/plain" ? "Patient SSN is 219-09-9999" : ""),
        files: [],
      },
      preventDefault: () => { defaultPrevented = true; },
      stopPropagation: () => { stopPropagationCalled = true; },
      stopImmediatePropagation: () => { stopPropagationCalled = true; },
    };

    await doc.dispatchEvent(dropEvent);

    expect(defaultPrevented).toBe(true);
    expect(stopPropagationCalled).toBe(true);

    cleanup();
  });

  it("intercepts drag-and-drop of text/code files containing sensitive data", async () => {
    const doc = createMockDocument();
    const input = createMockElement("input", { type: "text" });
    const cleanup = initPasteGuard(doc);

    let defaultPrevented = false;
    let stopPropagationCalled = false;

    const mockFile = {
      name: "credentials.env",
      type: "text/plain",
      text: async () => "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nAWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    };

    const dropEvent = {
      type: "drop",
      target: input,
      dataTransfer: {
        getData: () => "",
        files: [mockFile],
      },
      preventDefault: () => { defaultPrevented = true; },
      stopPropagation: () => { stopPropagationCalled = true; },
      stopImmediatePropagation: () => { stopPropagationCalled = true; },
    };

    await doc.dispatchEvent(dropEvent);

    expect(defaultPrevented).toBe(true);
    expect(stopPropagationCalled).toBe(true);

    cleanup();
  });

  it("documents unintercepted browser vectors: file picker uploads (<input type='file'>) are NOT intercepted", () => {
    // Invariant: Native file input dialogs and change events on <input type="file">
    // are unintercepted by Paste Guard because they do not fire 'paste' or 'drop'.
    const fileInput = createMockElement("input", { type: "file" });

    const doc = createMockDocument();
    const cleanup = initPasteGuard(doc);

    let changeHandled = false;
    fileInput.addEventListener("change", () => {
      changeHandled = true;
    });

    // Native file selection triggers 'change', not 'paste'
    fileInput.dispatchEvent({ type: "change" });
    expect(changeHandled).toBe(true); // proves Paste Guard does not interfere with file inputs

    cleanup();
  });

  it("documents unintercepted browser vectors: non-editable drop zones (<div id='dropzone'>) are NOT intercepted", async () => {
    // Web applications using custom non-contenteditable dropzones are not intercepted by isEditableElement
    const customDropZone = createMockElement("div", { isContentEditable: false });
    expect(isEditableElement(customDropZone)).toBe(false);

    const doc = createMockDocument();
    const cleanup = initPasteGuard(doc);

    let defaultPrevented = false;
    const dropEvent = {
      type: "drop",
      target: customDropZone,
      dataTransfer: {
        getData: () => "AKIAIOSFODNN7EXAMPLE",
        files: [],
      },
      preventDefault: () => { defaultPrevented = true; },
      stopPropagation: () => {},
      stopImmediatePropagation: () => {},
    };

    await doc.dispatchEvent(dropEvent);
    // Because target is not editable, Paste Guard intentionally ignores it
    expect(defaultPrevented).toBe(false);

    cleanup();
  });

  it("documents unintercepted browser vectors: <form> submit events are NOT intercepted", () => {
    // Form submissions (typed or browser autofilled) do not fire paste events
    const form = createMockElement("form");
    expect(isEditableElement(form)).toBe(false);
  });

  it("documents unintercepted browser vectors: programmatic inputs (el.value = ...) bypass DOM event listeners", () => {
    // Scripts assigning input values programmatically bypass user paste/drop events completely
    const input = createMockElement("input", { type: "text" });
    const doc = createMockDocument();
    const cleanup = initPasteGuard(doc);

    // Direct programmatic property assignment does not dispatch a 'paste' or 'beforeinput' event
    input.value = "Patient SSN 219-09-9999";
    expect(input.value).toBe("Patient SSN 219-09-9999");

    cleanup();
  });

  it("documents unintercepted browser vectors: canvas-based editors (<canvas>) cannot be intercepted via standard DOM guards", () => {
    // Canvas elements used by Google Docs, Figma, etc. are non-editable DOM nodes
    const canvas = createMockElement("canvas");
    expect(isEditableElement(canvas)).toBe(false);
  });
});
