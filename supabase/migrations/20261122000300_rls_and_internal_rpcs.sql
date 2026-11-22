-- Migration 3: Strict tenant-isolated RLS, Vault pairing pepper, internal SECURITY DEFINER RPCs, and service_role-only wrappers.

-- 1. Enable & force RLS on all 12 tables (10 public + 2 internal).
ALTER TABLE public.organisations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organisations FORCE ROW LEVEL SECURITY;

ALTER TABLE public.admin_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_groups FORCE ROW LEVEL SECURITY;

ALTER TABLE public.admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admins FORCE ROW LEVEL SECURITY;

ALTER TABLE public.policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.policies FORCE ROW LEVEL SECURITY;

ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.groups FORCE ROW LEVEL SECURITY;

ALTER TABLE public.seats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seats FORCE ROW LEVEL SECURITY;

ALTER TABLE public.pairing_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pairing_codes FORCE ROW LEVEL SECURITY;

ALTER TABLE public.admin_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_grants FORCE ROW LEVEL SECURITY;

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log FORCE ROW LEVEL SECURITY;

ALTER TABLE public.heartbeat_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.heartbeat_state FORCE ROW LEVEL SECURITY;

ALTER TABLE internal.seat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE internal.seat_sessions FORCE ROW LEVEL SECURITY;

ALTER TABLE internal.redemption_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE internal.redemption_rate_limits FORCE ROW LEVEL SECURITY;

-- 2. Strict least-privilege table grants.
REVOKE ALL ON TABLE
  public.organisations,
  public.admin_groups,
  public.admins,
  public.policies,
  public.groups,
  public.seats,
  public.pairing_codes,
  public.admin_grants,
  public.audit_log,
  public.heartbeat_state,
  internal.seat_sessions,
  internal.redemption_rate_limits
FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE
  public.organisations,
  public.admin_groups,
  public.admins,
  public.policies,
  public.groups,
  public.seats,
  public.pairing_codes,
  public.admin_grants,
  public.audit_log,
  public.heartbeat_state,
  internal.seat_sessions,
  internal.redemption_rate_limits
TO service_role;

GRANT SELECT ON TABLE
  public.organisations,
  public.admin_groups,
  public.admins,
  public.policies,
  public.groups,
  public.seats,
  public.audit_log,
  public.heartbeat_state
TO authenticated;

-- Exclude temp_password_hash from authenticated SELECT grants on public.admin_grants.
GRANT SELECT (
  id,
  organisation_id,
  email,
  username,
  permission_set,
  tier,
  admin_group_id,
  created_by_admin_id,
  status,
  created_at,
  expires_at,
  admin_id
) ON TABLE public.admin_grants TO authenticated;

-- 3. Initialize server-only Vault secret for pairing_codes HMAC pepper (NEVER private signing keys).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM vault.secrets WHERE name = 'gw_pairing_code_pepper'
  ) THEN
    PERFORM vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'gw_pairing_code_pepper',
      'Server-only HMAC pepper for pairing_codes digests and IP rate-limit hashes'
    );
  END IF;
END $$;

-- 4. RLS Helper functions in internal schema (active admin + must_change_password = false).
CREATE OR REPLACE FUNCTION internal.active_admin_organisation_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT a.organisation_id
  FROM public.admins a
  WHERE a.id = (select auth.uid())
    AND a.status = 'active'
    AND a.must_change_password = false
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION internal.active_admin_has_permission(p_permission text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.admins a
    WHERE a.id = (select auth.uid())
      AND a.status = 'active'
      AND a.must_change_password = false
      AND (
        a.role = 'primary'
        OR (
          a.permission_set IS NOT NULL
          AND jsonb_typeof(a.permission_set) = 'array'
          AND a.permission_set ? p_permission
        )
      )
  );
$$;

GRANT USAGE ON SCHEMA internal TO authenticated;
REVOKE ALL ON FUNCTION internal.active_admin_organisation_id() FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION internal.active_admin_organisation_id() TO authenticated;
REVOKE ALL ON FUNCTION internal.active_admin_has_permission(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION internal.active_admin_has_permission(text) TO authenticated;

-- 5. Disjoint single RLS policies per table.
DROP POLICY IF EXISTS organisations_select_active_admin ON public.organisations;
CREATE POLICY organisations_select_active_admin
  ON public.organisations
  FOR SELECT
  TO authenticated
  USING (id = (select internal.active_admin_organisation_id()));

DROP POLICY IF EXISTS admin_groups_select_active_admin ON public.admin_groups;
CREATE POLICY admin_groups_select_active_admin
  ON public.admin_groups
  FOR SELECT
  TO authenticated
  USING (organisation_id = (select internal.active_admin_organisation_id()));

DROP POLICY IF EXISTS admins_select_self_or_org ON public.admins;
CREATE POLICY admins_select_self_or_org
  ON public.admins
  FOR SELECT
  TO authenticated
  USING (
    id = (select auth.uid())
    OR organisation_id = (select internal.active_admin_organisation_id())
  );

DROP POLICY IF EXISTS policies_select_active_admin ON public.policies;
CREATE POLICY policies_select_active_admin
  ON public.policies
  FOR SELECT
  TO authenticated
  USING (organisation_id = (select internal.active_admin_organisation_id()));

DROP POLICY IF EXISTS groups_select_active_admin ON public.groups;
CREATE POLICY groups_select_active_admin
  ON public.groups
  FOR SELECT
  TO authenticated
  USING (organisation_id = (select internal.active_admin_organisation_id()));

DROP POLICY IF EXISTS seats_select_active_admin ON public.seats;
CREATE POLICY seats_select_active_admin
  ON public.seats
  FOR SELECT
  TO authenticated
  USING (organisation_id = (select internal.active_admin_organisation_id()));

DROP POLICY IF EXISTS heartbeat_state_select_active_admin ON public.heartbeat_state;
CREATE POLICY heartbeat_state_select_active_admin
  ON public.heartbeat_state
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.seats s
      WHERE s.id = heartbeat_state.seat_id
        AND s.organisation_id = (select internal.active_admin_organisation_id())
    )
  );

DROP POLICY IF EXISTS audit_log_select_permitted_admin ON public.audit_log;
CREATE POLICY audit_log_select_permitted_admin
  ON public.audit_log
  FOR SELECT
  TO authenticated
  USING (
    organisation_id = (select internal.active_admin_organisation_id())
    AND (select internal.active_admin_has_permission('audit.read'))
  );

DROP POLICY IF EXISTS admin_grants_select_permitted_admin ON public.admin_grants;
CREATE POLICY admin_grants_select_permitted_admin
  ON public.admin_grants
  FOR SELECT
  TO authenticated
  USING (
    organisation_id = (select internal.active_admin_organisation_id())
    AND (select internal.active_admin_has_permission('admin.grant'))
  );

DROP POLICY IF EXISTS pairing_codes_deny_all_clients ON public.pairing_codes;
CREATE POLICY pairing_codes_deny_all_clients
  ON public.pairing_codes
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS seat_sessions_deny_all_clients ON internal.seat_sessions;
CREATE POLICY seat_sessions_deny_all_clients
  ON internal.seat_sessions
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS redemption_rate_limits_deny_all_clients ON internal.redemption_rate_limits;
CREATE POLICY redemption_rate_limits_deny_all_clients
  ON internal.redemption_rate_limits
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

-- 6. Internal helpers & atomic RPCs.
CREATE OR REPLACE FUNCTION internal.require_service_role()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF current_user NOT IN ('service_role', 'postgres') THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION internal.get_pairing_pepper()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_secret text;
BEGIN
  PERFORM internal.require_service_role();
  SELECT ds.decrypted_secret
  INTO v_secret
  FROM vault.decrypted_secrets ds
  WHERE ds.name = 'gw_pairing_code_pepper'
  LIMIT 1;
  RETURN v_secret;
END;
$$;

CREATE OR REPLACE FUNCTION internal.admin_has_permission(p_admin public.admins, p_permission text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT p_admin.status = 'active'
    AND p_admin.must_change_password = false
    AND (
      p_admin.role = 'primary'
      OR (
        p_admin.permission_set IS NOT NULL
        AND jsonb_typeof(p_admin.permission_set) = 'array'
        AND p_admin.permission_set ? p_permission
      )
    );
$$;

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
    'seat_id', v_seat.id,
    'seat_status', v_seat.status,
    'installation_id', v_seat.installation_id,
    'unlocked', v_seat.unlocked,
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

CREATE OR REPLACE FUNCTION internal.get_admin_context(p_admin_id uuid, p_session_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin public.admins%ROWTYPE;
  v_org_name text;
  v_banned_until timestamptz;
  v_session_ok boolean := true;
BEGIN
  PERFORM internal.require_service_role();

  SELECT u.banned_until INTO v_banned_until
  FROM auth.users u
  WHERE u.id = p_admin_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false, 'reason', 'auth_user_missing');
  END IF;

  IF v_banned_until IS NOT NULL AND v_banned_until > timezone('utc', now()) THEN
    RETURN jsonb_build_object('found', false, 'reason', 'auth_user_banned');
  END IF;

  IF p_session_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM auth.sessions s
      WHERE s.id = p_session_id
        AND s.user_id = p_admin_id
        AND (s.not_after IS NULL OR s.not_after > timezone('utc', now()))
    ) INTO v_session_ok;
    IF NOT v_session_ok THEN
      RETURN jsonb_build_object('found', false, 'reason', 'session_revoked');
    END IF;
  END IF;

  SELECT * INTO v_admin
  FROM public.admins a
  WHERE a.id = p_admin_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false, 'reason', 'not_admin');
  END IF;

  SELECT o.name INTO v_org_name
  FROM public.organisations o
  WHERE o.id = v_admin.organisation_id;

  RETURN jsonb_build_object(
    'found', true,
    'id', v_admin.id,
    'organisation_id', v_admin.organisation_id,
    'organisation_name', v_org_name,
    'email', v_admin.email,
    'username', v_admin.username,
    'role', v_admin.role,
    'permission_set', COALESCE(v_admin.permission_set, '[]'::jsonb),
    'tier', v_admin.tier,
    'admin_group_id', v_admin.admin_group_id,
    'must_change_password', v_admin.must_change_password,
    'status', v_admin.status
  );
END;
$$;

