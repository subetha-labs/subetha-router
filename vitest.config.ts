import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "tests/**/*.test.ts",
      // P-2 source equality and dependency/signing gates belong to root verification.
      "packages/payer/test/unit/sign.test.ts",
      "packages/payer/test/unit/vendor.test.ts",
    ],
  },
});
