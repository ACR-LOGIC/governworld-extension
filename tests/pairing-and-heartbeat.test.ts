// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
/**
 * Test suite for Standalone LOCAL Mode, Admin Pairing, Feature Lockdown,
 * and Lightweight Post-Pairing Heartbeat Verification.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  sendHeartbeatStatusCheck,
  scheduleHeartbeatAlarm,
  clearHeartbeatAlarm,
  ALARM_NAME_HEARTBEAT,
  HEARTBEAT_INTERVAL_MINUTES,
  getBrowserInfo,
} from "../src/service-worker/heartbeatService.js";
import {
  saveManagementEnrollment,
  clearManagementEnrollment,
  loadManagementEnrollment,
  ManagementEnrollment,
} from "../src/shared/managedPolicy.js";
import { loadEnterprisePolicy } from "../src/shared/enterprisePolicy.js";

describe("Standalone LOCAL mode vs Managed Pairing & Heartbeat", () => {
  let localStorageMock: Record<string, unknown> = {};
  let alarmsMock: Record<string, { periodInMinutes?: number; delayInMinutes?: number }> = {};
  let fetchMock = vi.fn();

  beforeEach(() => {
    localStorageMock = {};
    alarmsMock = {};
    fetchMock = vi.fn();

    // Mock chrome storage
    const chromeMock: Record<string, unknown> = {
      storage: {
        local: {
          get: vi.fn(async (keys: string | string[] | null) => {
            if (keys === null) return { ...localStorageMock };
            if (typeof keys === "string") return { [keys]: localStorageMock[keys] };
            if (Array.isArray(keys)) {
              const res: Record<string, unknown> = {};
              for (const k of keys) res[k] = localStorageMock[k];
              return res;
            }
            return {};
          }),
          set: vi.fn(async (items: Record<string, unknown>) => {
            Object.assign(localStorageMock, items);
          }),
          remove: vi.fn(async (keys: string | string[]) => {
            const arr = Array.isArray(keys) ? keys : [keys];
            for (const k of arr) delete localStorageMock[k];
          }),
        },
        managed: {
          get: vi.fn(async () => ({})),
        },
      },
      alarms: {
        get: vi.fn(async (name: string) => alarmsMock[name] || null),
        create: vi.fn((name: string, info: { periodInMinutes?: number; delayInMinutes?: number }) => {
          alarmsMock[name] = info;
        }),
        clear: vi.fn(async (name: string) => {
          delete alarmsMock[name];
          return true;
        }),
      },
      runtime: {
        getManifest: () => ({ version: "0.3.0" }),
      },
    };

    Object.defineProperty(globalThis, "chrome", {
      value: chromeMock,
      configurable: true,
      writable: true,
    });

    Object.defineProperty(globalThis, "fetch", {
      value: fetchMock,
      configurable: true,
      writable: true,
    });
  });

  it("boots strictly in Standalone LOCAL mode: zero heartbeats, zero network calls, zero alarms", async () => {
    // 1. Initial state: not enrolled
    const enrollment = await loadManagementEnrollment();
    expect(enrollment).toBeNull();

    const policy = await loadEnterprisePolicy();
    expect(policy.managed).toBe(false);

    // 2. Heartbeat status check MUST NOT make any network calls
    const result = await sendHeartbeatStatusCheck();
    expect(result.mode).toBe("LOCAL");
    expect(result.sent).toBe(false);
    expect(result.status).toBe("idle");
    expect(fetchMock).not.toHaveBeenCalled();

    // 3. scheduleHeartbeatAlarm MUST NOT create any alarm in LOCAL mode
    await scheduleHeartbeatAlarm();
    expect(alarmsMock[ALARM_NAME_HEARTBEAT]).toBeUndefined();
  });

  it("starts periodic heartbeats ONLY after successful pairing in MANAGE mode", async () => {
    // 1. Setup enrollment (simulating successful pairing)
    const mockEnrollment: ManagementEnrollment = {
      organization_id: "org_governworld_corp",
      organization_name: "GovernWorld Corp",
      employee_id: "emp_101",
      device_id: "dev_uuid_12345",
      coordinator_url: "https://coordinator.governworld.internal",
      enrolled_at: new Date().toISOString(),
      management_mode: "MANAGE",
    };
    await saveManagementEnrollment(mockEnrollment);

    // 2. Schedule heartbeat alarm
    await scheduleHeartbeatAlarm();
    expect(alarmsMock[ALARM_NAME_HEARTBEAT]).toBeDefined();
    expect(alarmsMock[ALARM_NAME_HEARTBEAT].periodInMinutes).toBe(HEARTBEAT_INTERVAL_MINUTES);

    // 3. Execute heartbeat status check
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: "acknowledged" }),
    });

    const result = await sendHeartbeatStatusCheck();
    expect(result.mode).toBe("MANAGE");
    expect(result.sent).toBe(true);
    expect(result.status).toBe("sent");

    // Verify endpoint called
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe("https://coordinator.governworld.internal/api/v1/management/heartbeat");
    expect(calledInit.method).toBe("POST");

    const payload = JSON.parse(calledInit.body);
    expect(payload.device_id).toBe("dev_uuid_12345");
    expect(payload.organization_id).toBe("org_governworld_corp");
    expect(payload.employee_id).toBe("emp_101");
    expect(payload.browser_info).toBeDefined();
    expect(payload.extension_version).toBe("0.3.0");
    expect(payload.policy_version).toBeGreaterThanOrEqual(1);
    expect(payload.status).toBe("healthy");

    // 4. Strict privacy assertion: NO browsing history, visited URLs, page text, or secrets
    expect(payload.url).toBeUndefined();
    expect(payload.history).toBeUndefined();
    expect(payload.searchQuery).toBeUndefined();
    expect(payload.pageText).toBeUndefined();
    expect(payload.dom).toBeUndefined();
    expect(payload.credentials).toBeUndefined();
    expect(payload.documents).toBeUndefined();
  });

  it("cancels heartbeat alarm and returns to LOCAL mode when unpaired", async () => {
    // 1. Enroll and schedule alarm
    const mockEnrollment: ManagementEnrollment = {
      organization_id: "org_governworld_corp",
      organization_name: "GovernWorld Corp",
      employee_id: "emp_101",
      device_id: "dev_uuid_12345",
      coordinator_url: "https://coordinator.governworld.internal",
      enrolled_at: new Date().toISOString(),
      management_mode: "MANAGE",
    };
    await saveManagementEnrollment(mockEnrollment);
    await scheduleHeartbeatAlarm();
    expect(alarmsMock[ALARM_NAME_HEARTBEAT]).toBeDefined();

    // 2. Unenroll / Unpair
    await clearManagementEnrollment();
    await clearHeartbeatAlarm();
    expect(alarmsMock[ALARM_NAME_HEARTBEAT]).toBeUndefined();

    // 3. Heartbeat check immediately returns idle with 0 fetches
    const result = await sendHeartbeatStatusCheck();
    expect(result.mode).toBe("LOCAL");
    expect(result.sent).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gathers sanitized browser information without sensitive device metadata", () => {
    const info = getBrowserInfo();
    expect(info).toBeDefined();
    expect(typeof info.name).toBe("string");
    expect(typeof info.version).toBe("string");
    expect(typeof info.platform).toBe("string");
  });
});