CREATE OR REPLACE FUNCTION internal.verify_seat_session(p_token_hash text, p_installation_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_session internal.seat_sessions%ROWTYPE;
  v_seat public.seats%ROWTYPE;
  v_org public.organisations%ROWTYPE;
BEGIN
  PERFORM internal.require_service_role();

  SELECT * INTO v_session
  FROM internal.seat_sessions ss
  WHERE ss.token_hash = p_token_hash;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 401, 'status', 'invalid', 'error', 'Unauthorized');
  END IF;

  SELECT * INTO v_seat FROM public.seats WHERE id = v_session.seat_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 401, 'status', 'invalid', 'error', 'Unauthorized');
  END IF;

  IF v_session.revoked_at IS NOT NULL OR v_seat.status = 'revoked' THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'status', 'revoked', 'error', 'Seat has been revoked');
  END IF;

  IF v_session.expires_at <= timezone('utc', now()) THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 401, 'status', 'expired', 'error', 'Session expired');
  END IF;

  IF v_seat.status <> 'paired'
     OR v_session.installation_id IS DISTINCT FROM p_installation_id
     OR v_seat.installation_id IS DISTINCT FROM p_installation_id THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 401, 'status', 'invalid', 'error', 'Unauthorized');
  END IF;

  SELECT * INTO v_org FROM public.organisations WHERE id = v_seat.organisation_id;

  RETURN jsonb_build_object(
    'ok', true,
    'seat_id', v_seat.id,
    'organisation_id', v_org.id,
    'organisation_name', v_org.name,
    'installation_id', v_seat.installation_id,
    'unlocked', v_seat.unlocked,
    'policy_seq', v_org.policy_seq,
    'token_generation', v_session.token_generation
  );
END;
$$;

CREATE OR REPLACE FUNCTION internal.find_pairing_code_candidate(p_lookup_hash text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.pairing_codes%ROWTYPE;
BEGIN
  PERFORM internal.require_service_role();

  SELECT * INTO v_row
  FROM public.pairing_codes pc
  WHERE pc.code_lookup_hash = p_lookup_hash
    AND pc.used_at IS NULL
    AND pc.revoked_at IS NULL
  LIMIT 1;

  IF NOT FOUND THEN
    SELECT * INTO v_row
    FROM public.pairing_codes pc
    WHERE pc.code_lookup_hash = p_lookup_hash
    ORDER BY pc.created_at DESC
    LIMIT 1;
  END IF;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  RETURN jsonb_build_object('found', true, 'organisation_id', v_row.organisation_id);
END;
$$;

CREATE OR REPLACE FUNCTION internal.generate_pairing_code_atomic(
  p_admin_id uuid,
  p_seat_id uuid,
  p_code_hash text,
  p_lookup_hash text,
  p_expires_at timestamptz
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
BEGIN
  PERFORM internal.require_service_role();

  SELECT * INTO v_admin FROM public.admins WHERE id = p_admin_id;
  IF NOT FOUND OR v_admin.status <> 'active' OR v_admin.must_change_password THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'Admin account is not active');
  END IF;

  -- Deadlock order: organisations -> seats -> pairing_codes.
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

  IF v_seat.status IN ('paired', 'revoked') THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 409, 'error', 'Seat is not eligible for a pairing code');
  END IF;

  -- Expire any stale unredeemed code on this seat first.
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

  -- Enforce max 1 live code per seat.
  IF EXISTS (
    SELECT 1 FROM public.pairing_codes pc
    WHERE pc.seat_id = v_seat.id
      AND pc.used_at IS NULL
      AND pc.revoked_at IS NULL
  ) THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 409, 'error', 'Seat already has an active pairing code');
  END IF;

  -- Check paid_seat_count against currently occupied (paired or unexpired code_issued) seats.
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

  IF v_org.paid_seat_count <= 0 OR v_active_count >= v_org.paid_seat_count THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'No free paid seats available');
  END IF;

  -- Guard against rare 8-digit live lookup digest collision.
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
    created_by_admin_id,
    expires_at
  ) VALUES (
    v_org.id,
    v_seat.id,
    p_code_hash,
    p_lookup_hash,
    v_admin.id,
    p_expires_at
  )
  RETURNING id INTO v_code_id;

  UPDATE public.seats SET status = 'code_issued' WHERE id = v_seat.id;

  INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, after)
  VALUES (
    v_org.id,
    v_admin.id,
    'code.generate',
    'seat',
    v_seat.id,
    jsonb_build_object('code_id', v_code_id, 'expires_at', p_expires_at)
  );

  RETURN jsonb_build_object(
    'ok', true,
    'code_id', v_code_id,
    'seat_id', v_seat.id,
    'organisation_id', v_org.id,
    'expires_at', p_expires_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION internal.revoke_pairing_code_atomic(
  p_admin_id uuid,
  p_seat_id uuid DEFAULT NULL,
  p_code_id uuid DEFAULT NULL
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
  v_code public.pairing_codes%ROWTYPE;
  v_seat public.seats%ROWTYPE;
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
    VALUES (v_org.id, v_admin.id, 'security.refused', 'seat', p_seat_id, jsonb_build_object('attempted_action', 'code.revoke'));
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'Missing code.manage permission');
  END IF;

  -- Lock seat first if seat_id known, else resolve from code_id then lock in order.
  IF p_seat_id IS NOT NULL THEN
    SELECT * INTO v_seat FROM public.seats WHERE id = p_seat_id AND organisation_id = v_org.id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'http_status', 404, 'error', 'Seat not found');
    END IF;
    SELECT * INTO v_code FROM public.pairing_codes
    WHERE seat_id = v_seat.id AND used_at IS NULL AND revoked_at IS NULL
    FOR UPDATE;
  ELSIF p_code_id IS NOT NULL THEN
    SELECT pc.seat_id INTO p_seat_id FROM public.pairing_codes pc WHERE pc.id = p_code_id AND pc.organisation_id = v_org.id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'http_status', 404, 'error', 'Pairing code not found');
    END IF;
    SELECT * INTO v_seat FROM public.seats WHERE id = p_seat_id FOR UPDATE;
    SELECT * INTO v_code FROM public.pairing_codes WHERE id = p_code_id AND used_at IS NULL AND revoked_at IS NULL FOR UPDATE;
  ELSE
    RETURN jsonb_build_object('ok', false, 'http_status', 400, 'error', 'seat_id or code_id is required');
  END IF;

  IF v_code.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 404, 'error', 'No active pairing code to revoke');
  END IF;

  UPDATE public.pairing_codes SET revoked_at = v_now WHERE id = v_code.id;

  IF v_seat.status = 'code_issued' THEN
    UPDATE public.seats SET status = 'free' WHERE id = v_seat.id;
  END IF;

  INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, after)
  VALUES (v_org.id, v_admin.id, 'code.revoke', 'seat', v_seat.id, jsonb_build_object('code_id', v_code.id));

  RETURN jsonb_build_object('ok', true, 'code_id', v_code.id, 'seat_id', v_seat.id);
END;
$$;

CREATE OR REPLACE FUNCTION internal.record_redemption_failure_keys(p_keys text[], p_now timestamptz)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_key text;
  v_rl internal.redemption_rate_limits%ROWTYPE;
  v_new_count integer;
BEGIN
  FOREACH v_key IN ARRAY p_keys LOOP
    SELECT * INTO v_rl FROM internal.redemption_rate_limits WHERE scope_key = v_key FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO internal.redemption_rate_limits (scope_key, failure_count, window_started_at, locked_until, updated_at)
      VALUES (v_key, 1, p_now, NULL, p_now);
    ELSE
      IF v_rl.window_started_at <= p_now - interval '15 minutes'
         AND (v_rl.locked_until IS NULL OR v_rl.locked_until <= p_now) THEN
        v_new_count := 1;
        UPDATE internal.redemption_rate_limits
        SET failure_count = 1,
            window_started_at = p_now,
            locked_until = NULL,
            updated_at = p_now
        WHERE scope_key = v_key;
      ELSE
        v_new_count := v_rl.failure_count + 1;
        UPDATE internal.redemption_rate_limits
        SET failure_count = v_new_count,
            locked_until = CASE WHEN v_new_count >= 5 THEN p_now + interval '15 minutes' ELSE v_rl.locked_until END,
            updated_at = p_now
        WHERE scope_key = v_key;
      END IF;
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION internal.redeem_pairing_code_atomic(
  p_lookup_hash text,
  p_code_hash text,
  p_installation_id text,
  p_ip_hash text,
  p_session_token_hash text,
  p_session_expires_at timestamptz
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
  v_paired_count integer;
  v_new_fails integer;
  v_policy jsonb;
BEGIN
  PERFORM internal.require_service_role();

  -- 1. Lock rate limits in deterministic sorted order first.
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

  -- 2. Reject if this installation_id is already paired to any seat.
  IF EXISTS (SELECT 1 FROM public.seats s WHERE s.installation_id = p_installation_id) THEN
    PERFORM internal.record_redemption_failure_keys(v_keys, v_now);
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'That code could not be accepted');
  END IF;

  -- 3. Locate candidate pairing_codes row without locking out of order.
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

  -- 4. Lock in strict order: organisations -> seats -> pairing_codes -> internal.seat_sessions.
  SELECT * INTO v_org FROM public.organisations WHERE id = v_candidate.organisation_id FOR UPDATE;
  SELECT * INTO v_seat FROM public.seats WHERE id = v_candidate.seat_id FOR UPDATE;
  SELECT * INTO v_code FROM public.pairing_codes WHERE id = v_candidate.id FOR UPDATE;

  IF NOT FOUND THEN
    PERFORM internal.record_redemption_failure_keys(v_keys, v_now);
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'That code could not be accepted');
  END IF;

  -- Verify org-bound code_hash matches.
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

  -- Replay check (S3/A3).
  IF v_code.used_at IS NOT NULL THEN
    UPDATE public.pairing_codes SET failed_attempts = failed_attempts + 1 WHERE id = v_code.id;
    INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, after)
    VALUES (v_org.id, NULL, 'system.code_redeem_replay', 'seat', v_seat.id, jsonb_build_object('code_id', v_code.id));
    PERFORM internal.record_redemption_failure_keys(v_keys, v_now);
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'That code could not be accepted');
  END IF;

  -- Revoked / expired / burned / seat status / capacity checks.
  IF v_code.revoked_at IS NOT NULL
     OR v_code.expires_at <= v_now
     OR v_code.failed_attempts >= 5
     OR v_seat.status NOT IN ('free', 'code_issued') THEN
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

  SELECT count(*)::integer INTO v_paired_count
  FROM public.seats s
  WHERE s.organisation_id = v_org.id
    AND s.status = 'paired';

  IF v_org.paid_seat_count <= 0 OR v_paired_count >= v_org.paid_seat_count THEN
    v_new_fails := v_code.failed_attempts + 1;
    UPDATE public.pairing_codes
    SET failed_attempts = v_new_fails,
        revoked_at = CASE WHEN v_new_fails >= 5 AND revoked_at IS NULL THEN v_now ELSE revoked_at END
    WHERE id = v_code.id;

    INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, after)
    VALUES (v_org.id, NULL, 'system.code_redeem_rejected', 'seat', v_seat.id, jsonb_build_object('reason', 'no_free_paid_seat'));
    PERFORM internal.record_redemption_failure_keys(v_keys, v_now);
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'That code could not be accepted');
  END IF;

  -- 5. Atomic redemption commit.
  UPDATE public.pairing_codes
  SET used_at = v_now
  WHERE id = v_code.id;

  UPDATE public.seats
  SET status = 'paired',
      installation_id = p_installation_id,
      paired_at = v_now
  WHERE id = v_seat.id;

  INSERT INTO internal.seat_sessions (
    seat_id,
    organisation_id,
    installation_id,
    token_hash,
    token_generation,
    created_at,
    rotated_at,
    expires_at,
    revoked_at
  ) VALUES (
    v_seat.id,
    v_org.id,
    p_installation_id,
    p_session_token_hash,
    1,
    v_now,
    NULL,
    p_session_expires_at,
    NULL
  )
  ON CONFLICT (seat_id) DO UPDATE SET
    organisation_id = EXCLUDED.organisation_id,
    installation_id = EXCLUDED.installation_id,
    token_hash = EXCLUDED.token_hash,
    token_generation = internal.seat_sessions.token_generation + 1,
    rotated_at = NULL,
    expires_at = EXCLUDED.expires_at,
    revoked_at = NULL;

  DELETE FROM internal.redemption_rate_limits WHERE scope_key = 'inst:' || p_installation_id;

  INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, after)
  VALUES (
    v_org.id,
    NULL,
    'system.seat_paired',
    'seat',
    v_seat.id,
    jsonb_build_object('installation_id', p_installation_id)
  );

  v_policy := internal.resolve_effective_policy(v_seat.id);

  RETURN jsonb_build_object(
    'ok', true,
    'organisation_id', v_org.id,
    'organisation_name', v_org.name,
    'seat_id', v_seat.id,
    'unlocked', v_seat.unlocked,
    'session_expires_at', p_session_expires_at,
    'policy_seq', v_org.policy_seq,
    'policy', v_policy -> 'policy'
  );
