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
  // parser, plus the same security rules the scripts get. Typescript 7 ships
  // no compiler API for tooling yet (see typescript-eslint#10940), so the
  // `typescript` package here is the TS6 compatibility alias while
  // `@typescript/native` carries the native TS7 compiler for the tsc command.
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
      // Promoted from the plugin's recommended `warn` to `error` for src:
      // src/** now lints the regex findings (each has a disable comment
      // justified by an existing runtime guard), so the only findings left
      // at warn are object-injection.
      "security/detect-unsafe-regex": "error",
      "security/detect-non-literal-regexp": "error",
      // Left at the plugin's recommended `warn`: dynamic property access
      // (`obj[key]`, `arr[i]`) is the idiomatic TypeScript pattern used
      // throughout detection code. Promoting it to error would require a
      // sweeping rewrite of the detection engine rather than a focused
      // pass, so it is downgraded to warn with the rest of the plugin's
      // recommended level and a full fix pass is flagged for follow-up.
      "security/detect-object-injection": "warn",
    },
  },
];
