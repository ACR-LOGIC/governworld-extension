// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
/**
 * Centralized, local-first Telemetry Framework (Item 15).
 *
 * Separates observability into four explicit, privacy-preserving domains:
 *   1. SecurityTelemetry    — SSRF/network guard blocks, redirect blocks, signature failures, unsafe regex rejections
 *   2. CoverageTelemetry    — Scan coverage verdicts, partial-scan reasons, chunked custom pattern limits, inventory metrics
 *   3. PerformanceTelemetry — Detector execution times, custom pattern budget usage, DOM inventory pass timings
 *   4. PolicyTelemetry      — Site policy evaluations, compliance score bands, enforcement actions, redirect policies
 *
 * Privacy invariant:
 *   No raw page text, document bytes, unmasked findings, or full URLs with paths/queries
 *   may ever be recorded in telemetry events.
 */

export type TelemetryDomain = "security" | "coverage" | "performance" | "policy";

export interface SecurityTelemetryEvent {
  domain: "security";
  ts: string;
  kind: string;
  classification?: string;
  normalizedHost?: string;
  reason?: string;
  [extra: string]: unknown;
}

export interface CoverageTelemetryEvent {
  domain: "coverage";
  ts: string;
  kind: string;
  coverageStatus?: string;
  chunksProcessed?: number;
  totalChars?: number;
  partiallyScanned?: boolean;
  deferredMediaCount?: number;
  unscannableCount?: number;
  [extra: string]: unknown;
}

export interface PerformanceTelemetryEvent {
  domain: "performance";
  ts: string;
  operation: string;
  durationMs: number;
  inputChars?: number;
  budgetExceeded?: boolean;
  [extra: string]: unknown;
}

export interface PolicyTelemetryEvent {
  domain: "policy";
  ts: string;
  kind: string;
  action?: string;
  riskScore?: number;
  riskBand?: string;
  destinationCategory?: string;
  hops?: number;
  [extra: string]: unknown;
}

export type AnyTelemetryEvent =
  | SecurityTelemetryEvent
  | CoverageTelemetryEvent
  | PerformanceTelemetryEvent
  | PolicyTelemetryEvent;

const MAX_EVENTS_PER_DOMAIN = 200;

function trimRing<T>(ring: T[]): void {
  if (ring.length > MAX_EVENTS_PER_DOMAIN) {
    ring.splice(0, ring.length - MAX_EVENTS_PER_DOMAIN);
  }
}

export class SecurityTelemetryCollector {
  private events: SecurityTelemetryEvent[] = [];

  record(kindOrEvent: string | (Record<string, unknown> & { kind?: string }), extra?: Record<string, unknown>): void {
    const raw = typeof kindOrEvent === "string" ? { kind: kindOrEvent, ...(extra ?? {}) } : { ...kindOrEvent, ...(extra ?? {}) };
    const base = raw as Record<string, unknown>;
    this.events.push({
      domain: "security",
      ts: typeof base.ts === "string" ? base.ts : new Date().toISOString(),
      kind: String(base.kind ?? "security_event"),
      ...(base.classification !== undefined ? { classification: String(base.classification) } : {}),
      ...(base.normalizedHost !== undefined ? { normalizedHost: String(base.normalizedHost) } : {}),
      ...(base.reason !== undefined ? { reason: String(base.reason).slice(0, 200) } : {}),
      ...base,
    });
    trimRing(this.events);
  }

  getEvents(): readonly SecurityTelemetryEvent[] {
    return [...this.events];
  }

  clear(): void {
    this.events = [];
  }
}

export class CoverageTelemetryCollector {
  private events: CoverageTelemetryEvent[] = [];

  record(kindOrEvent: string | (Record<string, unknown> & { kind?: string }), extra?: Record<string, unknown>): void {
    const raw = typeof kindOrEvent === "string" ? { kind: kindOrEvent, ...(extra ?? {}) } : { ...kindOrEvent, ...(extra ?? {}) };
    const base = raw as Record<string, unknown>;
    this.events.push({
      domain: "coverage",
      ts: typeof base.ts === "string" ? base.ts : new Date().toISOString(),
      kind: String(base.kind ?? "coverage_event"),
      ...base,
    });
    trimRing(this.events);
  }

  getEvents(): readonly CoverageTelemetryEvent[] {
    return [...this.events];
  }

  clear(): void {
    this.events = [];
  }
}

export class PerformanceTelemetryCollector {
  private events: PerformanceTelemetryEvent[] = [];

  record(operationOrEvent: string | (Record<string, unknown> & { operation?: string }), extra?: Record<string, unknown>): void {
    const raw = typeof operationOrEvent === "string" ? { operation: operationOrEvent, ...(extra ?? {}) } : { ...operationOrEvent, ...(extra ?? {}) };
    const base = raw as Record<string, unknown>;
    const dur = typeof base.durationMs === "number" ? Math.max(0, Math.round(base.durationMs * 100) / 100) : 0;
    this.events.push({
      domain: "performance",
      ts: typeof base.ts === "string" ? base.ts : new Date().toISOString(),
      operation: String(base.operation ?? "perf_op"),
      durationMs: dur,
      ...base,
    });
    trimRing(this.events);
  }

  getEvents(): readonly PerformanceTelemetryEvent[] {
    return [...this.events];
  }

  clear(): void {
    this.events = [];
  }
}

export class PolicyTelemetryCollector {
  private events: PolicyTelemetryEvent[] = [];

  record(kindOrEvent: string | (Record<string, unknown> & { kind?: string }), extra?: Record<string, unknown>): void {
    const raw = typeof kindOrEvent === "string" ? { kind: kindOrEvent, ...(extra ?? {}) } : { ...kindOrEvent, ...(extra ?? {}) };
    const base = raw as Record<string, unknown>;
    this.events.push({
      domain: "policy",
      ts: typeof base.ts === "string" ? base.ts : new Date().toISOString(),
      kind: String(base.kind ?? "policy_event"),
      ...base,
    });
    trimRing(this.events);
  }

  getEvents(): readonly PolicyTelemetryEvent[] {
    return [...this.events];
  }

  clear(): void {
    this.events = [];
  }
}

export const SecurityTelemetry = new SecurityTelemetryCollector();
export const CoverageTelemetry = new CoverageTelemetryCollector();
export const PerformanceTelemetry = new PerformanceTelemetryCollector();
export const PolicyTelemetry = new PolicyTelemetryCollector();

export interface TelemetrySnapshot {
  security: readonly SecurityTelemetryEvent[];
  coverage: readonly CoverageTelemetryEvent[];
  performance: readonly PerformanceTelemetryEvent[];
  policy: readonly PolicyTelemetryEvent[];
}

export function getTelemetrySnapshot(): TelemetrySnapshot {
  return {
    security: SecurityTelemetry.getEvents(),
    coverage: CoverageTelemetry.getEvents(),
    performance: PerformanceTelemetry.getEvents(),
    policy: PolicyTelemetry.getEvents(),
  };
}

export function clearAllTelemetry(): void {
  SecurityTelemetry.clear();
  CoverageTelemetry.clear();
  PerformanceTelemetry.clear();
  PolicyTelemetry.clear();
}
