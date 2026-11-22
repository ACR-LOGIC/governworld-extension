// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
/**
 * Playwright Chromium extension driver for GovernWorld Supabase Pairing E2E tests.
 * - Launches unpacked `dist/` or ephemeral-key `tmpdir()` bundles under `--headless=new` (or `--headed`).
 * - Intercepts `https://lkgcehdwasewwoieyoip.supabase.co/**` in `--mode=mock` to forward MV3 SW fetches.
 * - Captures all wire-level requests for A20 zero-egress and A11 canary leak assertions.
 */

import { chromium, type BrowserContext, type Locator, type Page, type Worker } from "@playwright/test";
import { build as esbuildBuild, type Plugin } from "esbuild";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HELPERS_DIR = dirname(fileURLToPath(import.meta.url));
const RELATIVE_ROOT = resolve(HELPERS_DIR, "..", "..", "..");
const ROOT = existsSync(join(RELATIVE_ROOT, "package.json")) ? RELATIVE_ROOT : process.cwd();
const DEFAULT_DIST_DIR = join(ROOT, "dist");

export const SUPABASE_ORIGIN = "https://lkgcehdwasewwoieyoip.supabase.co";

export const CANARY_SECRETS = {
  ssn: "219-09-9999",
  card: "4111111111111111",
  email: "confidential.patient@example.test",
  password: "SecretP@ssw0rd!2026",
  diagnosis: "Acute Myocardial Infarction",
  secretKey: "AKIAIOSFODNN7EXAMPLE",
  customId: "CANARY-CUST-99482",
  phiToken: "CANARY-PHI-SECRET",
} as const;

export interface CapturedWireRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  postData: string | null;
  resourceType: string;
  timestampMs: number;
}

export interface EphemeralKeyBundle {
  dir: string;
  cleanup(): void;
}

export interface LaunchExtensionOptions {
  distDir?: string;
  headed?: boolean;
  mockServerUrl?: string;
  extraHostPermissions?: string[];
}

export interface ProtectionControlsSnapshot {
  modeBadge: string;
  pasteGuardDisabled: boolean | null;
  pasteGuardChecked: boolean | null;
  alwaysOnDisabled: boolean | null;
  alwaysOnChecked: boolean | null;
  presetDisabled: boolean | null;
  presetValue: string | null;
  langDisabled: boolean | null;
  fontSizeDisabled: boolean | null;
  highContrastDisabled: boolean | null;
  dyslexiaDisabled: boolean | null;
  managedLockNoticeVisible: boolean;
  managedLockNoticeText: string;
}

