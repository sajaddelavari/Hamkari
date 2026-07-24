import { defineConfig, devices } from "@playwright/test";

const port = 43177;
const baseURL = `http://127.0.0.1:${port}`;
const useSystemChrome = process.env.PLAYWRIGHT_USE_SYSTEM_CHROME === "1" || process.platform === "win32";

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
      pathTemplate: "{testDir}/__screenshots__/{arg}{ext}"
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
    ...(useSystemChrome ? { channel: "chrome" } : {}),
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
      DATABASE_PATH: ":memory:",
      SESSION_SECRET: "test-session-secret-that-is-longer-than-thirty-two-characters",
      ADMIN_DEV_PASSWORD: "hamkari-dev-admin"
    }
  }
});
