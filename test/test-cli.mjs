import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const REPO_DIR = new URL("..", import.meta.url).pathname;
const BIN_PATH = new URL("../bin/codex-replay.mjs", import.meta.url).pathname;

function writeRolloutFile(filePath, payload) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    [
      JSON.stringify({
        timestamp: payload.timestamp,
        type: "session_meta",
        payload: {
          id: payload.id,
          timestamp: payload.timestamp,
          cwd: payload.cwd,
          model_provider: "openai",
          source:
            payload.parent_thread_id
              ? {
                  subagent: {
                    thread_spawn: {
                      parent_thread_id: payload.parent_thread_id,
                      depth: 1,
                    },
                  },
                }
              : "cli",
          agent_nickname: payload.agent_nickname,
          agent_role: payload.agent_role,
        },
      }),
      JSON.stringify({
        timestamp: payload.user_message_timestamp ?? payload.timestamp,
        type: "event_msg",
        payload: {
          type: "user_message",
          message: payload.prompt,
          images: [],
          local_images: [],
        },
      }),
      JSON.stringify({
        timestamp: payload.answer_timestamp ?? payload.timestamp,
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: payload.answer,
          phase: "final_answer",
        },
      }),
      JSON.stringify({
        timestamp: payload.complete_timestamp ?? payload.timestamp,
        type: "event_msg",
        payload: {
          type: "task_complete",
          last_agent_message: payload.done ?? payload.answer,
        },
      }),
    ].join("\n")
  );
}

function createCodexHome() {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-replay-cli-"));
  mkdirSync(join(codexHome, "sessions", "2026", "03", "07"), { recursive: true });

  writeFileSync(
    join(codexHome, "history.jsonl"),
    [
      JSON.stringify({
        session_id: "session-rollout",
        ts: "2026-03-07T10:20:00.000Z",
        text: "Linked history prompt",
      }),
      JSON.stringify({
        session_id: "session-hist",
        ts: "2026-03-07T10:10:00.000Z",
        text: "History-only prompt",
      }),
      JSON.stringify({
        session_id: "session-hist",
        ts: "2026-03-07T10:11:00.000Z",
        text: "History-only second prompt",
      }),
    ].join("\n") + "\n"
  );

  writeRolloutFile(
    join(codexHome, "sessions", "2026", "03", "07", "rollout-2026-03-07T10-00-00-root.jsonl"),
    {
      id: "session-rollout",
      cwd: "/Users/example/project-cli",
      timestamp: "2026-03-07T10:00:00.000Z",
      prompt: "CLI rollout prompt",
      answer: "CLI rollout answer",
      done: "done",
    }
  );

  writeRolloutFile(
    join(codexHome, "sessions", "2026", "03", "07", "rollout-2026-03-07T10-01-00-child.jsonl"),
    {
      id: "session-child",
      cwd: "/Users/example/project-cli",
      timestamp: "2026-03-07T10:01:00.000Z",
      parent_thread_id: "session-rollout",
      agent_nickname: "Aquinas",
      agent_role: "awaiter",
      prompt: "Child rollout prompt",
      answer: "Child rollout answer",
      done: "child done",
    }
  );

  writeRolloutFile(
    join(codexHome, "sessions", "2026", "03", "07", "rollout-2026-03-07T09-00-00-orphan.jsonl"),
    {
      id: "session-orphan",
      cwd: "/Users/example/project-orphan",
      timestamp: "2026-03-07T09:00:00.000Z",
      prompt: "Orphan rollout prompt",
      answer: "Orphan rollout answer",
      done: "orphan done",
    }
  );

  return codexHome;
}

function runCli(args, input = "") {
  return spawnSync(process.execPath, [BIN_PATH, ...args], {
    cwd: REPO_DIR,
    encoding: "utf-8",
    input,
  });
}

