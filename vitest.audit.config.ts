import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** On-chain address audit (report only, needs RPC access): `npm run audit:onchain`. */
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: { environment: "node", include: ["e2e/**/*.audit.test.ts"], testTimeout: 600_000 },
});
