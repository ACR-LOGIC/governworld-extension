// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Exports Chrome Web Store assets and listing description to the user's Desktop.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = "C:\\Users\\omg\\Desktop\\GovernWorld_Chrome_Store_Assets";
mkdirSync(desktopDir, { recursive: true });

console.log(`Target desktop directory: ${desktopDir}`);

// 1. Copy Store Icon (128x128 with 96x96 artwork + 16px padding)
const iconSrc = join(root, "release", "images", "store-icon-128x128.png");
if (existsSync(iconSrc)) {
  copyFileSync(iconSrc, join(desktopDir, "store-icon-128x128.png"));
  console.log("Copied: store-icon-128x128.png");
}

// 2. Copy Small Promo Tile (440x280)
const promoSmall = join(root, "release", "images", "promo-tile-440x280.png");
if (existsSync(promoSmall)) {
  copyFileSync(promoSmall, join(desktopDir, "small-promo-tile-440x280.png"));
  console.log("Copied: small-promo-tile-440x280.png");
}

// 3. Copy Marquee Promo Tile (1400x560)
const promoMarquee = join(root, "release", "images", "marquee-promo-tile-1400x560.png");
if (existsSync(promoMarquee)) {
  copyFileSync(promoMarquee, join(desktopDir, "marquee-promo-tile-1400x560.png"));
  console.log("Copied: marquee-promo-tile-1400x560.png");
}

// 4. Copy 5 Screenshots (1280x800)
const screenshots = [
  { src: "01-protection-idle.png", dest: "screenshot-1-protection-idle.png" },
  { src: "02-findings-masked.png", dest: "screenshot-2-findings-masked.png" },
  { src: "03-page-masks-applied.png", dest: "screenshot-3-page-masks-applied.png" },
  { src: "04-document-studio.png", dest: "screenshot-4-document-studio.png" },
  { src: "05-settings-about.png", dest: "screenshot-5-settings-about.png" },
];

for (const s of screenshots) {
  const p = join(root, "release", "screenshots", s.src);
  if (existsSync(p)) {
    copyFileSync(p, join(desktopDir, s.dest));
    console.log(`Copied: ${s.dest}`);
  }
}

