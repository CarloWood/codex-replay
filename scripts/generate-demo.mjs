import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, firefox, webkit } from "playwright";
import { parseTranscript } from "../src/parser.mjs";
import { render } from "../src/renderer.mjs";
import { getTheme } from "../src/themes.mjs";
import { getPlaywrightBrowserConfig } from "./playwright-browser.mjs";

const ROOT_DIR = resolve(new URL("..", import.meta.url).pathname);
const DOCS_DIR = join(ROOT_DIR, "docs");
const DEMO_HTML_PATH = join(DOCS_DIR, "demo.html");
const DEMO_SCREENSHOT_PATH = join(DOCS_DIR, "screenshot-demo.png");

function makeEntry(timestamp, type, payload) {
  return JSON.stringify({ timestamp, type, payload });
}

function buildDemoJsonl() {
  return [
    makeEntry("2026-03-07T09:00:00.000Z", "session_meta", {
      id: "session-demo-20260307",
      timestamp: "2026-03-07T09:00:00.000Z",
      cwd: "~/workspace/codex-replay",
      cli_version: "0.52.0",
      model_provider: "openai",
      source: "cli",
    }),
    makeEntry("2026-03-07T09:00:01.000Z", "event_msg", {
      type: "task_started",
      turn_id: "turn_demo_1",
    }),
    makeEntry("2026-03-07T09:00:01.050Z", "event_msg", {
      type: "user_message",
      message: "Audit the repo instructions, summarize the constraints, and ask for confirmation before editing.",
      images: ["https://example.com/demo-input.png"],
      local_images: ["~/Pictures/spec.png"],
    }),
    makeEntry("2026-03-07T09:00:01.090Z", "turn_context", {
      cwd: "~/workspace/codex-replay",
      model: "gpt-5-codex",
      approval_policy: "never",
    }),
    makeEntry("2026-03-07T09:00:01.160Z", "event_msg", {
      type: "agent_reasoning",
      text: "Checking AGENTS instructions, current repo state, and the e2e coverage before touching any files.",
    }),
    makeEntry("2026-03-07T09:00:01.220Z", "response_item", {
      type: "reasoning",
      summary: [
        {
          type: "summary_text",
          text: "Inspecting repo instructions and the current rollout UI before proposing edits.",
        },
      ],
      content: null,
      encrypted_content: "opaque",
    }),
    makeEntry("2026-03-07T09:00:01.300Z", "response_item", {
      type: "function_call",
      name: "request_user_input",
      arguments: JSON.stringify({
        questions: [
          {
            header: "Scope",
            id: "scope",
            question: "Which scope should I prioritize?",
            options: [
              { label: "Docs first", description: "Focus on the demo and screenshots." },
              { label: "Full polish", description: "Also refine tests and docs." },
            ],
          },
        ],
      }),
      call_id: "call_request_scope",
    }),
    makeEntry("2026-03-07T09:00:01.360Z", "response_item", {
      type: "function_call_output",
      call_id: "call_request_scope",
      output: JSON.stringify({
        answers: {
          scope: "Full polish",
          notes: "Update docs/demo.html and capture a fresh screenshot.",
        },
      }),
    }),
    makeEntry("2026-03-07T09:00:01.430Z", "response_item", {
      type: "function_call",
      name: "exec_command",
      arguments: JSON.stringify({
        cmd: "rg --files codex-replay && sed -n '1,220p' codex-replay/docs/demo.html",
      }),
      call_id: "call_exec_1",
    }),
    makeEntry("2026-03-07T09:00:01.510Z", "response_item", {
      type: "function_call_output",
      call_id: "call_exec_1",
      output: JSON.stringify({
        status: "ok",
        files: ["codex-replay/docs/demo.html", "codex-replay/template/player.html", "codex-replay/playwright.config.mjs"],
      }),
    }),
    makeEntry("2026-03-07T09:00:01.620Z", "event_msg", {
      type: "plan_update",
      explanation: "Gather the current demo, then regenerate it from a stable fixture and capture a screenshot.",
      plan: [
        { status: "completed", step: "Read repo guidance" },
        { status: "completed", step: "Inspect the existing demo asset" },
        { status: "in_progress", step: "Regenerate demo and screenshot" },
      ],
    }),
    makeEntry("2026-03-07T09:00:01.760Z", "event_msg", {
      type: "agent_message",
      message: "I found the current demo asset and will regenerate it from a fixture so the screenshot is reproducible.",
      phase: "commentary",
    }),
    makeEntry("2026-03-07T09:00:01.960Z", "event_msg", {
      type: "task_complete",
      last_agent_message: "Turn one complete.",
    }),
    makeEntry("2026-03-07T09:03:00.000Z", "event_msg", {
      type: "task_started",
      turn_id: "turn_demo_2",
    }),
    makeEntry("2026-03-07T09:03:00.060Z", "event_msg", {
      type: "user_message",
      message: "Render the final demo page with visible tool output, system notices, and a strong hero screenshot.",
      images: [],
      local_images: [],
    }),
    makeEntry("2026-03-07T09:03:00.140Z", "response_item", {
      type: "custom_tool_call",
      name: "generate_demo",
      input: JSON.stringify({
        html: "docs/demo.html",
        screenshot: "docs/screenshot-demo.png",
        theme: "cinder-amber",
      }),
      call_id: "custom_demo_1",
      status: "running",
    }),
    makeEntry("2026-03-07T09:03:00.240Z", "response_item", {
      type: "custom_tool_call_output",
      call_id: "custom_demo_1",
      output: JSON.stringify({
        html: "docs/demo.html",
        screenshot: "docs/screenshot-demo.png",
        viewport: { width: 1480, height: 1280 },
      }),
    }),
    makeEntry("2026-03-07T09:03:00.340Z", "response_item", {
      type: "web_search_call",
      action: "query",
      status: "complete",
    }),
    makeEntry("2026-03-07T09:03:00.460Z", "event_msg", {
      type: "agent_message",
      message: [
        "The demo page now renders as a self-contained replay with bookmarks, filters, tool panels, and system notices visible.",
        "A fresh headless Chromium screenshot was captured from the generated HTML so the docs asset matches the actual UI.",
      ].join("\n\n"),
      phase: "final_answer",
    }),
    makeEntry("2026-03-07T09:03:00.640Z", "event_msg", {
      type: "task_complete",
      last_agent_message: "Demo refresh complete.",
    }),
  ].join("\n");
}

