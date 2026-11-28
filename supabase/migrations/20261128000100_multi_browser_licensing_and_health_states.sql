-- Migration 4: Multi-browser single-seat licensing, dual-state health lifecycle,
-- per-feature "Unlock for User", and fail-closed lapsed-subscription continuity.

-- 1. Extend organisations, seats, pairing_codes, heartbeat_state, and internal.seat_sessions.
ALTER TABLE public.organisations
  ADD COLUMN IF NOT EXISTS subscription_status text NOT NULL DEFAULT 'active'
  CHECK (subscription_status IN ('active', 'past_due', 'lapsed', 'canceled'));

ALTER TABLE public.seats
  ADD COLUMN IF NOT EXISTS user_email_hash text,
  ADD COLUMN IF NOT EXISTS unlocked_features jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.pairing_codes
  ADD COLUMN IF NOT EXISTS target_email_hash text;

ALTER TABLE public.heartbeat_state
  ADD COLUMN IF NOT EXISTS browser_family text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS lifecycle_state text NOT NULL DEFAULT 'online'
    CHECK (lifecycle_state IN ('online', 'offline_clean_shutdown', 'uninstalled_or_terminated')),
  ADD COLUMN IF NOT EXISTS clean_shutdown_flag boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_clean_shutdown_at timestamptz,
  ADD COLUMN IF NOT EXISTS uninstalled_at timestamptz,
  ADD COLUMN IF NOT EXISTS policy_hash text;

ALTER TABLE internal.seat_sessions
  ADD COLUMN IF NOT EXISTS revocation_reason text;

-- 2. Per-browser-family instance table (1 user email = 1 seat; max 1 active instance per browser family).
CREATE TABLE IF NOT EXISTS public.seat_browser_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  seat_id uuid NOT NULL REFERENCES public.seats(id) ON DELETE CASCADE,
  user_email_hash text,
  browser_family text NOT NULL CHECK (browser_family IN ('chrome', 'edge', 'firefox', 'safari', 'brave', 'opera', 'vivaldi', 'chromium', 'unknown')),
  installation_id text NOT NULL,
  device_activation_hash text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'replaced', 'uninstalled')),
  lifecycle_state text NOT NULL DEFAULT 'online' CHECK (lifecycle_state IN ('online', 'offline_clean_shutdown', 'uninstalled_or_terminated')),
  clean_shutdown_flag boolean NOT NULL DEFAULT false,
  last_clean_shutdown_at timestamptz,
  last_heartbeat_at timestamptz,
  uninstalled_at timestamptz,
  paired_at timestamptz NOT NULL DEFAULT timezone('utc', now()),
  replaced_at timestamptz
);

ALTER TABLE public.seat_browser_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seat_browser_instances FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.seat_browser_instances FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.seat_browser_instances TO service_role;
GRANT SELECT ON TABLE public.seat_browser_instances TO authenticated;

DROP POLICY IF EXISTS seat_browser_instances_select_active_admin ON public.seat_browser_instances;
CREATE POLICY seat_browser_instances_select_active_admin
  ON public.seat_browser_instances
  FOR SELECT
  TO authenticated
  USING (organisation_id = (select internal.active_admin_organisation_id()));

-- Enforce strict 1-instance-per-browser-family for a user email inside an org.
CREATE UNIQUE INDEX IF NOT EXISTS seat_browser_instances_one_per_user_browser_idx
  ON public.seat_browser_instances (organisation_id, user_email_hash, browser_family)
  WHERE status = 'active' AND user_email_hash IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS seat_browser_instances_one_per_seat_browser_idx
  ON public.seat_browser_instances (seat_id, browser_family)
  WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS seat_browser_instances_active_install_idx
  ON public.seat_browser_instances (installation_id)
  WHERE status = 'active';

