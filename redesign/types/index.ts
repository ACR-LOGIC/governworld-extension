// Copyright (c) 2026 Andres Chavez Ramirez / ACR LOGIC. All rights reserved.
/**
 * Master Type System for the GovernWorld Redesigned Frontend Architecture.
 *
 * Defines the core models, runtime-health states, detection categories,
 * document pipeline stages, and UI viewports.
 */

export type ScreenId =
  | "popup"
  | "protection-workspace"
  | "detection-profiles"
  | "document-studio"
  | "my-logic"
  | "review-audit"
  | "central-settings"
  | "privacy-governance"
  | "account-enterprise"
  | "diagnostics-maintenance";

export type ViewportMode = "popup" | "sidepanel" | "workspace";

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

export type CompliancePresetId =
  | "custom"
  | "hipaa"
  | "pci"
  | "gdpr"
  | "developer"
  | "pipeda"
  | "uk_gdpr"
  | "india_dpdp"
  | "australia_privacy"
  | "brazil_lgpd";

export type FindingCategory =
  | "email"
  | "phone"
  | "ssn"
  | "dob"
  | "medical_record_number"
  | "member_id"
  | "npi"
  | "dea"
  | "mbi"
  | "address"
  | "payment_card"
  | "secrets"
  | "possible_name"
  | "custom"
  | "canadian_sin"
  | "uk_nhs"
  | "aadhaar"
  | "pan_india"
  | "australian_tfn"
  | "cpf";

export type FindingSeverity = "critical" | "high" | "medium" | "low" | "informational";

export interface Finding {
  id: string;
  category: FindingCategory;
  severity: FindingSeverity;
  label: string;
  maskedValue: string;
  contextSnippet: string;
  confidence: number;
  selected: boolean;
  location?: {
    pageNumber?: number;
    rect?: { x: number; y: number; width: number; height: number };
    nodePath?: string;
  };
}

export interface DetectionProfile {
  activePreset: CompliancePresetId;
  enabledCategories: FindingCategory[];
  confidenceThresholds: Record<FindingCategory, number>;
  maskPlaceholders: boolean;
  maskPadding: number;
  maskColor: string;
  defaultRedactionStyle: "blackout" | "whiteout" | "stamp";
  defaultStampText: string;
}

export interface CustomLogicRule {
  id: string;
  name: string;
  category: string;
  pattern: string;
  flags: string;
  confidence: number;
  positiveExamples: string[];
  negativeExamples: string[];
  createdAt: string;
  enabled: boolean;
  source: "local" | "community" | "enterprise";
  contributionConsent: boolean;
}

export interface DocumentItem {
  id: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
  pageCount: number;
  thumbnailUrl?: string;
  pages: DocumentPage[];
}

export interface DocumentPage {
  pageNumber: number;
  widthPt: number;
  heightPt: number;
  hasTextLayer: boolean;
  ocrProcessed: boolean;
  previewUrl: string;
  findings: Finding[];
  redacted: boolean;
}

export interface AuditRecord {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  target: string;
  outcome: "ok" | "blocked" | "warning" | "error";
  counts?: Record<string, number>;
  signature: string;
  verified: boolean;
}

export interface ActivitySummary {
  pagesScanned: number;
  threatsIntercepted: number;
  documentsRedacted: number;
  totalRegionsSecured: number;
  lastActive: string;
}

export interface SystemDiagnostics {
  version: string;
  buildNumber: string;
  manifestVersion: number;
  memoryUsageMb: number;
  wasmLoaded: boolean;
  ocrEngineStatus: RuntimeState;
  storageUsageBytes: number;
  permissionsGranted: string[];
  permissionsOptionalHeld: string[];
  enterpriseLocked: boolean;
}
