// Copyright (c) 2026 Andres Chavez Ramirez / ACR LOGIC. All rights reserved.
/**
 * Interactive Demo Mode Adapter.
 *
 * Implements IBackendAdapters with realistic simulated security operations,
 * synthetic finding streams, mock documents, tamper-evident audit logs,
 * and controllable runtime health states.
 *
 * Clearly flags all operations as simulated with DEMO MODE markers.
 */

import type {
  ActivitySummary,
  AuditRecord,
  CompliancePresetId,
  CustomLogicRule,
  DetectionProfile,
  DocumentItem,
  FeatureHealth,
  Finding,
  FindingCategory,
  SystemDiagnostics,
} from "../types/index.js";
import type {
  IAuditAdapter,
  IBackendAdapters,
  IDocumentAdapter,
  IHealthAdapter,
  ILogicAdapter,
  IScanningAdapter,
  ISettingsAdapter,
} from "./contracts.js";

const DEFAULT_DEMO_PROFILE: DetectionProfile = {
  activePreset: "hipaa",
  enabledCategories: [
    "email",
    "phone",
    "ssn",
    "dob",
    "medical_record_number",
    "member_id",
    "npi",
    "dea",
    "mbi",
    "payment_card",
    "secrets",
  ],
  confidenceThresholds: {
    email: 0.85,
    phone: 0.8,
    ssn: 0.95,
    dob: 0.75,
    medical_record_number: 0.9,
    member_id: 0.85,
    npi: 0.95,
    dea: 0.9,
    mbi: 0.9,
    address: 0.7,
    payment_card: 0.95,
    secrets: 0.9,
    possible_name: 0.6,
    custom: 0.85,
    canadian_sin: 0.9,
    uk_nhs: 0.9,
    aadhaar: 0.9,
    pan_india: 0.9,
    australian_tfn: 0.9,
    cpf: 0.9,
  },
  maskPlaceholders: true,
  maskPadding: 4,
  maskColor: "#0f172a",
  defaultRedactionStyle: "blackout",
  defaultStampText: "[REDACTED]",
};

export class DemoSettingsAdapter implements ISettingsAdapter {
  private profile: DetectionProfile = { ...DEFAULT_DEMO_PROFILE };
  private globals: Record<string, unknown> = {
    protectionMode: "this-tab",
    pasteGuardEnabled: true,
    autoCopySanitized: true,
    notificationsEnabled: true,
    language: "en",
    highContrast: false,
    reducedMotion: false,
    sessionTimeout: "15m",
  };

  async getProfile(): Promise<DetectionProfile> {
    return { ...this.profile };
  }

  async updateProfile(updates: Partial<DetectionProfile>): Promise<DetectionProfile> {
    this.profile = { ...this.profile, ...updates };
    return { ...this.profile };
  }

  async getGlobalSettings(): Promise<Record<string, unknown>> {
    return { ...this.globals };
  }

  async updateGlobalSettings(settings: Record<string, unknown>): Promise<void> {
    this.globals = { ...this.globals, ...settings };
  }

  async resetDefaults(): Promise<DetectionProfile> {
    this.profile = { ...DEFAULT_DEMO_PROFILE };
    return { ...this.profile };
  }
}

export class DemoScanningAdapter implements IScanningAdapter {
  private progressListeners: ((state: { progress: number; stage: string; findingsCount: number }) => void)[] = [];
  private activeTimer: ReturnType<typeof setInterval> | null = null;

