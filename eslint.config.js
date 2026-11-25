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
