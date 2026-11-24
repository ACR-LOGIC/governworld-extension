// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Unified medical engine: Bloom phrase packs (drugs, conditions, terms),
// dosage/frequency boost, medical abbreviations & context scoring,
// gated SymSpell/Damerau fuzzy drug matching, and clinic-mode demographic boosts.

import type { RawMatch } from "../detect.js";
import type { ClinicMode } from "../../shared/types.js";
import { BloomFilter } from "./bloom.js";
import { detectPhrases, tokenizeMedicalText } from "./phrases.js";
import { applyMedicalContextScore, boostForDrug } from "./meds.js";
import { detectAbbrev } from "./abbrev.js";
import { fuzzyFindDrugSymSpell, isDrugLike } from "./fuzzy.js";

export interface MedicalPackMeta {
  drugs: { count: number; sizeBits: number; hashCount: number };
  conditions: { count: number; sizeBits: number; hashCount: number };
  terms: { count: number; sizeBits: number; hashCount: number };
}

export interface ConditionCatalogEntry {
  age: string[];
  sex: "all" | "female" | "male";
  pregnancy: boolean;
  exclusive: boolean;
  specialty: string;
}

export interface MedicalPacks {
  drugs: BloomFilter;
  conditions: BloomFilter;
  terms: BloomFilter;
  catalog: Record<string, ConditionCatalogEntry>;
  fuzzyIndex: Record<string, string | string[]> | null;
  specialtyMode: ClinicMode;
  specialty: {
    drugs: BloomFilter;
    conditions: BloomFilter;
    terms: BloomFilter;
    fuzzyIndex: Record<string, string | string[]> | null;
  } | null;
}

let activePacks: MedicalPacks | null = null;
let loadedForMode: ClinicMode | null = null;
let loadPromise: Promise<boolean> | null = null;
let skipNodeAutoLoad = false;

// Legacy simple-term fallback if packs aren't loaded via SW
let legacyTerms: string[] | null = null;
let legacyRegex: RegExp | null = null;

interface BuiltinProcess {
  versions?: { node?: string };
  cwd?: () => string;
  getBuiltinModule?: (id: string) => unknown;
}

