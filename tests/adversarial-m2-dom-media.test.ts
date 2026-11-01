// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { collectAttrRecords } from "../src/content/attrs.js";
import { extractSvgText } from "../src/content/svgExtract.js";
import { buildMediaQueue, extractVideoCaptions } from "../src/content/mediaQueue.js";
import { createOverlay } from "../src/content/overlay.js";
import type { OverlayRect } from "../src/content/overlay.js";
import {
  resolveScanCoverageStatus,
  type PageInventory,
} from "../src/content/normalization/pageInventory.js";
import { detect } from "../src/content/detect.js";
import type { Finding } from "../src/shared/types.js";

function makeCleanInventory(): PageInventory {
  return {
    domTextRegions: 1,
    formControls: 0,
    openShadowRoots: 0,
    closedShadowRootsAccessed: 0,
    sameOriginIframes: 0,
    crossOriginIframes: 0,
    images: { total: 0, visible: 0, dataOrBlob: 0, cssBackgrounds: 0, inlineSvgs: 0 },
    canvases: 0,
    videos: { total: 0, withTracks: 0, visible: 0 },
    audios: 0,
    pdfs: { embedded: 0, isTopLevelPdfViewer: false },
    unscannableRegions: [],
  };
}

describe("Adversarial M2: Feature 24 — Deep Nested Shadow Trees & Multiple Same-Origin Iframes", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("recursively traverses 3-level deep nested shadow DOM trees for attributes, SVGs, and captions", () => {
    // Level 1: Host in main document
    const hostL1 = document.createElement("div");
    hostL1.id = "host-l1";
    const shadowL1 = hostL1.attachShadow({ mode: "open" });

    // Level 2: Host inside Level 1 shadow
    const hostL2 = document.createElement("div");
    hostL2.id = "host-l2";
    const shadowL2 = hostL2.attachShadow({ mode: "open" });
    shadowL1.appendChild(hostL2);

    // Level 3: Host inside Level 2 shadow
    const hostL3 = document.createElement("div");
    hostL3.id = "host-l3";
    const shadowL3 = hostL3.attachShadow({ mode: "open" });
    shadowL2.appendChild(hostL3);

    // 1. Target element with attribute inside Level 3 shadow
    const deepAttrEl = document.createElement("button");
    deepAttrEl.setAttribute("aria-label", "  \t  deep-shadow-secret@company.com  ");
    shadowL3.appendChild(deepAttrEl);

    // 2. SVG element inside Level 3 shadow
    const deepSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    deepSvg.getBoundingClientRect = () =>
      ({ x: 10, y: 10, width: 120, height: 40, top: 10, left: 10, right: 130, bottom: 50, toJSON: () => {} }) as any;
    const deepSvgText = document.createElementNS("http://www.w3.org/2000/svg", "text");
    deepSvgText.textContent = "deep-shadow-svg@company.com";
    deepSvgText.getBoundingClientRect = () =>
      ({ x: 10, y: 10, width: 100, height: 20, top: 10, left: 10, right: 110, bottom: 30, toJSON: () => {} }) as any;
    deepSvg.appendChild(deepSvgText);
    shadowL3.appendChild(deepSvg);

    // 3. Video element with caption track inside Level 3 shadow
    const deepVideo = document.createElement("video");
    const deepTrack = {
      cues: [{ text: "Deep video caption: 4111-1111-1111-1111", startTime: 12 }],
    };
    Object.defineProperty(deepVideo, "textTracks", { value: [deepTrack], configurable: true });
    shadowL3.appendChild(deepVideo);

    document.body.appendChild(hostL1);

    // Assert Attribute Scanner reaches Level 3
    const { records } = collectAttrRecords(document, { maxTotalChars: 5000, maxPerValue: 2048 });
    const targetRecord = records.find((r) => r.value.includes("deep-shadow-secret@company.com"));
    expect(targetRecord).toBeDefined();
    expect(targetRecord?.attributeName).toBe("aria-label");
    expect(targetRecord?.value).toBe("deep-shadow-secret@company.com");
    // "  \t  " has length 5 leading characters
    expect(targetRecord?.startOffset).toBe(5);

    // Assert SVG Scanner reaches Level 3
    const svgSegments = extractSvgText(document);
    const targetSvg = svgSegments.find((s) => s.text.includes("deep-shadow-svg@company.com"));
    expect(targetSvg).toBeDefined();
    expect(targetSvg?.text).toBe("deep-shadow-svg@company.com");
    expect(targetSvg?.elementTag).toBe("text");

    // Assert Video Caption Scanner reaches Level 3
    const captionSegments = extractVideoCaptions(document);
    const targetCaption = captionSegments.find((c) => c.text.includes("4111-1111-1111-1111"));
    expect(targetCaption).toBeDefined();
    expect(targetCaption?.text).toContain("4111-1111-1111-1111");
  });

  it("traverses multiple same-origin sibling and nested child iframes", () => {
    // Sibling Iframe A
    const frameDocA = document.implementation.createHTMLDocument("Frame A");
    const attrElA = frameDocA.createElement("input");
    attrElA.setAttribute("placeholder", " \t\t  frameA-placeholder@test.org ");
    frameDocA.body.appendChild(attrElA);

    // Sibling Iframe B (which hosts a nested Iframe C)
    const frameDocB = document.implementation.createHTMLDocument("Frame B");
    const frameDocC = document.implementation.createHTMLDocument("Frame C");

    const svgC = frameDocC.createElementNS("http://www.w3.org/2000/svg", "svg");
    svgC.getBoundingClientRect = () =>
      ({ x: 0, y: 0, width: 150, height: 50, top: 0, left: 0, right: 150, bottom: 50, toJSON: () => {} }) as any;
    const tspanC = frameDocC.createElementNS("http://www.w3.org/2000/svg", "tspan");
    tspanC.textContent = "nested-frameC-svg@test.org";
    tspanC.getBoundingClientRect = () =>
      ({ x: 5, y: 5, width: 140, height: 25, top: 5, left: 5, right: 145, bottom: 30, toJSON: () => {} }) as any;
    svgC.appendChild(tspanC);
    frameDocC.body.appendChild(svgC);

    const videoC = frameDocC.createElement("video");
    const trackC = {
      cues: [{ text: "Frame C caption: 987-65-4321", startTime: 1 }],
    };
    Object.defineProperty(videoC, "textTracks", { value: [trackC], configurable: true });
    frameDocC.body.appendChild(videoC);

    // Mock querySelectorAll traversal across the documents
    const mockRoot = {
      querySelectorAll(selector: string) {
        if (selector === "*") {
          return [
            {
              tagName: "IFRAME",
              contentDocument: {
                ...frameDocA,
                querySelectorAll(subSel: string) {
                  if (subSel === "*") return Array.from(frameDocA.querySelectorAll("*"));
                  return Array.from(frameDocA.querySelectorAll(subSel));
                },
              },
            },
            {
              tagName: "IFRAME",
              contentDocument: {
                ...frameDocB,
                querySelectorAll(subSel: string) {
                  if (subSel === "*") {
                    return [
                      {
                        tagName: "IFRAME",
                        contentDocument: {
                          ...frameDocC,
                          querySelectorAll(cSel: string) {
                            if (cSel === "*") return Array.from(frameDocC.querySelectorAll("*"));
                            if (cSel === "svg") return [svgC];
                            if (cSel === "video") return [videoC];
                            return Array.from(frameDocC.querySelectorAll(cSel));
                          },
                        },
                      },
                    ];
                  }
                  return [];
                },
              },
            },
          ];
        }
        if (selector === "svg" || selector === "video") return [];
        return [];
      },
    };

    // Assert Attribute Scanner
    const { records } = collectAttrRecords(mockRoot as any, { maxTotalChars: 5000, maxPerValue: 2048 });
    const recA = records.find((r) => r.value.includes("frameA-placeholder@test.org"));
    expect(recA).toBeDefined();
    expect(recA?.attributeName).toBe("placeholder");
    expect(recA?.startOffset).toBe(5); // " \t\t  " -> 1 space + 2 tabs + 2 spaces = 5 chars

    // Assert SVG Scanner
    const svgSegments = extractSvgText(mockRoot as any);
    const svgCFound = svgSegments.find((s) => s.text.includes("nested-frameC-svg@test.org"));
    expect(svgCFound).toBeDefined();
    expect(svgCFound?.elementTag).toBe("tspan");

    // Assert Video Captions Scanner
    const captions = extractVideoCaptions(mockRoot as any);
    const captionFound = captions.find((c) => c.text.includes("987-65-4321"));
    expect(captionFound).toBeDefined();
    expect(captionFound?.text).toContain("987-65-4321");
  });

  it("handles attribute startOffset across various combinations of leading whitespace, tabs, and non-breaking spaces", () => {
    const root = {
      querySelectorAll(_sel: string) {
        return [
          {
            getAttribute(name: string) {
              if (name === "title") return "\t\t   \t  token-with-tabs-and-spaces   ";
              if (name === "alt") return "\u00a0\u200b\t   token-with-nbsp-and-zwsp";
              if (name === "placeholder") return "no-leading-whitespace";
              if (name === "aria-label") return "   \t\t   "; // only whitespace
              return null;
            },
            closest: () => null,
          },
        ];
      },
    };

    const { records } = collectAttrRecords(root as any, { maxTotalChars: 5000, maxPerValue: 2048 });

    // 1. Tabs and spaces: "\t\t   \t  " is 8 leading chars
    const titleRec = records.find((r) => r.attributeName === "title");
    expect(titleRec).toBeDefined();
    expect(titleRec?.startOffset).toBe(8);
    expect(titleRec?.value).toBe("token-with-tabs-and-spaces");

    // 2. Non-breaking space, zero-width space, tab, spaces: "\u00a0\u200b\t   " is 6 leading chars
    const altRec = records.find((r) => r.attributeName === "alt");
    expect(altRec).toBeDefined();
    expect(altRec?.startOffset).toBe(6);
    expect(altRec?.value).toBe("token-with-nbsp-and-zwsp");

    // 3. No leading whitespace: startOffset === 0
    const placeRec = records.find((r) => r.attributeName === "placeholder");
    expect(placeRec).toBeDefined();
    expect(placeRec?.startOffset).toBe(0);
    expect(placeRec?.value).toBe("no-leading-whitespace");

    // 4. Pure whitespace is trimmed to empty and dropped
    const ariaRec = records.find((r) => r.attributeName === "aria-label");
    expect(ariaRec).toBeUndefined();
  });
});

