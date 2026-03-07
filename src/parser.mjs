/**
 * Parse Codex rollout logs and persistent history into a normalized replay model.
 */

import { readFileSync } from "node:fs";

/**
 * @typedef {{
 *   format: "rollout" | "history",
 *   meta: Record<string, unknown>,
 *   turns: ReplayTurn[],
 *   sessions?: HistorySession[],
 * }} ReplayDocument
 *
 * @typedef {{
 *   index: number,
 *   turn_id: string | null,
 *   session_id: string | null,
 *   source_session_id?: string | null,
 *   source_agent_label?: string | null,
 *   source_role?: string | null,
 *   source_is_root?: boolean,
 *   user_text: string,
 *   attachments: { images: string[], local_images: string[] },
 *   blocks: ReplayBlock[],
 *   status: "completed" | "aborted" | "history" | "in_progress",
 *   timestamp: string | null,
 * }} ReplayTurn
 *
 * @typedef {{
 *   kind: string,
 *   text?: string,
 *   summary_text?: string | null,
 *   phase?: string | null,
 *   name?: string | null,
 *   call_id?: string | null,
 *   timestamp?: string | null,
 *   response_timestamp?: string | null,
 *   input?: unknown,
 *   output?: unknown,
 *   questions?: unknown[],
 *   answers?: unknown,
 *   meta?: Record<string, unknown> | null,
 *   status?: string | null,
 * }} ReplayBlock
 *
 * @typedef {{
 *   session_id: string,
 *   turns: ReplayTurn[],
 * }} HistorySession
 */

const HOME_DIR = process.env.HOME ?? "";
const ASSISTANT_PHASE_PRIORITY = {
  "final_answer": 4,
  "commentary": 3,
  "final": 2,
  "message": 1,
};

function readJsonLines(filePath) {
  const text = readFileSync(filePath, "utf-8");
  const entries = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // Ignore malformed lines so partially written logs still parse.
    }
  }
  return entries;
}

function cleanText(text) {
  if (typeof text !== "string") return "";
  return text.replace(/\r\n/g, "\n").trim();
}

function normalizeHomePath(value) {
  if (typeof value !== "string") return value;
  if (HOME_DIR && value.startsWith(HOME_DIR)) {
    return "~" + value.slice(HOME_DIR.length);
  }
  return value;
}

function safeJsonParse(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function toIsoTimestamp(ts) {
  if (typeof ts === "number" && Number.isFinite(ts)) {
    return new Date(ts * 1000).toISOString();
  }
  if (typeof ts === "string" && ts) {
    const asNumber = Number(ts);
    if (Number.isFinite(asNumber)) return new Date(asNumber * 1000).toISOString();
    const asDate = new Date(ts);
    if (!Number.isNaN(asDate.getTime())) return asDate.toISOString();
  }
  return null;
}

function toTimeMs(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.getTime();
}

function shortenSessionId(sessionId) {
  if (typeof sessionId !== "string" || !sessionId) return "unknown";
  return sessionId.length > 12 ? sessionId.slice(0, 12) : sessionId;
}

function deriveSourceAgentLabel(meta) {
  if (meta?.agent_nickname) return meta.agent_nickname;
  if (meta?.parent_thread_id) return shortenSessionId(meta.session_id);
  return "main";
}

function extractAssistantMessageText(content) {
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const item of content) {
    if (item?.type === "output_text" || item?.type === "text") {
      parts.push(item.text ?? "");
    }
  }
  return cleanText(parts.join("\n\n"));
}

function extractReasoningText(content) {
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const item of content) {
    if (item?.type === "reasoning_text" || item?.type === "text") {
      parts.push(item.text ?? "");
    }
  }
  return cleanText(parts.join("\n\n"));
}

function extractReasoningSummaryText(summary) {
  if (!Array.isArray(summary)) return "";
  const parts = [];
  for (const item of summary) {
    if (item?.type === "summary_text" || item?.type === "text") {
      parts.push(item.text ?? "");
    }
  }
  return cleanText(parts.join("\n\n"));
}