async function captureScreenshot(htmlPath) {
  const { browserName, launchOptions } = getPlaywrightBrowserConfig();
  const browserType = browserName === "firefox" ? firefox : browserName === "webkit" ? webkit : chromium;
  const browser = await browserType.launch({ headless: true, ...launchOptions });
  const page = await browser.newPage({ viewport: { width: 1480, height: 1280 }, deviceScaleFactor: 1.5 });

  try {
    await page.goto(`file://${htmlPath}#turn=2`, { waitUntil: "load" });
    await page.waitForSelector('body[data-ready="1"]');
    await page.locator('.turn-shell[data-index="2"] details[data-kind="custom_tool"]').first().click();
    await page.locator("#btn-prev").click();
    await page.locator('.turn-shell[data-index="1"] details[data-kind="reasoning"]').first().click();
    await page.locator('.turn-shell[data-index="1"] details[data-kind="request_user_input"]').first().click();
    await page.locator('.turn-shell[data-index="1"] details[data-kind="tool_call"]').first().click();
    await page.locator("#btn-next").click();
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await page.waitForTimeout(250);
    await page.screenshot({ path: DEMO_SCREENSHOT_PATH, fullPage: false });
  } finally {
    await browser.close();
  }
}

async function main() {
  const tempDir = mkdtempSync(join(tmpdir(), "codex-replay-demo-"));
  const fixturePath = join(tempDir, "demo-rollout.jsonl");
  writeFileSync(fixturePath, buildDemoJsonl() + "\n");

  const document = parseTranscript(fixturePath);
  const html = render(document, {
    title: "Codex Replay Demo",
    theme: getTheme("cinder-amber"),
    redactSecrets: false,
    bookmarks: [
      { turn: 1, label: "Inspect" },
      { turn: 2, label: "Ship demo" },
    ],
  });

  writeFileSync(DEMO_HTML_PATH, html);
  await captureScreenshot(DEMO_HTML_PATH);

  console.log(`Updated ${DEMO_HTML_PATH}`);
  console.log(`Updated ${DEMO_SCREENSHOT_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