END;
$$;

CREATE OR REPLACE FUNCTION internal.deliver_policy_for_seat(p_token_hash text, p_installation_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_session jsonb;
  v_resolved jsonb;
BEGIN
  PERFORM internal.require_service_role();

  v_session := internal.verify_seat_session(p_token_hash, p_installation_id);
  IF NOT COALESCE((v_session ->> 'ok')::boolean, false) THEN
    RETURN v_session;
  END IF;

  v_resolved := internal.resolve_effective_policy((v_session ->> 'seat_id')::uuid);
  RETURN jsonb_build_object(
    'ok', true,
    'status', 'active',
    'organisation_id', v_resolved -> 'organisation_id',
    'organisation_name', v_resolved -> 'organisation_name',
    'seat_id', v_resolved -> 'seat_id',
    'installation_id', v_resolved -> 'installation_id',
    'unlocked', v_resolved -> 'unlocked',
    'policy_seq', v_resolved -> 'policy_seq',
    'policy', v_resolved -> 'policy'
  );
END;
$$;

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
  p_reported_policy jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := timezone('utc', now());
  v_session jsonb;
BEGIN
  PERFORM internal.require_service_role();

  v_session := internal.verify_seat_session(p_token_hash, p_installation_id);
  IF NOT COALESCE((v_session ->> 'ok')::boolean, false) THEN
    RETURN v_session;
  END IF;

  IF (v_session ->> 'seat_id')::uuid <> p_seat_id
     OR (v_session ->> 'organisation_id')::uuid <> p_organisation_id THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'Heartbeat identity mismatch');
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
    reported_policy
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
    COALESCE(p_reported_policy, '{}'::jsonb)
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
    reported_policy = EXCLUDED.reported_policy;

  UPDATE public.seats
  SET last_heartbeat_at = v_now
  WHERE id = p_seat_id;

  RETURN jsonb_build_object(
    'ok', true,
    'received_at', v_now,
    'unlocked', (v_session ->> 'unlocked')::boolean,
    'policy_version', (v_session ->> 'policy_seq')::bigint
  );
END;
$$;

CREATE OR REPLACE FUNCTION internal.rotate_seat_session_atomic(
  p_old_token_hash text,
  p_installation_id text,
  p_new_token_hash text,
  p_new_expires_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := timezone('utc', now());
  v_session internal.seat_sessions%ROWTYPE;
  v_seat public.seats%ROWTYPE;
BEGIN
  PERFORM internal.require_service_role();

  SELECT * INTO v_session
  FROM internal.seat_sessions ss
  WHERE ss.token_hash = p_old_token_hash;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 401, 'status', 'invalid', 'error', 'Unauthorized');
  END IF;

  -- Lock in order: seats -> internal.seat_sessions.
  SELECT * INTO v_seat FROM public.seats WHERE id = v_session.seat_id FOR UPDATE;
  SELECT * INTO v_session FROM internal.seat_sessions WHERE id = v_session.id FOR UPDATE;

  IF NOT FOUND OR v_session.token_hash IS DISTINCT FROM p_old_token_hash THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 401, 'status', 'invalid', 'error', 'Unauthorized');
  END IF;

  IF v_session.revoked_at IS NOT NULL OR v_seat.status = 'revoked' THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'status', 'revoked', 'error', 'Seat has been revoked');
  END IF;

  IF v_session.expires_at <= v_now THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 401, 'status', 'expired', 'error', 'Session expired');
  END IF;

  IF v_seat.status <> 'paired'
     OR v_session.installation_id IS DISTINCT FROM p_installation_id
     OR v_seat.installation_id IS DISTINCT FROM p_installation_id THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 401, 'status', 'invalid', 'error', 'Unauthorized');
  END IF;

  -- In-place token_hash overwrite guarantees zero reuse window for old token.
  UPDATE internal.seat_sessions
  SET token_hash = p_new_token_hash,
      token_generation = token_generation + 1,
      rotated_at = v_now,
      expires_at = p_new_expires_at
  WHERE id = v_session.id;

  RETURN jsonb_build_object(
    'ok', true,
    'session_expires_at', p_new_expires_at,
    'token_generation', v_session.token_generation + 1
  );
END;
$$;

CREATE OR REPLACE FUNCTION internal.unpair_seat_atomic(p_token_hash text, p_installation_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_session internal.seat_sessions%ROWTYPE;
  v_seat public.seats%ROWTYPE;
BEGIN
  PERFORM internal.require_service_role();

  SELECT * INTO v_session
  FROM internal.seat_sessions ss
  WHERE ss.token_hash = p_token_hash;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 401, 'status', 'invalid', 'error', 'Unauthorized');
  END IF;

  SELECT * INTO v_seat FROM public.seats WHERE id = v_session.seat_id FOR UPDATE;
  SELECT * INTO v_session FROM internal.seat_sessions WHERE id = v_session.id FOR UPDATE;

  IF v_session.revoked_at IS NOT NULL OR v_seat.status = 'revoked' THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'status', 'revoked', 'error', 'Seat has been revoked');
  END IF;

  IF v_session.expires_at <= timezone('utc', now())
     OR v_seat.status <> 'paired'
     OR v_session.installation_id IS DISTINCT FROM p_installation_id
     OR v_seat.installation_id IS DISTINCT FROM p_installation_id THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 401, 'status', 'invalid', 'error', 'Unauthorized');
  END IF;

  UPDATE public.seats
  SET status = 'free',
      installation_id = NULL,
      paired_at = NULL,
      last_heartbeat_at = NULL,
      unlocked = false
  WHERE id = v_seat.id;

  DELETE FROM internal.seat_sessions WHERE seat_id = v_seat.id;
  DELETE FROM public.heartbeat_state WHERE seat_id = v_seat.id;

  INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, before)
  VALUES (
    v_seat.organisation_id,
    NULL,
    'system.seat_unpaired',
    'seat',
    v_seat.id,
    jsonb_build_object('installation_id', p_installation_id)
  );

  RETURN jsonb_build_object('ok', true, 'status', 'unpaired', 'seat_id', v_seat.id);
END;
$$;

CREATE OR REPLACE FUNCTION internal.create_organisation_atomic(
  p_admin_id uuid,
  p_email text,
  p_username text,
  p_org_name text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_org_id uuid;
BEGIN
  PERFORM internal.require_service_role();

  IF p_org_name IS NULL OR char_length(btrim(p_org_name)) = 0 OR p_username IS NULL OR char_length(btrim(p_username)) < 2 THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 400, 'error', 'Valid organisation name and username are required');
  END IF;

  IF EXISTS (SELECT 1 FROM public.admins a WHERE a.id = p_admin_id) THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 409, 'error', 'User is already assigned to an organisation');
  END IF;

  INSERT INTO public.organisations (name, paid_seat_count)
  VALUES (btrim(p_org_name), 0)
  RETURNING id INTO v_org_id;

  INSERT INTO public.admins (
    id,
    organisation_id,
    email,
    username,
    role,
    permission_set,
    tier,
    must_change_password,
    status
  ) VALUES (
    p_admin_id,
    v_org_id,
    p_email,
    btrim(p_username),
    'primary',
    NULL,
    NULL,
    false,
    'active'
  );

  UPDATE public.organisations
  SET created_by_admin_id = p_admin_id
  WHERE id = v_org_id;

  INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, after)
  VALUES (
    v_org_id,
    p_admin_id,
    'organisation.create',
    'organisation',
    v_org_id,
    jsonb_build_object('name', btrim(p_org_name), 'paid_seat_count', 0)
  );

  RETURN jsonb_build_object(
    'ok', true,
    'organisation_id', v_org_id,
    'name', btrim(p_org_name),
    'paid_seat_count', 0
  );
END;
$$;

CREATE OR REPLACE FUNCTION internal.delete_organisation_atomic(
  p_admin_id uuid,
  p_organisation_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin public.admins%ROWTYPE;
BEGIN
  PERFORM internal.require_service_role();

  SELECT * INTO v_admin FROM public.admins WHERE id = p_admin_id;
  IF NOT FOUND OR v_admin.status <> 'active' OR v_admin.must_change_password THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'Admin account is not active');
  END IF;

  IF v_admin.organisation_id <> p_organisation_id THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'Forbidden');
  END IF;

  IF v_admin.role <> 'primary' THEN
    INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, before)
    VALUES (
      v_admin.organisation_id,
      v_admin.id,
      'security.refused',
      'organisation',
      p_organisation_id,
      jsonb_build_object('attempted_action', 'organisation.delete')
    );
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'Only primary admin can delete organisation');
  END IF;

  DELETE FROM public.organisations WHERE id = p_organisation_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 404, 'error', 'Organisation not found');
  END IF;

  RETURN jsonb_build_object('ok', true, 'deleted_organisation_id', p_organisation_id);
END;
$$;