  private mockFindings: Finding[] = [
    {
      id: "demo-f1",
      category: "ssn",
      severity: "critical",
      label: "Social Security Number",
      maskedValue: "•••-••-6789",
      contextSnippet: "Patient SSN recorded as [•••-••-6789] on intake form",
      confidence: 0.98,
      selected: true,
      location: { nodePath: "DIV > FORM > INPUT[name='ssn']" },
    },
    {
      id: "demo-f2",
      category: "medical_record_number",
      severity: "high",
      label: "Medical Record Number",
      maskedValue: "MRN-••••••••",
      contextSnippet: "Hospital chart # [MRN-••••••••] under clinical review",
      confidence: 0.94,
      selected: true,
      location: { nodePath: "DIV > TABLE > TR:nth-child(2) > TD" },
    },
    {
      id: "demo-f3",
      category: "payment_card",
      severity: "critical",
      label: "Visa Payment Card",
      maskedValue: "••••-••••-••••-4242",
      contextSnippet: "Billing card ending in [••••-••••-••••-4242] expiration 12/28",
      confidence: 0.99,
      selected: true,
      location: { nodePath: "SECTION > DIV > SPAN.card-num" },
    },
    {
      id: "demo-f4",
      category: "secrets",
      severity: "critical",
      label: "API Bearer Secret",
      maskedValue: "sk_live_••••••••••••••••",
      contextSnippet: "Authorization: Bearer [sk_live_••••••••••••••••]",
      confidence: 0.97,
      selected: true,
      location: { nodePath: "PRE > CODE.bash" },
    },
    {
      id: "demo-f5",
      category: "email",
      severity: "medium",
      label: "Corporate Email Address",
      maskedValue: "c•••••@governworld.local",
      contextSnippet: "Primary contact listed as [c•••••@governworld.local]",
      confidence: 0.89,
      selected: false,
      location: { nodePath: "FOOTER > P > A" },
    },
  ];

  async startScan(): Promise<{ sessionId: string }> {
    const sessionId = `demo-session-${Date.now()}`;
    let step = 0;
    const stages = [
      "Traversing DOM & visible viewport...",
      "Analyzing input fields & form controls...",
      "Evaluating regex & checksum validators...",
      "Pixel bounds mapping & context inspection...",
      "Scan complete. 5 sensitive items identified.",
    ];

    if (this.activeTimer) clearInterval(this.activeTimer);

    this.activeTimer = setInterval(() => {
      step++;
      const progress = Math.min(100, step * 20);
      const stage = stages[Math.min(stages.length - 1, step - 1)];
      const findingsCount = Math.min(5, Math.floor((step / 5) * 5));

      for (const listener of this.progressListeners) {
        listener({ progress, stage, findingsCount });
      }

      if (progress >= 100 && this.activeTimer) {
        clearInterval(this.activeTimer);
        this.activeTimer = null;
      }
    }, 300);

    return { sessionId };
  }

  async cancelScan(): Promise<void> {
    if (this.activeTimer) {
      clearInterval(this.activeTimer);
      this.activeTimer = null;
    }
  }

  async getFindings(): Promise<Finding[]> {
    return [...this.mockFindings];
  }

  async applyMasks(_sessionId: string, findingIds: string[]): Promise<{ appliedCount: number }> {
    const count = findingIds.length;
    this.mockFindings.forEach((f) => {
      f.selected = findingIds.includes(f.id);
    });
    return { appliedCount: count };
  }

  async removeMasks(): Promise<void> {
    this.mockFindings.forEach((f) => {
      f.selected = false;
    });
  }

  onScanProgress(callback: (state: { progress: number; stage: string; findingsCount: number }) => void): () => void {
    this.progressListeners.push(callback);
    return () => {
      this.progressListeners = this.progressListeners.filter((cb) => cb !== callback);
    };
  }
}

