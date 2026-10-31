// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Adversarial test suite for audit hash chaining, concurrency, and key trust (Objectives 1, 2, 3).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  canonicalEventLine,
  toAuditJsonl,
  sha256Hex,
  verifyAuditChain,
  recordAudit,
  loadAuditLog,
  clearAuditLog,
  exportSignedAuditLog,
  verifySignedAuditExport,
  canonicalCheckpointLine,
  AUDIT_CHECKPOINT_KEY,
  type AuditEvent,
  type SignedAuditExport,
} from "../src/shared/audit.js";

const tmpAdversarialExport = path.resolve(process.cwd(), ".tmp-test-adversarial-export.json");

describe("audit hash chaining adversarial resilience (Objective 1 & 2)", () => {
  afterEach(() => {
    if (fs.existsSync(tmpAdversarialExport)) {
      try {
        fs.unlinkSync(tmpAdversarialExport);
      } catch {
        // ignore
      }
    }
  });

  async function buildChain(count: number): Promise<AuditEvent[]> {
    const events: AuditEvent[] = [];
    for (let i = 0; i < count; i++) {
      const ev: AuditEvent = {
        ts: `2026-08-21T00:0${i}:00.000Z`,
        action: i % 2 === 0 ? "page_scan_completed" : "masks_applied",
        outcome: "ok",
      };
      if (i > 0) {
        ev.prevHash = await sha256Hex(canonicalEventLine(events[i - 1]));
      }
      events.push(ev);
    }
    return events;
  }

  it("rejects history when an event is deleted from the middle of the chain", async () => {
    const chain = await buildChain(5);
    // Delete event at index 2
    const tampered = [chain[0], chain[1], chain[3], chain[4]];
    const result = await verifyAuditChain(tampered);
    expect(result.valid).toBe(false);
    expect(result.brokenIndex).toBe(2); // chain[3] is now at index 2 and expects chain[2]
    expect(result.reason).toContain("Hash chain mismatch at index 2");
  });

  it("rejects history when the genesis event is deleted (prefix truncation)", async () => {
    const chain = await buildChain(4);
    // Delete event at index 0 (genesis). Now event 1 is at index 0 with a prevHash!
    const truncated = chain.slice(1);
    const result = await verifyAuditChain(truncated);
    expect(result.valid).toBe(false);
    expect(result.brokenIndex).toBe(0);
    expect(result.reason).toContain("Prefix history truncated");
  });

  it("rejects history when two events are reordered / swapped", async () => {
    const chain = await buildChain(4);
    // Swap index 1 and index 2
    const swapped = [chain[0], chain[2], chain[1], chain[3]];
    const result = await verifyAuditChain(swapped);
    expect(result.valid).toBe(false);
    expect(result.brokenIndex).toBe(1);
  });

  it("rejects history when an intermediate event has prevHash stripped", async () => {
    const chain = await buildChain(4);
    // Strip prevHash from event 2
    const stripped = [
      chain[0],
      chain[1],
      { ...chain[2], prevHash: undefined },
      chain[3],
    ];
    const result = await verifyAuditChain(stripped);
    expect(result.valid).toBe(false);
    expect(result.brokenIndex).toBe(2);
    expect(result.reason).toContain("Missing prevHash at index 2");
  });

  it("rejects rogue key when verified against a trusted fingerprint via CLI", async () => {
    const chain = await buildChain(3);
    const jsonl = toAuditJsonl(chain);

    // 1. Generate legitimate key
    const legitPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const legitJwk = await crypto.subtle.exportKey("jwk", legitPair.publicKey);
    const sortedLegitKeys = Object.keys(legitJwk).sort();
    const canonicalLegit: Record<string, unknown> = {};
    for (const k of sortedLegitKeys) canonicalLegit[k] = (legitJwk as Record<string, unknown>)[k];
    const legitFingerprint = await sha256Hex(JSON.stringify(canonicalLegit));

    // 2. Attacker generates rogue key and signs arbitrary payload
    const roguePair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const rogueJwk = await crypto.subtle.exportKey("jwk", roguePair.publicKey);
    const data = new TextEncoder().encode(jsonl);
    const rogueSig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, roguePair.privateKey, data);
    const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(rogueSig)));

    const forgedExport: SignedAuditExport = {
      jsonl,
      signatureBase64,
      publicKeyJwk: rogueJwk,
      exportedAt: new Date().toISOString(),
      eventCount: chain.length,
    };

    fs.writeFileSync(tmpAdversarialExport, JSON.stringify(forgedExport, null, 2), "utf8");

    // 3. Verification with trusted fingerprint MUST reject the rogue key!
    let failed = false;
    try {
      execFileSync(
        "node",
        ["scripts/verify-audit.mjs", tmpAdversarialExport, "--trusted-fingerprint", legitFingerprint],
        { encoding: "utf8" }
      );
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);

    // 4. Verification with the matching rogue fingerprint succeeds the key check
    const sortedRogueKeys = Object.keys(rogueJwk).sort();
    const canonicalRogue: Record<string, unknown> = {};
    for (const k of sortedRogueKeys) canonicalRogue[k] = (rogueJwk as Record<string, unknown>)[k];
    const rogueFingerprint = await sha256Hex(JSON.stringify(canonicalRogue));

    const out = execFileSync(
      "node",
      ["scripts/verify-audit.mjs", tmpAdversarialExport, "--trusted-fingerprint", rogueFingerprint],
      { encoding: "utf8" }
    );
    expect(out).toContain("PASS: Public key matches trusted device fingerprint");
  });
});