CREATE OR REPLACE FUNCTION internal.policy_ops_atomic(
  p_admin_id uuid,
  p_op text,
  p_policy_id uuid DEFAULT NULL,
  p_name text DEFAULT NULL,
  p_body jsonb DEFAULT NULL,
  p_target_type text DEFAULT NULL,
  p_target_id uuid DEFAULT NULL
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
  v_policy public.policies%ROWTYPE;
  v_before jsonb;
  v_new_id uuid;
  v_new_seq bigint;
  v_group public.groups%ROWTYPE;
  v_seat public.seats%ROWTYPE;
BEGIN
  PERFORM internal.require_service_role();

  SELECT * INTO v_admin FROM public.admins WHERE id = p_admin_id;
  IF NOT FOUND OR v_admin.status <> 'active' OR v_admin.must_change_password THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'Admin account is not active');
  END IF;

  SELECT * INTO v_org FROM public.organisations WHERE id = v_admin.organisation_id FOR UPDATE;

  IF NOT internal.admin_has_permission(v_admin, 'policy.write') THEN
    INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, before)
    VALUES (v_org.id, v_admin.id, 'security.refused', 'policy', p_policy_id, jsonb_build_object('attempted_action', 'policy.' || p_op));
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'Missing policy.write permission');
  END IF;

  IF p_op = 'create' THEN
    IF p_name IS NULL OR char_length(btrim(p_name)) = 0 THEN
      RETURN jsonb_build_object('ok', false, 'http_status', 400, 'error', 'Policy name is required');
    END IF;
    INSERT INTO public.policies (organisation_id, name, version, body, updated_by_admin_id, updated_at)
    VALUES (v_org.id, btrim(p_name), 1, COALESCE(p_body, '{}'::jsonb), v_admin.id, v_now)
    RETURNING * INTO v_policy;

    INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, after)
    VALUES (v_org.id, v_admin.id, 'policy.create', 'policy', v_policy.id, jsonb_build_object('name', v_policy.name, 'version', v_policy.version));

    RETURN jsonb_build_object('ok', true, 'policy', to_jsonb(v_policy));

  ELSIF p_op = 'update' THEN
    SELECT * INTO v_policy FROM public.policies WHERE id = p_policy_id AND organisation_id = v_org.id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'http_status', 404, 'error', 'Policy not found');
    END IF;
    v_before := jsonb_build_object('name', v_policy.name, 'version', v_policy.version, 'body', v_policy.body);

    UPDATE public.policies
    SET name = COALESCE(NULLIF(btrim(p_name), ''), name),
        body = COALESCE(p_body, body),
        version = version + 1,
        updated_by_admin_id = v_admin.id,
        updated_at = v_now
    WHERE id = v_policy.id
    RETURNING * INTO v_policy;

    UPDATE public.organisations
    SET policy_seq = policy_seq + 1
    WHERE id = v_org.id
    RETURNING policy_seq INTO v_new_seq;

    INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, before, after)
    VALUES (
      v_org.id,
      v_admin.id,
      'policy.update',
      'policy',
      v_policy.id,
      v_before,
      jsonb_build_object('name', v_policy.name, 'version', v_policy.version, 'policy_seq', v_new_seq)
    );

    RETURN jsonb_build_object('ok', true, 'policy', to_jsonb(v_policy), 'policy_seq', v_new_seq);

  ELSIF p_op = 'delete' THEN
    SELECT * INTO v_policy FROM public.policies WHERE id = p_policy_id AND organisation_id = v_org.id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'http_status', 404, 'error', 'Policy not found');
    END IF;
    v_before := jsonb_build_object('name', v_policy.name, 'version', v_policy.version);

    DELETE FROM public.policies WHERE id = v_policy.id;
    UPDATE public.organisations SET policy_seq = policy_seq + 1 WHERE id = v_org.id RETURNING policy_seq INTO v_new_seq;

    INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, before, after)
    VALUES (v_org.id, v_admin.id, 'policy.delete', 'policy', v_policy.id, v_before, jsonb_build_object('policy_seq', v_new_seq));

    RETURN jsonb_build_object('ok', true, 'deleted_policy_id', v_policy.id, 'policy_seq', v_new_seq);

  ELSIF p_op = 'assign' THEN
    IF p_policy_id IS NOT NULL THEN
      SELECT * INTO v_policy FROM public.policies WHERE id = p_policy_id AND organisation_id = v_org.id;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'http_status', 404, 'error', 'Policy not found');
      END IF;
    END IF;

    IF p_target_type = 'organisation' THEN
      v_before := jsonb_build_object('default_policy_id', v_org.default_policy_id);
      UPDATE public.organisations
      SET default_policy_id = p_policy_id,
          policy_seq = policy_seq + 1
      WHERE id = v_org.id
      RETURNING policy_seq INTO v_new_seq;

      INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, before, after)
      VALUES (v_org.id, v_admin.id, 'policy.assign', 'organisation', v_org.id, v_before, jsonb_build_object('default_policy_id', p_policy_id, 'policy_seq', v_new_seq));

      RETURN jsonb_build_object('ok', true, 'target_type', 'organisation', 'policy_id', p_policy_id, 'policy_seq', v_new_seq);

    ELSIF p_target_type = 'group' THEN
      SELECT * INTO v_group FROM public.groups WHERE id = p_target_id AND organisation_id = v_org.id FOR UPDATE;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'http_status', 404, 'error', 'Group not found');
      END IF;
      v_before := jsonb_build_object('policy_id', v_group.policy_id);
      UPDATE public.groups SET policy_id = p_policy_id WHERE id = v_group.id;
      UPDATE public.organisations SET policy_seq = policy_seq + 1 WHERE id = v_org.id RETURNING policy_seq INTO v_new_seq;

      INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, before, after)
      VALUES (v_org.id, v_admin.id, 'policy.assign', 'group', v_group.id, v_before, jsonb_build_object('policy_id', p_policy_id, 'policy_seq', v_new_seq));

      RETURN jsonb_build_object('ok', true, 'target_type', 'group', 'target_id', v_group.id, 'policy_id', p_policy_id, 'policy_seq', v_new_seq);

    ELSIF p_target_type = 'seat' THEN
      SELECT * INTO v_seat FROM public.seats WHERE id = p_target_id AND organisation_id = v_org.id FOR UPDATE;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'http_status', 404, 'error', 'Seat not found');
      END IF;
      v_before := jsonb_build_object('policy_id', v_seat.policy_id);
      UPDATE public.seats SET policy_id = p_policy_id WHERE id = v_seat.id;
      UPDATE public.organisations SET policy_seq = policy_seq + 1 WHERE id = v_org.id RETURNING policy_seq INTO v_new_seq;

      INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, before, after)
      VALUES (v_org.id, v_admin.id, 'policy.assign', 'seat', v_seat.id, v_before, jsonb_build_object('policy_id', p_policy_id, 'policy_seq', v_new_seq));

      RETURN jsonb_build_object('ok', true, 'target_type', 'seat', 'target_id', v_seat.id, 'policy_id', p_policy_id, 'policy_seq', v_new_seq);
    ELSE
      RETURN jsonb_build_object('ok', false, 'http_status', 400, 'error', 'Invalid assignment target_type');
    END IF;
  ELSE
    RETURN jsonb_build_object('ok', false, 'http_status', 400, 'error', 'Unsupported policy op');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION internal.group_ops_atomic(
  p_admin_id uuid,
  p_op text,
  p_group_id uuid DEFAULT NULL,
  p_name text DEFAULT NULL,
  p_policy_id uuid DEFAULT NULL,
  p_seat_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin public.admins%ROWTYPE;
  v_org public.organisations%ROWTYPE;
  v_group public.groups%ROWTYPE;
  v_seat public.seats%ROWTYPE;
  v_before jsonb;
  v_new_seq bigint;
BEGIN
  PERFORM internal.require_service_role();

  SELECT * INTO v_admin FROM public.admins WHERE id = p_admin_id;
  IF NOT FOUND OR v_admin.status <> 'active' OR v_admin.must_change_password THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'Admin account is not active');
  END IF;

  SELECT * INTO v_org FROM public.organisations WHERE id = v_admin.organisation_id FOR UPDATE;

  IF NOT internal.admin_has_permission(v_admin, 'group.manage') THEN
    INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, before)
    VALUES (v_org.id, v_admin.id, 'security.refused', 'group', COALESCE(p_group_id, p_seat_id), jsonb_build_object('attempted_action', 'group.' || p_op));
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'Missing group.manage permission');
  END IF;

  IF p_policy_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.policies p WHERE p.id = p_policy_id AND p.organisation_id = v_org.id) THEN
      RETURN jsonb_build_object('ok', false, 'http_status', 404, 'error', 'Policy not found');
    END IF;
  END IF;

  IF p_op = 'create' THEN
    IF p_name IS NULL OR char_length(btrim(p_name)) = 0 THEN
      RETURN jsonb_build_object('ok', false, 'http_status', 400, 'error', 'Group name is required');
    END IF;
    INSERT INTO public.groups (organisation_id, name, policy_id)
    VALUES (v_org.id, btrim(p_name), p_policy_id)
    RETURNING * INTO v_group;

    INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, after)
    VALUES (v_org.id, v_admin.id, 'group.create', 'group', v_group.id, jsonb_build_object('name', v_group.name, 'policy_id', v_group.policy_id));

    RETURN jsonb_build_object('ok', true, 'group', to_jsonb(v_group));

  ELSIF p_op = 'update' THEN
    SELECT * INTO v_group FROM public.groups WHERE id = p_group_id AND organisation_id = v_org.id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'http_status', 404, 'error', 'Group not found');
    END IF;
    v_before := jsonb_build_object('name', v_group.name, 'policy_id', v_group.policy_id);

    UPDATE public.groups
    SET name = COALESCE(NULLIF(btrim(p_name), ''), name),
        policy_id = COALESCE(p_policy_id, policy_id)
    WHERE id = v_group.id
    RETURNING * INTO v_group;

    UPDATE public.organisations SET policy_seq = policy_seq + 1 WHERE id = v_org.id RETURNING policy_seq INTO v_new_seq;

    INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, before, after)
    VALUES (v_org.id, v_admin.id, 'group.update', 'group', v_group.id, v_before, jsonb_build_object('name', v_group.name, 'policy_id', v_group.policy_id, 'policy_seq', v_new_seq));

    RETURN jsonb_build_object('ok', true, 'group', to_jsonb(v_group), 'policy_seq', v_new_seq);

  ELSIF p_op = 'delete' THEN
    SELECT * INTO v_group FROM public.groups WHERE id = p_group_id AND organisation_id = v_org.id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'http_status', 404, 'error', 'Group not found');
    END IF;
    v_before := jsonb_build_object('name', v_group.name, 'policy_id', v_group.policy_id);
    DELETE FROM public.groups WHERE id = v_group.id;
    UPDATE public.organisations SET policy_seq = policy_seq + 1 WHERE id = v_org.id RETURNING policy_seq INTO v_new_seq;

    INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, before, after)
    VALUES (v_org.id, v_admin.id, 'group.delete', 'group', v_group.id, v_before, jsonb_build_object('policy_seq', v_new_seq));

    RETURN jsonb_build_object('ok', true, 'deleted_group_id', v_group.id, 'policy_seq', v_new_seq);

  ELSIF p_op = 'assign_seat' THEN
    IF p_group_id IS NOT NULL THEN
      SELECT * INTO v_group FROM public.groups WHERE id = p_group_id AND organisation_id = v_org.id;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'http_status', 404, 'error', 'Group not found');
      END IF;
    END IF;

    SELECT * INTO v_seat FROM public.seats WHERE id = p_seat_id AND organisation_id = v_org.id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'http_status', 404, 'error', 'Seat not found');
    END IF;

    v_before := jsonb_build_object('group_id', v_seat.group_id);
    UPDATE public.seats SET group_id = p_group_id WHERE id = v_seat.id RETURNING * INTO v_seat;
    UPDATE public.organisations SET policy_seq = policy_seq + 1 WHERE id = v_org.id RETURNING policy_seq INTO v_new_seq;

    INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, before, after)
    VALUES (v_org.id, v_admin.id, 'group.assign_seat', 'seat', v_seat.id, v_before, jsonb_build_object('group_id', p_group_id, 'policy_seq', v_new_seq));

    RETURN jsonb_build_object('ok', true, 'seat', to_jsonb(v_seat), 'policy_seq', v_new_seq);
  ELSE
    RETURN jsonb_build_object('ok', false, 'http_status', 400, 'error', 'Unsupported group op');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION internal.seat_ops_atomic(
  p_admin_id uuid,
  p_op text,
  p_seat_id uuid DEFAULT NULL,
  p_label text DEFAULT NULL
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
  v_required_perm text;
  v_before jsonb;
  v_new_seq bigint;
BEGIN
  PERFORM internal.require_service_role();

  SELECT * INTO v_admin FROM public.admins WHERE id = p_admin_id;
  IF NOT FOUND OR v_admin.status <> 'active' OR v_admin.must_change_password THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'Admin account is not active');
  END IF;

  IF p_op IN ('create', 'revoke') THEN
    v_required_perm := 'code.manage';
  ELSIF p_op IN ('unlock', 'lock') THEN
    v_required_perm := 'seat.unlock';
  ELSE
    RETURN jsonb_build_object('ok', false, 'http_status', 400, 'error', 'Unsupported seat op');
  END IF;

  SELECT * INTO v_org FROM public.organisations WHERE id = v_admin.organisation_id FOR UPDATE;

  IF NOT internal.admin_has_permission(v_admin, v_required_perm) THEN
    INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, before)
    VALUES (v_org.id, v_admin.id, 'security.refused', 'seat', p_seat_id, jsonb_build_object('attempted_action', 'seat.' || p_op));
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'Missing ' || v_required_perm || ' permission');
  END IF;

  IF p_op = 'create' THEN
    IF p_label IS NULL OR char_length(btrim(p_label)) = 0 THEN
      RETURN jsonb_build_object('ok', false, 'http_status', 400, 'error', 'Seat label is required');
    END IF;
    INSERT INTO public.seats (organisation_id, label, status)
    VALUES (v_org.id, btrim(p_label), 'free')
    RETURNING * INTO v_seat;

    INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, after)
    VALUES (v_org.id, v_admin.id, 'seat.create', 'seat', v_seat.id, jsonb_build_object('label', v_seat.label));

    RETURN jsonb_build_object('ok', true, 'seat', to_jsonb(v_seat));
  END IF;

  -- Deadlock order: organisations -> seats -> pairing_codes -> seat_sessions.
  SELECT * INTO v_seat FROM public.seats WHERE id = p_seat_id AND organisation_id = v_org.id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 404, 'error', 'Seat not found');
  END IF;

  IF p_op IN ('unlock', 'lock') THEN
    v_before := jsonb_build_object('unlocked', v_seat.unlocked);
    UPDATE public.seats
    SET unlocked = (p_op = 'unlock')
    WHERE id = v_seat.id
    RETURNING * INTO v_seat;

    UPDATE public.organisations SET policy_seq = policy_seq + 1 WHERE id = v_org.id RETURNING policy_seq INTO v_new_seq;

    INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, before, after)
    VALUES (v_org.id, v_admin.id, 'seat.' || p_op, 'seat', v_seat.id, v_before, jsonb_build_object('unlocked', v_seat.unlocked, 'policy_seq', v_new_seq));

    RETURN jsonb_build_object('ok', true, 'seat', to_jsonb(v_seat), 'policy_seq', v_new_seq);

  ELSIF p_op = 'revoke' THEN
    v_before := jsonb_build_object('status', v_seat.status, 'installation_id', v_seat.installation_id);

    UPDATE public.seats
    SET status = 'revoked',
        installation_id = NULL,
        unlocked = false
    WHERE id = v_seat.id
    RETURNING * INTO v_seat;

    UPDATE public.pairing_codes
    SET revoked_at = v_now
    WHERE seat_id = v_seat.id
      AND used_at IS NULL
      AND revoked_at IS NULL;

    UPDATE internal.seat_sessions
    SET revoked_at = v_now
    WHERE seat_id = v_seat.id
      AND revoked_at IS NULL;

    UPDATE public.organisations SET policy_seq = policy_seq + 1 WHERE id = v_org.id RETURNING policy_seq INTO v_new_seq;

    INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, before, after)
    VALUES (v_org.id, v_admin.id, 'seat.revoke', 'seat', v_seat.id, v_before, jsonb_build_object('status', 'revoked', 'policy_seq', v_new_seq));

    RETURN jsonb_build_object('ok', true, 'seat', to_jsonb(v_seat), 'policy_seq', v_new_seq);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION internal.read_audit_log_atomic(
  p_admin_id uuid,
  p_limit integer DEFAULT 50,
  p_before timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin public.admins%ROWTYPE;
  v_limit integer := GREATEST(1, LEAST(COALESCE(p_limit, 50), 200));
  v_rows jsonb;
BEGIN
  PERFORM internal.require_service_role();

  SELECT * INTO v_admin FROM public.admins WHERE id = p_admin_id;
  IF NOT FOUND OR v_admin.status <> 'active' OR v_admin.must_change_password THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'Admin account is not active');
  END IF;

  IF NOT internal.admin_has_permission(v_admin, 'audit.read') THEN
    INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, before)
    VALUES (v_admin.organisation_id, v_admin.id, 'security.refused', 'organisation', v_admin.organisation_id, jsonb_build_object('attempted_action', 'audit.read'));
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'Missing audit.read permission');
  END IF;

  SELECT COALESCE(jsonb_agg(row_data), '[]'::jsonb) INTO v_rows
  FROM (
    SELECT jsonb_build_object(
      'id', al.id,
      'organisation_id', al.organisation_id,
      'admin_id', al.admin_id,
      'action', al.action,
      'target_type', al.target_type,
      'target_id', al.target_id,
      'before', al.before,
      'after', al.after,
      'created_at', al.created_at
    ) AS row_data
    FROM public.audit_log al
    WHERE al.organisation_id = v_admin.organisation_id
      AND (p_before IS NULL OR al.created_at < p_before)
    ORDER BY al.created_at DESC
    LIMIT v_limit
  ) sub;

  RETURN jsonb_build_object('ok', true, 'entries', v_rows);
