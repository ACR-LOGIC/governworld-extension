// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
// Who may change organization settings, decided once and failing closed.
//
// An organization account has employees who should use GovernWorld and admins who
// should configure it. The privilege boundary has to hold in three places or it
// does not hold at all:
//
//   1. The popup hides the settings form from members and shows a wall instead.
//   2. The worker refuses the save. A hidden form is NOT a control — the message
//      that drives it is still reachable from the popup, the sidepanel and any
//      other extension context, so the write must be refused where it happens.
//   3. The API is authoritative and rejects a non-admin write regardless.
//
// These tests cover the shared decision every one of those layers consults, so a
// new surface cannot invent its own weaker rule.
import { describe, expect, it } from "vitest";
import {
  buildAccountView,
  canManageOrganization,
  hasOrganizationControls,
  NO_ACCOUNT,
  parseAccountView,
  resolveHighestRole,
  subscriptionTier,
} from "../src/shared/account.js";
import type { TenantContext } from "../src/api/types.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const workerSrc = readFileSync(join(process.cwd(), "src/service-worker/index.ts"), "utf8");
const popupSrc = readFileSync(join(process.cwd(), "src/popup/popup.ts"), "utf8");
const popupMarkup = readFileSync(join(process.cwd(), "src/popup/index.html"), "utf8");

const tenant = (roles: string[], verified = true): TenantContext => ({
  tenant_id: "acme",
  tenant_name: "Acme Corp",
  roles,
  verified,
});

describe("administrative access is granted by role, never assumed", () => {
  it("grants owner and admin", () => {
    expect(canManageOrganization(["owner"])).toBe(true);
    expect(canManageOrganization(["admin"])).toBe(true);
  });

  it("refuses member and viewer — the whole point of the wall", () => {
    expect(canManageOrganization(["member"])).toBe(false);
    expect(canManageOrganization(["viewer"])).toBe(false);
  });

  it("fails closed on absent, empty, or unrecognised roles", () => {
    // Every one of these previously could have been read as "no roles given, so
    // unrestricted". Each must grant nothing.
    for (const input of [[], null, undefined, ["superuser"], ["Admin "], [""], ["ADMIN"], [42, {}]]) {
      expect(canManageOrganization(input as unknown[]), JSON.stringify(input)).toBe(false);
    }
  });

  it("takes the highest privilege when several roles are present", () => {
    expect(resolveHighestRole(["member", "admin"])).toBe("admin");
    expect(resolveHighestRole(["admin", "owner"])).toBe("owner");
    expect(resolveHighestRole(["viewer", "member"])).toBe("member");
  });

  it("returns null when nothing in the list is recognised", () => {
    expect(resolveHighestRole(["auditor", "billing"])).toBeNull();
  });
});

describe("subscription tier never overstates what was granted", () => {
  it("reads the server tier", () => {
    expect(subscriptionTier({ tier: "enterprise", features: [] })).toBe("enterprise");
    expect(subscriptionTier({ tier: "pro", features: [] })).toBe("pro");
    expect(subscriptionTier({ tier: "free", features: [] })).toBe("free");
  });

  it("falls back to free for a missing or malformed entitlement", () => {
    // A paid-looking label on an absent entitlement is the worst outcome: the user
    // believes they are covered when nothing was proven.
    expect(subscriptionTier(null)).toBe("free");
    expect(subscriptionTier(undefined)).toBe("free");
    expect(subscriptionTier({ tier: "platinum", features: [] } as never)).toBe("free");
  });
});

describe("the account view is built only from a verified tenant", () => {
  it("populates identity, org, role and tier for a verified admin", () => {
    const view = buildAccountView({
      connected: true,
      userEmail: "admin@acme.test",
      tenant: tenant(["admin"]),
      entitlements: { tier: "enterprise", features: [] },
      capabilities: ["policy_sync", "organization_controls"],
    });
    expect(view).toMatchObject({
      connected: true,
      userEmail: "admin@acme.test",
      tenantId: "acme",
      tenantName: "Acme Corp",
      role: "admin",
      canManage: true,
      tier: "enterprise",
    });
  });

  it("shows a member their identity and plan but not management", () => {
    const view = buildAccountView({
      connected: true,
      userEmail: "employee@acme.test",
      tenant: tenant(["member"]),
      entitlements: { tier: "pro", features: [] },
      capabilities: ["policy_sync"],
    });
    expect(view.connected).toBe(true);
    expect(view.userEmail).toBe("employee@acme.test");
    expect(view.role).toBe("member");
    expect(view.tier).toBe("pro");
    expect(view.canManage).toBe(false);
  });

  it("resolves to disconnected for an unverified or absent tenant", () => {
    // A half-populated account reads as authoritative when it is not, so any
    // failure to verify collapses to fully disconnected.
    for (const input of [
      { connected: true, tenant: tenant(["admin"], false) },
      { connected: true, tenant: null },
      { connected: false, tenant: tenant(["owner"]) },
      { connected: true },
    ]) {
      const view = buildAccountView(input);
      expect(view.connected, JSON.stringify(input)).toBe(false);
      expect(view.canManage).toBe(false);
      expect(view.role).toBeNull();
    }
  });

  it("separates 'may edit settings' from 'has org controls'", () => {
    // An admin without the capability still edits settings but must not be shown
    // as holding organization controls; a capability without admin role grants no
    // access at all.
    const adminNoCapability = buildAccountView({ connected: true, tenant: tenant(["admin"]) });
    expect(adminNoCapability.canManage).toBe(true);
    expect(hasOrganizationControls(adminNoCapability.capabilities)).toBe(false);

    const memberWithCapability = buildAccountView({
      connected: true,
      tenant: tenant(["member"]),
      capabilities: ["organization_controls"],
    });
    expect(memberWithCapability.canManage).toBe(false);
    expect(hasOrganizationControls(memberWithCapability.capabilities)).toBe(true);
  });
});

