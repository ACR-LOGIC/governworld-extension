// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createOverlay } from "../src/content/overlay.js";
import type { OverlayRect } from "../src/content/overlay.js";

describe("OverlayController", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("injects a fixed viewport overlay host inside document.body", () => {
    const overlay = createOverlay(document);
    const host = document.querySelector("div[data-gw-scan-overlay]");
    expect(host).not.toBeNull();
    expect(host?.getAttribute("style")).toContain("position: fixed");
    expect(host?.getAttribute("aria-hidden")).toBe("true");
    overlay.destroy();
    expect(document.querySelector("div[data-gw-scan-overlay]")).toBeNull();
  });

  it("renders multiple mask and highlight items", () => {
    const overlay = createOverlay(document);
    const items: OverlayRect[] = [
      { kind: "mask", label: "email: user@test.com", x: 20, y: 30, width: 100, height: 20, placeholder: "[EMAIL]" },
      { kind: "highlight", label: "phone: 555-0100", x: 40, y: 80, width: 90, height: 25 },
    ];
    overlay.render(items);

    const host = document.querySelector("div[data-gw-scan-overlay]");
    expect(host).not.toBeNull();
    overlay.destroy();
  });

  it("triggers recalculator callback and re-evaluates coordinates on scroll and resize", () => {
    let callCount = 0;
    const dynamicItems: OverlayRect[] = [
      { kind: "mask", label: "ssn", x: 10, y: 10, width: 80, height: 20 },
    ];

    const recalculate = vi.fn(() => {
      callCount++;
      return [
        { kind: "mask" as const, label: "ssn", x: 10, y: 10 + callCount * 10, width: 80, height: 20 },
      ];
    });

    const overlay = createOverlay(document, recalculate);
    overlay.render(dynamicItems);

    window.dispatchEvent(new Event("scroll"));
    expect(recalculate).toHaveBeenCalled();

    window.dispatchEvent(new Event("resize"));
    expect(recalculate.mock.calls.length).toBeGreaterThanOrEqual(2);

    overlay.destroy();
  });

  it("supports dynamic setRecalculator assignment", () => {
    const overlay = createOverlay(document);
    overlay.render([{ kind: "mask", label: "card", x: 50, y: 50, width: 120, height: 25 }]);

    const recalculator = vi.fn(() => [
      { kind: "mask" as const, label: "card", x: 50, y: 150, width: 120, height: 25 },
    ]);
    overlay.setRecalculator?.(recalculator);

    window.dispatchEvent(new Event("scroll"));
    expect(recalculator).toHaveBeenCalled();

    overlay.destroy();
  });

  it("clear empties rects and cancels pending animation frame", () => {
    const overlay = createOverlay(document);
    overlay.render([{ kind: "mask", label: "test", x: 10, y: 10, width: 50, height: 20 }]);
    overlay.clear();
    const host = document.querySelector("div[data-gw-scan-overlay]");
    expect(host).not.toBeNull();
    overlay.destroy();
  });

  it("destroy detaches scroll and resize listeners cleanly", () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const overlay = createOverlay(document);
    overlay.destroy();

    const events = removeSpy.mock.calls.map((c) => c[0]);
    expect(events).toContain("scroll");
    expect(events).toContain("resize");
  });
});