function parseToolInput(value) {
  if (typeof value !== "string") return value ?? null;
  const parsed = safeJsonParse(value);
  return parsed ?? value;
}

function extractToolOutput(raw) {
  if (raw == null) return null;
  if (typeof raw === "string") {
    return safeJsonParse(raw) ?? raw;
  }
  if (typeof raw === "object") {
    if ("body" in raw && raw.body !== undefined) {
      return raw.body;
    }
    return raw;
  }
  return raw;
}

function summarizePlanUpdate(payload) {
  if (!payload || typeof payload !== "object") return "Plan updated";
  const items = Array.isArray(payload.plan) ? payload.plan : [];
  const summary = items
    .map((item) => {
      const status = typeof item.status === "string" ? item.status : "pending";
      const step = typeof item.step === "string" ? item.step : "Unnamed step";
      return `[${status}] ${step}`;
    })
    .join("\n");
  const explanation = typeof payload.explanation === "string" ? cleanText(payload.explanation) : "";
  return cleanText([explanation, summary].filter(Boolean).join("\n"));
}

function summarizeItemEvent(payload, label) {
  const itemType = payload?.item?.type ?? "unknown";
  const turnId = payload?.turn_id ?? payload?.turnId ?? null;
  const suffix = turnId ? ` (${turnId})` : "";
  return `${label}: ${itemType}${suffix}`;
}

function blockSignature(block) {
  return JSON.stringify([
    block.kind,
    block.phase ?? "",
    block.name ?? "",
    block.call_id ?? "",
    block.text ?? "",
    block.summary_text ?? "",
    JSON.stringify(block.input ?? null),
    JSON.stringify(block.output ?? null),
    JSON.stringify(block.questions ?? null),
    JSON.stringify(block.answers ?? null),
    JSON.stringify(block.meta ?? null),
    block.status ?? "",
  ]);
}

function normalizeAssistantPhase(phase) {
  return typeof phase === "string" && phase ? phase : null;
}

function getAssistantPhasePriority(phase) {
  return ASSISTANT_PHASE_PRIORITY[phase ?? "message"] ?? ASSISTANT_PHASE_PRIORITY.message;
}

function createTurn(meta, timestamp, turnId) {
  return {
    index: 0,
    turn_id: turnId ?? null,
    session_id: typeof meta.session_id === "string" ? meta.session_id : null,
    user_text: "",
    attachments: {
      images: [],
      local_images: [],
    },
    blocks: [],
    status: "in_progress",
    timestamp: timestamp ?? null,
    _seen: new Set(),
    _pending: new Map(),
  };
}

function ensureTurn(state, timestamp) {
  if (!state.currentTurn) {
    state.currentTurn = createTurn(state.meta, timestamp, state.lastTurnId);
  }
  if (!state.currentTurn.timestamp && timestamp) {
    state.currentTurn.timestamp = timestamp;
  }
  return state.currentTurn;
}

function hasMaterialTurnState(turn) {
  return Boolean(turn && (turn.user_text || turn.blocks.length || turn.attachments.images.length || turn.attachments.local_images.length));
}

function pushBlock(turn, block) {
  const normalized = { ...block };
  if (typeof normalized.text === "string") {
    normalized.text = cleanText(normalized.text);
  }
  if (typeof normalized.summary_text === "string") {
    normalized.summary_text = cleanText(normalized.summary_text);
  }
  if (!normalized.timestamp && turn.timestamp) {
    normalized.timestamp = turn.timestamp;
  }
  const signature = blockSignature(normalized);
  if (turn._seen.has(signature)) {
    return turn.blocks.find((candidate) => blockSignature(candidate) === signature) ?? null;
  }
  turn._seen.add(signature);
  turn.blocks.push(normalized);
  if (normalized.call_id) {
    turn._pending.set(normalized.call_id, normalized);
  }
  return normalized;
}

