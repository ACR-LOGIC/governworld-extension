// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Builds OB-GYN Bloom packs + SymSpell index into vendor/medical/.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { buildSymSpellIndex, writeBloomPack } from "./build-rxnorm-icd10.mjs";

const OBGYN_CONDITIONS = [
  "preeclampsia", "gestational diabetes", "placenta previa", "hyperemesis gravidarum",
  "ectopic pregnancy", "miscarriage", "preterm labor", "pcos", "polycystic ovary syndrome",
  "endometriosis", "ovarian cyst", "uterine fibroids", "cervical dysplasia",
  "pelvic inflammatory disease", "breast cancer", "mastitis", "fibroadenoma",
  "postpartum depression", "postpartum hemorrhage", "menopause",
  "postmenopausal bleeding", "atrophic vaginitis",
];

const OBGYN_DRUGS = [
  "levonorgestrel", "ethinyl estradiol", "norethindrone", "medroxyprogesterone",
  "clomiphene", "letrozole", "prenatal vitamin", "folic acid", "iron",
  "labetalol", "methyldopa", "misoprostol", "oxytocin", "magnesium sulfate", "progesterone",
];

const OBGYN_TERMS = [
  "prenatal visit", "ultrasound", "pap smear", "mammogram", "colposcopy",
  "fetal heart rate", "amniocentesis", "c-section", "vaginal delivery",
  "contraceptive counseling", "iud insertion",
];

const root = process.cwd();
const outDir = path.join(root, "vendor", "medical");
fs.mkdirSync(outDir, { recursive: true });

const catalogPath = path.join(outDir, "conditions-catalog.json");
const mergedObgynConditions = [...OBGYN_CONDITIONS];
if (fs.existsSync(catalogPath)) {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  for (const [phrase, info] of Object.entries(catalog)) {
    if (info?.specialty === "obgyn") mergedObgynConditions.push(phrase);
  }
}

const dMeta = writeBloomPack(outDir, "bloom-drugs-obgyn", OBGYN_DRUGS);
const cMeta = writeBloomPack(outDir, "bloom-conditions-obgyn", mergedObgynConditions);
const tMeta = writeBloomPack(outDir, "bloom-terms-obgyn", OBGYN_TERMS);

const symspell = buildSymSpellIndex(dMeta.items);
fs.writeFileSync(path.join(outDir, "fuzzy-index-obgyn.json.gz"), zlib.gzipSync(JSON.stringify(symspell)));

const meta = {
  generatedAt: new Date().toISOString(),
  drugs: { count: dMeta.count, sizeBits: dMeta.sizeBits, hashCount: dMeta.hashCount, bytes: dMeta.bytes },
  conditions: { count: cMeta.count, sizeBits: cMeta.sizeBits, hashCount: cMeta.hashCount, bytes: cMeta.bytes },
  terms: { count: tMeta.count, sizeBits: tMeta.sizeBits, hashCount: tMeta.hashCount, bytes: tMeta.bytes },
};
fs.writeFileSync(path.join(outDir, "bloom-obgyn-meta.json"), JSON.stringify(meta, null, 2));
console.log("Built OB-GYN medical packs:", meta);
