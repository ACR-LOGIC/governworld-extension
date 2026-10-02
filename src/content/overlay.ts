// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { OVERLAY_ATTR } from "./extract.js";
import type { Rect } from "../shared/types.js";

/**
 * Non-destructive overlay layer for candidate highlights and applied masks.
 * Lives in a shadow root so page CSS cannot interfere and vice versa.
 * This only overlays pixels in the browser; it never modifies the page's DOM
 * or server state, and is always removed when the scan session ends.
 */

/**
 * One painted rectangle. Exported so callers describe overlays with a real type
 * rather than an inline literal that can drift from the one used here.
 */
export interface OverlayRect extends Rect {
  kind: "highlight" | "mask";
  label: string;
  /** When set, the mask block renders this label in white on top (e.g. [SSN]). */
  placeholder?: string;
}

export interface OverlayController {
  render(items: OverlayRect[]): void;
  setBlocking(blocking: boolean): void;
  clear(): void;
  destroy(): void;
}

const HIGHLIGHT_COLOR = "rgba(255, 193, 7, 0.35)";
const HIGHLIGHT_BORDER = "2px solid rgba(255, 152, 0, 0.9)";
const MASK_COLOR = "#1a1a1a";
const MASK_BORDER = "1px solid #000";

/** Caps the longest placeholder so tiny spans degrade gracefully instead of overflowing. */
const MAX_PLACEHOLDER_WIDTH = 120;

export function createOverlay(root: Document): OverlayController {
  const existing = root.querySelector(`body > [${OVERLAY_ATTR}]`);
  if (existing) existing.remove();

  const host = root.createElement("div");
  host.setAttribute(OVERLAY_ATTR, "");
  host.setAttribute("aria-hidden", "true");
  Object.assign(host.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483646",
    pointerEvents: "none",
  } as Partial<CSSStyleDeclaration>);

  // CLOSED, not open. With an open root, page JavaScript could read every mask
  // rect, its category and its label straight out of `host.shadowRoot` — which
  // hands a third-party script a map of exactly where the PII on this page is,
  // a disclosure the user never agreed to and cannot see. It could also remove
  // the host and present the user with an unmasked page while the extension still
  // reported masks applied, which is the false assurance this tool exists to
  // avoid.
  //
  // Closing the root costs nothing here: `layer` is captured below, so painting
  // never goes back through the host. The host element itself stays in the light
  // DOM and keeps `data-gw-scan-overlay`, which is what lets the test harnesses
  // confirm the overlay exists without being able to read inside it.
  const shadow = host.attachShadow({ mode: "closed" });
  const layer = root.createElement("div");
  Object.assign(layer.style, {
    position: "fixed",
    inset: "0",
    overflow: "hidden",
    pointerEvents: "none",
  } as Partial<CSSStyleDeclaration>);
  shadow.appendChild(layer);

  let rects: OverlayRect[] = [];
  let blocking = false;
  let raf = 0;
  let destroyed = false;

  const applyStyle = (el: HTMLElement, rect: OverlayRect) => {
    Object.assign(el.style, {
      position: "absolute",
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      pointerEvents: blocking && rect.kind === "mask" ? "auto" : "none",
    } as Partial<CSSStyleDeclaration>);
    if (rect.kind === "mask") {
      el.style.backgroundColor = MASK_COLOR;
      el.style.border = MASK_BORDER;
    } else {
      el.style.backgroundColor = HIGHLIGHT_COLOR;
      el.style.border = HIGHLIGHT_BORDER;
      el.style.borderRadius = "2px";
    }
    el.setAttribute("data-kind", rect.kind);
    el.setAttribute("data-label", rect.label);
    if (rect.kind === "mask" && rect.placeholder) {
      el.style.display = "flex";
      el.style.alignItems = "center";
      el.style.justifyContent = "center";
      el.style.overflow = "hidden";
      el.style.whiteSpace = "nowrap";
      el.style.color = "#fff";
      el.style.fontFamily = '"Segoe UI", system-ui, sans-serif';
      el.style.fontWeight = "600";
      el.style.fontSize = "10px";
      el.style.lineHeight = "1";
      el.style.letterSpacing = "0.04em";
      el.style.textAlign = "center";
      el.style.textTransform = "uppercase";
      el.style.maxWidth = `${Math.max(rect.width, MAX_PLACEHOLDER_WIDTH)}px`;
      el.textContent = rect.placeholder;
    }
  };

  const paint = () => {
    if (destroyed) return;
    layer.replaceChildren();
    const vw = root.defaultView?.innerWidth ?? window.innerWidth;
    const vh = root.defaultView?.innerHeight ?? window.innerHeight;
    for (const rect of rects) {
      if (rect.x + rect.width < 0 || rect.y + rect.height < 0 || rect.x > vw || rect.y > vh) {
        continue; // off-viewport; skip
      }
      const el = root.createElement("div");
      applyStyle(el, rect);
      layer.appendChild(el);
    }
  };

  const schedulePaint = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      paint();
    });
  };

  const schedule = () => {
    if (rects.length === 0) return;
    schedulePaint();
  };

  const onScroll = () => schedule();
  const onResize = () => schedule();

  root.defaultView?.addEventListener("scroll", onScroll, { passive: true, capture: true });
  root.defaultView?.addEventListener("resize", onResize, { passive: true });

  const observer = typeof ResizeObserver !== "undefined"
    ? new ResizeObserver(schedule)
    : null;
  observer?.observe(root.body);

  root.body.appendChild(host);

  return {
    render(items) {
      rects = items;
      schedule();
    },
    setBlocking(value: boolean) {
      blocking = value;
      paint();
    },
    clear() {
      rects = [];
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      layer.replaceChildren();
    },
    destroy() {
      destroyed = true;
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      root.defaultView?.removeEventListener("scroll", onScroll, true);
      root.defaultView?.removeEventListener("resize", onResize);
      observer?.disconnect();
      host.remove();
    },
  };
}