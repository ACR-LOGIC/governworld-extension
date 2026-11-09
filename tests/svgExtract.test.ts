// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { extractSvgText } from "../src/content/svgExtract.js";

describe("extractSvgText", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("extracts text content from inline SVG elements", () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.getBoundingClientRect = () => ({ x: 0, y: 0, width: 200, height: 100, top: 0, left: 0, right: 200, bottom: 100, toJSON: () => {} }) as any;

    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.textContent = "support@governworld.org";
    text.getBoundingClientRect = () => ({ x: 10, y: 10, width: 150, height: 20, top: 10, left: 10, right: 160, bottom: 30, toJSON: () => {} }) as any;
    svg.appendChild(text);
    document.body.appendChild(svg);

    const segments = extractSvgText(document);
    expect(segments.length).toBeGreaterThan(0);
    expect(segments[0].text).toBe("support@governworld.org");
    expect(segments[0].elementTag).toBe("text");
  });

  it("skips small decorative SVGs below 24x14 dimensions", () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.getBoundingClientRect = () => ({ x: 0, y: 0, width: 16, height: 16, top: 0, left: 0, right: 16, bottom: 16, toJSON: () => {} }) as any;

    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.textContent = "Tiny Icon";
    svg.appendChild(text);
    document.body.appendChild(svg);

    const segments = extractSvgText(document);
    expect(segments).toHaveLength(0);
  });

  it("traverses accessible shadow roots to extract SVG text", () => {
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.getBoundingClientRect = () => ({ x: 0, y: 0, width: 100, height: 50, top: 0, left: 0, right: 100, bottom: 50, toJSON: () => {} }) as any;

    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.textContent = "shadow-svg@example.com";
    text.getBoundingClientRect = () => ({ x: 5, y: 5, width: 90, height: 20, top: 5, left: 5, right: 95, bottom: 25, toJSON: () => {} }) as any;
    svg.appendChild(text);
    shadow.appendChild(svg);
    document.body.appendChild(host);

    const segments = extractSvgText(document);
    expect(segments.length).toBe(1);
    expect(segments[0].text).toBe("shadow-svg@example.com");
  });

  it("traverses accessible child iframes to extract SVG text", () => {
    const frameDoc = document.implementation.createHTMLDocument("Frame");
    const svg = frameDoc.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.getBoundingClientRect = () => ({ x: 0, y: 0, width: 120, height: 60, top: 0, left: 0, right: 120, bottom: 60, toJSON: () => {} }) as any;

    const text = frameDoc.createElementNS("http://www.w3.org/2000/svg", "text");
    text.textContent = "iframe-svg@example.com";
    text.getBoundingClientRect = () => ({ x: 10, y: 10, width: 100, height: 20, top: 10, left: 10, right: 110, bottom: 30, toJSON: () => {} }) as any;
    svg.appendChild(text);
    frameDoc.body.appendChild(svg);

    const mockRoot = {
      querySelectorAll(selector: string) {
        if (selector === "svg") return [];
        if (selector === "*") {
          return [
            {
              tagName: "IFRAME",
              contentDocument: frameDoc,
            },
          ];
        }
        return [];
      },
    };

    const segments = extractSvgText(mockRoot as unknown as Document);
    expect(segments.length).toBe(1);
    expect(segments[0].text).toBe("iframe-svg@example.com");
  });

  it("uses preCollectedSvgs directly without walking the document", () => {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.getBoundingClientRect = () => ({ x: 0, y: 0, width: 200, height: 100, top: 0, left: 0, right: 200, bottom: 100, toJSON: () => {} }) as any;
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.textContent = "precollected-svg@example.com";
    text.getBoundingClientRect = () => ({ x: 10, y: 10, width: 150, height: 20, top: 10, left: 10, right: 160, bottom: 30, toJSON: () => {} }) as any;
    svg.appendChild(text);

    const segments = extractSvgText(document, [svg as unknown as SVGElement]);
    expect(segments.length).toBe(1);
    expect(segments[0].text).toBe("precollected-svg@example.com");
  });
});