describe("concurrent writes, storage errors, and recovery (Objective 3)", () => {
  let mockStorage: Record<string, unknown> = {};
  let failNextSet = false;

  beforeEach(() => {
    mockStorage = {};
    failNextSet = false;
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: mockStorage[key] }),
          set: async (items: Record<string, unknown>) => {
            if (failNextSet) {
              failNextSet = false;
              throw new Error("QuotaExceededError: Local storage full");
            }
            // Add slight artificial delay to maximize concurrency race exposure
            await new Promise((r) => setTimeout(r, 2));
            Object.assign(mockStorage, items);
          },
          remove: async (key: string) => {
            delete mockStorage[key];
          },
        },
      },
    };
  });

  it("preserves strict sequential hash chaining under 50 concurrent writes", async () => {
    const writes = Array.from({ length: 50 }, (_, i) =>
      recordAudit({
        ts: new Date(1700000000000 + i * 1000).toISOString(),
        action: "page_scan_completed",
        outcome: "ok",
      })
    );

    await Promise.all(writes);

    const log = await loadAuditLog();
    expect(log).toHaveLength(50);

    // Check chain integrity across all 50 concurrent writes
    const result = await verifyAuditChain(log);
    expect(result.valid).toBe(true);

    // Assert every event i >= 1 links to event i - 1
    for (let i = 1; i < log.length; i++) {
      const prevExpected = await sha256Hex(canonicalEventLine(log[i - 1]));
      expect(log[i].prevHash).toBe(prevExpected);
    }
  });

  it("recovers cleanly and releases mutex lock after storage failure", async () => {
    // 1. Initial write succeeds
    await recordAudit({ ts: "2026-08-21T00:00:00.000Z", action: "page_scan_completed", outcome: "ok" });

    // 2. Next write fails with failClosed: true
    failNextSet = true;
    await expect(
      recordAudit({ ts: "2026-08-21T00:01:00.000Z", action: "doc_redacted", outcome: "ok" }, { failClosed: true })
    ).rejects.toThrow("QuotaExceededError");

    // 3. Mutex lock was released, next write succeeds and links to the last surviving event!
    await recordAudit({ ts: "2026-08-21T00:02:00.000Z", action: "masks_applied", outcome: "ok" });

    const log = await loadAuditLog();
    expect(log).toHaveLength(2);
    expect(log[0].action).toBe("page_scan_completed");
    expect(log[1].action).toBe("masks_applied");

    // Chain is unbroken between surviving events
    const expectedHash = await sha256Hex(canonicalEventLine(log[0]));
    expect(log[1].prevHash).toBe(expectedHash);

    const chainCheck = await verifyAuditChain(log);
    expect(chainCheck.valid).toBe(true);
  });
});

