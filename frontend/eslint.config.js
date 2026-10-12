import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "dist-e2e", "node_modules", "coverage", "test-results", "playwright-report", "public/sw.js", "public/boot"] },
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended, jsxA11y.flatConfigs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // autoFocus is only used where focus follows the user's own action —
      // a dialog opening, inline edit mode, a dropdown's search box — and on
      // the sign-in form. That is the expected place for focus to land.
      "jsx-a11y/no-autofocus": "off",
      // Our own form controls wrap a native input/select one level down.
      "jsx-a11y/label-has-associated-control": ["error", {
        assert: "either",
        controlComponents: ["SelectField", "Select", "EntitySearchSelect"],
        depth: 4,
      }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
  {
    files: ["e2e/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    files: ["src/**/__tests__/**", "src/test/**"],
    languageOptions: { globals: { ...globals.browser, ...globals.node, ...globals.vitest } },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
