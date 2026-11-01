# GovernWorld Browser Extension — Architecture & Redesign Specification
**ACR LOGIC / Product Design & Frontend Architecture**  
*Document Version: 2.0.0-REDESIGN | Release: October 2026*

---

## 1. Executive Summary & Design Vision
GovernWorld is an on-device, local-first browser extension providing cryptographic privacy governance, real-time sensitive data interception, offline document redaction, and tamper-evident audit logging.

The redesign moves away from generic, cluttered security dashboards and establishes an original visual identity termed **"Cognitive Fortification & Cryptographic Clarity"**:
- **Palette**: Deep Obsidian Slate (`#090D16`), Atmospheric Navy (`#0E1524`), Cybernetic Cobalt (`#2563EB` / `#3B82F6`), Radiant Detection Amber (`#F59E0B`), Verified Emerald (`#10B981`), Laser Threat Crimson (`#EF4444`), and Neon Inspection Cyan (`#06B6D4`).
- **Surface Elevation**: Luminous 1px edge dividers, subtle ambient backdrop blurs (12px glassmorphism), zero CSS bleeding into host pages.
- **Precision Typography**: Modern high-legibility sans-serif (`Inter`) paired with geometric monospace (`JetBrains Mono` / `SF Mono`) for hashes, regex, tokens, and coordinates.
- **Honest Runtime Semantics**: Visual states strictly map to real application conditions. No simulated green badges for inactive features.

---

## 2. Non-Negotiable Architectural Decisions

### A. Shared Detection Profiles
Page Scanning, Paste Shield, and Document Studio consume a single, unified detection configuration (`DetectionProfile`). Compliance presets (HIPAA, PCI DSS, GDPR, PIPEDA, UK GDPR, DPDP India, Australia Privacy, Brazil LGPD, Developer) and custom regex rules operate from this single source of truth.

### B. Combined Review & Audit
Activity metrics and tamper-evident audit logs live in one unified destination (`ScreenF_ReviewAudit`), keeping aggregate performance metrics and cryptographic ECDSA P-256 signatures clearly demarcated.

### C. Central Settings
Persistent user preferences across protection modes, paste interception, appearance, accessibility, notifications, and enterprise policies are centralized under `ScreenG_CentralSettings`. Competing settings menus are eliminated.

---

## 3. Screen Inventory & UX Architecture

| Screen ID | Surface Role | Key Capabilities & Features |
| :--- | :--- | :--- |
| **Screen A: Browser Popup** | Compact Toolbar (380x600) | Immediate protection toggles (Page Protection, Paste Shield), primary "Scan This Page" trigger, real-time finding counters, quick workspace jump links. |
| **Screen B: Protection Workspace** | Side Panel (420x820) | In-depth live viewport analysis, host URL metadata, interactive findings list with masked preview inspector, coverage limitation disclosures, action bar. |
| **Screen C: Shared Detection Profiles** | Central Settings Engine | 9 compliance presets, 20 granular category toggles, per-category confidence sliders (0..1), visual masking padding defaults, legal non-certification notice. |
| **Screen D: Document Studio** | Specialized Workspace (1280x850) | Multi-page PDF/image dropzone, page rail, interactive canvas redaction boxes, Blackout/Whiteout/Stamp style switchers, Cryptographic Pixel Verification Shader, sanitized PDF export. |
| **Screen E: My Logic** | Specialized Workspace (1280x850) | 4-stage rule builder (Examples → Proposals → Refine → Save), live regex testing sandbox against positive/negative strings, match counter, contribution consent toggle. |
| **Screen F: Review & Audit** | Review Destination (1280x850) | Telemetry metrics (Pages Scanned, Threat Blocks, Regions Secured), chronological audit trail, on-device ECDSA signature verification, CSV/JSON export, destructive delete modal. |
| **Screen G: Central Settings** | Configuration Hub (1280x850) | Unified 6-section configuration: Protection & Site Access, Paste Shield, Appearance & A11y, Notifications Channels & Privacy Modes, Session Timeouts, Enterprise Policies. |
| **Screen H: Privacy & Governance** | Information Architecture | Full disclosure of on-device CPU/WASM processing, zero network egress proof, detailed manifest permission justification (`activeTab`, `scripting`, `storage`, `offscreen`). |
| **Screen I: Account & Enterprise** | Enterprise & Multi-Tenant | Organization identity, role badges (Compliance Officer, Workspace Admin), GPO/InTune policy enforcement cards with visual `🔒 LOCKED` indicators. |
| **Screen J: Diagnostics & Maintenance** | Engineering Telemetry | 9-state Feature Health Matrix (`FeatureHealth`), WASM OCR engine status, memory usage telemetry, permission grid, self-test suite, cache reset. |

