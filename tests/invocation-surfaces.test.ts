// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
//
// Context menus and keyboard shortcuts are the only ways to invoke this
// extension without opening a surface that can report back. That makes them the
// places where a silent failure is most likely and most costly.
//
// The defects this file exists to prevent, all of which shipped:
//
//   1. The context-menu handler awaited `sendToTab` and threw the reply away.
//      `CONTEXT_MASK_SELECTION` returns `{ok:false}` on a collapsed selection,
//      and `mask_selection` was registered for the `page` context — so the entry
//      appeared on every ordinary right-click and did nothing, silently.
//   2. Neither `CONTEXT_REDACT_SELECTION` nor `CONTEXT_MASK_SELECTION` wrote an
//      audit record. Redacting a selection writes content to the user's
//      clipboard; the popup paths audit that, so the invariant held everywhere
//      except the right-click.
//   3. `toggle-masks` returned on a missing session with no signal at all.
//      `notifyPopup` posts to a popup that a keypress never opens.
//   4. Neither manifest declared `_execute_action`, so the popup — the only way
//      into the Document Studio — had no keyboard route at all.
//   5. `manifest.firefox.json` declared its commands with no `suggested_key`,
//      which per MDN makes them user-assignable only: Firefox shipped with no
//      shortcuts whatsoever.
//
// The assertions below are deliberately narrow. They check the CONTRACT, not
// the implementation, so a rewrite that keeps the contract passes.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isAuditAction, AUDIT_ACTIONS } from "../src/shared/audit.js";

const extRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(extRoot, p), "utf8");

const chromium = JSON.parse(read("manifest.json")) as {
  commands?: Record<string, { suggested_key?: Record<string, string>; description?: string }>;
  action?: { default_popup?: string };
};
const firefox = JSON.parse(read("manifest.firefox.json")) as {
  commands?: Record<string, { suggested_key?: Record<string, string>; description?: string }>;
  action?: { default_popup?: string };
  sidebar_action?: { default_panel?: string };
  background?: { service_worker?: unknown; scripts?: string[] };
};

const WORKER = read("src/service-worker/index.ts");
const CONTENT = read("src/content/content.ts");

/** The commands the worker actually handles. */
const HANDLED = ["scan-page", "toggle-masks", "open-side-panel"] as const;

describe("every declared command is implemented", () => {
  for (const [label, manifest] of [
    ["manifest.json", chromium],
    ["manifest.firefox.json", firefox],
  ] as const) {
    it(`${label} declares no command the worker cannot handle`, () => {
      const declared = Object.keys(manifest.commands ?? {}).filter(
        // The reserved command names are dispatched by the browser, not by
        // chrome.commands.onCommand.
        (name) => !name.startsWith("_"),
      );
      expect(declared.sort(), `${label} has an unimplemented command`).toEqual(
        [...HANDLED].sort(),
      );
    });

    it(`${label} declares a command for each handled name`, () => {
      for (const name of HANDLED) {
        expect(manifest.commands?.[name], `${label} is missing "${name}"`).toBeDefined();
        expect(manifest.commands?.[name]?.description, `${label} "${name}" needs a description`).toBeTruthy();
      }
    });

    it(`${label} handles _execute_action, so the popup is keyboard-reachable`, () => {
      // Without this the popup can only be reached by pointing at the toolbar,
      // and the Document Studio has no other entry point at all.
      const cmd = manifest.commands?.["_execute_action"];
      expect(cmd, `${label} must declare _execute_action`).toBeDefined();
      expect(cmd?.description).toBeTruthy();
    });

    it(`${label} binds every command to a key on every platform`, () => {
      // An unbound command is not a shortcut. Per MDN, `default` covers every
      // platform not listed explicitly, so both must be present.
      for (const name of [...HANDLED, "_execute_action"] as const) {
        const key = manifest.commands?.[name]?.suggested_key;
        expect(key?.default, `${label} "${name}" has no default binding`).toBeTruthy();
        expect(key?.mac, `${label} "${name}" has no mac binding`).toBeTruthy();
      }
    });

    it(`${label} binds no two commands to the same key`, () => {
      // A collision is silently resolved by the browser in favour of one
      // command, so the other becomes unreachable and nothing reports it.
      const keys: Array<[string, string | undefined]> = Object.entries(manifest.commands ?? {}).map(
        ([name, cmd]) => [name, cmd.suggested_key?.default],
      );
      const seen = new Map<string, string>();
      const collisions: string[] = [];
      for (const [name, key] of keys) {
        if (!key) continue;
        if (seen.has(key)) collisions.push(`${key}: ${seen.get(key)} and ${name}`);
        else seen.set(key, name);
      }
      expect(collisions, `${label} has colliding shortcuts`).toEqual([]);
    });
  }

  it("Chromium and Firefox bind the same keys for the same commands", () => {
    for (const name of [...HANDLED, "_execute_action"] as const) {
      expect(firefox.commands?.[name]?.suggested_key?.default, `${name}`).toBe(
        chromium.commands?.[name]?.suggested_key?.default,
      );
    }
  });

  it("both packages point their action at the popup _execute_action opens", () => {
    expect(chromium.action?.default_popup).toBe("popup.html");
    expect(firefox.action?.default_popup).toBe("popup.html");
    expect(firefox.sidebar_action?.default_panel).toBe("sidepanel.html");
  });
});