describe("a tampered account message cannot manufacture privilege", () => {
  const valid = buildAccountView({
    connected: true,
    userEmail: "member@acme.test",
    tenant: tenant(["member"]),
    entitlements: { tier: "pro", features: [] },
    capabilities: [],
  });

  it("accepts a well-formed view", () => {
    const parsed = parseAccountView(valid);
    expect(parsed?.role).toBe("member");
    expect(parsed?.canManage).toBe(false);
  });

  it("re-derives canManage rather than trusting the field", () => {
    // The message claims admin rights the role does not carry. This is the
    // attack the re-derivation exists to stop.
    const parsed = parseAccountView({ ...valid, role: "member", canManage: true });
    expect(parsed?.canManage).toBe(false);
  });

  it("does not let a missing role become a management grant", () => {
    expect(parseAccountView({ ...valid, role: null, canManage: true })?.canManage).toBe(false);
  });

  it("rejects rather than repairs a malformed view", () => {
    for (const bad of [
      { ...valid, role: "superuser" },
      { ...valid, tier: "platinum" },
      { ...valid, connected: false },
      { ...valid, capabilities: "all" },
      { ...valid, capabilities: ["not_a_capability"] },
      { ...valid, tenantId: "" },
      null,
      "member",
      42,
    ]) {
      expect(parseAccountView(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("refuses an unbounded capability list", () => {
    const many = Array.from({ length: 40 }, () => "policy_sync");
    expect(parseAccountView({ ...valid, capabilities: many })).toBeNull();
  });

  it("collapses a rejected view to the disconnected default", () => {
    // What a caller does with a rejection: the safe state, not a partial account.
    expect(parseAccountView({ role: "admin" }) ?? NO_ACCOUNT).toEqual(NO_ACCOUNT);
  });
});

describe("the privilege boundary exists in the UI and the worker", () => {
  it("the worker refuses an org settings save from a non-admin", () => {
    // Hiding a form is not a control — the message still drives the write.
    const fn = workerSrc.slice(workerSrc.indexOf("async function saveAccount"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toContain("ORG_SETTINGS_FORBIDDEN");
    // The check runs before the gateway is contacted or anything is persisted.
    expect(body.indexOf("ORG_SETTINGS_FORBIDDEN")).toBeLessThan(body.indexOf("saveSettings"));
  });

  it("the popup shows members a wall instead of the settings form", () => {
    expect(popupMarkup).toContain('id="org-settings-wall"');
    expect(popupSrc).toContain("renderAccountView");
    // Both surfaces are toggled from the one decision.
    expect(popupSrc).toMatch(/orgSettings\.hidden = !canManage/);
    expect(popupSrc).toMatch(/orgSettingsWall\.hidden = !connected \|\| canManage/);
  });

  it("the wall text is the user-facing wording, in every language", async () => {
    const { UI_TRANSLATIONS } = await import("../src/shared/i18n.js");
    const langs = Object.keys(UI_TRANSLATIONS) as (keyof typeof UI_TRANSLATIONS)[];
    expect(langs.length).toBeGreaterThanOrEqual(7);
    for (const lang of langs) {
      const wall = UI_TRANSLATIONS[lang].account_managed_wall;
      // A missing or stub translation leaves a member staring at an empty box, so
      // every locale must carry real prose. Content is not word-matched: the
      // translations legitimately differ.
      expect(wall, `missing wall text for ${lang}`).toBeTruthy();
      expect(wall.length, `wall text too short for ${lang}`).toBeGreaterThan(30);
    }
    expect(UI_TRANSLATIONS.en.account_managed_wall).toBe(
      "You don't have access to this page, please reach out to your organization admins for more information. This is managed by your organization."
    );
  });
});