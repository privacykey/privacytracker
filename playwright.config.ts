import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const e2eDataDir = path.join(process.cwd(), ".playwright-data");
const browserChannel =
  process.env.PLAYWRIGHT_BROWSER_CHANNEL ||
  (process.platform === "darwin" && !process.env.CI ? "chrome" : undefined);
process.env.PRIVACYTRACKER_DATA_DIR = e2eDataDir;
process.env.NEXT_TELEMETRY_DISABLED = "1";

export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  // The whole suite shares a single Next.js server and a single SQLite
  // file under .playwright-data. Several specs reconfigure global state
  // (focus, privacy profile, app-store data) via /api/reset, /api/focus,
  // and /api/privacy-profile — running them in parallel workers would
  // race those mutations and produce flaky failures (for example, a
  // reset from one spec wiping the audience another spec just set up).
  // The suite is small enough (~30 s end-to-end on workers=1) that the
  // parallelism trade-off isn't worth the brittleness.
  workers: 1,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"]],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command:
      "rm -rf .playwright-data && mkdir -p .playwright-data && npm run build && HOSTNAME=127.0.0.1 npm start",
    url: "http://127.0.0.1:3000/api/ready",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      PRIVACYTRACKER_DATA_DIR: e2eDataDir,
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(browserChannel ? { channel: browserChannel } : {}),
      },
    },
  ],
});
