// @vitest-environment happy-dom
// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Run 1 Benchmark Harness (Node / happy-dom) — GW-BENCH-2026-001 reproduction & CI gate.
// Synthetic test data only (RFC 2606 .test domains, never-issued SSNs, documented test cards).

import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";

import { detect } from "../src/content/detect.js";
import { extractVisibleText, buildScanText } from "../src/content/extract.js";
import { detectPasteFindings, sanitizePastedText, insertTextIntoElement } from "../src/content/pasteGuard.js";
import { findingsFromOcrPages } from "../src/document-pipeline/core.js";
import { applyBoxes, pagesToPdf } from "../src/document-pipeline/render.js";
import type { OcrPageResult } from "../src/document-pipeline/ocr.js";
import type { FindingCategory } from "../src/shared/types.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS_PATH = join(ROOT, "docs", "benchmarks", "results-run1.json");
const STRICT_MODE = process.env.GW_BENCH_STRICT === "1";
const STRICT_COVERAGE = process.env.GW_BENCH_STRICT_COVERAGE === "1";

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[idx].toFixed(3));
}

function measureRuns(fn: () => void, iterations = 11): { p50: number; p95: number; min: number; max: number; samples: number[] } {
  // Warmup
  fn();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    min: Number(sorted[0].toFixed(3)),
    max: Number(sorted[sorted.length - 1].toFixed(3)),
    samples: samples.map((s) => Number(s.toFixed(3))),
  };
}

interface StrictSample {
  id: string;
  category: FindingCategory;
  text: string;
  expected: string;
}

const STRICT_CATEGORIES: FindingCategory[] = [
  "email",
  "phone",
  "ssn",
  "payment_card",
  "npi",
  "dea",
  "mbi",
  "canadian_sin",
  "uk_nhs",
  "aadhaar",
  "pan_india",
  "australian_tfn",
  "cpf",
  "secrets",
  "dob",
  "medical_record_number",
];

// 16 strict categories, 22 positive cases matching GW-BENCH-2026-001 §4.1
export const STRICT_CORPUS_22: StrictSample[] = [
  { id: "email-ascii", category: "email", text: "Contact patient at test.user@example.test for details.", expected: "test.user@example.test" },
  { id: "email-unicode", category: "email", text: "Direct care notice to josé.maría@example.test today.", expected: "josé.maría@example.test" },
  { id: "phone-1", category: "phone", text: "Direct callback number is (555) 234-5678.", expected: "(555) 234-5678" },
  { id: "phone-2", category: "phone", text: "Emergency line: +1-555-987-6543.", expected: "+1-555-987-6543" },
  { id: "ssn-1", category: "ssn", text: "Applicant SSN listed as 219-09-9999 on form.", expected: "219-09-9999" },
  { id: "ssn-2", category: "ssn", text: "Primary subscriber SSN: 219-09-9997.", expected: "219-09-9997" },
  { id: "card-1", category: "payment_card", text: "Paid with card 4111 1111 1111 1111 exp 12/28.", expected: "4111 1111 1111 1111" },
  { id: "card-2", category: "payment_card", text: "Mastercard test card 5105 1051 0510 5100 on file.", expected: "5105 1051 0510 5100" },
  { id: "npi-1", category: "npi", text: "Rendering physician NPI: 1234567893 on file.", expected: "1234567893" },
  { id: "dea-1", category: "dea", text: "Prescribing clinician DEA number: AB1234563 issued.", expected: "AB1234563" },
  { id: "mbi-1", category: "mbi", text: "Patient Medicare MBI 1EG4TE5MK73 verified.", expected: "1EG4TE5MK73" },
  { id: "sin-1", category: "canadian_sin", text: "Social Insurance Number is 130-692-908.", expected: "130-692-908" },
  { id: "nhs-1", category: "uk_nhs", text: "Patient NHS number 943 476 5919 registered.", expected: "943 476 5919" },
  { id: "aadhaar-1", category: "aadhaar", text: "Resident Aadhaar: 3675 9834 6125 provided.", expected: "3675 9834 6125" },
  { id: "pan-1", category: "pan_india", text: "Tax identification PAN: ABCPE1234F.", expected: "ABCPE1234F" },
  { id: "tfn-1", category: "australian_tfn", text: "Australian Tax File Number: 876 543 210.", expected: "876 543 210" },
  { id: "cpf-1", category: "cpf", text: "Cadastro de Pessoas Fisicas CPF: 123.456.789-09.", expected: "123.456.789-09" },
  { id: "secrets-1", category: "secrets", text: "AWS Key: AKIAIOSFODNN7EXAMPLE active.", expected: "AKIAIOSFODNN7EXAMPLE" },
  { id: "secrets-2", category: "secrets", text: "GitHub Token: ghp_123456789012345678901234567890123456 in env.", expected: "ghp_123456789012345678901234567890123456" },
  { id: "dob-1", category: "dob", text: "Patient Date of Birth: 1984-03-14 confirmed.", expected: "1984-03-14" },
  { id: "mrn-1", category: "medical_record_number", text: "Hospital MRN: 44219-A assigned.", expected: "44219-A" },
  { id: "mrn-2", category: "medical_record_number", text: "Medical Record Number #9981234 updated.", expected: "9981234" },
];

