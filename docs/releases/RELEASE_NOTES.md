# GovernWorld Extension — Release Notes

## Version 0.3.0 (Release Target: 2026-11-09)

GovernWorld Extension v0.3.0 introduces enterprise policy governance through the **GovernWorld Office Manager** coordination framework, formalized two-tier operating modes (**LOCAL** and **MANAGE**), a 3-tier setting ownership hierarchy, Ed25519 cryptographic policy verification, and offline continuity guarantees, while maintaining directly on-device zero-egress data privacy.

---

### Highlights & Key Capabilities

1. **Two Distinct Operating Modes:**
   - **LOCAL Mode (Standalone):** Autonomous, on-device operation requiring no account, no subscription, and no network coordination. Users maintain full control over detection categories, custom rules, and UI preferences.
   - **MANAGE Mode (Enterprise Managed):** Seamless enrollment with the organization's GovernWorld Office Manager infrastructure. The extension automatically receives, cryptographically verifies, and enforces administrator-approved policies.

2. **3-Tier Setting Ownership Classification:**
   - **Administrator-Controlled:** Mandated detection categories (e.g. SSN, credit cards, medical records, secrets), minimum protection modes (`always-on` or `this-tab`), and site-specific governance rules. Administrator settings cannot be weakened, bypassed, or removed by employees. Enforced at storage, background worker, configuration resolution, and message-handling boundaries.
   - **User-Controlled:** End-user preferences that do not compromise organizational security policies, such as custom regex rules in non-restricted domains, UI themes, dyslexia font scaling, screen reader sound announcements, and optional notifications.
   - **System-Controlled:** Tamper-resistant cryptographic audit signing (ECDSA P-256), offline WebAssembly OCR models, and strict zero-egress network sandboxing.

3. **Managed Policy Receiving & Cryptographic Security:**
   - **Cryptographic Ed25519 Signature Verification:** Policies received from the Office Manager via Supabase coordination infrastructure must be signed with the administrator's private key and verified against a pinned public key (`TRUSTED_POLICY_PUBLIC_KEY_JWK`). Unsigned or invalidly signed policies are rejected with `SIGNATURE_INVALID`.
   - **Deterministic Content Canonicalization:** Policy objects are canonically formatted and SHA-256 hashed prior to signature verification, preventing formatting attacks.
   - **Anti-Rollback / Anti-Downgrade Defense:** Strictly monotonic `policy_version` numbering. Policies with version numbers equal to or lower than the currently applied version are rejected with `VERSION_DOWNGRADE`.
   - **Anti-Replay Defense:** Enforces fresh nonces and timestamp verification within an allowable validation window (+/- 5 minutes).
   - **Targeting Validation:** Validates `organization_id`, `employee_id`, and `device_id` match enrollment credentials. Mismatched policies are rejected with `TARGET_MISMATCH`.
   - **Offline Continuity & Safe-State Design:** When disconnected or traveling offline, the extension preserves and continues enforcing the last valid policy. The extension never fails open or suspends protection due to lack of network connectivity.
   - **Minimal Status Acknowledgment:** Policy application reports minimal status metadata (`policy_id`, `policy_version`, applied timestamp, and status code). Zero sensitive content is ever transmitted.

4. **Extension Policy Updates vs. Extension Software Updates:**
   - **Policy Updates:** Signed JSON configuration envelopes dynamically retrieved by the extension at runtime (on startup, on install, on settings change, and bounded 15-minute intervals) without reinstalling or updating the extension binary.
   - **Software Updates:** Extension binary releases distributed through official browser stores (Chrome Web Store, Firefox AMO, Edge Add-ons) carrying application code, engines, and assets.

5. **Local-First Zero-Egress Privacy:**
   - Scanned page text, clipboard contents, uploaded documents (PDF, DOCX, images), OCR text, PHI/PII, and AI conversation contents are processed directly on-device.
   - Zero sensitive content is ever sent to Supabase or the Office Manager.

---

### Detection Engine & Redaction Audit

- **Comprehensive Detection Audit:** Validated across 23 detection categories using synthetic data only:
  - Personal Identifiers (US SSN/ITIN, Canadian SIN, UK NHS, Australian TFN, Brazilian CPF, Indian Aadhaar/PAN, DOB, Names, Addresses, Phones, Emails).
  - Financial Data (Payment cards with Luhn checksum, ABA routing, IBAN with Mod-97 checksum, salary amounts).
  - Healthcare & Clinical PHI (NPI with checksum, DEA numbers, CMS MBI, MRN, clinical signatures, medications, ICD-10, CPT codes).
  - Developer Secrets & Credentials (API keys for OpenAI, Anthropic, Google, Stripe, GitHub, AWS, private RSA/SSH keys, JWT tokens, connection strings).
  - Custom Detection Logic (User-authored regex rules created via the Redaction Wizard).
- **Redaction Pipeline Verification:**
  - Page Visual Masking: Non-destructive isolated Shadow DOM privacy overlays.
  - Clipboard Protection: Sanitize & Paste / Sanitize & Send removes detected sensitive entities prior to submission.
  - Document Redaction Studio: True flattened pixel and vector redaction for PDF, DOCX, and images. Sensitive content is permanently stripped from the underlying text layer and metadata.
- **Transparency Notice:** Preserves the user-facing disclaimer that pattern-based detection is not guaranteed complete and users must verify their work.

---

### Verification & Testing Gates

- **Total Test Suite:** 120 test files, 2,246 unit and integration tests passing (`npm test`).
- **TypeScript:** Clean compilation with zero errors (`tsc --noEmit`).
- **Build Targets:**
  - Google Chrome / Chromium (`npm run build` -> `dist/`)
  - Microsoft Edge (Chromium-based, uses `dist/`)
  - Mozilla Firefox (`npm run build:firefox` -> `dist-firefox/`)
  - Apple Safari (`npm run build:safari` -> `dist-safari/` handoff payload)
- **Security & Integrity Linting:** Zero vulnerabilities reported by `npm audit`, clean ESLint security audit (`npm run lint:security`), zero dead CSS selectors (`prune-dead-css.mts`), and 0% drift in sidepanel code (`sync:sidepanel:check`).
- **Wire-Level Network Inspection:** Automated test asserts zero requests, zero telemetry, and zero canary leakage during scans and logic wizard execution (`npm run test:network-inspection`).

---

### Upgrade & Migration Guide

- **Existing v0.2.0 Users:** Automatically retain all existing settings, custom rules, and audit records in `chrome.storage.local`. The extension defaults to **LOCAL** mode with full standalone functionality.
- **Enrolling in MANAGE Mode:** Navigate to Settings -> Advanced -> Management and enter the organization enrollment credentials provided by your GovernWorld administrator.