function mergeAssistantMessageBlock(existingBlock, incomingBlock) {
  const incomingPhase = normalizeAssistantPhase(incomingBlock.phase);
  const existingPriority = getAssistantPhasePriority(existingBlock.phase);
  const incomingPriority = getAssistantPhasePriority(incomingPhase);

  if (
    incomingPriority > existingPriority ||
    (incomingPriority === existingPriority && !existingBlock.phase && incomingPhase)
  ) {
    existingBlock.phase = incomingPhase;
  }

  if ((!existingBlock.timestamp && incomingBlock.timestamp) || incomingPriority > existingPriority) {
    existingBlock.timestamp = incomingBlock.timestamp ?? existingBlock.timestamp ?? null;
  }

  return existingBlock;
}

function pushAssistantMessageBlock(turn, block) {
  const normalized = {
    ...block,
    kind: "assistant_message",
    phase: normalizeAssistantPhase(block.phase),
  };

  if (typeof normalized.text === "string") {
    normalized.text = cleanText(normalized.text);
  }
  if (!normalized.text) return null;
  if (!normalized.timestamp && turn.timestamp) {
    normalized.timestamp = turn.timestamp;
  }

  const duplicate = turn.blocks.find(
    (candidate) =>
      candidate.kind === "assistant_message" &&
      cleanText(candidate.text) === normalized.text
  );
  if (duplicate) {
    return mergeAssistantMessageBlock(duplicate, normalized);
  }

  return pushBlock(turn, normalized);
}

function finalizePendingCall(turn, callId, output, timestamp) {
  const block = turn?._pending.get(callId);
  if (!block) return;
  block.output = output;
  if (timestamp) block.response_timestamp = timestamp;
  if (block.kind === "request_user_input") {
    const answerSource = typeof output === "string" ? output : JSON.stringify(output);
    const parsed = safeJsonParse(answerSource);
    block.answers = parsed?.answers ?? parsed ?? output;
  }
  turn._pending.delete(callId);
}

function turnHasContent(turn) {
  return Boolean(
    cleanText(turn.user_text) ||
    turn.blocks.length > 0 ||
    turn.attachments.images.length > 0 ||
    turn.attachments.local_images.length > 0
  );
}

function normalizeTurnForOutput(turn, index) {
  return {
    index,
    turn_id: turn.turn_id ?? null,
    session_id: turn.session_id ?? null,
    source_session_id: turn.source_session_id ?? turn.session_id ?? null,
    source_agent_label: turn.source_agent_label ?? null,
    source_role: turn.source_role ?? null,
    source_is_root: Boolean(turn.source_is_root),
    user_text: cleanText(turn.user_text),
    attachments: turn.attachments,
    blocks: turn.blocks,
    status: turn.status,
    timestamp: turn.timestamp ?? null,
  };
}

function finalizeTurn(state) {
  const turn = state.currentTurn;
  if (!turn) return;
  if (!turnHasContent(turn)) {
    state.currentTurn = null;
    return;
  }
  const normalized = normalizeTurnForOutput(turn, state.turns.length + 1);
  state.turns.push(normalized);
  state.currentTurn = null;
}

function applyUserMessage(turn, payload, timestamp) {
  turn.user_text = cleanText(payload?.message ?? "");
  turn.timestamp = timestamp ?? turn.timestamp ?? null;
  turn.attachments = {
    images: Array.isArray(payload?.images)
      ? payload.images.filter((value) => typeof value === "string").map(normalizeHomePath)
      : [],
    local_images: Array.isArray(payload?.local_images)
      ? payload.local_images.filter((value) => typeof value === "string").map(normalizeHomePath)
      : [],
  };
}

