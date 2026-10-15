// Real-browser verification for the invocation surfaces: context menus,
// keyboard shortcuts, and the badge/notification feedback they rely on.
//
// Why this needs a browser rather than a unit test: the whole point of the fix
// is that a context-menu action has no UI to report through. A mocked
// chrome.contextMenus proves the worker reads the reply; it cannot prove the
// reply the content script actually sends, that the counts come back without the
// text, that the badge changes, or that an abandoned marker is cleaned up. Those
// are the claims that would otherwise stay unverified.
//
// Two things genuinely cannot be driven by automation and are NOT asserted
// here: a native right-click menu item, and a browser-level accelerator key.
// Both are dispatched by browser chrome, not the renderer, so Playwright cannot
// synthesise either. What IS verified is the whole chain underneath them: the
// content script's real reply, the worker's consumption of that shape, the badge
// the user would actually see, and recovery from a marker left by a reclaimed
// worker.
//
//   npm run build && node scripts/verify-invocation-feedback.mjs
import { chromium } from "playwright";
import { browserChannelArgs, browserProfileDir, waitForPopupReady } from "./browser-launch.mjs";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(join(root, "dist", "manifest.json"))) {
  console.error("dist/ is missing - run `npm run build` first.");
  process.exit(1);
}

// Synthetic data only: the never-issued SSN and the documented test card.
const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>Invocation fixture</title></head><body>
<h1>Patient intake record</h1>
<p id="pii">Contact jane.doe@example.test, SSN 219-09-9999, card 4111111111111111.</p>
<p id="filler">Ordinary prose with nothing sensitive in it at all.</p>
</body></html>`;

const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(FIXTURE);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

// dist ships with no host_permissions by design (activeTab only). The content
// script has to run on the fixture, so a throwaway copy gets a localhost-only
// entry, exactly as capture-ui and verify-image-capture do. The shipped manifest
// is asserted untouched, and dist/ is never written to.
const shipped = JSON.parse(readFileSync(join(root, "dist", "manifest.json"), "utf8"));
if (shipped.host_permissions?.length) {
  console.error("dist/ ships with host_permissions; aborting rather than testing a different build");
  process.exit(1);
}
const work = mkdtempSync(join(tmpdir(), "gw-invoke-"));
const extDir = join(work, "ext");
rmSync(extDir, { recursive: true, force: true });
mkdirSync(extDir, { recursive: true });
cpSync(join(root, "dist"), extDir, { recursive: true });
const mp = join(extDir, "manifest.json");
const manifestVariant = JSON.parse(readFileSync(mp, "utf8"));
manifestVariant.host_permissions = [`http://127.0.0.1:${port}/*`];
writeFileSync(mp, JSON.stringify(manifestVariant, null, 2));

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

const context = await chromium.launchPersistentContext(browserProfileDir(join(work, "profile")), {
  headless: false,
  ...browserChannelArgs(),
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--no-first-run"],
  permissions: ["clipboard-read", "clipboard-write"],
});
const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker", { timeout: 20_000 }));
const extId = new URL(sw.url()).host;

const workerErrors = [];
sw.on("console", (m) => {
  if (m.type() === "error") workerErrors.push(m.text());
});

const page = await context.newPage();
const popup = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));

await page.goto(`http://127.0.0.1:${port}/`);
await page.bringToFront();

const tabId = await sw.evaluate(async () => {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs[0]?.id ?? null;
});
check("the fixture tab is addressable", typeof tabId === "number", `tabId=${tabId}`);

const SETTINGS = {
  enabledCategories: ["ssn", "payment_card", "email"],
  maxVisibleChars: 200000,
  maxNodeChars: 20000,
  maskPlaceholders: false,
  sessionTimeoutMs: 0,
};

