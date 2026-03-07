import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTranscript, parseTranscriptGroup } from "../../src/parser.mjs";
import { render } from "../../src/renderer.mjs";

const ROLLOUT_FIXTURE = new URL("../fixture-rollout.jsonl", import.meta.url).pathname;
const HISTORY_FIXTURE = new URL("../fixture-history.jsonl", import.meta.url).pathname;
const outputDir = mkdtempSync(join(tmpdir(), "codex-replay-e2e-"));
const cache = new Map();
const groupRootFixture = join(outputDir, "group-root.jsonl");
const groupChildFixture = join(outputDir, "group-child.jsonl");
const autoFollowFixture = join(outputDir, "auto-follow.jsonl");
const duplicateAssistantFixture = join(outputDir, "duplicate-assistant.jsonl");

function buildAutoFollowMessage(index) {
  return [
    `Autoplay block ${index} should stay visible while playback is running, even when the transcript grows enough to require scrolling under the sticky topbar.`,
    `This paragraph intentionally wraps across multiple lines so the replay viewer has to keep following the newest assistant response instead of pinning the turn header to an incorrect position.`,
    "- Keep the newest response block inside the safe viewport.",
    "- Avoid leaving the latest content hidden below the fold.",
    "- Avoid jumping back to an earlier anchor once more blocks arrive.",
  ].join("\n\n");
}

writeFileSync(
  groupRootFixture,
  [
    JSON.stringify({
      timestamp: "2026-03-07T03:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "session-group-root",
        timestamp: "2026-03-07T03:00:00.000Z",
        cwd: "/Users/tester/workspace/grouped-e2e",
        cli_version: "0.52.0",
        model_provider: "openai",
        source: "cli",
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-07T03:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "Root grouped prompt", images: [], local_images: [] },
    }),
    JSON.stringify({
      timestamp: "2026-03-07T03:00:02.000Z",
      type: "event_msg",
      payload: { type: "agent_message", message: "Root grouped answer", phase: "final_answer" },
    }),
    JSON.stringify({
      timestamp: "2026-03-07T03:00:03.000Z",
      type: "event_msg",
      payload: { type: "task_complete", last_agent_message: "Root grouped done" },
    }),
  ].join("\n")
);

writeFileSync(
  groupChildFixture,
  [
    JSON.stringify({
      timestamp: "2026-03-07T03:00:01.500Z",
      type: "session_meta",
      payload: {
        id: "session-group-child",
        timestamp: "2026-03-07T03:00:01.500Z",
        cwd: "/Users/tester/workspace/grouped-e2e",
        cli_version: "0.52.0",
        model_provider: "openai",
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: "session-group-root",
              depth: 1,
            },
          },
        },
        agent_nickname: "Aquinas",
        agent_role: "awaiter",
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-07T03:00:01.600Z",
      type: "event_msg",
      payload: { type: "user_message", message: "Child grouped prompt", images: [], local_images: [] },
    }),
    JSON.stringify({
      timestamp: "2026-03-07T03:00:02.400Z",
      type: "event_msg",
      payload: { type: "agent_message", message: "Child grouped answer", phase: "final_answer" },
    }),
    JSON.stringify({
      timestamp: "2026-03-07T03:00:02.700Z",
      type: "event_msg",
      payload: { type: "task_complete", last_agent_message: "Child grouped done" },
    }),
  ].join("\n")
);

