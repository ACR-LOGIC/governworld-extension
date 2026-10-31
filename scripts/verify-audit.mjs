#!/usr/bin/env node
// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Standalone audit verification tool (CLI).
// Self-contained: runs on any standard Node.js installation (v20+ / v22+)
// with zero external dependencies.
//
// Verifies:
// 1. ECDSA P-256 / SHA-256 digital signature over the canonical JSONL payload.
// 2. Cryptographic SHA-256 hash chain linking every audit event.
//
// Usage:
//   node scripts/verify-audit.mjs <path-to-audit-export.json>

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const CANONICAL_KEYS = [
  "ts",
  "action",
  "host",
  "counts",
  "docHash",
  "pages",
  "presetId",
  "gatewayOrigin",
  "enabledCategories",
  "prevHash",
  "outcome",
];

const AUDIT_ACTIONS = new Set([
  "page_scan_completed",
  "masks_applied",
  "masks_removed",
  "selection_redacted",
  "selection_masked",
  "doc_previewed",
  "doc_redacted",
  "doc_cleared",
  "session_cleared",
  "preset_applied",
  "preset_overridden",
  "account_linked",
]);

function canonicalEventLine(event) {
  const ordered = {};
  for (const key of CANONICAL_KEYS) {
    if (event[key] !== undefined) ordered[key] = event[key];
  }
  return JSON.stringify(ordered);
}

function sha256Hex(str) {
  return crypto.createHash("sha256").update(str, "utf8").digest("hex");
}

function isAuditEvent(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  if (typeof v.ts !== "string" || !v.ts) return false;
  if (!AUDIT_ACTIONS.has(v.action)) return false;
  if (v.outcome !== "ok" && v.outcome !== "denied" && v.outcome !== "error") return false;
  if (v.prevHash !== undefined && (typeof v.prevHash !== "string" || !/^[a-f0-9]{64}$/.test(v.prevHash))) return false;
  return true;
}

async function verifySignature(exported) {
  try {
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      exported.publicKeyJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
    const data = new TextEncoder().encode(exported.jsonl);
    const sigBytes = Uint8Array.from(atob(exported.signatureBase64), (c) => c.charCodeAt(0));
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, sigBytes, data);
  } catch (err) {
    console.error(`Signature verification error: ${err.message}`);
    return false;
  }
}