/** Send a message to the fixture exactly as the context-menu handler does. */
const send = async (msg) =>
  await sw.evaluate(
    async ({ tabId, msg }) => {
      try {
        const reply = await chrome.tabs.sendMessage(tabId, msg);
        return { sent: true, keys: Object.keys(reply ?? {}).sort(), reply: reply ?? null };
      } catch (err) {
        return { sent: false, error: String(err) };
      }
    },
    { tabId, msg },
  );

// The context-menu handler injects on demand (sendToTab retries through
// ensureContentScriptReady). Do the same, then confirm the script is live.
await sw.evaluate(
  async ({ tabId }) => {
    try {
      await chrome.tabs.sendMessage(tabId, { type: "PING" });
    } catch {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    }
  },
  { tabId },
);
const ping = await send({ type: "PING" });
check("the content script is live on the fixture", ping.reply?.ok === true, JSON.stringify(ping.reply));

// ---------------------------------------------------------------- content script
console.log("\n1. What the content script actually replies (real page, real injection)");

await page.evaluate(() => {
  const range = document.createRange();
  range.selectNodeContents(document.getElementById("filler"));
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
});
// Collapse it, so the mask handler sees the case that used to fail silently.
await page.evaluate(() => {
  const range = document.createRange();
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
});

const collapsed = await send({
  type: "CONTEXT_MASK_SELECTION",
  requestId: crypto.randomUUID(),
  settings: SETTINGS,
});
console.log(`     collapsed selection -> ${JSON.stringify(collapsed.reply)}`);
check("a collapsed selection is refused, not silently ignored", collapsed.reply?.ok === false, JSON.stringify(collapsed.reply));
check(
  "the refusal carries a reason the worker can surface",
  typeof collapsed.reply?.error === "string" && collapsed.reply.error.length > 0,
  collapsed.reply?.error,
);

await page.evaluate(() => {
  const range = document.createRange();
  range.selectNodeContents(document.getElementById("pii"));
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
});

const redacted = await send({ type: "CONTEXT_REDACT_SELECTION", requestId: crypto.randomUUID(), settings: SETTINGS });
console.log(`     redact selection -> keys=${JSON.stringify(redacted.keys)} counts=${JSON.stringify(redacted.reply?.counts)}`);
check("a real selection is redacted", redacted.reply?.ok === true, JSON.stringify(redacted.reply));
check(
  "the reply carries category counts",
  redacted.reply?.counts && typeof redacted.reply.counts === "object" && Object.keys(redacted.reply.counts).length > 0,
  JSON.stringify(redacted.reply?.counts),
);
check(
  "the reply carries NO page text",
  !redacted.keys.includes("redactedText") && !redacted.keys.includes("text"),
  JSON.stringify(redacted.keys),
);
check(
  "the counts name a category that was actually found",
  ["ssn", "payment_card", "email"].some((c) => (redacted.reply?.counts?.[c] ?? 0) > 0),
  JSON.stringify(redacted.reply?.counts),
);

const clipboard = await page.evaluate(async () => {
  try {
    return { text: await navigator.clipboard.readText() };
  } catch (err) {
    return { error: String(err) };
  }
});
console.log(`     clipboard -> ${JSON.stringify(clipboard).slice(0, 140)}`);
check(
  "the clipboard holds the redacted text, and not the raw value",
  !clipboard.error && clipboard.text.includes("\u2588") && !clipboard.text.includes("219-09-9999"),
  clipboard.error ?? clipboard.text.slice(0, 80),
);

const masked = await send({ type: "CONTEXT_MASK_SELECTION", requestId: crypto.randomUUID(), settings: SETTINGS });
console.log(`     mask selection -> ${JSON.stringify(masked.reply)}`);
check("a real selection is masked", masked.reply?.ok === true, JSON.stringify(masked.reply));

// ------------------------------------------------------------------------ badge
console.log("\n2. The badge marker and its recovery");

const badgeText = async () =>
  await sw.evaluate(async ({ tabId }) => (await chrome.action.getBadgeText({ tabId })) ?? "", { tabId });

