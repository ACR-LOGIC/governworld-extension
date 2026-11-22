// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// C7 — Low OCR confidence = uncertain, never clean.

import { describe, expect, it } from "vitest";
import { isLowOcrConfidencePage, LOW_OCR_CONFIDENCE_THRESHOLD } from "../src/document-pipeline/impl.js";
import { validateMessage } from "../src/shared/messages.js";

describe("C7 — Low OCR confidence = uncertain, never clean", () => {
  it("flags empty OCR token output as low confidence (uncertain)", () => {
    expect(isLowOcrConfidencePage([])).toBe(true);
    expect(isLowOcrConfidencePage([{ text: "   ", confidence: 99 }])).toBe(true);
  });

  it("flags pages whose mean OCR confidence is below threshold", () => {
    expect(LOW_OCR_CONFIDENCE_THRESHOLD).toBe(60);
    expect(
      isLowOcrConfidencePage([
        { text: "blvrred", confidence: 35 },
        { text: "t3xt", confidence: 45 },
      ])
    ).toBe(true);
    expect(
      isLowOcrConfidencePage([
        { text: "Clear", confidence: 92 },
        { text: "Document", confidence: 88 },
      ])
    ).toBe(false);
  });

  it("validates lowOcrConfidence boolean on POPUP_DOC_STATE pages", () => {
    const valid = validateMessage({
      type: "POPUP_DOC_STATE",
      requestId: "req_c7_1",
      docId: "doc_1",
      name: "scan.pdf",
      fileKey: "file_1",
      mimeType: "application/pdf",
      kind: "pdf",
      pages: [
        {
          index: 0,
          widthPx: 600,
          heightPx: 800,
          previewKey: "file_1::preview::0",
          lowOcrConfidence: true,
          findings: [],
        },
      ],
    });
    expect(valid.ok).toBe(true);

    const invalid = validateMessage({
      type: "POPUP_DOC_STATE",
      requestId: "req_c7_2",
      docId: "doc_1",
      name: "scan.pdf",
      fileKey: "file_1",
      mimeType: "application/pdf",
      kind: "pdf",
      pages: [
        {
          index: 0,
          widthPx: 600,
          heightPx: 800,
          previewKey: "file_1::preview::0",
          lowOcrConfidence: "yes",
          findings: [],
        },
      ],
    });
    expect(invalid.ok).toBe(false);
  });
});
