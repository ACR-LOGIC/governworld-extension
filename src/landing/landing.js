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

/** Lightweight client-side redaction preview for the landing page playground. */
function initLiveDemo() {
  const input = document.getElementById("demo-input");
  const output = document.getElementById("demo-output");
  const badges = document.getElementById("demo-badges");
  if (!input || !output || !badges) return;

  const PRESETS = {
    clinical:
      "Patient: Maria Gonzalez (DOB 04/22/1990), SSN 219-09-9999. Prescribed metformin 500mg BID for type 2 diabetes. Address: 123 Main St, Springfield, IL 62701.",
    chatbot:
      "Hey ChatGPT, summarize john.doe@example.test (Phone 555-234-5678, NPI 1234567893) taking lisinopril 10mg daily for hypertension.",
    secrets:
      "Card 4111-1111-1111-1111, API key sk_test_51N9xExampleKey9988, IP 203.0.113.42",
  };

  const RULES = [
    { label: "SSN", re: /\b\d{3}-\d{2}-\d{4}\b/g },
    { label: "CARD", re: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g },
    { label: "API KEY", re: /\bsk_(?:test|live)_[A-Za-z0-9]{8,}\b/g },
    { label: "EMAIL", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
    { label: "PHONE", re: /\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g },
    { label: "DOB", re: /\b\d{2}\/\d{2}\/\d{4}\b/g },
    { label: "NPI", re: /\bNPI\s+\d{10}\b/gi },
    { label: "IP ADDRESS", re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
    { label: "MEDICATION", re: /\b(?:metformin|lisinopril|atorvastatin|ozempic|amoxicillin)(?:\s+\d+(?:\.\d+)?\s*(?:mg|mcg|ml))?(?:\s+(?:bid|tid|qid|daily))?\b/gi },
    { label: "CONDITION", re: /\b(?:type\s+2\s+diabetes|hypertension|preeclampsia|croup)\b/gi },
    { label: "ADDRESS", re: /\b\d{1,5}\s+[A-Za-z0-9.\s]{2,30}\s+(?:St|Ave|Rd|Blvd|Plaza),?\s+[A-Za-z\s]+,?\s+[A-Z]{2}\s+\d{5}\b/g },
  ];

  function render() {
    const text = input.value || "";
    const hits = [];
    for (const r of RULES) {
      r.re.lastIndex = 0;
      for (const m of text.matchAll(r.re)) {
        if (m.index === undefined) continue;
        hits.push({ start: m.index, end: m.index + m[0].length, label: r.label });
      }
    }
    hits.sort((a, b) => a.start - b.start || b.end - a.end);
    const merged = [];
    let cursor = 0;
    for (const h of hits) {
      if (h.start >= cursor) {
        merged.push(h);
        cursor = h.end;
      }
    }

    output.textContent = "";
    let pos = 0;
    const foundLabels = new Set();
    for (const h of merged) {
      if (h.start > pos) {
        output.appendChild(document.createTextNode(text.slice(pos, h.start)));
      }
      const span = document.createElement("span");
      span.className = "demo-mask";
      span.textContent = `[REDACTED ${h.label}]`;
      output.appendChild(span);
      foundLabels.add(h.label);
      pos = h.end;
    }
    if (pos < text.length) {
      output.appendChild(document.createTextNode(text.slice(pos)));
    }

    badges.textContent = "";
    for (const lbl of foundLabels) {
      const b = document.createElement("span");
      b.className = "demo-badge";
      b.textContent = `✓ ${lbl}`;
      badges.appendChild(b);
    }
  }

  document.querySelectorAll("[data-demo-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.demoPreset;
      if (!PRESETS[key]) return;
      document.querySelectorAll("[data-demo-preset]").forEach((b) =>
        b.setAttribute("aria-pressed", String(b === btn))
      );
      input.value = PRESETS[key];
      render();
    });
  });

  input.addEventListener("input", render);
  render();
}

/** Click-to-zoom lightbox for real extension screenshots. */
function initLightbox() {
  const box = document.getElementById("gw-lightbox");
  const boxImg = document.getElementById("gw-lightbox-img");
  const closeBtn = document.getElementById("gw-lightbox-close");
  if (!box || !boxImg || !closeBtn) return;

  document.querySelectorAll("#showcase img").forEach((img) => {
    img.addEventListener("click", () => {
      boxImg.src = img.src;
      boxImg.alt = img.alt;
      box.hidden = false;
    });
  });

  const close = () => {
    box.hidden = true;
    boxImg.src = "";
  };
  closeBtn.addEventListener("click", close);
  box.addEventListener("click", (e) => {
    if (e.target === box) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !box.hidden) close();
  });
}

function boot() {
  initTabs();
  initScrollCtas();
  initSponsorButton();
  initLiveDemo();
  initLightbox();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