export class DemoDocumentAdapter implements IDocumentAdapter {
  async importDocument(file: File): Promise<DocumentItem> {
    return {
      id: "doc-demo-101",
      name: file.name || "Patient_Intake_Audit_2026.pdf",
      sizeBytes: file.size || 2_458_102,
      mimeType: file.type || "application/pdf",
      pageCount: 3,
      pages: [
        {
          pageNumber: 1,
          widthPt: 612,
          heightPt: 792,
          hasTextLayer: true,
          ocrProcessed: true,
          previewUrl: "",
          findings: [
            {
              id: "df-1",
              category: "ssn",
              severity: "critical",
              label: "SSN",
              maskedValue: "•••-••-1234",
              contextSnippet: "Patient Identifier: •••-••-1234",
              confidence: 0.99,
              selected: true,
              location: { pageNumber: 1, rect: { x: 120, y: 180, width: 95, height: 18 } },
            },
            {
              id: "df-2",
              category: "medical_record_number",
              severity: "high",
              label: "MRN",
              maskedValue: "MRN-8472910",
              contextSnippet: "Record ID: MRN-8472910",
              confidence: 0.95,
              selected: true,
              location: { pageNumber: 1, rect: { x: 120, y: 220, width: 85, height: 18 } },
            },
          ],
          redacted: false,
        },
        {
          pageNumber: 2,
          widthPt: 612,
          heightPt: 792,
          hasTextLayer: false,
          ocrProcessed: true,
          previewUrl: "",
          findings: [
            {
              id: "df-3",
              category: "payment_card",
              severity: "critical",
              label: "Credit Card",
              maskedValue: "••••-••••-••••-8812",
              contextSnippet: "Co-pay Card: ••••-••••-••••-8812",
              confidence: 0.98,
              selected: true,
              location: { pageNumber: 2, rect: { x: 140, y: 310, width: 140, height: 20 } },
            },
          ],
          redacted: false,
        },
        {
          pageNumber: 3,
          widthPt: 612,
          heightPt: 792,
          hasTextLayer: true,
          ocrProcessed: false,
          previewUrl: "",
          findings: [],
          redacted: false,
        },
      ],
    };
  }

  async runOcr(_docId: string, pageNumber: number): Promise<{ text: string; findings: Finding[] }> {
    return {
      text: `[DEMO OCR Output Page ${pageNumber}] Patient intake data processed via on-device Tesseract WASM.`,
      findings: [
        {
          id: `ocr-f-${pageNumber}`,
          category: "dob",
          severity: "medium",
          label: "Date of Birth",
          maskedValue: "••/••/1984",
          contextSnippet: "DOB: ••/••/1984 verified",
          confidence: 0.92,
          selected: true,
        },
      ],
    };
  }

  async applyRedaction(
    _docId: string,
    options: { findingIds: string[]; style: "blackout" | "whiteout" | "stamp"; stampText?: string }
  ): Promise<{ outputBytes: Uint8Array; verified: boolean; darkRegions: number; checkedRegions: number }> {
    const total = options.findingIds.length || 3;
    return {
      outputBytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), // %PDF header mock
      verified: true,
      darkRegions: total,
      checkedRegions: total,
    };
  }

  async downloadSanitized(_docId: string, filename: string): Promise<void> {
    console.log(`[DEMO MODE] Download simulated for sanitized file: ${filename}`);
  }
}

export class DemoLogicAdapter implements ILogicAdapter {
  private rules: CustomLogicRule[] = [
    {
      id: "rule-1",
      name: "Internal Staff Employee ID",
      category: "custom",
      pattern: "\\bEMP-[0-9]{5}-[A-Z]{2}\\b",
      flags: "g",
      confidence: 0.95,
      positiveExamples: ["EMP-48201-US", "EMP-91823-CA"],
      negativeExamples: ["EMP-123", "emp-48201", "EMP-ABCDE-US"],
      createdAt: "2026-03-12T14:30:00Z",
      enabled: true,
      source: "local",
      contributionConsent: false,
    },
    {
      id: "rule-2",
      name: "Cloud Project Resource Identifier",
      category: "secrets",
      pattern: "\\bprj-[a-z0-9]{8,16}-[a-z]{2}\\b",
      flags: "gi",
      confidence: 0.9,
      positiveExamples: ["prj-8f92a10c-eu", "prj-11223344-us"],
      negativeExamples: ["project-1", "PRJ-TEST"],
      createdAt: "2026-03-15T09:15:00Z",
      enabled: true,
      source: "local",
      contributionConsent: false,
    },
  ];

  async listRules(): Promise<CustomLogicRule[]> {
    return [...this.rules];
  }

