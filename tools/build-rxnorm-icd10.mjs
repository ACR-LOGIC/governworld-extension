// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Builds Bloom filter packs (drugs, conditions, terms), conditions-catalog.json,
// bloom-meta.json, and SymSpell fuzzy-index.json.gz into vendor/medical/.
// Pass --fetch to pull live RxNorm prescribable + CDC/CMS ICD-10-CM order lists.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export function normalizePhrase(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function optimalParams(expectedItems, fpRate = 0.0001) {
  const n = Math.max(1, expectedItems);
  const sizeBits = Math.ceil((-n * Math.log(fpRate)) / (Math.LN2 * Math.LN2));
  const hashCount = Math.max(1, Math.round((sizeBits / n) * Math.LN2));
  return { sizeBits, hashCount };
}

class NodeBloom {
  constructor(sizeBits, hashCount) {
    this.sizeBits = sizeBits;
    this.hashCount = hashCount;
    this.bits = new Uint8Array(Math.ceil(sizeBits / 8));
  }
  hashes(key) {
    let h1 = 0x811c9dc5;
    let h2 = 0x9e3779b9;
    for (let i = 0; i < key.length; i++) {
      const c = key.charCodeAt(i);
      h1 ^= c;
      h1 = Math.imul(h1, 0x01000193);
      h2 ^= c + ((h1 >>> 16) & 0xff);
      h2 = Math.imul(h2, 0x85ebca6b);
    }
    return [h1 >>> 0, (h2 >>> 0) || 1];
  }
  add(key) {
    const [h1, h2] = this.hashes(key);
    for (let i = 0; i < this.hashCount; i++) {
      const bit = ((h1 + Math.imul(i, h2)) >>> 0) % this.sizeBits;
      this.bits[bit >>> 3] |= 1 << (bit & 7);
    }
  }
}

export function deletionsUpTo2(word, maxDist = 2) {
  const result = new Map();
  result.set(word, 0);
  const queue = [[word, 0]];
  while (queue.length > 0) {
    const [cur, dist] = queue.shift();
    if (dist >= maxDist || cur.length <= 2) continue;
    for (let i = 0; i < cur.length; i++) {
      const del = cur.slice(0, i) + cur.slice(i + 1);
      const nextDist = dist + 1;
      const existing = result.get(del);
      if (existing === undefined || nextDist < existing) {
        result.set(del, nextDist);
        queue.push([del, nextDist]);
      }
    }
  }
  return result;
}

export function categorizeCondition(code, desc) {
  const d = desc.toLowerCase();
  const c = (code || "").toUpperCase();
  const cats = { age: [], sex: "all", pregnancy: false, exclusive: false, specialty: "general" };

  if (/^P\d/.test(c) || /newborn|neonatal/.test(d)) {
    cats.age.push("neonatal");
    cats.specialty = "pediatrics";
  }
  if (/^Q\d/.test(c) || /congenital|infant|child|pediatric|croup|kawasaki|bronchiolitis|chickenpox|otitis media/.test(d)) {
    cats.age.push("child");
    cats.specialty = "pediatrics";
  }
  if (/^O\d/.test(c) || /pregnan|preeclampsia|gestational|placenta|ectopic|postpartum|hyperemesis|preterm/.test(d)) {
    cats.sex = "female";
    cats.pregnancy = true;
    cats.exclusive = true;
    cats.specialty = "obgyn";
  } else if (/^(N7[0-9]|N8[0-9]|N9[0-8]|C5[0-8]|D2[5-8])/.test(c) || /endometriosis|pcos|polycystic ovary|ovarian|cervical|menopause/.test(d)) {
    cats.sex = "female";
    cats.exclusive = true;
    cats.specialty = "obgyn";
  } else if (/^(N4[0-9]|N5[01]|C61)/.test(c) || /prostate|bph|testicular|erectile/.test(d)) {
    cats.sex = "male";
    cats.exclusive = true;
    cats.specialty = "urology";
  }
  if (/alzheimer|dementia|hip fracture|macular degeneration|senile|age-related/.test(d)) {
    cats.age.push("older_adult");
    if (cats.specialty === "general") cats.specialty = "geriatrics";
  }
  if (/type 2 diabetes|hypertension/.test(d)) {
    cats.age.push("adult");
  }
  return cats;
}

function readLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((l) => normalizePhrase(l))
    .filter((l) => l.length >= 3);
}

