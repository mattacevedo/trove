import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts", "dotenv/config"],
    exclude: ["**/node_modules/**", "**/e2e/**"],
    // This repo lives on an iCloud-synced path where spinning up multiple
    // worker processes/threads is slow enough to hit the pool startup timeout.
    // Run test files serially in a single fork — the suite is small and several
    // tests hit a live hosted DB, so serial is both reliable and fine here.
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
});