function parseRolloutEntries(entries, opts = {}) {
  const state = {
    meta: {
      source: "rollout",
      session_id: null,
      cwd: null,
      cli_version: null,
      model_provider: null,
      started_at: null,
      parent_thread_id: null,
      agent_nickname: null,
      agent_role: null,
      source_path: opts.sourcePath ?? null,
    },
    turns: [],
    currentTurn: null,
    lastTurnId: null,
    seenTurnStart: false,
  };

  for (const entry of entries) {
    const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : null;

    if (entry.type === "session_meta") {
      const payload = entry.payload ?? {};
      state.meta = {
        source: payload.source ?? "rollout",
        session_id: payload.id ?? null,
        cwd: payload.cwd ?? null,
        cli_version: payload.cli_version ?? null,
        model_provider: payload.model_provider ?? null,
        started_at: payload.timestamp ?? timestamp ?? null,
        parent_thread_id: payload.source?.subagent?.thread_spawn?.parent_thread_id ?? null,
        agent_nickname: payload.agent_nickname ?? null,
        agent_role: payload.agent_role ?? null,
        source_path: opts.sourcePath ?? null,
      };
      continue;
    }

    if (entry.type === "turn_context") {
      const payload = entry.payload ?? {};
      if (!state.meta.cwd && payload.cwd) state.meta.cwd = payload.cwd;
      if (!state.meta.model_provider && (payload.model_provider || payload.model)) {
        state.meta.model_provider = payload.model_provider ?? payload.model;
      }
      continue;
    }

    if (entry.type === "event_msg") {
      const payload = entry.payload ?? {};
      switch (payload.type) {
        case "task_started": {
          if (state.currentTurn && state.currentTurn.status === "in_progress" && turnHasContent(state.currentTurn)) {
            finalizeTurn(state);
          }
          state.lastTurnId = payload.turn_id ?? null;
          state.currentTurn = createTurn(state.meta, timestamp, state.lastTurnId);
          state.seenTurnStart = true;
          break;
        }
        case "user_message": {
          if (hasMaterialTurnState(state.currentTurn)) {
            state.currentTurn.status = state.currentTurn.status === "in_progress" ? "completed" : state.currentTurn.status;
            finalizeTurn(state);
          }
          const turn = ensureTurn(state, timestamp);
          state.seenTurnStart = true;
          applyUserMessage(turn, payload, timestamp);
          break;
        }
        case "agent_message": {
          if (!state.seenTurnStart && !state.currentTurn) break;
          const turn = ensureTurn(state, timestamp);
          if (cleanText(payload.message ?? "")) {
            pushAssistantMessageBlock(turn, {
              text: payload.message,
              phase: payload.phase ?? null,
              timestamp,
            });
          }
          break;
        }
        case "agent_reasoning": {
          if (!state.seenTurnStart && !state.currentTurn) break;
          const turn = ensureTurn(state, timestamp);
          if (cleanText(payload.text ?? "")) {
            pushBlock(turn, {
              kind: "reasoning",
              text: payload.text,
              timestamp,
            });
          }
          break;
        }
        case "request_user_input": {
          if (!state.seenTurnStart && !state.currentTurn) break;
          const turn = ensureTurn(state, timestamp);
          pushBlock(turn, {
            kind: "request_user_input",
            call_id: payload.call_id ?? null,
            name: "request_user_input",
            questions: Array.isArray(payload.questions) ? payload.questions : [],
            timestamp,
          });
          break;
        }
        case "plan_update": {
          if (!state.seenTurnStart && !state.currentTurn) break;
          const turn = ensureTurn(state, timestamp);
          pushBlock(turn, {
            kind: "system_notice",
            text: summarizePlanUpdate(payload),
            timestamp,
            status: "plan_update",
          });
          break;
        }
        case "context_compacted": {
          if (!state.seenTurnStart && !state.currentTurn) break;
          const turn = ensureTurn(state, timestamp);
          pushBlock(turn, {
            kind: "system_notice",
            text: "Conversation compacted.",
            timestamp,
            status: "context_compacted",
          });
          break;
        }
        case "item_started": {
          if (!state.seenTurnStart && !state.currentTurn) break;
          const turn = ensureTurn(state, timestamp);
          pushBlock(turn, {
            kind: "system_notice",
            text: summarizeItemEvent(payload, "Item started"),
            timestamp,
            status: "item_started",
          });
          break;
        }
        case "item_completed": {
          if (!state.seenTurnStart && !state.currentTurn) break;
          const turn = ensureTurn(state, timestamp);
          pushBlock(turn, {
            kind: "system_notice",
            text: summarizeItemEvent(payload, "Item completed"),
            timestamp,
            status: "item_completed",
          });
          break;
        }
        case "turn_aborted": {
          if (!state.seenTurnStart && !state.currentTurn) break;
          const turn = ensureTurn(state, timestamp);
          turn.status = "aborted";
          if (cleanText(payload.reason ?? "")) {
            pushBlock(turn, {
              kind: "system_notice",
              text: `Turn aborted: ${payload.reason}`,
              timestamp,
              status: "aborted",
            });
          }
          finalizeTurn(state);
          break;
        }
        case "task_complete": {
          if (!state.seenTurnStart && !state.currentTurn) break;
          const turn = ensureTurn(state, timestamp);
          if (cleanText(payload.last_agent_message ?? "")) {
            pushAssistantMessageBlock(turn, {
              text: payload.last_agent_message,
              phase: "final",
              timestamp,
            });
          }
          turn.status = turn.status === "aborted" ? "aborted" : "completed";
          finalizeTurn(state);
          break;
        }
        default:
          break;
      }
      continue;
    }

    if (entry.type !== "response_item") continue;

    const payload = entry.payload ?? {};

    if (payload.type === "message" && payload.role === "assistant") {
      if (!state.seenTurnStart && !state.currentTurn) continue;
      const turn = ensureTurn(state, timestamp);
      const text = extractAssistantMessageText(payload.content);
      if (text) {
        pushAssistantMessageBlock(turn, {
          text,
          phase: payload.phase ?? null,
          timestamp,
        });
      }
      continue;
    }

    if (payload.type === "reasoning") {
      if (!state.seenTurnStart && !state.currentTurn) continue;
      const turn = ensureTurn(state, timestamp);
      const visibleText = extractReasoningText(payload.content);
      if (visibleText) {
        pushBlock(turn, {
          kind: "reasoning",
          text: visibleText,
          timestamp,
        });
      } else if (payload.encrypted_content) {
        const summaryText = extractReasoningSummaryText(payload.summary);
        pushBlock(turn, {
          kind: "reasoning",
          summary_text: summaryText || null,
          timestamp,
          status: "encrypted",
        });
      }
      continue;
    }

    if (payload.type === "function_call") {
      if (!state.seenTurnStart && !state.currentTurn) continue;
      const turn = ensureTurn(state, timestamp);
      const parsedInput = parseToolInput(payload.arguments);
      if (payload.name === "request_user_input") {
        const questions = Array.isArray(parsedInput?.questions) ? parsedInput.questions : [];
        pushBlock(turn, {
          kind: "request_user_input",
          call_id: payload.call_id ?? null,
          name: payload.name,
          questions,
          input: parsedInput,
          timestamp,
        });
      } else {
        pushBlock(turn, {
          kind: "tool_call",
          call_id: payload.call_id ?? null,
          name: payload.name ?? "tool",
          input: parsedInput,
          timestamp,
        });
      }
      continue;
    }

    if (payload.type === "function_call_output") {
      if (!state.seenTurnStart && !state.currentTurn) continue;
      const turn = ensureTurn(state, timestamp);
      finalizePendingCall(turn, payload.call_id, extractToolOutput(payload.output), timestamp);
      continue;
    }

    if (payload.type === "custom_tool_call") {
      if (!state.seenTurnStart && !state.currentTurn) continue;
      const turn = ensureTurn(state, timestamp);
      pushBlock(turn, {
        kind: "custom_tool",
        call_id: payload.call_id ?? null,
        name: payload.name ?? "custom_tool",
        input: parseToolInput(payload.input),
        timestamp,
        status: payload.status ?? null,
      });
      continue;
    }

    if (payload.type === "custom_tool_call_output") {
      if (!state.seenTurnStart && !state.currentTurn) continue;
      const turn = ensureTurn(state, timestamp);
      finalizePendingCall(turn, payload.call_id, extractToolOutput(payload.output), timestamp);
      continue;
    }

    if (payload.type === "web_search_call") {
      if (!state.seenTurnStart && !state.currentTurn) continue;
      const turn = ensureTurn(state, timestamp);
      pushBlock(turn, {
        kind: "web_search",
        name: "web_search",
        meta: {
          action: payload.action ?? null,
        },
        status: payload.status ?? null,
        timestamp,
      });
      continue;
    }

    if (payload.type === "local_shell_call") {
      if (!state.seenTurnStart && !state.currentTurn) continue;
      const turn = ensureTurn(state, timestamp);
      pushBlock(turn, {
        kind: "tool_call",
        call_id: payload.call_id ?? null,
        name: "local_shell_call",
        input: payload.action ?? null,
        status: payload.status ?? null,
        timestamp,
      });
      continue;
    }

    if (payload.type === "ghost_snapshot") {
      if (!state.seenTurnStart && !state.currentTurn) continue;
      const turn = ensureTurn(state, timestamp);
      pushBlock(turn, {
        kind: "system_notice",
        text: "Ghost snapshot captured.",
        meta: {
          ghost_commit: payload.ghost_commit ?? null,
        },
        status: "ghost_snapshot",
        timestamp,
      });
      continue;
    }

    if (payload.type === "compaction") {
      if (!state.seenTurnStart && !state.currentTurn) continue;
      const turn = ensureTurn(state, timestamp);
      pushBlock(turn, {
        kind: "system_notice",
        text: "Compaction payload omitted.",
        status: "compaction",
        timestamp,
      });
    }
  }

  if (state.currentTurn) {
    state.currentTurn.status = state.currentTurn.status === "in_progress" ? "completed" : state.currentTurn.status;
    finalizeTurn(state);
  }

  return {
    format: "rollout",
    meta: state.meta,
    turns: state.turns.map((turn, index) => ({
      ...turn,
      index: index + 1,
      source_session_id: turn.source_session_id ?? state.meta.session_id ?? null,
      source_agent_label: turn.source_agent_label ?? deriveSourceAgentLabel(state.meta),
      source_role: turn.source_role ?? state.meta.agent_role ?? null,
      source_is_root:
        typeof turn.source_is_root === "boolean"
          ? turn.source_is_root
          : !state.meta.parent_thread_id,
    })),
  };
}

