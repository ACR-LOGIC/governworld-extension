// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// @vitest-environment happy-dom
// C8 — Rich-text & shadow-DOM input guard matrix (0 escapes).

import { describe, expect, it } from "vitest";
import { detect } from "../src/content/detect.js";
import { ALL_CATEGORIES } from "../src/shared/settings.js";

describe("C8 — Rich-text & shadow-DOM guard matrix", () => {
  it("flags sensitive payloads across input, textarea, contentEditable, and shadow DOM targets", () => {
    const payloads = [
      "Contact test.user@example.test",
      "SSN 219-09-9999",
      "Phone 555-234-5678",
    ];

    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });

    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const shadowEditable = document.createElement("div");
    shadowEditable.setAttribute("contenteditable", "plaintext-only");
    shadow.appendChild(shadowEditable);
    document.body.append(host, input, textarea, editable);

    const targets = [input, textarea, editable, shadowEditable];
    let escapes = 0;

    for (const target of targets) {
      for (const payload of payloads) {
        if ("value" in target) {
          (target as HTMLInputElement | HTMLTextAreaElement).value = payload;
        } else {
          target.textContent = payload;
        }
        const text =
          "value" in target
            ? (target as HTMLInputElement | HTMLTextAreaElement).value
            : (target.textContent ?? "");
        const hits = detect(text, ALL_CATEGORIES);
        if (hits.length === 0) escapes += 1;
      }
    }

    expect(escapes).toBe(0);
    host.remove();
    input.remove();
    textarea.remove();
    editable.remove();
  });
});