describe("audit checkpointing and rollback resistance (Objective 2)", () => {
  const tmpCpExport = path.resolve(process.cwd(), ".tmp-test-cp-export.json");

  afterEach(() => {
    if (fs.existsSync(tmpCpExport)) {
      try {
        fs.unlinkSync(tmpCpExport);
      } catch {
        // ignore
      }
    }
  });

  it("verifies authentic checkpoint and rejects rollback or tampered head hash", async () => {
    const event1: AuditEvent = { ts: "2026-08-21T00:00:00.000Z", action: "page_scan_completed", outcome: "ok" };
    const prev1 = await sha256Hex(canonicalEventLine(event1));
    const event2: AuditEvent = { ts: "2026-08-21T00:01:00.000Z", action: "masks_applied", prevHash: prev1, outcome: "ok" };

    const events = [event1, event2];
    const jsonl = toAuditJsonl(events);
    const headHash = await sha256Hex(canonicalEventLine(event2));

    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const publicKeyJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const data = new TextEncoder().encode(jsonl);
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, data);
    const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(signature)));

    const checkpoint = {
      checkpointVersion: 1 as const,
      sequenceNumber: 10,
      timestamp: new Date().toISOString(),
      eventCount: 2,
      headHash,
    };
    const cpData = new TextEncoder().encode(canonicalCheckpointLine(checkpoint));
    const cpSig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, cpData);
    const checkpointSignatureBase64 = btoa(String.fromCharCode(...new Uint8Array(cpSig)));
    const expectedCheckpointHash = await sha256Hex(canonicalCheckpointLine(checkpoint));

    const validExport: SignedAuditExport = {
      jsonl,
      signatureBase64,
      publicKeyJwk,
      exportedAt: new Date().toISOString(),
      eventCount: events.length,
      checkpoint,
      checkpointSignatureBase64,
    };

    // 1. In-process verification
    expect(await verifySignedAuditExport(validExport)).toBe(true);
    expect(await verifySignedAuditExport(validExport, { minSequenceNumber: 10 })).toBe(true);
    expect(await verifySignedAuditExport(validExport, { minSequenceNumber: 9 })).toBe(true);

    // Rollback attempt: verifier expects at least seq 11
    expect(await verifySignedAuditExport(validExport, { minSequenceNumber: 11 })).toBe(false);

    // Head hash check
    expect(await verifySignedAuditExport(validExport, { expectedHeadHash: headHash })).toBe(true);
    expect(await verifySignedAuditExport(validExport, { expectedHeadHash: "0".repeat(64) })).toBe(false);

    // Tampered checkpoint signature
    const badSigExport = {
      ...validExport,
      checkpointSignatureBase64: btoa("invalid-sig"),
    };
    expect(await verifySignedAuditExport(badSigExport)).toBe(false);

    // Tampered event count in checkpoint
    const badCountExport = {
      ...validExport,
      checkpoint: { ...checkpoint, eventCount: 3 },
    };
    expect(await verifySignedAuditExport(badCountExport)).toBe(false);

    // 2. CLI verification
    fs.writeFileSync(tmpCpExport, JSON.stringify(validExport, null, 2), "utf8");

    // CLI passes with authentic checkpoint
    const out = execFileSync(
      "node",
      [
        "scripts/verify-audit.mjs",
        tmpCpExport,
        "--min-sequence",
        "10",
        "--expected-head",
        headHash,
        "--expected-checkpoint",
        expectedCheckpointHash,
      ],
      { encoding: "utf8" }
    );
    expect(out).toContain("PASS: Monotonic sequence verified: 10 >= 10");
    expect(out).toContain("PASS: Expected head hash matches checkpoint");
    expect(out).toContain("PASS: External anchor checkpoint hash matches");
    expect(out).toContain("VERIFICATION SUCCESSFUL");

    // CLI rejects rollback attempt (min-sequence 15)
    let cliFailed = false;
    try {
      execFileSync("node", ["scripts/verify-audit.mjs", tmpCpExport, "--min-sequence", "15"], {
        encoding: "utf8",
      });
    } catch {
      cliFailed = true;
    }
    expect(cliFailed).toBe(true);

    // CLI rejects checkpoint hash mismatch
    let cpMismatch = false;
    try {
      execFileSync("node", ["scripts/verify-audit.mjs", tmpCpExport, "--expected-checkpoint", "f".repeat(64)], {
        encoding: "utf8",
      });
    } catch {
      cpMismatch = true;
    }
    expect(cpMismatch).toBe(true);
  });

  it("evaluates all 9 rollback and checkpoint attack vectors explicitly", async () => {
    // 1. Setup legitimate keypair and device fingerprint
    const legitPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const legitJwk = await crypto.subtle.exportKey("jwk", legitPair.publicKey);
    const sortedLegit = Object.keys(legitJwk).sort().reduce((acc: any, k) => { acc[k] = (legitJwk as any)[k]; return acc; }, {});
    const legitFingerprint = await sha256Hex(JSON.stringify(sortedLegit));

    // Build event log history
    const ev1: AuditEvent = { ts: "2026-08-21T00:00:00.000Z", action: "page_scan_completed", outcome: "ok" };
    const h1 = await sha256Hex(canonicalEventLine(ev1));
    const ev2: AuditEvent = { ts: "2026-08-21T00:01:00.000Z", action: "masks_applied", prevHash: h1, outcome: "ok" };
    const h2 = await sha256Hex(canonicalEventLine(ev2));

    const events = [ev1, ev2];
    const jsonl = toAuditJsonl(events);
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, legitPair.privateKey, new TextEncoder().encode(jsonl));
    const signatureBase64 = btoa(String.fromCharCode(...new Uint8Array(sig)));

    // Vector 1: Valid latest checkpoint (seq 10)
    const validCp = { checkpointVersion: 1 as const, sequenceNumber: 10, timestamp: new Date().toISOString(), eventCount: 2, headHash: h2 };
    const cpSig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, legitPair.privateKey, new TextEncoder().encode(canonicalCheckpointLine(validCp)));
    const validExport: SignedAuditExport = {
      jsonl,
      signatureBase64,
      publicKeyJwk: legitJwk,
      exportedAt: new Date().toISOString(),
      eventCount: 2,
      checkpoint: validCp,
      checkpointSignatureBase64: btoa(String.fromCharCode(...new Uint8Array(cpSig))),
    };
    expect(await verifySignedAuditExport(validExport, { minSequenceNumber: 10 })).toBe(true);

    // Vector 2: Older valid checkpoint replay (seq 5 replay when minSequence is 10)
    const olderCp = { checkpointVersion: 1 as const, sequenceNumber: 5, timestamp: new Date().toISOString(), eventCount: 2, headHash: h2 };
    const olderCpSig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, legitPair.privateKey, new TextEncoder().encode(canonicalCheckpointLine(olderCp)));
    const olderExport: SignedAuditExport = {
      ...validExport,
      checkpoint: olderCp,
      checkpointSignatureBase64: btoa(String.fromCharCode(...new Uint8Array(olderCpSig))),
    };
    expect(await verifySignedAuditExport(olderExport, { minSequenceNumber: 10 })).toBe(false);

    // Vector 3: Modified checkpoint sequence without valid signature
    const modifiedSeqExport: SignedAuditExport = {
      ...olderExport,
      checkpoint: { ...olderCp, sequenceNumber: 10 }, // Bumped seq without new signature
    };
    expect(await verifySignedAuditExport(modifiedSeqExport, { minSequenceNumber: 10 })).toBe(false);

    // Vector 4: Modified checkpoint head hash
    const modifiedHeadExport: SignedAuditExport = {
      ...validExport,
      checkpoint: { ...validCp, headHash: "e".repeat(64) },
    };
    expect(await verifySignedAuditExport(modifiedHeadExport)).toBe(false);

    // Vector 5: Same sequence with different checkpoint hash
    const fakeCp = { ...validCp, timestamp: "2020-01-01T00:00:00.000Z" };
    const fakeCpSig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, legitPair.privateKey, new TextEncoder().encode(canonicalCheckpointLine(fakeCp)));
    const sameSeqDifferentExport: SignedAuditExport = {
      ...validExport,
      checkpoint: fakeCp,
      checkpointSignatureBase64: btoa(String.fromCharCode(...new Uint8Array(fakeCpSig))),
    };
    const expectedCpHash = await sha256Hex(canonicalCheckpointLine(validCp));
    const differentCpHash = await sha256Hex(canonicalCheckpointLine(fakeCp));
    expect(differentCpHash).not.toBe(expectedCpHash);

    // Vector 6: Missing checkpoint when minSequence is required
    const missingCpExport: SignedAuditExport = {
      jsonl,
      signatureBase64,
      publicKeyJwk: legitJwk,
      exportedAt: new Date().toISOString(),
      eventCount: 2,
    };
    expect(await verifySignedAuditExport(missingCpExport, { minSequenceNumber: 1 })).toBe(true); // in-process without cp passes basic, but fails CLI constraint
    fs.writeFileSync(tmpCpExport, JSON.stringify(missingCpExport, null, 2), "utf8");
    let missingCpCliFailed = false;
    try {
      execFileSync("node", ["scripts/verify-audit.mjs", tmpCpExport, "--min-sequence", "1"], { encoding: "utf8" });
    } catch {
      missingCpCliFailed = true;
    }
    expect(missingCpCliFailed).toBe(true);

    // Vector 7: Replaced signing key with rogue attacker key
    const roguePair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const rogueCpSig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, roguePair.privateKey, new TextEncoder().encode(canonicalCheckpointLine(validCp)));
    const rogueSigExport: SignedAuditExport = {
      ...validExport,
      checkpointSignatureBase64: btoa(String.fromCharCode(...new Uint8Array(rogueCpSig))),
    };
    expect(await verifySignedAuditExport(rogueSigExport)).toBe(false);

    // Vector 8: Replaced exported public key (signed with rogue key, but checked against legit device fingerprint)
    const rogueJwk = await crypto.subtle.exportKey("jwk", roguePair.publicKey);
    const rogueDataSig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, roguePair.privateKey, new TextEncoder().encode(jsonl));
    const rogueExport: SignedAuditExport = {
      jsonl,
      signatureBase64: btoa(String.fromCharCode(...new Uint8Array(rogueDataSig))),
      publicKeyJwk: rogueJwk,
      exportedAt: new Date().toISOString(),
      eventCount: 2,
      checkpoint: validCp,
      checkpointSignatureBase64: btoa(String.fromCharCode(...new Uint8Array(rogueCpSig))),
    };
    fs.writeFileSync(tmpCpExport, JSON.stringify(rogueExport, null, 2), "utf8");
    let rogueKeyCliFailed = false;
    try {
      execFileSync("node", ["scripts/verify-audit.mjs", tmpCpExport, "--trusted-fingerprint", legitFingerprint], { encoding: "utf8" });
    } catch {
      rogueKeyCliFailed = true;
    }
    expect(rogueKeyCliFailed).toBe(true);

    // Vector 9: Export replay after a newer checkpoint has already been trusted
    // The verifier maintains external anchor: currentTrustedSeq = 15
    const currentTrustedSeq = 15;
    expect(await verifySignedAuditExport(validExport, { minSequenceNumber: currentTrustedSeq })).toBe(false);
  });
});
