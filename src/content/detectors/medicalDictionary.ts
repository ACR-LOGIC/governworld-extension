// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Lazy-loaded medical dictionary detector (A3 / D3).
// Never loaded or bundled into content.js unless medicalDictionaryEnabled is ON.

import type { RawMatch } from "../detect.js";

let medicalTerms: string[] | null = null;
let medicalRegex: RegExp | null = null;
let loadPromise: Promise<boolean> | null = null;
let skipNodeAutoLoad = false;

interface BuiltinProcess {
  versions?: { node?: string };
  cwd?: () => string;
  getBuiltinModule?: (id: string) => unknown;
}

function compileTerms(terms: string[]): void {
  const cleaned = terms
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= 3)
    .sort((a, b) => b.length - a.length);
  medicalTerms = cleaned;
  if (cleaned.length === 0) {
    medicalRegex = null;
    return;
  }
  const escaped = cleaned.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"));
  medicalRegex = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${escaped.join("|")})(?![\\p{L}\\p{N}_])`, "giu");
}

function tryLoadSyncInNode(): boolean {
  if (skipNodeAutoLoad) return false;
  if (medicalTerms !== null) return true;
  const proc = (globalThis as { process?: BuiltinProcess }).process;
  if (!proc?.versions?.node || typeof proc.getBuiltinModule !== "function") {
    return false;
  }
  try {
    const fs = proc.getBuiltinModule("node:fs") as {
      existsSync: (p: string) => boolean;
      readFileSync: (p: string, enc: string) => string;
    };
    const path = proc.getBuiltinModule("node:path") as {
      resolve: (...parts: string[]) => string;
    };
    const cwd = typeof proc.cwd === "function" ? proc.cwd() : ".";
    const candidates = [
      path.resolve(cwd, "vendor", "medical-dictionary.json"),
      path.resolve(cwd, "dist", "assets", "medical-dictionary.json"),
    ];
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue;
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as { terms?: string[] };
      if (Array.isArray(parsed.terms)) {
        compileTerms(parsed.terms);
        return true;
      }
    }
  } catch {
    // Fail open cleanly.
  }
  return false;
}

export function isMedicalDictionaryLoaded(): boolean {
  return medicalTerms !== null;
}

export function setMedicalDictionaryFromTerms(terms: string[]): void {
  compileTerms(terms);
}

export function resetMedicalDictionaryForTests(disableAutoLoad = false): void {
  medicalTerms = null;
  medicalRegex = null;
  loadPromise = null;
  skipNodeAutoLoad = disableAutoLoad;
}

export async function ensureMedicalDictionaryLoaded(): Promise<boolean> {
  if (medicalTerms !== null) return true;
  if (tryLoadSyncInNode()) return true;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      const cr = (globalThis as { chrome?: typeof chrome }).chrome;
      if (!cr?.runtime?.sendMessage) return false;
      const resp = (await cr.runtime.sendMessage({
        type: "CONTENT_GET_MEDICAL_DICTIONARY",
        requestId: `md_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      })) as { ok?: boolean; terms?: string[] } | undefined;
      if (resp?.ok && Array.isArray(resp.terms)) {
        compileTerms(resp.terms);
        return true;
      }
    } catch {
      // Fail open cleanly.
    }
    return false;
  })();

  const ok = await loadPromise;
  if (!ok) loadPromise = null;
  return ok;
}

export function detectMedicalDictionaryTerms(text: string): RawMatch[] {
  if (!text) return [];
  if (medicalTerms === null) tryLoadSyncInNode();
  if (!medicalRegex) return [];
  medicalRegex.lastIndex = 0;
  const out: RawMatch[] = [];
  for (const m of text.matchAll(medicalRegex)) {
    if (m.index === undefined) continue;
    const value = m[0];
    out.push({
      category: "medical_record_number",
      confidence: 0.78,
      value,
      start: m.index,
      end: m.index + value.length,
      entityType: "medical_term",
    });
  }
  return out;
}
