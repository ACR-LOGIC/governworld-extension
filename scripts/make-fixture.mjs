// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Generates the synthetic E2E fixture PDF (synthetic PHI only) used by
// tests/extension.e2e.spec.ts. Run from apps/redaction-extension:
//   node scripts/make-fixture.mjs
import { PDFDocument, StandardFonts } from "pdf-lib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const root = dirname(fileURLToPath(import.meta.url));
const outDir = join(root, "..", "tests", "fixtures");

// Synthetic values only (project rule: never real PII/PHI). Content mirrors the
// discharge-summary fixture so page and document screenshots stay consistent.
const lines = [
  "St. Mary's Community Hospital",
  "Patient Care Services - Springfield, IL",
  "",
  "DISCHARGE SUMMARY",
  "",
  "Synthetic demonstration record. This is fictional discharge",
  "paperwork generated for the GovernWorld Redaction demo.",
  "",
  "Patient name: Jane Doe",
  "Date of birth: 1984-03-14",
  "Sex: F",
  "MRN: 44219",
  "Member ID: M882134",
  "SSN: 123-45-6789",
  "Phone: (415) 555-0199",
  "Email: jane.doe@example.com",
  "Address: 742 Evergreen Terrace, Springfield, IL 62704",
  "Payment method on file: 4111 1111 1111 1111",
  "Emergency contact: Mark Doe - (415) 555-0142 - mark.doe@example.net",
  "",
  "Admitted: 2026-08-10   Discharged: 2026-08-18",
  "Attending physician: Dr. Evelyn Reed",
  "Primary diagnosis: Acute bronchitis (J20.9)",
  "Secondary diagnosis: Type 2 diabetes, well controlled (E11.9)",
  "",
  "Summary of Stay",
  "Ms. Doe was admitted on 2026-08-10 with a productive cough, wheezing,",
  "and shortness of breath. Chest imaging showed changes consistent with",
  "acute bronchitis. She responded well to inhaled bronchodilators and",
  "oral fluids and was discharged on 2026-08-18 in stable condition.",
  "",
  "Discharge Medications",
  "- Amoxicillin 500 mg: one capsule by mouth three times daily for 7 days.",
  "- Metformin 1000 mg: one tablet twice daily with meals.",
  "- Albuterol 90 mcg HFA inhaler: two puffs every 4 hours as needed.",
  "",
  "Discharge Instructions",
  "Call the office or emergency services immediately for chest pain, difficulty",
  "breathing, facial swelling, or a fever above 101.5F. Complete all prescribed",
  "medications even if you feel better.",
  "",
  "Follow-Up Appointment",
  "A follow-up visit is scheduled for 2026-08-25 at 09:30 with Dr. Marcus Chen",
  "at Springfield Family Medicine (second floor, pulmonary clinic).",
  "",
  "Synthetic demo data only. No real personal information appears in this file.",
];

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const page = doc.addPage([612, 792]);
let y = 742;
for (const line of lines) {
  page.drawText(line, { x: 72, y, size: 11, font });
  y -= 16;
  if (y < 60) {
    y = 742;
    page.drawText("Page break placeholder - synthetic", { x: 72, y: 40, size: 9, font });
    break;
  }
}

const bytes = await doc.save();
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "sample.pdf"), bytes);
console.log("Wrote tests/fixtures/sample.pdf", bytes.length, "bytes");

function escapeXml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function crc32(buf) {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function buildDeflatedZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const raw = Buffer.from(data, "utf8");
    const compressed = deflateRawSync(raw);
    const crc = crc32(raw);

    const lh = Buffer.alloc(30 + nameBytes.length);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(8, 8); // deflate
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(compressed.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(lh, 30);
    locals.push(lh, compressed);

    const ch = Buffer.alloc(46 + nameBytes.length);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(8, 10); // deflate
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(compressed.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBytes.length, 28);
    ch.writeUInt32LE(offset, 42);
    nameBytes.copy(ch, 46);
    central.push(ch);

    offset += lh.length + compressed.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

const docxParagraphs = lines
  .map((line) => (line === "" ? "<w:p/>" : `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`))
  .join("");

const docxBytes = buildDeflatedZip([
  [
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      "</Types>",
  ],
  [
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      "</Relationships>",
  ],
  [
    "word/_rels/document.xml.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      "</Relationships>",
  ],
  [
    "word/styles.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
  ],
  [
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${docxParagraphs}</w:body></w:document>`,
  ],
]);

writeFileSync(join(outDir, "sample.docx"), docxBytes);
console.log("Wrote tests/fixtures/sample.docx", docxBytes.length, "bytes");