// 5. Generate Full Chrome Web Store Description (< 16,000 chars)
const description = `GovernWorld Redaction is a local-first browser extension designed to protect sensitive personal and healthcare information directly inside your browser. Detect, inspect, visually mask, and redact sensitive data in live webpages, clipboard operations, and document files—completely on your device with zero cloud data exfiltration.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
► KEY CAPABILITIES & FEATURES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. 100% ON-DEVICE DETECTION (ZERO EGRESS)
• All pattern matching, regex evaluation, and OCR tokenization run strictly inside your local browser memory (CPU/GPU).
• Zero raw page text, document bytes, or unmasked values ever leave your computer.
• Operates seamlessly offline without requiring an internet connection or account login.

2. ON-DEMAND WEBPAGE SCANNING & VISUAL MASKING
• Scan active web pages on demand with a single click or keyboard hotkey (Alt+Shift+S).
• Review detected sensitive entities with masked previews (e.g., SSN: •••-••-9999, Phone: (•••) •••-1234).
• Apply non-destructive visual overlay masks directly into the webpage DOM using isolated Shadow DOM encapsulation.
• Safely share screens, deliver presentations, or capture screenshots without exposing private client records.

3. PASTE SHIELD & CLIPBOARD INTERCEPTION
• Automatically guards pastes into web chats, public AI models (ChatGPT, Claude, Gemini), text editors, and CRM forms.
• Intercepts accidental leakage of Social Security Numbers, payment cards, patient identifiers, and secret credentials before form submission.
• Configurable protection modes: Off, This Tab (ephemeral activeTab protection), or Always-On with user-approved site access.

4. OFFLINE DOCUMENT STUDIO (PDF, DOCX, IMAGES)
• Drag and drop PDF files, Microsoft Word (.docx) documents, and images (.png, .jpg, .webp) up to 20 MB.
• Fully bundled offline WebAssembly OCR engine (Tesseract.js) and PDF renderer (pdf.js)—no external model downloads.
• Full-screen interactive review workspace: inspect token boundaries, draw custom redaction boxes, and toggle individual findings.
• Export true, flattened, cryptographically verified redacted documents where sensitive text and image layers are permanently removed.

5. REGULATORY COMPLIANCE DETECTION PROFILES
One-click compliance presets configure detection categories to match industry regulatory standards:
• HIPAA (US Healthcare: PHI, Medical Record Numbers, NPI, DEA, Medicare MBI)
• PCI DSS (Payment Cards: Visa, Mastercard, Amex, Discover, CVV, Cardholder data)
• GDPR / UK GDPR (European & UK Data Protection: NHS numbers, IBANs, passports, identity codes)
• PIPEDA (Canadian Social Insurance Numbers - SIN)
• Global Identifiers: Indian Aadhaar & PAN, Australian TFN, Brazilian CPF
• Developer Secrets: API Keys, AWS tokens, GitHub personal access tokens, private keys

6. CUSTOM REDACTION LOGIC & INTERACTIVE WIZARD
• Build bespoke detection rules tailored to your organization's internal document formats and employee IDs.
• 4-stage guided creation wizard: Examples → Automated Proposals → Regex Refinement → Local Testing.
• Live test sandbox with instant positive and negative matching feedback.

7. COMPREHENSIVE NOTIFICATION SYSTEM
• Multi-channel alerts: Toolbar badge finding counts, non-intrusive in-page toast notifications, and optional system desktop alerts.
• Granular event triggers: Get alerted specifically on critical PII findings, Paste Shield interceptions, or policy changes.
• Notification Privacy Modes: Choose between "Detailed" (shows entity counts) and "Minimal" (zero category disclosure for screen-sharing security).

8. CRYPTOGRAPHIC AUDIT TRAILS & INTEGRITY VERIFICATION
• Every scan, redaction, and policy change writes a verifiable, ECDSA-signed local audit record.
• SHA-256 hash-chaining prevents log tampering, deletion, or rollback attacks.
• One-click export of verifiable audit evidence for enterprise compliance reviews and compliance proof.

9. ACCESSIBILITY & INTERNATIONALIZATION
• Translated into 7 complete UI languages: English, Español, Français, Deutsch, 日本語, Português, and 简体中文.
• Accessibility features: High contrast mode, OpenDyslexic typography, reduced motion, and ARIA-compliant screen reader announcements.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
► PRIVACY BY ARCHITECTURE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
GovernWorld is architected under strict zero-trust, local-only engineering principles:
• NO Install-Time Host Permissions: The extension installs with zero default access to any website. Page access is granted ephemerally only when you click "Scan this page".
• NO Background Telemetry: No Google Analytics, no tracking pixels, no user session recording.
• NO Cloud Inference: Machine learning and OCR run in an offscreen WebAssembly sandbox on your machine.
• NO Dynamic Script Execution: Strict Manifest V3 Content Security Policy (CSP) forbidding 'unsafe-eval' and external script loaders.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
► KEYBOARD SHORTCUTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Alt + Shift + E: Open the GovernWorld popup interface
• Alt + Shift + S: Instantly scan the current page for sensitive data
• Alt + Shift + M: Apply or toggle visual redaction masks
• Alt + Shift + P: Open the side panel workspace

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
► RIGHT-CLICK CONTEXT ACTIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Highlight any text on a webpage and right-click to:
• "Redact Selection to Clipboard": Sanitizes sensitive values and copies cleaned text directly to your clipboard.
• "Mask Selected Text": Places an instant visual mask over the highlighted element.
• "Scan Page for Sensitive Data": Initiates a targeted scan on the current document.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
► WHO IS GOVERNWORLD FOR?
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Healthcare Professionals & Clinical Staff handling HIPAA-regulated patient medical records (PHI).
• Legal, Compliance, & HR Teams reviewing employee records, background checks, and confidential contracts.
• Financial Analysts & Accountants protecting banking data, credit card numbers, and tax identifiers.
• Software Engineers & DevOps Teams preventing secret keys, database credentials, and tokens from leaking into web forms or AI prompts.
• Remote Workers & Educators sharing screens and presenting sensitive browser tabs.

Keep your sensitive information where it belongs—safely on your device. Install GovernWorld Redaction today.`;

