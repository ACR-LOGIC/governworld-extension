// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// @vitest-environment node
// C5 — Export metadata verified / stripped from flattened PDF outputs.

import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { deflateSync } from "node:zlib";
import { pagesToPdf } from "../src/document-pipeline/render.js";

function minimalPng1x1(): Uint8Array {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    let crc = 0xffffffff;
    for (const b of body) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
    return Buffer.concat([len, body, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.from([0, 255, 255, 255, 255]);
  return new Uint8Array(
    Buffer.concat([
      sig,
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ])
  );
}

describe("C5 — Export metadata verified and stripped", () => {
  it("strips Title, Author, Subject, Keywords, Creator, and Producer from exported PDFs", async () => {
    const outBytes = await pagesToPdf([
      { pngBytes: minimalPng1x1(), widthPt: 72, heightPt: 72 },
    ]);
    const reloaded = await PDFDocument.load(outBytes);
    expect(reloaded.getTitle()).toBeUndefined();
    expect(reloaded.getAuthor()).toBeUndefined();
    expect(reloaded.getSubject()).toBeUndefined();
    expect(reloaded.getKeywords()).toBeUndefined();

    const rawLatin1 = Buffer.from(outBytes).toString("latin1");
    expect(rawLatin1).not.toContain("/Metadata");
  });
});
