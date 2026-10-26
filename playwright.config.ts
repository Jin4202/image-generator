import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  // Production stack (no dev on-demand compile race, see docs/blockers.md). Kept at 1 because all specs share one stack
  // whose global active-run cap is 1: parallel full-flow runs would make submit order nondeterministic.
  workers: 1,
  retries: 0,
  use: { baseURL: "http://127.0.0.1:3100", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Health returns 200 only once the isolated, migrated database opens.
  webServer: { command: "npx tsx scripts/e2e-stack.ts", url: "http://127.0.0.1:3100/api/health", reuseExistingServer: false, timeout: 300_000, gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 }, stdout: "pipe", stderr: "pipe" },
});