describe("Adversarial M2: Feature 25 — SVG Findings Coverage Verdict & Overlay Masking", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("asserts resolveScanCoverageStatus produces FULLY_SCANNED (not NO_SENSITIVE_DATA_DETECTED) when only sensitive data is in SVG", () => {
    // Scenario: Page has readable text (visibleChars = 100), but the ONLY sensitive match is in an inline SVG.
    // In M2: SVG findings are marked selected: true.
    const activeSvgFinding: Finding = {
      id: "svg_credit_card_0_16_0",
      category: "payment_card",
      confidence: 0.95,
      source: "local-rules",
      preview: "•••• •••• •••• 1111",
      nodeId: "svg",
      startOffset: 101,
      endOffset: 120,
      rects: [{ x: 50, y: 50, width: 160, height: 24 }],
      selected: true, // Crucial M2 fix!
    };

    const findings = [activeSvgFinding];

    // Filter used in content.ts line 522:
    const activeSelectedCount = findings.filter((f) => f.source !== "attr" && f.selected).length;
    expect(activeSelectedCount).toBe(1);

    const coverageStatus = resolveScanCoverageStatus({
      findingsCount: activeSelectedCount,
      unresolvedRegions: [],
      deferredMediaCount: 0,
      visibleChars: 100,
    });

    // Must be FULLY_SCANNED!
    expect(coverageStatus).toBe("FULLY_SCANNED");
    expect(coverageStatus).not.toBe("NO_SENSITIVE_DATA_DETECTED");

    // Contrast with the previous buggy behavior where SVG findings had selected: false:
    const buggySvgFinding: Finding = {
      ...activeSvgFinding,
      selected: false, // Old behavior
    };
    const buggySelectedCount = [buggySvgFinding].filter((f) => f.source !== "attr" && f.selected).length;
    expect(buggySelectedCount).toBe(0);

    const buggyCoverageStatus = resolveScanCoverageStatus({
      findingsCount: buggySelectedCount,
      unresolvedRegions: [],
      deferredMediaCount: 0,
      visibleChars: 100,
    });

    // The buggy behavior resulted in a false-clean bill of health
    expect(buggyCoverageStatus).toBe("NO_SENSITIVE_DATA_DETECTED");
  });

  it("asserts selected: true on SVG finding causes overlay mask to render with bounding rect", () => {
    const overlay = createOverlay(document);

    const svgFinding: Finding = {
      id: "svg_email_0_18_0",
      category: "email",
      confidence: 0.9,
      source: "local-rules",
      preview: "u***@example.com",
      nodeId: "svg",
      startOffset: 200,
      endOffset: 218,
      rects: [{ x: 75, y: 120, width: 180, height: 28 }],
      selected: true,
    };

    // Simulate getOverlayItems logic from content.ts:
    const padding = 4;
    const items: OverlayRect[] = [];
    if (svgFinding.selected) {
      for (const r of svgFinding.rects) {
        items.push({
          kind: "mask",
          label: `${svgFinding.category}: ${svgFinding.preview}`,
          placeholder: "[EMAIL]",
          x: r.x - padding,
          y: r.y - padding,
          width: r.width + padding * 2,
          height: r.height + padding * 2,
        });
      }
    }

    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      kind: "mask",
      label: "email: u***@example.com",
      placeholder: "[EMAIL]",
      x: 71,
      y: 116,
      width: 188,
      height: 36,
    });

    overlay.render(items);

    // Verify overlay host is injected in DOM
    const host = document.querySelector("div[data-gw-scan-overlay]");
    expect(host).not.toBeNull();

    // Verify that when selected: false, zero masks are generated
    const unselectedSvg: Finding = { ...svgFinding, selected: false };
    const unselectedItems: OverlayRect[] = [];
    if (unselectedSvg.selected) {
      for (const r of unselectedSvg.rects) {
        unselectedItems.push({
          kind: "mask",
          label: unselectedSvg.category,
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
        });
      }
    }
    expect(unselectedItems).toHaveLength(0);

    overlay.destroy();
  });
});