export interface ExtensionDriver {
  readonly context: BrowserContext;
  readonly serviceWorker: Worker;
  readonly extensionId: string;
  readonly profileDir: string;
  openPopup(): Promise<Page>;
  openSidepanel(): Promise<Page>;
  openFixturePage(url: string): Promise<Page>;
  waitForPopupReady(page: Page, timeoutMs?: number): Promise<boolean>;
  navigateToProfileSettings(page: Page): Promise<void>;
  enterPairingCodeInUi(page: Page, code: string): Promise<void>;
  unpairInUi(page: Page): Promise<void>;
  readModeBadge(page: Page): Promise<string>;
  readPairingStatusText(page: Page): Promise<{
    statusText: string;
    errorText: string;
    lockNoticeText: string;
    alertTexts: string[];
  }>;
  getProtectionControlsState(page: Page): Promise<ProtectionControlsSnapshot>;
  getWireRequests(): CapturedWireRequest[];
  clearWireRequests(): void;
  assertZeroSupabaseEgress(requests?: CapturedWireRequest[]): void;
  assertNoCanaryLeaks(requests?: CapturedWireRequest[], extraCanaries?: string[]): void;
  setNetworkOffline(offline: boolean): Promise<void>;
  getAlarms(): Promise<Array<{ name: string; periodInMinutes?: number; scheduledTime: number }>>;
  triggerServiceWorkerAlarm(alarmName: string): Promise<boolean>;
  getStorageLocal(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  setStorageLocal(items: Record<string, unknown>): Promise<void>;
  sendRuntimeMessage<T = unknown>(message: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

const BUNDLE_ENTRIES: Array<{ entry: string; out: string; format: "esm" | "iife" }> = [
  { entry: "src/service-worker/index.ts", out: "service-worker.js", format: "esm" },
  { entry: "src/content/content.ts", out: "content.js", format: "iife" },
  { entry: "src/popup/entry.ts", out: "popup.js", format: "iife" },
  { entry: "src/sidepanel/sidepanel.ts", out: "sidepanel.js", format: "iife" },
  { entry: "src/offscreen/offscreen.ts", out: "offscreen.js", format: "esm" },
  { entry: "src/popup/redact.ts", out: "redact.js", format: "iife" },
  { entry: "src/popup/review.ts", out: "review.js", format: "iife" },
];

export async function buildEphemeralKeyBundle(publicJwk: JsonWebKey): Promise<EphemeralKeyBundle> {
  if (!existsSync(join(DEFAULT_DIST_DIR, "manifest.json"))) {
    throw new Error(`Missing built extension at ${DEFAULT_DIST_DIR}. Run npm run build first.`);
  }

  const outDir = mkdtempSync(join(tmpdir(), "gw-e2e-bundle-"));
  cpSync(DEFAULT_DIST_DIR, outDir, { recursive: true });

  const configPathNormalized = join(ROOT, "src", "api", "config.ts").replace(/\\/g, "/");
  const jwkReplacement = JSON.stringify(publicJwk);

  const ephemeralKeyPlugin: Plugin = {
    name: "gw-ephemeral-public-key",
    setup(build) {
      build.onLoad({ filter: /src[\\/]api[\\/]config\.ts$/ }, (args) => {
        const normalized = args.path.replace(/\\/g, "/");
        if (normalized !== configPathNormalized) return null;
        const source = readFileSync(args.path, "utf8");
        const pattern =
          /export\s+const\s+TRUSTED_POLICY_PUBLIC_KEY_JWK\s*:\s*JsonWebKey\s*=\s*\{[\s\S]*?\};/;
        if (!pattern.test(source)) {
          throw new Error("Could not locate TRUSTED_POLICY_PUBLIC_KEY_JWK in src/api/config.ts");
        }
        const patched = source.replace(
          pattern,
          `export const TRUSTED_POLICY_PUBLIC_KEY_JWK: JsonWebKey = ${jwkReplacement};`,
        );
        return { contents: patched, loader: "ts" };
      });
    },
  };

  for (const { entry, out, format } of BUNDLE_ENTRIES) {
    await esbuildBuild({
      bundle: true,
      sourcemap: false,
      legalComments: "none",
      minify: false,
      target: "chrome109",
      logLevel: "silent",
      entryPoints: [join(ROOT, entry)],
      outfile: join(outDir, out),
      format,
      plugins: [ephemeralKeyPlugin],
    });
  }

  return {
    dir: outDir,
    cleanup() {
      rmSync(outDir, { recursive: true, force: true });
    },
  };
}

export function buildCanaryFixtureHtml(canaries = CANARY_SECRETS): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>GovernWorld E2E Canary Fixture</title>
</head>
<body>
  <main>
    <h1>Patient Intake &amp; Secrets Fixture</h1>
    <p id="canary-ssn">SSN: ${canaries.ssn}</p>
    <p id="canary-card">Card: ${canaries.card}</p>
    <p id="canary-email">Email: ${canaries.email}</p>
    <p id="canary-diagnosis">Diagnosis: ${canaries.diagnosis}</p>
    <p id="canary-key">Secret: ${canaries.secretKey}</p>
    <p id="canary-phi">Token: ${canaries.phiToken}</p>
    <textarea id="paste-target" aria-label="Paste target"></textarea>
  </main>
</body>
</html>`;
}

function resolveChannelOptions(): { executablePath?: string; channel?: "chrome" | "msedge" | "chromium" } {
  const executable = (process.env.GW_BROWSER_EXECUTABLE || "").trim();
  if (executable) return { executablePath: executable };
  const channel = (process.env.GW_BROWSER_CHANNEL || "").trim();
  if (channel === "chrome" || channel === "msedge" || channel === "chromium") {
    return { channel };
  }
  return {};
}

async function firstVisibleLocator(candidates: Locator[]): Promise<Locator | null> {
  for (const loc of candidates) {
    const count = await loc.count().catch(() => 0);
    if (count > 0) {
      const visible = await loc.first().isVisible().catch(() => false);
      if (visible) return loc.first();
    }
  }
  return null;
}

export async function waitForPopupReady(page: Page, timeoutMs = 25_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await page
      .evaluate(() => document.documentElement.dataset.gwReady === "1")
      .catch(() => false);
    if (ready) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

export async function launchExtensionContext(
  options: LaunchExtensionOptions = {},
): Promise<ExtensionDriver> {
  const sourceDistDir = options.distDir ? resolve(options.distDir) : DEFAULT_DIST_DIR;
  if (!existsSync(join(sourceDistDir, "manifest.json"))) {
    throw new Error(`Extension manifest missing at ${sourceDistDir}. Run npm run build first.`);
  }

  let loadedExtDir = sourceDistDir;
  let tempExtWorkDir: string | null = null;
  if (options.extraHostPermissions && options.extraHostPermissions.length > 0) {
    tempExtWorkDir = mkdtempSync(join(tmpdir(), "gw-e2e-ext-"));
    cpSync(sourceDistDir, tempExtWorkDir, { recursive: true });
    const manifestPath = join(tempExtWorkDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      host_permissions?: string[];
    };
    const existingHosts = Array.isArray(manifest.host_permissions) ? manifest.host_permissions : [];
    manifest.host_permissions = [...new Set([...existingHosts, ...options.extraHostPermissions])];
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    loadedExtDir = tempExtWorkDir;
  }

  const externalProfileOverride = (process.env.GW_BROWSER_PROFILE_DIR || "").trim();
  const ownsProfileDir = !externalProfileOverride;
  const profileDir = externalProfileOverride
    ? externalProfileOverride
    : mkdtempSync(join(tmpdir(), "gw-e2e-profile-"));
  if (externalProfileOverride && !existsSync(profileDir)) {
    mkdirSync(profileDir, { recursive: true });
  }

  const isHeaded = options.headed ?? process.env.GW_SUPABASE_E2E_HEADED === "1";
  const args: string[] = [];
  if (!isHeaded) {
    args.push("--headless=new");
  }
  args.push(
    `--disable-extensions-except=${loadedExtDir}`,
    `--load-extension=${loadedExtDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  );

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    ...resolveChannelOptions(),
    args,
    acceptDownloads: true,
    permissions: ["clipboard-read", "clipboard-write"],
  });

