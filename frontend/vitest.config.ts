import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    // e2e/ is Playwright's (npm run e2e).
    include: ["src/**/*.test.{ts,tsx}"],
    globals: true,
    pool: "forks",
    fileParallelism: false,
  },
});
