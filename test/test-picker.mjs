import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import stringWidth from "string-width";
import {
  applyInteractivePickerKey,
  createInteractivePickerState,
  filterCandidates,
  pickCodexInput,
  renderCandidateList,
  renderInteractivePickerView,
  stripAnsi,
} from "../src/picker.mjs";

const SAMPLE_CANDIDATES = [
  {
    kind: "session",
    session_kind: "history+rollout",
    format: "rollout",
    path: "/tmp/root-alpha.jsonl",
    paths: ["/tmp/root-alpha.jsonl", "/tmp/child-alpha.jsonl"],
    history_path: "/tmp/history.jsonl",
    history_session_id: "session-alpha",
    display_path: "sessions/2026/03/07/rollout-alpha.jsonl",
    display_time: "2026-03-07 12:00:00",
    cwd_name: "repo-alpha",
    session_id: "session-alpha",
    entry_count: 3,
    member_count: 2,
    participant_labels: ["Aquinas"],
    preview_text: "Linked alpha prompt about keeping the newest response visible during playback.",
    model_provider: "openai",
    search_text:
      "linked repo-alpha session-alpha aquinas linked alpha prompt keeping the newest response visible during playback sessions/2026/03/07/rollout-alpha.jsonl /tmp/root-alpha.jsonl /tmp/child-alpha.jsonl",
  },
  {
    kind: "session",
    session_kind: "history-only",
    format: "history",
    path: "/tmp/history.jsonl",
    history_path: "/tmp/history.jsonl",
    history_session_id: "session-history",
    display_path: "history.jsonl#session-history",
    display_time: "2026-03-07 11:00:00",
    session_id: "session-history",
    entry_count: 1,
    member_count: 0,
    participant_labels: [],
    preview_text: "History-only prompt for a single preserved session.",
    search_text:
      "history-only history history.jsonl session-history history-only prompt for a single preserved session",
  },
  {
    kind: "session",
    session_kind: "rollout-only",
    format: "rollout",
    path: "/tmp/rollout-beta.jsonl",
    paths: ["/tmp/rollout-beta.jsonl"],
    display_path: "sessions/2026/03/07/rollout-beta.jsonl",
    display_time: "2026-03-07 10:00:00",
    cwd_name: "frontend",
    session_id: "session-beta",
    entry_count: 5,
    member_count: 1,
    participant_labels: [],
    preview_text:
      "frontend 에서 이미지 사이즈가 큰거 불러올 때 너무 느리게 로딩되는데 최적화 전략이 있는지 검토하라.",
    model_provider: "openai",
    search_text:
      "rollout-only rollout frontend session-beta frontend 에서 이미지 사이즈가 큰거 불러올 때 너무 느리게 로딩되는데 최적화 전략이 있는지 검토하라 sessions/2026/03/07/rollout-beta.jsonl /tmp/rollout-beta.jsonl",
  },
];

describe("filterCandidates", () => {
  it("matches session kind, cwd, participant, and preview text", () => {
    assert.equal(filterCandidates(SAMPLE_CANDIDATES, "frontend").length, 1);
    assert.equal(filterCandidates(SAMPLE_CANDIDATES, "session-alpha").length, 1);
    assert.equal(filterCandidates(SAMPLE_CANDIDATES, "aquinas").length, 1);
    assert.equal(filterCandidates(SAMPLE_CANDIDATES, "newest response").length, 1);
    assert.equal(filterCandidates(SAMPLE_CANDIDATES, "history-only").length, 1);
  });
});

describe("renderCandidateList", () => {
  it("limits fallback rows and renders structured session summaries", () => {
    const view = renderCandidateList(SAMPLE_CANDIDATES, { limit: 2 });
    assert.equal(view.shown.length, 2);
    assert.equal(view.filtered.length, 3);
    assert.match(view.text, /1 more matches not shown/);
    assert.match(view.text, /\[linked\]/);
    assert.match(view.text, /3 turns/);
    assert.match(view.text, /x2 rollout/);
    assert.match(view.text, /Aquinas/);
    assert.match(view.text, /Linked alpha prompt about keeping the newest response visible during playback\./);
    assert.doesNotMatch(view.text, /\[rollout-only\]/);
  });
});

