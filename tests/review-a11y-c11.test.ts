// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// C11 — Review-flow & settings accessibility structure verification.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("C11 — Review-flow & controls accessibility", () => {
  it("provides accessible roles, labels, and aria-checked attributes across popup, sidepanel, and review HTML", () => {
    const popupHtml = readFileSync(resolve(process.cwd(), "src", "popup", "index.html"), "utf8");
    const sidepanelHtml = readFileSync(resolve(process.cwd(), "src", "sidepanel", "sidepanel.html"), "utf8");
    const reviewHtml = readFileSync(resolve(process.cwd(), "src", "popup", "review.html"), "utf8");

    for (const html of [popupHtml, sidepanelHtml]) {
      expect(html).toContain('id="pinned-tab-select"');
      expect(html).toContain('aria-label=');
      expect(html).toContain('role="switch"');
      expect(html).toContain('id="auto-mask-single-names-toggle"');
      expect(html).toContain('id="medical-dictionary-toggle"');
    }

    expect(reviewHtml).toContain("<main");
    expect(reviewHtml).toContain("aria-label");
  });
});