const initialBadge = await badgeText();
check("the badge starts empty", initialBadge === "", `"${initialBadge}"`);

// A real scan through the popup, so there is a genuine finding count to restore.
await popup.goto(`chrome-extension://${extId}/popup.html`);
await waitForPopupReady(popup);
await page.bringToFront();
await popup.evaluate(() => document.getElementById("scan-btn")?.click());
let scanStatus = "";
for (let i = 0; i < 60; i++) {
  await popup.waitForTimeout(400);
  scanStatus = await popup.evaluate(
    () => (document.getElementById("status")?.textContent || "").trim().replace(/\s+/g, " ")
  );
  if (scanStatus && !/scanning/i.test(scanStatus)) break;
}
const findingCount = Number(await badgeText());
console.log(`     scan status="${scanStatus}" badge="${findingCount}"`);
check("a scan puts the finding count on the badge", findingCount > 0, `badge="${findingCount}"`);

const auditActions = await sw.evaluate(async () => {
  const raw = await chrome.storage.local.get("auditLog");
  const log = Array.isArray(raw.auditLog) ? raw.auditLog : [];
  return { count: log.length, actions: [...new Set(log.map((e) => e?.action))].sort() };
});
console.log(`     audit log: ${auditActions.count} record(s), actions=${JSON.stringify(auditActions.actions)}`);
check("the scan wrote an audit record", auditActions.count > 0, JSON.stringify(auditActions.actions));
check("it records the scan, counts only", auditActions.actions.includes("page_scan_completed"), JSON.stringify(auditActions.actions));

// `reconcileTabStatuses` cannot be reached from inside the worker: it is an ES
// module and `import()` is disallowed on ServiceWorkerGlobalScope by spec. It is
// therefore invoked from the popup document, which may import a same-origin
// extension URL. That evaluates a second copy of the module in the page context,
// so the listeners it registers are test-only, but the FUNCTION is the shipped
// one and everything it touches — chrome.storage.session, chrome.action — is
// real browser state shared with the live worker. It is a pure function of that
// state, which is exactly what is under test.
const reconcile = async () =>
  await popup.evaluate(async () => {
    try {
      const mod = await import(chrome.runtime.getURL("service-worker.js"));
      if (typeof mod.reconcileTabStatuses !== "function") return { ran: false, reason: "not exported" };
      await mod.reconcileTabStatuses();
      return { ran: true };
    } catch (err) {
      return { ran: false, reason: String(err) };
    }
  });

const strandMarker = async (ttlMs) =>
  await sw.evaluate(
    async ({ tabId, ttlMs }) => {
      await chrome.action.setBadgeText({ tabId, text: "!" });
      await chrome.storage.session.set({ [`action-status:${tabId}`]: Date.now() + ttlMs });
    },
    { tabId, ttlMs },
  );

const readMarker = async () =>
  await sw.evaluate(
    async ({ tabId }) => ({
      text: (await chrome.action.getBadgeText({ tabId })) ?? "",
      key: (await chrome.storage.session.get(`action-status:${tabId}`))[`action-status:${tabId}`],
    }),
    { tabId },
  );

// Expired marker: the worker that wrote it is gone, and its setTimeout died with
// it. Only the persisted deadline can put the badge right.
await strandMarker(-1);
const stranded = await readMarker();
console.log(`     stranded marker -> badge="${stranded.text}" key=${JSON.stringify(stranded.key)}`);
check("the stranded state is real before recovery", stranded.text === "!" && typeof stranded.key === "number");

const ranExpired = await reconcile();
const afterExpired = await readMarker();
console.log(`     reconcile(expired) -> ${JSON.stringify(ranExpired)} badge="${afterExpired.text}" key=${JSON.stringify(afterExpired.key)}`);
check("the stranded marker is reconciled", ranExpired.ran === true, ranExpired.reason ?? "");
check("the stale marker key is cleared", afterExpired.key === undefined, JSON.stringify(afterExpired.key));
check(
  "the finding count is restored, not blanked and not left as '!'",
  afterExpired.text === String(findingCount),
  `badge="${afterExpired.text}" expected="${findingCount}"`,
);