describe("pickCodexInput fallback", () => {
  it("allows filtering before selecting by index", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let printed = "";
    output.on("data", (chunk) => {
      printed += chunk.toString();
    });

    const pending = pickCodexInput(SAMPLE_CANDIDATES, { input, output, limit: 5 });
    input.end("frontend\n1\n");
    const selected = await pending;

    assert.equal(selected.action, "select");
    assert.equal(selected.candidate.path, "/tmp/rollout-beta.jsonl");
    assert.match(printed, /Filter: \(all\)/);
    assert.match(printed, /Filter: frontend/);
    assert.match(printed, /이미지 사이즈가 큰거 불러올 때 너무 느리게 로딩되는데/);
  });

  it("clears the filter on empty input and keeps going", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let printed = "";
    output.on("data", (chunk) => {
      printed += chunk.toString();
    });

    const pending = pickCodexInput(SAMPLE_CANDIDATES, { input, output, limit: 5 });
    input.end("does-not-match\n\n2\n");
    const selected = await pending;

    assert.equal(selected.action, "select");
    assert.equal(selected.candidate.path, "/tmp/history.jsonl");
    assert.match(printed, /No matches/);
  });

  it("returns null when the user quits", async () => {
    const input = new PassThrough();
    const output = new PassThrough();

    const pending = pickCodexInput(SAMPLE_CANDIDATES, { input, output, limit: 5 });
    input.end("q\n");
    const selected = await pending;

    assert.equal(selected, null);
  });
});

describe("pickCodexInput raw mode", () => {
  it("moves with arrow actions and renders a clear selected card", () => {
    let state = createInteractivePickerState(SAMPLE_CANDIDATES);

    let result = applyInteractivePickerKey(SAMPLE_CANDIDATES, state, "down", { rows: 18, columns: 72 });
    state = result.state;
    assert.equal(state.selectedIndex, 1);

    result = applyInteractivePickerKey(SAMPLE_CANDIDATES, state, "down", { rows: 18, columns: 72 });
    state = result.state;
    assert.equal(state.selectedIndex, 2);

    const view = renderInteractivePickerView(SAMPLE_CANDIDATES, state, {
      rows: 18,
      columns: 72,
      useColor: false,
    });
    assert.equal(view.selected?.session_id, "session-beta");
    assert.match(view.text, /^> frontend \[rollout-only\]/m);
    assert.match(view.text, /^\| Prompt: frontend/m);
    assert.match(view.text, /Selected: frontend \[rollout-only\]/);
    assert.match(view.text, /Actions: Enter open preview \| S save html/);

    result = applyInteractivePickerKey(SAMPLE_CANDIDATES, state, "enter", { rows: 18, columns: 72 });
    assert.equal(result.action, "open");
  });

  it("keeps every rendered line within terminal width for Korean prompts", () => {
    const state = createInteractivePickerState(SAMPLE_CANDIDATES, "frontend");
    const view = renderInteractivePickerView(SAMPLE_CANDIDATES, state, {
      rows: 18,
      columns: 68,
      useColor: true,
    });

    for (const line of view.text.split("\n")) {
      assert.ok(stringWidth(stripAnsi(line)) <= 68, `line exceeded width: ${stripAnsi(line)}`);
    }
  });

  it("uses the raw-mode picker for save shortcuts and pauses stdin during cleanup", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const rawModeCalls = [];
    let paused = false;

    input.isTTY = true;
    input.setRawMode = (value) => {
      rawModeCalls.push(value);
    };
    input.pause = () => {
      paused = true;
    };
    output.isTTY = true;
    output.rows = 18;
    output.columns = 72;

    const pending = pickCodexInput(SAMPLE_CANDIDATES, { input, output, limit: 1 });
    input.write("\u001b[B");
    input.write("S");
    const selected = await pending;

    assert.equal(selected.action, "save");
    assert.equal(selected.candidate.session_id, "session-history");
    assert.deepEqual(rawModeCalls, [true, false]);
    assert.equal(paused, true);
  });

  it("treats uppercase Q as an immediate quit even when a filter is active", async () => {
    const input = new PassThrough();
    const output = new PassThrough();

    input.isTTY = true;
    input.setRawMode = () => {};
    input.pause = () => {};
    output.isTTY = true;
    output.rows = 18;
    output.columns = 72;

    const pending = pickCodexInput(SAMPLE_CANDIDATES, { input, output });
    input.write("f");
    input.write("Q");
    const selected = await pending;

    assert.equal(selected, null);
  });
});