END;
$$;

-- 7. Admin Grant & Admin Group RPCs.
CREATE OR REPLACE FUNCTION internal.issue_admin_grant_atomic(
  p_admin_id uuid,
  p_email text,
  p_username text,
  p_temp_password_hash text,
  p_permission_set jsonb,
  p_tier text,
  p_admin_group_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := timezone('utc', now());
  v_admin public.admins%ROWTYPE;
  v_grant_id uuid;
  v_expires_at timestamptz := v_now + interval '72 hours';
BEGIN
  PERFORM internal.require_service_role();

  SELECT * INTO v_admin FROM public.admins WHERE id = p_admin_id;
  IF NOT FOUND OR v_admin.status <> 'active' OR v_admin.must_change_password THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'Admin account is not active');
  END IF;

  IF NOT internal.admin_has_permission(v_admin, 'admin.grant') THEN
    INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, before)
    VALUES (v_admin.organisation_id, v_admin.id, 'security.refused', 'admin', NULL, jsonb_build_object('attempted_action', 'admin.grant'));
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'Missing admin.grant permission');
  END IF;

  IF p_admin_group_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.admin_groups ag WHERE ag.id = p_admin_group_id AND ag.organisation_id = v_admin.organisation_id) THEN
      RETURN jsonb_build_object('ok', false, 'http_status', 404, 'error', 'Admin group not found');
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.admins a WHERE a.organisation_id = v_admin.organisation_id AND a.username = btrim(p_username)
  ) OR EXISTS (
    SELECT 1 FROM public.admin_grants g WHERE g.organisation_id = v_admin.organisation_id AND g.username = btrim(p_username)
  ) THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 409, 'error', 'Username already exists in organisation');
  END IF;

  INSERT INTO public.admin_grants (
    organisation_id,
    email,
    username,
    temp_password_hash,
    permission_set,
    tier,
    admin_group_id,
    created_by_admin_id,
    status,
    expires_at
  ) VALUES (
    v_admin.organisation_id,
    lower(btrim(p_email)),
    btrim(p_username),
    p_temp_password_hash,
    COALESCE(p_permission_set, '[]'::jsonb),
    p_tier,
    p_admin_group_id,
    v_admin.id,
    'issued',
    v_expires_at
  )
  RETURNING id INTO v_grant_id;

  RETURN jsonb_build_object(
    'ok', true,
    'grant_id', v_grant_id,
    'organisation_id', v_admin.organisation_id,
    'email', lower(btrim(p_email)),
    'username', btrim(p_username),
    'expires_at', v_expires_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION internal.finalize_admin_grant_email_atomic(
  p_admin_id uuid,
  p_grant_id uuid,
  p_email_sent boolean,
  p_failure_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_grant public.admin_grants%ROWTYPE;
BEGIN
  PERFORM internal.require_service_role();

  SELECT * INTO v_grant FROM public.admin_grants WHERE id = p_grant_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 404, 'error', 'Grant not found');
  END IF;

  IF p_email_sent THEN
    INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, after)
    VALUES (
      v_grant.organisation_id,
      p_admin_id,
      'admin.grant',
      'admin',
      NULL,
      jsonb_build_object('grant_id', v_grant.id, 'username', v_grant.username, 'tier', v_grant.tier, 'permission_set', v_grant.permission_set, 'expires_at', v_grant.expires_at)
    );
    RETURN jsonb_build_object('ok', true, 'grant_id', v_grant.id);
  ELSE
    -- Fail closed: no grant exists without email step (§4b.1).
    DELETE FROM public.admin_grants WHERE id = v_grant.id AND status = 'issued' AND admin_id IS NULL;
    INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, before)
    VALUES (
      v_grant.organisation_id,
      p_admin_id,
      'admin.grant_email_failed',
      'admin',
      NULL,
      jsonb_build_object('username', v_grant.username, 'reason', COALESCE(p_failure_reason, 'email_delivery_failed'))
    );
    RETURN jsonb_build_object('ok', false, 'rolled_back', true);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION internal.verify_grant_first_login_atomic(
  p_organisation_id uuid,
  p_username text,
  p_ip_hash text
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
  v_grant public.admin_grants%ROWTYPE;
BEGIN
  PERFORM internal.require_service_role();

  SELECT array_agg(k ORDER BY k) INTO v_keys
  FROM unnest(ARRAY[
    'grant:' || p_organisation_id::text || ':' || btrim(p_username),
    'grant_ip:' || p_ip_hash
  ]) AS k;

  FOREACH v_k IN ARRAY v_keys LOOP
    INSERT INTO internal.redemption_rate_limits (scope_key, failure_count, window_started_at, updated_at)
    VALUES (v_k, 0, v_now, v_now)
    ON CONFLICT (scope_key) DO NOTHING;
  END LOOP;

  SELECT EXISTS (
    SELECT 1 FROM internal.redemption_rate_limits rl
    WHERE rl.scope_key = ANY(v_keys)
      AND rl.locked_until IS NOT NULL
      AND rl.locked_until > v_now
    FOR UPDATE
  ) INTO v_locked;

  IF v_locked THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 429, 'error', 'Too many failed attempts');
  END IF;

  SELECT * INTO v_grant
  FROM public.admin_grants g
  WHERE g.organisation_id = p_organisation_id
    AND g.username = btrim(p_username)
  FOR UPDATE;

  IF NOT FOUND OR v_grant.status <> 'issued' OR v_grant.admin_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 401, 'error', 'Invalid or inactive grant');
  END IF;

  IF v_grant.expires_at <= v_now THEN
    UPDATE public.admin_grants SET status = 'expired' WHERE id = v_grant.id;
    RETURN jsonb_build_object('ok', false, 'http_status', 401, 'error', 'Grant has expired');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'grant_id', v_grant.id,
    'organisation_id', v_grant.organisation_id,
    'email', v_grant.email,
    'username', v_grant.username,
    'temp_password_hash', v_grant.temp_password_hash,
    'permission_set', v_grant.permission_set,
    'tier', v_grant.tier,
    'admin_group_id', v_grant.admin_group_id,
    'created_by_admin_id', v_grant.created_by_admin_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION internal.record_grant_login_failure_atomic(
  p_organisation_id uuid,
  p_username text,
  p_ip_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := timezone('utc', now());
  v_keys text[];
BEGIN
  PERFORM internal.require_service_role();
  SELECT array_agg(k ORDER BY k) INTO v_keys
  FROM unnest(ARRAY[
    'grant:' || p_organisation_id::text || ':' || btrim(p_username),
    'grant_ip:' || p_ip_hash
  ]) AS k;
  PERFORM internal.record_redemption_failure_keys(v_keys, v_now);
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION internal.activate_admin_grant_atomic(
  p_grant_id uuid,
  p_auth_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := timezone('utc', now());
  v_grant public.admin_grants%ROWTYPE;
BEGIN
  PERFORM internal.require_service_role();

  SELECT * INTO v_grant FROM public.admin_grants WHERE id = p_grant_id FOR UPDATE;
  IF NOT FOUND OR v_grant.status <> 'issued' OR v_grant.admin_id IS NOT NULL OR v_grant.expires_at <= v_now THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 409, 'error', 'Grant cannot be activated');
  END IF;

  INSERT INTO public.admins (
    id,
    organisation_id,
    email,
    username,
    role,
    granted_by_admin_id,
    permission_set,
    tier,
    admin_group_id,
    must_change_password,
    status
  ) VALUES (
    p_auth_user_id,
    v_grant.organisation_id,
    v_grant.email,
    v_grant.username,
    'granted',
    v_grant.created_by_admin_id,
    v_grant.permission_set,
    v_grant.tier,
    v_grant.admin_group_id,
    false,
    'active'
  );

  UPDATE public.admin_grants
  SET status = 'active',
      admin_id = p_auth_user_id
  WHERE id = v_grant.id;

  DELETE FROM internal.redemption_rate_limits
  WHERE scope_key = 'grant:' || v_grant.organisation_id::text || ':' || v_grant.username;

  INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, after)
  VALUES (
    v_grant.organisation_id,
    p_auth_user_id,
    'admin.grant_activate',
    'admin',
    p_auth_user_id,
    jsonb_build_object('grant_id', v_grant.id, 'username', v_grant.username)
  );

  RETURN jsonb_build_object(
    'ok', true,
    'admin_id', p_auth_user_id,
    'organisation_id', v_grant.organisation_id,
    'username', v_grant.username
  );
