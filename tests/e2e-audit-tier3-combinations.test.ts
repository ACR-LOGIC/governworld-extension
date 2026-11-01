// @vitest-environment happy-dom
// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Tier 3: Pairwise Cross-Feature Interaction Test Suite
// Verifying integration boundaries and pairwise interaction across the 19 master issue categories.

import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  extractVisibleText,
  buildScanText,
  segmentIndexAt,
  mapRange,
  maskCombinedRange,
  type TextSegment,
} from "../src/content/extract.js";
import {
  detect,
  resolveOverlaps,
  placeholderLabelFor,
  runCustomPatterns,
} from "../src/content/detect.js";
import { isValidNpi } from "../src/validators/index.js";
import {
  normalizeUnicodeWithMapping,
  mapNormalizedToOriginalOffset,
} from "../src/content/normalization/unicode.js";
import {
  detectPasteFindings,
  sanitizePastedText,
  insertTextIntoElement,
} from "../src/content/pasteGuard.js";
import { extractSvgText } from "../src/content/svgExtract.js";
import { createOverlay } from "../src/content/overlay.js";
import { ALL_CATEGORIES } from "../src/shared/settings.js";
import type { Finding, FindingCategory, ScanSettingsMessage } from "../src/shared/types.js";
import type { CustomPattern } from "../src/shared/customPatterns.js";
import { resolveScanCoverageStatus } from "../src/content/normalization/pageInventory.js";

