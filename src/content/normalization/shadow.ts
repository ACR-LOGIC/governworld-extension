// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.

/**
 * The single implementation of shadow-root access.
 *
 * Chromium extensions can read *closed* shadow roots through
 * `chrome.dom.openOrClosedShadowRoot`, which is the only way to see inside a
 * web component that called `attachShadow({ mode: "closed" })`. Everywhere
 * else `element.shadowRoot` returns null for those, so the closed content is
 * invisible rather than merely absent.
 *
 * This was duplicated inline in extract.ts, canonical.ts (twice) and
 * pageInventory.ts. Each copy was a chance to drift — a copy that dropped the
 * try/catch throws on an element that cannot host a shadow root, and a copy
 * that forgot the Chromium branch silently scans half the page. This module
 * imports nothing so it stays usable from any context, including the unit
 * tests, where `chrome.dom` does not exist.
 */

/**
 * Returns the shadow root hosted by `element`, preferring the Chromium
 * extension API so closed roots are included. Returns null when the element
 * hosts no root, or when the API is unavailable (Firefox, unit tests).
 */
export function getAccessibleShadowRoot(element: Element): ShadowRoot | null {
  try {
    // chrome.dom is Chromium-only and absent from unit-test environments.
    const chromeApi = (globalThis as unknown as {
      chrome?: { dom?: { openOrClosedShadowRoot?: (el: HTMLElement) => ShadowRoot | null } };
    }).chrome;
    const root = chromeApi?.dom?.openOrClosedShadowRoot?.(element as HTMLElement);
    if (root) return root;
  } catch {
    // Not an extension context, or the element cannot host a root.
  }
  return element.shadowRoot ?? null;
}