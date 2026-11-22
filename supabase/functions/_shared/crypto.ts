import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALL_ZERO_UUID = "00000000-0000-0000-0000-000000000000";

export function isNonZeroUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    UUID_REGEX.test(value) &&
    value.toLowerCase() !== ALL_ZERO_UUID
  );
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function base64ToBytes(base64: string): Uint8Array | null {
  try {
    const normalized = base64.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export function timingSafeEqualStrings(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.byteLength !== bb.byteLength) {
    return false;
  }
  return timingSafeEqualBytes(ab, bb);
}

export async function sha256Hex(content: string): Promise<string> {
  const data = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(digest));
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return bytesToHex(new Uint8Array(sig));
}

export function randomOpaqueToken(prefix = "gws_", byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return `${prefix}${bytesToBase64Url(bytes)}`;
}

export function generate8DigitCode(): string {
  const max = 100_000_000;
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buf = new Uint32Array(1);
  while (true) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) {
      return (buf[0] % max).toString().padStart(8, "0");
    }
  }
}

export function generateTempPassword(length = 20): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const symbols = "!@#$%^&*-_+=";
  const all = upper + lower + digits + symbols;
  const chars: string[] = [
    pickChar(upper),
    pickChar(lower),
    pickChar(digits),
    pickChar(symbols),
  ];
  while (chars.length < length) {
    chars.push(pickChar(all));
  }
  // Fisher-Yates shuffle with unbiased CSPRNG
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIntBelow(i + 1);
    const tmp = chars[i];
    chars[i] = chars[j];
    chars[j] = tmp;
  }
  return chars.join("");
}

function randomIntBelow(max: number): number {
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buf = new Uint32Array(1);
  while (true) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % max;
  }
}

function pickChar(alphabet: string): string {
  return alphabet[randomIntBelow(alphabet.length)];
}

const PBKDF2_ITERATIONS = 210_000;

export async function hashTempPassword(password: string): Promise<string> {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations: PBKDF2_ITERATIONS,
    },
    keyMaterial,
    256,
  );
  return `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(new Uint8Array(derived))}`;
}

export async function verifyTempPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2_sha256") {
    return false;
  }
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 100_000 || iterations > 1_000_000) {
    return false;
  }
  const salt = base64ToBytes(parts[2]);
  const expected = base64ToBytes(parts[3]);
  if (!salt || !expected || expected.byteLength !== 32) {
    return false;
  }
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: salt as unknown as BufferSource,
      iterations,
    },
    keyMaterial,
    256,
  );
  return timingSafeEqualBytes(new Uint8Array(derived), expected);
}

let cachedVaultPepper: string | null = null;

export async function getPairingPepper(supabaseAdmin: SupabaseClient): Promise<string> {
  const envPepper = Deno.env.get("GW_PAIRING_CODE_PEPPER");
  if (envPepper && envPepper.trim().length >= 32) {
    return envPepper.trim();
  }
  if (cachedVaultPepper) {
    return cachedVaultPepper;
  }
  const { data, error } = await supabaseAdmin.rpc("rpc_get_pairing_pepper");
  if (error || typeof data !== "string" || data.length < 32) {
    throw new Error("Pairing code pepper unavailable");
  }
  cachedVaultPepper = data;
  return data;
}

export async function computePairingCodeHashes(
  pepper: string,
  code: string,
  organisationId?: string,
): Promise<{ lookupHash: string; orgHash?: string }> {
  const lookupHash = await hmacSha256Hex(pepper, `lookup:${code}`);
  if (!organisationId) {
    return { lookupHash };
  }
  const orgHash = await hmacSha256Hex(pepper, `gw-v1:${organisationId}:${code}`);
  return { lookupHash, orgHash };
}

export async function getClientIpHash(req: Request, pepper: string): Promise<string> {
  const xff = req.headers.get("x-forwarded-for");
  const cfIp = req.headers.get("cf-connecting-ip");
  const rawIp = (xff ? xff.split(",")[0] : cfIp ?? "unknown").trim() || "unknown";
  return await hmacSha256Hex(pepper, `ip:${rawIp}`);
}