  async createRule(rule: Omit<CustomLogicRule, "id" | "createdAt">): Promise<CustomLogicRule> {
    const newRule: CustomLogicRule = {
      ...rule,
      id: `rule-${Date.now()}`,
      createdAt: new Date().toISOString(),
    };
    this.rules.push(newRule);
    return newRule;
  }

  async updateRule(ruleId: string, updates: Partial<CustomLogicRule>): Promise<CustomLogicRule> {
    const idx = this.rules.findIndex((r) => r.id === ruleId);
    if (idx === -1) throw new Error("Rule not found");
    this.rules[idx] = { ...this.rules[idx], ...updates };
    return this.rules[idx];
  }

  async deleteRule(ruleId: string): Promise<void> {
    this.rules = this.rules.filter((r) => r.id !== ruleId);
  }

  async analyzeExamples(
    positive: string[],
    _negative: string[]
  ): Promise<{ proposals: { pattern: string; flags: string; confidence: number; rationale: string }[] }> {
    return {
      proposals: [
        {
          pattern: `\\b${positive[0]?.slice(0, 3) || "KEY"}-[0-9]{4,6}\\b`,
          flags: "gi",
          confidence: 0.94,
          rationale: "Matches prefix letters followed by strict numeric boundary",
        },
        {
          pattern: `\\b[A-Z]{3,4}-[A-Z0-9]{5,8}\\b`,
          flags: "g",
          confidence: 0.88,
          rationale: "Broad alphanumeric segment match with standardized delimiters",
        },
      ],
    };
  }

  async testPattern(pattern: string, flags: string, sample: string): Promise<{ matches: number; matchedText: string[] }> {
    try {
      const rx = new RegExp(pattern, flags);
      const m = sample.match(rx) || [];
      return { matches: m.length, matchedText: m };
    } catch {
      return { matches: 0, matchedText: [] };
    }
  }
}

export class DemoAuditAdapter implements IAuditAdapter {
  private auditRecords: AuditRecord[] = [
    {
      id: "rec-801",
      timestamp: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
      actor: "Local User (activeTab)",
      action: "page_scan_completed",
      target: "app.healthportal.example/patient/8421",
      outcome: "warning",
      counts: { ssn: 1, medical_record_number: 1, payment_card: 1 },
      signature: "MEYCIQDx982a...[ECDSA-P256-SHA256-VERIFIED]",
      verified: true,
    },
    {
      id: "rec-802",
      timestamp: new Date(Date.now() - 1000 * 60 * 35).toISOString(),
      actor: "Paste Shield Guard",
      action: "paste_intercepted_and_sanitized",
      target: "chat.openai.example",
      outcome: "blocked",
      counts: { secrets: 1, email: 1 },
      signature: "MEUCIQDf8812...[ECDSA-P256-SHA256-VERIFIED]",
      verified: true,
    },
    {
      id: "rec-803",
      timestamp: new Date(Date.now() - 1000 * 60 * 180).toISOString(),
      actor: "Document Studio",
      action: "document_redacted_and_pixel_verified",
      target: "Claims_Summary_Q1.pdf",
      outcome: "ok",
      counts: { verified_boxes: 7, unverified: 0 },
      signature: "MEQCID9a4411...[ECDSA-P256-SHA256-VERIFIED]",
      verified: true,
    },
  ];

  async getActivitySummary(): Promise<ActivitySummary> {
    return {
      pagesScanned: 142,
      threatsIntercepted: 38,
      documentsRedacted: 19,
      totalRegionsSecured: 284,
      lastActive: "Just now",
    };
  }

  async getAuditRecords(limit = 20): Promise<AuditRecord[]> {
    return this.auditRecords.slice(0, limit);
  }

  async verifyTamperEvidence(recordId: string): Promise<{ valid: boolean; signatureAlg: string; keyId: string }> {
    const rec = this.auditRecords.find((r) => r.id === recordId);
    return {
      valid: rec ? rec.verified : true,
      signatureAlg: "ECDSA P-256 / SHA-256",
      keyId: "local-device-keystore-01",
    };
  }

