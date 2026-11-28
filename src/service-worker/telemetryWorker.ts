// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
/**
 * Dedicated isolated execution context for strict telemetry validation.
 * Has ZERO imports or access to DOM, payload storage, OCR, or document memory.
 */

import { validateStrictTelemetryPayload } from "../shared/telemetrySandbox.js";

interface TelemetryWorkerRequest {
  id?: string;
  type?: string;
  payload?: unknown;
}

const workerScope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<TelemetryWorkerRequest>) => void) | null;
  postMessage?: (message: unknown) => void;
};

workerScope.onmessage = (event: MessageEvent<TelemetryWorkerRequest>) => {
  const msg = event?.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "BUILD_AND_VALIDATE") {
    const result = validateStrictTelemetryPayload(msg.payload);
    workerScope.postMessage?.({
      id: msg.id ?? null,
      ...result,
    });
  }
};
