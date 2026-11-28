# GovernWorld Extension — Public Zero-Trust Cloud & Privacy Architecture

GovernWorld is built **local-first**: all PII, PHI, financial, and secret detection, DOM masking, paste protection, and document redaction run **100% on your device**. When an organization enables centralized team management, the GovernWorld Chrome Extension uses **Supabase — and only Supabase —** for authentication, pairing code generation/redemption, policy delivery, and device health heartbeats, alongside **Stripe** exclusively for payment processing.

---

## 1. Local Mode vs. Managed Mode

| Capability | `LOCAL` Mode (Default) | `MANAGE` Mode (Optional Team / Enterprise) |
| :--- | :--- | :--- |
| **Network Egress** | **Zero.** No background requests, no heartbeats, no account required. | **Metadata-only.** Connects only to pinned GovernWorld Supabase endpoints over strict TLS. |
| **Detection & Redaction** | 100% on-device (deterministic regex, checksums, local Bloom dictionaries, local OCR). | 100% on-device (identical local engine; no content ever leaves the browser). |
| **Policy Control** | Controlled entirely by the local user. | Organization-signed policies enforce compliance rules; accessibility accommodations remain user-controlled. |

---

## 2. Why GovernWorld Uses Supabase — and Only Supabase — for Extension Coordination

For `MANAGE` mode, GovernWorld relies **exclusively on Supabase** (project `https://lkgcehdwasewwoieyoip.supabase.co`) for four tightly scoped responsibilities:

1. **Administrator Authentication:** Organization administrators sign in through Supabase Auth to manage seats, groups, and compliance policies.
2. **Email-Bound Pairing Tokens & Single-Seat Multi-Browser Licensing:** Admins enter the target user's email address to issue a single-use 8-digit pairing token (`user_email_hash`, 10-minute TTL). **1 user = 1 seat** across distinct browser families, with **at most 1 active instance per browser family** per user email (`(user_email_hash, browser_family, device_activation_hash)`). Duplicate browser pairing prompts for explicit replacement (unpairing and resetting the old instance) or cancellation. Before pairing finalizes, the user must confirm a modal warning that administrator policies take effect immediately and **once paired, only the administrator can unpair the extension**.
3. **Signed Policy Delivery, Auto-Lock & Per-Feature Unlock:** Paired devices receive organization policies wrapped in an **Ed25519 cryptographic signature**. All admin-controlled features lock automatically upon pairing (with a separate administrator `"Unlock for User"` trigger per feature). If an organization's subscription lapses (`HTTP 402`), cloud heartbeats pause while previously pushed policies remain enforced and locked locally.
4. **Isolated Telemetry & Dual-State Lifecycle Detection:** Health-check schema validation runs in an isolated worker (`telemetry-worker.js` / `telemetrySandbox.ts`) with zero access to DOM or payload storage. Paired devices emit closed-schema checks every 15 minutes and distinguish **Online** (active heartbeats), **Offline (Clean Shutdown)** (`runtime.onSuspend`), and **Uninstalled / Terminated** (`runtime.setUninstallURL` -> `uninstall-signal`).

> [!IMPORTANT]
> **Strictest Possible Transport Security (HTTPS / TLS):** Every connection from the extension to Supabase is validated by [`validateSupabaseUrl()`](file:///c:/Projects/governworld-chrome-extension/src/api/config.ts#L128-L152), which enforces **HTTPS/TLS**, pins the exact GovernWorld Supabase hostname, and rejects non-HTTPS URLs, custom ports, embedded credentials, or untrusted hosts.

---

## 3. How the Heartbeat Works — and Why Your Data Can Never Be Exposed

Paid-tier and enterprise customers can enable team management with confidence that **none of their browsing, clinical, financial, or personal data is ever exposed** to GovernWorld or transmitted over the network.

### 3.1 "If It Doesn't Match, We Won't Get It" (Fail-Closed Allowlist)
Both the extension and the [`heartbeat-ingest`](file:///c:/Projects/governworld-chrome-extension/supabase/functions/heartbeat-ingest/index.ts#L8-L180) Edge Function enforce a **strict, closed schema allowlist**. Every incoming heartbeat is validated against exact field names, UUID formats, semver patterns, and fixed enumerations before it can touch the database:

- **Accepted Fields Only:**
  - Device & org identifiers (`seat_id`, `installation_id`, `organisation_id`)
  - Sanitized environment metadata (`extension_version`, `browser_name`, `browser_version`, `platform`)
  - Policy & health status (`policy_version`, `policy_status`, `health_status`, `timestamp`)
  - Policy-lock summary (`locked`, `protectionMode`, `userCanDisable`, `enforcedCategories`, `networkDestinationPolicy`)
- **Automatic Rejection:** If a payload contains **any** unexpected key, free-text field, or non-matching value, the Edge Function **immediately rejects the entire request (`HTTP 400`)** before any database write occurs.

### 3.2 Zero Surveillance Guarantee
The following data is **never** collected, transmitted, or stored in Supabase:
- Browsing history, visited URLs, domains, or search queries
- Webpage text, DOM contents, form inputs, or clipboard/paste contents
- Detected or redacted PII, PHI, medical terms, financial numbers, or API secrets
- Uploaded/scanned documents, PDFs, images, emails, or personal files

### 3.3 Built for Your Team's Visibility — Not Ours
The heartbeat signal exists **for your organization's benefit, not for GovernWorld to inspect your work**. It provides your own administrators with a clean health and compliance signal (for example, confirming that enrolled seats are active and enforcing the latest policy version) while keeping all sensitive workflows strictly inside your employees' browsers.

### 3.4 Defense-in-Depth Server Isolation
- **Row-Level Security (RLS):** Enabled and forced on every table in Supabase, isolating each organization's metadata to its own authorized administrators.
- **Hashed Device Sessions:** Paired devices authenticate using opaque `gws_` session tokens bound to a single `installation_id`; only SHA-256 hashes are stored server-side, and tokens rotate on a 30-day lifecycle.
- **Anti-Enumeration Pairing:** Invalid, expired, or rate-limited pairing attempts all return the same generic error response so attackers cannot probe valid codes or organizations.

---

## 4. How Supabase and Stripe Coexist

Besides Supabase, GovernWorld uses **Stripe** exclusively as its payment and subscription billing provider. The two systems are strictly separated by responsibility:

| Plane | Provider | Scope & Data Handled | What It Never Sees |
| :--- | :--- | :--- | :--- |
| **Billing & Payments** | **Stripe** (`https://checkout.stripe.com`) | Subscription checkout, payment methods, invoices, and plan tier status. | Webpage text, PII/PHI, device heartbeats, or organization security policies. |
| **Auth, Policy & Health** | **Supabase** (`lkgcehdwasewwoieyoip.supabase.co`) | Admin auth, pairing codes, seat sessions, signed policies, and 15-minute device health signals. | Payment card details, browsing history, page content, or scanned documents. |

When a user opens billing or upgrades to a paid tier from the extension side panel, the extension opens Stripe Checkout over strict HTTPS (`checkout.stripe.com`). Billing state remains decoupled from on-device protection and from the metadata-only Supabase health plane.

---

Last verified on: November 28, 2026
