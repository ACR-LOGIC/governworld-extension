// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
/**
 * Logic rule submission client.
 * Submits metadata/specification representations ONLY.
 * Hard invariant: NEVER transmits raw user examples, document contents, OCR text, or PHI/PII.
 */

import { GovernWorldApiClient } from "./client.js";
import { hasCapability } from "./capabilities.js";
import { detect, maskValue } from "../content/detect.js";
import { ALL_CATEGORIES } from "../shared/settings.js";
import type { ExtensionCapability, LogicSubmissionRequest, LogicSubmissionResponse } from "./types.js";

export interface SubmissionScreeningFinding {
  field: "rule_name" | "pattern" | "cues" | "description";
  category: string;
  preview: string;
}

export interface SubmissionScreeningResult {
  safe: boolean;
  error?: string;
  maskedFindings: SubmissionScreeningFinding[];
}

/**
 * Screens all submission fields with the local detection engine before any
 * outbound transmission. Fails closed if screening throws or finds sensitive data.
 */
export function screenSubmissionPayload(req: LogicSubmissionRequest): SubmissionScreeningResult {
  const fields: Array<{ name: SubmissionScreeningFinding["field"]; text: string }> = [
    { name: "rule_name", text: req.rule_name ?? "" },
    { name: "pattern", text: req.pattern ?? "" },
    { name: "cues", text: Array.isArray(req.cues) ? req.cues.join(" ") : "" },
    { name: "description", text: req.description ?? "" },
  ];

  const maskedFindings: SubmissionScreeningFinding[] = [];
  try {
    for (const field of fields) {
      if (!field.text.trim()) continue;
      const matches = detect(field.text, ALL_CATEGORIES, []);
      for (const m of matches) {
        const rawVal = field.text.slice(m.start, m.end);
        maskedFindings.push({
          field: field.name,
          category: m.category,
          preview: maskValue(m.category, rawVal),
        });
      }
    }
  } catch {
    return {
      safe: false,
      error: "Submission security screening failed. Submission blocked (fail-closed).",
      maskedFindings: [],
    };
  }

  if (maskedFindings.length > 0) {
    const summary = maskedFindings
      .slice(0, 3)
      .map((f) => `${f.field} (${f.category}: ${f.preview})`)
      .join(", ");
    return {
      safe: false,
      error: `Submission blocked: sensitive content detected in ${summary}. Remove real examples or secrets before sharing.`,
      maskedFindings,
    };
  }

  return { safe: true, maskedFindings: [] };
}

/**
 * Validates that a submission payload does not contain raw sensitive document contents.
 */
export function validateSubmissionPayload(req: LogicSubmissionRequest): { valid: boolean; error?: string } {
  if (!req.rule_name || !req.rule_name.trim()) {
    return { valid: false, error: "Rule name is required." };
  }
  if (!req.pattern || !req.pattern.trim()) {
    return { valid: false, error: "Regex pattern is required." };
  }
  if (!req.category || !req.category.trim()) {
    return { valid: false, error: "Category is required." };
  }

  // Verify pattern is valid regex
  try {
    new RegExp(req.pattern);
  } catch {
    return { valid: false, error: "Invalid regular expression pattern." };
  }

  return { valid: true };
}

export interface SubmitLogicOptions {
  capabilities?: ExtensionCapability[];
  requireCapability?: boolean;
}

/**
 * Submits an authorized logic rule specification to the GovernWorld review pipeline.
 * Enforces gateway capability, schema validation, pre-send local detector screening,
 * and a strict allowlist payload builder.
 */
export async function submitLogic(
  client: GovernWorldApiClient,
  submission: LogicSubmissionRequest,
  token?: string,
  options?: SubmitLogicOptions
): Promise<{ ok: true; response: LogicSubmissionResponse } | { ok: false; error: string; maskedFindings?: SubmissionScreeningFinding[] }> {
  if (options?.requireCapability || options?.capabilities !== undefined) {
    if (!hasCapability(options?.capabilities, "logic_submission")) {
      return {
        ok: false,
        error: "Gateway authorization required: logic_submission capability is not enabled for this workspace.",
      };
    }
  }

  const check = validateSubmissionPayload(submission);
  if (!check.valid) {
    return { ok: false, error: check.error ?? "Invalid submission" };
  }

  const screening = screenSubmissionPayload(submission);
  if (!screening.safe) {
    return {
      ok: false,
      error: screening.error ?? "Submission blocked by security screening.",
      maskedFindings: screening.maskedFindings,
    };
  }

  // Strict allowlist payload builder: never forward raw form object properties.
  const sanitizedPayload: LogicSubmissionRequest = {
    rule_name: submission.rule_name.trim(),
    category: submission.category.trim(),
    pattern: submission.pattern.trim(),
    cues: Array.isArray(submission.cues) ? submission.cues.map((c) => c.trim()).filter(Boolean) : [],
    description: submission.description ? submission.description.trim() : "",
    organization_approved: submission.organization_approved ?? false,
  };

  const result = await client.post<LogicSubmissionResponse>(
    "/api/v1/extension/submissions",
    sanitizedPayload,
    { token, idempotencyKey: crypto.randomUUID() }
  );

  if (!result.ok) {
    return { ok: false, error: result.error.user_message };
  }

  return { ok: true, response: result.data };
}
