import { defineConfig, devices } from "@playwright/test";

const port = 43177;
const baseURL = `http://127.0.0.1:${port}`;
// Visual baselines must use Playwright's pinned Chromium revision on every OS.
// A system Chrome can still be selected explicitly for local exploratory runs,
// but it must never be the implicit snapshot renderer.
const useSystemChrome = process.env.PLAYWRIGHT_USE_SYSTEM_CHROME === "1";
const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH?.trim();
const browserChannel = executablePath
  ? undefined
  : (useSystemChrome ? "chrome" : "chromium");
// The original baselines predate platform suffixes and are retained for
// Windows. Linux CI has its own goldens because text rasterization is an
// operating-system concern even when the Chromium revision is identical.
const snapshotPlatformSuffix = process.platform === "win32" ? "" : `-${process.platform}`;

export default defineConfig({
  testDir: "./test/e2e",
  timeout: 30_000,
  expect: {
    timeout: 7_000,
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: 0.02,
      threshold: 0.2,
      stylePath: "./test/e2e/visual-stability.css",
      pathTemplate: `{testDir}/__screenshots__/{arg}${snapshotPlatformSuffix}{ext}`
    }
  },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }]
  ],
  use: {
    ...devices["Desktop Chrome"],
    // `chromium` opts in to Playwright's pinned full browser and the new
    // headless renderer. This keeps CI aligned with real Chrome rendering
    // instead of the legacy, separately-built headless shell.
    ...(browserChannel ? { channel: browserChannel } : {}),
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
    baseURL,
    locale: "fa-IR",
    timezoneId: "Asia/Tehran",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off"
  },
  webServer: {
    command: "node server.js",
    url: `${baseURL}/healthz`,
    timeout: 30_000,
    reuseExistingServer: false,
    env: {
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_ORIGIN: baseURL,
      TRUST_PROXY: '127.0.0.1/32',
      DATABASE_PATH: ":memory:",
      SESSION_SECRET: "test-session-secret-that-is-longer-than-thirty-two-characters",
      ADMIN_DEV_PASSWORD: "hamkari-dev-admin"
    }
  }
});
