-- Migration 2: Core Section 3 schema, internal security tables, partial unique indexes, and FK/RLS covering indexes.

-- 1. Create private internal schema (never exposed via PostgREST).
CREATE SCHEMA IF NOT EXISTS internal;
REVOKE ALL ON SCHEMA internal FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA internal TO service_role;

-- 2. Section 3 core tables.
CREATE TABLE IF NOT EXISTS public.organisations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  created_by_admin_id uuid,
  paid_seat_count integer NOT NULL DEFAULT 0 CHECK (paid_seat_count >= 0),
  default_policy_id uuid,
  policy_seq bigint NOT NULL DEFAULT 1 CHECK (policy_seq >= 1),
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);

CREATE TABLE IF NOT EXISTS public.admin_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  permission_template jsonb,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT admin_groups_org_name_key UNIQUE (organisation_id, name)
);

CREATE TABLE IF NOT EXISTS public.admins (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  organisation_id uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  email text NOT NULL CHECK (char_length(btrim(email)) BETWEEN 3 AND 320),
  username text NOT NULL CHECK (char_length(btrim(username)) BETWEEN 2 AND 100),
  role text NOT NULL CHECK (role IN ('primary', 'granted')),
  granted_by_admin_id uuid REFERENCES public.admins(id) ON DELETE SET NULL,
  permission_set jsonb,
  tier text CHECK (tier IS NULL OR tier IN ('high', 'standard')),
  admin_group_id uuid REFERENCES public.admin_groups(id) ON DELETE SET NULL,
  must_change_password boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  revoked_at timestamptz,
  CONSTRAINT admins_org_username_key UNIQUE (organisation_id, username)
);

CREATE TABLE IF NOT EXISTS public.policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  body jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by_admin_id uuid REFERENCES public.admins(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);

-- Add deferred circular FKs on public.organisations idempotently.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'organisations_created_by_admin_id_fkey'
      AND conrelid = 'public.organisations'::regclass
  ) THEN
    ALTER TABLE public.organisations
      ADD CONSTRAINT organisations_created_by_admin_id_fkey
      FOREIGN KEY (created_by_admin_id)
      REFERENCES public.admins(id)
      ON DELETE SET NULL
      DEFERRABLE INITIALLY DEFERRED;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'organisations_default_policy_id_fkey'
      AND conrelid = 'public.organisations'::regclass
  ) THEN
    ALTER TABLE public.organisations
      ADD CONSTRAINT organisations_default_policy_id_fkey
      FOREIGN KEY (default_policy_id)
      REFERENCES public.policies(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  policy_id uuid REFERENCES public.policies(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT groups_org_name_key UNIQUE (organisation_id, name)
);

CREATE TABLE IF NOT EXISTS public.seats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  group_id uuid REFERENCES public.groups(id) ON DELETE SET NULL,
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'free' CHECK (status IN ('free', 'code_issued', 'paired', 'revoked')),
  installation_id text,
  policy_id uuid REFERENCES public.policies(id) ON DELETE SET NULL,
  unlocked boolean NOT NULL DEFAULT false,
  last_heartbeat_at timestamptz,
  paired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);

CREATE TABLE IF NOT EXISTS public.pairing_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  seat_id uuid NOT NULL REFERENCES public.seats(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  code_lookup_hash text NOT NULL,
  created_by_admin_id uuid REFERENCES public.admins(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  expires_at timestamptz NOT NULL DEFAULT (timezone('utc', now()) + interval '10 minutes'),
  used_at timestamptz,
  revoked_at timestamptz,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0)
);

CREATE TABLE IF NOT EXISTS public.admin_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  email text NOT NULL CHECK (char_length(btrim(email)) BETWEEN 3 AND 320),
  username text NOT NULL CHECK (char_length(btrim(username)) BETWEEN 2 AND 100),
  temp_password_hash text NOT NULL,
  permission_set jsonb NOT NULL DEFAULT '[]'::jsonb,
  tier text NOT NULL CHECK (tier IN ('high', 'standard')),
  admin_group_id uuid REFERENCES public.admin_groups(id) ON DELETE SET NULL,
  created_by_admin_id uuid REFERENCES public.admins(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'active', 'expired', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  expires_at timestamptz NOT NULL DEFAULT (timezone('utc', now()) + interval '72 hours'),
  admin_id uuid REFERENCES public.admins(id) ON DELETE SET NULL,
  CONSTRAINT admin_grants_org_username_key UNIQUE (organisation_id, username)
);

CREATE TABLE IF NOT EXISTS public.audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  admin_id uuid REFERENCES public.admins(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (char_length(btrim(action)) BETWEEN 1 AND 120),
  target_type text NOT NULL CHECK (target_type IN ('seat', 'group', 'policy', 'organisation', 'admin')),
  target_id uuid,
  before jsonb,
  after jsonb,
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT audit_log_actor_check CHECK (admin_id IS NOT NULL OR action LIKE 'system.%')
);