  async exportAuditLog(format: "json" | "csv"): Promise<string> {
    if (format === "json") {
      return JSON.stringify(this.auditRecords, null, 2);
    }
    return "timestamp,actor,action,target,outcome,signature\n" +
      this.auditRecords.map((r) => `${r.timestamp},"${r.actor}","${r.action}","${r.target}",${r.outcome},"${r.signature}"`).join("\n");
  }

  async clearLocalHistory(): Promise<void> {
    this.auditRecords = [];
  }
}

export class DemoHealthAdapter implements IHealthAdapter {
  private features: FeatureHealth[] = [
    {
      featureId: "page-scanning",
      name: "On-Page Detection Engine",
      configuredEnabled: true,
      runtimeState: "operational",
      lastSuccessfulCheck: Date.now() - 12000,
      missingPermissions: [],
      capabilities: ["DOM Extraction", "Context Boundary Verification", "Dynamic Mutation Monitoring"],
    },
    {
      featureId: "paste-shield",
      name: "Paste Shield (Clipboard Guard)",
      configuredEnabled: true,
      runtimeState: "operational",
      lastSuccessfulCheck: Date.now() - 5000,
      missingPermissions: [],
      capabilities: ["Synthetic Prompt Interception", "Sanitize & Paste", "Zero-Egress Dialog"],
    },
    {
      featureId: "doc-studio",
      name: "Document Studio (PDF/OCR)",
      configuredEnabled: true,
      runtimeState: "operational",
      lastSuccessfulCheck: Date.now() - 45000,
      missingPermissions: [],
      capabilities: ["Client-Side PDF Rendering", "Tesseract WASM Offline OCR", "Pixel Verification Gate"],
    },
    {
      featureId: "always-on-protection",
      name: "Always-On Cross-Site Protection",
      configuredEnabled: false,
      runtimeState: "unavailable",
      lastError: "Optional host permissions not granted by user",
      missingPermissions: ["http://*/*", "https://*/*"],
      capabilities: ["Background Script Auto-Injection", "Global Chat Guard"],
    },
    {
      featureId: "audit-keystore",
      name: "ECDSA Local Audit Keystore",
      configuredEnabled: true,
      runtimeState: "operational",
      lastSuccessfulCheck: Date.now() - 1000,
      missingPermissions: [],
      capabilities: ["SubtleCrypto Key Generation", "Tamper-Evident SHA-256 Signatures"],
    },
  ];

  async getAllFeaturesHealth(): Promise<FeatureHealth[]> {
    return [...this.features];
  }

  async getFeatureHealth(featureId: string): Promise<FeatureHealth | null> {
    return this.features.find((f) => f.featureId === featureId) || null;
  }

  async getSystemDiagnostics(): Promise<SystemDiagnostics> {
    return {
      version: "2.0.0-REDESIGN",
      buildNumber: "20261031.1",
      manifestVersion: 3,
      memoryUsageMb: 42.8,
      wasmLoaded: true,
      ocrEngineStatus: "operational",
      storageUsageBytes: 348_192,
      permissionsGranted: ["activeTab", "scripting", "storage", "downloads", "offscreen"],
      permissionsOptionalHeld: ["notifications"],
      enterpriseLocked: false,
    };
  }

  async requestPermission(permission: string): Promise<boolean> {
    console.log(`[DEMO MODE] Permission request simulated: ${permission}`);
    return true;
  }

  async revokePermission(permission: string): Promise<boolean> {
    console.log(`[DEMO MODE] Permission revoke simulated: ${permission}`);
    return true;
  }
}

export class DemoAdapters implements IBackendAdapters {
  public settings = new DemoSettingsAdapter();
  public scanning = new DemoScanningAdapter();
  public documents = new DemoDocumentAdapter();
  public logic = new DemoLogicAdapter();
  public audit = new DemoAuditAdapter();
  public health = new DemoHealthAdapter();

  isDemoMode(): boolean {
    return true;
  }
}

export const demoAdapters = new DemoAdapters();