function tryLoadPacksSyncInNode(clinicMode: ClinicMode = "general"): boolean {
  if (skipNodeAutoLoad) return false;
  if (activePacks && loadedForMode === clinicMode) return true;
  const proc = (globalThis as { process?: BuiltinProcess }).process;
  if (!proc?.versions?.node || typeof proc.getBuiltinModule !== "function") return false;
  try {
    const fs = proc.getBuiltinModule("node:fs") as {
      existsSync: (p: string) => boolean;
      readFileSync: (p: string, enc?: string) => string | Uint8Array;
    };
    const path = proc.getBuiltinModule("node:path") as {
      resolve: (...parts: string[]) => string;
    };
    const zlib = proc.getBuiltinModule("node:zlib") as {
      gunzipSync: (buf: Uint8Array) => Uint8Array;
    };
    const cwd = typeof proc.cwd === "function" ? proc.cwd() : ".";
    const dir = fs.existsSync(path.resolve(cwd, "vendor", "medical", "bloom-meta.json"))
      ? path.resolve(cwd, "vendor", "medical")
      : path.resolve(cwd, "dist", "assets", "medical");
    if (!fs.existsSync(path.resolve(dir, "bloom-meta.json"))) return false;

    const meta = JSON.parse(fs.readFileSync(path.resolve(dir, "bloom-meta.json"), "utf8") as string) as MedicalPackMeta;
    const catalog = JSON.parse(fs.readFileSync(path.resolve(dir, "conditions-catalog.json"), "utf8") as string) as Record<
      string,
      ConditionCatalogEntry
    >;
    const drugs = new BloomFilter(meta.drugs.sizeBits, meta.drugs.hashCount, fs.readFileSync(path.resolve(dir, "bloom-drugs.bin")) as Uint8Array);
    const conditions = new BloomFilter(meta.conditions.sizeBits, meta.conditions.hashCount, fs.readFileSync(path.resolve(dir, "bloom-conditions.bin")) as Uint8Array);
    const terms = new BloomFilter(meta.terms.sizeBits, meta.terms.hashCount, fs.readFileSync(path.resolve(dir, "bloom-terms.bin")) as Uint8Array);
    const fuzzyRaw = zlib.gunzipSync(fs.readFileSync(path.resolve(dir, "fuzzy-index.json.gz")) as Uint8Array);
    const fuzzyIndex = JSON.parse(new TextDecoder().decode(fuzzyRaw)) as Record<string, string | string[]>;

    let specialty: MedicalPacks["specialty"] = null;
    if (clinicMode === "pediatrics" || clinicMode === "obgyn") {
      const prefix = clinicMode === "pediatrics" ? "pediatric" : "obgyn";
      const sMetaPath = path.resolve(dir, `bloom-${prefix}-meta.json`);
      if (fs.existsSync(sMetaPath)) {
        const sMeta = JSON.parse(fs.readFileSync(sMetaPath, "utf8") as string) as MedicalPackMeta;
        const sDrugs = new BloomFilter(sMeta.drugs.sizeBits, sMeta.drugs.hashCount, fs.readFileSync(path.resolve(dir, `bloom-drugs-${prefix}.bin`)) as Uint8Array);
        const sConds = new BloomFilter(sMeta.conditions.sizeBits, sMeta.conditions.hashCount, fs.readFileSync(path.resolve(dir, `bloom-conditions-${prefix}.bin`)) as Uint8Array);
        const sTerms = new BloomFilter(sMeta.terms.sizeBits, sMeta.terms.hashCount, fs.readFileSync(path.resolve(dir, `bloom-terms-${prefix}.bin`)) as Uint8Array);
        const sFuzzyRaw = zlib.gunzipSync(fs.readFileSync(path.resolve(dir, `fuzzy-index-${prefix}.json.gz`)) as Uint8Array);
        const sFuzzy = JSON.parse(new TextDecoder().decode(sFuzzyRaw)) as Record<string, string | string[]>;
        specialty = { drugs: sDrugs, conditions: sConds, terms: sTerms, fuzzyIndex: sFuzzy };
      }
    }

    activePacks = { drugs, conditions, terms, catalog, fuzzyIndex, specialtyMode: clinicMode, specialty };
    loadedForMode = clinicMode;
    return true;
  } catch {
    return false;
  }
}

export function isMedicalDictionaryLoaded(clinicMode?: ClinicMode): boolean {
  if (activePacks !== null) {
    return !clinicMode || loadedForMode === clinicMode;
  }
  return false;
}

export function resetMedicalDictionaryForTests(disableAutoLoad = false): void {
  activePacks = null;
  loadedForMode = null;
  legacyTerms = null;
  legacyRegex = null;
  loadPromise = null;
  skipNodeAutoLoad = disableAutoLoad;
}