describe("the worker acts on the tab the user acted on", () => {
  it("resolve the target tab rather than falling back to the active one", () => {
    // A right-click does not focus a background tab, and a keyboard shortcut
    // fires in whichever window is focused. Re-resolving "the active tab" can
    // therefore act on a page the user is not looking at.
    expect(WORKER).toMatch(/tab\?\.id \?\? \(await getActiveTab\(\)\)\?\.id/);
  });
});

describe("a context-menu action cannot fail silently", () => {
  it("inspects the content script's reply", () => {
    // The exact defect: `await sendToTab(...)` with the result discarded.
    expect(WORKER).not.toMatch(/await sendToTab\(tabId, msg\);\s*\n\s*\}/);
    expect(WORKER).toMatch(/const response = await sendToTab\(tabId, msg\);/);
  });

  it("distinguishes a refusal from a success", () => {
    expect(WORKER).toMatch(/function actionOk\(/);
    expect(WORKER).toMatch(/function actionError\(/);
  });

  it("surfaces a failure to a surface that exists without a popup", () => {
    // notifyPopup alone cannot work here: nothing is listening.
    expect(WORKER).toMatch(/function reportActionFailure\(/);
    expect(WORKER).toMatch(/function flashTabStatus\(/);
    const failureReports = WORKER.match(/reportActionFailure\(/g) ?? [];
    expect(failureReports.length, "reportActionFailure is never called").toBeGreaterThan(1);
  });

  it("cannot strand the marker when the worker is reclaimed", () => {
    // MV3 terminates an idle worker at will. A marker whose only expiry is a
    // setTimeout would leave a "!" on the toolbar for the rest of the browser
    // session — a different kind of lie than the one it replaced.
    expect(WORKER).toMatch(/function reconcileTabStatuses\(/);
    expect(WORKER).toMatch(/void reconcileTabStatuses\(\);/);
    expect(WORKER).toMatch(/persistTabStatus/);
  });

  it("restores the finding count rather than blanking the badge", () => {
    // The badge normally shows how many findings the scan found. A status
    // marker must not leave it empty when a scan is still live.
    expect(WORKER).toMatch(/function restoreFindingBadge\(/);
    expect(WORKER).toMatch(/updateBadgeForTab\(tabId, session\.findings\.length\)/);
  });

  it("only reconciles markers whose deadline has passed", () => {
    // The first version removed EVERY key with the marker prefix, which dropped
    // live markers too — and a live marker's key is the only record that the
    // badge is showing a failure, so removing it produced a second stranded
    // marker, this time one nothing could ever clear. Proven by
    // scripts/verify-invocation-feedback.mjs in a real browser.
    const reconcile = WORKER.match(/export async function reconcileTabStatuses\(\)[\s\S]*?\n\}/);
    expect(reconcile).toBeTruthy();
    const body = reconcile?.[0] ?? "";
    expect(body, "expired markers must be filtered on their deadline").toMatch(/value <= now/);
    expect(body, "only expired keys may be removed").toMatch(/expiredKeys\.push\(key\)/);
    expect(body).not.toMatch(/const keys: string\[\]/);
  });

  it("deletes no session key it did not write", () => {
    // chrome.storage.session is shared state, not private to this module.
    const reconcile = WORKER.match(/export async function reconcileTabStatuses\(\)[\s\S]*?\n\}/);
    expect(reconcile?.[0]).toMatch(/garbageKeys\.push\(key\)/);
    expect(reconcile?.[0]).not.toMatch(/storage\.session\.remove\(keys\)/);
  });

  it("never puts page-derived content in the failure message", () => {
    // The message is what reaches a notification and the console. It must be a
    // fixed string or a length-capped refusal reason, never page text.
    expect(WORKER).toMatch(/error\.length <= 200/);
  });

  it("reports the toggle-masks shortcut's no-session case", () => {
    expect(WORKER).toMatch(/No scan on this tab yet\. Run a scan first\./);
  });

  it("does not offer a mask action where no selection can exist", () => {
    // `page` context means every right-click, and the handler reads
    // window.getSelection(), which is collapsed there.
    const create = WORKER.match(/id: "mask_selection"[^;]+;/);
    expect(create).toBeTruthy();
    expect(create?.[0]).toContain('contexts: ["selection"]');
    expect(create?.[0]).not.toContain('"page"');
  });

  it("does not claim to mask an element it never masks", () => {
    expect(WORKER).not.toContain("Mask selected text / element");
    for (const doc of ["README.md", "PERMISSIONS.md", "CHROMEWEBSTORE.md", "STORE_DESCRIPTION.md"]) {
      expect(read(doc), `${doc} still claims element masking`).not.toContain("Mask selected text / element");
    }
  });
});

describe("every context-menu redaction is audited", () => {
  for (const [messageType, action] of [
    ["CONTEXT_REDACT_SELECTION", "selection_redacted"],
    ["CONTEXT_MASK_SELECTION", "selection_masked"],
  ] as const) {
    it(`${messageType} writes a "${action}" record`, () => {
      expect(WORKER).toMatch(new RegExp(`type: "${messageType}"[\\s\\S]{0,1200}action: "${action}"`));
    });

    it(`"${action}" is an action the audit validator accepts`, () => {
      // The two hand-maintained lists used to drift: an action in the union but
      // not in the validator typechecked and was then silently dropped, so the
      // operation looked audited and was not.
      expect(isAuditAction(action)).toBe(true);
      expect(AUDIT_ACTIONS).toContain(action);
    });
  }

  it("records the outcome, so a refused action is not logged as a success", () => {
    expect(WORKER).toMatch(/action: "selection_redacted"[\s\S]{0,300}outcome: error \? "error" : "ok"/);
    expect(WORKER).toMatch(/action: "selection_masked"[\s\S]{0,300}outcome: error \? "error" : "ok"/);
  });

  it("records category counts rather than the redacted text", () => {
    expect(CONTENT).toMatch(/sendResponse\(\{ ok: true, counts \}\);/);
    expect(CONTENT).not.toMatch(/sendResponse\(\{ ok: true, redactedText/);
    // The clipboard is where the user asked for the text to go; returning it
    // over the message boundary put it on a second path with no consumer.
    expect(WORKER).not.toContain("redactedText");
  });

  it("re-validates counts read back off a message boundary", () => {
    expect(WORKER).toMatch(/function actionCounts\(/);
  });

  it("carries no value-bearing field into the audit record", () => {
    const block = WORKER.match(/action: "selection_redacted"[\s\S]{0,400}outcome: error \? "error" : "ok"/);
    expect(block?.[0]).not.toMatch(/selectionText|text:|value:/);
  });
});