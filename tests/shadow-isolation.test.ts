// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// What a hostile page must not be able to reach through the DOM.
//
// Both the scan overlay and the paste-guard dialog render in a shadow root. With
// `mode: "open"`, any script on the page can read `host.shadowRoot`, which meant:
//
//   * the overlay leaked a precise map of where the PII on the page is — every
//     rect, its category and its label — to a third-party script the user never
//     authorised, and
//   * the paste dialog's buttons were clickable by page script, so it could
//     dispatch a click on "Paste Unchanged" and choose the outcome on the user's
//     behalf, bypassing the guard they had installed.
//
// A closed root costs nothing internally: the paint loop and the dialog handlers
// both hold their own references. These tests assert the isolation property in a
// real DOM, and assert the parts that must REMAIN observable so the overlay can
// still be verified and cleaned up.
// @vitest-environment happy-dom
import { describe, expect, it, beforeEach } from "vitest";
import { detectPasteFindings, showPasteGuardDialog } from "../src/content/pasteGuard.js";
import { createOverlay, type OverlayRect } from "../src/content/overlay.js";

// Synthetic fixture, never real PHI.
const SSN_TEXT = "my ssn is 219-09-9999 ok";

const rects: OverlayRect[] = [
  { kind: "mask", label: "ssn: ***-**-9999", x: 40, y: 60, width: 120, height: 20, placeholder: "[SSN]" },
  { kind: "highlight", label: "email: j***@example.test", x: 40, y: 90, width: 200, height: 20 },
];

describe("the scan overlay is not readable by page JavaScript", () => {
  let overlay: ReturnType<typeof createOverlay> | null = null;

  beforeEach(() => {
    document.body.innerHTML = "";
    overlay = null;
  });

  it("does not expose its shadow root", () => {
    overlay = createOverlay(document);
    overlay.render(rects);
    const host = document.querySelector("[data-gw-scan-overlay]");
    expect(host, "the overlay host must exist in the light DOM").not.toBeNull();
    // This is the whole point: page script reaches the mask layer through here.
    expect((host as unknown as { shadowRoot: unknown }).shadowRoot).toBeNull();
  });

  it("keeps the host discoverable so it can be cleaned up and verified", () => {
    overlay = createOverlay(document);
    overlay.render(rects);
    // The attribute is how tests confirm an overlay exists and how a second
    // createOverlay() replaces the previous one. Losing it would cost more than
    // the closed root gains.
    expect(document.querySelectorAll("[data-gw-scan-overlay]")).toHaveLength(1);
  });

  it("replaces its own previous host rather than accumulating", () => {
    const first = createOverlay(document);
    first.render(rects);
    const second = createOverlay(document);
    second.render(rects);
    expect(document.querySelectorAll("[data-gw-scan-overlay]")).toHaveLength(1);
    second.destroy();
  });

  it("removes the host on destroy", () => {
    overlay = createOverlay(document);
    overlay.render(rects);
    overlay.destroy();
    expect(document.querySelectorAll("[data-gw-scan-overlay]")).toHaveLength(0);
    overlay = null;
  });
});

describe("the paste dialog cannot be operated by page JavaScript", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("does not expose its shadow root", () => {
    const target = document.createElement("textarea");
    document.body.appendChild(target);
    const handle = showPasteGuardDialog(document, target, detectPasteFindings(SSN_TEXT), {
      onSanitize: () => undefined,
      onRaw: () => undefined,
      onCancel: () => undefined,
    });
    try {
      const host = document.getElementById("__governworld-paste-guard-host");
      expect(host).not.toBeNull();
      expect((host as unknown as { shadowRoot: unknown }).shadowRoot).toBeNull();
      // And therefore no button is reachable: the ids are not even discoverable
      // from out here.
      expect(document.getElementById("gw-btn-raw")).toBeNull();
      expect(host?.querySelector("#gw-btn-raw")).toBeNull();
    } finally {
      handle.close();
    }
  });

  it("still offers every outcome to the extension itself", () => {
    // Closing the root must not cost the extension its own controls: each action
    // remains invokable by its stable id, and an unknown id is refused rather
    // than silently ignored.
    const target = document.createElement("textarea");
    document.body.appendChild(target);
    const seen: string[] = [];
    const handle = showPasteGuardDialog(document, target, detectPasteFindings(SSN_TEXT), {
      onSanitize: () => seen.push("sanitize"),
      onRaw: () => seen.push("raw"),
      onCancel: () => seen.push("cancel"),
    });
    try {
      expect(handle.press("gw-btn-sanitize")).toBe(true);
      expect(handle.press("gw-btn-raw")).toBe(true);
      expect(handle.press("gw-btn-cancel")).toBe(true);
      expect(seen).toEqual(["sanitize", "raw", "cancel"]);
      expect(handle.press("gw-btn-nope" as "gw-btn-raw")).toBe(false);
      expect(seen).toHaveLength(3);
    } finally {
      handle.close();
    }
  });
});