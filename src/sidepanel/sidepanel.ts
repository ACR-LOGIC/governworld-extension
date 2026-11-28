// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { initPopup } from "../popup/popup.js";
import { ensureInvokerPolyfill, ensureSwitchPolyfill } from "../shared/webPlatformPolyfills.js";

ensureInvokerPolyfill();
ensureSwitchPolyfill();

async function initPanel(): Promise<void> {
  await initPopup();
}

void initPanel();