export function buildSymSpellIndex(words) {
  const index = Object.create(null);
  for (const word of words) {
    if (word.includes(" ") || word.length < 5 || word.length > 28) continue;
    const dels = deletionsUpTo2(word, 2);
    for (const [del] of dels) {
      if (del.length < 4) continue;
      const cur = index[del];
      if (!cur) {
        index[del] = word;
      } else if (Array.isArray(cur)) {
        if (!cur.includes(word) && cur.length < 4) cur.push(word);
      } else if (cur !== word) {
        index[del] = [cur, word];
      }
    }
  }
  return index;
}

export function writeBloomPack(outDir, name, items) {
  const unique = [...new Set(items.map(normalizePhrase).filter((x) => x.length >= 3))];
  const { sizeBits, hashCount } = optimalParams(unique.length, 0.0001);
  const bloom = new NodeBloom(sizeBits, hashCount);
  for (const item of unique) bloom.add(item);
  fs.writeFileSync(path.join(outDir, `${name}.bin`), bloom.bits);
  return { count: unique.length, sizeBits, hashCount, bytes: bloom.bits.length, items: unique };
}

function extractZipTextEntries(zipBuf) {
  const entries = [];
  // Find End of Central Directory (0x06054b50)
  let eocdOffset = -1;
  for (let i = zipBuf.length - 22; i >= Math.max(0, zipBuf.length - 65558); i--) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) return entries;
  const cdOffset = zipBuf.readUInt32LE(eocdOffset + 16);
  const totalEntries = zipBuf.readUInt16LE(eocdOffset + 10);
  let pos = cdOffset;
  for (let n = 0; n < totalEntries && pos + 46 <= zipBuf.length; n++) {
    if (zipBuf.readUInt32LE(pos) !== 0x02014b50) break;
    const compMethod = zipBuf.readUInt16LE(pos + 10);
    const compSize = zipBuf.readUInt32LE(pos + 20);
    const nameLen = zipBuf.readUInt16LE(pos + 28);
    const extraLen = zipBuf.readUInt16LE(pos + 30);
    const commentLen = zipBuf.readUInt16LE(pos + 32);
    const localOffset = zipBuf.readUInt32LE(pos + 42);
    const name = zipBuf.toString("utf8", pos + 46, pos + 46 + nameLen);
    pos += 46 + nameLen + extraLen + commentLen;

    if (!name.toLowerCase().endsWith(".txt")) continue;
    const lNameLen = zipBuf.readUInt16LE(localOffset + 26);
    const lExtraLen = zipBuf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const slice = zipBuf.subarray(dataStart, dataStart + compSize);
    const data = compMethod === 0 ? slice : compMethod === 8 ? zlib.inflateRawSync(slice) : null;
    if (data) entries.push({ name, text: data.toString("utf8") });
  }
  return entries;
}

function cleanIcd10Variants(rawDesc) {
  const cleaned = rawDesc
    .replace(/\([^)]*\)/g, " ")
    .replace(/,\s*(?:unspecified|not otherwise specified|nos|initial encounter|subsequent encounter|sequela|without complications|with complications).*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  const variants = new Set();
  const n1 = normalizePhrase(rawDesc);
  const n2 = normalizePhrase(cleaned);
  if (n1.length >= 4 && n1.split(" ").length <= 4) variants.add(n1);
  if (n2.length >= 4 && n2.split(" ").length <= 4) variants.add(n2);
  // Shorten comma-inverted descriptions like "hypertension, essential" -> "essential hypertension"
  const commaParts = cleaned.split(",").map((p) => normalizePhrase(p)).filter(Boolean);
  if (commaParts.length === 2 && commaParts[0].split(" ").length <= 2 && commaParts[1].split(" ").length <= 2) {
    variants.add(`${commaParts[1]} ${commaParts[0]}`);
  }
  return [...variants];
}

async function fetchIcd10OrderText() {
  const directUrls = [
    "https://ftp.cdc.gov/pub/Health_Statistics/NCHS/Publications/ICD10CM/2025/icd10cm-order-Jan-2025.txt",
    "https://ftp.cdc.gov/pub/Health_Statistics/NCHS/Publications/ICD10CM/2024/icd10cm-order-Jan-2024.txt",
    "https://www.cms.gov/files/zip/2025-code-descriptions-tabular-order.zip",
    "https://www.cms.gov/files/zip/2026-code-descriptions-tabular-order.zip",
  ];
  for (const url of directUrls) {
    try {
      const resp = await fetch(url, { headers: { "User-Agent": "GovernWorld-PackBuilder/1.0" } });
      if (!resp.ok) continue;
      if (url.endsWith(".zip")) {
        const buf = Buffer.from(await resp.arrayBuffer());
        const txts = extractZipTextEntries(buf);
        const orderTxt = txts.find((t) => /order/i.test(t.name)) ?? txts[0];
        if (orderTxt) {
          console.log(`Fetched ICD-10-CM zip from ${url} (${orderTxt.name})`);
          return orderTxt.text;
        }
      } else {
        const txt = await resp.text();
        if (txt.length > 50_000) {
          console.log(`Fetched ICD-10-CM order text from ${url}`);
          return txt;
        }
      }
    } catch {
      // Try next URL
    }
  }
  return null;
}

