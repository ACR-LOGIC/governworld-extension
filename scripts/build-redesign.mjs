// Copyright (c) 2026 Andres Chavez Ramirez / ACR LOGIC. All rights reserved.
import * as esbuild from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "redesign", "dist");

mkdirSync(outDir, { recursive: true });

async function build() {
  console.log("Bundling GovernWorld Redesigned Experience...");
  await esbuild.build({
    entryPoints: [join(root, "redesign", "app.ts")],
    bundle: true,
    format: "esm",
    outfile: join(outDir, "redesign-bundle.js"),
    sourcemap: true,
    target: ["chrome114", "firefox115"],
  });
  console.log("✓ Redesign bundle built cleanly to redesign/dist/redesign-bundle.js");
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
