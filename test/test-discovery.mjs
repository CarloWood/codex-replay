import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { discoverCodexInputs } from "../src/discovery.mjs";

function createTempCodexHome() {
  return mkdtempSync(join(tmpdir(), "codex-replay-discovery-"));
}

function writeRolloutFile(filePath, payload = {}) {
  mkdirSync(dirname(filePath), { recursive: true });
  const entries = [
    JSON.stringify({
      timestamp: payload.timestamp ?? "2026-03-07T10:00:00.000Z",
      type: "session_meta",
      payload: {
        id: payload.id ?? "session-rollout",
        timestamp: payload.timestamp ?? "2026-03-07T10:00:00.000Z",
        cwd: payload.cwd ?? "/Users/example/project-alpha",
        model_provider: payload.model_provider ?? "openai",
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
  ];

  if (payload.bootstrap_input) {
    entries.push(
      JSON.stringify({
        timestamp: payload.bootstrap_timestamp ?? payload.timestamp ?? "2026-03-07T10:00:00.050Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: payload.bootstrap_input }],
        },
      })
    );
  }

  if (payload.message !== false) {
    entries.push(
      JSON.stringify({
        timestamp: payload.user_message_timestamp ?? payload.timestamp ?? "2026-03-07T10:00:00.100Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: payload.message ?? "hello",
          images: [],
          local_images: [],
        },
      })
    );
  }

  writeFileSync(filePath, entries.join("\n"));
}

describe("discoverCodexInputs", () => {
  it("merges history sessions with rollout trees and keeps one candidate per session", () => {
    const codexHome = createTempCodexHome();
    mkdirSync(join(codexHome, "sessions", "2026", "03", "07"), { recursive: true });
    mkdirSync(join(codexHome, "sessions", "2026", "03", "06"), { recursive: true });

    writeFileSync(
      join(codexHome, "history.jsonl"),
      [
        JSON.stringify({
          session_id: "session-newer",
          ts: "2026-03-07T10:02:00.000Z",
          text: "Linked history prompt",
        }),
        JSON.stringify({
          session_id: "session-history-only",
          ts: "2026-03-07T09:30:00.000Z",
          text: "History only prompt",
        }),
      ].join("\n") + "\n"
    );

    writeRolloutFile(join(codexHome, "sessions", "2026", "03", "07", "rollout-2026-03-07T10-00-00-newer.jsonl"), {
      id: "session-newer",
      cwd: "/Users/example/project-newer",
      timestamp: "2026-03-07T10:00:00.000Z",
      message: "Root grouped prompt",
    });
    writeRolloutFile(join(codexHome, "sessions", "2026", "03", "07", "rollout-2026-03-07T10-01-00-child.jsonl"), {
      id: "session-child",
      cwd: "/Users/example/project-newer",
      timestamp: "2026-03-07T10:01:00.000Z",
      parent_thread_id: "session-newer",
      agent_nickname: "Aquinas",
      agent_role: "awaiter",
      message: "Child grouped prompt",
    });
    writeRolloutFile(join(codexHome, "sessions", "2026", "03", "06", "rollout-2026-03-06T09-00-00-older.jsonl"), {
      id: "session-older",
      cwd: "/Users/example/project-older",
      timestamp: "2026-03-06T09:00:00.000Z",
      message: "Orphan rollout prompt",
    });

    const candidates = discoverCodexInputs({ codexHome });

    assert.equal(candidates.length, 3);

    assert.equal(candidates[0].kind, "session");
    assert.equal(candidates[0].session_kind, "history+rollout");
    assert.equal(candidates[0].format, "rollout");
    assert.equal(candidates[0].session_id, "session-newer");
    assert.equal(candidates[0].history_session_id, "session-newer");
    assert.equal(candidates[0].cwd_name, "project-newer");
    assert.equal(candidates[0].entry_count, 1);
    assert.equal(candidates[0].member_count, 2);
    assert.deepEqual(candidates[0].participant_labels, ["Aquinas"]);
    assert.equal(candidates[0].preview_text, "Linked history prompt");
    assert.match(candidates[0].search_text, /root grouped prompt/);
    assert.deepEqual(
      candidates[0].paths.map((filePath) => filePath.split("/").pop()),
      [
        "rollout-2026-03-07T10-00-00-newer.jsonl",
        "rollout-2026-03-07T10-01-00-child.jsonl",
      ]
    );

    assert.equal(candidates[1].kind, "session");
    assert.equal(candidates[1].session_kind, "history-only");
    assert.equal(candidates[1].format, "history");
    assert.equal(candidates[1].session_id, "session-history-only");
    assert.equal(candidates[1].history_session_id, "session-history-only");
    assert.equal(candidates[1].path, join(codexHome, "history.jsonl"));
    assert.equal(candidates[1].preview_text, "History only prompt");

    assert.equal(candidates[2].kind, "session");
    assert.equal(candidates[2].session_kind, "rollout-only");
    assert.equal(candidates[2].format, "rollout");
    assert.equal(candidates[2].session_id, "session-older");
    assert.equal(candidates[2].preview_text, "Orphan rollout prompt");
    assert.equal(candidates[2].member_count, 1);
  });

  it("keeps rollout-only sessions with fallback labels when metadata is missing", () => {
    const codexHome = createTempCodexHome();
    const rolloutDir = join(codexHome, "sessions", "2026", "03", "07");
    mkdirSync(rolloutDir, { recursive: true });
    writeFileSync(
      join(rolloutDir, "rollout-2026-03-07T11-00-00-no-meta.jsonl"),
      "{not-json}\n"
    );

    const candidates = discoverCodexInputs({ codexHome });

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].kind, "session");
    assert.equal(candidates[0].session_kind, "rollout-only");
    assert.equal(candidates[0].session_id, null);
    assert.equal(candidates[0].cwd, null);
    assert.equal(candidates[0].member_count, 1);
    assert.equal(candidates[0].preview_text, null);
    assert.match(candidates[0].display_path, /rollout-2026-03-07T11-00-00-no-meta\.jsonl$/);
  });

  it("falls back to the earliest grouped preview when the root rollout has no user prompt", () => {
    const codexHome = createTempCodexHome();
    const rolloutDir = join(codexHome, "sessions", "2026", "03", "07");
    mkdirSync(rolloutDir, { recursive: true });

    writeRolloutFile(join(rolloutDir, "rollout-2026-03-07T10-00-00-root.jsonl"), {
      id: "session-root",
      cwd: "/Users/example/project-preview",
      timestamp: "2026-03-07T10:00:00.000Z",
      bootstrap_input: "<environment_context>bootstrap</environment_context>",
      message: false,
    });
    writeRolloutFile(join(rolloutDir, "rollout-2026-03-07T10-01-00-child.jsonl"), {
      id: "session-preview-child",
      cwd: "/Users/example/project-preview",
      timestamp: "2026-03-07T10:01:00.000Z",
      parent_thread_id: "session-root",
      agent_nickname: "Aquinas",
      message: "Child fallback prompt",
    });

    const candidates = discoverCodexInputs({ codexHome });

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].session_kind, "rollout-only");
    assert.equal(candidates[0].member_count, 2);
    assert.equal(candidates[0].preview_text, "Child fallback prompt");
    assert.match(candidates[0].search_text, /child fallback prompt/);
  });
});