async function run() {
  const root = process.cwd();
  const outDir = path.join(root, "vendor", "medical");
  fs.mkdirSync(outDir, { recursive: true });

  const drugs = readLines(path.join(root, "data/manual/drugs-extra.txt"));
  const conditions = readLines(path.join(root, "data/manual/conditions-extra.txt"));
  const terms = readLines(path.join(root, "data/manual/terms-extra.txt"));

  const legacyPath = path.join(root, "vendor/medical-dictionary.json");
  if (fs.existsSync(legacyPath)) {
    const legacy = JSON.parse(fs.readFileSync(legacyPath, "utf8"));
    if (Array.isArray(legacy.terms)) {
      for (const t of legacy.terms) conditions.push(normalizePhrase(t));
    }
  }

  const catalog = {};
  for (const cond of conditions) {
    const cat = categorizeCondition("", cond);
    if (cat.specialty !== "general" || cat.sex !== "all" || cat.age.length > 0) {
      catalog[cond] = cat;
    }
  }

  if (process.argv.includes("--fetch")) {
    try {
      const rxResp = await fetch("https://rxnav.nlm.nih.gov/REST/Prescribe/allconcepts.json?tty=IN+BN+PIN");
      if (rxResp.ok) {
        const rxData = await rxResp.json();
        const groups = rxData?.minConceptGroup?.minConcept ?? [];
        for (const g of groups) {
          if (!g?.name) continue;
          const cleaned = g.name.replace(/\([^)]*\)/g, " ").replace(/\[[^\]]*\]/g, " ");
          const norm = normalizePhrase(cleaned);
          if (norm.length >= 4 && norm.split(" ").length <= 4) {
            drugs.push(norm);
          }
        }
        console.log(`Fetched ${groups.length} RxNorm concepts.`);
      }
    } catch (err) {
      console.warn("RxNorm fetch skipped:", err.message);
    }

    const icdText = await fetchIcd10OrderText();
    if (icdText) {
      let icdCount = 0;
      for (const line of icdText.split(/\r?\n/)) {
        if (line.length < 18) continue;
        // CMS/CDC fixed-width order format: seq(5) + space + code(7) + space + header(1) + space + shortDesc(60) + space + longDesc
        const code = line.slice(6, 13).trim();
        const shortDesc = line.slice(16, 77).trim();
        const longDesc = line.slice(77).trim();
        const raw = shortDesc || longDesc;
        if (!code || !raw) continue;
        icdCount += 1;
        const cat = categorizeCondition(code, longDesc || shortDesc);
        for (const variant of cleanIcd10Variants(raw)) {
          conditions.push(variant);
          if (cat.specialty !== "general" || cat.sex !== "all" || cat.age.length > 0) {
            catalog[variant] = cat;
          }
        }
      }
      console.log(`Parsed ${icdCount} ICD-10-CM rows.`);
    } else {
      console.warn("ICD-10-CM fetch unavailable; using local conditions.");
    }
  }

  const dMeta = writeBloomPack(outDir, "bloom-drugs", drugs);
  const cMeta = writeBloomPack(outDir, "bloom-conditions", conditions);
  const tMeta = writeBloomPack(outDir, "bloom-terms", terms);

  fs.writeFileSync(path.join(outDir, "conditions-catalog.json"), JSON.stringify(catalog));

  const symspell = buildSymSpellIndex(dMeta.items);
  fs.writeFileSync(path.join(outDir, "fuzzy-index.json.gz"), zlib.gzipSync(JSON.stringify(symspell)));

  const meta = {
    generatedAt: new Date().toISOString(),
    drugs: { count: dMeta.count, sizeBits: dMeta.sizeBits, hashCount: dMeta.hashCount, bytes: dMeta.bytes },
    conditions: { count: cMeta.count, sizeBits: cMeta.sizeBits, hashCount: cMeta.hashCount, bytes: cMeta.bytes },
    terms: { count: tMeta.count, sizeBits: tMeta.sizeBits, hashCount: tMeta.hashCount, bytes: tMeta.bytes },
  };
  fs.writeFileSync(path.join(outDir, "bloom-meta.json"), JSON.stringify(meta, null, 2));
  console.log("Built general medical packs:", meta);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("build-rxnorm-icd10.mjs")) {
  await run();
}
