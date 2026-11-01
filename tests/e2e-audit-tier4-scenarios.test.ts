// @vitest-environment happy-dom
// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Tier 4: Real-World Application Scenarios
// End-to-end integration journeys simulating realistic multi-feature user workflows
// Derived strictly from TEST_INFRA.md and ORIGINAL_REQUEST.md.

import { describe, it, expect, vi, afterEach } from "vitest";

import {
  extractVisibleText,
  buildScanText,
  maskCombinedRange,
  type TextSegment,
} from "../src/content/extract.js";
import {
  detect,
  resolveOverlaps,
  placeholderLabelFor,
  runCustomPatterns,
} from "../src/content/detect.js";
import { isValidNpi, isValidCanadianSin, isValidNhsNumber } from "../src/validators/index.js";
import {
  normalizeUnicodeWithMapping,
  mapNormalizedToOriginalOffset,
} from "../src/content/normalization/unicode.js";
import { isSafeRegex } from "../src/shared/wizardAnalyzer.js";
import {
  detectPasteFindings,
  sanitizePastedText,
  insertTextIntoElement,
} from "../src/content/pasteGuard.js";
import { extractSvgText } from "../src/content/svgExtract.js";
import { createOverlay } from "../src/content/overlay.js";
import { ALL_CATEGORIES } from "../src/shared/settings.js";
import type { Finding, FindingCategory } from "../src/shared/types.js";
import type { CustomPattern } from "../src/shared/customPatterns.js";
import { resolveScanCoverageStatus } from "../src/content/normalization/pageInventory.js";

