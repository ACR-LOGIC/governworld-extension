// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.

const invokerDocs = new WeakSet<Document>();

/**
 * Conditionally install local fallbacks for newly/limited available HTML
 * primitives when native browser support is absent, without using dynamic
 * code evaluation (`new Function` / `eval`) forbidden by MV3 CSP.
 */
export function ensureInvokerPolyfill(): void {
  if (
    typeof document === "undefined" ||
    typeof HTMLButtonElement === "undefined" ||
    "commandForElement" in HTMLButtonElement.prototype ||
    invokerDocs.has(document)
  ) {
    return;
  }
  invokerDocs.add(document);
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented) return;
    const target = event.target as Element | null;
    const button = target?.closest?.("button[commandfor][command]") as HTMLButtonElement | null;
    if (!button || button.disabled) return;
    if (button.form && button.getAttribute("type") !== "button") return;
    const targetId = button.getAttribute("commandfor");
    const command = (button.getAttribute("command") || "").toLowerCase();
    if (!targetId) return;
    const dialog = document.getElementById(targetId);
    if (!dialog || dialog.localName !== "dialog") return;
    const dlg = dialog as HTMLDialogElement;
    if (command === "show-modal" && !dlg.open) {
      dlg.showModal();
    } else if (command === "close" && dlg.open) {
      dlg.close();
    }
  });
}

export function ensureSwitchPolyfill(): void {
  if (
    typeof HTMLInputElement !== "undefined" &&
    typeof CSSStyleSheet !== "undefined" &&
    typeof document !== "undefined" &&
    "adoptedStyleSheets" in document &&
    !("switch" in HTMLInputElement.prototype)
  ) {
    void import("input-switch-polyfill").catch(() => {});
  }
}
