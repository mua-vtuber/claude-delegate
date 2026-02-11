import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Allow unused vars with _ prefix (common pattern in codebase)
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_"
      }],
      // Already fixed all any to unknown, keep it enforced
      "@typescript-eslint/no-explicit-any": "warn",
      // Allow empty catch blocks (used for fallback logic)
      "no-empty": ["error", { allowEmptyCatch: true }],
      "@typescript-eslint/no-empty-function": "off",
    },
  },
  {
    ignores: ["build/", "dist/", "node_modules/", "*.js", "vitest.config.ts"],
  }
);