describe("codex-replay CLI", () => {
  it("renders the selected history-only session from the picker", () => {
    const codexHome = createCodexHome();
    const outputPath = join(codexHome, "history.html");

    const result = runCli(
      ["--pick", "--codex-home", codexHome, "--no-minify", "--no-compress", "-o", outputPath],
      "history-only\n1\n"
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(outputPath), true);
    const html = readFileSync(outputPath, "utf-8");
    assert.match(html, /Codex History Replay - session-hist/);
    assert.match(html, /History-only prompt/);
    assert.match(html, /History-only second prompt/);
    assert.doesNotMatch(html, /CLI rollout prompt/);
    assert.doesNotMatch(html, /Orphan rollout prompt/);
  });

  it("shows one numbered row per session in the initial picker list", () => {
    const codexHome = createCodexHome();
    const outputPath = join(codexHome, "linked.html");

    const result = runCli(
      ["--pick", "--codex-home", codexHome, "--no-minify", "--no-compress", "-o", outputPath],
      "1\n"
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal((result.stderr.match(/\[\s*\d+\]/g) ?? []).length, 3);
    assert.match(result.stderr, /linked/);
    assert.match(result.stderr, /history-only/);
    assert.match(result.stderr, /rollout-only/);
    assert.match(result.stderr, /x2 rollout/);
    assert.match(result.stderr, /Linked history prompt/);
    assert.doesNotMatch(result.stderr, /Child rollout prompt/);

    const html = readFileSync(outputPath, "utf-8");
    assert.match(html, /CLI rollout prompt/);
    assert.match(html, /Child rollout prompt/);
  });

  it("renders the selected linked rollout session after filtering in the picker", () => {
    const codexHome = createCodexHome();
    const outputPath = join(codexHome, "rollout.html");

    const result = runCli(
      ["--pick", "--codex-home", codexHome, "--no-minify", "--no-compress", "-o", outputPath],
      "project-cli\n1\n"
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /Linked history prompt/);
    const html = readFileSync(outputPath, "utf-8");
    assert.match(html, /CLI rollout prompt/);
    assert.match(html, /Child rollout prompt/);
    assert.match(html, /Aquinas/);
    assert.match(html, /\(\+2 sessions\)/);
    assert.match(html, /CLI rollout answer/);
    assert.doesNotMatch(html, /Orphan rollout prompt/);
  });

  it("renders the selected rollout-only session after filtering in the picker", () => {
    const codexHome = createCodexHome();
    const outputPath = join(codexHome, "rollout-only.html");

    const result = runCli(
      ["--pick", "--codex-home", codexHome, "--no-minify", "--no-compress", "-o", outputPath],
      "rollout-only\n1\n"
    );

    assert.equal(result.status, 0, result.stderr);
    const html = readFileSync(outputPath, "utf-8");
    assert.match(html, /Orphan rollout prompt/);
    assert.match(html, /Orphan rollout answer/);
    assert.doesNotMatch(html, /CLI rollout prompt/);
    assert.doesNotMatch(html, /Child rollout prompt/);
  });

  it("keeps explicit rollout input scoped to the single file", () => {
    const codexHome = createCodexHome();
    const outputPath = join(codexHome, "single-rollout.html");
    const inputPath = join(codexHome, "sessions", "2026", "03", "07", "rollout-2026-03-07T10-00-00-root.jsonl");

    const result = runCli([inputPath, "--no-minify", "--no-compress", "-o", outputPath]);

    assert.equal(result.status, 0, result.stderr);
    const html = readFileSync(outputPath, "utf-8");
    assert.match(html, /CLI rollout prompt/);
    assert.doesNotMatch(html, /Child rollout prompt/);
  });

  it("rejects conflicting --pick and explicit input", () => {
    const codexHome = createCodexHome();
    const inputPath = join(codexHome, "history.jsonl");

    const result = runCli(["--pick", inputPath]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /cannot be used together with an explicit input file/);
  });

  it("rejects forced formats when picker mode is requested", () => {
    const codexHome = createCodexHome();
    const result = runCli(["--pick", "--codex-home", codexHome, "--format", "history"]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires --format auto/);
  });

  it("still errors with no input when picker is not enabled and stdin is not a tty", () => {
    const result = runCli([]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /input file is required/);
  });
});