function regroupHistorySessions(turns) {
  const grouped = new Map();
  for (const turn of turns) {
    const sessionId = turn.session_id ?? "unknown";
    if (!grouped.has(sessionId)) grouped.set(sessionId, []);
    grouped.get(sessionId).push(turn);
  }
  return Array.from(grouped, ([session_id, sessionTurns]) => ({
    session_id,
    turns: sessionTurns,
  }));
}

function parseHistoryEntries(entries) {
  const normalizedEntries = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (typeof entry?.session_id !== "string") continue;
    if (typeof entry?.text !== "string") continue;
    normalizedEntries.push({
      order: index,
      session_id: entry.session_id,
      text: cleanText(entry.text),
      timestamp: toIsoTimestamp(entry.ts),
    });
  }

  normalizedEntries.sort((left, right) => {
    if (left.session_id !== right.session_id) return left.session_id.localeCompare(right.session_id);
    if (left.timestamp && right.timestamp && left.timestamp !== right.timestamp) {
      return left.timestamp.localeCompare(right.timestamp);
    }
    if (left.timestamp && !right.timestamp) return -1;
    if (!left.timestamp && right.timestamp) return 1;
    return left.order - right.order;
  });

  const turns = normalizedEntries.map((entry, index) => ({
    index: index + 1,
    turn_id: null,
    session_id: entry.session_id,
    user_text: entry.text,
    attachments: {
      images: [],
      local_images: [],
    },
    blocks: [],
    status: "history",
    timestamp: entry.timestamp,
  }));

  return {
    format: "history",
    meta: {
      source: "history",
      entry_count: turns.length,
    },
    turns,
    sessions: regroupHistorySessions(turns),
  };
}