END;
$$;

CREATE OR REPLACE FUNCTION internal.change_admin_password_atomic(p_admin_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin public.admins%ROWTYPE;
BEGIN
  PERFORM internal.require_service_role();

  SELECT * INTO v_admin FROM public.admins WHERE id = p_admin_id FOR UPDATE;
  IF NOT FOUND OR v_admin.status <> 'active' THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'Admin account is not active');
  END IF;

  UPDATE public.admins
  SET must_change_password = false
  WHERE id = v_admin.id;

  UPDATE public.admin_grants
  SET status = 'active'
  WHERE admin_id = v_admin.id
    AND status = 'issued';

  INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, after)
  VALUES (
    v_admin.organisation_id,
    v_admin.id,
    'admin.password_change',
    'admin',
    v_admin.id,
    jsonb_build_object('must_change_password', false)
  );

  RETURN jsonb_build_object('ok', true, 'admin_id', v_admin.id, 'must_change_password', false);
END;
$$;

CREATE OR REPLACE FUNCTION internal.update_admin_grant_atomic(
  p_admin_id uuid,
  p_target_admin_id uuid,
  p_permission_set jsonb DEFAULT NULL,
  p_tier text DEFAULT NULL,
  p_admin_group_id uuid DEFAULT NULL,
  p_clear_admin_group boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin public.admins%ROWTYPE;
  v_target public.admins%ROWTYPE;
  v_before jsonb;
BEGIN
  PERFORM internal.require_service_role();

  SELECT * INTO v_admin FROM public.admins WHERE id = p_admin_id;
  IF NOT FOUND OR v_admin.status <> 'active' OR v_admin.must_change_password THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'Admin account is not active');
  END IF;

  IF NOT internal.admin_has_permission(v_admin, 'admin.grant') THEN
    INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, before)
    VALUES (v_admin.organisation_id, v_admin.id, 'security.refused', 'admin', p_target_admin_id, jsonb_build_object('attempted_action', 'admin.grant_change'));
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'Missing admin.grant permission');
  END IF;

  IF p_target_admin_id = v_admin.id THEN
    INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, before)
    VALUES (v_admin.organisation_id, v_admin.id, 'security.refused', 'admin', p_target_admin_id, jsonb_build_object('attempted_action', 'admin.self_escalation'));
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'Self-escalation is not permitted');
  END IF;

  SELECT * INTO v_target FROM public.admins WHERE id = p_target_admin_id AND organisation_id = v_admin.organisation_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 404, 'error', 'Target admin not found');
  END IF;

  IF v_target.role = 'primary' THEN
    INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, before)
    VALUES (v_admin.organisation_id, v_admin.id, 'security.refused', 'admin', v_target.id, jsonb_build_object('attempted_action', 'admin.modify_primary'));
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'Primary admin cannot be modified');
  END IF;

  IF p_admin_group_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.admin_groups ag WHERE ag.id = p_admin_group_id AND ag.organisation_id = v_admin.organisation_id) THEN
      RETURN jsonb_build_object('ok', false, 'http_status', 404, 'error', 'Admin group not found');
    END IF;
  END IF;

  v_before := jsonb_build_object(
    'permission_set', v_target.permission_set,
    'tier', v_target.tier,
    'admin_group_id', v_target.admin_group_id
  );

  -- D5: admin_groups.permission_template never overrides admins.permission_set.
  UPDATE public.admins
  SET permission_set = COALESCE(p_permission_set, permission_set),
      tier = COALESCE(p_tier, tier),
      admin_group_id = CASE
        WHEN p_clear_admin_group THEN NULL
        WHEN p_admin_group_id IS NOT NULL THEN p_admin_group_id
        ELSE admin_group_id
      END
  WHERE id = v_target.id
  RETURNING * INTO v_target;

  UPDATE public.admin_grants
  SET permission_set = COALESCE(p_permission_set, permission_set),
      tier = COALESCE(p_tier, tier),
      admin_group_id = v_target.admin_group_id
  WHERE admin_id = v_target.id;

  INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, before, after)
  VALUES (
    v_admin.organisation_id,
    v_admin.id,
    'admin.grant_change',
    'admin',
    v_target.id,
    v_before,
    jsonb_build_object('permission_set', v_target.permission_set, 'tier', v_target.tier, 'admin_group_id', v_target.admin_group_id)
  );

  RETURN jsonb_build_object(
    'ok', true,
    'admin', jsonb_build_object(
      'id', v_target.id,
      'permission_set', v_target.permission_set,
      'tier', v_target.tier,
      'admin_group_id', v_target.admin_group_id
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION internal.revoke_admin_grant_atomic(
  p_admin_id uuid,
  p_target_admin_id uuid DEFAULT NULL,
  p_grant_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := timezone('utc', now());
  v_admin public.admins%ROWTYPE;
  v_target public.admins%ROWTYPE;
  v_grant public.admin_grants%ROWTYPE;
BEGIN
  PERFORM internal.require_service_role();

  SELECT * INTO v_admin FROM public.admins WHERE id = p_admin_id;
  IF NOT FOUND OR v_admin.status <> 'active' OR v_admin.must_change_password THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'Admin account is not active');
  END IF;

  IF NOT internal.admin_has_permission(v_admin, 'admin.grant') THEN
    INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, before)
    VALUES (v_admin.organisation_id, v_admin.id, 'security.refused', 'admin', p_target_admin_id, jsonb_build_object('attempted_action', 'admin.revoke'));
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'Missing admin.grant permission');
  END IF;

  IF p_target_admin_id IS NOT NULL THEN
    IF p_target_admin_id = v_admin.id THEN
      INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, before)
      VALUES (v_admin.organisation_id, v_admin.id, 'security.refused', 'admin', p_target_admin_id, jsonb_build_object('attempted_action', 'admin.self_revoke'));
      RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'Cannot revoke self');
    END IF;

    SELECT * INTO v_target FROM public.admins WHERE id = p_target_admin_id AND organisation_id = v_admin.organisation_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'http_status', 404, 'error', 'Target admin not found');
    END IF;

    IF v_target.role = 'primary' THEN
      INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, before)
      VALUES (v_admin.organisation_id, v_admin.id, 'security.refused', 'admin', v_target.id, jsonb_build_object('attempted_action', 'admin.revoke_primary'));
      RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'Primary admin cannot be revoked');
    END IF;

    UPDATE public.admins SET status = 'revoked', revoked_at = v_now WHERE id = v_target.id;
    UPDATE public.admin_grants SET status = 'revoked' WHERE admin_id = v_target.id;

    INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, after)
    VALUES (v_admin.organisation_id, v_admin.id, 'admin.revoke', 'admin', v_target.id, jsonb_build_object('status', 'revoked'));

    RETURN jsonb_build_object('ok', true, 'revoked_admin_id', v_target.id);

  ELSIF p_grant_id IS NOT NULL THEN
    SELECT * INTO v_grant FROM public.admin_grants WHERE id = p_grant_id AND organisation_id = v_admin.organisation_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'http_status', 404, 'error', 'Grant not found');
    END IF;

    IF v_grant.admin_id = v_admin.id THEN
      INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, before)
      VALUES (v_admin.organisation_id, v_admin.id, 'security.refused', 'admin', v_admin.id, jsonb_build_object('attempted_action', 'admin.self_revoke'));
      RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'Cannot revoke self');
    END IF;

    UPDATE public.admin_grants SET status = 'revoked' WHERE id = v_grant.id;
    IF v_grant.admin_id IS NOT NULL THEN
      SELECT * INTO v_target FROM public.admins WHERE id = v_grant.admin_id FOR UPDATE;
      IF FOUND AND v_target.role <> 'primary' THEN
        UPDATE public.admins SET status = 'revoked', revoked_at = v_now WHERE id = v_target.id;
      END IF;
    END IF;

    INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, after)
    VALUES (v_admin.organisation_id, v_admin.id, 'admin.revoke', 'admin', v_grant.admin_id, jsonb_build_object('grant_id', v_grant.id, 'status', 'revoked'));

    RETURN jsonb_build_object('ok', true, 'revoked_grant_id', v_grant.id, 'revoked_admin_id', v_grant.admin_id);
  ELSE
    RETURN jsonb_build_object('ok', false, 'http_status', 400, 'error', 'target_admin_id or grant_id is required');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION internal.manage_admin_group_atomic(
  p_admin_id uuid,
  p_op text,
  p_admin_group_id uuid DEFAULT NULL,
  p_name text DEFAULT NULL,
  p_permission_template jsonb DEFAULT NULL,
  p_target_admin_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin public.admins%ROWTYPE;
  v_ag public.admin_groups%ROWTYPE;
  v_target public.admins%ROWTYPE;
  v_before jsonb;
BEGIN
  PERFORM internal.require_service_role();

  SELECT * INTO v_admin FROM public.admins WHERE id = p_admin_id;
  IF NOT FOUND OR v_admin.status <> 'active' OR v_admin.must_change_password THEN
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'Admin account is not active');
  END IF;

  IF NOT internal.admin_has_permission(v_admin, 'admin.grant') THEN
    INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, before)
    VALUES (v_admin.organisation_id, v_admin.id, 'security.refused', 'admin', COALESCE(p_target_admin_id, p_admin_group_id), jsonb_build_object('attempted_action', 'admin_group.' || p_op));
    RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'Missing admin.grant permission');
  END IF;

  IF p_op = 'create' THEN
    IF p_name IS NULL OR char_length(btrim(p_name)) = 0 THEN
      RETURN jsonb_build_object('ok', false, 'http_status', 400, 'error', 'Admin group name is required');
    END IF;
    INSERT INTO public.admin_groups (organisation_id, name, permission_template)
    VALUES (v_admin.organisation_id, btrim(p_name), p_permission_template)
    RETURNING * INTO v_ag;

    INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, after)
    VALUES (v_admin.organisation_id, v_admin.id, 'admin.team_change', 'admin', NULL, jsonb_build_object('admin_group_id', v_ag.id, 'name', v_ag.name));

    RETURN jsonb_build_object('ok', true, 'admin_group', to_jsonb(v_ag));

  ELSIF p_op = 'update' THEN
    SELECT * INTO v_ag FROM public.admin_groups WHERE id = p_admin_group_id AND organisation_id = v_admin.organisation_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'http_status', 404, 'error', 'Admin group not found');
    END IF;
    v_before := jsonb_build_object('name', v_ag.name, 'permission_template', v_ag.permission_template);

    -- D5: updating permission_template never alters existing admins.permission_set.
    UPDATE public.admin_groups
    SET name = COALESCE(NULLIF(btrim(p_name), ''), name),
        permission_template = COALESCE(p_permission_template, permission_template)
    WHERE id = v_ag.id
    RETURNING * INTO v_ag;

    INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, before, after)
    VALUES (v_admin.organisation_id, v_admin.id, 'admin.team_change', 'admin', NULL, v_before, jsonb_build_object('admin_group_id', v_ag.id, 'name', v_ag.name, 'permission_template', v_ag.permission_template));

    RETURN jsonb_build_object('ok', true, 'admin_group', to_jsonb(v_ag));

  ELSIF p_op = 'delete' THEN
    SELECT * INTO v_ag FROM public.admin_groups WHERE id = p_admin_group_id AND organisation_id = v_admin.organisation_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'http_status', 404, 'error', 'Admin group not found');
    END IF;
    DELETE FROM public.admin_groups WHERE id = v_ag.id;

    INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, before)
    VALUES (v_admin.organisation_id, v_admin.id, 'admin.team_change', 'admin', NULL, jsonb_build_object('deleted_admin_group_id', v_ag.id, 'name', v_ag.name));

    RETURN jsonb_build_object('ok', true, 'deleted_admin_group_id', v_ag.id);

  ELSIF p_op = 'assign' THEN
    IF p_admin_group_id IS NOT NULL THEN
      SELECT * INTO v_ag FROM public.admin_groups WHERE id = p_admin_group_id AND organisation_id = v_admin.organisation_id;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'http_status', 404, 'error', 'Admin group not found');
      END IF;
    END IF;
    SELECT * INTO v_target FROM public.admins WHERE id = p_target_admin_id AND organisation_id = v_admin.organisation_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'http_status', 404, 'error', 'Target admin not found');
    END IF;
    IF v_target.role = 'primary' THEN
      INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, before)
      VALUES (v_admin.organisation_id, v_admin.id, 'security.refused', 'admin', v_target.id, jsonb_build_object('attempted_action', 'admin.modify_primary'));
      RETURN jsonb_build_object('ok', false, 'http_status', 403, 'error', 'Primary admin cannot be assigned to an admin group');
    END IF;

    v_before := jsonb_build_object('admin_group_id', v_target.admin_group_id);
    -- D5: strictly updates admin_group_id; never overwrites admins.permission_set.
    UPDATE public.admins SET admin_group_id = p_admin_group_id WHERE id = v_target.id;

    INSERT INTO public.audit_log (organisation_id, admin_id, action, target_type, target_id, before, after)
    VALUES (v_admin.organisation_id, v_admin.id, 'admin.team_change', 'admin', v_target.id, v_before, jsonb_build_object('admin_group_id', p_admin_group_id));

    RETURN jsonb_build_object('ok', true, 'admin_id', v_target.id, 'admin_group_id', p_admin_group_id);
  ELSE
    RETURN jsonb_build_object('ok', false, 'http_status', 400, 'error', 'Unsupported admin_group op');
  END IF;
