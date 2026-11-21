// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Landing page behavior lives in an external file: MV3 `script-src 'self'`
// blocks inline scripts on extension pages, so nothing may run inside <script>.

/** Wire the tab strip so exactly one tab/panel pair is active. */
function initTabs() {
  const tabs = document.querySelectorAll(".tab");
  const panels = document.querySelectorAll(".panel");
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      const id = tab.dataset.tab;
      for (const t of tabs) t.setAttribute("aria-selected", String(t === tab));
      for (const p of panels) p.dataset.active = String(p.dataset.panel === id);
    });
  }
}

/** Wire hero/section CTAs that scroll to a target section. */
function initScrollCtas() {
  document.querySelectorAll("[data-scroll]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = document.getElementById(btn.dataset.scroll);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

/** Mount the GitHub Sponsors iframe only on http(s) origins where GitHub frame-ancestors allows it. */
function initSponsorButton() {
  const slot = document.getElementById("github-sponsor-slot");
  if (!slot) return;
  const proto = window.location.protocol;
  if (proto !== "http:" && proto !== "https:") return;
  const frame = document.createElement("iframe");
  frame.src = "https://github.com/sponsors/ACR-LOGIC/button";
  frame.title = "Sponsor ACR-LOGIC";
  frame.height = "32";
  frame.width = "114";
  frame.style.border = "0";
  frame.style.borderRadius = "6px";
  slot.replaceChildren(frame);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    initTabs();
    initScrollCtas();
    initSponsorButton();
  });
} else {
  initTabs();
  initScrollCtas();
  initSponsorButton();
}
