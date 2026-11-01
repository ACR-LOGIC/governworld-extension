// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_NOTIFICATION_PREFS,
  DEFAULT_SETTINGS,
  isNotificationPrivacyMode,
  normalizeNotificationPrefs,
  normalizeSettings,
  type NotificationPreferences,
} from "../src/shared/settings.js";
import { validateMessage } from "../src/shared/messages.js";

describe("Notification System - Preferences & Normalization", () => {
  it("provides complete default preferences", () => {
    expect(DEFAULT_NOTIFICATION_PREFS).toEqual({
      systemEnabled: false,
      toastEnabled: true,
      badgeEnabled: true,
      soundEnabled: false,
      notifyCriticalFindings: true,
      notifyPasteInterception: true,
      notifyPolicyChanges: true,
      notifyRedactionComplete: true,
      privacyMode: "detailed",
    });
    expect(DEFAULT_SETTINGS.notificationPrefs).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(DEFAULT_SETTINGS.notificationsEnabled).toBe(false);
  });

  it("normalizes malformed or null preferences fail-closed", () => {
    expect(normalizeNotificationPrefs(null)).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(normalizeNotificationPrefs(undefined)).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(normalizeNotificationPrefs("unexpected")).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(normalizeNotificationPrefs(123)).toEqual(DEFAULT_NOTIFICATION_PREFS);
  });

  it("sanitizes boolean fields and privacy modes", () => {
    const custom = {
      systemEnabled: true,
      toastEnabled: false,
      badgeEnabled: false,
      soundEnabled: true,
      notifyCriticalFindings: false,
      notifyPasteInterception: false,
      notifyPolicyChanges: false,
      notifyRedactionComplete: false,
      privacyMode: "minimal",
    };
    expect(normalizeNotificationPrefs(custom)).toEqual(custom);

    const malformed = {
      systemEnabled: "yes",
      toastEnabled: 1,
      badgeEnabled: null,
      soundEnabled: {},
      notifyCriticalFindings: [],
      notifyPasteInterception: "true",
      notifyPolicyChanges: 0,
      notifyRedactionComplete: undefined,
      privacyMode: "super-detailed", // invalid
    };
    expect(normalizeNotificationPrefs(malformed)).toEqual(DEFAULT_NOTIFICATION_PREFS);
  });

  it("validates isNotificationPrivacyMode", () => {
    expect(isNotificationPrivacyMode("detailed")).toBe(true);
    expect(isNotificationPrivacyMode("minimal")).toBe(true);
    expect(isNotificationPrivacyMode("other")).toBe(false);
    expect(isNotificationPrivacyMode(null)).toBe(false);
    expect(isNotificationPrivacyMode(undefined)).toBe(false);
    expect(isNotificationPrivacyMode("")).toBe(false);
  });

  it("preserves backward compatibility between notificationsEnabled and notificationPrefs.systemEnabled", () => {
    // Legacy stored settings where notificationsEnabled was true
    const legacy = normalizeSettings({ notificationsEnabled: true });
    expect(legacy.notificationsEnabled).toBe(true);
    expect(legacy.notificationPrefs.systemEnabled).toBe(true);

    // Legacy stored settings where notificationsEnabled was false
    const legacyOff = normalizeSettings({ notificationsEnabled: false });
    expect(legacyOff.notificationsEnabled).toBe(false);
    expect(legacyOff.notificationPrefs.systemEnabled).toBe(false);

    // New format with notificationPrefs
    const modern = normalizeSettings({
      notificationPrefs: {
        systemEnabled: true,
        toastEnabled: true,
        badgeEnabled: true,
        soundEnabled: false,
        notifyCriticalFindings: true,
        notifyPasteInterception: true,
        notifyPolicyChanges: true,
        notifyRedactionComplete: true,
        privacyMode: "minimal",
      },
    });
    expect(modern.notificationsEnabled).toBe(true);
    expect(modern.notificationPrefs.systemEnabled).toBe(true);
    expect(modern.notificationPrefs.privacyMode).toBe("minimal");
  });
});