---

## 4. Advanced Visualization & Motion Design

1. **Canvas Scanning Visualizer (`ScanVisualizer.ts`)**:
   - Oscillating dual-glow laser beam (`#06B6D4`) running across grid coordinates at 60 FPS.
   - Particle collision markers on detected sensitive coordinates (critical: red, high: amber, medium: blue) with radius expansion and alpha decay.
   - Telemetry HUD displaying active node count, visible characters, and coverage percentage. Zero CPU consumption when stopped.

2. **Document & Pixel Verification Shader (`DocumentVisualizer.ts`)**:
   - High-DPI canvas rendering realistic document pages.
   - Interactive bounding boxes with instant style switching:
     - **Blackout**: `#090D16` solid fill.
     - **Whiteout**: `#FFFFFF` solid fill with `#CBD5E1` boundary.
     - **Stamp**: Outlined stamp with centered custom label (e.g. `[REDACTED]`).
   - Animated pixel verification scanline: sweeping green laser that tests page raster pixels and outputs cryptographic proof of dark coverage.

---

## 5. Runtime Health Architecture (Section 11)

The conceptual runtime health model enforces transparency:
```ts
export type RuntimeState =
  | "initializing"
  | "operational"
  | "processing"
  | "degraded"
  | "failed"
  | "completed"
  | "cancelled"
  | "unknown"
  | "unavailable";

export interface FeatureHealth {
  featureId: string;
  name: string;
  configuredEnabled: boolean;
  runtimeState: RuntimeState;
  lastSuccessfulCheck?: number;
  lastError?: string;
  missingPermissions: string[];
  capabilities: string[];
}
```
A feature enabled in settings never displays an operational status unless its content script is verified and permissions are held.

---

## 6. Typed Integration Adapters

The UI is decoupled from the browser execution layer via typed contracts in `redesign/adapters/contracts.ts`:
- `ISettingsAdapter`: Manages `DetectionProfile` and global settings.
- `IScanningAdapter`: Coordinates viewport scans, progress subscriptions, and mask applications.
- `IDocumentAdapter`: Handles file ingestion, Tesseract WASM OCR, pixel verification, and sanitized PDF downloads.
- `ILogicAdapter`: Rule proposals, regex testing, and rule storage.
- `IAuditAdapter`: Activity summaries, ECDSA signature verification, and export.
- `IHealthAdapter`: Feature health polling, diagnostics, and permission requests.

### Demo Mode vs. Live Extension
`DemoAdapters` (`redesign/adapters/demoAdapter.ts`) provides high-fidelity synthetic data, live simulated scanning progress, and controllable degradation states, with an unmistakable `DEMO MODE` badge on every screen.

---

## 7. Responsive Viewport Adaptability

The redesigned shell provides an interactive viewport switcher:
- **📱 Popup (380px × 600px)**: Compact, thumb-friendly toolbar UI.
- **📑 Side Panel (440px × 800px)**: High-density vertical workspace for continuous page auditing.
- **🖥️ Full Workspace (1180px × 850px)**: Multi-column desktop command center for Document Studio and My Logic.

---

## 8. Verification & Test Checklist

- [x] All 10 screens implemented and rendered.
- [x] Real-time Canvas scanning beam and particle animation verified.
- [x] Document redaction canvas with blackout, whiteout, and stamp modes verified.
- [x] Pixel verification shader tested with dark region statistics.
- [x] 4-stage My Logic rule builder verified with live regex testing.
- [x] Audit log signature verification and JSON/CSV export verified.
- [x] Central Settings 6-tab panel verified.
- [x] High contrast toggle verified (`data-high-contrast="true"`).
- [x] Reduced motion media query compliance verified.
- [x] Headless Chromium Playwright test passed with **0 console errors**.