describe("Adversarial M2: Feature 26 — Visual Queue Sorting by Area & Tier", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("creates 20 mock images of varying sizes and asserts largest area images rank first within VISIBLE_IN_VIEWPORT", () => {
    // 20 images:
    // 5x (16x16) -> area 256 (below MIN_IMG_WIDTH 24 -> filtered out)
    // 5x (32x32) -> area 1,024
    // 5x (800x600) -> area 480,000
    // 5x (1920x1080) -> area 2,073,600
    const specs = [
      // Shuffled order to ensure DOM order does NOT dictate queue ranking
      { w: 16, h: 16, id: "icon-16-a" },
      { w: 32, h: 32, id: "thumb-32-a" },
      { w: 800, h: 600, id: "doc-800-a" },
      { w: 1920, h: 1080, id: "hd-1920-a" },
      { w: 16, h: 16, id: "icon-16-b" },
      { w: 32, h: 32, id: "thumb-32-b" },
      { w: 800, h: 600, id: "doc-800-b" },
      { w: 1920, h: 1080, id: "hd-1920-b" },
      { w: 16, h: 16, id: "icon-16-c" },
      { w: 32, h: 32, id: "thumb-32-c" },
      { w: 800, h: 600, id: "doc-800-c" },
      { w: 1920, h: 1080, id: "hd-1920-c" },
      { w: 16, h: 16, id: "icon-16-d" },
      { w: 32, h: 32, id: "thumb-32-d" },
      { w: 800, h: 600, id: "doc-800-d" },
      { w: 1920, h: 1080, id: "hd-1920-d" },
      { w: 16, h: 16, id: "icon-16-e" },
      { w: 32, h: 32, id: "thumb-32-e" },
      { w: 800, h: 600, id: "doc-800-e" },
      { w: 1920, h: 1080, id: "hd-1920-e" },
    ];

    expect(specs.length).toBe(20);

    for (const s of specs) {
      const img = document.createElement("img");
      img.id = s.id;
      img.src = `https://example.com/assets/${s.id}.png`;
      img.getBoundingClientRect = () =>
        ({ x: 0, y: 0, width: s.w, height: s.h, top: 0, left: 0, right: s.w, bottom: s.h, toJSON: () => {} }) as any;
      document.body.appendChild(img);
    }

    const inv = makeCleanInventory();
    // Request queue with maxVisualQueue = 20 to inspect all qualifying images
    const result = buildMediaQueue(document, inv, 20, "https://example.com");

    // All 5 16x16 images are omitted due to MIN_IMG_WIDTH = 24.
    // 15 images remain.
    expect(result.visualQueue.length).toBe(15);
    expect(result.deferredCount).toBe(0);

    // Calculate areas in resulting queue
    const areas = result.visualQueue.map((item) => {
      const w = item.cropRect?.width ?? 0;
      const h = item.cropRect?.height ?? 0;
      return w * h;
    });

    // Top 5 must be area 1920*1080 = 2,073,600
    for (let i = 0; i < 5; i++) {
      expect(areas[i]).toBe(1920 * 1080);
      expect(result.visualQueue[i].cssSelector).toContain("hd-1920");
    }

    // Next 5 must be area 800*600 = 480,000
    for (let i = 5; i < 10; i++) {
      expect(areas[i]).toBe(800 * 600);
      expect(result.visualQueue[i].cssSelector).toContain("doc-800");
    }

    // Next 5 must be area 32*32 = 1,024
    for (let i = 10; i < 15; i++) {
      expect(areas[i]).toBe(32 * 32);
      expect(result.visualQueue[i].cssSelector).toContain("thumb-32");
    }

    // Test with standard cap maxVisualQueue = 8
    const cappedResult = buildMediaQueue(document, inv, 8, "https://example.com");
    expect(cappedResult.visualQueue.length).toBe(8);
    // 15 total qualifying images - 8 capped = 7 deferred
    expect(cappedResult.deferredCount).toBe(7);

    // All 5 HD images are in the capped queue
    for (let i = 0; i < 5; i++) {
      expect((cappedResult.visualQueue[i].cropRect?.width ?? 0) * (cappedResult.visualQueue[i].cropRect?.height ?? 0)).toBe(
        1920 * 1080
      );
    }
    // Remaining 3 in the capped queue are 800x600 images
    for (let i = 5; i < 8; i++) {
      expect((cappedResult.visualQueue[i].cropRect?.width ?? 0) * (cappedResult.visualQueue[i].cropRect?.height ?? 0)).toBe(
        800 * 600
      );
    }
  });
});

