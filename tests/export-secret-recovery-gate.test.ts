// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// @vitest-environment node
// Gate G5 — No recoverable test secrets in an export (re-decode finished PDF via pdf-lib & pdfjs-dist + pixel check).

import { describe, expect, it } from "vitest";
import { PDFDocument, PDFDict, PDFName, PDFNumber, PDFRawStream } from "pdf-lib";
import { deflateSync, inflateSync } from "node:zlib";
import { applyBoxes, pagesToPdf } from "../src/document-pipeline/render.js";
import type { Rect } from "../src/shared/types.js";

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  let crc = 0xffffffff;
  for (const byte of body) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
  return Buffer.concat([len, body, crcBuf]);
}

function encodeRgbaToPng(width: number, height: number, rgba: Buffer): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8-bit
  ihdr[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return new Uint8Array(
    Buffer.concat([
      PNG_SIG,
      pngChunk("IHDR", ihdr),
      pngChunk("IDAT", deflateSync(raw, { level: 9 })),
      pngChunk("IEND", Buffer.alloc(0)),
    ])
  );
}

function makePixelCanvas(width: number, height: number, rgba: Buffer): HTMLCanvasElement {
  const ctx = {
    fillStyle: "#000000",
    font: "",
    textAlign: "",
    textBaseline: "",
    save() {},
    restore() {},
    fillText() {},
    fillRect(x: number, y: number, w: number, h: number) {
      const hex = String(this.fillStyle).toLowerCase();
      const rgb: [number, number, number] = hex === "#ffffff" ? [255, 255, 255] : [0, 0, 0];
      const x0 = Math.max(0, Math.floor(x));
      const y0 = Math.max(0, Math.floor(y));
      const x1 = Math.min(width, Math.ceil(x + w));
      const y1 = Math.min(height, Math.ceil(y + h));
      for (let py = y0; py < y1; py++) {
        for (let px = x0; px < x1; px++) {
          const idx = (py * width + px) * 4;
          rgba[idx] = rgb[0];
          rgba[idx + 1] = rgb[1];
          rgba[idx + 2] = rgb[2];
          rgba[idx + 3] = 255;
        }
      }
    },
  };
  return { width, height, getContext: () => ctx } as unknown as HTMLCanvasElement;
}

describe("Gate G5 — Finished PDF Re-Decode & Secret Non-Recovery", () => {
  it("re-decodes the flattened PDF via pdf-lib and pdfjs-dist and verifies zero leaked text or unredacted pixels", async () => {
    const width = 240;
    const height = 120;
    const rgba = Buffer.alloc(width * height * 4, 255); // solid white page background

    const secretBoxes: Rect[] = [
      { x: 20, y: 24, width: 120, height: 18 }, // synthetic SSN "219-09-9999"
      { x: 20, y: 66, width: 170, height: 18 }, // synthetic Email "test.user@example.test"
    ];

    // Paint contrasting colored secret glyph pixels inside both target regions before redaction
    for (const box of secretBoxes) {
      for (let py = box.y + 2; py < box.y + box.height - 2; py++) {
        for (let px = box.x + 2; px < box.x + box.width - 2; px++) {
          const idx = (py * width + px) * 4;
          rgba[idx] = 200;
          rgba[idx + 1] = 25;
          rgba[idx + 2] = 25;
          rgba[idx + 3] = 255;
        }
      }
    }

    const canvas = makePixelCanvas(width, height, rgba);
    applyBoxes(canvas, secretBoxes, 4);

    const pngBytes = encodeRgbaToPng(width, height, rgba);
    const pdfBytes = await pagesToPdf([{ pngBytes, widthPt: 612, heightPt: 792 }]);

    // 1. pdf-lib inspection: zero /Font resources, zero secret/source metadata strings
    const doc = await PDFDocument.load(pdfBytes);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getTitle()).toBeUndefined();
    expect(doc.getAuthor()).toBeUndefined();
    expect(doc.getSubject()).toBeUndefined();
    expect(doc.getKeywords()).toBeUndefined();

    const latin1 = Buffer.from(pdfBytes).toString("latin1");
    expect(latin1).not.toContain("219-09-9999");
    expect(latin1).not.toContain("test.user@example.test");
    expect(latin1).not.toContain("/Font");

    let fontDicts = 0;
    let extractedRgbImage: Buffer | null = null;
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFDict && obj.get(PDFName.of("Font"))) {
        fontDicts++;
      }
      if (obj instanceof PDFRawStream) {
        const subtype = obj.dict.get(PDFName.of("Subtype"));
        const cs = obj.dict.get(PDFName.of("ColorSpace"));
        const wObj = obj.dict.get(PDFName.of("Width"));
        const hObj = obj.dict.get(PDFName.of("Height"));
        if (
          subtype === PDFName.of("Image") &&
          cs === PDFName.of("DeviceRGB") &&
          wObj instanceof PDFNumber &&
          wObj.asNumber() === width &&
          hObj instanceof PDFNumber &&
          hObj.asNumber() === height
        ) {
          extractedRgbImage = inflateSync(Buffer.from(obj.contents));
        }
      }
    }
    expect(fontDicts).toBe(0);
    expect(extractedRgbImage).not.toBeNull();
    expect(extractedRgbImage!.length).toBe(width * height * 3);

    // 2. Re-decode finished PDF text layer using pdfjs-dist
    const pdfjsLib = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as typeof import("pdfjs-dist");
    const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(pdfBytes), useSystemFonts: true });
    try {
      const pdfDoc = await loadingTask.promise;
      expect(pdfDoc.numPages).toBe(1);
      const page = await pdfDoc.getPage(1);
      const textContent = await page.getTextContent();
      expect(textContent.items).toHaveLength(0);
    } finally {
      await loadingTask.destroy();
    }

    // 3. Pixel-level verification inside the embedded RGB image stream of the finished PDF
    let nonBlackPixelsInsideBoxes = 0;
    for (const box of secretBoxes) {
      for (let py = box.y; py < box.y + box.height; py++) {
        for (let px = box.x; px < box.x + box.width; px++) {
          const offset = (py * width + px) * 3;
          const r = extractedRgbImage![offset];
          const g = extractedRgbImage![offset + 1];
          const b = extractedRgbImage![offset + 2];
          if (r !== 0 || g !== 0 || b !== 0) {
            nonBlackPixelsInsideBoxes++;
          }
        }
      }
    }
    expect(nonBlackPixelsInsideBoxes).toBe(0);
  });
});
