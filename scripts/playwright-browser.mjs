import path from "node:path";

function inferBrowserNameFromExecutablePath(executablePath) {
  const basename = path.basename(executablePath).toLowerCase();

  if (basename.includes("firefox")) return "firefox";
  if (basename.includes("webkit")) return "webkit";

  return "chromium";
}

export function getPlaywrightBrowserConfig() {
  const executablePath = process.env.PLAYWRIGHT_BROWSER_EXECUTABLE_PATH;
  const explicitBrowserName = process.env.PLAYWRIGHT_BROWSER_NAME;
  const inferredBrowserName = executablePath ? inferBrowserNameFromExecutablePath(executablePath) : undefined;

  const browserName = explicitBrowserName ?? inferredBrowserName ?? "chromium";
  const launchOptions = executablePath ? { executablePath } : {};

  return { browserName, launchOptions };
}