export function detectFormat(entries, explicitFormat = "auto") {
  if (explicitFormat && explicitFormat !== "auto") return explicitFormat;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.session_id === "string" && "text" in entry && "ts" in entry) {
      return "history";
    }
    if (
      entry.type === "session_meta" ||
      entry.type === "event_msg" ||
      entry.type === "response_item"
    ) {
      return "rollout";
    }
  }
  throw new Error("Unable to detect Codex input format.");
}

/**
 * Parse a Codex transcript file into a normalized replay document.
 * @param {string} filePath
 * @param {{ format?: "auto" | "rollout" | "history" }} opts
 * @returns {ReplayDocument}
 */
export function parseTranscript(filePath, opts = {}) {
  const entries = readJsonLines(filePath);
  const format = detectFormat(entries, opts.format ?? "auto");
  if (format === "history") return parseHistoryEntries(entries);
  return parseRolloutEntries(entries, { sourcePath: filePath });
}

function cloneTurn(turn) {
  return {
    ...turn,
    attachments: {
      images: Array.isArray(turn.attachments?.images) ? turn.attachments.images.slice() : [],
      local_images: Array.isArray(turn.attachments?.local_images) ? turn.attachments.local_images.slice() : [],
    },
    blocks: Array.isArray(turn.blocks) ? turn.blocks.map((block) => ({ ...block })) : [],
  };
}