-- Strictly the 10 Section 5 columns on public.heartbeat_state.
CREATE TABLE IF NOT EXISTS public.heartbeat_state (
  seat_id uuid PRIMARY KEY REFERENCES public.seats(id) ON DELETE CASCADE,
  received_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  extension_version text NOT NULL,
  browser_name text NOT NULL,
  browser_version text NOT NULL,
  platform text NOT NULL,
  policy_version integer NOT NULL DEFAULT 0 CHECK (policy_version >= 0),
  policy_status text NOT NULL CHECK (policy_status IN ('compliant', 'out-of-date', 'unmanaged_default', 'error')),
  health_status text NOT NULL CHECK (health_status IN ('healthy', 'active', 'degraded')),
  reported_policy jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- 3. Internal security tables (opaque seat sessions + brute-force rate limits).
CREATE TABLE IF NOT EXISTS internal.seat_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seat_id uuid NOT NULL UNIQUE REFERENCES public.seats(id) ON DELETE CASCADE,
  organisation_id uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  installation_id text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  token_generation integer NOT NULL DEFAULT 1 CHECK (token_generation >= 1),
  created_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  rotated_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (timezone('utc', now()) + interval '30 days'),
  revoked_at timestamptz
);

CREATE TABLE IF NOT EXISTS internal.redemption_rate_limits (
  scope_key text PRIMARY KEY,
  failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  window_started_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  locked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT timezone('utc', now())
);

-- 4. Partial unique indexes & uniqueness invariants.
CREATE UNIQUE INDEX IF NOT EXISTS seats_installation_id_unique_idx
  ON public.seats (installation_id)
  WHERE installation_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS pairing_codes_one_live_per_seat_idx
  ON public.pairing_codes (seat_id)
  WHERE used_at IS NULL AND revoked_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS pairing_codes_live_lookup_hash_idx
  ON public.pairing_codes (code_lookup_hash)
  WHERE used_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS pairing_codes_lookup_history_idx
  ON public.pairing_codes (code_lookup_hash, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS admins_one_active_primary_per_org_idx
  ON public.admins (organisation_id)
  WHERE role = 'primary' AND status = 'active';

-- 5. FK and RLS covering indexes (prevents unindexed_foreign_keys advisor findings).
CREATE INDEX IF NOT EXISTS organisations_created_by_admin_id_idx
  ON public.organisations (created_by_admin_id);

CREATE INDEX IF NOT EXISTS organisations_default_policy_id_idx
  ON public.organisations (default_policy_id);

CREATE INDEX IF NOT EXISTS admins_org_status_idx
  ON public.admins (organisation_id, status);

CREATE INDEX IF NOT EXISTS admins_granted_by_admin_id_idx
  ON public.admins (granted_by_admin_id);

CREATE INDEX IF NOT EXISTS admins_admin_group_id_idx
  ON public.admins (admin_group_id);

CREATE INDEX IF NOT EXISTS policies_organisation_id_idx
  ON public.policies (organisation_id);

CREATE INDEX IF NOT EXISTS policies_updated_by_admin_id_idx
  ON public.policies (updated_by_admin_id);

CREATE INDEX IF NOT EXISTS groups_policy_id_idx
  ON public.groups (policy_id);

CREATE INDEX IF NOT EXISTS seats_org_status_idx
  ON public.seats (organisation_id, status);

CREATE INDEX IF NOT EXISTS seats_group_id_idx
  ON public.seats (group_id);

CREATE INDEX IF NOT EXISTS seats_policy_id_idx
  ON public.seats (policy_id);

CREATE INDEX IF NOT EXISTS pairing_codes_organisation_id_idx
  ON public.pairing_codes (organisation_id);

CREATE INDEX IF NOT EXISTS pairing_codes_created_by_admin_id_idx
  ON public.pairing_codes (created_by_admin_id);

CREATE INDEX IF NOT EXISTS admin_grants_admin_group_id_idx
  ON public.admin_grants (admin_group_id);

CREATE INDEX IF NOT EXISTS admin_grants_created_by_admin_id_idx
  ON public.admin_grants (created_by_admin_id);

CREATE INDEX IF NOT EXISTS admin_grants_admin_id_idx
  ON public.admin_grants (admin_id);

CREATE INDEX IF NOT EXISTS audit_log_org_created_at_idx
  ON public.audit_log (organisation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS audit_log_admin_id_idx
  ON public.audit_log (admin_id);

CREATE INDEX IF NOT EXISTS internal_seat_sessions_org_id_idx
  ON internal.seat_sessions (organisation_id);
