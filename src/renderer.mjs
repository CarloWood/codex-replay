/**
 * Render normalized replay data into a self-contained HTML document.
 */

import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { getTheme, themeToCss } from "./themes.mjs";
import { redactObject, redactSecrets } from "./secrets.mjs";

const TEMPLATE_PATH = new URL("../template/player.html", import.meta.url);
const TEMPLATE_MIN_PATH = new URL("../template/player.min.html", import.meta.url);

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeJsonForScript(json) {
  return JSON.stringify(json)
    .slice(1, -1)
    .replace(/<\//g, "<\\/")
    .replace(/<!--/g, "<\\!--");
}

function compressForEmbed(json) {
  return deflateSync(Buffer.from(json)).toString("base64");
}

function serializeBlock(block, { redact }) {
  return {
    kind: block.kind,
    text: redact ? redactSecrets(block.text) : block.text,
    summary_text: redact ? redactSecrets(block.summary_text) : block.summary_text,
    phase: block.phase ?? null,
    name: block.name ?? null,
    call_id: block.call_id ?? null,
    timestamp: block.timestamp ?? null,
    response_timestamp: block.response_timestamp ?? null,
    input: redact ? redactObject(block.input) : block.input,
    output: redact ? redactObject(block.output) : block.output,
    questions: redact ? redactObject(block.questions) : block.questions,
    answers: redact ? redactObject(block.answers) : block.answers,
    meta: redact ? redactObject(block.meta) : block.meta,
    status: block.status ?? null,
  };
}

function serializeTurn(turn, { redact }) {
  return {
    index: turn.index,
    turn_id: turn.turn_id ?? null,
    session_id: turn.session_id ?? null,
    source_session_id: turn.source_session_id ?? null,
    source_agent_label: turn.source_agent_label ?? null,
    source_role: turn.source_role ?? null,
    source_is_root: Boolean(turn.source_is_root),
    user_text: redact ? redactSecrets(turn.user_text) : turn.user_text,
    attachments: redact ? redactObject(turn.attachments) : turn.attachments,
    blocks: turn.blocks.map((block) => serializeBlock(block, { redact })),
    status: turn.status,
    timestamp: turn.timestamp ?? null,
  };
}

function serializeDocument(document, { redact = true } = {}) {
  return {
    format: document.format,
    meta: redact ? redactObject(document.meta) : document.meta,
    turns: document.turns.map((turn) => serializeTurn(turn, { redact })),
    sessions: Array.isArray(document.sessions)
      ? document.sessions.map((session) => ({
          session_id: session.session_id,
          turns: session.turns.map((turn) => serializeTurn(turn, { redact })),
        }))
      : [],
  };
}

/**
 * Render replay data into a self-contained HTML string.
 * @param {import("./parser.mjs").ReplayDocument} document
 * @param {{
 *   speed?: number,
 *   showReasoning?: boolean,
 *   showTools?: boolean,
 *   showSystem?: boolean,
 *   theme?: Record<string, string>,
 *   title?: string,
 *   userLabel?: string,
 *   assistantLabel?: string,
 *   redactSecrets?: boolean,
 *   minified?: boolean,
 *   compress?: boolean,
 *   bookmarks?: { turn: number, label: string }[],
 * }} opts
 * @returns {string}
 */
export function render(document, opts = {}) {
  const {
    speed: rawSpeed = 1,
    showReasoning = true,
    showTools = true,
    showSystem = true,
    theme = getTheme("cinder-amber"),
    title = document.format === "history" ? "Codex History Replay" : "Codex Replay",
    userLabel = "User",
    assistantLabel = "Codex",
    redactSecrets: redact = true,
    bookmarks = [],
  } = opts;

  const speed = Number.isFinite(rawSpeed) ? Math.max(0.25, Math.min(rawSpeed, 8)) : 1;

  let html;
  if (opts.minified === false) {
    html = readFileSync(TEMPLATE_PATH, "utf-8");
  } else {
    try {
      html = readFileSync(TEMPLATE_MIN_PATH, "utf-8");
    } catch {
      html = readFileSync(TEMPLATE_PATH, "utf-8");
    }
  }

  html = html.replace("/*THEME_CSS*/", themeToCss(theme));
  html = html.replace("/*INITIAL_SPEED*/1", String(speed));
  html = html.replace(/\/\*INITIAL_SPEED\*\//g, String(speed));
  html = html.replaceAll("/*CHECKED_REASONING*/", showReasoning ? "checked" : "");
  html = html.replaceAll("/*CHECKED_TOOLS*/", showTools ? "checked" : "");
  html = html.replaceAll("/*CHECKED_SYSTEM*/", showSystem ? "checked" : "");
  html = html.replaceAll("/*PAGE_TITLE*/", escapeHtml(title));
  html = html.replace("/*USER_LABEL*/", escapeHtml(userLabel));
  html = html.replace("/*ASSISTANT_LABEL*/", escapeHtml(assistantLabel));

  const embedData = (json) => {
    if (opts.compress === false) return escapeJsonForScript(json);
    return compressForEmbed(json);
  };

  html = html.replace(
    "/*BOOKMARKS_DATA*/",
    embedData(JSON.stringify(bookmarks))
  );
  html = html.replace(
    "/*REPLAY_DATA*/",
    embedData(JSON.stringify(serializeDocument(document, { redact })))
  );

  return html;
}