END;
$$;

-- Lock down all internal.* RPCs from PUBLIC, anon, authenticated.
REVOKE ALL ON FUNCTION
  internal.require_service_role(),
  internal.get_pairing_pepper(),
  internal.admin_has_permission(public.admins, text),
  internal.resolve_effective_policy(uuid),
  internal.get_admin_context(uuid, uuid),
  internal.verify_seat_session(text, text),
  internal.find_pairing_code_candidate(text),
  internal.generate_pairing_code_atomic(uuid, uuid, text, text, timestamptz),
  internal.revoke_pairing_code_atomic(uuid, uuid, uuid),
  internal.record_redemption_failure_keys(text[], timestamptz),
  internal.redeem_pairing_code_atomic(text, text, text, text, text, timestamptz),
  internal.deliver_policy_for_seat(text, text),
  internal.ingest_heartbeat_atomic(text, text, uuid, uuid, text, text, text, text, integer, text, text, jsonb),
  internal.rotate_seat_session_atomic(text, text, text, timestamptz),
  internal.unpair_seat_atomic(text, text),
  internal.create_organisation_atomic(uuid, text, text, text),
  internal.delete_organisation_atomic(uuid, uuid),
  internal.policy_ops_atomic(uuid, text, uuid, text, jsonb, text, uuid),
  internal.group_ops_atomic(uuid, text, uuid, text, uuid, uuid),
  internal.seat_ops_atomic(uuid, text, uuid, text),
  internal.read_audit_log_atomic(uuid, integer, timestamptz),
  internal.issue_admin_grant_atomic(uuid, text, text, text, jsonb, text, uuid),
  internal.finalize_admin_grant_email_atomic(uuid, uuid, boolean, text),
  internal.verify_grant_first_login_atomic(uuid, text, text),
  internal.record_grant_login_failure_atomic(uuid, text, text),
  internal.activate_admin_grant_atomic(uuid, uuid),
  internal.change_admin_password_atomic(uuid),
  internal.update_admin_grant_atomic(uuid, uuid, jsonb, text, uuid, boolean),
  internal.revoke_admin_grant_atomic(uuid, uuid, uuid),
  internal.manage_admin_group_atomic(uuid, text, uuid, text, jsonb, uuid)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  internal.require_service_role(),
  internal.get_pairing_pepper(),
  internal.admin_has_permission(public.admins, text),
  internal.resolve_effective_policy(uuid),
  internal.get_admin_context(uuid, uuid),
  internal.verify_seat_session(text, text),
  internal.find_pairing_code_candidate(text),
  internal.generate_pairing_code_atomic(uuid, uuid, text, text, timestamptz),
  internal.revoke_pairing_code_atomic(uuid, uuid, uuid),
  internal.record_redemption_failure_keys(text[], timestamptz),
  internal.redeem_pairing_code_atomic(text, text, text, text, text, timestamptz),
  internal.deliver_policy_for_seat(text, text),
  internal.ingest_heartbeat_atomic(text, text, uuid, uuid, text, text, text, text, integer, text, text, jsonb),
  internal.rotate_seat_session_atomic(text, text, text, timestamptz),
  internal.unpair_seat_atomic(text, text),
  internal.create_organisation_atomic(uuid, text, text, text),
  internal.delete_organisation_atomic(uuid, uuid),
  internal.policy_ops_atomic(uuid, text, uuid, text, jsonb, text, uuid),
  internal.group_ops_atomic(uuid, text, uuid, text, uuid, uuid),
  internal.seat_ops_atomic(uuid, text, uuid, text),
  internal.read_audit_log_atomic(uuid, integer, timestamptz),
  internal.issue_admin_grant_atomic(uuid, text, text, text, jsonb, text, uuid),
  internal.finalize_admin_grant_email_atomic(uuid, uuid, boolean, text),
  internal.verify_grant_first_login_atomic(uuid, text, text),
  internal.record_grant_login_failure_atomic(uuid, text, text),
  internal.activate_admin_grant_atomic(uuid, uuid),
  internal.change_admin_password_atomic(uuid),
  internal.update_admin_grant_atomic(uuid, uuid, jsonb, text, uuid, boolean),
  internal.revoke_admin_grant_atomic(uuid, uuid, uuid),
  internal.manage_admin_group_atomic(uuid, text, uuid, text, jsonb, uuid)
