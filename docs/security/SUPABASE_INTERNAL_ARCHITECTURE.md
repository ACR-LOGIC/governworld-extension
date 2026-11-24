# GovernWorld Supabase Integration — Internal Technical Architecture

> [!CAUTION]
> **INTERNAL ENGINEERING REFERENCE ONLY.** This document details the private database schema, `internal` schema RPCs, cryptographic hashing flows, Edge Function contracts, and extension integration boundaries for project `lkgcehdwasewwoieyoip`. Never commit `service_role` keys, Vault secrets, or private Ed25519 signing keys to source control or documentation.

---

## 1. Project & Client Coordinates

- **Supabase Project Ref:** `lkgcehdwasewwoieyoip` (`GovernWorld Manager`, `us-east-1`)
- **Pinned Base URL:** `https://lkgcehdwasewwoieyoip.supabase.co` ([`src/api/config.ts`](file:///c:/Projects/governworld-chrome-extension/src/api/config.ts#L18))
- **Publishable Key:** `SUPABASE_PUBLISHABLE_KEY` (`sb_publishable_...`) in [`src/api/config.ts`](file:///c:/Projects/governworld-chrome-extension/src/api/config.ts#L19)
- **Extension Version:** `CURRENT_EXTENSION_VERSION = "0.4.1"` ([`src/api/config.ts`](file:///c:/Projects/governworld-chrome-extension/src/api/config.ts#L20))
- **Transport Validation:** [`validateSupabaseUrl()`](file:///c:/Projects/governworld-chrome-extension/src/api/config.ts#L128-L152) enforces `https:` protocol, exact hostname (`lkgcehdwasewwoieyoip.supabase.co`), no custom ports, and no embedded URL credentials.

---

## 2. Database Schema Architecture

All tables reside in PostgreSQL 17 across two schemas (`public` and `internal`), defined in [`20261122000200_core_schema_and_internal_tables.sql`](file:///c:/Projects/governworld-chrome-extension/supabase/migrations/20261122000200_core_schema_and_internal_tables.sql) (after [`20261122000100_reconcile_legacy_prototype.sql`](file:///c:/Projects/governworld-chrome-extension/supabase/migrations/20261122000100_reconcile_legacy_prototype.sql) dropped legacy prototype tables including `public.stripe_events`).

### 2.1 `public` Schema Tables (10)
| Table | Purpose |
| :--- | :--- |
| `public.organisations` | Tenant root records and org metadata. |
| `public.admin_groups` | Role/permission groups scoped to an organisation. |
| `public.admins` | Admin identities linked to `auth.users` and `organisations` (partial unique index `admins_one_active_primary_per_org_idx`). |
| `public.policies` | Managed policy definitions and sequence numbers (`policy_seq`). |
| `public.groups` | Device/seat groups for targeted policy assignment. |
| `public.seats` | Enrolled extension seats bound to `installation_id` (`seats_installation_id_unique_idx`). |
| `public.pairing_codes` | Hashed pairing codes with `expires_at`; partial unique indexes enforce one live code per seat (`pairing_codes_one_live_per_seat_idx`) and unique live lookup hash (`pairing_codes_live_lookup_hash_idx`). |
| `public.admin_grants` | Delegated admin invitations, first-login verification state, and permission grants. |
| `public.audit_log` | Immutable organisation-scoped administrative & pairing audit trail. |
| `public.heartbeat_state` | Latest per-seat device health & compliance snapshot (10 allowlisted metadata columns). |

### 2.2 `internal` Schema Tables (2)
| Table | Purpose |
| :--- | :--- |
| `internal.seat_sessions` | Stores SHA-256 hashes of opaque `gws_` seat session tokens, `installation_id` binding, `token_generation`, and `expires_at` (30-day TTL). |
| `internal.redemption_rate_limits` | Tracks failed pairing-code redemption attempts by lookup/IP keys for brute-force throttling. |

---

## 3. Row-Level Security (RLS) & `SECURITY DEFINER` RPC Model

Defined in [`20261122000300_rls_and_internal_rpcs.sql`](file:///c:/Projects/governworld-chrome-extension/supabase/migrations/20261122000300_rls_and_internal_rpcs.sql):

1. **Forced RLS & Revoked Grants:** `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` are enabled on all 12 tables. Direct `PUBLIC`, `anon`, and `authenticated` table privileges are revoked.
2. **Deny-All Client Policies:** `public.pairing_codes`, `internal.seat_sessions`, and `internal.redemption_rate_limits` have explicit `USING (false) WITH CHECK (false)` policies for `anon` and `authenticated`.
3. **Admin Read Policies (`TO authenticated`):** Org-scoped `SELECT` policies use `(select internal.active_admin_organisation_id())` and `(select internal.active_admin_has_permission(...))` (e.g., `audit.read` on `audit_log`, `admin.grant` on `admin_grants`).
4. **Service-Role-Gated Atomic RPCs:** All mutations and sensitive lookups run inside `internal.*` `SECURITY DEFINER` functions with `SET search_path = ''` that call `internal.require_service_role()` (requiring `current_user IN ('service_role', 'postgres')`). Edge Functions invoke them via `public.rpc_*` wrappers using a `service_role` client (`createSupabaseAdmin()`).

---

## 4. Authentication & Authorization

### 4.1 API Key Gate (`apikey`)
Every Edge Function calls [`requireApiKey(req)`](file:///c:/Projects/governworld-chrome-extension/supabase/functions/_shared/auth.ts#L7-L18), which validates the `apikey` header against `resolvePublishableKeys()` using constant-time comparison ([`timingSafeEqualStrings()`](file:///c:/Projects/governworld-chrome-extension/supabase/functions/_shared/crypto.ts#L62-L70)).

### 4.2 Admin Authentication
Admin endpoints (`pairing-code-generate`, `admin-ops`, `admin-grant-manage`) call `requireAdminContext(req, supabaseAdmin)` which invokes [`verifyAdminJwt()`](file:///c:/Projects/governworld-chrome-extension/supabase/functions/_shared/auth.ts#L54-L100):
- Extracts the 3-segment Bearer JWT.
- Verifies claims via `anonClient.auth.getClaims(jwt)` (with fallback to `supabaseAdmin.auth.getUser(jwt)`), validating non-zero UUID `sub`.
- Resolves org membership, active status, and permissions via `public.rpc_get_admin_context(p_admin_id, p_session_id)`.

### 4.3 Seat (Extension) Authentication
Device endpoints (`heartbeat-ingest`, `policy-deliver`, `session-rotate`, `seat-unpair`) call `hashSeatSessionFromRequest(req)` using [`extractSeatSessionToken()`](file:///c:/Projects/governworld-chrome-extension/supabase/functions/_shared/auth.ts#L31-L46):
- Reads `x-seat-session` header (or `Authorization: Bearer <token>`, explicitly rejecting `sb_publishable_` keys and 3-segment JWTs).
- Hashes the opaque `gws_` token with SHA-256 (`sha256Hex`) before passing `p_token_hash` to Postgres.
- Postgres verifies `(p_token_hash, p_installation_id)` against `internal.seat_sessions` via `internal.verify_seat_session()`.

---

## 5. Edge Functions & Operational Flows

All 8 Edge Functions are deployed under `supabase/functions/`:

| Edge Function | Caller | Underlying RPC(s) | Responsibility |
| :--- | :--- | :--- | :--- |
| `pairing-code-generate` | Admin | `rpc_generate_pairing_code`, `rpc_revoke_pairing_code` | Generates/revokes 8-digit pairing codes (10-min TTL) hashed with Vault pepper. |
| `pairing-code-redeem` | Extension | `rpc_find_pairing_code_candidate`, `rpc_redeem_pairing_code` | Redeems 8-digit code + `installation_id`; enforces rate limits; issues `gws_` token + signed policy envelope. |
| `policy-deliver` | Extension | `rpc_deliver_policy_for_seat` | Resolves effective policy (`internal.resolve_effective_policy`) and returns Ed25519-signed envelope. |
| `heartbeat-ingest` | Extension | `rpc_ingest_heartbeat` | Validates strict Section-5 allowlist and upserts `public.heartbeat_state`. |
| `session-rotate` | Extension | `rpc_rotate_seat_session` | Rotates `gws_` token (30-day TTL) and increments `token_generation`. |
| `seat-unpair` | Extension | `rpc_unpair_seat` | Revokes active seat session and unpairs the device installation. |
| `admin-ops` | Admin | `rpc_create_organisation`, `rpc_delete_organisation`, `rpc_policy_ops`, `rpc_group_ops`, `rpc_seat_ops`, `rpc_read_audit_log` | Organisation, policy, group, seat, and audit-log management. |
| `admin-grant-manage` | Admin | `rpc_issue_admin_grant`, `rpc_finalize_admin_grant_email`, `rpc_verify_grant_first_login`, `rpc_record_grant_login_failure`, `rpc_activate_admin_grant`, `rpc_change_admin_password`, `rpc_update_admin_grant`, `rpc_revoke_admin_grant`, `rpc_manage_admin_group` | Delegated admin lifecycle and admin group management. |

### 5.1 Pairing Code Cryptography & Anti-Enumeration
- **Vault Pepper:** `vault.decrypted_secrets` (`gw_pairing_code_pepper`) is fetched only by `service_role` via `internal.get_pairing_pepper()` (`public.rpc_get_pairing_pepper()`).
- **Two-Stage Hashing:** [`pairing-code-redeem/index.ts`](file:///c:/Projects/governworld-chrome-extension/supabase/functions/pairing-code-redeem/index.ts#L63-L96) computes `lookupHash` from `(pepper, rawCode)` in Deno so the plaintext code is **never** sent to Postgres. `rpc_find_pairing_code_candidate` resolves the candidate `organisation_id`, Deno computes the org-scoped `orgHash`, and `rpc_redeem_pairing_code` atomically validates, marks used, binds `installation_id`, and inserts the hashed `gws_` session token.
- **Anti-Enumeration:** Every invalid format, unknown key, rate-limit hit, or unmatched code returns HTTP `400`/`403` with the identical message `"That code could not be accepted"`.

### 5.2 Heartbeat Strict Allowlist & Extension Cadence
- **Extension Cadence:** [`src/service-worker/heartbeatService.ts`](file:///c:/Projects/governworld-chrome-extension/src/service-worker/heartbeatService.ts#L20-L91) schedules `gw_management_heartbeat` via `chrome.alarms` every **15 minutes** (`HEARTBEAT_INTERVAL_MINUTES = 15`). In `LOCAL` mode, `sendHeartbeatStatusCheck()` returns immediately with `sent: false` and zero network egress.
- **Server Allowlist:** [`heartbeat-ingest/index.ts`](file:///c:/Projects/governworld-chrome-extension/supabase/functions/heartbeat-ingest/index.ts#L8-L180) rejects any unknown top-level key outside:
  `seat_id`, `installation_id`, `organisation_id`, `extension_version`, `browser_name`, `browser_version`, `platform`, `policy_version`, `policy_status`, `health_status`, `timestamp`, `reported_policy`.
  `reported_policy` is likewise restricted to `policy_version`, `locked`, `protectionMode`, `userCanDisable`, `enforcedCategories`, and `networkDestinationPolicy`. All enums (`BROWSER_NAMES`, `POLICY_STATUSES`, `HEALTH_STATUSES`, `PROTECTION_MODES`, `NETWORK_DEST_POLICIES`, `ALL_CATEGORIES`) and formats (`SEMVER_REGEX`, `BROWSER_VER_REGEX`, `PLATFORM_REGEX`, non-zero UUIDs) fail closed with HTTP `400`.

### 5.3 Ed25519 Policy Signing & Extension State
- `buildAndSignManagedPolicyEnvelope()` in [`policySigner.ts`](file:///c:/Projects/governworld-chrome-extension/supabase/functions/_shared/policySigner.ts) signs policy envelopes with Ed25519.
- The extension verifies signatures against `TRUSTED_POLICY_PUBLIC_KEY_JWK` in [`src/api/config.ts`](file:///c:/Projects/governworld-chrome-extension/src/api/config.ts#L37-L42). If `x` is empty, verification fails closed.
- Local pairing metadata is persisted under `PAIRING_STATE_KEY` (`"gw_pairing_state"`) via [`normalizePairingState()`](file:///c:/Projects/governworld-chrome-extension/src/shared/settings.ts#L644-L729), which fails closed to `local_only` on any malformed state and **never** stores raw pairing codes or bearer tokens.

---

## 6. Coexistence with Stripe Billing

Supabase and Stripe operate as strictly decoupled planes:
- **Stripe:** Handles checkout and subscription billing exclusively (`https://checkout.stripe.com`, validated in [`src/service-worker/index.ts`](file:///c:/Projects/governworld-chrome-extension/src/service-worker/index.ts#L1973)). When a user links a workspace in the side panel, the `gw_` API key is held in browser session storage solely to query billing metadata and open Stripe Checkout ([`PRIVACY.md`](file:///c:/Projects/governworld-chrome-extension/docs/security/PRIVACY.md#L98)).
- **Supabase:** Handles identity/authentication, organisation/seat management, pairing codes, signed policy distribution, and device health heartbeats. Legacy `public.stripe_events` was removed from the extension's Supabase schema in migration `20261122000100`.
