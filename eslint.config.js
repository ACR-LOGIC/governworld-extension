import pluginSecurity from "eslint-plugin-security";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      "dist/**",
      "dist-firefox/**",
      "dist-safari/**",
      "node_modules/**",
      ".tmp*/**",
      "coverage/**",
      "vendor/**",
    ],
  },
  {
    files: ["scripts/**/*.{js,mjs}", "*.{js,mjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    plugins: {
      security: pluginSecurity,
    },
    rules: {
      ...pluginSecurity.configs.recommended.rules,
      "security/detect-non-literal-fs-filename": "off",
      "security/detect-object-injection": "off",
      "security/detect-non-literal-regexp": "off",
      "security/detect-unsafe-regex": "off",
    },
  },
  // TypeScript sources: the TS6 programmatic API via the typescript-eslint
  // parser, plus the security rules promoted to error. TS tracking:
  // typescript-eslint#10940 is still open as of 2026-11 — the maintainer says
  // "we're still waiting for the API to release" (2026-04); WIP TS 7.1 support
  // exists with `projectService.EXPERIMENTAL_backend` since typescript-eslint
  // 8.73.0 (2026-11), and TS 7.1 beta shipped 2026-10 with a new programmatic
  // API. So the `typescript` package here is the TS6 compatibility alias while
  // `@typescript/native` carries the native TS7 compiler; switch when a
  // typescript-eslint release states TS 7 support.
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      security: pluginSecurity,
    },
    rules: {
      // Promoted from the plugin's recommended `warn` to `error` for src.
      // Each finding was fixed or annotated with an eslint-disable-next-line
      // comment; the codebase runs lint as a gate, so the findings it can
      // prove are safe stay visible and promote when new ones are introduced.
      "security/detect-object-injection": "error",
      "security/detect-unsafe-regex": "error",
      "security/detect-non-literal-regexp": "error",
    },
  },
];