export async function ensureMedicalDictionaryLoaded(clinicMode: ClinicMode = "general"): Promise<boolean> {
  if (activePacks && loadedForMode === clinicMode) return true;
  if (tryLoadPacksSyncInNode(clinicMode)) return true;
  if (loadPromise && loadedForMode === clinicMode) return loadPromise;

  loadedForMode = clinicMode;
  loadPromise = (async () => {
    try {
      const cr = (globalThis as { chrome?: typeof chrome }).chrome;
      if (!cr?.runtime?.sendMessage) return false;
      const resp = (await cr.runtime.sendMessage({
        type: "CONTENT_GET_MEDICAL_PACKS",
        requestId: `mp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        clinicMode,
      })) as {
        ok?: boolean;
        payload?: {
          meta: MedicalPackMeta;
          catalog: Record<string, ConditionCatalogEntry>;
          drugsB64: string;
          conditionsB64: string;
          termsB64: string;
          fuzzyIndex: Record<string, string | string[]>;
          specialty?: {
            meta: MedicalPackMeta;
            drugsB64: string;
            conditionsB64: string;
            termsB64: string;
            fuzzyIndex: Record<string, string | string[]>;
          } | null;
        };
      } | undefined;

      if (resp?.ok && resp.payload) {
        const p = resp.payload;
        let specialty: MedicalPacks["specialty"] = null;
        if (p.specialty) {
          specialty = {
            drugs: BloomFilter.fromBase64(p.specialty.drugsB64, p.specialty.meta.drugs.sizeBits, p.specialty.meta.drugs.hashCount),
            conditions: BloomFilter.fromBase64(p.specialty.conditionsB64, p.specialty.meta.conditions.sizeBits, p.specialty.meta.conditions.hashCount),
            terms: BloomFilter.fromBase64(p.specialty.termsB64, p.specialty.meta.terms.sizeBits, p.specialty.meta.terms.hashCount),
            fuzzyIndex: p.specialty.fuzzyIndex ?? null,
          };
        }
        activePacks = {
          drugs: BloomFilter.fromBase64(p.drugsB64, p.meta.drugs.sizeBits, p.meta.drugs.hashCount),
          conditions: BloomFilter.fromBase64(p.conditionsB64, p.meta.conditions.sizeBits, p.meta.conditions.hashCount),
          terms: BloomFilter.fromBase64(p.termsB64, p.meta.terms.sizeBits, p.meta.terms.hashCount),
          catalog: p.catalog ?? {},
          fuzzyIndex: p.fuzzyIndex ?? null,
          specialtyMode: clinicMode,
          specialty,
        };
        return true;
      }

      // Fallback to legacy term list if mocks only answer CONTENT_GET_MEDICAL_DICTIONARY
      const legacyResp = (await cr.runtime.sendMessage({
        type: "CONTENT_GET_MEDICAL_DICTIONARY",
        requestId: `md_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      })) as { ok?: boolean; terms?: string[] } | undefined;
      if (legacyResp?.ok && Array.isArray(legacyResp.terms)) {
        const cleaned = legacyResp.terms.map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 3);
        legacyTerms = cleaned;
        if (cleaned.length > 0) {
          const esc = cleaned.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"));
          legacyRegex = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${esc.join("|")})(?![\\p{L}\\p{N}_])`, "giu");
        }
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

function demographicDelta(normPhrase: string, packs: MedicalPacks, clinicMode: ClinicMode): number {
  if (clinicMode === "general") return 0;
  const entry = packs.catalog[normPhrase];
  const inSpecialty =
    packs.specialty &&
    (packs.specialty.conditions.has(normPhrase) ||
      packs.specialty.drugs.has(normPhrase) ||
      packs.specialty.terms.has(normPhrase));

  if (inSpecialty || entry?.specialty === clinicMode) {
    return 0.12;
  }
  if (clinicMode === "obgyn" && entry?.exclusive && entry.sex === "male") {
    return -0.15;
  }
  if (clinicMode === "urology" && entry?.exclusive && entry.sex === "female") {
    return -0.15;
  }
  if (clinicMode === "pediatrics" && entry?.exclusive && entry.sex === "female" && entry.pregnancy) {
    return -0.15;
  }
  return 0;
}

export function detectMedicalDictionaryTerms(text: string, clinicMode: ClinicMode = "general"): RawMatch[] {
  if (!text) return [];
  if (!activePacks && !legacyTerms) tryLoadPacksSyncInNode(clinicMode);

  if (!activePacks) {
    if (!legacyRegex) return [];
    legacyRegex.lastIndex = 0;
    const out: RawMatch[] = [];
    for (const m of text.matchAll(legacyRegex)) {
      if (m.index === undefined) continue;
      out.push({
        category: "medical_record_number",
        confidence: 0.78,
        value: m[0],
        start: m.index,
        end: m.index + m[0].length,
        entityType: "medical_term",
      });
    }
    return out;
  }

  const packs = activePacks;
  const out: RawMatch[] = [];
  const covered: [number, number][] = [];
  const overlaps = (s: number, e: number) => covered.some(([cs, ce]) => s < ce && e > cs);

  // 1a. Multi-word conditions (2+ tokens) first so clinical phrases like "prostate cancer"
  // or "iron deficiency" are never split by single-word RxNorm supplements/ingredients.
  for (const hit of detectPhrases(text, packs.conditions, 4)) {
    if (hit.tokenCount < 2 || overlaps(hit.start, hit.end)) continue;
    const modeDelta = demographicDelta(hit.norm, packs, clinicMode);
    const conf = applyMedicalContextScore(text, hit.start, hit.end, 0.72 + modeDelta);
    out.push({
      category: "medical_record_number",
      confidence: conf,
      value: hit.phrase,
      start: hit.start,
      end: hit.end,
      entityType: "medical_condition",
    });
    covered.push([hit.start, hit.end]);
  }

  // 1b. Drugs: exact phrase match + dosage/frequency boost
  for (const hit of detectPhrases(text, packs.drugs, 4)) {
    if (overlaps(hit.start, hit.end)) continue;
    const boost = boostForDrug(text, hit.start, hit.end, 0.72);
    const modeDelta = demographicDelta(hit.norm, packs, clinicMode);
    const conf = applyMedicalContextScore(text, hit.start, boost.end, boost.confidence + modeDelta);
    out.push({
      category: "medical_record_number",
      confidence: conf,
      value: text.slice(hit.start, boost.end),
      start: hit.start,
      end: boost.end,
      entityType: boost.hasDosage ? "prescription" : "medication",
    });
    covered.push([hit.start, boost.end]);
  }

  // 2. Fuzzy drug matching via SymSpell + Damerau for drug-like tokens not already matched
  const tokens = tokenizeMedicalText(text);
  for (const tok of tokens) {
    if (overlaps(tok.start, tok.end)) continue;
    const nearby = text.slice(Math.max(0, tok.start - 40), Math.min(text.length, tok.end + 40));
    if (!isDrugLike(tok.raw, nearby)) continue;
    const fuzzy =
      fuzzyFindDrugSymSpell(tok.raw, packs.specialty?.fuzzyIndex ?? null, packs.specialty?.drugs ?? null) ??
      fuzzyFindDrugSymSpell(tok.raw, packs.fuzzyIndex, packs.drugs);
    if (!fuzzy || fuzzy.distance === 0) continue;
    const base = fuzzy.distance === 1 ? 0.68 : 0.6;
    const boost = boostForDrug(text, tok.start, tok.end, base + (fuzzy.phoneticMatch ? 0.04 : 0));
    const conf = applyMedicalContextScore(text, tok.start, boost.end, boost.confidence);
    out.push({
      category: "medical_record_number",
      confidence: conf,
      value: text.slice(tok.start, boost.end),
      start: tok.start,
      end: boost.end,
      entityType: `medication:${fuzzy.suggestion}`,
    });
    covered.push([tok.start, boost.end]);
  }

  // 3. Conditions: 1..4 word sliding phrase Bloom + demographic catalog boost
  for (const hit of detectPhrases(text, packs.conditions, 4)) {
    if (overlaps(hit.start, hit.end)) continue;
    const modeDelta = demographicDelta(hit.norm, packs, clinicMode);
    const conf = applyMedicalContextScore(text, hit.start, hit.end, 0.72 + modeDelta);
    out.push({
      category: "medical_record_number",
      confidence: conf,
      value: hit.phrase,
      start: hit.start,
      end: hit.end,
      entityType: "medical_condition",
    });
    covered.push([hit.start, hit.end]);
  }

  // 4. Medical terminology: procedures, labs, devices
  for (const hit of detectPhrases(text, packs.terms, 4)) {
    if (overlaps(hit.start, hit.end)) continue;
    const modeDelta = demographicDelta(hit.norm, packs, clinicMode);
    const conf = applyMedicalContextScore(text, hit.start, hit.end, 0.58 + modeDelta);
    out.push({
      category: "medical_record_number",
      confidence: conf,
      value: hit.phrase,
      start: hit.start,
      end: hit.end,
      entityType: "medical_term",
    });
    covered.push([hit.start, hit.end]);
  }

  // 5. Abbreviations (exact set)
  for (const ab of detectAbbrev(text)) {
    if (overlaps(ab.start, ab.end)) continue;
    const conf = applyMedicalContextScore(text, ab.start, ab.end, 0.65);
    out.push({
      category: "medical_record_number",
      confidence: conf,
      value: ab.value,
      start: ab.start,
      end: ab.end,
      entityType: `medical_abbrev:${ab.expanded}`,
    });
    covered.push([ab.start, ab.end]);
  }

  return out;
}
