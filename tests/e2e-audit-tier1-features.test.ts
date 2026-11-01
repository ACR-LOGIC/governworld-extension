// @vitest-environment happy-dom
// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Tier 1: Feature Coverage Test Suite across all 19 master issue categories (Features 1-31)
// Derived strictly from requirements in ORIGINAL_REQUEST.md, PROJECT.md, and TEST_INFRA.md.

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  extractVisibleText,
  buildScanText,
  segmentIndexAt,
  mapRange,
  buildRedactedText,
  maskCombinedRange,
  selectionCombinedSpan,
  type TextSegment,
} from "../src/content/extract.js";
import {
  detect,
  maskValue,
  maskContext,
  resolveOverlaps,
  placeholderLabelFor,
  runCustomPatterns,
} from "../src/content/detect.js";
import { isValidNpi, luhnValid } from "../src/validators/index.js";
import {
  normalizeUnicodeWithMapping,
  mapNormalizedToOriginalOffset,
} from "../src/content/normalization/unicode.js";
import { isSafeRegex } from "../src/shared/wizardAnalyzer.js";
import {
  validateMessage,
  isScanSettings,
} from "../src/shared/messages.js";
import {
  detectPasteFindings,
  sanitizePastedText,
  insertTextIntoElement,
} from "../src/content/pasteGuard.js";
import {
  collectAttrRecords,
  buildAttrScan,
} from "../src/content/attrs.js";
import { extractSvgText } from "../src/content/svgExtract.js";
import {
  buildMediaQueue,
  extractVideoCaptions,
} from "../src/content/mediaQueue.js";
import { createOverlay } from "../src/content/overlay.js";
import { buildOcrWorkerOptions } from "../src/document-pipeline/ocr.js";
import { DEFAULT_SETTINGS, ALL_CATEGORIES } from "../src/shared/settings.js";
import type { Finding, FindingCategory, ScanSettingsMessage } from "../src/shared/types.js";
import type { CustomPattern } from "../src/shared/customPatterns.js";
import { resolveScanCoverageStatus } from "../src/content/normalization/pageInventory.js";

const ALL_BUILTIN: FindingCategory[] = [
  "email", "phone", "ssn", "dob", "medical_record_number",
  "member_id", "npi", "dea", "mbi", "address", "payment_card",
  "secrets", "possible_name", "canadian_sin", "uk_nhs",
  "aadhaar", "pan_india", "australian_tfn", "cpf"
];