TO service_role;

-- 8. Thin service_role-only public.rpc_* wrappers for PostgREST Edge Function calls.
CREATE OR REPLACE FUNCTION public.rpc_get_pairing_pepper()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM internal.require_service_role();
  RETURN internal.get_pairing_pepper();
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_get_admin_context(p_admin_id uuid, p_session_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM internal.require_service_role();
  RETURN internal.get_admin_context(p_admin_id, p_session_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_find_pairing_code_candidate(p_lookup_hash text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM internal.require_service_role();
  RETURN internal.find_pairing_code_candidate(p_lookup_hash);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_generate_pairing_code(
  p_admin_id uuid,
  p_seat_id uuid,
  p_code_hash text,
  p_lookup_hash text,
  p_expires_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM internal.require_service_role();
  RETURN internal.generate_pairing_code_atomic(p_admin_id, p_seat_id, p_code_hash, p_lookup_hash, p_expires_at);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_revoke_pairing_code(
  p_admin_id uuid,
  p_seat_id uuid DEFAULT NULL,
  p_code_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM internal.require_service_role();
  RETURN internal.revoke_pairing_code_atomic(p_admin_id, p_seat_id, p_code_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_redeem_pairing_code(
  p_lookup_hash text,
  p_code_hash text,
  p_installation_id text,
  p_ip_hash text,
  p_session_token_hash text,
  p_session_expires_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM internal.require_service_role();
  RETURN internal.redeem_pairing_code_atomic(p_lookup_hash, p_code_hash, p_installation_id, p_ip_hash, p_session_token_hash, p_session_expires_at);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_deliver_policy_for_seat(p_token_hash text, p_installation_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM internal.require_service_role();
  RETURN internal.deliver_policy_for_seat(p_token_hash, p_installation_id);
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
  p_reported_policy jsonb
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
    p_reported_policy
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_rotate_seat_session(
  p_old_token_hash text,
  p_installation_id text,
  p_new_token_hash text,
  p_new_expires_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM internal.require_service_role();
  RETURN internal.rotate_seat_session_atomic(p_old_token_hash, p_installation_id, p_new_token_hash, p_new_expires_at);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_unpair_seat(p_token_hash text, p_installation_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM internal.require_service_role();
  RETURN internal.unpair_seat_atomic(p_token_hash, p_installation_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_create_organisation(
  p_admin_id uuid,
  p_email text,
  p_username text,
  p_org_name text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM internal.require_service_role();
  RETURN internal.create_organisation_atomic(p_admin_id, p_email, p_username, p_org_name);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_delete_organisation(p_admin_id uuid, p_organisation_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM internal.require_service_role();
  RETURN internal.delete_organisation_atomic(p_admin_id, p_organisation_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_policy_ops(
  p_admin_id uuid,
  p_op text,
  p_policy_id uuid DEFAULT NULL,
  p_name text DEFAULT NULL,
  p_body jsonb DEFAULT NULL,
  p_target_type text DEFAULT NULL,
  p_target_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM internal.require_service_role();
  RETURN internal.policy_ops_atomic(p_admin_id, p_op, p_policy_id, p_name, p_body, p_target_type, p_target_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_group_ops(
  p_admin_id uuid,
  p_op text,
  p_group_id uuid DEFAULT NULL,
  p_name text DEFAULT NULL,
  p_policy_id uuid DEFAULT NULL,
  p_seat_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM internal.require_service_role();
  RETURN internal.group_ops_atomic(p_admin_id, p_op, p_group_id, p_name, p_policy_id, p_seat_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_seat_ops(
  p_admin_id uuid,
  p_op text,
  p_seat_id uuid DEFAULT NULL,
  p_label text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM internal.require_service_role();
  RETURN internal.seat_ops_atomic(p_admin_id, p_op, p_seat_id, p_label);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_read_audit_log(
  p_admin_id uuid,
  p_limit integer DEFAULT 50,
  p_before timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM internal.require_service_role();
  RETURN internal.read_audit_log_atomic(p_admin_id, p_limit, p_before);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_issue_admin_grant(
  p_admin_id uuid,
  p_email text,
  p_username text,
  p_temp_password_hash text,
  p_permission_set jsonb,
  p_tier text,
  p_admin_group_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM internal.require_service_role();
  RETURN internal.issue_admin_grant_atomic(p_admin_id, p_email, p_username, p_temp_password_hash, p_permission_set, p_tier, p_admin_group_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_finalize_admin_grant_email(
  p_admin_id uuid,
  p_grant_id uuid,
  p_email_sent boolean,
  p_failure_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM internal.require_service_role();
  RETURN internal.finalize_admin_grant_email_atomic(p_admin_id, p_grant_id, p_email_sent, p_failure_reason);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_verify_grant_first_login(
  p_organisation_id uuid,
  p_username text,
  p_ip_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM internal.require_service_role();
  RETURN internal.verify_grant_first_login_atomic(p_organisation_id, p_username, p_ip_hash);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_record_grant_login_failure(
  p_organisation_id uuid,
  p_username text,
  p_ip_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM internal.require_service_role();
  RETURN internal.record_grant_login_failure_atomic(p_organisation_id, p_username, p_ip_hash);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_activate_admin_grant(p_grant_id uuid, p_auth_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM internal.require_service_role();
  RETURN internal.activate_admin_grant_atomic(p_grant_id, p_auth_user_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_change_admin_password(p_admin_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM internal.require_service_role();
  RETURN internal.change_admin_password_atomic(p_admin_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_update_admin_grant(
  p_admin_id uuid,
  p_target_admin_id uuid,
  p_permission_set jsonb DEFAULT NULL,
  p_tier text DEFAULT NULL,
  p_admin_group_id uuid DEFAULT NULL,
  p_clear_admin_group boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM internal.require_service_role();
  RETURN internal.update_admin_grant_atomic(p_admin_id, p_target_admin_id, p_permission_set, p_tier, p_admin_group_id, p_clear_admin_group);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_revoke_admin_grant(
  p_admin_id uuid,
  p_target_admin_id uuid DEFAULT NULL,
  p_grant_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM internal.require_service_role();
  RETURN internal.revoke_admin_grant_atomic(p_admin_id, p_target_admin_id, p_grant_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_manage_admin_group(
  p_admin_id uuid,
  p_op text,
  p_admin_group_id uuid DEFAULT NULL,
  p_name text DEFAULT NULL,
  p_permission_template jsonb DEFAULT NULL,
  p_target_admin_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM internal.require_service_role();
  RETURN internal.manage_admin_group_atomic(p_admin_id, p_op, p_admin_group_id, p_name, p_permission_template, p_target_admin_id);
END;
$$;

REVOKE ALL ON FUNCTION
  public.rpc_get_pairing_pepper(),
  public.rpc_get_admin_context(uuid, uuid),
  public.rpc_find_pairing_code_candidate(text),
  public.rpc_generate_pairing_code(uuid, uuid, text, text, timestamptz),
  public.rpc_revoke_pairing_code(uuid, uuid, uuid),
  public.rpc_redeem_pairing_code(text, text, text, text, text, timestamptz),
  public.rpc_deliver_policy_for_seat(text, text),
  public.rpc_ingest_heartbeat(text, text, uuid, uuid, text, text, text, text, integer, text, text, jsonb),
  public.rpc_rotate_seat_session(text, text, text, timestamptz),
  public.rpc_unpair_seat(text, text),
  public.rpc_create_organisation(uuid, text, text, text),
  public.rpc_delete_organisation(uuid, uuid),
  public.rpc_policy_ops(uuid, text, uuid, text, jsonb, text, uuid),
  public.rpc_group_ops(uuid, text, uuid, text, uuid, uuid),
  public.rpc_seat_ops(uuid, text, uuid, text),
  public.rpc_read_audit_log(uuid, integer, timestamptz),
  public.rpc_issue_admin_grant(uuid, text, text, text, jsonb, text, uuid),
  public.rpc_finalize_admin_grant_email(uuid, uuid, boolean, text),
  public.rpc_verify_grant_first_login(uuid, text, text),
  public.rpc_record_grant_login_failure(uuid, text, text),
  public.rpc_activate_admin_grant(uuid, uuid),
  public.rpc_change_admin_password(uuid),
  public.rpc_update_admin_grant(uuid, uuid, jsonb, text, uuid, boolean),
  public.rpc_revoke_admin_grant(uuid, uuid, uuid),
  public.rpc_manage_admin_group(uuid, text, uuid, text, jsonb, uuid)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.rpc_get_pairing_pepper(),
  public.rpc_get_admin_context(uuid, uuid),
  public.rpc_find_pairing_code_candidate(text),
  public.rpc_generate_pairing_code(uuid, uuid, text, text, timestamptz),
  public.rpc_revoke_pairing_code(uuid, uuid, uuid),
  public.rpc_redeem_pairing_code(text, text, text, text, text, timestamptz),
  public.rpc_deliver_policy_for_seat(text, text),
  public.rpc_ingest_heartbeat(text, text, uuid, uuid, text, text, text, text, integer, text, text, jsonb),
  public.rpc_rotate_seat_session(text, text, text, timestamptz),
  public.rpc_unpair_seat(text, text),
  public.rpc_create_organisation(uuid, text, text, text),
  public.rpc_delete_organisation(uuid, uuid),
  public.rpc_policy_ops(uuid, text, uuid, text, jsonb, text, uuid),
  public.rpc_group_ops(uuid, text, uuid, text, uuid, uuid),
  public.rpc_seat_ops(uuid, text, uuid, text),
  public.rpc_read_audit_log(uuid, integer, timestamptz),
  public.rpc_issue_admin_grant(uuid, text, text, text, jsonb, text, uuid),
  public.rpc_finalize_admin_grant_email(uuid, uuid, boolean, text),
  public.rpc_verify_grant_first_login(uuid, text, text),
  public.rpc_record_grant_login_failure(uuid, text, text),
  public.rpc_activate_admin_grant(uuid, uuid),
  public.rpc_change_admin_password(uuid),
  public.rpc_update_admin_grant(uuid, uuid, jsonb, text, uuid, boolean),
  public.rpc_revoke_admin_grant(uuid, uuid, uuid),
  public.rpc_manage_admin_group(uuid, text, uuid, text, jsonb, uuid)
TO service_role;
