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
    // worker processes in parallel is slow enough to hit the pool startup
    // timeout. Run test files serially in a forks pool — the suite is small and
    // several tests hit a live hosted DB, so serial is both reliable and fine.
    fileParallelism: false,
    pool: "forks",
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
});
