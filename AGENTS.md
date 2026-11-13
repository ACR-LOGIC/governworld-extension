# AGENTS.md - Engineer Configuration

This document outlines the engineering setup for the GovernWorld Chrome Extension repository, including directory structure, CI/CD configuration, license implementation, and core protection system details.

## Repository Structure & Layout

### Primary Directories

#### src/
- `src/service-worker/`: Core service worker orchestration and message handling
- `src/content/`: Content script for live DOM scanning and masking
- `src/offscreen/`: Offscreen document for OCR processing and heavy computations
- `src/shared/`: Common utilities, types, and helper functions shared across contexts

#### scripts/
- `scripts/build-firefox.mjs`: Firefox-specific build configuration
- `scripts/build.mjs`: Main Chromium build configuration
- `scripts/verify-release-zip.mjs`: Release verification and validation script
- Additional automation and build scripts

#### tests/
- `tests/`: Comprehensive test suite covering unit, integration, and E2E testing

#### scripts/lib/
- `scripts/lib/png.mjs`: PNG manipulation utilities

#### docs/
- `docs/community-trust-model.md`: Community trust model documentation
- `docs/DEV-MODE-INSTALL.md`: Developer mode installation guide
- `docs/ENTERPRISE_DEPLOYMENT.md`: Enterprise deployment configuration
- `docs/git-history-tarballs.md`: Git history management documentation
- `docs/ocr-languages.md`: OCR language configuration
- `docs/STORE-PUBLISHING.md`: Store publishing guidelines
- `docs/submission-package.md`: Submission package documentation

### Security Documentation

#### docs/security/
- `PERMISSIONS.md`: Detailed permission justification and requirements
- `PRIVACY.md`: Privacy policy and data handling documentation
- `SECURITY_ENFORCEMENT.md`: Enterprise security enforcement guidelines

### Release Documentation

#### docs/releases/
- `RELEASE_EVIDENCE.md`: Release verification evidence and checksums
- `RELEASE_NOTES.md`: Release notes and version information
- `TEST_READY.md`: Test readiness and validation checklist

### Publishing Documentation

#### docs/publishing/
- `BROWSER_SUPPORT.md`: Browser support matrix and compatibility
- `CHROMEWEBSTORE.md`: Chrome Web Store submission guidelines
- `STORE_DESCRIPTION.md`: Store description and presentation
- `STORE_READINESS.md`: Store readiness assessment

## CI/CD Configuration

### GitHub Actions Workflow

File: `.github/workflows/release.yml`

This workflow automates:
- Multi-browser extension builds (Chrome, Firefox, Safari)
- Checksum generation and verification
- GitHub Release creation with artifacts
- Store submission (Chrome Web Store, Firefox AMO)
- Cross-platform compliance validation

### Key Workflow Steps

1. **Dependency Management**: Node.js 20 LTS with npm caching
2. **Verification Gates**: TypeScript typechecking, security linting, sidepanel sync
3. **Multi-Target Builds**: Chrome, Firefox, and Safari variants
4. **Package Validation**: Manifest and offline asset verification
5. **Artifact Generation**: ZIP packaging with checksum generation
6. **Store Submission**: Automated publishing to supported app stores
7. **Release Creation**: GitHub Release with downloadable artifacts

## License Implementation

### Business Source License 1.1 (BSL 1.1)

File: `LICENSE`

**Key Provisions:**
- **Grant**: Personal, educational, academic, and internal non-commercial use
- **Restrictions**: Prohibits commercial hosting, monetization, or selling
- **Transition**: Changes to Apache License 2.0 after November 13, 2030
- **Contact**: Commercial licensing inquiries to andres@acr-logic.com

**Licensor**: Andres Chavez Ramirez (ACR-LOGIC)

## Core Protection System

### Detection Capabilities

The extension includes 24 detection categories:

#### PII / Contact
- Email addresses
- Phone numbers
- Physical addresses
- Dates of birth
- Parsed names (structured with prefix, first, middle, last, suffix, credentials, gender, age, DOB)
- IP addresses
- Usernames