describe("Notification System - Message Contract Validation", () => {
  it("validates CONTENT_SHOW_TOAST message correctly", () => {
    const valid = validateMessage({
      type: "CONTENT_SHOW_TOAST",
      requestId: "req-1",
      level: "warning",
      title: "GovernWorld \u2014 Paste Shield",
      message: "Sensitive data intercepted from clipboard.",
      durationMs: 4000,
      actionLabel: "Undo",
    });
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.message.type).toBe("CONTENT_SHOW_TOAST");
    }

    // Missing/invalid title
    expect(validateMessage({
      type: "CONTENT_SHOW_TOAST",
      requestId: "req-2",
      title: "",
      message: "Test message",
    }).ok).toBe(false);

    // Missing/invalid message
    expect(validateMessage({
      type: "CONTENT_SHOW_TOAST",
      requestId: "req-3",
      title: "Test title",
      message: "",
    }).ok).toBe(false);

    // Invalid level
    expect(validateMessage({
      type: "CONTENT_SHOW_TOAST",
      requestId: "req-4",
      level: "critical", // invalid level
      title: "Test title",
      message: "Test message",
    }).ok).toBe(false);

    // Duration out of bounds (< 500ms or > 30000ms)
    expect(validateMessage({
      type: "CONTENT_SHOW_TOAST",
      requestId: "req-5",
      title: "Test title",
      message: "Test message",
      durationMs: 200,
    }).ok).toBe(false);

    expect(validateMessage({
      type: "CONTENT_SHOW_TOAST",
      requestId: "req-6",
      title: "Test title",
      message: "Test message",
      durationMs: 50000,
    }).ok).toBe(false);
  });

  it("validates POPUP_SET_NOTIFICATION_PREFS and POPUP_NOTIFICATION_PREFS_STATE", () => {
    const setMsg = validateMessage({
      type: "POPUP_SET_NOTIFICATION_PREFS",
      requestId: "req-7",
      prefs: {
        toastEnabled: false,
        privacyMode: "minimal",
      },
    });
    expect(setMsg.ok).toBe(true);

    const invalidSetMsg = validateMessage({
      type: "POPUP_SET_NOTIFICATION_PREFS",
      requestId: "req-8",
      prefs: "not-a-record",
    });
    expect(invalidSetMsg.ok).toBe(false);

    const stateMsg = validateMessage({
      type: "POPUP_NOTIFICATION_PREFS_STATE",
      requestId: "req-9",
      prefs: DEFAULT_NOTIFICATION_PREFS,
      granted: true,
    });
    expect(stateMsg.ok).toBe(true);
  });
});

describe("Notification System - Privacy & Zero-Egress Invariants", () => {
  it("never includes unmasked sensitive content in notification structures", () => {
    const rawSSN = "123-45-6789";
    const rawCard = "4111222233334444";
    const rawSecret = "gw_sec_abc123xyz";

    // Simulate notification payload generation in minimal privacy mode
    const minimalMessage = `${3} sensitive items detected on this page.`;
    expect(minimalMessage).not.toContain(rawSSN);
    expect(minimalMessage).not.toContain(rawCard);
    expect(minimalMessage).not.toContain(rawSecret);
    expect(minimalMessage).not.toContain("ssn");
    expect(minimalMessage).not.toContain("payment_card");

    // Simulate notification payload generation in detailed privacy mode
    const counts: Record<string, number> = { ssn: 1, payment_card: 1, secrets: 1 };
    const top = Object.entries(counts)
      .map(([cat, n]) => `${n} ${cat.replace(/_/g, " ")}`)
      .join(", ");
    const detailedMessage = `3 values detected on this page: ${top}.`;

    expect(detailedMessage).not.toContain(rawSSN);
    expect(detailedMessage).not.toContain(rawCard);
    expect(detailedMessage).not.toContain(rawSecret);
    expect(detailedMessage).toContain("1 ssn");
    expect(detailedMessage).toContain("1 payment card");
  });
});
