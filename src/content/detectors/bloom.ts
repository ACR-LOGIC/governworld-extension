// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Compact FNV-1a / Murmur-style double-hashing Bloom filter for phrase packs.

export class BloomFilter {
  readonly sizeBits: number;
  readonly hashCount: number;
  readonly bits: Uint8Array;

  constructor(sizeBits: number, hashCount: number, bytes?: Uint8Array) {
    this.sizeBits = Math.max(8, sizeBits);
    this.hashCount = Math.max(1, hashCount);
    const byteLen = Math.ceil(this.sizeBits / 8);
    this.bits = bytes && bytes.length === byteLen ? bytes : new Uint8Array(byteLen);
  }

  static optimalParams(expectedItems: number, fpRate = 0.001): { sizeBits: number; hashCount: number } {
    const n = Math.max(1, expectedItems);
    const p = Math.min(0.1, Math.max(1e-6, fpRate));
    const sizeBits = Math.ceil((-n * Math.log(p)) / (Math.LN2 * Math.LN2));
    const hashCount = Math.max(1, Math.round((sizeBits / n) * Math.LN2));
    return { sizeBits, hashCount };
  }

  private hashes(key: string): [number, number] {
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

  add(key: string): void {
    const [h1, h2] = this.hashes(key);
    for (let i = 0; i < this.hashCount; i++) {
      const bit = ((h1 + Math.imul(i, h2)) >>> 0) % this.sizeBits;
      this.bits[bit >>> 3] |= 1 << (bit & 7);
    }
  }

  has(key: string): boolean {
    const [h1, h2] = this.hashes(key);
    for (let i = 0; i < this.hashCount; i++) {
      const bit = ((h1 + Math.imul(i, h2)) >>> 0) % this.sizeBits;
      if ((this.bits[bit >>> 3] & (1 << (bit & 7))) === 0) return false;
    }
    return true;
  }

  toBase64(): string {
    let bin = "";
    // eslint-disable-next-line security/detect-object-injection
    for (let i = 0; i < this.bits.length; i++) bin += String.fromCharCode(this.bits[i]);
    return btoa(bin);
  }

  static fromBase64(b64: string, sizeBits: number, hashCount: number): BloomFilter {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    // eslint-disable-next-line security/detect-object-injection
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new BloomFilter(sizeBits, hashCount, bytes);
  }
}
