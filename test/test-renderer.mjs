import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { render } from "../src/renderer.mjs";
import { getTheme } from "../src/themes.mjs";

const SAMPLE_DOCUMENT = {
  format: "rollout",
  meta: {
    cwd: "/Users/alice/demo",
    cli_version: "0.52.0",
    model_provider: "openai",
    session_id: "session-123",
  },
  turns: [
    {
      index: 1,
      turn_id: "turn_1",
      session_id: "session-123",
      user_text: "Use secret sk-12345678901234567890 carefully.",
      attachments: { images: [], local_images: ["~/Pictures/input.png"] },
      status: "completed",
      timestamp: "2026-03-07T01:00:00.000Z",
      blocks: [
        { kind: "reasoning", text: "Thinking out loud." },
        { kind: "reasoning", status: "encrypted", summary_text: "Inspecting the repo before replying." },
        { kind: "tool_call", name: "shell", input: { cmd: "pwd", token: "Bearer abcdefghijklmnopqrstuvwxyz" }, output: { ok: true } },
        { kind: "system_notice", text: "Plan updated", status: "plan_update" },
        { kind: "assistant_message", text: "Ready to proceed.", phase: "final_answer" },
      ],
    },
  ],
};

describe("render", () => {
  it("produces valid HTML", () => {
    const html = render(SAMPLE_DOCUMENT, { minified: false });
    assert.match(html, /<!DOCTYPE html>/);
    assert.match(html, /Interactive Codex playback/);
    assert.match(html, /assistant-meta/);
    assert.match(html, /summary-preview/);
    assert.match(html, /summary-chevron/);
    assert.match(html, /turn-metrics/);
  });

  it("serializes encrypted reasoning summaries for the locked-state UI", () => {
    const html = render(SAMPLE_DOCUMENT, { minified: false, compress: false });
    assert.match(html, /\\"summary_text\\":\\"Inspecting the repo before replying\.\\"/);
    assert.match(html, /\\"status\\":\\"encrypted\\"/);
    assert.match(html, /locked-note/);
  });

  it("embeds compressed data by default", () => {
    const html = render(SAMPLE_DOCUMENT, { minified: false });
    assert.match(html, /await decodeData\("/);
    assert.doesNotMatch(html, /"turn_id":"turn_1"/);
  });

  it("embeds raw JSON when compression is disabled", () => {
    const html = render(SAMPLE_DOCUMENT, { minified: false, compress: false });
    assert.match(html, /\{\\\"format\\\":\\\"rollout\\\"/);
    assert.match(html, /\\\"turn_id\\\":\\\"turn_1\\\"/);
    assert.match(html, /\\\"assistant_message\\\"/);
  });

  it("injects theme css", () => {
    const html = render(SAMPLE_DOCUMENT, {
      minified: false,
      compress: false,
      theme: getTheme("oxide-blue"),
    });
    assert.match(html, /--bg: #111827/);
    assert.match(html, /--accent: #6aa6ff/);
  });

  it("sets toggle defaults from renderer options", () => {
    const html = render(SAMPLE_DOCUMENT, {
      minified: false,
      compress: false,
      showReasoning: false,
      showTools: false,
      showSystem: false,
    });

    assert.match(html, /id="toggle-reasoning"\s*>/);
    assert.match(html, /id="toggle-tools"\s*>/);
    assert.match(html, /id="toggle-system"\s*>/);
  });

  it("replaces all HTML placeholders", () => {
    const html = render(SAMPLE_DOCUMENT, { minified: false, compress: false });
    assert.doesNotMatch(html, /\/\*THEME_CSS\*\//);
    assert.doesNotMatch(html, /\/\*REPLAY_DATA\*\//);
    assert.doesNotMatch(html, /\/\*BOOKMARKS_DATA\*\//);
    assert.doesNotMatch(html, /\/\*CHECKED_REASONING\*\//);
    assert.doesNotMatch(html, /\/\*CHECKED_TOOLS\*\//);
    assert.doesNotMatch(html, /\/\*CHECKED_SYSTEM\*\//);
  });

  it("redacts embedded secrets by default", () => {
    const html = render(SAMPLE_DOCUMENT, { minified: false, compress: false });
    assert.doesNotMatch(html, /sk-12345678901234567890/);
    assert.doesNotMatch(html, /Bearer abcdefghijklmnopqrstuvwxyz/);
    assert.match(html, /\[REDACTED\]/);
  });

  it("uses a history-specific default title", () => {
    const html = render(
      {
        format: "history",
        meta: { source: "history" },
        turns: [],
        sessions: [],
      },
      { minified: false, compress: false }
    );

    assert.match(html, /<title>Codex History Replay<\/title>/);
  });

  it("serializes grouped rollout metadata and turn source fields", () => {
    const html = render(
      {
        format: "rollout",
        meta: {
          cwd: "/Users/alice/demo",
          session_id: "session-root",
          grouped: true,
          member_count: 2,
          participant_labels: ["Aquinas"],
        },
        turns: [
          {
            ...SAMPLE_DOCUMENT.turns[0],
            source_session_id: "session-root",
            source_agent_label: "main",
            source_role: null,
            source_is_root: true,
          },
        ],
      },
      { minified: false, compress: false }
    );

    assert.match(html, /\\"grouped\\":true/);
    assert.match(html, /\\"member_count\\":2/);
    assert.match(html, /\\"participant_labels\\":\[\\"Aquinas\\"\]/);
    assert.match(html, /\\"source_agent_label\\":\\"main\\"/);
  });
});
