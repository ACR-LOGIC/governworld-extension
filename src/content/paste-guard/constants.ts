// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import type { FindingCategory } from "../../shared/settings.js";

/**
 * Category display labels and secret subtype formatters for the Paste & Prompt Shield.
 */

export const CATEGORY_LABELS: Record<string, string> = {
  email: "Email Address",
  phone: "Phone Number",
  ssn: "SSN",
  dob: "Date of Birth",
  medical_record_number: "Medical Record Number (MRN)",
  member_id: "Member ID",
  npi: "Provider NPI",
  dea: "DEA Number",
  mbi: "Medicare ID (MBI)",
  address: "Street Address",
  payment_card: "Payment Card",
  secrets: "API Key / Secret",
  possible_name: "Personal Name",
  custom: "Custom Pattern",
  canadian_sin: "Canadian SIN",
  uk_nhs: "UK NHS Number",
  aadhaar: "Indian Aadhaar",
  pan_india: "Indian PAN Card",
  australian_tfn: "Australian TFN",
  cpf: "Brazilian CPF",
  ip_address: "IP Address",
  username: "Username",
  bank_account: "Bank Account / Routing Number",
  financial: "Salary / Compensation",
};

/** Specific secret label resolver to make the preview dialog crystal clear */
export function getFindingDisplayName(category: FindingCategory, value?: string): string {
  if (category === "secrets" && value) {
    if (/^sk-ant-/.test(value)) return "Anthropic API Key";
    if (/^sk-[A-Za-z0-9]/.test(value)) return "OpenAI API Key";
    if (/^AIza/.test(value)) return "Google API Key";
    if (/^(?:rk|sk|pk)_(?:live|test)_/.test(value)) return "Stripe API Key";
    if (/^(?:ghp_|github_pat_)/.test(value)) return "GitHub Token";
    if (/^xox[baprs]-/.test(value)) return "Slack Token";
    if (/^SG\./.test(value)) return "SendGrid Key";
    if (/^npm_/.test(value)) return "npm Token";
    if (/^SK[0-9a-fA-F]{32}/.test(value)) return "Twilio Key";
    if (/^dapi-/.test(value)) return "Databricks Token";
    if (/^eyJ/.test(value)) return "JSON Web Token (JWT)";
    if (/BEGIN.*PRIVATE KEY/.test(value)) return "Private Key";
    if (/^(?:postgres|mysql|mongodb|redis|amqp|mssql):/i.test(value)) return "Database Connection String";
  }
  return CATEGORY_LABELS[category] ?? category;
}