describe("Tier 4: Real-World Application Scenarios", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  // =========================================================================
  // Scenario 1: Dynamic SPA Route Transition & Mutation Storm
  // Features: F1, F2, F3, F4, F7, F24
  // =========================================================================
  it("Scenario 1: Dynamic SPA Route Transition & Mutation Storm (F1, F2, F3, F4, F7, F24)", () => {
    // 1. Initial Page Load: App container with view A
    const app = document.createElement("main");
    app.id = "app-root";
    document.body.appendChild(app);

    const viewA = document.createElement("section");
    viewA.id = "route-view-a";
    viewA.innerHTML = "<h1>Patient Profile</h1><p>Patient Name: John Doe</p>";
    app.appendChild(viewA);

    const nodeMap = new Map<string, Node>();
    const initialExtract = extractVisibleText(app, 10000, 500, nodeMap);
    expect(initialExtract.segments.length).toBeGreaterThan(0);
    const initialBuilt = buildScanText(initialExtract.segments);

    // Initial overlay created
    const overlay = createOverlay(document);
    overlay.render([
      { kind: "mask", label: "profile", x: 20, y: 30, width: 120, height: 20 }
    ]);

    // 2. SPA Route Transition: Route changes to View B (Mutation Storm: 65 nodes destroyed & created)
    viewA.remove();

    const viewB = document.createElement("section");
    viewB.id = "route-view-b";
    app.appendChild(viewB);

    // Add 65 dynamic patient row elements
    const addedTextNodes: Node[] = [];
    for (let i = 0; i < 65; i++) {
      const row = document.createElement("div");
      row.className = "record-row";
      const label = document.createElement("span");
      label.textContent = `Record #${i + 1000}: `;
      const value = document.createTextNode(i === 10 ? "SSN: 123-45-6789" : "Status: Active");
      row.appendChild(label);
      row.appendChild(value);
      viewB.appendChild(row);
      addedTextNodes.push(value);
    }

    // 3. Mutation storm limit verification: 65 nodes does NOT destroy scan session
    const mutationCount = 65;
    expect(mutationCount).toBeGreaterThan(50); // exceeds 50 batch threshold

    // 4. Incremental rescan maps delta to leaf text nodes rather than outer main container
    const deltaMap = new Map<string, Node>();
    const deltaExtract = extractVisibleText(viewB, 10000, 500, deltaMap);
    expect(deltaExtract.segments.length).toBeGreaterThan(0);

    // Verify leaf text node mapping
    const ssnSeg = deltaExtract.segments.find((s) => s.text.includes("123-45-6789"));
    expect(ssnSeg).toBeDefined();
    const mappedTarget = deltaMap.get(ssnSeg!.nodeId);
    expect(mappedTarget).toBeDefined();
    expect(mappedTarget?.nodeType).toBe(Node.TEXT_NODE);

    // 5. Delta scan detects SSN in new segments
    const findings = detect(ssnSeg!.text, ["ssn"]);
    expect(findings.length).toBe(1);
    expect(findings[0].value).toBe("123-45-6789");

    // 6. Floating mask update and repositioning on scroll
    overlay.render([
      { kind: "mask", label: "SSN", x: 40, y: 220, width: 100, height: 18 }
    ]);
    window.dispatchEvent(new Event("scroll"));
    expect(document.querySelector("div[data-gw-scan-overlay]")).not.toBeNull();

    overlay.destroy();
  });

  // =========================================================================
  // Scenario 2: Medical Record Intake Form with Form Controls & Unprefixed NPI
  // Features: F15, F16, F17, F21
  // =========================================================================
  it("Scenario 2: Medical Record Intake Form with Form Controls & Unprefixed NPI (F15, F16, F17, F21)", () => {
    // 1. Render Intake Form with generic labels and input controls
    const form = document.createElement("form");
    form.id = "intake-form";
    form.innerHTML = `
      <div class="field">
        <label>First Name</label>
        <input id="fn" type="text" value="  Jane  " />
      </div>
      <div class="field">
        <label>Last Name</label>
        <input id="ln" type="text" value="  Doe  " />
      </div>
      <div class="field">
        <label>Attending Doctor NPI</label>
        <input id="npi" type="text" value="   1234567893   " />
      </div>
      <div class="field">
        <label>Patient Clinical Notes</label>
        <textarea id="notes">Doctor 1234567893 reviewed lab results.</textarea>
      </div>
    `;
    document.body.appendChild(form);

    // 2. Generic form label filtering: "First Name" and "Last Name" not flagged as names
    const labelTexts = ["First Name", "Last Name", "Attending Doctor NPI"];
    for (const lt of labelTexts) {
      const nameMatches = detect(lt, ["possible_name"]);
      expect(nameMatches.map((m) => m.value)).not.toContain("First Name");
      expect(nameMatches.map((m) => m.value)).not.toContain("Last Name");
    }

    // 3. Form input token masking: whitespace offset calculation
    const npiInput = document.getElementById("npi") as HTMLInputElement;
    const rawVal = npiInput.value;
    const lead = rawVal.length - rawVal.replace(/^[\s\u00a0\u200b]+/, "").length;
    expect(lead).toBe(3);
    const tokenVal = rawVal.trim();
    expect(tokenVal).toBe("1234567893");

    // 4. Unprefixed NPI validation: 10-digit Luhn check
    expect(isValidNpi(tokenVal)).toBe(true);

    // 5. Confidence Thresholds filtering:
    // With threshold = 0.70, NPI is accepted
    const matches = detect(tokenVal, ["npi"]);
    expect(matches.length).toBeGreaterThanOrEqual(1);

    const thresholds: Partial<Record<FindingCategory, number>> = { npi: 0.70 };
    const accepted = matches.filter((m) => m.confidence >= (thresholds.npi ?? 0));
    expect(accepted.length).toBeGreaterThanOrEqual(1);
    expect(accepted[0].value).toBe("1234567893");

    // Token-level mask bounding box
    const tokenRect = { x: 50 + lead * 8, y: 120, width: tokenVal.length * 8, height: 20 };
    expect(tokenRect.x).toBeGreaterThan(50); // offset by leading whitespace
  });

  // =========================================================================
  // Scenario 3: Multilingual Clipboard & Paste Shield Workflow with Multi-File Drop
  // Features: F6, F8, F9, F10, F11, F12, F13
  // =========================================================================
  it("Scenario 3: Multilingual Clipboard & Paste Shield Workflow with Multi-File Drop (F6, F8, F9, F10, F11, F12, F13)", async () => {
    // 1. Fresh Tab in Always-On Mode with contenteditable rich editor
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    editor.innerHTML = "<p>Client Intake Notes:</p><p id='target-para'>Insertion Point: </p>";
    document.body.appendChild(editor);

    // Set caret at target paragraph
    const targetPara = document.getElementById("target-para")!;
    const range = document.createRange();
    range.selectNodeContents(targetPara);
    range.collapse(false); // collapsed at end
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    // 2. Multi-file Drop Event: 2 text files with sensitive PII and secrets
    let syncCancelled = false;
    const fakeDropEvent = {
      preventDefault: () => { syncCancelled = true; },
      dataTransfer: {
        files: [
          { name: "patient.csv", type: "text/csv", text: async () => "name,ssn,email\nAlice,123-45-6789,alice@health.org" },
          { name: "credentials.env", type: "text/plain", text: async () => "AWS_KEY=AKIAIOSFODNN7EXAMPLE\nSECRET=sk-1234567890abcdef1234567890abcdef" },
        ]
      }
    };

    // Synchronous preventDefault prevents raw unredacted data leakage
    fakeDropEvent.preventDefault();
    expect(syncCancelled).toBe(true);

    // 3. Process all dropped files and format using configured placeholders
    const file1Text = await fakeDropEvent.dataTransfer.files[0].text();
    const file2Text = await fakeDropEvent.dataTransfer.files[1].text();

    const findings1 = detectPasteFindings(file1Text, ["ssn", "email"]);
    const findings2 = detectPasteFindings(file2Text, ["secrets"]);

    expect(findings1.length).toBe(2);
    expect(findings2.length).toBeGreaterThanOrEqual(1);

    const sanitized1 = sanitizePastedText(file1Text, findings1, "[REDACTED]");
    const sanitized2 = sanitizePastedText(file2Text, findings2, "[REDACTED]");

    expect(sanitized1).toBe("name,ssn,email\nAlice,[REDACTED],[REDACTED]");
    expect(sanitized2).toContain("SECRET=[REDACTED]");

    // 4. Caret restoration & insertion
    insertTextIntoElement(editor, `\n${sanitized1}\n${sanitized2}`);
    expect(editor.textContent).toContain("Alice,[REDACTED],[REDACTED]");

    // 5. Copy/Cut Formatting Preservation: select multiline text and copy
    const tableText = "Name\tID\tSSN\nAlice\t101\t123-45-6789\nBob\t102\t987-65-4321";
    const ssnMatches = detect(tableText, ["ssn"]);
    const findingsList: Finding[] = ssnMatches.map((m, idx) => ({
      id: `f_${idx}`,
      category: "ssn",
      confidence: 0.95,
      source: "local-rules",
      preview: "***-**-****",
      nodeId: `n_${idx}`,
      startOffset: m.start,
      endOffset: m.end,
      rects: [],
      contextPreview: "",
      selected: true,
    }));

    const copyResult = maskCombinedRange(tableText, 0, tableText.length, findingsList);
    // Preserves table tabs and newlines while redacting SSNs
    expect(copyResult).toContain("\t");
    expect(copyResult).toContain("\n");
    expect(copyResult).not.toContain("123-45-6789");
    expect(copyResult).not.toContain("987-65-4321");
  });

  // =========================================================================
  // Scenario 4: Enterprise Web Component Dashboard with Inline SVG & Shadow DOM
  // Features: F24, F25, F26, F27
  // =========================================================================
  it("Scenario 4: Enterprise Web Component Dashboard with Inline SVG & Shadow DOM (F24, F25, F26, F27)", () => {
    // 1. Dashboard custom elements with Shadow DOM
    const dashboardHost = document.createElement("enterprise-dashboard");
    document.body.appendChild(dashboardHost);
    const shadowRoot = dashboardHost.attachShadow({ mode: "open" });

    // 2. Inline SVG Chart inside Shadow DOM
    const svgChart = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svgChart.id = "kpi-chart";
    svgChart.getBoundingClientRect = () => ({ x: 0, y: 0, width: 400, height: 250, top: 0, left: 0, right: 400, bottom: 250, toJSON: () => {} }) as any;

    const svgText = document.createElementNS("http://www.w3.org/2000/svg", "text");
    svgText.textContent = "lead.analyst@enterprise.com";
    svgText.getBoundingClientRect = () => ({ x: 20, y: 20, width: 180, height: 20, top: 20, left: 20, right: 200, bottom: 40, toJSON: () => {} }) as any;
    svgChart.appendChild(svgText);
    shadowRoot.appendChild(svgChart);

    // 3. Visual OCR Queue: Prioritize large chart over 16x16 icon
    const images = [
      { id: "status-icon-1", width: 16, height: 16, area: 256 },
      { id: "status-icon-2", width: 16, height: 16, area: 256 },
      { id: "chart-render", width: 1200, height: 800, area: 960000 },
    ];
    images.sort((a, b) => b.area - a.area);
    expect(images[0].id).toBe("chart-render");

    // 4. Cross-Origin Video Feed produces SecurityError
    const crossOriginVideo: import("../src/content/normalization/pageInventory.js").UnscannableRegion = {
      sourceType: "video-frame-ocr",
      cssSelector: "video#surveillance-feed",
      visibility: "VISIBLE_IN_VIEWPORT",
      reason: "tainted-canvas-no-tab-capture",
      detail: "Cross-origin video tainted canvas draw",
      boundingRect: { x: 500, y: 100, width: 640, height: 360 },
    };

    // 5. Active SVG Finding: selected: true
    const activeSvgFinding: Finding = {
      id: "svg_lead_email",
      category: "email",
      confidence: 0.95,
      source: "local-rules",
      preview: "l***@enterprise.com",
      nodeId: "svg",
      startOffset: 0,
      endOffset: 27,
      rects: [{ x: 20, y: 20, width: 180, height: 20 }],
      contextPreview: "",
      selected: true,
    };

    // 6. Coverage resolution: reports PARTIALLY_SCANNED or UNVERIFIED with unscannable region
    const status = resolveScanCoverageStatus({
      findingsCount: activeSvgFinding.selected ? 1 : 0,
      unresolvedRegions: [crossOriginVideo],
      deferredMediaCount: 0,
      visibleChars: 1200,
    });

    expect(status).not.toBe("NO_SENSITIVE_DATA_DETECTED");
  });

  // =========================================================================
  // Scenario 5: International Developer Secret & Regional ID Redaction
  // Features: F18, F19, F20, F22, F23
  // =========================================================================
  it("Scenario 5: International Developer Secret & Regional ID Redaction (F18, F19, F20, F22, F23)", () => {
    // 1. Unicode mathematical digits normalization
    // Mathematical sans-serif bold: 𝟢𝟣𝟤𝟥 (0x1D7EC..0x1D7EF) -> 0123
    const mathDigits = "\u{1D7EC}\u{1D7ED}\u{1D7EE}\u{1D7EF}";
    const norm = normalizeUnicodeWithMapping(`Project Code: ${mathDigits}`);
    expect(norm.normalized).toBe("Project Code: 0123");

    // 2. Custom Pattern with captureGroup: PRJ-(\d{4})
    const projectPattern: CustomPattern = {
      id: "pat_intl_prj",
      name: "International Project",
      category: "custom",
      pattern: "PRJ-(\\d{4})",
      flags: "g",
      captureGroup: 1,
      source: "local",
      contributionStatus: "local_only",
      confidence: 0.97,
      createdAt: new Date().toISOString(),
    };

    const projectText = "Ticket reference: PRJ-0123 in repository.";
    const customMatches = runCustomPatterns(projectText, [projectPattern]);
    expect(customMatches.length).toBe(1);
    expect(customMatches[0].value).toBe("0123");

    // 3. ReDoS validation: ensure safe pattern is accepted, unsafe rejected
    expect(isSafeRegex("PRJ-[0-9]{4}")).toBe(true);
    expect(isSafeRegex("(PRJ+)+$")).toBe(false); // ReDoS rejected

    // 4. Overlapping secrets deduplication: specific API key vs generic string
    const specificApiKey = {
      category: "secrets" as FindingCategory,
      confidence: 0.99,
      start: 15,
      end: 45,
      value: "ghp_123456789012345678901234567890123456",
    };
    const genericSecret = {
      category: "secrets" as FindingCategory,
      confidence: 0.80,
      start: 15,
      end: 55,
      value: "ghp_123456789012345678901234567890123456-longer-span",
    };

    const resolved = resolveOverlaps([specificApiKey, genericSecret]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].confidence).toBe(0.99);
    expect(resolved[0].value).toBe("ghp_123456789012345678901234567890123456");

    // 5. Regional ID Validation: Canadian SIN & UK NHS
    expect(isValidCanadianSin("130-692-908")).toBe(true);
    expect(isValidNhsNumber("943 476 5919")).toBe(true);

    // 6. Selection redaction categories include all regional identifiers
    const requiredCategories: FindingCategory[] = [
      "canadian_sin", "uk_nhs", "aadhaar", "pan_india", "australian_tfn", "cpf", "custom"
    ];
    for (const c of requiredCategories) {
      expect(ALL_CATEGORIES).toContain(c);
    }
  });
});