-- 3. Update internal.resolve_effective_policy to expose unlocked_features.
CREATE OR REPLACE FUNCTION internal.resolve_effective_policy(p_seat_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_seat public.seats%ROWTYPE;
  v_org public.organisations%ROWTYPE;
  v_group_policy_id uuid;
  v_effective_policy_id uuid;
  v_policy public.policies%ROWTYPE;
BEGIN
  PERFORM internal.require_service_role();

  SELECT * INTO v_seat FROM public.seats WHERE id = p_seat_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_org FROM public.organisations WHERE id = v_seat.organisation_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_seat.group_id IS NOT NULL THEN
    SELECT g.policy_id INTO v_group_policy_id
    FROM public.groups g
    WHERE g.id = v_seat.group_id
      AND g.organisation_id = v_org.id;
  END IF;

  v_effective_policy_id := COALESCE(v_seat.policy_id, v_group_policy_id, v_org.default_policy_id);

  IF v_effective_policy_id IS NOT NULL THEN
    SELECT * INTO v_policy
    FROM public.policies p
    WHERE p.id = v_effective_policy_id
      AND p.organisation_id = v_org.id;
  END IF;

  RETURN jsonb_build_object(
    'organisation_id', v_org.id,
    'organisation_name', v_org.name,
    'subscription_status', v_org.subscription_status,
    'seat_id', v_seat.id,
    'seat_status', v_seat.status,
    'installation_id', v_seat.installation_id,
    'unlocked', v_seat.unlocked,
    'unlocked_features', COALESCE(v_seat.unlocked_features, '[]'::jsonb),
    'policy_seq', v_org.policy_seq,
    'policy', CASE
      WHEN v_policy.id IS NOT NULL THEN jsonb_build_object(
        'id', v_policy.id,
        'name', v_policy.name,
        'version', v_policy.version,
        'body', v_policy.body,
        'updated_at', v_policy.updated_at
      )
      ELSE NULL
    END
  );
END;
$$;

-- 4. Update generate_pairing_code_atomic to bind optional email hash onto pairing_codes and seat.
DROP FUNCTION IF EXISTS public.rpc_generate_pairing_code(uuid, uuid, text, text, timestamptz);
DROP FUNCTION IF EXISTS internal.generate_pairing_code_atomic(uuid, uuid, text, text, timestamptz);

CREATE OR REPLACE FUNCTION internal.generate_pairing_code_atomic(
  p_admin_id uuid,
  p_seat_id uuid,
  p_code_hash text,
  p_lookup_hash text,
  p_expires_at timestamptz,
  p_target_email_hash text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := timezone('utc', now());
  v_admin public.admins%ROWTYPE;
  v_org public.organisations%ROWTYPE;
  v_seat public.seats%ROWTYPE;
  v_active_count integer;
  v_code_id uuid;
  v_effective_email_hash text;
BEGIN
  PERFORM internal.require_service_role();

  SELECT * INTO v_admin FROM public.admins WHERE id = p_admin_id;
  IF NOT FOUND OR v_admin.status <> 'active' OR v_admin.must_change_password THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'Admin account is not active');
  END IF;

  SELECT * INTO v_org FROM public.organisations WHERE id = v_admin.organisation_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 404, 'error', 'Organisation not found');
  END IF;

  IF NOT internal.admin_has_permission(v_admin, 'code.manage') THEN
    INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, before)
    VALUES (v_org.id, v_admin.id, 'security.refused', 'seat', p_seat_id, jsonb_build_object('attempted_action', 'code.generate'));
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'Missing code.manage permission');
  END IF;

  SELECT * INTO v_seat FROM public.seats WHERE id = p_seat_id AND organisation_id = v_org.id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 404, 'error', 'Seat not found');
  END IF;

  IF v_seat.status = 'revoked' THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 409, 'error', 'Seat is revoked');
  END IF;

  v_effective_email_hash := COALESCE(NULLIF(btrim(p_target_email_hash), ''), v_seat.user_email_hash);

  -- Expire stale unredeemed code on this seat first.
  UPDATE public.pairing_codes
  SET revoked_at = v_now
  WHERE seat_id = v_seat.id
    AND used_at IS NULL
    AND revoked_at IS NULL
    AND expires_at <= v_now;

  IF FOUND AND v_seat.status = 'code_issued' THEN
    UPDATE public.seats SET status = 'free' WHERE id = v_seat.id;
    v_seat.status := 'free';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.pairing_codes pc
    WHERE pc.seat_id = v_seat.id
      AND pc.used_at IS NULL
      AND pc.revoked_at IS NULL
  ) THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 409, 'error', 'Seat already has an active pairing code');
  END IF;

  -- Check paid_seat_count against occupied seats (1 user = 1 seat across browsers).
  SELECT count(*)::integer INTO v_active_count
  FROM public.seats s
  WHERE s.organisation_id = v_org.id
    AND s.id <> v_seat.id
    AND (
      s.status = 'paired'
      OR (
        s.status = 'code_issued'
        AND EXISTS (
          SELECT 1 FROM public.pairing_codes pc
          WHERE pc.seat_id = s.id
            AND pc.used_at IS NULL
            AND pc.revoked_at IS NULL
            AND pc.expires_at > v_now
        )
      )
    );

  IF v_seat.status <> 'paired' AND (v_org.paid_seat_count <= 0 OR v_active_count >= v_org.paid_seat_count) THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'No free paid seats available');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.pairing_codes pc
    WHERE pc.code_lookup_hash = p_lookup_hash
      AND pc.used_at IS NULL
      AND pc.revoked_at IS NULL
  ) THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 409, 'error', 'CODE_COLLISION');
  END IF;

  INSERT INTO public.pairing_codes (
    organisation_id,
    seat_id,
    code_hash,
    code_lookup_hash,
    target_email_hash,
    created_by_admin_id,
    expires_at
  ) VALUES (
    v_org.id,
    v_seat.id,
    p_code_hash,
    p_lookup_hash,
    v_effective_email_hash,
    v_admin.id,
    p_expires_at
  )
  RETURNING id INTO v_code_id;

  IF v_effective_email_hash IS NOT NULL AND v_seat.user_email_hash IS NULL THEN
    UPDATE public.seats SET user_email_hash = v_effective_email_hash WHERE id = v_seat.id;
  END IF;

  IF v_seat.status = 'free' THEN
    UPDATE public.seats SET status = 'code_issued' WHERE id = v_seat.id;
  END IF;

  INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, after)
  VALUES (
    v_org.id,
    v_admin.id,
    'code.generate',
    'seat',
    v_seat.id,
    jsonb_build_object('code_id', v_code_id, 'expires_at', p_expires_at, 'email_bound', v_effective_email_hash IS NOT NULL)
  );

  RETURN jsonb_build_object(
    'ok', true,
    'code_id', v_code_id,
    'seat_id', v_seat.id,
    'organisation_id', v_org.id,
    'organisation_name', v_org.name,
    'expires_at', p_expires_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_generate_pairing_code(
  p_admin_id uuid,
  p_seat_id uuid,
  p_code_hash text,
  p_lookup_hash text,
  p_expires_at timestamptz,
  p_target_email_hash text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM internal.require_service_role();
  RETURN internal.generate_pairing_code_atomic(p_admin_id, p_seat_id, p_code_hash, p_lookup_hash, p_expires_at, p_target_email_hash);
END;
$$;

-- 5. Multi-browser single-seat redemption with duplicate-browser conflict check & pair-lock.
DROP FUNCTION IF EXISTS public.rpc_redeem_pairing_code(text, text, text, text, text, timestamptz);
DROP FUNCTION IF EXISTS internal.redeem_pairing_code_atomic(text, text, text, text, text, timestamptz);

CREATE OR REPLACE FUNCTION internal.redeem_pairing_code_atomic(
  p_lookup_hash text,
  p_code_hash text,
  p_installation_id text,
  p_ip_hash text,
  p_session_token_hash text,
  p_session_expires_at timestamptz,
  p_browser_family text DEFAULT 'unknown',
  p_user_email_hash text DEFAULT NULL,
  p_device_activation_hash text DEFAULT NULL,
  p_confirm_replace boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := timezone('utc', now());
  v_keys text[];
  v_k text;
  v_locked boolean := false;
  v_candidate public.pairing_codes%ROWTYPE;
  v_org public.organisations%ROWTYPE;
  v_seat public.seats%ROWTYPE;
  v_code public.pairing_codes%ROWTYPE;
  v_existing_instance public.seat_browser_instances%ROWTYPE;
  v_effective_email_hash text;
  v_paired_count integer;
  v_new_fails integer;
  v_policy jsonb;
BEGIN
  PERFORM internal.require_service_role();

  SELECT array_agg(k ORDER BY k) INTO v_keys
  FROM unnest(ARRAY['inst:' || p_installation_id, 'ip:' || p_ip_hash]) AS k;

  FOREACH v_k IN ARRAY v_keys LOOP
    INSERT INTO internal.redemption_rate_limits (scope_key, failure_count, window_started_at, updated_at)
    VALUES (v_k, 0, v_now, v_now)
    ON CONFLICT (scope_key) DO NOTHING;
  END LOOP;

  SELECT EXISTS (
    SELECT 1
    FROM internal.redemption_rate_limits rl
    WHERE rl.scope_key = ANY(v_keys)
      AND rl.locked_until IS NOT NULL
      AND rl.locked_until > v_now
    FOR UPDATE
  ) INTO v_locked;

  IF v_locked THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 429, 'error', 'That code could not be accepted');
  END IF;

  SELECT * INTO v_candidate
  FROM public.pairing_codes pc
  WHERE pc.code_lookup_hash = p_lookup_hash
    AND pc.used_at IS NULL
    AND pc.revoked_at IS NULL
  LIMIT 1;

  IF NOT FOUND THEN
    SELECT * INTO v_candidate
    FROM public.pairing_codes pc
    WHERE pc.code_lookup_hash = p_lookup_hash
    ORDER BY pc.created_at DESC
    LIMIT 1;
  END IF;

  IF NOT FOUND THEN
    PERFORM internal.record_redemption_failure_keys(v_keys, v_now);
    RETURN jsonb_build_object('ok', false, 'http_status', 400, 'error', 'That code could not be accepted');
  END IF;

  SELECT * INTO v_org FROM public.organisations WHERE id = v_candidate.organisation_id FOR UPDATE;
  SELECT * INTO v_seat FROM public.seats WHERE id = v_candidate.seat_id FOR UPDATE;
  SELECT * INTO v_code FROM public.pairing_codes WHERE id = v_candidate.id FOR UPDATE;

  IF NOT FOUND THEN
    PERFORM internal.record_redemption_failure_keys(v_keys, v_now);
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'That code could not be accepted');
  END IF;

  IF v_code.code_hash IS DISTINCT FROM p_code_hash THEN
    v_new_fails := v_code.failed_attempts + 1;
    UPDATE public.pairing_codes
    SET failed_attempts = v_new_fails,
        revoked_at = CASE WHEN v_new_fails >= 5 AND revoked_at IS NULL THEN v_now ELSE revoked_at END
    WHERE id = v_code.id;

    IF v_new_fails >= 5 AND v_seat.status = 'code_issued' THEN
      UPDATE public.seats SET status = 'free' WHERE id = v_seat.id;
    END IF;

    PERFORM internal.record_redemption_failure_keys(v_keys, v_now);
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'That code could not be accepted');
  END IF;

  IF v_code.used_at IS NOT NULL THEN
    UPDATE public.pairing_codes SET failed_attempts = failed_attempts + 1 WHERE id = v_code.id;
    INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, after)
    VALUES (v_org.id, NULL, 'system.code_redeem_replay', 'seat', v_seat.id, jsonb_build_object('code_id', v_code.id));
    PERFORM internal.record_redemption_failure_keys(v_keys, v_now);
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'That code could not be accepted');
  END IF;

  IF v_code.revoked_at IS NOT NULL
     OR v_code.expires_at <= v_now
     OR v_code.failed_attempts >= 5
     OR v_seat.status = 'revoked' THEN
    v_new_fails := v_code.failed_attempts + 1;
    UPDATE public.pairing_codes
    SET failed_attempts = v_new_fails,
        revoked_at = CASE WHEN v_new_fails >= 5 AND revoked_at IS NULL THEN v_now ELSE revoked_at END
    WHERE id = v_code.id;

    IF v_new_fails >= 5 AND v_seat.status = 'code_issued' THEN
      UPDATE public.seats SET status = 'free' WHERE id = v_seat.id;
    END IF;

    INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, after)
    VALUES (v_org.id, NULL, 'system.code_redeem_rejected', 'seat', v_seat.id, jsonb_build_object('code_id', v_code.id));
    PERFORM internal.record_redemption_failure_keys(v_keys, v_now);
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'That code could not be accepted');
  END IF;

  -- Check email-bound token match when token carries target_email_hash.
  v_effective_email_hash := COALESCE(NULLIF(btrim(p_user_email_hash), ''), v_code.target_email_hash, v_seat.user_email_hash);
  IF v_code.target_email_hash IS NOT NULL AND NULLIF(btrim(p_user_email_hash), '') IS NOT NULL
     AND v_code.target_email_hash IS DISTINCT FROM btrim(p_user_email_hash) THEN
    PERFORM internal.record_redemption_failure_keys(v_keys, v_now);
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'That code could not be accepted');
  END IF;

  -- Duplicate-browser conflict check (1 active instance per browser family per user email/seat).
  SELECT * INTO v_existing_instance
  FROM public.seat_browser_instances sbi
  WHERE sbi.organisation_id = v_org.id
    AND sbi.status = 'active'
    AND sbi.browser_family = COALESCE(NULLIF(btrim(p_browser_family), ''), 'unknown')
    AND sbi.installation_id <> p_installation_id
    AND (
      (v_effective_email_hash IS NOT NULL AND sbi.user_email_hash = v_effective_email_hash)
      OR sbi.seat_id = v_seat.id
    )
  LIMIT 1
  FOR UPDATE;

  IF FOUND AND NOT COALESCE(p_confirm_replace, false) THEN
    -- Return 409 conflict without burning code or disturbing existing instance.
    RETURN jsonb_build_object(
      'ok', false,
      'http_status', 409,
      'code', 'DUPLICATE_BROWSER_CONFLICT',
      'browser_family', v_existing_instance.browser_family,
      'existing_instance_id', v_existing_instance.installation_id,
      'error', 'Duplicate active browser extension requires user confirmation to replace.'
    );
  END IF;

  IF FOUND AND COALESCE(p_confirm_replace, false) THEN
    UPDATE public.seat_browser_instances
    SET status = 'replaced',
        replaced_at = v_now
    WHERE id = v_existing_instance.id;

    UPDATE internal.seat_sessions
    SET revoked_at = v_now,
        revocation_reason = 'replaced_by_repairing'
    WHERE seat_id = v_existing_instance.seat_id
      AND installation_id = v_existing_instance.installation_id
      AND revoked_at IS NULL;

    INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, after)
    VALUES (
      v_org.id,
      NULL,
      'system.browser_instance_replaced',
      'seat',
      v_seat.id,
      jsonb_build_object('browser_family', p_browser_family, 'replaced_installation_id', v_existing_instance.installation_id)
    );
  END IF;

  SELECT count(*)::integer INTO v_paired_count
  FROM public.seats s
  WHERE s.organisation_id = v_org.id
    AND s.id <> v_seat.id
    AND s.status = 'paired';

  IF v_seat.status <> 'paired' AND (v_org.paid_seat_count <= 0 OR v_paired_count >= v_org.paid_seat_count) THEN
    PERFORM internal.record_redemption_failure_keys(v_keys, v_now);
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'That code could not be accepted');
  END IF;

  UPDATE public.pairing_codes
  SET used_at = v_now
  WHERE id = v_code.id;

  -- Pair-lock immediately upon pairing confirmation (unlocked = false, unlocked_features = []).
  UPDATE public.seats
  SET status = 'paired',
      installation_id = p_installation_id,
      user_email_hash = COALESCE(v_effective_email_hash, user_email_hash),
      unlocked = false,
      unlocked_features = '[]'::jsonb,
      paired_at = COALESCE(paired_at, v_now)
  WHERE id = v_seat.id;

  INSERT INTO public.seat_browser_instances (
    organisation_id,
    seat_id,
    user_email_hash,
    browser_family,
    installation_id,
    device_activation_hash,
    status,
    lifecycle_state,
    paired_at
  ) VALUES (
    v_org.id,
    v_seat.id,
    v_effective_email_hash,
    COALESCE(NULLIF(btrim(p_browser_family), ''), 'unknown'),
    p_installation_id,
    p_device_activation_hash,
    'active',
    'online',
    v_now
  );

  INSERT INTO internal.seat_sessions (
    seat_id,
    organisation_id,
    installation_id,
    token_hash,
    token_generation,
    created_at,
    rotated_at,
    expires_at,
    revoked_at,
    revocation_reason
  ) VALUES (
    v_seat.id,
    v_org.id,
    p_installation_id,
    p_session_token_hash,
    1,
    v_now,
    NULL,
    p_session_expires_at,
    NULL,
    NULL
  )
  ON CONFLICT (seat_id) DO UPDATE SET
    organisation_id = EXCLUDED.organisation_id,
    installation_id = EXCLUDED.installation_id,
    token_hash = EXCLUDED.token_hash,
    token_generation = internal.seat_sessions.token_generation + 1,
    rotated_at = NULL,
    expires_at = EXCLUDED.expires_at,
    revoked_at = NULL,
    revocation_reason = NULL;

  DELETE FROM internal.redemption_rate_limits WHERE scope_key = 'inst:' || p_installation_id;

  INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, after)
  VALUES (
    v_org.id,
    NULL,
    'system.seat_paired',
    'seat',
    v_seat.id,
    jsonb_build_object('installation_id', p_installation_id, 'browser_family', p_browser_family)
  );

  v_policy := internal.resolve_effective_policy(v_seat.id);

  RETURN jsonb_build_object(
    'ok', true,
    'organisation_id', v_org.id,
    'organisation_name', v_org.name,
    'seat_id', v_seat.id,
    'unlocked', false,
    'unlocked_features', '[]'::jsonb,
    'browser_family', COALESCE(NULLIF(btrim(p_browser_family), ''), 'unknown'),
    'session_expires_at', p_session_expires_at,
    'policy_seq', v_org.policy_seq,
    'policy', v_policy -> 'policy'
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_redeem_pairing_code(
  p_lookup_hash text,
  p_code_hash text,
  p_installation_id text,
  p_ip_hash text,
  p_session_token_hash text,
  p_session_expires_at timestamptz,
  p_browser_family text DEFAULT 'unknown',
  p_user_email_hash text DEFAULT NULL,
  p_device_activation_hash text DEFAULT NULL,
  p_confirm_replace boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM internal.require_service_role();
  RETURN internal.redeem_pairing_code_atomic(
    p_lookup_hash,
    p_code_hash,
    p_installation_id,
    p_ip_hash,
    p_session_token_hash,
    p_session_expires_at,
    p_browser_family,
    p_user_email_hash,
    p_device_activation_hash,
    p_confirm_replace
  );
END;
$$;

-- 6. Update heartbeat ingestion to support dual-state lifecycle + lapsed subscription continuity.
DROP FUNCTION IF EXISTS public.rpc_ingest_heartbeat(text, text, uuid, uuid, text, text, text, text, integer, text, text, jsonb);
DROP FUNCTION IF EXISTS internal.ingest_heartbeat_atomic(text, text, uuid, uuid, text, text, text, text, integer, text, text, jsonb);

CREATE OR REPLACE FUNCTION internal.ingest_heartbeat_atomic(
  p_token_hash text,
  p_installation_id text,
  p_seat_id uuid,
  p_organisation_id uuid,
  p_extension_version text,
  p_browser_name text,
  p_browser_version text,
  p_platform text,
  p_policy_version integer,
  p_policy_status text,
  p_health_status text,
  p_reported_policy jsonb,
  p_browser_family text DEFAULT 'unknown',
  p_lifecycle_state text DEFAULT 'online',
  p_clean_shutdown_flag boolean DEFAULT false,
  p_last_clean_shutdown_at timestamptz DEFAULT NULL,
  p_policy_hash text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := timezone('utc', now());
  v_session jsonb;
  v_org_status text;
  v_revocation_reason text;
BEGIN
  PERFORM internal.require_service_role();

  SELECT ss.revocation_reason INTO v_revocation_reason
  FROM internal.seat_sessions ss
  WHERE ss.token_hash = p_token_hash
  LIMIT 1;

  IF v_revocation_reason = 'replaced_by_repairing' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'http_status', 410,
      'status', 'replaced_by_repairing',
      'error', 'This browser instance was replaced by a newer pairing.'
    );
  END IF;

  v_session := internal.verify_seat_session(p_token_hash, p_installation_id);
  IF NOT COALESCE((v_session ->> 'ok')::boolean, false) THEN
    RETURN v_session;
  END IF;

  IF (v_session ->> 'seat_id')::uuid <> p_seat_id
     OR (v_session ->> 'organisation_id')::uuid <> p_organisation_id THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'Heartbeat identity mismatch');
  END IF;

  SELECT o.subscription_status INTO v_org_status
  FROM public.organisations o
  WHERE o.id = p_organisation_id;

  IF v_org_status IN ('lapsed', 'canceled') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'http_status', 402,
      'status', 'subscription_lapsed',
      'fail_closed_continuity', true,
      'error', 'Subscription lapsed; cease cloud sync and preserve local enforcement locks.'
    );
  END IF;

  INSERT INTO public.heartbeat_state (
    seat_id,
    received_at,
    extension_version,
    browser_name,
    browser_version,
    platform,
    policy_version,
    policy_status,
    health_status,
    reported_policy,
    browser_family,
    lifecycle_state,
    clean_shutdown_flag,
    last_clean_shutdown_at,
    policy_hash
  ) VALUES (
    p_seat_id,
    v_now,
    p_extension_version,
    p_browser_name,
    p_browser_version,
    p_platform,
    p_policy_version,
    p_policy_status,
    p_health_status,
    COALESCE(p_reported_policy, '{}'::jsonb),
    COALESCE(NULLIF(btrim(p_browser_family), ''), 'unknown'),
    COALESCE(NULLIF(btrim(p_lifecycle_state), ''), 'online'),
    COALESCE(p_clean_shutdown_flag, false),
    p_last_clean_shutdown_at,
    p_policy_hash
  )
  ON CONFLICT (seat_id) DO UPDATE SET
    received_at = EXCLUDED.received_at,
    extension_version = EXCLUDED.extension_version,
    browser_name = EXCLUDED.browser_name,
    browser_version = EXCLUDED.browser_version,
    platform = EXCLUDED.platform,
    policy_version = EXCLUDED.policy_version,
    policy_status = EXCLUDED.policy_status,
    health_status = EXCLUDED.health_status,
    reported_policy = EXCLUDED.reported_policy,
    browser_family = EXCLUDED.browser_family,
    lifecycle_state = EXCLUDED.lifecycle_state,
    clean_shutdown_flag = EXCLUDED.clean_shutdown_flag,
    last_clean_shutdown_at = COALESCE(EXCLUDED.last_clean_shutdown_at, public.heartbeat_state.last_clean_shutdown_at),
    policy_hash = COALESCE(EXCLUDED.policy_hash, public.heartbeat_state.policy_hash);

  UPDATE public.seats
  SET last_heartbeat_at = v_now
  WHERE id = p_seat_id;

  UPDATE public.seat_browser_instances
  SET lifecycle_state = COALESCE(NULLIF(btrim(p_lifecycle_state), ''), 'online'),
      clean_shutdown_flag = COALESCE(p_clean_shutdown_flag, false),
      last_clean_shutdown_at = COALESCE(p_last_clean_shutdown_at, last_clean_shutdown_at),
      last_heartbeat_at = v_now
  WHERE seat_id = p_seat_id
    AND installation_id = p_installation_id
    AND status = 'active';

  RETURN jsonb_build_object(
    'ok', true,
    'received_at', v_now,
    'lifecycle_state', COALESCE(NULLIF(btrim(p_lifecycle_state), ''), 'online'),
    'unlocked', (v_session ->> 'unlocked')::boolean,
    'policy_version', (v_session ->> 'policy_seq')::bigint
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_ingest_heartbeat(
  p_token_hash text,
  p_installation_id text,
  p_seat_id uuid,
  p_organisation_id uuid,
  p_extension_version text,
  p_browser_name text,
  p_browser_version text,
  p_platform text,
  p_policy_version integer,
  p_policy_status text,
  p_health_status text,
  p_reported_policy jsonb,
  p_browser_family text DEFAULT 'unknown',
  p_lifecycle_state text DEFAULT 'online',
  p_clean_shutdown_flag boolean DEFAULT false,
  p_last_clean_shutdown_at timestamptz DEFAULT NULL,
  p_policy_hash text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM internal.require_service_role();
  RETURN internal.ingest_heartbeat_atomic(
    p_token_hash,
    p_installation_id,
    p_seat_id,
    p_organisation_id,
    p_extension_version,
    p_browser_name,
    p_browser_version,
    p_platform,
    p_policy_version,
    p_policy_status,
    p_health_status,
    p_reported_policy,
    p_browser_family,
    p_lifecycle_state,
    p_clean_shutdown_flag,
    p_last_clean_shutdown_at,
    p_policy_hash
  );
END;
$$;

-- 7. Uninstall hook signal RPC + per-feature "Unlock for User" + subscription status RPCs.
CREATE OR REPLACE FUNCTION public.rpc_record_uninstall_signal(
  p_organisation_id uuid,
  p_installation_id text,
  p_browser_family text,
  p_activation_prefix text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := timezone('utc', now());
  v_instance public.seat_browser_instances%ROWTYPE;
BEGIN
  PERFORM internal.require_service_role();

  SELECT * INTO v_instance
  FROM public.seat_browser_instances sbi
  WHERE sbi.organisation_id = p_organisation_id
    AND sbi.installation_id = p_installation_id
    AND sbi.browser_family = p_browser_family
    AND sbi.status = 'active'
    AND (
      p_activation_prefix IS NULL
      OR sbi.device_activation_hash IS NULL
      OR left(sbi.device_activation_hash, 16) = p_activation_prefix
    )
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 404, 'error', 'Active instance not found');
  END IF;

  UPDATE public.seat_browser_instances
  SET status = 'uninstalled',
      lifecycle_state = 'uninstalled_or_terminated',
      uninstalled_at = v_now
  WHERE id = v_instance.id;

  UPDATE public.heartbeat_state
  SET lifecycle_state = 'uninstalled_or_terminated',
      uninstalled_at = v_now
  WHERE seat_id = v_instance.seat_id;

  INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, after)
  VALUES (
    p_organisation_id,
    NULL,
    'system.extension_uninstalled',
    'seat',
    v_instance.seat_id,
    jsonb_build_object('browser_family', p_browser_family, 'installation_id', p_installation_id, 'uninstalled_at', v_now)
  );

  RETURN jsonb_build_object('ok', true, 'seat_id', v_instance.seat_id, 'lifecycle_state', 'uninstalled_or_terminated');
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_seat_feature_unlock(
  p_admin_id uuid,
  p_seat_id uuid,
  p_feature text,
  p_unlock boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin public.admins%ROWTYPE;
  v_org public.organisations%ROWTYPE;
  v_seat public.seats%ROWTYPE;
  v_features text[];
  v_new_seq bigint;
BEGIN
  PERFORM internal.require_service_role();

  SELECT * INTO v_admin FROM public.admins WHERE id = p_admin_id;
  IF NOT FOUND OR v_admin.status <> 'active' OR v_admin.must_change_password THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'Admin account is not active');
  END IF;

  SELECT * INTO v_org FROM public.organisations WHERE id = v_admin.organisation_id FOR UPDATE;
  IF NOT internal.admin_has_permission(v_admin, 'seat.unlock') THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'Missing seat.unlock permission');
  END IF;

  SELECT * INTO v_seat FROM public.seats WHERE id = p_seat_id AND organisation_id = v_org.id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 404, 'error', 'Seat not found');
  END IF;

  SELECT COALESCE(array_agg(DISTINCT elem), ARRAY[]::text[]) INTO v_features
  FROM jsonb_array_elements_text(COALESCE(v_seat.unlocked_features, '[]'::jsonb)) AS elem;

  IF p_unlock THEN
    IF NOT (p_feature = ANY(v_features)) THEN
      v_features := array_append(v_features, p_feature);
    END IF;
  ELSE
    v_features := array_remove(v_features, p_feature);
  END IF;

  UPDATE public.seats
  SET unlocked_features = to_jsonb(v_features)
  WHERE id = v_seat.id
  RETURNING * INTO v_seat;

  UPDATE public.organisations SET policy_seq = policy_seq + 1 WHERE id = v_org.id RETURNING policy_seq INTO v_new_seq;

  INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, after)
  VALUES (
    v_org.id,
    v_admin.id,
    CASE WHEN p_unlock THEN 'seat.feature_unlocked_for_user' ELSE 'seat.feature_locked' END,
    'seat',
    v_seat.id,
    jsonb_build_object('feature', p_feature, 'unlocked_features', v_seat.unlocked_features, 'policy_seq', v_new_seq)
  );

  RETURN jsonb_build_object('ok', true, 'seat_id', v_seat.id, 'unlocked_features', v_seat.unlocked_features, 'policy_seq', v_new_seq);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_set_org_subscription_status(
  p_admin_id uuid,
  p_status text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin public.admins%ROWTYPE;
  v_org public.organisations%ROWTYPE;
BEGIN
  PERFORM internal.require_service_role();

  IF p_status NOT IN ('active', 'past_due', 'lapsed', 'canceled') THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 400, 'error', 'Invalid subscription_status');
  END IF;

  SELECT * INTO v_admin FROM public.admins WHERE id = p_admin_id;
  IF NOT FOUND OR v_admin.status <> 'active' OR v_admin.must_change_password OR v_admin.role <> 'primary' THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'Primary admin required');
  END IF;

  UPDATE public.organisations
  SET subscription_status = p_status
  WHERE id = v_admin.organisation_id
  RETURNING * INTO v_org;

  INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, after)
  VALUES (v_org.id, v_admin.id, 'organisation.subscription_status', 'organisation', v_org.id, jsonb_build_object('subscription_status', p_status));

  RETURN jsonb_build_object('ok', true, 'organisation_id', v_org.id, 'subscription_status', v_org.subscription_status);
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_record_uninstall_signal(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_record_uninstall_signal(uuid, text, text, text) TO service_role;

REVOKE ALL ON FUNCTION public.rpc_seat_feature_unlock(uuid, uuid, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_seat_feature_unlock(uuid, uuid, text, boolean) TO service_role;

REVOKE ALL ON FUNCTION public.rpc_set_org_subscription_status(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_set_org_subscription_status(uuid, text) TO service_role;
