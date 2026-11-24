// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// @vitest-environment happy-dom
// Gate G4 — Redaction results identical (deterministic golden output gate).

import { describe, expect, it } from "vitest";
import { maskValue } from "../src/content/detect.js";
import { buildRedactedText, maskCombinedRange, type TextSegment } from "../src/content/extract.js";
import { applyBoxes, scaleBox } from "../src/document-pipeline/render.js";
import type { Finding } from "../src/shared/types.js";

const MASK_CHAR = "\u2588";

describe("Gate G4 — Deterministic Golden Redaction Outputs", () => {
  it("produces identical maskValue strings across canonical sensitive categories (including Unicode email)", () => {
    expect(maskValue("ssn", "219-09-9999")).toBe("***-**-9999");
    expect(maskValue("email", "test.user@example.test")).toBe("t***@example.test");
    expect(maskValue("email", "josé.maría@example.test")).toBe("j***@example.test");
    expect(maskValue("phone", "(555) 234-5678")).toBe("***-***-5678");
    expect(maskValue("payment_card", "4111 1111 1111 1111")).toBe("************1111");
    expect(maskValue("npi", "1234567893")).toBe("******-7893");
    expect(maskValue("secrets", "AKIAIOSFODNN7EXAMPLE")).toBe("A***");
  });

  it("produces identical block-masked and placeholder-masked text via buildRedactedText & maskCombinedRange", () => {
    const seg0: TextSegment = { nodeId: "s0", startOffset: 0, endOffset: 24, text: "Patient SSN:\t219-09-9999" };
    const seg1: TextSegment = { nodeId: "s1", startOffset: 0, endOffset: 30, text: "Email: josé.maría@example.test" };
    const combined = `${seg0.text}\n${seg1.text}`;
    const findings: Finding[] = [
      {
        id: "f-ssn",
        category: "ssn",
        confidence: 0.99,
        source: "local-rules",
        preview: "***-**-9999",
        nodeId: "s0",
        startOffset: 13,
        endOffset: 24,
        rects: [],
        contextPreview: "",
        selected: true,
      },
      {
        id: "f-email",
        category: "email",
        confidence: 0.99,
        source: "local-rules",
        preview: "j***@example.test",
        nodeId: "s1",
        startOffset: 32,
        endOffset: 55,
        rects: [],
        contextPreview: "",
        selected: true,
      },
    ];

    const expectedBlocks = `Patient SSN:\t${MASK_CHAR.repeat(11)}\nEmail: ${MASK_CHAR.repeat(23)}`;
    expect(buildRedactedText([seg0, seg1], [0, 25], combined.length, findings)).toBe(expectedBlocks);
    expect(maskCombinedRange(combined, 0, combined.length, findings, false)).toBe(expectedBlocks);
    expect(maskCombinedRange(combined, 0, combined.length, findings, true)).toBe(
      "Patient SSN:\t[SSN]\nEmail: [EMAIL]"
    );
  });

  it("produces exact deterministic blackout, whiteout, stamp, and edge-clamped coordinates in applyBoxes", () => {
    const fills: Array<{ x: number; y: number; w: number; h: number; fillStyle: unknown; text?: string }> = [];
    const ctx = {
      fillStyle: "",
      font: "",
      textAlign: "",
      textBaseline: "",
      save() {},
      restore() {},
      beginPath() {},
      rect() {},
      clip() {},
      fillRect(x: number, y: number, w: number, h: number) {
        fills.push({ x, y, w, h, fillStyle: this.fillStyle });
      },
      fillText(text: string) {
        if (fills.length > 0) fills[fills.length - 1].text = text;
      },
    };
    const canvas = { width: 200, height: 100, getContext: () => ctx } as unknown as HTMLCanvasElement;

    applyBoxes(
      canvas,
      [
        { x: 1, y: 1, width: 10, height: 10 },
        { x: 195, y: 95, width: 40, height: 40 },
      ],
      4
    );
    expect(fills).toEqual([
      { x: 0, y: 0, w: 18, h: 18, fillStyle: "#000000" },
      { x: 191, y: 91, w: 9, h: 9, fillStyle: "#000000" },
    ]);

    const scaled = scaleBox({ x: 10, y: 20, width: 30, height: 40 }, 2, 1.5);
    expect(scaled).toEqual({ x: 20, y: 30, width: 60, height: 60 });

    fills.length = 0;
    applyBoxes(canvas, [{ x: 20, y: 20, width: 60, height: 20 }], {
      style: "stamp",
      fillColor: "#111111",
      stampText: "[PHI]",
      padding: 0,
    });
    expect(fills).toEqual([{ x: 20, y: 20, w: 60, h: 20, fillStyle: "#111111", text: "[PHI]" }]);
  });
});