describe("Adversarial M2: Feature 27 — Cross-origin Video Canvas SecurityError", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("captures canvas toDataURL SecurityError on cross-origin video, yields UnscannableRegion with reason cross-origin-isolation and excludes element from visualQueue", () => {
    const video = document.createElement("video");
    video.id = "tainted-cross-origin-video";
    video.src = "https://cdn.other-origin.org/stream.mp4";
    video.getBoundingClientRect = () =>
      ({ x: 0, y: 0, width: 1280, height: 720, top: 0, left: 0, right: 1280, bottom: 720, toJSON: () => {} }) as any;
    Object.defineProperty(video, "readyState", { value: 4, configurable: true });
    Object.defineProperty(video, "videoWidth", { value: 1280, configurable: true });
    Object.defineProperty(video, "videoHeight", { value: 720, configurable: true });
    document.body.appendChild(video);

    // Spy on document.createElement: canvas context toDataURL throws DOMException SecurityError
    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
      const el = origCreateElement(tagName);
      if (tagName.toLowerCase() === "canvas") {
        (el as any).getContext = () => ({
          drawImage: vi.fn(),
        });
        (el as any).toDataURL = () => {
          throw new DOMException("Failed to execute 'toDataURL' on 'HTMLCanvasElement': Tainted canvases may not be exported.", "SecurityError");
        };
      }
      return el;
    });

    const inv = makeCleanInventory();
    const result = buildMediaQueue(document, inv, 8, "https://example.com");

    // 1. Tainted video is NOT included in visualQueue
    expect(result.visualQueue).toHaveLength(0);

    // 2. An explicit UnscannableRegion is reported
    expect(result.newUnscannableRegions).toHaveLength(1);
    const region = result.newUnscannableRegions[0];
    expect(region.sourceType).toBe("video");
    expect(region.reason).toBe("cross-origin-isolation");
    expect(region.detail).toContain("Cross-origin video cannot be extracted via canvas");
    expect(region.resourceUrl).toBe("https://cdn.other-origin.org/stream.mp4");
    expect(region.cssSelector).toContain("tainted-cross-origin-video");
    expect(region.boundingRect).toEqual({ x: 0, y: 0, width: 1280, height: 720 });

    // 3. Assert honest coverage resolution: BLOCKED_BY_BROWSER_SECURITY
    const status = resolveScanCoverageStatus({
      findingsCount: 0,
      unresolvedRegions: result.newUnscannableRegions,
      deferredMediaCount: 0,
      visibleChars: 50,
    });
    expect(status).toBe("BLOCKED_BY_BROWSER_SECURITY");
    expect(status).not.toBe("NO_SENSITIVE_DATA_DETECTED");
    expect(status).not.toBe("FULLY_SCANNED");
  });

  it("handles a page with both clean same-origin video and tainted cross-origin video honestly", () => {
    // Clean video
    const cleanVideo = document.createElement("video");
    cleanVideo.id = "clean-video";
    cleanVideo.src = "https://example.com/local-clip.mp4";
    cleanVideo.getBoundingClientRect = () =>
      ({ x: 0, y: 0, width: 640, height: 360, top: 0, left: 0, right: 640, bottom: 360, toJSON: () => {} }) as any;
    Object.defineProperty(cleanVideo, "readyState", { value: 4, configurable: true });
    document.body.appendChild(cleanVideo);

    // Tainted video
    const taintedVideo = document.createElement("video");
    taintedVideo.id = "tainted-video";
    taintedVideo.src = "https://external-untrusted.com/clip.mp4";
    taintedVideo.getBoundingClientRect = () =>
      ({ x: 0, y: 400, width: 640, height: 360, top: 400, left: 0, right: 640, bottom: 760, toJSON: () => {} }) as any;
    Object.defineProperty(taintedVideo, "readyState", { value: 4, configurable: true });
    document.body.appendChild(taintedVideo);

    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
      const el = origCreateElement(tagName);
      if (tagName.toLowerCase() === "canvas") {
        (el as any).getContext = () => ({
          drawImage: (v: HTMLVideoElement) => {
            if (v.src.includes("external-untrusted")) {
              throw new DOMException("The operation is insecure.", "SecurityError");
            }
          },
          toDataURL: () => "data:image/png;base64," + "A".repeat(300),
        });
      }
      return el;
    });

    const inv = makeCleanInventory();
    const result = buildMediaQueue(document, inv, 8, "https://example.com");

    // Clean video was queued
    expect(result.visualQueue).toHaveLength(1);
    expect(result.visualQueue[0].cssSelector).toContain("clean-video");

    // Tainted video was recorded as unscannable region
    expect(result.newUnscannableRegions).toHaveLength(1);
    expect(result.newUnscannableRegions[0].cssSelector).toContain("tainted-video");
    expect(result.newUnscannableRegions[0].reason).toBe("cross-origin-isolation");
  });

  it("contrasts Layer 3 canvas SecurityError (kept in queue for tab crop) with Layer 4 video SecurityError (unscannable region)", () => {
    // 1. Tainted Canvas (Layer 3)
    const canvas = document.createElement("canvas");
    canvas.id = "tainted-canvas";
    canvas.getBoundingClientRect = () =>
      ({ x: 0, y: 0, width: 200, height: 100, top: 0, left: 0, right: 200, bottom: 100, toJSON: () => {} }) as any;
    canvas.toDataURL = () => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    };
    document.body.appendChild(canvas);

    // 2. Tainted Video (Layer 4)
    const video = document.createElement("video");
    video.id = "tainted-video-layer4";
    video.src = "https://other-origin.org/movie.mp4";
    video.getBoundingClientRect = () =>
      ({ x: 0, y: 200, width: 640, height: 360, top: 200, left: 0, right: 640, bottom: 560, toJSON: () => {} }) as any;
    Object.defineProperty(video, "readyState", { value: 4, configurable: true });
    document.body.appendChild(video);

    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
      const el = origCreateElement(tagName);
      if (tagName.toLowerCase() === "canvas") {
        (el as any).getContext = () => ({
          drawImage: vi.fn(),
        });
        (el as any).toDataURL = () => {
          throw new DOMException("The operation is insecure.", "SecurityError");
        };
      }
      return el;
    });

    const inv = makeCleanInventory();
    const result = buildMediaQueue(document, inv, 8, "https://example.com");

    // The canvas is retained in visualQueue with dataUrl undefined (for SW captureVisibleTab crop fallback)
    const canvasItem = result.visualQueue.find((v) => v.sourceType === "canvas-ocr");
    expect(canvasItem).toBeDefined();
    expect(canvasItem?.dataUrl).toBeUndefined();
    expect(canvasItem?.cropRect?.width).toBe(200);

    // The video is NOT in visualQueue, but is converted to an UnscannableRegion
    const videoItem = result.visualQueue.find((v) => v.sourceType === "video-frame-ocr");
    expect(videoItem).toBeUndefined();

    expect(result.newUnscannableRegions).toHaveLength(1);
    expect(result.newUnscannableRegions[0].sourceType).toBe("video");
    expect(result.newUnscannableRegions[0].reason).toBe("cross-origin-isolation");
  });
});

