import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectFormat, filterTranscript, parseTranscript, parseTranscriptGroup } from "../src/parser.mjs";

const ROLLOUT_FIXTURE = new URL("./fixture-rollout.jsonl", import.meta.url).pathname;
const HISTORY_FIXTURE = new URL("./fixture-history.jsonl", import.meta.url).pathname;

describe("detectFormat", () => {
  it("auto-detects rollout logs", () => {
    const document = parseTranscript(ROLLOUT_FIXTURE);
    assert.equal(detectFormat([{ type: "session_meta" }]), "rollout");
    assert.equal(document.format, "rollout");
  });

  it("auto-detects history logs", () => {
    const document = parseTranscript(HISTORY_FIXTURE);
    assert.equal(detectFormat([{ session_id: "abc", ts: 1, text: "hello" }]), "history");
    assert.equal(document.format, "history");
  });

  it("respects explicit format", () => {
    assert.equal(detectFormat([], "history"), "history");
    assert.equal(detectFormat([], "rollout"), "rollout");
  });
});

describe("parseTranscript rollout", () => {
  it("parses normalized document metadata and turns", () => {
    const document = parseTranscript(ROLLOUT_FIXTURE);
    assert.equal(document.meta.cwd, "/Users/tester/workspace/demo-app");
    assert.equal(document.meta.cli_version, "0.52.0");
    assert.equal(document.meta.model_provider, "openai");
    assert.equal(document.turns.length, 2);
    assert.deepEqual(
      document.turns.map((turn) => turn.status),
      ["completed", "aborted"]
    );
  });

  it("ignores bootstrap response items before the first turn", () => {
    const document = parseTranscript(ROLLOUT_FIXTURE);
    const allText = document.turns.flatMap((turn) => turn.blocks.map((block) => block.text)).filter(Boolean);
    assert.equal(document.turns[0].user_text, "Summarize the repo and ask for confirmation.");
    assert.ok(!allText.includes("Bootstrap should be ignored."));
  });

  it("pairs tool calls and extracts request_user_input answers", () => {
    const document = parseTranscript(ROLLOUT_FIXTURE);
    const firstTurn = document.turns[0];
    const requestBlock = firstTurn.blocks.find((block) => block.kind === "request_user_input");
    const toolBlock = firstTurn.blocks.find((block) => block.kind === "tool_call");

    assert.equal(requestBlock.call_id, "call_input_1");
    assert.deepEqual(requestBlock.answers, { scope: "Default", notes: "Keep it simple." });
    assert.deepEqual(toolBlock.input, { query: "AGENTS.md" });
    assert.deepEqual(toolBlock.output, { results: ["AGENTS.md", "README.md"] });
  });

  it("captures encrypted reasoning summaries without pretending to decrypt them", () => {
    const document = parseTranscript(ROLLOUT_FIXTURE);
    const reasoningBlocks = document.turns[0].blocks.filter((block) => block.kind === "reasoning");
    assert.equal(reasoningBlocks.length, 2);
    assert.equal(reasoningBlocks[1].status, "encrypted");
    assert.equal(reasoningBlocks[1].text, undefined);
    assert.equal(
      reasoningBlocks[1].summary_text,
      "Inspecting the repo instructions and tool outputs before replying."
    );
  });

  it("still emits an encrypted reasoning block when no plaintext summary is available", () => {
    const filePath = join(tmpdir(), "codex-replay-encrypted-reasoning.jsonl");
    writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: "2026-03-07T02:40:00.000Z",
          type: "session_meta",
          payload: {
            id: "session-encrypted-reasoning",
            timestamp: "2026-03-07T02:40:00.000Z",
            cwd: "/Users/tester/workspace/demo-app",
            cli_version: "0.52.0",
            model_provider: "openai",
            source: "cli",
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-07T02:40:00.100Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "turn_encrypted_1" },
        }),
        JSON.stringify({
          timestamp: "2026-03-07T02:40:00.200Z",
          type: "event_msg",
          payload: { type: "user_message", message: "Summarize reasoning availability.", images: [], local_images: [] },
        }),
        JSON.stringify({
          timestamp: "2026-03-07T02:40:00.300Z",
          type: "response_item",
          payload: {
            type: "reasoning",
            summary: [],
            content: null,
            encrypted_content: "opaque",
          },
        }),
      ].join("\n")
    );

    try {
      const document = parseTranscript(filePath);
      const reasoningBlock = document.turns[0].blocks.find((block) => block.kind === "reasoning");
      assert.equal(reasoningBlock.status, "encrypted");
      assert.equal(reasoningBlock.summary_text, null);
    } finally {
      unlinkSync(filePath);
    }
  });

  it("normalizes attachments and preserves assistant phases", () => {
    const document = parseTranscript(ROLLOUT_FIXTURE);
    const [firstTurn] = document.turns;
    const phases = firstTurn.blocks
      .filter((block) => block.kind === "assistant_message")
      .map((block) => block.phase);

    assert.deepEqual(firstTurn.attachments.images, ["https://example.com/screenshot.png"]);
    assert.deepEqual(firstTurn.attachments.local_images, ["/Users/tester/Pictures/input.png"]);
    assert.deepEqual(phases, ["commentary", "final_answer", "final"]);
  });

  it("deduplicates identical assistant text within a turn and keeps the highest-precedence phase", () => {
    const filePath = join(tmpdir(), "codex-replay-duplicate-assistant.jsonl");
    writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: "2026-03-07T02:30:00.000Z",
          type: "session_meta",
          payload: {
            id: "session-duplicate-assistant",
            timestamp: "2026-03-07T02:30:00.000Z",
            cwd: "/Users/tester/workspace/demo-app",
            cli_version: "0.52.0",
            model_provider: "openai",
            source: "cli",
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-07T02:30:01.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "turn_duplicate_1" },
        }),
        JSON.stringify({
          timestamp: "2026-03-07T02:30:01.100Z",
          type: "event_msg",
          payload: { type: "user_message", message: "Show the merged answer once.", images: [], local_images: [] },
        }),
        JSON.stringify({
          timestamp: "2026-03-07T02:30:01.200Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Merged assistant text." }],
            phase: "message",
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-07T02:30:01.300Z",
          type: "event_msg",
          payload: { type: "agent_message", message: "Merged assistant text.", phase: "commentary" },
        }),
        JSON.stringify({
          timestamp: "2026-03-07T02:30:01.400Z",
          type: "event_msg",
          payload: { type: "agent_message", message: "Merged assistant text.", phase: "final_answer" },
        }),
        JSON.stringify({
          timestamp: "2026-03-07T02:30:01.500Z",
          type: "event_msg",
          payload: { type: "task_complete", last_agent_message: "Merged assistant text." },
        }),
      ].join("\n")
    );

    try {
      const document = parseTranscript(filePath);
      const assistantBlocks = document.turns[0].blocks.filter((block) => block.kind === "assistant_message");
      assert.equal(assistantBlocks.length, 1);
      assert.equal(assistantBlocks[0].text, "Merged assistant text.");
      assert.equal(assistantBlocks[0].phase, "final_answer");
      assert.equal(assistantBlocks[0].timestamp, "2026-03-07T02:30:01.400Z");
    } finally {
      unlinkSync(filePath);
    }
  });

  it("normalizes local image paths under the current home directory", () => {
    const homeDir = process.env.HOME;
    if (!homeDir) return;

    const filePath = join(tmpdir(), "codex-replay-home-fixture.jsonl");
    writeFileSync(
      filePath,
      [
        JSON.stringify({
          timestamp: "2026-03-07T02:00:00.000Z",
          type: "session_meta",
          payload: { id: "session-home", timestamp: "2026-03-07T02:00:00.000Z", cwd: homeDir, cli_version: "0.52.0", source: "cli" },
        }),
        JSON.stringify({
          timestamp: "2026-03-07T02:00:01.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "Attachment only",
            images: [],
            local_images: [`${homeDir}/Pictures/example.png`],
          },
        }),
      ].join("\n")
    );

    try {
      const document = parseTranscript(filePath);
      assert.deepEqual(document.turns[0].attachments.local_images, ["~/Pictures/example.png"]);
    } finally {
      unlinkSync(filePath);
    }
  });

  it("merges grouped rollout files and preserves turn source metadata", () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "codex-replay-group-"));
    const rootPath = join(fixtureDir, "root.jsonl");
    const childPath = join(fixtureDir, "child.jsonl");

    writeFileSync(
      rootPath,
      [
        JSON.stringify({
          timestamp: "2026-03-07T02:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "session-root-123456",
            timestamp: "2026-03-07T02:00:00.000Z",
            cwd: "/Users/tester/workspace/group-demo",
            cli_version: "0.52.0",
            model_provider: "openai",
            source: "cli",
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-07T02:00:01.000Z",
          type: "event_msg",
          payload: { type: "user_message", message: "Root prompt", images: [], local_images: [] },
        }),
        JSON.stringify({
          timestamp: "2026-03-07T02:00:02.000Z",
          type: "event_msg",
          payload: { type: "agent_message", message: "Root answer", phase: "final_answer" },
        }),
        JSON.stringify({
          timestamp: "2026-03-07T02:00:03.000Z",
          type: "event_msg",
          payload: { type: "task_complete", last_agent_message: "Root done" },
        }),
      ].join("\n")
    );

    writeFileSync(
      childPath,
      [
        JSON.stringify({
          timestamp: "2026-03-07T02:00:01.500Z",
          type: "session_meta",
          payload: {
            id: "session-child-654321",
            timestamp: "2026-03-07T02:00:01.500Z",
            cwd: "/Users/tester/workspace/group-demo",
            cli_version: "0.52.0",
            model_provider: "openai",
            source: {
              subagent: {
                thread_spawn: {
                  parent_thread_id: "session-root-123456",
                  depth: 1,
                },
              },
            },
            agent_nickname: "Aquinas",
            agent_role: "awaiter",
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-07T02:00:01.600Z",
          type: "event_msg",
          payload: { type: "user_message", message: "Child prompt", images: [], local_images: [] },
        }),
        JSON.stringify({
          timestamp: "2026-03-07T02:00:02.500Z",
          type: "event_msg",
          payload: { type: "agent_message", message: "Child answer", phase: "final_answer" },
        }),
        JSON.stringify({
          timestamp: "2026-03-07T02:00:02.700Z",
          type: "event_msg",
          payload: { type: "task_complete", last_agent_message: "Child done" },
        }),
      ].join("\n")
    );

    try {
      const document = parseTranscriptGroup([rootPath, childPath]);
      assert.equal(document.meta.grouped, true);
      assert.equal(document.meta.root_session_id, "session-root-123456");
      assert.equal(document.meta.member_count, 2);
      assert.deepEqual(document.meta.participant_labels, ["Aquinas"]);
      assert.equal(document.turns.length, 2);
      assert.deepEqual(document.turns.map((turn) => turn.user_text), ["Root prompt", "Child prompt"]);
      assert.equal(document.turns[0].source_agent_label, "main");
      assert.equal(document.turns[0].source_is_root, true);
      assert.equal(document.turns[1].source_agent_label, "Aquinas");
      assert.equal(document.turns[1].source_role, "awaiter");
      assert.equal(document.turns[1].source_is_root, false);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});