function computeKeyFingerprint(jwk) {
  const sortedKeys = Object.keys(jwk).sort();
  const canonical = {};
  for (const k of sortedKeys) canonical[k] = jwk[k];
  return crypto.createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

function canonicalCheckpointLine(cp) {
  const ordered = {
    checkpointVersion: cp.checkpointVersion,
    eventCount: cp.eventCount,
    headHash: cp.headHash,
  };
  if (cp.prevCheckpointHash !== undefined) {
    ordered.prevCheckpointHash = cp.prevCheckpointHash;
  }
  ordered.sequenceNumber = cp.sequenceNumber;
  ordered.timestamp = cp.timestamp;
  return JSON.stringify(ordered);
}

async function verifyCheckpointSignature(exported) {
  try {
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      exported.publicKeyJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
    const data = new TextEncoder().encode(canonicalCheckpointLine(exported.checkpoint));
    const sigBytes = Uint8Array.from(atob(exported.checkpointSignatureBase64), (c) => c.charCodeAt(0));
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, sigBytes, data);
  } catch (err) {
    console.error(`Checkpoint signature error: ${err.message}`);
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  let fileArg = null;
  let trustedFingerprint = null;
  let minSequence = null;
  let expectedHead = null;
  let expectedCheckpoint = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-h" || args[i] === "--help") {
      console.log(
        "Usage: node scripts/verify-audit.mjs <path-to-audit-export.json> [--trusted-fingerprint <sha256>] [--min-sequence <n>] [--expected-head <hash>] [--expected-checkpoint <hash>]"
      );
      process.exit(0);
    } else if (args[i] === "--trusted-fingerprint" || args[i] === "-f") {
      trustedFingerprint = args[++i];
    } else if (args[i] === "--min-sequence") {
      minSequence = parseInt(args[++i], 10);
    } else if (args[i] === "--expected-head") {
      expectedHead = args[++i];
    } else if (args[i] === "--expected-checkpoint") {
      expectedCheckpoint = args[++i];
    } else if (!fileArg) {
      fileArg = args[i];
    }
  }

  if (!fileArg) {
    console.log(
      "Usage: node scripts/verify-audit.mjs <path-to-audit-export.json> [--trusted-fingerprint <sha256>] [--min-sequence <n>] [--expected-head <hash>] [--expected-checkpoint <hash>]"
    );
    process.exit(1);
  }

  const filePath = path.resolve(process.cwd(), fileArg);
  if (!fs.existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    console.error(`Error parsing JSON: ${err.message}`);
    process.exit(1);
  }

  if (!raw || typeof raw.jsonl !== "string" || typeof raw.signatureBase64 !== "string" || !raw.publicKeyJwk) {
    console.error("Error: Invalid audit export format. Expected { jsonl, signatureBase64, publicKeyJwk }.");
    process.exit(1);
  }

  console.log(`Verifying audit export: ${filePath}`);
  console.log(`Exported at: ${raw.exportedAt ?? "unknown"}`);
  console.log(`Event count: ${raw.eventCount ?? "unknown"}`);

  const keyFingerprint = computeKeyFingerprint(raw.publicKeyJwk);
  console.log(`Public key fingerprint (SHA-256): ${keyFingerprint}`);

  if (trustedFingerprint) {
    if (keyFingerprint.toLowerCase() !== trustedFingerprint.toLowerCase()) {
      console.error(`FAIL: Public key fingerprint mismatch! Expected ${trustedFingerprint}, but export key is ${keyFingerprint}`);
      process.exit(1);
    }
    console.log("PASS: Public key matches trusted device fingerprint.");
  } else {
    console.log("NOTE: Self-signed export key. To verify against a known device anchor, pass --trusted-fingerprint <sha256>.");
  }

  // 1. Verify ECDSA signature
  const isSigValid = await verifySignature(raw);
  if (!isSigValid) {
    console.error("FAIL: Digital signature verification failed! The export bytes have been modified.");
    process.exit(1);
  }
  console.log("PASS: ECDSA P-256 digital signature verified.");

  // 2. Verify hash chain
  const lines = raw.jsonl.split("\n").filter((l) => l.trim().length > 0);
  const events = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (!isAuditEvent(parsed)) {
        console.error(`FAIL: Invalid audit event schema at line ${i + 1}`);
        process.exit(1);
      }
      events.push(parsed);
    } catch (e) {
      console.error(`FAIL: Malformed JSON at line ${i + 1}: ${e.message}`);
      process.exit(1);
    }
  }

  const isChainedLog = events.some((e) => e.prevHash !== undefined);
  if (isChainedLog && events.length > 0 && events[0].prevHash !== undefined) {
    console.error("FAIL: Prefix history truncated: genesis event at index 0 carries prevHash pointing to prior deleted event.");
    process.exit(1);
  }

  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1];
    const current = events[i];
    if (isChainedLog) {
      if (current.prevHash === undefined) {
        console.error(`FAIL: Missing prevHash at index ${i} in a hash-chained log.`);
        process.exit(1);
      }
      const expected = sha256Hex(canonicalEventLine(prev));
      if (current.prevHash !== expected) {
        console.error(`FAIL: Hash chain mismatch at index ${i}: expected ${expected}, got ${current.prevHash}`);
        process.exit(1);
      }
    }
  }

  console.log(`PASS: Hash chain verified intact across ${events.length} events.`);

  // 3. Verify Checkpoint and Rollback Resistance (if present)
  if (raw.checkpoint) {
    const cp = raw.checkpoint;
    if (cp.checkpointVersion !== 1) {
      console.error(`FAIL: Unsupported checkpoint version: ${cp.checkpointVersion}`);
      process.exit(1);
    }
    if (cp.eventCount !== events.length) {
      console.error(`FAIL: Checkpoint eventCount (${cp.eventCount}) does not match event count (${events.length}).`);
      process.exit(1);
    }
    const computedHead = events.length > 0 ? sha256Hex(canonicalEventLine(events[events.length - 1])) : "0".repeat(64);
    if (cp.headHash !== computedHead) {
      console.error(`FAIL: Checkpoint headHash mismatch! Expected ${computedHead}, got ${cp.headHash}`);
      process.exit(1);
    }

    if (raw.checkpointSignatureBase64) {
      const isCpSigValid = await verifyCheckpointSignature(raw);
      if (!isCpSigValid) {
        console.error("FAIL: Checkpoint digital signature verification failed!");
        process.exit(1);
      }
      console.log("PASS: Checkpoint ECDSA signature verified.");
    }

    if (minSequence !== null) {
      if (typeof cp.sequenceNumber !== "number" || cp.sequenceNumber < minSequence) {
        console.error(
          `FAIL: Rollback detected! Checkpoint sequence ${cp.sequenceNumber} is less than required minimum sequence ${minSequence}.`
        );
        process.exit(1);
      }
      console.log(`PASS: Monotonic sequence verified: ${cp.sequenceNumber} >= ${minSequence}.`);
    }

    if (expectedHead !== null) {
      if (cp.headHash !== expectedHead) {
        console.error(`FAIL: Expected head hash mismatch! Expected ${expectedHead}, got ${cp.headHash}`);
        process.exit(1);
      }
      console.log("PASS: Expected head hash matches checkpoint.");
    }

    if (expectedCheckpoint !== null) {
      const computedCpHash = sha256Hex(canonicalCheckpointLine(cp));
      if (computedCpHash !== expectedCheckpoint) {
        console.error(`FAIL: Expected checkpoint hash mismatch! Expected ${expectedCheckpoint}, got ${computedCpHash}`);
        process.exit(1);
      }
      console.log("PASS: External anchor checkpoint hash matches.");
    }
  } else if (minSequence !== null || expectedCheckpoint !== null) {
    console.error("FAIL: Checkpoint constraints were specified (--min-sequence / --expected-checkpoint), but export lacks a checkpoint.");
    process.exit(1);
  }

  console.log("VERIFICATION SUCCESSFUL: Audit log is authentic and untampered.");
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