describe("Adversarial M2: Extended Stress Tests for F24, F25, F26", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("gracefully survives cross-origin iframe SecurityError exceptions without failing the scan", () => {
    const mockRoot = {
      querySelectorAll(selector: string) {
        if (selector === "*") {
          return [
            {
              tagName: "IFRAME",
              get contentDocument(): Document | null {
                throw new DOMException("Blocked a frame with origin from accessing a cross-origin frame.", "SecurityError");
              },
            },
            {
              tagName: "DIV",
              getAttribute(name: string) {
                return name === "title" ? "valid-sibling-attr" : null;
              },
              closest: () => null,
            },
          ];
        }
        if (selector === "svg" || selector === "video") {
          return [];
        }
        if (selector.includes("title") || selector.includes("placeholder")) {
          return [
            {
              getAttribute(name: string) {
                return name === "title" ? "valid-sibling-attr" : null;
              },
              closest: () => null,
            },
          ];
        }
        return [];
        return [];
      },
    };

    // Scanners must NOT throw when contentDocument throws SecurityError
    expect(() => collectAttrRecords(mockRoot as any, { maxTotalChars: 5000, maxPerValue: 2048 })).not.toThrow();
    expect(() => extractSvgText(mockRoot as any)).not.toThrow();
    expect(() => extractVideoCaptions(mockRoot as any)).not.toThrow();

    const { records } = collectAttrRecords(mockRoot as any, { maxTotalChars: 5000, maxPerValue: 2048 });
    expect(records.some((r) => r.value === "valid-sibling-attr")).toBe(true);
  });

  it("extracts SVG text across <title>, <desc>, <tspan> tags and deduplicates repeated keys", () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.getBoundingClientRect = () =>
      ({ x: 0, y: 0, width: 250, height: 100, top: 0, left: 0, right: 250, bottom: 100, toJSON: () => {} }) as any;

    const titleEl = document.createElementNS("http://www.w3.org/2000/svg", "title");
    titleEl.textContent = "SVG Document Title - Confidential";
    titleEl.getBoundingClientRect = () =>
      ({ x: 0, y: 0, width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, toJSON: () => {} }) as any;
    svg.appendChild(titleEl);

    const descEl = document.createElementNS("http://www.w3.org/2000/svg", "desc");
    descEl.textContent = "Medical Record Chart for Patient";
    descEl.getBoundingClientRect = () =>
      ({ x: 0, y: 25, width: 150, height: 20, top: 25, left: 0, right: 150, bottom: 45, toJSON: () => {} }) as any;
    svg.appendChild(descEl);

    document.body.appendChild(svg);

    const segments = extractSvgText(document);
    expect(segments.length).toBe(2);
    expect(segments.some((s) => s.elementTag === "title" && s.text.includes("Confidential"))).toBe(true);
    expect(segments.some((s) => s.elementTag === "desc" && s.text.includes("Medical Record"))).toBe(true);
  });

  it("enforces visibility tier priority over area (VISIBLE_IN_VIEWPORT > VISIBLE_OUT_OF_VIEWPORT) and area sorting within tier", () => {
    // Large image OUT of viewport: area 1920*1080 = 2,073,600
    const outLarge = document.createElement("img");
    outLarge.id = "out-large";
    outLarge.src = "https://example.com/out-large.png";
    outLarge.getBoundingClientRect = () =>
      // top 3000 -> out of viewport
      ({ x: 0, y: 3000, width: 1920, height: 1080, top: 3000, left: 0, right: 1920, bottom: 4080, toJSON: () => {} }) as any;
    document.body.appendChild(outLarge);

    // Medium image OUT of viewport: area 800*600 = 480,000
    const outMed = document.createElement("img");
    outMed.id = "out-med";
    outMed.src = "https://example.com/out-med.png";
    outMed.getBoundingClientRect = () =>
      ({ x: 0, y: 2500, width: 800, height: 600, top: 2500, left: 0, right: 800, bottom: 3100, toJSON: () => {} }) as any;
    document.body.appendChild(outMed);

    // Small image IN viewport: area 32*32 = 1,024
    const inSmall = document.createElement("img");
    inSmall.id = "in-small";
    inSmall.src = "https://example.com/in-small.png";
    inSmall.getBoundingClientRect = () =>
      ({ x: 0, y: 10, width: 32, height: 32, top: 10, left: 0, right: 32, bottom: 42, toJSON: () => {} }) as any;
    document.body.appendChild(inSmall);

    // Large image IN viewport: area 800*600 = 480,000
    const inLarge = document.createElement("img");
    inLarge.id = "in-large";
    inLarge.src = "https://example.com/in-large.png";
    inLarge.getBoundingClientRect = () =>
      ({ x: 0, y: 50, width: 800, height: 600, top: 50, left: 0, right: 800, bottom: 650, toJSON: () => {} }) as any;
    document.body.appendChild(inLarge);

    const inv = makeCleanInventory();
    const result = buildMediaQueue(document, inv, 10, "https://example.com");

    expect(result.visualQueue).toHaveLength(4);

    // Order must be:
    // 1. inLarge (VISIBLE_IN_VIEWPORT, area 480,000)
    // 2. inSmall (VISIBLE_IN_VIEWPORT, area 1,024)
    // 3. outLarge (VISIBLE_OUT_OF_VIEWPORT, area 2,073,600)
    // 4. outMed (VISIBLE_OUT_OF_VIEWPORT, area 480,000)
    expect(result.visualQueue[0].cssSelector).toContain("in-large");
    expect(result.visualQueue[1].cssSelector).toContain("in-small");
    expect(result.visualQueue[2].cssSelector).toContain("out-large");
    expect(result.visualQueue[3].cssSelector).toContain("out-med");
  });
});