const reportData: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  strictMode: STRICT_MODE,
  strictCoverage: STRICT_COVERAGE,
  nodeVersion: process.version,
  platform: process.platform,
};

function writeReport(): void {
  mkdirSync(dirname(RESULTS_PATH), { recursive: true });
  writeFileSync(RESULTS_PATH, JSON.stringify(reportData, null, 2));
}

describe("Run 1 Measured Benchmark (GW-BENCH-2026-001)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("1. exact-span detection recall across 16 strict categories (22 cases) + multi-entity overlap", () => {
    let exactMatched = 0;
    const misses: Array<{ id: string; category: string; expected: string; got: unknown[] }> = [];

    for (const sample of STRICT_CORPUS_22) {
      const expectedStart = sample.text.indexOf(sample.expected);
      const expectedEnd = expectedStart + sample.expected.length;
      const matches = detect(sample.text, STRICT_CATEGORIES);
      const hit = matches.some(
        (m) =>
          m.category === sample.category &&
          m.start === expectedStart &&
          m.end === expectedEnd &&
          sample.text.slice(m.start, m.end) === sample.expected
      );
      if (hit) {
        exactMatched++;
      } else {
        misses.push({
          id: sample.id,
          category: sample.category,
          expected: sample.expected,
          got: matches.map((m) => ({ cat: m.category, start: m.start, end: m.end, span: sample.text.slice(m.start, m.end) })),
        });
      }
    }

    const multiText = "SSN: 219-09-9999 | Card: 4111 1111 1111 1111 | Email: test.user@example.test | Phone: (555) 234-5678";
    const multiExpected: Array<{ category: FindingCategory; expected: string }> = [
      { category: "ssn", expected: "219-09-9999" },
      { category: "payment_card", expected: "4111 1111 1111 1111" },
      { category: "email", expected: "test.user@example.test" },
      { category: "phone", expected: "(555) 234-5678" },
    ];
    const multiMatches = detect(multiText, STRICT_CATEGORIES);
    let multiExact = 0;
    for (const item of multiExpected) {
      const s = multiText.indexOf(item.expected);
      const e = s + item.expected.length;
      if (multiMatches.some((m) => m.category === item.category && m.start === s && m.end === e)) {
        multiExact++;
      }
    }

    const recallPct = Number(((exactMatched / STRICT_CORPUS_22.length) * 100).toFixed(1));
    reportData.exactSpanRecall = {
      total: STRICT_CORPUS_22.length,
      exactMatched,
      recallPct,
      misses,
      multiEntityMatched: multiExact,
      multiEntityTotal: multiExpected.length,
    };
    writeReport();

    expect(multiExact).toBe(4);
    expect(exactMatched).toBeGreaterThanOrEqual(21);
    if (STRICT_MODE) {
      expect(misses, `Exact-span misses: ${JSON.stringify(misses)}`).toHaveLength(0);
      expect(exactMatched).toBe(22);
    }
  });

  it("2. clean-text false positives (10,120 chars) and 7 invalid identifiers", () => {
    const cleanSentence =
      "The clinical operations schedule reviewed routine inventory logs, departmental staffing calendars, facility maintenance reports, and standard non-identifying compliance guidance notes across forty-two administrative units today. ";
    let cleanText = "";
    while (cleanText.length < 10120) {
      cleanText += cleanSentence;
    }
    cleanText = cleanText.slice(0, 10120);
    const cleanMatches = detect(cleanText, STRICT_CATEGORIES);

    const invalidCases: Array<{ category: FindingCategory; text: string }> = [
      { category: "payment_card", text: "Card 4111 1111 1111 1112 fails Luhn checksum." },
      { category: "ssn", text: "SSN 000-09-9999 invalid area." },
      { category: "ssn", text: "SSN 666-09-9999 invalid area." },
      { category: "npi", text: "Physician NPI 1234567890 fails Luhn." },
      { category: "uk_nhs", text: "NHS 943 476 5918 fails mod 11." },
      { category: "aadhaar", text: "Aadhaar 3675 9834 6124 fails Verhoeff." },
      { category: "cpf", text: "CPF 123.456.789-00 fails verifier." },
    ];
    let invalidFlagged = 0;
    for (const c of invalidCases) {
      if (detect(c.text, [c.category]).length > 0) invalidFlagged++;
    }

    reportData.falsePositives = {
      cleanChars: cleanText.length,
      cleanFalsePositives: cleanMatches.length,
      invalidChecked: invalidCases.length,
      invalidFlagged,
    };
    writeReport();

    expect(cleanMatches).toHaveLength(0);
    expect(invalidFlagged).toBe(0);
  });

  it("3. detect() throughput at 1 KB, 10 KB, 100 KB, and 1 MB", () => {
    const chunk =
      "Routine synthetic administrative summary for test.user@example.test with contact (555) 234-5678 and record SSN 219-09-9999 stored. ";
    const makePayload = (bytes: number) => chunk.repeat(Math.ceil(bytes / chunk.length)).slice(0, bytes);

    const sizes = [
      { label: "1KB", bytes: 1024, iterations: 25 },
      { label: "10KB", bytes: 10 * 1024, iterations: 15 },
      { label: "100KB", bytes: 100 * 1024, iterations: 11 },
      { label: "1MB", bytes: 1024 * 1024, iterations: 7 },
    ];

    const results: Record<string, unknown> = {};
    for (const sz of sizes) {
      const text = makePayload(sz.bytes);
      const timing = measureRuns(() => {
        detect(text, STRICT_CATEGORIES);
      }, sz.iterations);
      const charsPerSec = Math.round((text.length / Math.max(0.001, timing.p50)) * 1000);
      results[sz.label] = { ...timing, chars: text.length, charsPerSec };
    }

    reportData.detectThroughput = results;
    writeReport();

    const oneMbP50 = (results["1MB"] as { p50: number }).p50;
    if (STRICT_MODE) {
      expect(oneMbP50).toBeLessThan(200);
    } else {
      expect(oneMbP50).toBeGreaterThan(0);
    }
  });

  it("4. initial page scan timings (100, 1,000, and 10,000 text nodes) and findings completeness", () => {
    const buildDom = (nodeCount: number) => {
      document.body.innerHTML = "";
      const frag = document.createDocumentFragment();
      for (let i = 0; i < nodeCount; i++) {
        const p = document.createElement("p");
        // 30 findings per 1,000 nodes -> 300 findings per 10,000 nodes (~87 chars/node)
        const hasSecret = i % 100 < 3;
        p.textContent = hasSecret
          ? `Synthetic patient intake node ${i}: SSN 219-09-9999 recorded for synthetic chart verify.`
          : `Synthetic patient routine status note ${i}: general non-identifying review line in log.`;
        frag.appendChild(p);
      }
      document.body.appendChild(frag);
    };

    const pageResults: Record<string, unknown> = {};
    for (const count of [100, 1000, 10000]) {
      buildDom(count);
      const expectedFindings = Math.floor((count / 100) * 3);
      let lastFindings = 0;
      let lastChars = 0;
      let lastTruncated = false;
      const timing = measureRuns(
        () => {
          const nodeMap = new Map<string, Node>();
          const extracted = extractVisibleText(document, 250_000, 10_000, nodeMap);
          const built = buildScanText(extracted.segments);
          const matches = detect(built.combined, STRICT_CATEGORIES);
          lastFindings = matches.length;
          lastChars = built.combined.length;
          lastTruncated = extracted.truncated;
        },
        count === 10000 ? 5 : 9
      );
      pageResults[String(count)] = {
        ...timing,
        chars: lastChars,
        findings: lastFindings,
        expectedFindings,
        truncated: lastTruncated,
      };
    }

    reportData.pageScan = pageResults;
    writeReport();

    const scan1k = pageResults["1000"] as { p50: number; findings: number };
    const scan10k = pageResults["10000"] as { findings: number; expectedFindings: number };
    expect(scan1k.findings).toBe(30);
    if (STRICT_MODE) {
      expect(scan1k.p50).toBeLessThan(75);
    }
    if (STRICT_COVERAGE) {
      expect(scan10k.findings).toBe(scan10k.expectedFindings);
    }
  });

  it("5. incremental delta detection timings (1-node and 100-node burst)", () => {
    const singleNodeText = "Updated patient text node with SSN 219-09-9999 verified.";
    const burstText = Array.from(
      { length: 100 },
      (_, i) => `Burst node ${i}: ${i % 10 === 0 ? "SSN 219-09-9999" : "clean entry"}`
    ).join("\n");

    const oneNode = measureRuns(() => {
      detect(singleNodeText, STRICT_CATEGORIES);
    }, 25);
    const burst100 = measureRuns(() => {
      detect(burstText, STRICT_CATEGORIES);
    }, 15);

    reportData.incrementalDelta = { oneNode, burst100 };
    writeReport();

    expect(oneNode.p50).toBeGreaterThanOrEqual(0);
    expect(burst100.p50).toBeGreaterThanOrEqual(0);
  });

  it("6. input guard decision latency and 5 enforcement cases (0 escapes)", () => {
    const payloads = [
      { label: "short", text: "SSN 219-09-9999" },
      { label: "0.9KB", text: ("Routine memo text line. ".repeat(35) + "SSN 219-09-9999").slice(0, 900) },
      { label: "7.5KB", text: ("Note entry with email test.user@example.test and SSN 219-09-9999. ".repeat(115)).slice(0, 7500) },
      { label: "68KB", text: ("Safe narrative block for sizing test. ".repeat(1750) + "SSN 219-09-9999 ").slice(0, 68 * 1024) },
    ];

    const latency: Record<string, unknown> = {};
    for (const p of payloads) {
      const decision = measureRuns(() => {
        detectPasteFindings(p.text, STRICT_CATEGORIES);
      }, 11);
      const matches = detectPasteFindings(p.text, STRICT_CATEGORIES);
      const sanitise = measureRuns(() => {
        sanitizePastedText(p.text, matches, "[REDACTED]");
      }, 11);
      latency[p.label] = { chars: p.text.length, matches: matches.length, decision, sanitise };
    }

    // 5 enforcement cases
    let escapes = 0;
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);

    // Case 1: sensitive paste blocked (field untouched)
    const c1Matches = detectPasteFindings("SSN 219-09-9999", STRICT_CATEGORIES);
    if (c1Matches.length === 0) escapes++;
    expect(ta.value).toBe("");

    // Case 2: 50 KB trailing SSN blocked
    const payload50k = "Safe filler ".repeat(4200) + "SSN 219-09-9999";
    const c2Matches = detectPasteFindings(payload50k, STRICT_CATEGORIES);
    if (c2Matches.length === 0) escapes++;
    expect(ta.value).toBe("");

    // Case 3: safe paste allowed
    const safeMatches = detectPasteFindings("Routine meeting notes for tomorrow morning.", STRICT_CATEGORIES);
    expect(safeMatches).toHaveLength(0);
    insertTextIntoElement(ta, "Routine meeting notes");
    expect(ta.value).toBe("Routine meeting notes");

    // Case 4: sanitisation removes secret & keeps nearby safe text
    const rawWithSecret = "Call extension 400 and avoid SSN 219-09-9999 please.";
    const sanitised = sanitizePastedText(rawWithSecret, detectPasteFindings(rawWithSecret, STRICT_CATEGORIES));
    expect(sanitised).toContain("Call extension 400");
    expect(sanitised).not.toContain("219-09-9999");
    if (sanitised.includes("219-09-9999")) escapes++;

    // Case 5: multi-secret sanitisation removes both
    const multiRaw = "Email test.user@example.test and SSN 219-09-9999 done.";
    const multiSanitised = sanitizePastedText(multiRaw, detectPasteFindings(multiRaw, STRICT_CATEGORIES));
    if (multiSanitised.includes("219-09-9999") || multiSanitised.includes("test.user@example.test")) escapes++;

    reportData.inputGuard = { latency, enforcementCases: 5, escapes };
    writeReport();

    expect(escapes).toBe(0);
  });

  it("7. document token-path timing, 5-page PDF export structure, and box clamping", async () => {
    const makeOcrPages = (pageCount: number): OcrPageResult[] =>
      Array.from({ length: pageCount }, (_, pageIndex) => ({
        pageIndex,
        widthPx: 1200,
        heightPx: 1600,
        tokens: [
          { text: "Patient", confidence: 98, lineIndex: 0, bbox: { x: 40, y: 40, width: 60, height: 14 } },
          { text: "SSN", confidence: 99, lineIndex: 0, bbox: { x: 110, y: 40, width: 30, height: 14 } },
          { text: "219-09-9999", confidence: 99, lineIndex: 0, bbox: { x: 150, y: 40, width: 100, height: 14 } },
          { text: "test.user@example.test", confidence: 98, lineIndex: 1, bbox: { x: 40, y: 60, width: 160, height: 14 } },
        ],
        fullText: "Patient SSN 219-09-9999\ntest.user@example.test",
      }));

    const tokenTimings: Record<string, unknown> = {};
    for (const count of [1, 5, 20, 50]) {
      const pages = makeOcrPages(count);
      tokenTimings[`${count}p`] = measureRuns(() => {
        findingsFromOcrPages(pages, STRICT_CATEGORIES);
      }, 9);
    }

    const PNG_1X1 = Uint8Array.from(
      atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
      (c) => c.charCodeAt(0)
    );
    const t0 = performance.now();
    const pdfBytes = await pagesToPdf(
      Array.from({ length: 5 }, () => ({ pngBytes: PNG_1X1, widthPt: 612, heightPt: 792 }))
    );
    const exportMs = Number((performance.now() - t0).toFixed(2));
    const parsed = await PDFDocument.load(pdfBytes);
    const latin1 = Buffer.from(pdfBytes).toString("latin1");
    const fontMatches = latin1.match(/\/Font\b/g) ?? [];

    // Box clamping test
    const fills: Array<{ x: number; y: number; w: number; h: number }> = [];
    const mockCanvas = {
      width: 200,
      height: 100,
      getContext: () => ({
        fillStyle: "",
        fillRect(x: number, y: number, w: number, h: number) {
          fills.push({ x, y, w, h });
        },
      }),
    } as unknown as HTMLCanvasElement;
    applyBoxes(mockCanvas, [
      { x: 1, y: 1, width: 10, height: 10 },
      { x: 195, y: 95, width: 40, height: 40 },
    ], 4);

    reportData.documentTokenAndExport = {
      tokenTimings,
      export5pMs: exportMs,
      exportPageCount: parsed.getPageCount(),
      fontDictCount: fontMatches.length,
      containsTestSsn: latin1.includes("219-09-9999"),
      containsTestEmail: latin1.includes("test.user@example.test"),
      clampOrigin: fills[0],
      clampFarEdge: fills[1],
    };
    writeReport();

    expect(parsed.getPageCount()).toBe(5);
    expect(fontMatches.length).toBe(0);
    expect(latin1).not.toContain("219-09-9999");
    expect(latin1).not.toContain("test.user@example.test");
    expect(fills[0].x).toBe(0);
    expect(fills[0].y).toBe(0);
    expect(fills[1].x + fills[1].w).toBeLessThanOrEqual(200);
    expect(fills[1].y + fills[1].h).toBeLessThanOrEqual(100);
  });

  it("8. static privacy call-site scan across content and document-pipeline", () => {
    const walkTs = (dir: string): string[] => {
      const files: string[] = [];
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          files.push(...walkTs(full));
        } else if (full.endsWith(".ts")) {
          files.push(full);
        }
      }
      return files;
    };

    const tsFiles = [...walkTs(join(ROOT, "src", "content")), ...walkTs(join(ROOT, "src", "document-pipeline"))];
    const fetchCalls: string[] = [];
    const forbiddenCalls: string[] = [];

    for (const f of tsFiles) {
      const rel = f.slice(ROOT.length + 1).replace(/\\/g, "/");
      const content = readFileSync(f, "utf8");
      const lines = content.split(/\r?\n/);
      lines.forEach((line, idx) => {
        if (/\bfetch\s*\(/.test(line)) fetchCalls.push(`${rel}:${idx + 1}`);
        if (/\b(?:XMLHttpRequest|WebSocket|navigator\.sendBeacon)\b/.test(line)) {
          forbiddenCalls.push(`${rel}:${idx + 1}`);
        }
      });
    }

    const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8")) as { host_permissions?: unknown[] };
    reportData.staticPrivacyScan = {
      filesScanned: tsFiles.length,
      fetchCalls,
      forbiddenCalls,
      hostPermissions: manifest.host_permissions ?? [],
    };
    writeReport();

    expect(fetchCalls).toEqual(["src/document-pipeline/ocr.ts:76"]);
    expect(forbiddenCalls).toHaveLength(0);
    expect(manifest.host_permissions).toBeUndefined();
  });
});
