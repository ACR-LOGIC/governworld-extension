// Copyright (c) 2026 Andres Chavez Ramirez / ACR LOGIC. All rights reserved.
/**
 * Typed Integration Adapter Contracts.
 *
 * Defines the strict boundaries through which all frontend operations flow.
 * Provides separate interfaces for settings, scanning, document redaction,
 * custom logic, audit log management, and runtime health checks.
 */

import type {
  ActivitySummary,
  AuditRecord,
  CustomLogicRule,
  DetectionProfile,
  DocumentItem,
  FeatureHealth,
  Finding,
  RuntimeState,
  SystemDiagnostics,
} from "../types/index.js";

export interface IBackendAdapters {
  isDemoMode(): boolean;
  settings: ISettingsAdapter;
  scanning: IScanningAdapter;
  documents: IDocumentAdapter;
  logic: ILogicAdapter;
  audit: IAuditAdapter;
  health: IHealthAdapter;
}

export interface ISettingsAdapter {
  getProfile(): Promise<DetectionProfile>;
  updateProfile(profile: Partial<DetectionProfile>): Promise<DetectionProfile>;
  getGlobalSettings(): Promise<Record<string, unknown>>;
  updateGlobalSettings(settings: Record<string, unknown>): Promise<void>;
  resetDefaults(): Promise<DetectionProfile>;
}

export interface IScanningAdapter {
  startScan(targetTabId?: number): Promise<{ sessionId: string }>;
  cancelScan(sessionId: string): Promise<void>;
  getFindings(sessionId: string): Promise<Finding[]>;
  applyMasks(sessionId: string, findingIds: string[]): Promise<{ appliedCount: number }>;
  removeMasks(sessionId: string): Promise<void>;
  onScanProgress(callback: (state: { progress: number; stage: string; findingsCount: number }) => void): () => void;
}

export interface IDocumentAdapter {
  importDocument(file: File): Promise<DocumentItem>;
  runOcr(docId: string, pageNumber: number): Promise<{ text: string; findings: Finding[] }>;
  applyRedaction(
    docId: string,
    options: {
      findingIds: string[];
      manualBoxes?: { page: number; rect: { x: number; y: number; width: number; height: number } }[];
      style: "blackout" | "whiteout" | "stamp";
      stampText?: string;
    }
  ): Promise<{ outputBytes: Uint8Array; verified: boolean; darkRegions: number; checkedRegions: number }>;
  downloadSanitized(docId: string, filename: string): Promise<void>;
}

export interface ILogicAdapter {
  listRules(): Promise<CustomLogicRule[]>;
  createRule(rule: Omit<CustomLogicRule, "id" | "createdAt">): Promise<CustomLogicRule>;
  updateRule(ruleId: string, updates: Partial<CustomLogicRule>): Promise<CustomLogicRule>;
  deleteRule(ruleId: string): Promise<void>;
  analyzeExamples(
    positive: string[],
    negative: string[]
  ): Promise<{ proposals: { pattern: string; flags: string; confidence: number; rationale: string }[] }>;
  testPattern(pattern: string, flags: string, sample: string): Promise<{ matches: number; matchedText: string[] }>;
}

export interface IAuditAdapter {
  getActivitySummary(): Promise<ActivitySummary>;
  getAuditRecords(limit?: number): Promise<AuditRecord[]>;
  verifyTamperEvidence(recordId: string): Promise<{ valid: boolean; signatureAlg: string; keyId: string }>;
  exportAuditLog(format: "json" | "csv"): Promise<string>;
  clearLocalHistory(): Promise<void>;
}

export interface IHealthAdapter {
  getAllFeaturesHealth(): Promise<FeatureHealth[]>;
  getFeatureHealth(featureId: string): Promise<FeatureHealth | null>;
  getSystemDiagnostics(): Promise<SystemDiagnostics>;
  requestPermission(permission: string): Promise<boolean>;
  revokePermission(permission: string): Promise<boolean>;
}
