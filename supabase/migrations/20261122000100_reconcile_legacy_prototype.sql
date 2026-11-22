-- Migration 1: Reconcile and remove empty legacy prototype objects.
-- Preserves auth.users rows (including 759fd63b-a786-40ab-80fb-5e673f0741e9)
-- and platform event trigger ensure_rls -> public.rls_auto_enable().

-- 1. Drop legacy signup trigger on auth.users first so new Auth users do not invoke legacy handle_new_user().
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

-- 2. Drop legacy public functions (excluding public.rls_auto_enable()).
DROP FUNCTION IF EXISTS public.handle_new_user() CASCADE;
DROP FUNCTION IF EXISTS public.handle_new_organization() CASCADE;
DROP FUNCTION IF EXISTS public.handle_updated_at() CASCADE;
DROP FUNCTION IF EXISTS public.has_org_role(uuid, public.member_role[]) CASCADE;
DROP FUNCTION IF EXISTS public.is_org_admin(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.is_org_member(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.is_platform_admin() CASCADE;
DROP FUNCTION IF EXISTS public.create_employee_with_seat(uuid, text, text, uuid) CASCADE;
DROP FUNCTION IF EXISTS public.deactivate_employee_atomic(uuid, uuid, uuid) CASCADE;
DROP FUNCTION IF EXISTS public.redeem_pairing_code_atomic(text, text, text, text, text) CASCADE;
DROP FUNCTION IF EXISTS public.remove_entire_setup_atomic(uuid, uuid, boolean) CASCADE;

-- 3. Guarded idempotent drop of legacy public.pairing_codes only if it still has legacy column employee_id.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'pairing_codes'
      AND column_name = 'employee_id'
  ) THEN
    DROP TABLE public.pairing_codes CASCADE;
  END IF;
END $$;

-- 4. Drop remaining 18 empty legacy public tables.
DROP TABLE IF EXISTS
  public.audit_events,
  public.device_approvals,
  public.device_entitlements,
  public.employees,
  public.extension_policies,
  public.extension_releases,
  public.heartbeat_records,
  public.invitations,
  public.organization_licenses,
  public.organization_members,
  public.organizations,
  public.platform_settings,
  public.policy_versions,
  public.registered_devices,
  public.role_permissions,
  public.stripe_events,
  public.subscriptions,
  public.user_profiles
CASCADE;

-- 5. Drop all 16 legacy public enum types.
DROP TYPE IF EXISTS
  public.bem_account_status,
  public.bem_device_approval_status,
  public.bem_employee_status,
  public.bem_org_role,
  public.bem_pairing_status,
  public.bem_platform_role,
  public.bem_policy_sync_status,
  public.device_enrollment_status,
  public.entitlement_status,
  public.invitation_status,
  public.license_status,
  public.license_tier,
  public.member_role,
  public.membership_status,
  public.org_status,
  public.subscription_billing_interval
CASCADE;