writeFileSync(join(desktopDir, "CHROME_WEB_STORE_DESCRIPTION.txt"), description, "utf8");
console.log(`Saved: CHROME_WEB_STORE_DESCRIPTION.txt (${description.length} characters)`);

// 6. Generate Store Submission Checklist & Justifications Guide
const checklist = `# Chrome Web Store Submission Checklist & Asset Package

This folder contains all required and optional assets formatted strictly according to Google Chrome Web Store specifications.

## 1. Asset Inventory in this Folder
- **store-icon-128x128.png**: 128x128 px Canvas with 96x96 centered artwork (16px padding on all sides per CWS guidelines).
- **small-promo-tile-440x280.png**: 440x280 px Canvas, 24-bit RGB PNG (no alpha).
- **marquee-promo-tile-1400x560.png**: 1400x560 px Canvas, 24-bit RGB PNG (no alpha).
- **screenshot-1-protection-idle.png**: 1280x800 px, 24-bit RGB PNG (no alpha).
- **screenshot-2-findings-masked.png**: 1280x800 px, 24-bit RGB PNG (no alpha).
- **screenshot-3-page-masks-applied.png**: 1280x800 px, 24-bit RGB PNG (no alpha).
- **screenshot-4-document-studio.png**: 1280x800 px, 24-bit RGB PNG (no alpha).
- **screenshot-5-settings-about.png**: 1280x800 px, 24-bit RGB PNG (no alpha).
- **CHROME_WEB_STORE_DESCRIPTION.txt**: Ready-to-copy store listing text (${description.length} chars / 16,000 max).

## 2. Store Dashboard Fields Cheat-Sheet

### Basic Information
- **Name**: GovernWorld Redaction
- **Summary**: Local-first PII/PHI detection and redaction for pages and documents. On-device processing keeps your data private.
- **Category**: Productivity / Privacy & Security
- **Version**: 0.2.0

### URLs
- **Privacy Policy URL**: https://governworld.acrlogic.com/chrome-extension-privacy
- **Support / Website URL**: https://governworld.acrlogic.com/extension

### Permission Justifications (Copy into Dashboard Privacy tab)
- **activeTab**: "Allows the user to initiate on-demand visual PII/PHI detection on the currently active tab without requiring broad site access."
- **scripting**: "Injects the temporary visual redaction mask overlay into the webpage DOM upon user request."
- **storage**: "Persists user preferences, custom detection regex rules, and cryptographic audit records locally on the user's device."
- **downloads**: "Enables the user to save verified flattened redacted documents (PDF/PNG) and export signed audit logs to their local filesystem."
- **offscreen**: "Executes client-side WebAssembly OCR (Tesseract.js) and PDF canvas rasterization in a background sandbox without blocking the extension service worker."
- **sidePanel**: "Provides a persistent side-by-side workspace for document redaction and page inspection alongside normal browsing."
- **contextMenus**: "Provides quick-action right-click options ('Redact Selection to Clipboard' and 'Mask Selection')."

### Data Usage Declarations
- **Single Purpose**: "Local-first sensitive information (PII/PHI) detection, visual masking, and document redaction."
- **Does this extension collect user data?**: Select "No" (All processing is client-side, zero data collected or sold).
`;

writeFileSync(join(desktopDir, "STORE_SUBMISSION_CHECKLIST.md"), checklist, "utf8");
console.log("Saved: STORE_SUBMISSION_CHECKLIST.md");

console.log("\nALL DESKTOP ASSETS EXPORTED SUCCESSFULLY!");
