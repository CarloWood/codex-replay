import { defineConfig } from "@playwright/test";
import { getPlaywrightBrowserConfig } from "./scripts/playwright-browser.mjs";

const { browserName, launchOptions } = getPlaywrightBrowserConfig();
const hasLaunchOptions = Object.keys(launchOptions).length > 0;

export default defineConfig({
  testDir: "test/e2e",
  timeout: 15000,
  use: {
    browserName,
    headless: true,
    ...(hasLaunchOptions ? { launchOptions } : {}),
  },
});
