#!/usr/bin/env node

/**
 * CLI entry point for codex-replay.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { discoverCodexInputs, getDefaultCodexHome } from "../src/discovery.mjs";
import { filterTranscript, parseTranscript, parseTranscriptGroup } from "../src/parser.mjs";
import { pickCodexInput } from "../src/picker.mjs";
import { launchTarget, openEphemeralPreview } from "../src/preview-server.mjs";
import { render } from "../src/renderer.mjs";
import { getTheme, listThemes, loadThemeFile } from "../src/themes.mjs";

const options = {
  output: { type: "string", short: "o" },
  pick: { type: "boolean", default: false },
  "codex-home": { type: "string" },
  limit: { type: "string", default: "50" },
  format: { type: "string", default: "auto" },
  from: { type: "string" },
  to: { type: "string" },
  speed: { type: "string", default: "1" },
  "no-reasoning": { type: "boolean", default: false },
  "no-tools": { type: "boolean", default: false },
  "no-system": { type: "boolean", default: false },
  "no-thinking": { type: "boolean", default: false },
  "no-tool-calls": { type: "boolean", default: false },
  theme: { type: "string", default: "cinder-amber" },
  "theme-file": { type: "string" },
  "list-themes": { type: "boolean", default: false },
  "no-redact": { type: "boolean", default: false },
  title: { type: "string" },
  "user-label": { type: "string", default: "User" },
  "assistant-label": { type: "string", default: "Codex" },
  mark: { type: "string", multiple: true },
  bookmarks: { type: "string" },
  "no-minify": { type: "boolean", default: false },
  "no-compress": { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
};

let parsed;
try {
  parsed = parseArgs({ options, allowPositionals: true });
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}

const { values, positionals } = parsed;

function printHelp() {
  console.log(`Usage: codex-replay [input.jsonl] [options]

Convert Codex rollout logs or ~/.codex/history.jsonl into a self-contained HTML replay.

Options:
  -o, --output FILE       Output HTML file (default: stdout)
  --pick                  Open the interactive Codex session picker
  --codex-home DIR        Scan a custom Codex home directory (default: ~/.codex)
  --limit N               Max fallback picker rows to display before filtering (default: 50)
  --format NAME           Input format: auto | rollout | history (default: auto)
  --from TIMESTAMP        Start time filter (ISO 8601)
  --to TIMESTAMP          End time filter (ISO 8601)
  --speed N               Initial playback speed (default: 1.0)
  --no-reasoning          Hide reasoning blocks by default
  --no-tools              Hide tool blocks by default
  --no-system             Hide system notice blocks by default
  --title TEXT            Page title override
  --no-redact             Disable secret redaction in output
  --theme NAME            Built-in theme (default: cinder-amber)
  --theme-file FILE       Custom theme JSON file (overrides --theme)
  --user-label NAME       Label for user messages (default: User)
  --assistant-label NAME  Label for assistant messages (default: Codex)
  --mark "N:Label"        Add a bookmark at turn N (repeatable)
  --bookmarks FILE        JSON file with bookmarks [{turn, label}]
  --no-minify             Use unminified template
  --no-compress           Embed raw JSON instead of compressed data
  --list-themes           List available built-in themes and exit
  --no-thinking           Deprecated alias for --no-reasoning
  --no-tool-calls         Deprecated alias for --no-tools
  -h, --help              Show this help message`);
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function parsePositiveInteger(value, label) {
  const parsedInteger = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsedInteger) || parsedInteger <= 0) {
    fail(`invalid ${label} '${value}'`);
  }
  return parsedInteger;
}

function parseBookmarks(bookmarksPath, marks) {
  const bookmarks = [];

  if (marks) {
    for (const mark of marks) {
      const separator = mark.indexOf(":");
      if (separator === -1) fail(`invalid --mark format '${mark}' (expected N:Label)`);
      const turn = Number.parseInt(mark.slice(0, separator), 10);
      if (!Number.isInteger(turn)) fail(`invalid turn number in --mark '${mark}'`);
      bookmarks.push({ turn, label: mark.slice(separator + 1) });
    }
  }

  if (bookmarksPath) {
    if (!existsSync(bookmarksPath)) fail(`bookmarks file not found: ${bookmarksPath}`);
    let parsedBookmarks;
    try {
      parsedBookmarks = JSON.parse(readFileSync(bookmarksPath, "utf-8"));
    } catch (error) {
      fail(`failed to parse bookmarks file: ${error.message}`);
    }
    if (!Array.isArray(parsedBookmarks)) fail("bookmarks file must contain a JSON array");
    for (const bookmark of parsedBookmarks) {
      if (typeof bookmark?.turn !== "number" || typeof bookmark?.label !== "string") {
        fail("each bookmark must have numeric 'turn' and string 'label'");
      }
      bookmarks.push({ turn: bookmark.turn, label: bookmark.label });
    }
  }

  return bookmarks.sort((left, right) => left.turn - right.turn);
}

function resolveTheme() {
  if (values["theme-file"]) {
    if (!existsSync(values["theme-file"])) fail(`theme file not found: ${values["theme-file"]}`);
    try {
      return loadThemeFile(values["theme-file"]);
    } catch (error) {
      fail(`loading theme file failed: ${error.message}`);
    }
  }

  try {
    return getTheme(values.theme);
  } catch (error) {
    fail(error.message);
  }
}

function shortenSessionId(sessionId) {
  if (typeof sessionId !== "string" || !sessionId) return null;
  return sessionId.length > 12 ? sessionId.slice(0, 12) : sessionId;
}

function deriveTitle(document, inputFile, pickedCandidate = null) {
  if (values.title) return values.title;

  const meta = document.meta ?? {};
  if (document.format === "history") {
    if (pickedCandidate?.history_session_id) {
      return `Codex History Replay - ${shortenSessionId(pickedCandidate.history_session_id)}`;
    }
    const sessions = Array.isArray(document.sessions) ? document.sessions.length : 0;
    return sessions ? `Codex History Replay (${sessions} sessions)` : "Codex History Replay";
  }

  if (typeof meta.cwd === "string" && meta.cwd) {
    if (meta.grouped && Number.isInteger(meta.member_count) && meta.member_count > 1) {
      return `Codex Replay - ${basename(meta.cwd)} (+${meta.member_count} sessions)`;
    }
    return `Codex Replay - ${basename(meta.cwd)}`;
  }
  if (typeof meta.session_id === "string" && meta.session_id) {
    return `Codex Replay - ${meta.session_id.slice(0, 12)}`;
  }
  return `Codex Replay - ${basename(inputFile, ".jsonl")}`;
}

function filterHistorySessionDocument(document, sessionId) {
  if (document.format !== "history" || !sessionId) return document;
  const turns = document.turns
    .filter((turn) => turn.session_id === sessionId)
    .map((turn, index) => ({
      ...turn,
      index: index + 1,
    }));

  return {
    ...document,
    meta: {
      ...document.meta,
      filtered_session_id: sessionId,
      entry_count: turns.length,
    },
    turns,
    sessions: turns.length ? [{ session_id: sessionId, turns }] : [],
  };
}

function sanitizeFileName(value) {
  return String(value ?? "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function suggestOutputFileName(pickedCandidate, inputFile) {
  const seed =
    pickedCandidate?.session_id ??
    pickedCandidate?.history_session_id ??
    basename(inputFile, ".jsonl") ??
    "codex-replay";
  const normalized = sanitizeFileName(seed) || "codex-replay";
  return `codex-replay-${normalized}.html`;
}

async function promptForOutputPath(defaultPath, { input = process.stdin, output = process.stderr } = {}) {
  const rl = createInterface({
    input,
    output,
    crlfDelay: Infinity,
    terminal: Boolean(input?.isTTY && output?.isTTY),
  });

  try {
    const answer = await new Promise((resolvePrompt) => {
      rl.question(`Save path [${defaultPath}]: `, resolvePrompt);
    });
    const trimmed = String(answer ?? "").trim();
    return trimmed || defaultPath;
  } finally {
    rl.close();
  }
}

function describeWrite(document, inputFiles) {
  if (document.format === "rollout" && inputFiles.length > 1) {
    return `${document.format}, ${document.turns.length} turns, ${inputFiles.length} grouped sessions`;
  }
  return `${document.format}, ${document.turns.length} turns`;
}

if (values.help) {
  printHelp();
  process.exit(0);
}

if (values["list-themes"]) {
  for (const name of listThemes()) console.log(name);
  process.exit(0);
}

const pickerLimit = parsePositiveInteger(values.limit, "--limit");
const codexHome = values["codex-home"] ?? getDefaultCodexHome();
const autoPick = Boolean(process.stdin.isTTY && process.stderr.isTTY);

if (positionals.length > 1) {
  fail("only one input file may be provided");
}

if (values.pick && positionals[0]) {
  fail("--pick cannot be used together with an explicit input file");
}

if (!["auto", "rollout", "history"].includes(values.format)) {
  fail(`invalid --format '${values.format}' (expected auto, rollout, or history)`);
}

if ((values.pick || (!positionals[0] && autoPick)) && values.format !== "auto") {
  fail("picker mode requires --format auto so the selected file controls the format");
}

const speed = Number.parseFloat(values.speed);
if (!Number.isFinite(speed) || speed <= 0) {
  fail(`invalid --speed '${values.speed}'`);
}

let showReasoning = !values["no-reasoning"];
let showTools = !values["no-tools"];
if (values["no-thinking"]) {
  showReasoning = false;
  console.error("Warning: --no-thinking is deprecated; use --no-reasoning instead.");
}
if (values["no-tool-calls"]) {
  showTools = false;
  console.error("Warning: --no-tool-calls is deprecated; use --no-tools instead.");
}

const theme = resolveTheme();
const bookmarks = parseBookmarks(values.bookmarks, values.mark);
let inputFile = positionals[0] ?? null;
let inputFormat = values.format;
let inputFiles = inputFile ? [inputFile] : null;
let pickedCandidate = null;
let pickerAction = "select";
let historySessionId = null;

if (!inputFile) {
  if (values.pick || autoPick) {
    const candidates = discoverCodexInputs({ codexHome });
    if (!candidates.length) {
      fail(`no Codex sessions found under ${codexHome}`);
    }
    const pickedResult = await pickCodexInput(candidates, {
      input: process.stdin,
      output: process.stderr,
      limit: pickerLimit,
    });
    if (!pickedResult) {
      process.exit(0);
    }
    pickedCandidate = pickedResult.candidate;
    pickerAction = pickedResult.action ?? "select";
    inputFile = pickedCandidate.path;
    inputFiles =
      Array.isArray(pickedCandidate.paths) && pickedCandidate.paths.length
        ? pickedCandidate.paths.slice()
        : [pickedCandidate.path];
    inputFormat = pickedCandidate.format;
    historySessionId = pickedCandidate.history_session_id ?? null;
  } else {
    fail("input file is required. Usage: codex-replay [input.jsonl] [options]");
  }
}

if (!Array.isArray(inputFiles) || !inputFiles.length) fail("input file is required");
for (const filePath of inputFiles) {
  if (!existsSync(filePath)) fail(`file not found: ${filePath}`);
}

let document;
try {
  if (inputFormat === "rollout" && inputFiles.length > 1) {
    document = parseTranscriptGroup(inputFiles);
  } else {
    document = parseTranscript(inputFile, { format: inputFormat });
  }

  if (inputFormat === "history" && historySessionId) {
    document = filterHistorySessionDocument(document, historySessionId);
  }

  document = filterTranscript(document, {
    timeFrom: values.from,
    timeTo: values.to,
  });
} catch (error) {
  fail(error.message);
}

if (!document.turns.length) {
  console.error("Warning: no turns found after filtering.");
}

const title = deriveTitle(document, inputFile, pickedCandidate);
const html = render(document, {
  speed,
  showReasoning,
  showTools,
  showSystem: !values["no-system"],
  theme,
  redactSecrets: !values["no-redact"],
  userLabel: values["user-label"],
  assistantLabel: values["assistant-label"],
  title,
  bookmarks,
  minified: !values["no-minify"],
  compress: !values["no-compress"],
});

let outputPath = values.output ?? null;
const suggestedFileName = suggestOutputFileName(pickedCandidate, inputFile);
let previewUrl = null;

if (pickerAction === "save") {
  outputPath = await promptForOutputPath(outputPath ?? suggestedFileName, {
    input: process.stdin,
    output: process.stderr,
  });
} else if (pickerAction === "open" && !outputPath) {
  try {
    const preview = await openEphemeralPreview(html);
    previewUrl = preview.url;
  } catch (error) {
    fail(`failed to start preview server: ${error.message}`);
  }
}

if (outputPath) {
  writeFileSync(outputPath, html);
  console.error(`Wrote ${outputPath} (${describeWrite(document, inputFiles)})`);

  if (pickerAction === "open") {
    if (!launchTarget(outputPath)) {
      console.error(`Open manually: ${resolve(outputPath)}`);
    }
  }
} else if (previewUrl) {
  if (!launchTarget(previewUrl)) {
    console.error(`Open manually: ${previewUrl}`);
  }
} else {
  process.stdout.write(html);
}
