// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import * as auditModule from "../shared/audit.js";
import type { ExtensionMessage } from "../shared/types.js";

/**
 * Centralized Service Worker Audit Service (Priority 0, Item 3 & Item 17).
 *
 * Enforces the single-writer audit architecture:
 *   Popup / Sidepanel / Content Script -> Service Worker -> Audit Store
 *
 * Importing this module in the Service Worker designates the current execution
 * context as the authoritative `"service-worker"` writer.
 */
if (typeof auditModule.setAuditWriterRole === "function") {
  auditModule.setAuditWriterRole("service-worker");
}

export async function handlePopupRecordAudit(
  msg: Extract<ExtensionMessage, { type: "POPUP_RECORD_AUDIT" }>
): Promise<void> {
  if (typeof auditModule.writeAuditRecordDirect === "function") {
    await auditModule.writeAuditRecordDirect(msg.event, { failClosed: msg.failClosed });
  } else {
    await auditModule.recordAudit(msg.event, { failClosed: msg.failClosed });
  }
}

export const exportSignedAuditLog = auditModule.exportSignedAuditLog;
export const recordAudit = auditModule.recordAudit;
