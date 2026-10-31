import pluginSecurity from "eslint-plugin-security";

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
];
