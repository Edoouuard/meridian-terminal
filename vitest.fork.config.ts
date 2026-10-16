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
    // One file at a time: the files share one anvil fork per chain, and several of them sending
    // transactions at once through the same fork stalled it in CI (every Base test timed out together).
    fileParallelism: false,
  },
});