function resolveRootDocument(documents) {
  const sessionIds = new Set(
    documents.map((document) => document.meta?.session_id).filter((sessionId) => typeof sessionId === "string" && sessionId)
  );
  return (
    documents.find((document) => {
      const parentThreadId = document.meta?.parent_thread_id;
      return !parentThreadId || !sessionIds.has(parentThreadId);
    }) ?? documents[0]
  );
}

function collectParticipantLabels(documents, rootSessionId) {
  const labels = [];
  const seen = new Set();
  for (const document of documents) {
    const sessionId = document.meta?.session_id ?? null;
    if (sessionId && sessionId === rootSessionId) continue;
    const label = document.meta?.agent_nickname ?? (sessionId ? shortenSessionId(sessionId) : null);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  return labels;
}

/**
 * Parse and merge multiple rollout transcript files into a single replay document.
 * @param {string[]} filePaths
 * @returns {ReplayDocument}
 */
export function parseTranscriptGroup(filePaths) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    throw new Error("At least one rollout file is required to build a grouped replay.");
  }

  const documents = filePaths.map((filePath) => {
    const document = parseTranscript(filePath, { format: "rollout" });
    if (document.format !== "rollout") {
      throw new Error(`Grouped replay only supports rollout files: ${filePath}`);
    }
    return document;
  });

  if (documents.length === 1) return documents[0];

  const rootDocument = resolveRootDocument(documents);
  const rootSessionId = rootDocument.meta?.session_id ?? null;
  const participantLabels = collectParticipantLabels(documents, rootSessionId);

  const mergedTurns = documents
    .flatMap((document, documentIndex) =>
      document.turns.map((turn, turnIndex) => {
        const clonedTurn = cloneTurn(turn);
        const turnTimeMs = toTimeMs(clonedTurn.timestamp);
        const documentTimeMs = toTimeMs(document.meta?.started_at);
        return {
          ...clonedTurn,
          source_session_id: clonedTurn.source_session_id ?? document.meta?.session_id ?? null,
          source_agent_label:
            clonedTurn.source_agent_label ??
            deriveSourceAgentLabel({
              session_id: document.meta?.session_id ?? null,
              parent_thread_id: document.meta?.parent_thread_id ?? null,
              agent_nickname: document.meta?.agent_nickname ?? null,
            }),
          source_role: clonedTurn.source_role ?? document.meta?.agent_role ?? null,
          source_is_root:
            clonedTurn.source_session_id != null
              ? clonedTurn.source_session_id === rootSessionId
              : !document.meta?.parent_thread_id,
          _sortTimeMs: turnTimeMs ?? documentTimeMs ?? Number.MAX_SAFE_INTEGER,
          _hasTurnTimestamp: turnTimeMs != null ? 1 : 0,
          _documentTimeMs: documentTimeMs ?? Number.MAX_SAFE_INTEGER,
          _documentIndex: documentIndex,
          _turnIndex: turnIndex,
        };
      })
    )
    .sort((left, right) => {
      if (left._sortTimeMs !== right._sortTimeMs) return left._sortTimeMs - right._sortTimeMs;
      if (left._hasTurnTimestamp !== right._hasTurnTimestamp) return right._hasTurnTimestamp - left._hasTurnTimestamp;
      if (left._documentTimeMs !== right._documentTimeMs) return left._documentTimeMs - right._documentTimeMs;
      if (left._documentIndex !== right._documentIndex) return left._documentIndex - right._documentIndex;
      return left._turnIndex - right._turnIndex;
    })
    .map((turn) => {
      const {
        _sortTimeMs,
        _hasTurnTimestamp,
        _documentTimeMs,
        _documentIndex,
        _turnIndex,
        ...cleanTurn
      } = turn;
      return cleanTurn;
    });

  const earliestStartedAt = documents
    .map((document) => document.meta?.started_at)
    .filter(Boolean)
    .sort()[0] ?? rootDocument.meta?.started_at ?? null;

  return {
    format: "rollout",
    meta: {
      ...rootDocument.meta,
      grouped: true,
      source: "rollout",
      session_id: rootSessionId,
      root_session_id: rootSessionId,
      member_count: documents.length,
      participant_labels: participantLabels,
      grouped_session_ids: documents
        .map((document) => document.meta?.session_id)
        .filter((sessionId) => typeof sessionId === "string" && sessionId),
      started_at: earliestStartedAt,
    },
    turns: reindexTurns(mergedTurns),
  };
}

