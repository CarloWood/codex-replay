import { createInterface } from "node:readline";
import { createColors } from "picocolors";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";

const DEFAULT_LIMIT = 50;
const DEFAULT_COLUMNS = 100;
const DEFAULT_ROWS = 24;
const MIN_COLUMNS = 48;
const ENTRY_ROWS = 3;
const HEADER_ROWS = 4;
const DETAIL_ROWS = 8;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeQuery(value) {
  return String(value ?? "").trim().toLowerCase();
}

function singularOrPlural(count, singular, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function shortenSessionId(sessionId) {
  if (typeof sessionId !== "string" || !sessionId) return "unknown";
  return sessionId.length > 12 ? sessionId.slice(0, 12) : sessionId;
}

function projectLabel(candidate) {
  return candidate?.cwd_name ?? "unknown-project";
}

function sessionKindLabel(candidate) {
  switch (candidate?.session_kind) {
    case "history+rollout":
      return "linked";
    case "history-only":
      return "history-only";
    case "rollout-only":
      return "rollout-only";
    default:
      return candidate?.session_kind ?? candidate?.format ?? "session";
  }
}

function displayTime(candidate) {
  return candidate?.display_time ?? "unknown time";
}

function promptPreview(candidate) {
  return normalizeText(candidate?.preview_text) || "No prompt preview available.";
}

function rolloutCount(candidate) {
  return candidate?.session_kind === "history-only" ? 0 : Math.max(1, Number(candidate?.member_count) || 1);
}

function turnCount(candidate) {
  const count = Number(candidate?.entry_count) || 0;
  return `${count} ${singularOrPlural(count, "turn")}`;
}

function participantSummary(candidate) {
  const labels = Array.isArray(candidate?.participant_labels)
    ? candidate.participant_labels.filter(Boolean)
    : [];
  if (!labels.length) {
    const count = rolloutCount(candidate);
    return count > 1 ? `${count} agents` : "main agent";
  }
  return labels.join(", ");
}

function statsSummary(candidate) {
  const parts = [turnCount(candidate)];
  if (candidate?.session_kind === "history-only") {
    parts.push("history only");
  } else {
    parts.push(`x${rolloutCount(candidate)} rollout`);
  }
  const participants = participantSummary(candidate);
  if (participants) parts.push(participants);
  parts.push(shortenSessionId(candidate?.session_id ?? candidate?.history_session_id));
  return parts.join(" | ");
}

function displayWidth(value) {
  return stringWidth(String(value ?? ""));
}

function trimToWidth(value, width) {
  if (width <= 0) return "";
  let output = "";
  let used = 0;
  for (const char of String(value ?? "")) {
    const charWidth = displayWidth(char);
    if (used + charWidth > width) break;
    output += char;
    used += charWidth;
  }
  return output;
}

function fitText(value, width) {
  const normalized = String(value ?? "").replace(/\r?\n/g, " ");
  if (width <= 0) return "";
  if (displayWidth(normalized) <= width) return normalized;
  if (width <= 3) return trimToWidth(normalized, width);
  return `${trimToWidth(normalized, width - 3)}...`;
}

function padDisplay(value, width) {
  const fitted = fitText(value, width);
  const remaining = Math.max(0, width - displayWidth(fitted));
  return `${fitted}${" ".repeat(remaining)}`;
}

function wrapText(value, width, maxLines = 1) {
  if (width <= 0) return [""];
  const wrapped = wrapAnsi(normalizeText(value), width, {
    hard: true,
    trim: false,
    wordWrap: true,
  })
    .split("\n")
    .map((line) => fitText(line, width))
    .filter((line) => line.length || maxLines === 0);

  if (!wrapped.length) return [""];
  if (wrapped.length <= maxLines) return wrapped;
  const visible = wrapped.slice(0, Math.max(1, maxLines));
  visible[visible.length - 1] = fitText(visible[visible.length - 1], width);
  return visible;
}

function pageSizeForRows(rows) {
  const safeRows = Math.max(Number(rows) || DEFAULT_ROWS, HEADER_ROWS + DETAIL_ROWS + ENTRY_ROWS);
  return Math.max(1, Math.floor((safeRows - HEADER_ROWS - DETAIL_ROWS) / ENTRY_ROWS));
}

function visibleColumns(columns) {
  return Math.max(MIN_COLUMNS, Number(columns) || DEFAULT_COLUMNS);
}

function selectionPrefix(selected, lineIndex) {
  if (!selected) return "  ";
  return lineIndex === 0 ? "> " : "| ";
}

function styleLine(text, width, { colors, selected = false, muted = false, accent = false } = {}) {
  const padded = padDisplay(text, width);
  if (!colors) return padded;
  if (selected) return colors.inverse(colors.bold(padded));
  if (accent) return colors.bold(padded);
  if (muted) return colors.dim(padded);
  return padded;
}

function formatListLines(candidate, width) {
  const contentWidth = Math.max(12, width - 2);
  return [
    `${projectLabel(candidate)} [${sessionKindLabel(candidate)}] ${displayTime(candidate)}`,
    `Prompt: ${promptPreview(candidate)}`,
    statsSummary(candidate),
  ].map((line) => fitText(line, contentWidth));
}

function renderListWindow(candidates, state, { columns, rows, colors }) {
  const width = visibleColumns(columns);
  const pageSize = getInteractivePageSize(rows);
  const filtered = filterCandidates(candidates, state.query);
  const selectedIndex = filtered.length ? clamp(state.selectedIndex, 0, filtered.length - 1) : 0;
  const start = filtered.length
    ? clamp(selectedIndex - Math.floor(pageSize / 2), 0, Math.max(0, filtered.length - pageSize))
    : 0;
  const end = start + pageSize;
  const visible = filtered.slice(start, end);
  const lines = [];

  for (let visibleIndex = 0; visibleIndex < pageSize; visibleIndex += 1) {
    const candidate = visible[visibleIndex] ?? null;
    if (!candidate) {
      for (let lineIndex = 0; lineIndex < ENTRY_ROWS; lineIndex += 1) {
        lines.push(" ".repeat(width));
      }
      continue;
    }

    const absoluteIndex = start + visibleIndex;
    const selected = absoluteIndex === selectedIndex;
    const rowLines = formatListLines(candidate, width);
    for (let lineIndex = 0; lineIndex < rowLines.length; lineIndex += 1) {
      const prefix = selectionPrefix(selected, lineIndex);
      const content = `${prefix}${rowLines[lineIndex]}`;
      lines.push(
        styleLine(content, width, {
          colors,
          selected,
          muted: !selected && lineIndex > 0,
          accent: !selected && lineIndex === 0,
        })
      );
    }
  }

  return {
    lines,
    selected: filtered[selectedIndex] ?? null,
    selectedIndex,
    total: filtered.length,
    start,
    end: Math.min(filtered.length, end),
    pageSize,
  };
}

function detailLines(selected, width) {
  const promptWidth = Math.max(12, width - 8);
  const wrappedPrompt = wrapText(promptPreview(selected), promptWidth, 2);
  const pathValue = normalizeText(
    Array.isArray(selected?.paths) && selected.paths.length > 1
      ? `${selected.path} (+${selected.paths.length - 1} more)`
      : selected?.path ?? selected?.history_path ?? selected?.display_path ?? "unknown source"
  );
  const participants = participantSummary(selected);

  return [
    `Selected: ${projectLabel(selected)} [${sessionKindLabel(selected)}]`,
    `Updated: ${displayTime(selected)} | Format: ${selected?.format ?? "auto"} | ${turnCount(selected)}`,
    `Rollouts: ${selected?.session_kind === "history-only" ? "n/a" : `x${rolloutCount(selected)}`} | Agents: ${participants}`,
    `Prompt: ${wrappedPrompt[0] ?? ""}`,
    wrappedPrompt[1] ? `        ${wrappedPrompt[1]}` : "        ",
    `Source: ${fitText(pathValue, Math.max(10, width - 8))}`,
    `Actions: Enter open preview | S save html | Esc clear filter | Q quit`,
  ];
}

function renderHeaderLines(candidates, state, selectedIndex, total, width, colors) {
  const filterLabel = state.query ? state.query : "(all)";
  const selectedLabel = total ? `${selectedIndex + 1}/${total}` : "0/0";

  return [
    styleLine(`Codex Sessions ${selectedLabel}`, width, { colors, accent: true }),
    styleLine(`Filter: ${fitText(filterLabel, Math.max(8, width - 28))} | Matches: ${total}/${candidates.length}`, width, {
      colors,
      muted: true,
    }),
    styleLine(
      "Keys: Up/Down move | PageUp/PageDown jump | Type to filter | Enter open | S save | Q quit",
      width,
      { colors, muted: true }
    ),
    styleLine("-".repeat(width), width, { colors, muted: true }),
  ];
}

function normalizeInteractiveState(candidates, state) {
  const query = state?.query ?? "";
  const filtered = filterCandidates(candidates, query);
  return {
    query,
    selectedIndex: filtered.length ? clamp(state?.selectedIndex ?? 0, 0, filtered.length - 1) : 0,
  };
}

function updateSelectionIndex(candidates, state, nextIndex) {
  const filtered = filterCandidates(candidates, state.query);
  return {
    ...state,
    selectedIndex: filtered.length ? clamp(nextIndex, 0, filtered.length - 1) : 0,
  };
}

function parseInteractiveKeys(chunk) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
  const keys = [];

  for (let index = 0; index < text.length; index += 1) {
    const remaining = text.slice(index);
    if (remaining.startsWith("\u001b[A")) {
      keys.push("up");
      index += 2;
      continue;
    }
    if (remaining.startsWith("\u001b[B")) {
      keys.push("down");
      index += 2;
      continue;
    }
    if (remaining.startsWith("\u001b[5~")) {
      keys.push("pageup");
      index += 3;
      continue;
    }
    if (remaining.startsWith("\u001b[6~")) {
      keys.push("pagedown");
      index += 3;
      continue;
    }
    const current = text[index];
    if (current === "\r" || current === "\n") {
      keys.push("enter");
      continue;
    }
    if (current === "\u007f" || current === "\b") {
      keys.push("backspace");
      continue;
    }
    if (current === "\u001b") {
      keys.push("escape");
      continue;
    }
    keys.push(current);
  }

  return keys;
}