// A LIVE marker must survive reconciliation. Clearing it would drop the only
// record that the badge is showing a failure, leaving a "!" that nothing can
// ever put right — a second stranded marker, created by the fix.
await strandMarker(300_000);
const ranLive = await reconcile();
const afterLive = await readMarker();
console.log(`     reconcile(live) -> ${JSON.stringify(ranLive)} badge="${afterLive.text}" key=${JSON.stringify(afterLive.key)}`);
check(
  "a live marker is NOT wiped by reconciliation",
  afterLive.key !== undefined && typeof afterLive.key === "number",
  JSON.stringify(afterLive.key),
);
check("its badge marker is left on screen", afterLive.text === "!", `badge="${afterLive.text}"`);

// Reconciliation must ignore keys it did not write rather than deleting them.
const foreign = await sw.evaluate(async ({ tabId }) => {
  await chrome.storage.session.set({ "some-other-feature:1": { keep: true } });
  await chrome.storage.session.set({ [`action-status:not-a-tab`]: 1 });
  return true;
}, { tabId });
check("a foreign key is staged for the ownership test", foreign === true);

await strandMarker(-1);
await reconcile();
const survivors = await sw.evaluate(async () => {
  const all = await chrome.storage.session.get(null);
  return {
    foreign: all["some-other-feature:1"]?.keep === true,
    malformed: all["action-status:not-a-tab"] === 1,
  };
});
console.log(`     foreign key survived=${survivors.foreign} malformed marker survived=${survivors.malformed}`);
check("an unrelated session key is not deleted", survivors.foreign === true);
check("a marker key with an unusable tab id is not deleted", survivors.malformed === true);

// With no marker present at all, reconciliation must leave a live finding count
// exactly where the scan put it — no-op, not a blanking pass.
await sw.evaluate(
  async ({ tabId, count }) => {
    await chrome.storage.session.remove(["some-other-feature:1", "action-status:not-a-tab"]);
    await chrome.action.setBadgeText({ tabId, text: String(count) });
  },
  { tabId, count: findingCount }
);
const ranClean = await reconcile();
const finalBadge = await badgeText();
console.log(`     reconcile(no marker) -> ${JSON.stringify(ranClean)} badge="${finalBadge}"`);
check("reconciliation is a no-op when no marker is present", ranClean.ran === true, ranClean.reason ?? "");
check("a live finding count is left untouched", finalBadge === String(findingCount), `badge="${finalBadge}"`);

// --------------------------------------------------------------- notifications
console.log("\n3. Notification gating (the badge is the floor, the notice is additive)");

const gating = await sw.evaluate(async () => {
  const granted = await chrome.permissions.contains({ permissions: ["notifications"] });
  const stored = await chrome.storage.local.get("settings");
  return { granted, enabled: stored.settings?.notificationsEnabled === true };
});
console.log(`     notifications granted=${gating.granted} settingEnabled=${gating.enabled}`);
check(
  "a notification is only possible with BOTH the permission and the setting",
  gating.granted === false || gating.enabled === true,
  JSON.stringify(gating),
);
check(
  "the throwaway build does not hold the optional permission by default",
  gating.granted === false,
  JSON.stringify(gating),
);

// ------------------------------------------------------------------------ noise
check("no page errors were raised", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 200));
check("no service-worker console errors were raised", workerErrors.length === 0, workerErrors.join(" | ").slice(0, 200));

await context.close();
server.close();
rmSync(work, { recursive: true, force: true });

console.log(
  failures.length === 0
    ? "\nInvocation feedback: all checks passed."
    : `\nInvocation feedback: ${failures.length} failed: ${failures.join(", ")}`
);
process.exit(failures.length === 0 ? 0 : 1);