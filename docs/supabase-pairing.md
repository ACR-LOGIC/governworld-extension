# Supabase Pairing (MANAGE mode)

Design: GW-SUPABASE-DESIGN-2026-001. Project: `lkgcehdwasewwoieyoip`.

## Behaviour
- **LOCAL (default):** no network egress, no heartbeats. Pairing state is `local_only`.
- **MANAGE:** an admin issues a single-use, 10-minute pairing code per seat; the extension redeems it (`redeeming` -> `paired`, or `paired_offline` when the network is unavailable). Mandated policy is locked; accessibility and cosmetic settings stay unlocked.
- **Fail-closed:** policy payloads are signature-verified before enforcement; any verification failure rejects the policy. Redemption errors are generic and audited. Precedence is seat > group > org.
- **Heartbeat / sessions:** metadata-only heartbeat every 15 minutes; the opaque seat session token rotates on the same cadence with clock-skew tolerance. Transient network errors fall back to `paired_offline` and re-authenticate; they never fail open.
- **Never transmitted:** browsing history, URLs, page text, form data, keystrokes, credentials.

## Backend layout (`supabase/`)
- `migrations/` - idempotent SQL; strict RLS tenant isolation; private `internal` schema for sessions and rate limits.
- `functions/` - Edge Functions (see CHANGELOG); `_shared/` holds auth, crypto and policy-signing helpers.

## Configuration
- The extension pins the Supabase host (HTTPS, no wildcards, no custom ports) in `src/api/config.ts` and the manifests. Only the publishable key ships in the client; service-role and signing keys must never be placed in client bundles or docs.
- Vercel project `acr-logic/governworld`: `NEXT_PUBLIC_SUPABASE_URL` (Production, Preview) and `NEXT_PUBLIC_SUPABASE_ANON_KEY` (Production; add for Preview if used).

## Deploying
Apply migrations in order, then deploy functions with the Supabase CLI (`supabase db push`, `supabase functions deploy <name>`) after `supabase login`. Migration `20261122000100` drops empty legacy prototype tables with CASCADE; confirm they are empty first.

## Out of scope
Admin Portal, Azure parity, admin-account recovery (D8).