writeFileSync(
  autoFollowFixture,
  [
    JSON.stringify({
      timestamp: "2026-03-07T04:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "session-auto-follow",
        timestamp: "2026-03-07T04:00:00.000Z",
        cwd: "/Users/tester/workspace/auto-follow-e2e",
        cli_version: "0.52.0",
        model_provider: "openai",
        source: "cli",
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-07T04:00:01.000Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn_auto_follow_1" },
    }),
    JSON.stringify({
      timestamp: "2026-03-07T04:00:01.050Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "Play the response and keep the newest block visible.",
        images: [],
        local_images: [],
      },
    }),
    ...Array.from({ length: 8 }, function(_, index) {
      return JSON.stringify({
        timestamp: `2026-03-07T04:00:${String(2 + index).padStart(2, "0")}.000Z`,
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: buildAutoFollowMessage(index + 1),
          phase: index === 7 ? "final_answer" : "commentary",
        },
      });
    }),
    JSON.stringify({
      timestamp: "2026-03-07T04:00:20.000Z",
      type: "event_msg",
      payload: { type: "task_complete", last_agent_message: "Auto follow done." },
    }),
  ].join("\n")
);

writeFileSync(
  duplicateAssistantFixture,
  [
    JSON.stringify({
      timestamp: "2026-03-07T05:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "session-duplicate-assistant-e2e",
        timestamp: "2026-03-07T05:00:00.000Z",
        cwd: "/Users/tester/workspace/duplicate-assistant-e2e",
        cli_version: "0.52.0",
        model_provider: "openai",
        source: "cli",
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-07T05:00:01.000Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn_duplicate_e2e_1" },
    }),
    JSON.stringify({
      timestamp: "2026-03-07T05:00:01.050Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "Only show the merged assistant answer once.",
        images: [],
        local_images: [],
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-07T05:00:01.100Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Merged assistant answer for duplicate coverage." }],
        phase: "message",
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-07T05:00:01.200Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "Merged assistant answer for duplicate coverage.",
        phase: "commentary",
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-07T05:00:01.300Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "Merged assistant answer for duplicate coverage.",
        phase: "final_answer",
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-07T05:00:01.350Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        last_agent_message: "Merged assistant answer for duplicate coverage.",
      },
    }),
  ].join("\n")
);

function buildHtml(key, fixturePath, renderOptions = {}) {
  if (!cache.has(key)) {
    const document = parseTranscript(fixturePath);
    const html = render(document, {
      title: `E2E ${key}`,
      redactSecrets: false,
      ...renderOptions,
    });
    const filePath = join(outputDir, `${key}.html`);
    writeFileSync(filePath, html);
    cache.set(key, filePath);
  }
  return cache.get(key);
}

function buildGroupedHtml(key, fixturePaths, renderOptions = {}) {
  if (!cache.has(key)) {
    const document = parseTranscriptGroup(fixturePaths);
    const html = render(document, {
      title: `E2E ${key}`,
      redactSecrets: false,
      ...renderOptions,
    });
    const filePath = join(outputDir, `${key}.html`);
    writeFileSync(filePath, html);
    cache.set(key, filePath);
  }
  return cache.get(key);
}

export function getRolloutFileUrl(hash = "") {
  const filePath = buildHtml("rollout", ROLLOUT_FIXTURE, {
    bookmarks: [
      { turn: 1, label: "Scope" },
      { turn: 2, label: "Render" },
    ],
  });
  return "file://" + filePath + (hash ? `#${hash}` : "");
}

export function getHistoryFileUrl() {
  return "file://" + buildHtml("history", HISTORY_FIXTURE);
}

export function getGroupedRolloutFileUrl(hash = "") {
  const filePath = buildGroupedHtml("grouped-rollout", [groupRootFixture, groupChildFixture], {
    bookmarks: [{ turn: 2, label: "Child" }],
  });
  return "file://" + filePath + (hash ? `#${hash}` : "");
}

export function getAutoFollowRolloutFileUrl(hash = "") {
  const filePath = buildHtml("auto-follow", autoFollowFixture);
  return "file://" + filePath + (hash ? `#${hash}` : "");
}

export function getDuplicateAssistantFileUrl(hash = "") {
  const filePath = buildHtml("duplicate-assistant", duplicateAssistantFixture);
  return "file://" + filePath + (hash ? `#${hash}` : "");
}

export async function waitForReady(page) {
  await page.waitForSelector('body[data-ready="1"]', { timeout: 5000 });
}
