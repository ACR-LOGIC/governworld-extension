// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Inline `input-switch-polyfill.css` into `input-switch-polyfill.js` at build time
 * so IIFE extension bundles never execute `fetch(import.meta.resolve(...))` or emit
 * external CSS requests.
 */
export function inputSwitchPolyfillPlugin() {
  return {
    name: "inline-input-switch-polyfill-css",
    setup(build) {
      build.onLoad(
        { filter: /input-switch-polyfill[\\/]input-switch-polyfill\.js$/ },
        (args) => {
          const js = readFileSync(args.path, "utf8");
          const css = readFileSync(
            join(dirname(args.path), "input-switch-polyfill.css"),
            "utf8",
          );
          const fetchPattern =
            /fetch\(\s*import\.meta\.resolve\(['"]\.\/input-switch-polyfill\.css['"]\)\s*\)\s*\.then\(\(r\)\s*=>\s*r\.text\(\)\)/;
          if (!fetchPattern.test(js)) {
            throw new Error(
              `Expected fetch(import.meta.resolve('./input-switch-polyfill.css')) pattern in ${args.path}`,
            );
          }
          const patched = js.replace(
            fetchPattern,
            `Promise.resolve(${JSON.stringify(css)})`,
          );
          return { contents: patched, loader: "js" };
        },
      );
    },
  };
}
