import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** Fork tests: real contracts on a local anvil fork (see e2e/*.fork.test.ts). Run with `npm run test:fork`. */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["e2e/**/*.fork.test.ts"],
    testTimeout: 120_000,
  },
});
