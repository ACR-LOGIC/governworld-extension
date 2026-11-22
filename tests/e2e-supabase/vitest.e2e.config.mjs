// Copyright (c) 2026 Andres Chavez Ramirez. All rights reserved.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/e2e-supabase/**/*.e2e.spec.ts"],
    exclude: ["node_modules", "dist"],
    pool: "forks",
    maxWorkers: 1,
    forks: {
      maxForks: 1,
    },
    testTimeout: 90_000,
    hookTimeout: 60_000,
  },
});
