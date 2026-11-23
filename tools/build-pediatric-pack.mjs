// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Builds pediatric-only Bloom packs + SymSpell index into vendor/medical/.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { buildSymSpellIndex, categorizeCondition, writeBloomPack } from "./build-rxnorm-icd10.mjs";

const PED_CONDITIONS = [
  "neonatal jaundice", "respiratory distress of newborn", "neonatal sepsis",
  "rsv bronchiolitis", "croup", "acute otitis media", "otitis media", "colic",
  "failure to thrive", "hand foot and mouth", "kawasaki disease", "chickenpox",
  "measles", "mumps", "strep pharyngitis", "asthma", "febrile seizure",
  "scoliosis", "mononucleosis", "acne", "appendicitis", "congenital heart disease",
];

const PED_DRUGS = [
  "amoxicillin oral suspension", "azithromycin suspension", "albuterol inhaler",
  "albuterol nebulizer", "albuterol", "budesonide nebulizer", "cetirizine solution",
  "ibuprofen suspension", "acetaminophen suspension", "methylphenidate",
  "amoxicillin clavulanate suspension", "amoxicillin",
];

const PED_TERMS = [
  "well-child visit", "immunization", "growth chart", "developmental milestone",
  "pediatric intensive care", "school nurse", "daycare exposure", "weight-based dosing",
];

const root = process.cwd();
const outDir = path.join(root, "vendor", "medical");
fs.mkdirSync(outDir, { recursive: true });

const catalogPath = path.join(outDir, "conditions-catalog.json");
const mergedPedConditions = [...PED_CONDITIONS];
if (fs.existsSync(catalogPath)) {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  for (const [phrase, info] of Object.entries(catalog)) {
    if (info?.specialty === "pediatrics") mergedPedConditions.push(phrase);
  }
}

const dMeta = writeBloomPack(outDir, "bloom-drugs-pediatric", PED_DRUGS);
const cMeta = writeBloomPack(outDir, "bloom-conditions-pediatric", mergedPedConditions);
const tMeta = writeBloomPack(outDir, "bloom-terms-pediatric", PED_TERMS);

for (const c of cMeta.items) categorizeCondition("", c);

const symspell = buildSymSpellIndex(dMeta.items);
fs.writeFileSync(path.join(outDir, "fuzzy-index-pediatric.json.gz"), zlib.gzipSync(JSON.stringify(symspell)));

const meta = {
  generatedAt: new Date().toISOString(),
  drugs: { count: dMeta.count, sizeBits: dMeta.sizeBits, hashCount: dMeta.hashCount, bytes: dMeta.bytes },
  conditions: { count: cMeta.count, sizeBits: cMeta.sizeBits, hashCount: cMeta.hashCount, bytes: cMeta.bytes },
  terms: { count: tMeta.count, sizeBits: tMeta.sizeBits, hashCount: tMeta.hashCount, bytes: tMeta.bytes },
};
fs.writeFileSync(path.join(outDir, "bloom-pediatric-meta.json"), JSON.stringify(meta, null, 2));
console.log("Built pediatric medical packs:", meta);