function reindexTurns(turns) {
  return turns.map((turn, index) => ({
    ...turn,
    index: index + 1,
  }));
}

/**
 * Filter a replay document by turn index range or time range.
 * @param {ReplayDocument} document
 * @param {{ turnRange?: [number, number], timeFrom?: string, timeTo?: string }} opts
 * @returns {ReplayDocument}
 */
export function filterTranscript(document, opts = {}) {
  let turns = document.turns.slice();

  if (opts.turnRange) {
    const [start, end] = opts.turnRange;
    turns = turns.filter((turn) => turn.index >= start && turn.index <= end);
  }

  if (opts.timeFrom) {
    const from = new Date(opts.timeFrom).getTime();
    if (Number.isNaN(from)) throw new Error(`Invalid --from date: ${opts.timeFrom}`);
    turns = turns.filter((turn) => {
      if (!turn.timestamp) return false;
      return new Date(turn.timestamp).getTime() >= from;
    });
  }

  if (opts.timeTo) {
    const to = new Date(opts.timeTo).getTime();
    if (Number.isNaN(to)) throw new Error(`Invalid --to date: ${opts.timeTo}`);
    turns = turns.filter((turn) => {
      if (!turn.timestamp) return false;
      return new Date(turn.timestamp).getTime() <= to;
    });
  }

  const filteredTurns = reindexTurns(turns);
  if (document.format === "history") {
    return {
      ...document,
      turns: filteredTurns,
      sessions: regroupHistorySessions(filteredTurns),
    };
  }

  return {
    ...document,
    turns: filteredTurns,
  };
}
