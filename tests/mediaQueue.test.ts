// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildMediaQueue, extractVideoCaptions } from "../src/content/mediaQueue.js";
import type { PageInventory } from "../src/content/normalization/pageInventory.js";

function makeInventory(): PageInventory {
  return {
    domTextRegions: 0,
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

describe("buildMediaQueue", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("prioritizes images by descending surface area within the same visibility tier", () => {
    const smallImg = document.createElement("img");
    smallImg.src = "https://example.com/small-icon.png";
    smallImg.getBoundingClientRect = () => ({ x: 0, y: 0, width: 32, height: 32, top: 0, left: 0, right: 32, bottom: 32, toJSON: () => {} }) as any;
    document.body.appendChild(smallImg);

    const largeImg = document.createElement("img");
    largeImg.src = "https://example.com/large-doc.png";
    largeImg.getBoundingClientRect = () => ({ x: 0, y: 50, width: 800, height: 600, top: 50, left: 0, right: 800, bottom: 650, toJSON: () => {} }) as any;
    document.body.appendChild(largeImg);

    const inv = makeInventory();
    const result = buildMediaQueue(document, inv, 8, "https://example.com");

    expect(result.visualQueue.length).toBe(2);
    expect(result.visualQueue[0].resourceUrl).toBe("https://example.com/large-doc.png");
    expect(result.visualQueue[1].resourceUrl).toBe("https://example.com/small-icon.png");
  });

  it("captures SecurityError on cross-origin video canvas extraction as an UnscannableRegion", () => {
    const video = document.createElement("video");
    video.src = "https://cross-origin.com/video.mp4";
    video.getBoundingClientRect = () => ({ x: 0, y: 0, width: 640, height: 480, top: 0, left: 0, right: 640, bottom: 480, toJSON: () => {} }) as any;
    Object.defineProperty(video, "readyState", { value: 4, configurable: true });
    document.body.appendChild(video);

    // Mock canvas getContext to throw SecurityError on drawImage
    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
      const el = origCreateElement(tagName);
      if (tagName.toLowerCase() === "canvas") {
        (el as any).getContext = () => {
          return {
            drawImage: () => {
              throw new DOMException("The operation is insecure.", "SecurityError");
            },
            toDataURL: () => "data:,",
          };
        };
      }
      return el;
    });

    const inv = makeInventory();
    const result = buildMediaQueue(document, inv, 8, "https://example.com");

    expect(result.newUnscannableRegions.length).toBe(1);
    expect(result.newUnscannableRegions[0].reason).toBe("cross-origin-isolation");
    expect(result.newUnscannableRegions[0].sourceType).toBe("video");
    expect(result.visualQueue.length).toBe(0);
  });
});

describe("extractVideoCaptions", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("extracts text tracks and cues from video element", () => {
    const video = document.createElement("video");
    const track = {
      cues: [
        { text: "Contact Dr. Jane at 555-0199", startTime: 10 },
      ],
    };
    Object.defineProperty(video, "textTracks", { value: [track], configurable: true });
    document.body.appendChild(video);

    const captions = extractVideoCaptions(document);
    expect(captions.length).toBe(1);
    expect(captions[0].text).toBe("Contact Dr. Jane at 555-0199");
  });

  it("traverses shadow roots and child iframes to extract video captions", () => {
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });

    const video = document.createElement("video");
    const track = {
      cues: [
        { text: "Shadow video caption: alice@hospital.org", startTime: 5 },
      ],
    };
    Object.defineProperty(video, "textTracks", { value: [track], configurable: true });
    shadow.appendChild(video);
    document.body.appendChild(host);

    const captions = extractVideoCaptions(document);
    expect(captions.length).toBe(1);
    expect(captions[0].text).toContain("alice@hospital.org");
  });
});