describe("parseTranscript history", () => {
  it("groups entries by session and sorts by timestamp", () => {
    const document = parseTranscript(HISTORY_FIXTURE);

    assert.equal(document.turns.length, 4);
    assert.deepEqual(
      document.sessions.map((session) => session.session_id),
      ["session-alpha", "session-beta"]
    );
    assert.deepEqual(
      document.sessions[0].turns.map((turn) => turn.user_text),
      ["Older alpha prompt.", "Later alpha prompt."]
    );
    assert.deepEqual(
      document.sessions[1].turns.map((turn) => turn.user_text),
      ["Ask Codex to inspect the changelog.", "Ask Codex to open README."]
    );
  });
});

describe("filterTranscript", () => {
  it("filters rollout documents by time range", () => {
    const document = parseTranscript(ROLLOUT_FIXTURE);
    const filtered = filterTranscript(document, {
      timeFrom: "2026-03-07T01:04:59.000Z",
      timeTo: "2026-03-07T01:05:01.000Z",
    });

    assert.equal(filtered.turns.length, 1);
    assert.equal(filtered.turns[0].turn_id, "turn_2");
    assert.equal(filtered.turns[0].index, 1);
  });

  it("filters history documents and rebuilds grouped sessions", () => {
    const document = parseTranscript(HISTORY_FIXTURE);
    const filtered = filterTranscript(document, {
      timeTo: "2026-03-06T13:02:00.000Z",
    });

    assert.equal(filtered.turns.length, 3);
    assert.deepEqual(filtered.turns.map((turn) => turn.index), [1, 2, 3]);
    assert.equal(filtered.sessions.length, 2);
    assert.deepEqual(
      filtered.sessions.map((session) => session.session_id),
      ["session-alpha", "session-beta"]
    );
  });
});
