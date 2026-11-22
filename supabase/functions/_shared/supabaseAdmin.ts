import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

function resolveSecretKey(): string {
  const secretKeysJson = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretKeysJson) {
    try {
      const parsed = JSON.parse(secretKeysJson) as Record<string, string>;
      if (typeof parsed.default === "string" && parsed.default.length > 0) {
        return parsed.default;
      }
    } catch {
      // Fall through to SUPABASE_SERVICE_ROLE_KEY
    }
  }
  const legacyKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacyKey && legacyKey.length > 0) {
    return legacyKey;
  }
  throw new Error("Missing SUPABASE_SECRET_KEYS / SUPABASE_SERVICE_ROLE_KEY");
}

export function resolvePublishableKeys(): string[] {
  const keys: string[] = [];
  const pubJson = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  if (pubJson) {
    try {
      const parsed = JSON.parse(pubJson) as Record<string, string>;
      for (const v of Object.values(parsed)) {
        if (typeof v === "string" && v.length > 0) keys.push(v);
      }
    } catch {
      // Ignore parse error
    }
  }
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (anon && anon.length > 0 && !keys.includes(anon)) {
    keys.push(anon);
  }
  return keys;
}

export function createSupabaseAdmin(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  if (!url) {
    throw new Error("Missing SUPABASE_URL");
  }
  return createClient(url, resolveSecretKey(), {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

export function createSupabaseAnon(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const keys = resolvePublishableKeys();
  if (!url || keys.length === 0) {
    throw new Error("Missing SUPABASE_URL or publishable key");
  }
  return createClient(url, keys[0], {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