#### Government / Health IDs
- Social Security Numbers
- Medical Record Numbers
- Member IDs
- National Provider Identifier (NPI)
- Drug Enforcement Administration (DEA) numbers
- Medicare Beneficiary Identifier (MBI)
- Canadian SIN
- UK NHS numbers
- Aadhaar (India)
- PAN (India)
- Australian TFN
- Brazilian CPF

#### Financial
- Credit card numbers
- Bank account numbers
- Financial institution identifiers

#### Secrets / Custom
- Custom pattern matching
- User-defined detection rules

### Processing Pipeline

#### 1. Content Extraction
- DOM parsing for visible webpage text
- Accessibility attribute reading (aria-label, alt, placeholder, title)
- OCR processing for image-based documents (PDFs, screenshots)

#### 2. Pattern Detection
- Deterministic regex matching
- Checksum validation (Luhn for credit cards, SSN/MRN formatting)
- Structured name parsing and enrichment

#### 3. Masking & Redaction
- Shadow DOM overlay for live webpage masking
- Visual redaction in Document Studio (blackout/whiteout/text stamp)
- Verified pixel-level masking

#### 4. Export & Audit
- Signed audit trails (ECDSA P-256)
- Printable compliance certificates
- CSV and JSON export formats

### Operating Modes

#### LOCAL Mode (Standalone)
- On-device processing
- No mandatory account or subscription
- Zero remote coordination
- User-configured detection rules

#### MANAGE Mode (Enterprise)
- Administrator-mandated policies
- Cryptographic Ed25519 verification
- Anti-rollback and anti-replay protection
- Offline continuity enforcement

### Architecture Invariants

- **Zero Network Egress**: All sensitive data remains on-device
- **Fail-Closed**: Enterprise policies default to deny
- **Deterministic Processing**: Reproducible results
- **Local-First**: No external dependencies for core functionality

## Development Environment

### Prerequisites
- Node.js 20+ LTS
- Chrome 116+ or Firefox 109+
- npm or pnpm

### Build Commands
```bash
# Install dependencies
npm install

# TypeScript validation
npm run typecheck

# Full test suite
npm test

# Build for Chrome
npm run build

# Build for Firefox
npm run build:firefox

# Build for Safari (handoff)
npm run build:safari
```

### Testing Strategy
- **Unit Tests**: Vitest (Node.js environment)
- **Integration Tests**: Component interaction
- **E2E Tests**: Playwright (browser environment)
- **Offline OCR**: Synthetic test data
- **Network Inspection**: Zero egress verification

## Quality Gates

### Automated Verification
1. **TypeScript Typechecking**: `npm run typecheck`
2. **Security Linting**: `npm run lint:security`
3. **Sidepanel Sync Check**: `npm run sync:sidepanel:check`
4. **Test Suite Execution**: `npm test`
5. **Manifest Validation**: Offline asset verification

### Store Compliance
- **Chrome Web Store**: Manifest V3 compliance, permissions justification
- **Firefox AMO**: Geckoid validation, event-page background
- **Cross-Browser**: Compatibility testing across supported browsers

## Build Artifacts

### Production Outputs
- `dist/`: Chrome extension build
- `dist-firefox/`: Firefox extension build
- `dist-safari/`: Safari handoff payload

### Distribution Files
- `artifacts/*.zip`: Browser-specific extension packages
- `artifacts/SHA256SUMS.txt`: Checksums for artifact verification
- `release/*.zip`: Alternative build outputs

## Technical Specifications

### Manifest Requirements
- **Manifest Version**: V3 (Chrome, Firefox)
- **Background Service Worker**: ES-module orchestrator
- **Permissions**: Minimal, context-gesture-based access
- **Host Access**: Optional runtime-granted (never `<all_urls>`)

### Security Controls
- **Content Security Policy**: `script-src 'self' 'wasm-unsafe-eval'`
- **Audit Logging**: ECDSA-signed operation records
- **Zero Inline Scripts**: No eval() in production bundles
- **Deterministic Processing**: Reproducible detection algorithms

## Project Status

The repository is actively maintained with continuous improvements in:
- Detection algorithm accuracy
- Security hardening
- Accessibility compliance
- Cross-browser compatibility

## Contributing

For development guidelines and contribution process, see `CONTRIBUTING.md`.

## Support

For issues and support, refer to `SECURITY.md` for reporting guidelines.