  const wireRequests: CapturedWireRequest[] = [];
  let networkOffline = false;

  context.on("request", (req) => {
    let postData: string | null = null;
    try {
      postData = req.postData();
    } catch {
      postData = null;
    }
    wireRequests.push({
      url: req.url(),
      method: req.method(),
      headers: req.headers(),
      postData,
      resourceType: req.resourceType(),
      timestampMs: Date.now(),
    });
  });

  if (options.mockServerUrl) {
    const targetOrigin = options.mockServerUrl.replace(/\/+$/, "");
    await context.route(`${SUPABASE_ORIGIN}/**`, async (route) => {
      if (networkOffline) {
        await route.abort("internetdisconnected");
        return;
      }
      const req = route.request();
      const parsed = new URL(req.url());
      const forwardUrl = `${targetOrigin}${parsed.pathname}${parsed.search}`;
      const incomingHeaders = req.headers();
      const forwardHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(incomingHeaders)) {
        const lower = k.toLowerCase();
        if (lower === "host" || lower === "content-length" || lower === "connection") continue;
        forwardHeaders[k] = v;
      }
      const bodyBuf = req.postDataBuffer();
      try {
        const res = await fetch(forwardUrl, {
          method: req.method(),
          headers: forwardHeaders,
          body:
            bodyBuf && req.method() !== "GET" && req.method() !== "HEAD"
              ? new Uint8Array(bodyBuf)
              : undefined,
        });
        const respBytes = Buffer.from(await res.arrayBuffer());
        const respHeaders: Record<string, string> = {};
        res.headers.forEach((value, key) => {
          respHeaders[key] = value;
        });
        await route.fulfill({
          status: res.status,
          headers: respHeaders,
          body: respBytes,
        });
      } catch {
        await route.abort("failed");
      }
    });
  }

  let sw = context.serviceWorkers()[0];
  if (!sw) {
    sw = await context.waitForEvent("serviceworker", { timeout: 25_000 });
  }
  const extensionId = new URL(sw.url()).host;

  async function navigateToProfileSettings(page: Page): Promise<void> {
    const settingsBtn = page.locator("#tab-btn-settings");
    if ((await settingsBtn.count()) > 0 && (await settingsBtn.isVisible())) {
      await settingsBtn.click();
    }
    const profileNav = page.locator("#settings-nav-profile");
    if ((await profileNav.count()) > 0 && (await profileNav.isVisible())) {
      await profileNav.click();
    }
  }

  return {
    context,
    serviceWorker: sw,
    extensionId,
    profileDir,

    async openPopup(): Promise<Page> {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: "domcontentloaded" });
      const ready = await waitForPopupReady(page, 25_000);
      if (!ready) {
        throw new Error("popup.html did not reach dataset.gwReady === '1' within 25,000 ms");
      }
      return page;
    },

    async openSidepanel(): Promise<Page> {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/sidepanel.html`, { waitUntil: "domcontentloaded" });
      const ready = await waitForPopupReady(page, 25_000);
      if (!ready) {
        throw new Error("sidepanel.html did not reach dataset.gwReady === '1' within 25,000 ms");
      }
      return page;
    },

    async openFixturePage(url: string): Promise<Page> {
      const page = await context.newPage();
      await page.goto(url, { waitUntil: "load" });
      return page;
    },

    waitForPopupReady,
    navigateToProfileSettings,

    async enterPairingCodeInUi(page: Page, code: string): Promise<void> {
      await navigateToProfileSettings(page);
      const input = await firstVisibleLocator([
        page.locator("#supabase-pairing-input"),
        page.locator('[data-testid="pairing-code-input"]'),
        page.locator('input[maxlength="8"]'),
        page.getByPlaceholder(/8-digit|pairing code/i),
        page.getByLabel(/pairing code/i),
      ]);
      if (!input) {
        throw new Error("Could not locate 8-digit pairing code input in extension UI");
      }
      await input.fill(code);

      const submitBtn = await firstVisibleLocator([
        page.locator("#supabase-pair-btn"),
        page.locator('[data-testid="pairing-submit-btn"]'),
        page.locator("#supabase-pairing-form button[type='submit']"),
        page.getByRole("button", { name: /pair device|connect|pair with/i }),
      ]);
      if (!submitBtn) {
        throw new Error("Could not locate pairing submit button in extension UI");
      }
      await submitBtn.click();
    },

    async unpairInUi(page: Page): Promise<void> {
      await navigateToProfileSettings(page);
      const unpairBtn = await firstVisibleLocator([
        page.locator("#supabase-unpair-btn"),
        page.locator('[data-testid="unpair-btn"]'),
        page.getByRole("button", { name: /^unpair/i }),
      ]);
      if (!unpairBtn) {
        throw new Error("Could not locate Unpair button in extension UI");
      }
      await unpairBtn.click();
    },

    async readModeBadge(page: Page): Promise<string> {
      const text = await page.locator("#mode-badge").textContent();
      return (text ?? "").trim();
    },

    async readPairingStatusText(page: Page) {
      const statusLoc = await firstVisibleLocator([
        page.locator("#supabase-pairing-status"),
        page.locator('[data-testid="pairing-status"]'),
        page.locator("#mgmt-status-text"),
      ]);
      const errorLoc = await firstVisibleLocator([
        page.locator("#supabase-pairing-error"),
        page.locator('[data-testid="pairing-error"]'),
      ]);
      const lockLoc = page.locator("#managed-lock-notice");
      const lockVisible = (await lockLoc.count()) > 0 && (await lockLoc.isVisible().catch(() => false));
      const alerts = await page.locator('[role="alert"], [role="status"]').allTextContents();

      return {
        statusText: statusLoc ? ((await statusLoc.textContent()) ?? "").trim() : "",
        errorText: errorLoc ? ((await errorLoc.textContent()) ?? "").trim() : "",
        lockNoticeText: lockVisible ? ((await lockLoc.textContent()) ?? "").trim() : "",
        alertTexts: alerts.map((a) => a.trim()).filter((a) => a.length > 0),
      };
    },

    async getProtectionControlsState(page: Page): Promise<ProtectionControlsSnapshot> {
      const modeBadge = ((await page.locator("#mode-badge").textContent().catch(() => "")) ?? "").trim();

      const readCheckbox = async (sel: string) => {
        const loc = page.locator(sel);
        if ((await loc.count()) === 0) return { disabled: null, checked: null };
        return {
          disabled: await loc.isDisabled().catch(() => null),
          checked: await loc.isChecked().catch(() => null),
        };
      };

      const pasteGuard = await readCheckbox("#paste-guard-toggle");
      const alwaysOn = await readCheckbox("#always-on-toggle");
      const highContrast = await readCheckbox("#high-contrast-toggle");
      const dyslexia = await readCheckbox("#dyslexia-toggle");

      const presetLoc = page.locator("#preset-select");
      const presetExists = (await presetLoc.count()) > 0;
      const langLoc = page.locator("#lang-select");
      const langExists = (await langLoc.count()) > 0;
      const fontLoc = page.locator("#font-size-select");
      const fontExists = (await fontLoc.count()) > 0;

      const lockNotice = page.locator("#managed-lock-notice");
      const lockVisible = (await lockNotice.count()) > 0 && (await lockNotice.isVisible().catch(() => false));
      const lockText = lockVisible ? ((await lockNotice.textContent().catch(() => "")) ?? "").trim() : "";

      return {
        modeBadge,
        pasteGuardDisabled: pasteGuard.disabled,
        pasteGuardChecked: pasteGuard.checked,
        alwaysOnDisabled: alwaysOn.disabled,
        alwaysOnChecked: alwaysOn.checked,
        presetDisabled: presetExists ? await presetLoc.isDisabled().catch(() => null) : null,
        presetValue: presetExists ? await presetLoc.inputValue().catch(() => null) : null,
        langDisabled: langExists ? await langLoc.isDisabled().catch(() => null) : null,
        fontSizeDisabled: fontExists ? await fontLoc.isDisabled().catch(() => null) : null,
        highContrastDisabled: highContrast.disabled,
        dyslexiaDisabled: dyslexia.disabled,
        managedLockNoticeVisible: lockVisible,
        managedLockNoticeText: lockText,
      };
    },

    getWireRequests(): CapturedWireRequest[] {
      return [...wireRequests];
    },

    clearWireRequests(): void {
      wireRequests.length = 0;
    },

    assertZeroSupabaseEgress(requests = wireRequests): void {
      const supabaseCalls = requests.filter((r) => r.url.startsWith(SUPABASE_ORIGIN));
      if (supabaseCalls.length > 0) {
        throw new Error(
          `Expected ZERO requests to ${SUPABASE_ORIGIN} in local_only mode, found ${supabaseCalls.length}: ${supabaseCalls
            .map((r) => `${r.method} ${r.url}`)
            .join(", ")}`,
        );
      }
    },

    assertNoCanaryLeaks(requests = wireRequests, extraCanaries: string[] = []): void {
      const allCanaries = [...Object.values(CANARY_SECRETS), ...extraCanaries];
      for (const req of requests) {
        if (!req.url.startsWith(SUPABASE_ORIGIN)) continue;
        const haystack = [req.url, JSON.stringify(req.headers), req.postData ?? ""].join("\n");
        for (const canary of allCanaries) {
          if (haystack.includes(canary)) {
            throw new Error(
              `CANARY LEAK DETECTED in outbound Supabase request ${req.method} ${req.url}: matched "${canary}"`,
            );
          }
        }
      }
    },

    async setNetworkOffline(offline: boolean): Promise<void> {
      networkOffline = offline;
      await context.setOffline(offline);
    },

    async getAlarms() {
      return await sw.evaluate(async () => {
        const list = await chrome.alarms.getAll();
        return list.map((a) => ({
          name: a.name,
          periodInMinutes: a.periodInMinutes,
          scheduledTime: a.scheduledTime,
        }));
      });
    },

    async triggerServiceWorkerAlarm(alarmName: string): Promise<boolean> {
      return await sw.evaluate(async (name) => {
        const listenerApi = chrome.alarms.onAlarm as unknown as {
          hasListeners?: () => boolean;
          dispatch?: (alarm: chrome.alarms.Alarm) => void;
        };
        if (typeof listenerApi?.dispatch === "function") {
          listenerApi.dispatch({ name, scheduledTime: Date.now(), persistAcrossSessions: true });
          return true;
        }
        return false;
      }, alarmName);
    },

    async getStorageLocal(keys?: string | string[] | null): Promise<Record<string, unknown>> {
      return await sw.evaluate(async (k) => {
        return (await chrome.storage.local.get(k ?? undefined)) as Record<string, unknown>;
      }, keys ?? null);
    },

    async setStorageLocal(items: Record<string, unknown>): Promise<void> {
      await sw.evaluate(async (data) => {
        await chrome.storage.local.set(data);
      }, items);
    },

    async sendRuntimeMessage<T = unknown>(message: Record<string, unknown>): Promise<T> {
      return (await sw.evaluate(async (msg) => {
        return await chrome.runtime.sendMessage(msg);
      }, message)) as T;
    },

    async close(): Promise<void> {
      try {
        await context.close();
      } finally {
        if (ownsProfileDir) {
          rmSync(profileDir, { recursive: true, force: true });
        }
        if (tempExtWorkDir) {
          rmSync(tempExtWorkDir, { recursive: true, force: true });
        }
      }
    },
  };
}