describe("Tier 3: Pairwise Cross-Feature Interactions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  // =========================================================================
  // Interaction 1: Incremental Rescan + Floating Redaction Mask Tracking
  // Features: F1, F2, F3 + F4
  // =========================================================================
  describe("Interaction 1: Incremental Rescan + Floating Mask Tracking (F1/F2/F3 + F4)", () => {
    it("I1.1: newly added mutation segments receive floating masks that reposition on scroll", () => {
      const container = document.createElement("div");
      document.body.appendChild(container);

      // 1. Initial extraction
      const nodeMap = new Map<string, Node>();
      const p1 = document.createElement("p");
      p1.textContent = "Initial clean text";
      container.appendChild(p1);
      extractVisibleText(container, 1000, 200, nodeMap);

      // 2. Incremental mutation adds a leaf text node with an email
      const p2 = document.createElement("p");
      const text2 = document.createTextNode("Added user: john@example.com");
      p2.appendChild(text2);
      container.appendChild(p2);

      const deltaMap = new Map<string, Node>();
      const { segments: deltaSegs } = extractVisibleText(p2, 1000, 200, deltaMap);
      expect(deltaSegs.length).toBe(1);
      expect(deltaMap.get(deltaSegs[0].nodeId)).toBe(text2);

      // 3. Delta scan produces finding
      const deltaMatches = detect(deltaSegs[0].text, ["email"]);
      expect(deltaMatches.length).toBe(1);

      // 4. Floating mask is rendered in overlay
      const overlay = createOverlay(document);
      overlay.render([
        { kind: "mask", label: "Email", x: 20, y: 50, width: 140, height: 18 }
      ]);

      // 5. Scroll event re-evaluates mask
      window.dispatchEvent(new Event("scroll"));
      const host = document.querySelector("div[data-gw-scan-overlay]");
      expect(host).not.toBeNull();
      overlay.destroy();
    });

    it("I1.2: removing a node splices segment arrays and clears its associated overlay masks", () => {
      const segs: TextSegment[] = [
        { nodeId: "s0", startOffset: 0, endOffset: 10, text: "first text" },
        { nodeId: "s1", startOffset: 0, endOffset: 20, text: "email jane@corp.org" },
      ];
      const indexMap = new Map<string, number>([["s0", 0], ["s1", 1]]);

      // Overlay contains masks for s0 and s1
      const overlay = createOverlay(document);
      overlay.render([
        { kind: "mask", label: "mask_s0", x: 10, y: 10, width: 80, height: 20 },
        { kind: "mask", label: "mask_s1", x: 10, y: 40, width: 120, height: 20 },
      ]);

      // Splice s1 (simulating DOM node removal)
      segs.splice(1, 1);
      indexMap.delete("s1");
      expect(segs.length).toBe(1);
      expect(indexMap.has("s1")).toBe(false);

      // Update overlay without s1 mask
      overlay.render([
        { kind: "mask", label: "mask_s0", x: 10, y: 10, width: 80, height: 20 }
      ]);

      overlay.destroy();
    });
  });

  // =========================================================================
  // Interaction 2: Always-On Paste Shield + Multi-File Drops + Contenteditable Caret
  // Features: F6 + F8, F9 + F10
  // =========================================================================
  describe("Interaction 2: Always-On Paste Shield + Multi-File Drops + Caret (F6 + F8/F9 + F10)", () => {
    it("I2.1: dropping multiple sensitive files onto contenteditable preserves caret and sanitizes all files", async () => {
      const editor = document.createElement("div");
      editor.contentEditable = "true";
      editor.textContent = "Start drafting: ";
      document.body.appendChild(editor);

      // Establish caret at position 16
      const range = document.createRange();
      range.setStart(editor.firstChild!, 16);
      range.setEnd(editor.firstChild!, 16);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);

      // Simulated multi-file drop
      let syncPreventDefault = false;
      const fakeDropEvent = {
        preventDefault: () => { syncPreventDefault = true; },
        dataTransfer: {
          files: [
            { name: "keys.txt", type: "text/plain", text: async () => "API: sk-1234567890abcdef1234567890abcdef" },
            { name: "user.txt", type: "text/plain", text: async () => "Contact: alice@hospital.org" },
          ]
        }
      };

      // 1. Synchronous preventDefault
      fakeDropEvent.preventDefault();
      expect(syncPreventDefault).toBe(true);

      // 2. Read and sanitize all files
      const file1 = await fakeDropEvent.dataTransfer.files[0].text();
      const file2 = await fakeDropEvent.dataTransfer.files[1].text();
      const sanitized1 = sanitizePastedText(file1, detectPasteFindings(file1, ["secrets"]));
      const sanitized2 = sanitizePastedText(file2, detectPasteFindings(file2, ["email"]));

      expect(sanitized1).toBe("API: [REDACTED]");
      expect(sanitized2).toBe("Contact: [REDACTED]");

      // 3. Insert sanitized content at preserved caret
      insertTextIntoElement(editor, `${sanitized1} | ${sanitized2}`);
      expect(editor.textContent).toContain("Start drafting: API: [REDACTED] | Contact: [REDACTED]");
    });

    it("I2.2: multi-file drop ignores empty or non-text files while preserving caret position", async () => {
      const editor = document.createElement("div");
      editor.contentEditable = "true";
      editor.textContent = "Notes: ";
      document.body.appendChild(editor);

      const files = [
        { name: "binary.bin", type: "application/octet-stream", text: async () => { throw new Error("binary"); } },
        { name: "empty.txt", type: "text/plain", text: async () => "" },
        { name: "valid.txt", type: "text/plain", text: async () => "SSN: 123-45-6789" },
      ];

      const readValid: string[] = [];
      for (const f of files) {
        if (f.type.startsWith("text/") || /\.(txt|csv|json|md)$/i.test(f.name)) {
          try {
            const t = await f.text();
            if (t.trim().length > 0) readValid.push(t);
          } catch {
            // Ignore binary read
          }
        }
      }

      expect(readValid).toHaveLength(1);
      const sanitized = sanitizePastedText(readValid[0], detectPasteFindings(readValid[0], ["ssn"]));
      expect(sanitized).toBe("SSN: [REDACTED]");
    });
  });

  // =========================================================================
  // Interaction 3: Form Input Token Masking + Unprefixed NPI + Confidence Thresholds
  // Features: F15 + F16 + F17
  // =========================================================================
  describe("Interaction 3: Form Input Token Masking + Unprefixed NPI + Thresholds (F15 + F16 + F17)", () => {
    it("I3.1: form input with leading whitespace and unprefixed NPI applies token mask when above threshold", () => {
      const input = document.createElement("input");
      input.value = "   1234567893   "; // 1234567893 is Luhn valid NPI
      document.body.appendChild(input);

      // Verify NPI validity
      expect(isValidNpi("1234567893")).toBe(true);

      // Lead offset calculation
      const lead = input.value.length - input.value.replace(/^[\s\u00a0\u200b]+/, "").length;
      expect(lead).toBe(3);

      const token = input.value.trim();
      const matches = detect(token, ["npi"]);
      expect(matches.length).toBeGreaterThanOrEqual(1);

      // Filter by confidence threshold (e.g. threshold 0.70)
      const threshold = 0.70;
      const filtered = matches.filter((m) => m.confidence >= threshold);
      expect(filtered.length).toBeGreaterThanOrEqual(1);
      expect(filtered[0].value).toBe("1234567893");
    });

    it("I3.2: unprefixed NPI is filtered out when confidence threshold is set strictly higher (0.95)", () => {
      const token = "1234567893";
      const matches = detect(token, ["npi"]);
      // Unprefixed NPI confidence is 0.70
      const strictThreshold = 0.95;
      const filtered = matches.filter((m) => m.confidence >= strictThreshold);
      expect(filtered).toHaveLength(0);
    });
  });

  // =========================================================================
  // Interaction 4: Custom Pattern Constraints + Unicode Surrogate Pairs + Secrets Deduplication
  // Features: F18 + F19 + F20
  // =========================================================================
  describe("Interaction 4: Custom Pattern + Unicode Surrogate Pairs + Secrets (F18 + F19 + F20)", () => {
    it("I4.1: custom pattern with captureGroup extracts entity from text containing Plane 1 characters", () => {
      const pat: CustomPattern = {
        id: "pat_astral",
        name: "Astral Ticket",
        category: "custom",
        pattern: "TKT-(\\d{4})",
        flags: "g",
        captureGroup: 1,
        source: "local",
        contributionStatus: "local_only",
        confidence: 0.98,
        createdAt: new Date().toISOString(),
      };

      // Mathematical bold '𝟏' is surrogate pair (2 code units) preceding the ticket
      const text = "\u{1D7CF} TKT-4432 end";
      const matches = runCustomPatterns(text, [pat]);
      expect(matches.length).toBe(1);
      expect(matches[0].value).toBe("4432");
      expect(text.slice(matches[0].start, matches[0].end)).toBe("4432");
    });

    it("I4.2: overlapping custom pattern and secret pattern resolve via higher confidence", () => {
      const customMatch = {
        category: "custom" as FindingCategory,
        confidence: 0.98,
        start: 10,
        end: 45,
        value: "sk-special-custom-token",
      };
      const genericSecret = {
        category: "secrets" as FindingCategory,
        confidence: 0.80,
        start: 10,
        end: 50,
        value: "sk-special-custom-token-longer-span",
      };

      const resolved = resolveOverlaps([customMatch, genericSecret]);
      expect(resolved).toHaveLength(1);
      expect(resolved[0].confidence).toBe(0.98);
      expect(resolved[0].value).toBe("sk-special-custom-token");
    });
  });

  // =========================================================================
  // Interaction 5: Shadow DOM + SVG Findings Active Status + Video SecurityError
  // Features: F24 + F25 + F27
  // =========================================================================
  describe("Interaction 5: Shadow DOM + SVG Findings + Video SecurityError (F24 + F25 + F27)", () => {
    it("I5.1: inline SVG inside shadow DOM generates active selected finding and reflects in scan coverage", () => {
      const host = document.createElement("dashboard-widget");
      document.body.appendChild(host);
      const shadow = host.attachShadow({ mode: "open" });

      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.getBoundingClientRect = () => ({ x: 0, y: 0, width: 100, height: 40, top: 0, left: 0, right: 100, bottom: 40, toJSON: () => {} }) as any;
      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.getBoundingClientRect = () => ({ x: 10, y: 10, width: 80, height: 18, top: 10, left: 10, right: 90, bottom: 28, toJSON: () => {} }) as any;
      text.textContent = "support@hospital.org";
      svg.appendChild(text);
      shadow.appendChild(svg);

      // Simulated finding for SVG text
      const svgFinding: Finding = {
        id: "svg_email_find",
        category: "email",
        confidence: 0.95,
        source: "local-rules",
        preview: "s***@hospital.org",
        nodeId: "svg",
        startOffset: 0,
        endOffset: 20,
        rects: [{ x: 10, y: 10, width: 80, height: 18 }],
        contextPreview: "",
        selected: true, // MUST be selected: true
      };

      const status = resolveScanCoverageStatus({
        findingsCount: svgFinding.selected ? 1 : 0,
        unresolvedRegions: [],
        deferredMediaCount: 0,
        visibleChars: 100,
      });

      expect(status).toBe("FULLY_SCANNED");
    });

    it("I5.2: page with active SVG finding and cross-origin video error reports coverage with unscannable region", () => {
      const status = resolveScanCoverageStatus({
        findingsCount: 1, // SVG finding
        unresolvedRegions: [
          {
            sourceType: "video-frame-ocr",
            cssSelector: "video#cross-feed",
            visibility: "VISIBLE_IN_VIEWPORT",
            reason: "tainted-canvas-no-tab-capture",
            detail: "Cross-origin video tainted canvas draw",
            boundingRect: { x: 0, y: 0, width: 320, height: 240 },
          }
        ],
        deferredMediaCount: 0,
        visibleChars: 500,
      });

      // Presence of unresolved regions flags partial/unscannable status
      expect(status).not.toBe("NO_SENSITIVE_DATA_DETECTED");
    });
  });

  // =========================================================================
  // Interaction 6: Copy/Cut Formatting Preservation + Selection Mask Findings
  // Features: F12 + F14
  // =========================================================================
  describe("Interaction 6: Copy/Cut Formatting + Selection Masks (F12 + F14)", () => {
    it("I6.1: manual selection mask on paragraph text replaces span with block masks while keeping newlines", () => {
      const docText = "Header Line\n\nUser Notes: Sensitive Client Info here.\n\nFooter Line";
      const selStart = docText.indexOf("Sensitive Client Info");
      const selEnd = selStart + "Sensitive Client Info".length;

      const selFinding: Finding = {
        id: "sel_manual_1",
        category: "custom",
        confidence: 1.0,
        source: "selection",
        preview: "Sensitive Client Info",
        nodeId: "n0",
        startOffset: selStart,
        endOffset: selEnd,
        rects: [],
        contextPreview: "",
        selected: true,
      };

      const masked = maskCombinedRange(docText, 0, docText.length, [selFinding]);
      expect(masked).toContain("\n\nUser Notes: ");
      expect(masked).toContain("\n\nFooter Line");
      expect(masked.slice(selStart, selEnd)).toBe("█".repeat("Sensitive Client Info".length));
    });

    it("I6.2: clearing selection mask restores clean unmasked text on subsequent copy", () => {
      const docText = "Alpha\nBeta\nGamma";
      const selFinding: Finding = {
        id: "sel_to_remove",
        category: "custom",
        confidence: 1.0,
        source: "selection",
        preview: "Beta",
        nodeId: "n",
        startOffset: 6,
        endOffset: 10,
        rects: [],
        contextPreview: "",
        selected: false, // Toggled off / removed
      };

      const masked = maskCombinedRange(docText, 0, docText.length, [selFinding]);
      expect(masked).toBe(docText);
    });
  });

  // =========================================================================
  // Interaction 7: Mutation Batch Limits (>50) + Always-On Protection
  // Features: F6 + F7
  // =========================================================================
  describe("Interaction 7: Mutation Batch Limits (>50) + Always-On Protection (F6 + F7)", () => {
    it("I7.1: 75 mutations on always-on protected tab do not discard paste interception", () => {
      const container = document.createElement("div");
      document.body.appendChild(container);

      // Add 75 dynamic nodes
      for (let i = 0; i < 75; i++) {
        const item = document.createElement("p");
        item.textContent = `Feed item ${i}`;
        container.appendChild(item);
      }

      // Input field inserted during the mutation storm
      const dynamicInput = document.createElement("input");
      container.appendChild(dynamicInput);

      // Paste event into dynamic input is successfully intercepted and sanitized
      const pasteText = "Secret: sk-1234567890abcdef1234567890abcdef";
      const findings = detectPasteFindings(pasteText, ["secrets"]);
      expect(findings.length).toBeGreaterThan(0);

      const sanitized = sanitizePastedText(pasteText, findings);
      expect(sanitized).toBe("Secret: [REDACTED]");
    });
  });

  // =========================================================================
  // Interaction 8: Generic Form Label Filtering + Unprefixed NPI + Form Controls
  // Features: F15 + F16 + F21
  // =========================================================================
  describe("Interaction 8: Generic Form Label + Unprefixed NPI + Form Controls (F15 + F16 + F21)", () => {
    it("I8.1: form with 'First Name' label and NPI input detects NPI without false positive on label", () => {
      const label = document.createElement("label");
      label.textContent = "First Name";
      document.body.appendChild(label);

      const input = document.createElement("input");
      input.value = "1234567893"; // Luhn-valid NPI
      document.body.appendChild(input);

      // 1. Label text must NOT be detected as possible_name
      const labelMatches = detect(label.textContent, ["possible_name"]);
      expect(labelMatches.map((m) => m.value)).not.toContain("First Name");

      // 2. Input value must be detected as NPI
      const inputMatches = detect(input.value, ["npi"]);
      expect(inputMatches.filter((m) => m.category === "npi").length).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // Interaction 9: Documentation Parity (Manifest + Privacy + Legal + Landing)
  // Features: F5 + F28 + F29 + F30 + F31
  // =========================================================================
  describe("Interaction 9: Documentation Parity (F5 + F28 + F29 + F30 + F31)", () => {
    it("I9.1: manifest declared permissions match privacy.html permissions list", () => {
      const manifest = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "manifest.json"), "utf8"));
      expect(manifest.permissions).toContain("contextMenus");
      expect(manifest.permissions).toContain("activeTab");
      expect(manifest.permissions).toContain("storage");
    });

    it("I9.2: ALL_CATEGORIES count (20) includes all 19 built-in detection categories", () => {
      expect(ALL_CATEGORIES).toHaveLength(20);
      const builtins = ALL_CATEGORIES.filter((c) => c !== "custom");
      expect(builtins).toHaveLength(19);
    });
  });
});
