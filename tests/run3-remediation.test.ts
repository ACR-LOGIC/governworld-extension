import { describe, expect, it, vi } from "vitest";
import { screenSubmissionPayload, submitLogic } from "../src/api/submissions.js";
import { GovernWorldApiClient } from "../src/api/client.js";
import { getDisplayCategoryLabel } from "../src/shared/i18n.js";
import { sendHeartbeatStatusCheck } from "../src/service-worker/heartbeatService.js";
import { saveManagementEnrollment, clearManagementEnrollment } from "../src/shared/managedPolicy.js";

describe("Run 3 Remediation Regression Tests", () => {
  it("Fix #2: screenSubmissionPayload blocks sensitive content and submitLogic prevents outbound POST", async () => {
    const unsafe = screenSubmissionPayload({
      rule_name: "Patient John SSN 123-45-6789",
      category: "ssn",
      pattern: "\\b\\d{3}-\\d{2}-\\d{4}\\b",
      cues: ["ssn"],
      description: "Detect SSN like 123-45-6789",
    });
    expect(unsafe.safe).toBe(false);
    expect(unsafe.maskedFindings.length).toBeGreaterThan(0);

    const postSpy = vi.fn();
    const fakeClient = { post: postSpy } as unknown as GovernWorldApiClient;

    // 1. Blocked by missing capability
    const noCap = await submitLogic(
      fakeClient,
      { rule_name: "Safe Rule", category: "custom", pattern: "ABC-[0-9]{4}", cues: [], description: "Safe pattern" },
      "tok",
      { capabilities: ["policy_sync"], requireCapability: true }
    );
    expect(noCap.ok).toBe(false);
    expect(postSpy).not.toHaveBeenCalled();

    // 2. Blocked by pre-send detector screening
    const blocked = await submitLogic(
      fakeClient,
      {
        rule_name: "Safe Rule",
        category: "custom",
        pattern: "ABC-[0-9]{4}",
        cues: [],
        description: "Contact alice@example.com for details",
      },
      "tok",
      { capabilities: ["logic_submission"], requireCapability: true }
    );
    expect(blocked.ok).toBe(false);
    expect(postSpy).not.toHaveBeenCalled();
  });

  it("Fix #6: getDisplayCategoryLabel maps medical entityTypes instead of MRN", () => {
    expect(getDisplayCategoryLabel("en", "medical_record_number", "medical_condition")).toBe("Medical Condition");
    expect(getDisplayCategoryLabel("en", "medical_record_number", "diagnosis")).toBe("Medical Condition");
    expect(getDisplayCategoryLabel("en", "medical_record_number", "medication")).toBe("Medication");
    expect(getDisplayCategoryLabel("en", "medical_record_number", "prescription")).toBe("Medication");
    expect(getDisplayCategoryLabel("en", "medical_record_number", "medication:metformin")).toBe("Medication");
    expect(getDisplayCategoryLabel("en", "medical_record_number", "medical_procedure")).toBe("Medical Procedure");
    expect(getDisplayCategoryLabel("en", "medical_record_number", "medical_term")).toBe("Medical Term");
    expect(getDisplayCategoryLabel("en", "medical_record_number", "mrn")).toContain("Medical record number");
  });

  it("Fix #8: heartbeatService does not default to http://127.0.0.1:4820 when coordinator_url is unset", async () => {
    const store: Record<string, unknown> = {};
    (globalThis as Record<string, unknown>).chrome = {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: store[key] })),
          set: vi.fn(async (obj: Record<string, unknown>) => Object.assign(store, obj)),
          remove: vi.fn(async (key: string) => {
            delete store[key];
          }),
        },
      },
    };
    const fetchSpy = vi.fn();
    (globalThis as Record<string, unknown>).fetch = fetchSpy;

    await saveManagementEnrollment({
      organization_id: "org_1",
      employee_id: "emp_1",
      device_id: "00000000-0000-4000-8000-000000000001",
      enrolled_at: new Date().toISOString(),
      management_mode: "MANAGE",
    });

    const res = await sendHeartbeatStatusCheck();
    expect(res.sent).toBe(false);
    expect(res.status).toBe("idle");
    expect(res.error).toContain("coordinator not configured");
    expect(fetchSpy).not.toHaveBeenCalled();

    await clearManagementEnrollment();
  });
});