function stripAnsi(value) {
  return String(value ?? "").replace(/\u001b\[[0-9;]*m/g, "");
}

async function pickWithFallback(candidates, { input, output, limit = DEFAULT_LIMIT } = {}) {
  const rl = createInterface({
    input,
    output,
    crlfDelay: Infinity,
    terminal: Boolean(input?.isTTY && output?.isTTY),
  });
  const iterator = rl[Symbol.asyncIterator]();

  let query = "";
  try {
    for (;;) {
      const view = renderCandidateList(candidates, { query, limit });
      output.write(`${view.text}\n`);

      if (!view.filtered.length) {
        output.write("No matches. Press Enter to clear the filter or type a new one.\n");
      }

      output.write("Filter, number, or q: ");
      const next = await iterator.next();
      if (next.done) return null;
      const answer = normalizeText(next.value);
      if (!answer) {
        if (query) {
          query = "";
        }
        continue;
      }

      if (answer.toLowerCase() === "q") {
        return null;
      }

      if (/^\d+$/.test(answer)) {
        const selected = view.shown[Number(answer) - 1] ?? null;
        if (selected) {
          return { action: "select", candidate: selected };
        }
        output.write("Invalid selection.\n");
        continue;
      }

      query = answer;
    }
  } finally {
    rl.close();
  }
}

export function filterCandidates(candidates, query = "") {
  const normalized = normalizeQuery(query);
  if (!normalized) return candidates.slice();
  return candidates.filter((candidate) => normalizeText(candidate?.search_text).toLowerCase().includes(normalized));
}

export function renderCandidateList(candidates, { query = "", limit = DEFAULT_LIMIT } = {}) {
  const filtered = filterCandidates(candidates, query);
  const shown = filtered.slice(0, limit);
  const lines = [`Filter: ${query ? query : "(all)"}`, ""];

  shown.forEach((candidate, index) => {
    lines.push(`[${index + 1}] ${projectLabel(candidate)} [${sessionKindLabel(candidate)}] ${displayTime(candidate)}`);
    lines.push(`    Prompt: ${promptPreview(candidate)}`);
    lines.push(`    ${statsSummary(candidate)}`);
    lines.push("");
  });

  if (!shown.length) {
    lines.push("No matches.");
  } else if (filtered.length > shown.length) {
    lines.push(`${filtered.length - shown.length} more matches not shown. Refine the filter or raise --limit.`);
  }

  return {
    filtered,
    shown,
    text: lines.join("\n").trimEnd(),
  };
}

export function createInteractivePickerState(candidates, initialQuery = "") {
  return normalizeInteractiveState(candidates, {
    query: initialQuery,
    selectedIndex: 0,
  });
}

export function getInteractivePageSize(rows) {
  return pageSizeForRows(rows);
}

export function renderInteractivePickerView(candidates, state, { rows = DEFAULT_ROWS, columns = DEFAULT_COLUMNS, useColor = false } = {}) {
  const width = visibleColumns(columns);
  const colors = createColors(Boolean(useColor));
  const normalizedState = normalizeInteractiveState(candidates, state);
  const listWindow = renderListWindow(candidates, normalizedState, { rows, columns: width, colors });
  const detail = listWindow.selected
    ? detailLines(listWindow.selected, width)
    : [
        "Selected: none",
        "Updated: n/a",
        "Rollouts: n/a",
        "Prompt: no matches",
        "        ",
        "Source: n/a",
        "Actions: Enter open preview | S save html | Esc clear filter | Q quit",
      ];
  const header = renderHeaderLines(candidates, normalizedState, listWindow.selectedIndex, listWindow.total, width, colors);
  const divider = styleLine("-".repeat(width), width, { colors, muted: true });
  const detailStyled = detail.map((line, index) =>
    styleLine(line, width, {
      colors,
      accent: index === 0,
      muted: index > 0,
    })
  );

  const lines = [...header, ...listWindow.lines, divider, ...detailStyled];
  const clipped = lines.slice(0, Math.max(Number(rows) || DEFAULT_ROWS, HEADER_ROWS + ENTRY_ROWS + 2));

  return {
    text: clipped.join("\n"),
    selected: listWindow.selected,
    filtered: filterCandidates(candidates, normalizedState.query),
    state: normalizedState,
  };
}

export function applyInteractivePickerKey(
  candidates,
  state,
  key,
  { rows = DEFAULT_ROWS, columns = DEFAULT_COLUMNS } = {}
) {
  const normalizedState = normalizeInteractiveState(candidates, state);
  const filtered = filterCandidates(candidates, normalizedState.query);
  const pageSize = getInteractivePageSize(rows);
  const lowerKey = typeof key === "string" ? key.toLowerCase() : key;

  if (lowerKey === "q") {
    return { state: normalizedState, action: "quit" };
  }

  if (lowerKey === "s") {
    if (!filtered.length) return { state: normalizedState, action: null };
    return { state: normalizedState, action: "save" };
  }

  if (key === "enter") {
    if (!filtered.length) return { state: normalizedState, action: null };
    return { state: normalizedState, action: "open" };
  }

  if (key === "up") {
    return { state: updateSelectionIndex(candidates, normalizedState, normalizedState.selectedIndex - 1), action: null };
  }

  if (key === "down") {
    return { state: updateSelectionIndex(candidates, normalizedState, normalizedState.selectedIndex + 1), action: null };
  }

  if (key === "pageup") {
    return {
      state: updateSelectionIndex(candidates, normalizedState, normalizedState.selectedIndex - pageSize),
      action: null,
    };
  }

  if (key === "pagedown") {
    return {
      state: updateSelectionIndex(candidates, normalizedState, normalizedState.selectedIndex + pageSize),
      action: null,
    };
  }

  if (key === "backspace") {
    return {
      state: normalizeInteractiveState(candidates, {
        ...normalizedState,
        query: normalizedState.query.slice(0, -1),
        selectedIndex: 0,
      }),
      action: null,
    };
  }

  if (key === "escape") {
    if (!normalizedState.query) return { state: normalizedState, action: null };
    return {
      state: normalizeInteractiveState(candidates, {
        ...normalizedState,
        query: "",
        selectedIndex: 0,
      }),
      action: null,
    };
  }

  if (typeof key === "string" && key.length === 1 && key >= " " && key !== "\u007f") {
    return {
      state: normalizeInteractiveState(candidates, {
        ...normalizedState,
        query: `${normalizedState.query}${key}`,
        selectedIndex: 0,
      }),
      action: null,
    };
  }

  return { state: normalizedState, action: null };
}

export async function pickCodexInput(
  candidates,
  { input = process.stdin, output = process.stderr, limit = DEFAULT_LIMIT } = {}
) {
  if (!(input?.isTTY && output?.isTTY)) {
    return pickWithFallback(candidates, { input, output, limit });
  }

  const colors = createColors(true);
  let state = createInteractivePickerState(candidates);
  let resolved = false;

  return new Promise((resolve) => {
    const render = () => {
      const view = renderInteractivePickerView(candidates, state, {
        rows: output.rows ?? DEFAULT_ROWS,
        columns: output.columns ?? DEFAULT_COLUMNS,
        useColor: true,
      });
      output.write(`\u001b[?25l\u001b[2J\u001b[H${view.text}\u001b[0J`);
    };

    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      input.off("data", handleData);
      output.off?.("resize", handleResize);
      if (typeof input.setRawMode === "function") input.setRawMode(false);
      if (typeof input.pause === "function") input.pause();
      output.write(`${colors.reset("\u001b[?25h")}\n`);
    };

    const finish = (result) => {
      cleanup();
      resolve(result);
    };

    const handleResize = () => {
      render();
    };

    const handleData = (chunk) => {
      for (const key of parseInteractiveKeys(chunk)) {
        const result = applyInteractivePickerKey(candidates, state, key, {
          rows: output.rows ?? DEFAULT_ROWS,
          columns: output.columns ?? DEFAULT_COLUMNS,
        });
        state = result.state;
        if (result.action === "quit") {
          finish(null);
          return;
        }
        if (result.action === "open" || result.action === "save") {
          const filtered = filterCandidates(candidates, state.query);
          const candidate = filtered[state.selectedIndex] ?? null;
          if (candidate) {
            finish({ action: result.action, candidate });
            return;
          }
        }
      }
      render();
    };

    if (typeof input.setRawMode === "function") input.setRawMode(true);
    input.resume?.();
    input.on("data", handleData);
    output.on?.("resize", handleResize);
    render();
  });
}

export { stripAnsi };
