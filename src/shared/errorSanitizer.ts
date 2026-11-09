// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
/**
 * Privacy-safe error normalization for console and diagnostic logging.
 *
 * Raw Error objects or thrown values may contain:
 *   - local filesystem paths (e.g. C:\Users\..., /Users/..., file:///...)
 *   - document names or URLs with query strings/tokens
 *   - stack traces or raw user content snippets
 *
 * This module extracts only `{ name, message }` with sensitive tokens scrubbed
 * and length bounded, ensuring clean security posture across all extension contexts.
 */

const MAX_LOG_MESSAGE_LENGTH = 160;

/** Patterns that must never appear in console log output. */
const PATH_OR_URL_PATTERNS: Array<[RegExp, string]> = [
  // file:// URLs
  [/file:\/\/\/[^\s"'<>)+]+/gi, "[redacted-path]"],
  // Windows drive paths (e.g., C:\Users\alice\Documents\secret.pdf)
  [/\b[A-Za-z]:\\(?:[^\s\\/:*?"<>|]+\\)*[^\s\\/:*?"<>|]*/g, "[redacted-path]"],
  // Unix home/root paths (e.g., /Users/alice/secret.pdf, /home/user/doc.docx)
  [/(?:^|(?<=[\s(]))\/(?:Users|home|var|tmp|etc|opt|private|mnt)\/[^\s"'<>)+]+/g, "[redacted-path]"],
  // URLs with query strings or credentials
  [/https?:\/\/[^\s"'<>)+]+\?[^\s"'<>)+]+/gi, "[redacted-url]"],
  // Query strings (e.g. ?token=secret_123, &secret=...)
  [/[?&][A-Za-z0-9_.-]+=[^\s"'<>)+]*/g, "?[redacted-query]"],
  // Email addresses
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[redacted-email]"],
  // Bearer or API tokens
  [/\b(?:Bearer\s+|sk-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{10,}|gw_free_[A-Za-z0-9]+)[^\s"']*/gi, "[redacted-token]"],
];

export interface SanitizedErrorInfo {
  name: string;
  message: string;
}

/**
 * Scrubs paths, URLs with query strings, emails, and stack traces from an error message.
 */
export function scrubSensitiveErrorText(raw: string): string {
  // Take only the first line so multi-line stack traces are stripped immediately
  let cleaned = raw.split(/\r?\n/)[0]?.trim() ?? "";
  for (const [pattern, replacement] of PATH_OR_URL_PATTERNS) {
    cleaned = cleaned.replace(pattern, replacement);
  }
  if (cleaned.length > MAX_LOG_MESSAGE_LENGTH) {
    cleaned = `${cleaned.slice(0, MAX_LOG_MESSAGE_LENGTH)}...`;
  }
  return cleaned;
}

/**
 * Extracts a safe `{ name, message }` representation of any caught error or rejection reason.
 */
export function extractSafeError(err: unknown): SanitizedErrorInfo {
  if (err instanceof Error) {
    return {
      name: err.name || "Error",
      message: scrubSensitiveErrorText(err.message || "An unexpected error occurred."),
    };
  }
  if (typeof err === "string") {
    return {
      name: "Error",
      message: scrubSensitiveErrorText(err),
    };
  }
  if (typeof err === "object" && err !== null) {
    const record = err as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "Error";
    const message =
      typeof record.message === "string"
        ? scrubSensitiveErrorText(record.message)
        : typeof record.userMessage === "string"
        ? scrubSensitiveErrorText(record.userMessage)
        : "An unexpected error occurred.";
    return { name, message };
  }
  return {
    name: "Error",
    message: "An unexpected error occurred.",
  };
}

/**
 * Formats a clean, single-line error string suitable for console.warn / console.error.
 */
export function sanitizeErrorForLog(err: unknown): string {
  const safe = extractSafeError(err);
  return `${safe.name}: ${safe.message}`;
}