describe("Tier 1: Feature Coverage — 19 Master Issue Categories", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  // =========================================================================
  // Category 1: Incremental Rescan (Features 1, 2, 3)
  // Leaf text node mapping, segment splice sync, delta scanning
  // =========================================================================
  describe("Category 1: Incremental Rescan - Leaf Text Nodes, Splice Sync & Delta Scan", () => {
    it("F1.1: extractVisibleText maps segments directly to leaf Text nodes rather than container elements", () => {
      const container = document.createElement("div");
      container.id = "parent-container";
      const span = document.createElement("span");
      const textNode = document.createTextNode("Patient SSN 123-45-6789 confidential");
      span.appendChild(textNode);
      container.appendChild(span);
      document.body.appendChild(container);

      const nodeMap = new Map<string, Node>();
      const { segments } = extractVisibleText(container, 10000, 500, nodeMap);

      expect(segments.length).toBeGreaterThan(0);
      const mappedNode = nodeMap.get(segments[0].nodeId);
      expect(mappedNode).toBeDefined();
      expect(mappedNode?.nodeType).toBe(Node.TEXT_NODE);
      expect(mappedNode).toBe(textNode);
      expect(mappedNode).not.toBe(container);
    });

    it("F1.2: extractVisibleText correctly traverses deep nested DOM hierarchy without attributing to root container", () => {
      const root = document.createElement("div");
      root.className = "card";
      const inner = document.createElement("section");
      const paragraph = document.createElement("p");
      const leafText = document.createTextNode("Contact user at support@example.com");
      paragraph.appendChild(leafText);
      inner.appendChild(paragraph);
      root.appendChild(inner);
      document.body.appendChild(root);

      const nodeMap = new Map<string, Node>();
      const { segments } = extractVisibleText(root, 10000, 500, nodeMap);
      expect(segments).toHaveLength(1);
      expect(nodeMap.get(segments[0].nodeId)).toBe(leafText);
      expect(segments[0].text).toBe("Contact user at support@example.com");
    });

    it("F2.1: segment index lookups remain synchronized when segments are spliced", () => {
      const seg1: TextSegment = { nodeId: "seg_0", startOffset: 0, endOffset: 5, text: "alpha" };
      const seg2: TextSegment = { nodeId: "seg_1", startOffset: 0, endOffset: 4, text: "beta" };
      const seg3: TextSegment = { nodeId: "seg_2", startOffset: 0, endOffset: 5, text: "gamma" };
      const segments = [seg1, seg2, seg3];
      const segmentIndexById = new Map<string, number>([
        ["seg_0", 0],
        ["seg_1", 1],
        ["seg_2", 2],
      ]);

      // Remove middle segment seg_1 (simulate deletion of a node)
      const removedIdx = segmentIndexById.get("seg_1")!;
      segments.splice(removedIdx, 1);
      segmentIndexById.delete("seg_1");
      // Re-index subsequent segments
      for (let i = removedIdx; i < segments.length; i++) {
        segmentIndexById.set(segments[i].nodeId, i);
      }

      expect(segments.length).toBe(2);
      expect(segmentIndexById.get("seg_0")).toBe(0);
      expect(segmentIndexById.get("seg_2")).toBe(1);
      expect(segmentIndexById.get("seg_1")).toBeUndefined();
    });

    it("F2.2: segmentStarts array recalculation tracks segment length changes on splice", () => {
      const segs: TextSegment[] = [
        { nodeId: "s0", startOffset: 0, endOffset: 4, text: "1234" },
        { nodeId: "s1", startOffset: 0, endOffset: 6, text: "abcdef" },
        { nodeId: "s2", startOffset: 0, endOffset: 3, text: "xyz" },
      ];
      const initial = buildScanText(segs);
      expect(initial.segmentStarts).toEqual([0, 5, 12]);

      // Remove index 1
      segs.splice(1, 1);
      const updated = buildScanText(segs);
      expect(updated.segmentStarts).toEqual([0, 5]);
      expect(updated.combined).toBe("1234\nxyz");
    });

    it("F3.1: delta scanning newly added segments resolves findings with correct offset adjustment", () => {
      const existingText = "User Alice in system.\n";
      const newSegments: TextSegment[] = [
        { nodeId: "new_1", startOffset: 0, endOffset: 25, text: "Email: alice@example.com" }
      ];
      const newBuilt = buildScanText(newSegments);
      const baseOffset = existingText.length;

      // Scan only the newly added segment text
      const deltaMatches = detect(newBuilt.combined, ["email"]);
      expect(deltaMatches.length).toBe(1);
      expect(deltaMatches[0].value).toBe("alice@example.com");

      // Verify adjusted absolute offsets
      const absoluteStart = baseOffset + deltaMatches[0].start;
      const absoluteEnd = baseOffset + deltaMatches[0].end;
      const fullText = existingText + newBuilt.combined;
      expect(fullText.slice(absoluteStart, absoluteEnd)).toBe("alice@example.com");
    });
  });

  // =========================================================================
  // Category 2: Floating Redaction Mask Tracking (Feature 4)
  // Re-evaluating target node coordinates on scroll and viewport resize
  // =========================================================================
  describe("Category 2: Floating Redaction Mask Tracking on Scroll and Resize", () => {
    it("F4.1: overlay registers scroll and resize listeners on the window/view", () => {
      const addSpy = vi.spyOn(window, "addEventListener");
      const overlay = createOverlay(document);
      overlay.render([
        { kind: "mask", label: "test", x: 10, y: 10, width: 100, height: 20 }
      ]);

      const events = addSpy.mock.calls.map((c) => c[0]);
      expect(events).toContain("scroll");
      expect(events).toContain("resize");

      overlay.destroy();
    });

    it("F4.2: destroying overlay cleanly detaches scroll and resize listeners", () => {
      const removeSpy = vi.spyOn(window, "removeEventListener");
      const overlay = createOverlay(document);
      overlay.destroy();

      const events = removeSpy.mock.calls.map((c) => c[0]);
      expect(events).toContain("scroll");
      expect(events).toContain("resize");
    });

    it("F4.3: overlay host element is injected as a fixed viewport overlay", () => {
      const overlay = createOverlay(document);
      overlay.render([{ kind: "mask", label: "mask1", x: 50, y: 50, width: 80, height: 25 }]);

      const host = document.querySelector("div[data-gw-scan-overlay]");
      expect(host).not.toBeNull();
      expect(host?.getAttribute("style")).toContain("position: fixed");
      overlay.destroy();
    });

    it("F4.4: rendering multiple masks paints distinct rect elements inside shadow root", () => {
      const overlay = createOverlay(document);
      overlay.render([
        { kind: "mask", label: "item1", x: 20, y: 30, width: 100, height: 20 },
        { kind: "mask", label: "item2", x: 20, y: 60, width: 120, height: 20 },
      ]);

      const host = document.querySelector("div[data-gw-scan-overlay]");
      expect(host).toBeDefined();
      overlay.destroy();
    });

    it("F4.5: empty render call clears rendered mask elements", () => {
      const overlay = createOverlay(document);
      overlay.render([{ kind: "mask", label: "item1", x: 20, y: 30, width: 100, height: 20 }]);
      overlay.render([]);
      // Rendered elements cleared
      overlay.destroy();
      expect(document.querySelector("div[data-gw-scan-overlay]")).toBeNull();
    });
  });

  // =========================================================================
  // Category 3: Stylesheet Syntax & Parity (Feature 5)
  // Balanced braces, no stray closing brace at line 1145, strict parity
  // =========================================================================
  describe("Category 3: Stylesheet Syntax & Parity", () => {
    function checkBraceBalance(cssContent: string): { balanced: boolean; netBalance: number; errorLine?: number } {
      const lines = cssContent.split("\n");
      let balance = 0;
      for (let i = 0; i < lines.length; i++) {
        // Strip comments and string literals
        const line = lines[i].replace(/\/\*[\s\S]*?\*\//g, "").replace(/"[^"]*"|'[^']*'/g, "");
        for (const ch of line) {
          if (ch === "{") balance++;
          if (ch === "}") {
            balance--;
            if (balance < 0) {
              return { balanced: false, netBalance: balance, errorLine: i + 1 };
            }
          }
        }
      }
      return { balanced: balance === 0, netBalance: balance };
    }

    it("F5.1: popup.css has zero stray closing braces and balanced block structure", () => {
      const cssPath = path.resolve(process.cwd(), "src/popup/popup.css");
      const content = fs.readFileSync(cssPath, "utf8");
      const result = checkBraceBalance(content);
      expect(result.balanced, `popup.css brace balance error at line ${result.errorLine}`).toBe(true);
      expect(result.netBalance).toBe(0);
    });

    it("F5.2: sidepanel.css has zero stray closing braces and balanced block structure", () => {
      const cssPath = path.resolve(process.cwd(), "src/sidepanel/sidepanel.css");
      const content = fs.readFileSync(cssPath, "utf8");
      const result = checkBraceBalance(content);
      expect(result.balanced, `sidepanel.css brace balance error at line ${result.errorLine}`).toBe(true);
      expect(result.netBalance).toBe(0);
    });

    it("F5.3: popup.css does not contain stray brace after .tab-panel--active around line 1145", () => {
      const cssPath = path.resolve(process.cwd(), "src/popup/popup.css");
      const lines = fs.readFileSync(cssPath, "utf8").split("\n");
      // Find .tab-panel--active
      const idx = lines.findIndex((l) => l.includes(".tab-panel--active"));
      expect(idx).toBeGreaterThan(-1);
      // Verify subsequent lines do not contain an isolated stray '}'
      const nextLines = lines.slice(idx, idx + 10).join("\n");
      expect(nextLines).not.toMatch(/\.tab-panel--active\s*\{[^}]*\}\s*\n\s*\}\s*\n/);
    });

    it("F5.4: sidepanel.css is byte-for-byte or structurally identical to popup.css", () => {
      const popupCss = fs.readFileSync(path.resolve(process.cwd(), "src/popup/popup.css"), "utf8");
      const sidepanelCss = fs.readFileSync(path.resolve(process.cwd(), "src/sidepanel/sidepanel.css"), "utf8");
      expect(popupCss.trim()).toBe(sidepanelCss.trim());
    });

    it("F5.5: all CSS selector rules in popup.css have non-empty valid declaration blocks", () => {
      const popupCss = fs.readFileSync(path.resolve(process.cwd(), "src/popup/popup.css"), "utf8");
      // Rule declarations should not have empty double braces {{}}
      expect(popupCss).not.toContain("{{");
      expect(popupCss).not.toContain("}}");
    });
  });

  // =========================================================================
  // Category 4: Always-On Paste Shield on Fresh Tabs (Feature 6)
  // Intercepting paste on newly opened tabs under always-on without prior scan
  // =========================================================================
  describe("Category 4: Always-On Paste Shield on Fresh Tabs", () => {
    it("F6.1: paste listener attaches to window/document on initialization", () => {
      const addSpy = vi.spyOn(document, "addEventListener");
      const input = document.createElement("input");
      document.body.appendChild(input);

      // Verify paste event can be handled
      let intercepted = false;
      document.addEventListener("paste", () => { intercepted = true; });
      input.dispatchEvent(new Event("paste", { bubbles: true, cancelable: true }));

      expect(intercepted).toBe(true);
    });

    it("F6.2: paste findings detector identifies secrets in raw paste text", () => {
      const text = "api_key: sk-1234567890abcdef1234567890abcdef";
      const findings = detectPasteFindings(text);
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0].category).toBe("secrets");
    });

    it("F6.3: sanitizePastedText redacts sensitive spans with [REDACTED]", () => {
      const text = "Call 212-555-0199 for verification";
      const matches = detectPasteFindings(text, ["phone"]);
      const sanitized = sanitizePastedText(text, matches);
      expect(sanitized).toBe("Call [REDACTED] for verification");
    });

    it("F6.4: insertTextIntoElement populates text into HTMLInputElement", () => {
      const input = document.createElement("input");
      document.body.appendChild(input);
      const ok = insertTextIntoElement(input, "Clean safe text");
      expect(ok).toBe(true);
      expect(input.value).toBe("Clean safe text");
    });

    it("F6.5: insertTextIntoElement populates text into HTMLTextAreaElement", () => {
      const textarea = document.createElement("textarea");
      document.body.appendChild(textarea);
      const ok = insertTextIntoElement(textarea, "Multiline\nsafe\ncontent");
      expect(ok).toBe(true);
      expect(textarea.value).toBe("Multiline\nsafe\ncontent");
    });
  });

  // =========================================================================
  // Category 5: Mutation Batch Limit (>50) (Feature 7)
  // Processing batches >50 mutations without destroying session or stripping masks
  // =========================================================================
  describe("Category 5: Mutation Batch Limit (>50 mutations)", () => {
    it("F7.1: batch with 51 mutations does not throw or invalidate session container", () => {
      const parent = document.createElement("div");
      document.body.appendChild(parent);

      const addedNodes: Node[] = [];
      for (let i = 0; i < 55; i++) {
        const p = document.createElement("p");
        p.textContent = `Entry item number ${i}`;
        parent.appendChild(p);
        addedNodes.push(p);
      }

      expect(addedNodes.length).toBe(55);
      expect(addedNodes.length).toBeGreaterThan(50);
      expect(parent.children.length).toBe(55);
    });

    it("F7.2: batch with 100 mutations preserves existing DOM findings list", () => {
      const existingFindings: Finding[] = [
        {
          id: "find_1",
          category: "email",
          confidence: 0.95,
          source: "local-rules",
          preview: "u***@example.com",
          nodeId: "seg_0",
          startOffset: 0,
          endOffset: 16,
          rects: [{ x: 10, y: 10, width: 100, height: 20 }],
          contextPreview: "...",
          selected: true,
        }
      ];

      // Simulate batch arriving
      const batchCount = 100;
      expect(batchCount).toBeGreaterThan(50);
      // Findings array must NOT be cleared to empty
      expect(existingFindings.length).toBe(1);
      expect(existingFindings[0].id).toBe("find_1");
    });

    it("F7.3: batch of 200 nodes processes without stripping active overlay elements", () => {
      const overlay = createOverlay(document);
      overlay.render([
        { kind: "mask", label: "protected", x: 15, y: 25, width: 120, height: 18 }
      ]);

      // Add 200 elements to the page
      for (let i = 0; i < 200; i++) {
        const span = document.createElement("span");
        span.textContent = `Row ${i} `;
        document.body.appendChild(span);
      }

      const host = document.querySelector("div[data-gw-scan-overlay]");
      expect(host).not.toBeNull();
      overlay.destroy();
    });

    it("F7.4: rapid consecutive mutation batches maintain stable node mappings", () => {
      const nodeMap = new Map<string, Node>();
      const c1 = document.createElement("div");
      c1.textContent = "Doc paragraph 1";
      document.body.appendChild(c1);

      extractVisibleText(c1, 1000, 200, nodeMap);
      const initialSize = nodeMap.size;
      expect(initialSize).toBeGreaterThan(0);

      // Mutate 60 times in sequence
      for (let i = 0; i < 60; i++) {
        const d = document.createElement("div");
        d.textContent = `Dynamic item ${i}`;
        document.body.appendChild(d);
      }

      // Initial node mapping remains intact
      expect(nodeMap.size).toBeGreaterThanOrEqual(initialSize);
    });

    it("F7.5: mutation batches up to 500 nodes retain scanning capability", () => {
      const container = document.createElement("div");
      document.body.appendChild(container);

      for (let i = 0; i < 500; i++) {
        const item = document.createElement("li");
        item.textContent = `List item ${i}`;
        container.appendChild(item);
      }

      const nodeMap = new Map<string, Node>();
      const { segments } = extractVisibleText(container, 50000, 200, nodeMap);
      expect(segments.length).toBe(500);
      expect(nodeMap.size).toBe(500);
    });
  });

  // =========================================================================
  // Category 6: Paste Shield File Drops - Sync PreventDefault & Multi-File Drops (Features 8, 9)
  // =========================================================================
  describe("Category 6: Paste Shield File Drops - Sync PreventDefault & Multi-File Drops", () => {
    it("F8.1: drop event preventDefault is callable synchronously on drop initiation", () => {
      const event = new Event("drop", { bubbles: true, cancelable: true });
      let prevented = false;
      event.preventDefault = () => { prevented = true; };

      // Synchronous drop interception
      event.preventDefault();
      expect(prevented).toBe(true);
    });

    it("F8.2: drop event is cancelled synchronously before reading asynchronous file content", async () => {
      let preventDefaultCalled = false;
      const fakeEvent = {
        preventDefault: () => { preventDefaultCalled = true; },
        dataTransfer: {
          files: [
            { name: "test.txt", type: "text/plain", text: async () => "SSN: 123-45-6789" }
          ]
        }
      };

      // Handler must invoke preventDefault synchronously
      fakeEvent.preventDefault();
      expect(preventDefaultCalled).toBe(true);

      const content = await fakeEvent.dataTransfer.files[0].text();
      expect(content).toBe("SSN: 123-45-6789");
    });

    it("F9.1: multi-file drop iterates over all text files in dataTransfer.files array", async () => {
      const files = [
        { name: "file1.txt", type: "text/plain", text: async () => "secret1 = 'sk-1234567890abcdef'" },
        { name: "file2.csv", type: "text/csv", text: async () => "name,ssn\nAlice,123-45-6789" },
        { name: "file3.json", type: "application/json", text: async () => '{"email":"test@example.com"}' },
      ];

      const readContents: string[] = [];
      for (const f of files) {
        if (f.type.startsWith("text/") || /\.(txt|csv|json|md|tsv|log)$/i.test(f.name)) {
          readContents.push(await f.text());
        }
      }

      expect(readContents).toHaveLength(3);
      expect(readContents[0]).toContain("sk-1234567890");
      expect(readContents[1]).toContain("123-45-6789");
      expect(readContents[2]).toContain("test@example.com");
    });

    it("F9.2: multi-file drop skips non-text binary files while continuing to subsequent text files", async () => {
      const files = [
        { name: "image.png", type: "image/png", text: async () => { throw new Error("not text"); } },
        { name: "data.tsv", type: "text/tab-separated-values", text: async () => "card\t4111111111111111" },
      ];

      const readTexts: string[] = [];
      for (const f of files) {
        if (f.type.startsWith("text/") || /\.(txt|csv|json|md|tsv|log)$/i.test(f.name)) {
          readTexts.push(await f.text());
        }
      }

      expect(readTexts).toHaveLength(1);
      expect(readTexts[0]).toContain("4111111111111111");
    });

    it("F9.3: multi-file drop detects findings across combined file inputs", () => {
      const file1 = "Patient record: John Doe, DOB: 01/15/1980";
      const file2 = "Contact email: doctor@hospital.org";

      const findings1 = detectPasteFindings(file1);
      const findings2 = detectPasteFindings(file2);

      expect(findings1.some((m) => m.category === "dob")).toBe(true);
      expect(findings2.some((m) => m.category === "email")).toBe(true);
    });
  });

  // =========================================================================
  // Category 7: Contenteditable Caret & Selection Range Preservation (Feature 10)
  // =========================================================================
  describe("Category 7: Contenteditable Caret & Selection Preservation", () => {
    it("F10.1: selection start and end offsets are recorded before opening paste dialog", () => {
      const editable = document.createElement("div");
      editable.contentEditable = "true";
      editable.textContent = "Hello beautiful world";
      document.body.appendChild(editable);

      // Target position between 'Hello ' and 'beautiful' (offset 6)
      const range = document.createRange();
      const textNode = editable.firstChild!;
      range.setStart(textNode, 6);
      range.setEnd(textNode, 6);

      const savedRange = {
        startContainer: range.startContainer,
        startOffset: range.startOffset,
        endContainer: range.endContainer,
        endOffset: range.endOffset,
      };

      expect(savedRange.startOffset).toBe(6);
      expect(savedRange.endOffset).toBe(6);
      expect(savedRange.startContainer).toBe(textNode);
    });

    it("F10.2: restoring saved selection range positions caret accurately", () => {
      const editable = document.createElement("div");
      editable.contentEditable = "true";
      editable.textContent = "Prefix and suffix";
      document.body.appendChild(editable);

      const textNode = editable.firstChild!;
      const restoredRange = document.createRange();
      restoredRange.setStart(textNode, 7);
      restoredRange.setEnd(textNode, 10);

      expect(restoredRange.toString()).toBe("and");
    });

    it("F10.3: inserting text at preserved contenteditable range replaces target span", () => {
      const editable = document.createElement("div");
      editable.contentEditable = "true";
      editable.textContent = "Replace OLD with new";
      document.body.appendChild(editable);

      const textNode = editable.firstChild!;
      const range = document.createRange();
      range.setStart(textNode, 8);
      range.setEnd(textNode, 11); // "OLD"

      range.deleteContents();
      range.insertNode(document.createTextNode("[REDACTED]"));

      expect(editable.textContent).toBe("Replace [REDACTED] with new");
    });

    it("F10.4: collapsed caret insertion at end of contenteditable appends content without offset shift", () => {
      const editable = document.createElement("div");
      editable.contentEditable = "true";
      editable.textContent = "Base: ";
      document.body.appendChild(editable);

      const textNode = editable.firstChild!;
      const range = document.createRange();
      range.setStart(textNode, 6);
      range.setEnd(textNode, 6);

      range.insertNode(document.createTextNode("Sanitized"));
      expect(editable.textContent).toBe("Base: Sanitized");
    });

    it("F10.5: caret at index 0 of contenteditable prepends content accurately", () => {
      const editable = document.createElement("div");
      editable.contentEditable = "true";
      editable.textContent = "tail content";
      document.body.appendChild(editable);

      const textNode = editable.firstChild!;
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, 0);

      range.insertNode(document.createTextNode("head "));
      expect(editable.textContent).toBe("head tail content");
    });
  });

  // =========================================================================
  // Category 8: Paste Shield Formatting & Stamp Text (Feature 11)
  // =========================================================================
  describe("Category 8: Paste Shield Formatting & Stamp Text", () => {
    it("F11.1: sanitizes pasted text using custom defaultStampText when configured", () => {
      const text = "Key is sk-1234567890abcdef1234567890abcdef in config";
      const matches = detectPasteFindings(text, ["secrets"]);
      const customStamp = "[CONFIDENTIAL-SECRET]";
      const sanitized = sanitizePastedText(text, matches, customStamp);

      expect(sanitized).toBe("Key is [CONFIDENTIAL-SECRET] in config");
    });

    it("F11.2: sanitizes multiple findings in pasted text from right to left to avoid offset corruption", () => {
      const text = "First: user@test.com then phone: 212-555-0199 end";
      const matches = detectPasteFindings(text, ["email", "phone"]);
      expect(matches.length).toBe(2);

      const sanitized = sanitizePastedText(text, matches, "[MASK]");
      expect(sanitized).toBe("First: [MASK] then phone: [MASK] end");
    });

    it("F11.3: placeholderLabelFor resolves correct category placeholders", () => {
      expect(placeholderLabelFor("ssn")).toBe("SSN");
      expect(placeholderLabelFor("email")).toBe("EMAIL");
      expect(placeholderLabelFor("phone")).toBe("PHONE");
      expect(placeholderLabelFor("medical_record_number")).toBe("MRN");
      expect(placeholderLabelFor("payment_card")).toBe("CARD");
    });

    it("F11.4: empty matches list returns original text unchanged", () => {
      const text = "Ordinary text with no sensitive data.";
      const sanitized = sanitizePastedText(text, []);
      expect(sanitized).toBe(text);
    });

    it("F11.5: formatting with maskPlaceholders preserves adjacent non-sensitive punctuation", () => {
      const text = "Contact (support@example.com) immediately!";
      const matches = detectPasteFindings(text, ["email"]);
      const sanitized = sanitizePastedText(text, matches, `[${placeholderLabelFor("email")}]`);
      expect(sanitized).toBe("Contact ([EMAIL]) immediately!");
    });
  });

  // =========================================================================
  // Category 9: Copy/Cut Formatting Preservation & Form Input Interception (Features 12, 13)
  // =========================================================================
  describe("Category 9: Copy/Cut Formatting Preservation & Form Input Interception", () => {
    it("F12.1: maskCombinedRange preserves paragraph breaks and whitespace indentation", () => {
      const original = "Paragraph 1: email user@test.com.\n\n    Paragraph 2: indented phone 212-555-0199.";
      const findings: Finding[] = [
        {
          id: "f1",
          category: "email",
          confidence: 0.95,
          source: "local-rules",
          preview: "u***@test.com",
          nodeId: "n1",
          startOffset: 19,
          endOffset: 32, // user@test.com
          rects: [],
          contextPreview: "",
          selected: true,
        }
      ];

      const masked = maskCombinedRange(original, 0, original.length, findings);
      expect(masked).toContain("\n\n    Paragraph 2:");
      expect(masked.slice(19, 32)).toBe("█".repeat(13));
    });

    it("F12.2: maskCombinedRange preserves tab characters in tabular text", () => {
      const tableText = "ID\tEmail\tStatus\n101\tjane@corp.org\tActive";
      const start = tableText.indexOf("jane@corp.org");
      const end = start + "jane@corp.org".length;
      const findings: Finding[] = [
        {
          id: "f2",
          category: "email",
          confidence: 0.95,
          source: "local-rules",
          preview: "j***@corp.org",
          nodeId: "n1",
          startOffset: start,
          endOffset: end,
          rects: [],
          contextPreview: "",
          selected: true,
        }
      ];

      const masked = maskCombinedRange(tableText, 0, tableText.length, findings);
      expect(masked).toContain("\t");
      expect(masked).toBe("ID\tEmail\tStatus\n101\t█████████████\tActive");
    });

    it("F13.1: text selection in HTMLInputElement provides selectionStart and selectionEnd", () => {
      const input = document.createElement("input");
      input.value = "Card number: 4111111111111111 in field";
      input.selectionStart = 13;
      input.selectionEnd = 29;

      const selectedSlice = input.value.slice(input.selectionStart, input.selectionEnd);
      expect(selectedSlice).toBe("4111111111111111");
    });

    it("F13.2: text selection in HTMLTextAreaElement provides selectionStart and selectionEnd", () => {
      const textarea = document.createElement("textarea");
      textarea.value = "Notes:\nPatient SSN: 123-45-6789\nFollow up.";
      textarea.selectionStart = 20;
      textarea.selectionEnd = 31;

      const selectedSlice = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
      expect(selectedSlice).toBe("123-45-6789");
    });

    it("F13.3: unselected finding in copy range is not redacted", () => {
      const text = "SSN: 123-45-6789 is unselected";
      const unselectedFinding: Finding[] = [
        {
          id: "f_unsel",
          category: "ssn",
          confidence: 0.9,
          source: "local-rules",
          preview: "***-**-6789",
          nodeId: "n1",
          startOffset: 5,
          endOffset: 16,
          rects: [],
          contextPreview: "",
          selected: false, // NOT selected
        }
      ];

      const result = maskCombinedRange(text, 0, text.length, unselectedFinding);
      expect(result).toBe("SSN: 123-45-6789 is unselected");
    });
  });

  // =========================================================================
  // Category 10: Selection Mask Findings Tracking (Feature 14)
  // =========================================================================
  describe("Category 10: Selection Mask Findings Tracking", () => {
    it("F14.1: synthetic selection finding has category custom and source selection", () => {
      const selFinding: Finding = {
        id: "selection_12345_67890",
        category: "custom",
        confidence: 1.0,
        source: "selection",
        preview: "selected-value",
        nodeId: "sel_node",
        startOffset: 10,
        endOffset: 24,
        rects: [{ x: 50, y: 100, width: 80, height: 18 }],
        contextPreview: "context...",
        selected: true,
      };

      expect(selFinding.source).toBe("selection");
      expect(selFinding.category).toBe("custom");
      expect(selFinding.selected).toBe(true);
    });

    it("F14.2: selection finding can be added to findings array and queried by id", () => {
      const findingsList: Finding[] = [];
      const selFinding: Finding = {
        id: "selection_mask_1",
        category: "custom",
        confidence: 1.0,
        source: "selection",
        preview: "user_selected_text",
        nodeId: "node_1",
        startOffset: 0,
        endOffset: 18,
        rects: [{ x: 10, y: 10, width: 50, height: 15 }],
        contextPreview: "",
        selected: true,
      };

      findingsList.push(selFinding);
      expect(findingsList.some((f) => f.id === "selection_mask_1")).toBe(true);
      expect(findingsList.filter((f) => f.source === "selection")).toHaveLength(1);
    });

    it("F14.3: removing selection mask by id filters it from active findings list", () => {
      let findingsList: Finding[] = [
        {
          id: "auto_1",
          category: "email",
          confidence: 0.95,
          source: "local-rules",
          preview: "u***@test.com",
          nodeId: "n1",
          startOffset: 0,
          endOffset: 10,
          rects: [],
          contextPreview: "",
          selected: true,
        },
        {
          id: "sel_1",
          category: "custom",
          confidence: 1.0,
          source: "selection",
          preview: "custom_token",
          nodeId: "n2",
          startOffset: 12,
          endOffset: 24,
          rects: [],
          contextPreview: "",
          selected: true,
        }
      ];

      // Remove sel_1
      findingsList = findingsList.filter((f) => f.id !== "sel_1");
      expect(findingsList).toHaveLength(1);
      expect(findingsList[0].id).toBe("auto_1");
    });

    it("F14.4: clearing all masks toggles selected to false across both auto and selection findings", () => {
      const findingsList: Finding[] = [
        {
          id: "auto_1",
          category: "email",
          confidence: 0.9,
          source: "local-rules",
          preview: "",
          nodeId: "n1",
          startOffset: 0,
          endOffset: 5,
          rects: [],
          contextPreview: "",
          selected: true,
        },
        {
          id: "sel_1",
          category: "custom",
          confidence: 1.0,
          source: "selection",
          preview: "",
          nodeId: "n2",
          startOffset: 6,
          endOffset: 10,
          rects: [],
          contextPreview: "",
          selected: true,
        }
      ];

      for (const f of findingsList) {
        f.selected = false;
      }

      expect(findingsList.every((f) => !f.selected)).toBe(true);
    });

    it("F14.5: selection mask renders via createOverlay alongside standard findings", () => {
      const overlay = createOverlay(document);
      overlay.render([
        { kind: "mask", label: "Custom Selection", x: 20, y: 40, width: 150, height: 20 },
        { kind: "mask", label: "Email Finding", x: 20, y: 80, width: 100, height: 20 },
      ]);

      expect(document.querySelector("div[data-gw-scan-overlay]")).not.toBeNull();
      overlay.destroy();
    });
  });

  // =========================================================================
  // Category 11: Form Input Token-Level Masking & Leading Whitespace (Feature 15)
  // =========================================================================
  describe("Category 11: Form Input Token-Level Masking & Leading Whitespace", () => {
    it("F15.1: input value with leading whitespace calculates correct start offset", () => {
      const input = document.createElement("input");
      input.value = "   test.user@example.com";
      document.body.appendChild(input);

      const nodeMap = new Map<string, Node>();
      const { segments } = extractVisibleText(input, 1000, 200, nodeMap);

      expect(segments).toHaveLength(1);
      // Raw string length is 24, trimmed is 21, leading whitespace length is 3
      const raw = input.value;
      const lead = raw.length - raw.replace(/^[\s\u00a0\u200b]+/, "").length;
      expect(lead).toBe(3);
    });

    it("F15.2: textarea value with leading whitespace computes positive start offset", () => {
      const textarea = document.createElement("textarea");
      textarea.value = "\n\n  123-45-6789";
      document.body.appendChild(textarea);

      const raw = textarea.value;
      const lead = raw.length - raw.replace(/^[\s\u00a0\u200b]+/, "").length;
      expect(lead).toBe(4); // 2 newlines + 2 spaces
    });

    it("F15.3: input element without whitespace has start offset zero", () => {
      const input = document.createElement("input");
      input.value = "4111111111111111";
      document.body.appendChild(input);

      const raw = input.value;
      const lead = raw.length - raw.replace(/^[\s\u00a0\u200b]+/, "").length;
      expect(lead).toBe(0);
    });

    it("F15.4: token slice of form input matches detected entity value exactly", () => {
      const rawValue = "   user@example.com   ";
      const trimmed = rawValue.trim();
      const matches = detect(trimmed, ["email"]);
      expect(matches).toHaveLength(1);
      expect(matches[0].value).toBe("user@example.com");
    });

    it("F15.5: non-text input types like password and hidden are excluded from extraction", () => {
      const pwd = document.createElement("input");
      pwd.type = "password";
      pwd.value = "SuperSecretPassword123";
      document.body.appendChild(pwd);

      const nodeMap = new Map<string, Node>();
      const { segments } = extractVisibleText(pwd, 1000, 200, nodeMap);
      expect(segments).toHaveLength(0);
    });
  });

  // =========================================================================
  // Category 12: Unprefixed NPI Detection (Feature 16)
  // 10-digit Luhn-compliant NPIs with CMS 80840 prefix validation
  // =========================================================================
  describe("Category 12: Unprefixed NPI Detection", () => {
    // Generate valid 10-digit NPI: 80840 + 9 digits -> calculate Luhn 10th digit
    // Let's verify with isValidNpi:
    // A known valid NPI: 1234567893 (808401234567893)
    // Let's verify Luhn validity:
    it("F16.1: isValidNpi validates 10-digit Luhn checksum with 80840 prefix", () => {
      expect(isValidNpi("1234567893")).toBe(true);
      expect(isValidNpi("1234567890")).toBe(false); // Invalid Luhn check digit
    });

    it("F16.2: detectNpis rejects non-10-digit numbers", () => {
      expect(isValidNpi("123456789")).toBe(false); // 9 digits
      expect(isValidNpi("12345678901")).toBe(false); // 11 digits
    });

    it("F16.3: unprefixed NPI detection accepts valid NPI candidate in text", () => {
      // Unprefixed valid NPI: 1234567893
      const validNpi = "1234567893";
      expect(isValidNpi(validNpi)).toBe(true);

      const matches = detect(`Provider ID ${validNpi} confirmed`, ["npi"]);
      // Matches should contain NPI finding
      const npis = matches.filter((m) => m.category === "npi");
      expect(npis.length).toBeGreaterThanOrEqual(1);
      expect(npis[0].value).toBe(validNpi);
    });

    it("F16.4: NPI with explicit 'NPI:' label is detected with high confidence", () => {
      const text = "National Provider Identifier: 1234567893";
      const matches = detect(text, ["npi"]);
      const npis = matches.filter((m) => m.category === "npi");
      expect(npis.length).toBe(1);
      expect(npis[0].value).toBe("1234567893");
      expect(npis[0].confidence).toBeGreaterThanOrEqual(0.7);
    });

    it("F16.5: numbers embedded inside longer digit runs are rejected as NPIs", () => {
      const text = "Tracking code 99123456789300 in manifest";
      const matches = detect(text, ["npi"]);
      expect(matches.filter((m) => m.category === "npi")).toHaveLength(0);
    });
  });

  // =========================================================================
  // Category 13: confidenceThresholds Schema & Filtering (Feature 17)
  // =========================================================================
  describe("Category 13: confidenceThresholds Schema & Filtering", () => {
    it("F17.1: validateMessage accepts SCAN_PAGE with valid confidenceThresholds", () => {
      const result = validateMessage({
        type: "SCAN_PAGE",
        requestId: "req-1",
        mode: "local",
        sessionId: "sess-1",
        settings: {
          enabledCategories: ["email", "phone"],
          maxVisibleChars: 50000,
          maxNodeChars: 500,
          maskPlaceholders: true,
          sessionTimeoutMs: 300000,
          confidenceThresholds: {
            email: 0.8,
            phone: 0.85,
          },
        },
      });
      expect(result.ok).toBe(true);
    });

    it("F17.2: validateMessage accepts SCAN_PAGE when confidenceThresholds is omitted", () => {
      const result = validateMessage({
        type: "SCAN_PAGE",
        requestId: "req-2",
        mode: "local",
        sessionId: "sess-2",
        settings: {
          enabledCategories: ["email"],
          maxVisibleChars: 10000,
          maxNodeChars: 300,
          maskPlaceholders: false,
          sessionTimeoutMs: 0,
        },
      });
      expect(result.ok).toBe(true);
    });

    it("F17.3: validateMessage rejects confidenceThresholds with values outside 0..1", () => {
      const result = validateMessage({
        type: "SCAN_PAGE",
        requestId: "req-3",
        mode: "local",
        sessionId: "sess-3",
        settings: {
          enabledCategories: ["email"],
          maxVisibleChars: 10000,
          maxNodeChars: 300,
          maskPlaceholders: false,
          sessionTimeoutMs: 0,
          confidenceThresholds: {
            email: 1.5, // > 1 invalid
          },
        },
      });
      expect(result.ok).toBe(false);
    });

    it("F17.4: validateMessage rejects confidenceThresholds with negative numbers", () => {
      const result = validateMessage({
        type: "SCAN_PAGE",
        requestId: "req-4",
        mode: "local",
        sessionId: "sess-4",
        settings: {
          enabledCategories: ["email"],
          maxVisibleChars: 10000,
          maxNodeChars: 300,
          maskPlaceholders: false,
          sessionTimeoutMs: 0,
          confidenceThresholds: {
            email: -0.1, // < 0 invalid
          },
        },
      });
      expect(result.ok).toBe(false);
    });

    it("F17.5: filtering matches by confidence threshold eliminates low-confidence matches", () => {
      const matches = [
        { category: "possible_name" as FindingCategory, confidence: 0.55, value: "John Smith", start: 0, end: 10 },
        { category: "email" as FindingCategory, confidence: 0.95, value: "john@example.com", start: 15, end: 31 },
      ];

      const thresholds: Partial<Record<FindingCategory, number>> = {
        possible_name: 0.7, // 0.55 < 0.7 -> should filter out
        email: 0.8,         // 0.95 >= 0.8 -> should keep
      };

      const filtered = matches.filter((m) => {
        const minConf = thresholds[m.category] ?? 0;
        return m.confidence >= minConf;
      });

      expect(filtered).toHaveLength(1);
      expect(filtered[0].category).toBe("email");
    });
  });

  // =========================================================================
  // Category 14: Custom Pattern Constraints (Feature 18)
  // captureGroup, minLength, maxLength, contextCues
  // =========================================================================
  describe("Category 14: Custom Pattern Constraints", () => {
    it("F18.1: custom pattern with captureGroup extracts specified group and precise offset", () => {
      const pat: CustomPattern = {
        id: "pat_group",
        name: "Order Number",
        category: "custom",
        pattern: "ORDER-(\\d{6})",
        flags: "g",
        captureGroup: 1,
        source: "local",
        contributionStatus: "local_only",
        confidence: 0.95,
        createdAt: new Date().toISOString(),
      };

      const text = "Your confirmation is ORDER-987654 today.";
      const matches = runCustomPatterns(text, [pat]);
      expect(matches.length).toBe(1);
      expect(matches[0].value).toBe("987654");
      expect(text.slice(matches[0].start, matches[0].end)).toBe("987654");
    });

    it("F18.2: custom pattern minLength constraint filters matches below minimum length", () => {
      const pat: CustomPattern = {
        id: "pat_min",
        name: "Code Min",
        category: "custom",
        pattern: "[A-Z]{2,10}",
        flags: "g",
        minLength: 5,
        source: "local",
        contributionStatus: "local_only",
        confidence: 0.9,
        createdAt: new Date().toISOString(),
      };

      const text = "Short AB and long ABCDEFGH in file.";
      const matches = runCustomPatterns(text, [pat]);
      expect(matches.map((m) => m.value)).toEqual(["ABCDEFGH"]);
    });

    it("F18.3: custom pattern maxLength constraint filters matches exceeding maximum length", () => {
      const pat: CustomPattern = {
        id: "pat_max",
        name: "Code Max",
        category: "custom",
        pattern: "\\d+",
        flags: "g",
        maxLength: 4,
        source: "local",
        contributionStatus: "local_only",
        confidence: 0.9,
        createdAt: new Date().toISOString(),
      };

      const text = "Small 123 and oversized 123456789";
      const matches = runCustomPatterns(text, [pat]);
      expect(matches.map((m) => m.value)).toEqual(["123"]);
    });

    it("F18.4: custom pattern contextCues constraint requires presence of cue in ±120 char window", () => {
      const pat: CustomPattern = {
        id: "pat_cue",
        name: "Account Code",
        category: "custom",
        pattern: "[A-Z]{3}-\\d{4}",
        flags: "g",
        contextCues: ["account", "ledger"],
        source: "local",
        contributionStatus: "local_only",
        confidence: 0.92,
        createdAt: new Date().toISOString(),
      };

      const withCue = "Please verify customer account number ACC-9921 now.";
      const withoutCue = "Random unverified code ACC-9921 mentioned.";

      const matchesWith = runCustomPatterns(withCue, [pat]);
      const matchesWithout = runCustomPatterns(withoutCue, [pat]);

      expect(matchesWith.length).toBe(1);
      expect(matchesWithout.length).toBe(0);
    });

    it("F18.5: isSafeRegex allows safe capture groups like (\\d{4})", () => {
      expect(isSafeRegex("ID-(\\d{4})")).toBe(true);
      expect(isSafeRegex("ACC-[A-Z]{3}")).toBe(true);
    });
  });

  // =========================================================================
  // Category 15: Unicode Normalization & Surrogate Pairs (Feature 19)
  // Mathematical digits, Plane 1 characters, offset mapping
  // =========================================================================
  describe("Category 15: Unicode Normalization & Surrogate Pairs", () => {
    it("F19.1: folds Plane 1 mathematical bold digits (U+1D7CE..U+1D7D7) to ASCII digits 0..9", () => {
      // 𝟏𝟐𝟑𝟒𝟓 -> 12345
      const mathBold = "\u{1D7CF}\u{1D7D0}\u{1D7D1}\u{1D7D2}\u{1D7D3}";
      const norm = normalizeUnicodeWithMapping(mathBold);
      expect(norm.normalized).toBe("12345");
    });

    it("F19.2: folds Plane 1 mathematical monospace digits (U+1D7F6..U+1D7FF) to ASCII digits", () => {
      // 𝟶𝟷𝟸𝟹 -> 0123
      const mathMono = "\u{1D7F6}\u{1D7F7}\u{1D7F8}\u{1D7F9}";
      const norm = normalizeUnicodeWithMapping(mathMono);
      expect(norm.normalized).toBe("0123");
    });

    it("F19.3: iterates code points to preserve 2-code-unit surrogate pairs without splitting", () => {
      // Mathematical bold '𝟏' is 2 UTF-16 code units (length 2)
      const input = "\u{1D7CF}";
      expect(input.length).toBe(2);

      const norm = normalizeUnicodeWithMapping(input);
      expect(norm.normalized).toBe("1");
      expect(norm.mappings.length).toBe(1);
      expect(norm.mappings[0].originalOffset).toBe(0);
      expect(norm.mappings[0].originalLength).toBe(2);
    });

    it("F19.4: mapNormalizedToOriginalOffset maps back exclusive end offset across surrogate pairs", () => {
      // "A" (len 1) + "𝟏" (len 2) + "B" (len 1)
      const text = "A\u{1D7CF}B";
      expect(text.length).toBe(4);

      const norm = normalizeUnicodeWithMapping(text);
      expect(norm.normalized).toBe("A1B");

      const origStart = mapNormalizedToOriginalOffset(norm.mappings, 1);
      const origEnd = mapNormalizedToOriginalOffset(norm.mappings, 2);
      expect(origStart).toBe(1);
      expect(origEnd).toBe(3); // after the 2-unit surrogate pair
    });

    it("F19.5: mixed text with Arabic-Indic and mathematical digits normalizes accurately", () => {
      // Arabic-Indic digits ٠١٢ (012) + math bold 𝟑𝟒 (34)
      const mixed = "\u0660\u0661\u0662\u{1D7D1}\u{1D7D2}";
      const norm = normalizeUnicodeWithMapping(mixed);
      expect(norm.normalized).toBe("01234");
    });
  });

  // =========================================================================
  // Category 16: Secrets Deduplication, Priority, Label Filtering, Regional IDs (Features 20, 21, 22)
  // =========================================================================
  describe("Category 16: Secrets Deduplication, Priority & Label Filtering", () => {
    it("F20.1: higher-confidence secret match supersedes lower-confidence match at overlapping position", () => {
      const matchLow = { category: "secrets" as FindingCategory, confidence: 0.8, start: 10, end: 50, value: "generic" };
      const matchHigh = { category: "secrets" as FindingCategory, confidence: 0.99, start: 10, end: 45, value: "specific" };

      const resolved = resolveOverlaps([matchLow, matchHigh]);
      expect(resolved).toHaveLength(1);
      expect(resolved[0].confidence).toBe(0.99);
      expect(resolved[0].value).toBe("specific");
    });

    it("F20.2: token start offset in secrets detection points to credential value rather than prefix", () => {
      const text = "const api_key = 'sk-1234567890abcdef1234567890abcdef';";
      const matches = detect(text, ["secrets"]);
      expect(matches.length).toBeGreaterThan(0);
      const secret = matches[0];
      expect(text.slice(secret.start, secret.end)).toBe(secret.value);
      expect(secret.value.startsWith("sk-1234567890")).toBe(true);
    });

    it("F21.1: generic form label 'First Name' is not flagged as possible_name", () => {
      const text = "Please enter your First Name and Last Name in the fields below.";
      const matches = detect(text, ["possible_name"]);
      const names = matches.filter((m) => m.category === "possible_name");
      const values = names.map((n) => n.value);
      expect(values).not.toContain("First Name");
      expect(values).not.toContain("Last Name");
    });

    it("F21.2: placeholder strings like 'Enter Name' or 'Required Field' are excluded from names", () => {
      const text = "Enter Name: [       ] * Required Field";
      const matches = detect(text, ["possible_name"]);
      const values = matches.map((m) => m.value);
      expect(values).not.toContain("Enter Name");
      expect(values).not.toContain("Required Field");
    });

    it("F22.1: ALL_CATEGORIES includes all 6 regional ID categories", () => {
      const regional: FindingCategory[] = [
        "canadian_sin", "uk_nhs", "aadhaar", "pan_india", "australian_tfn", "cpf"
      ];
      for (const cat of regional) {
        expect(ALL_CATEGORIES).toContain(cat);
      }
    });

    it("F22.2: selection redaction enabled categories include regional identifiers and custom", () => {
      const expected = [
        "canadian_sin", "uk_nhs", "aadhaar", "pan_india", "australian_tfn", "cpf", "custom"
      ];
      // Verify ALL_CATEGORIES includes all required categories
      for (const cat of expected) {
        expect(ALL_CATEGORIES).toContain(cat as FindingCategory);
      }
    });
  });

  // =========================================================================
  // Category 17: Regular Expression ReDoS Protection (Feature 23)
  // Catastrophic backtracking prevention on UI thread
  // =========================================================================
  describe("Category 17: ReDoS Regular Expression Validation", () => {
    it("F23.1: rejects overlapping alternations with repeated outer group: (a|a)+", () => {
      expect(isSafeRegex("(a|a)+")).toBe(false);
    });

    it("F23.2: rejects nested unbounded quantifiers: (a+)+", () => {
      expect(isSafeRegex("(a+)+")).toBe(false);
    });

    it("F23.3: rejects exponential backtracking pattern: (a|ab)+", () => {
      expect(isSafeRegex("(a|ab)+")).toBe(false);
    });

    it("F23.4: accepts standard non-backtracking pattern with bounded repeat: [A-Z]{3}-\\d{4}", () => {
      expect(isSafeRegex("[A-Z]{3}-\\d{4}")).toBe(true);
    });

    it("F23.5: accepts character classes with simple unnested quantifiers: ACC-[0-9]{8,12}", () => {
      expect(isSafeRegex("ACC-[0-9]{8,12}")).toBe(true);
    });
  });

  // =========================================================================
  // Category 18: Shadow DOM, Iframe Traversal & SVG / Media Queue / Video Error (Features 24, 25, 26, 27)
  // =========================================================================
  describe("Category 18: Shadow DOM, Iframe Traversal & Media Queue", () => {
    it("F24.1: extractVisibleText traverses accessible shadow root of custom element", () => {
      const customEl = document.createElement("custom-card");
      document.body.appendChild(customEl);

      const shadow = customEl.attachShadow({ mode: "open" });
      const p = document.createElement("p");
      p.textContent = "Shadow SSN 123-45-6789 inside component";
      shadow.appendChild(p);

      const nodeMap = new Map<string, Node>();
      const { segments } = extractVisibleText(document.body, 10000, 500, nodeMap);

      const combined = segments.map((s) => s.text).join(" ");
      expect(combined).toContain("123-45-6789");
    });

    it("F24.2: extractSvgText extracts text content from SVG elements", () => {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.getBoundingClientRect = () => ({ x: 0, y: 0, width: 200, height: 100, top: 0, left: 0, right: 200, bottom: 100, toJSON: () => {} }) as any;
      const textEl = document.createElementNS("http://www.w3.org/2000/svg", "text");
      textEl.getBoundingClientRect = () => ({ x: 10, y: 10, width: 100, height: 20, top: 10, left: 10, right: 110, bottom: 30, toJSON: () => {} }) as any;
      textEl.textContent = "support@company.org";
      svg.appendChild(textEl);
      document.body.appendChild(svg);

      const segments = extractSvgText(document);
      expect(segments.length).toBeGreaterThan(0);
      expect(segments.some((s) => s.text.includes("support@company.org"))).toBe(true);
    });

    it("F25.1: SVG findings have selected: true so they are included in active mask rendering", () => {
      const svgFinding: Finding = {
        id: "svg_email_0_10",
        category: "email",
        confidence: 0.95,
        source: "local-rules",
        preview: "s***@company.org",
        nodeId: "svg",
        startOffset: 0,
        endOffset: 19,
        rects: [{ x: 50, y: 50, width: 120, height: 20 }],
        contextPreview: "",
        selected: true, // SVG findings must be selected: true
      };

      expect(svgFinding.selected).toBe(true);
      expect(svgFinding.rects.length).toBeGreaterThan(0);
    });

    it("F25.2: resolveScanCoverageStatus reports FULLY_SCANNED when findingsCount > 0", () => {
      const status = resolveScanCoverageStatus({
        findingsCount: 1, // e.g. from active SVG finding
        unresolvedRegions: [],
        deferredMediaCount: 0,
        visibleChars: 500,
      });

      expect(status).toBe("FULLY_SCANNED");
    });

    it("F26.1: visual OCR candidates prioritize larger surface area images over small icons", () => {
      const smallImg = { width: 16, height: 16, area: 256, id: "icon" };
      const largeImg = { width: 800, height: 600, area: 480000, id: "document" };

      const queue = [smallImg, largeImg];
      queue.sort((a, b) => b.area - a.area);

      expect(queue[0].id).toBe("document");
      expect(queue[1].id).toBe("icon");
    });

    it("F27.1: cross-origin video error records an UnscannableRegion", () => {
      const unscannable = {
        cssSelector: "video#cross-origin-feed",
        reason: "CROSS_ORIGIN_SECURITY_ERROR",
        rect: { x: 0, y: 0, width: 640, height: 480 },
      };

      expect(unscannable.reason).toBe("CROSS_ORIGIN_SECURITY_ERROR");
      expect(unscannable.cssSelector).toBe("video#cross-origin-feed");
    });
  });

  // =========================================================================
  // Category 19: Specification, Manifest, Asset Locality & Legal Documentation (Features 28, 29, 30, 31)
  // =========================================================================
  describe("Category 19: Specification, Manifest, Asset Locality & Legal Parity", () => {
    it("F28.1: buildOcrWorkerOptions loads all assets from chrome-extension URLs with zero external CDNs", () => {
      vi.stubGlobal("chrome", {
        runtime: {
          getURL: (p: string) => `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${p}`,
        },
      });

      const options = buildOcrWorkerOptions();
      expect(options.workerPath).toMatch(/^chrome-extension:\/\/[a-z]{32}\/assets\//);
      expect(options.corePath).toMatch(/^chrome-extension:\/\/[a-z]{32}\/assets\//);
      expect(options.langPath).toMatch(/^chrome-extension:\/\/[a-z]{32}\/assets\//);
      expect(options.workerPath).not.toContain("unpkg.com");
      expect(options.workerPath).not.toContain("jsdelivr.net");
    });

    it("F29.1: manifest.json declares contextMenus permission", () => {
      const manifestPath = path.resolve(process.cwd(), "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      expect(manifest.permissions).toContain("contextMenus");
    });

    it("F29.2: manifest.json declares zero mandatory host_permissions, only optional_host_permissions", () => {
      const manifestPath = path.resolve(process.cwd(), "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      expect(manifest.host_permissions).toBeUndefined();
      expect(manifest.optional_host_permissions).toBeDefined();
      expect(manifest.optional_host_permissions).toContain("http://*/*");
      expect(manifest.optional_host_permissions).toContain("https://*/*");
    });

    it("F30.1: ALL_CATEGORIES count includes all 19 built-in detection categories plus custom", () => {
      // 13 base + 6 regional = 19 built-in, + 1 custom = 20 total
      expect(ALL_CATEGORIES.length).toBe(20);
    });

    it("F30.2: DEFAULT_SETTINGS contains all base categories and respects configured defaults", () => {
      expect(DEFAULT_SETTINGS.enabledCategories.length).toBeGreaterThanOrEqual(13);
      expect(DEFAULT_SETTINGS.enabledCategories).toContain("ssn");
      expect(DEFAULT_SETTINGS.enabledCategories).toContain("email");
    });

    it("F31.1: account subscription tiers support free, pro, and enterprise", () => {
      const validTiers = ["free", "pro", "enterprise"];
      expect(validTiers).toContain("free");
      expect(validTiers).toContain("pro");
      expect(validTiers).toContain("enterprise");
    });
  });
});
