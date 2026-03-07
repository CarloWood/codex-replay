/**
 * Discover Codex sessions from ~/.codex-style directories.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

const HOME_DIR = process.env.HOME ?? "";
const ROLLOUT_TIMESTAMP_RE = /^rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-/;
const PREVIEW_MAX_LENGTH = 140;

function normalizeHomePath(value) {
  if (typeof value !== "string") return value;
  if (HOME_DIR && value.startsWith(HOME_DIR)) {
    return "~" + value.slice(HOME_DIR.length);
  }
  return value;
}

function formatDate(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return "unknown";
  const yyyy = String(value.getFullYear());
  const mm = String(value.getMonth() + 1).padStart(2, "0");
  const dd = String(value.getDate()).padStart(2, "0");
  const hh = String(value.getHours()).padStart(2, "0");
  const min = String(value.getMinutes()).padStart(2, "0");
  const ss = String(value.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}

function shortenSessionId(sessionId) {
  if (typeof sessionId !== "string" || !sessionId) return "unknown";
  return sessionId.length > 12 ? sessionId.slice(0, 12) : sessionId;
}

function toRelativeDisplayPath(filePath, codexHome) {
  if (!codexHome) return normalizeHomePath(filePath);
  const relativePath = relative(codexHome, filePath);
  if (!relativePath || relativePath.startsWith("..")) {
    return normalizeHomePath(filePath);
  }
  return relativePath;
}

function parseRolloutFilenameTimestamp(fileName) {
  const match = fileName.match(ROLLOUT_TIMESTAMP_RE);
  if (!match) return null;
  const [, day, hour, minute, second] = match;
  const value = new Date(`${day}T${hour}:${minute}:${second}`);
  if (Number.isNaN(value.getTime())) return null;
  return value;
}

function normalizePreviewText(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

function truncatePreviewText(value, maxLength = PREVIEW_MAX_LENGTH) {
  if (!value || value.length <= maxLength) return value ?? "";
  return value.slice(0, maxLength - 3) + "...";
}

function isBootstrapPreview(value) {
  if (typeof value !== "string") return false;
  return /^(# AGENTS\.md instructions|<(environment_context|user_instructions|developer_instructions)>)/i.test(
    value.trim()
  );
}

function toDateValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const asDate = new Date(value * 1000);
    if (!Number.isNaN(asDate.getTime())) return asDate;
  }

  if (typeof value === "string" && value) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) {
      const asDate = new Date(asNumber * 1000);
      if (!Number.isNaN(asDate.getTime())) return asDate;
    }

    const asDate = new Date(value);
    if (!Number.isNaN(asDate.getTime())) return asDate;
  }

  return null;
}

function extractResponseItemPreview(payload) {
  if (payload?.type !== "message" || payload?.role !== "user" || !Array.isArray(payload.content)) {
    return "";
  }

  const parts = [];
  for (const item of payload.content) {
    if (item?.type === "input_text" || item?.type === "text") {
      parts.push(item.text ?? "");
    }
  }

  return normalizePreviewText(parts.join(" "));
}

function readJsonLines(filePath) {
  try {
    return readFileSync(filePath, "utf-8").split("\n");
  } catch {
    return [];
  }
}

function readRolloutSummary(filePath) {
  const summary = {
    timestamp: null,
    cwd: null,
    session_id: null,
    model_provider: null,
    parent_thread_id: null,
    agent_nickname: null,
    agent_role: null,
    preview_text: null,
  };
  let fallbackPreview = "";
  let sawSessionMeta = false;

  for (const line of readJsonLines(filePath)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const entry = JSON.parse(trimmed);
      if (entry?.type === "session_meta") {
        const payload = entry.payload ?? {};
        summary.timestamp = typeof payload.timestamp === "string" ? payload.timestamp : null;
        summary.cwd = typeof payload.cwd === "string" ? payload.cwd : null;
        summary.session_id = typeof payload.id === "string" ? payload.id : null;
        summary.model_provider = typeof payload.model_provider === "string" ? payload.model_provider : null;
        summary.parent_thread_id = payload?.source?.subagent?.thread_spawn?.parent_thread_id ?? null;
        summary.agent_nickname = typeof payload.agent_nickname === "string" ? payload.agent_nickname : null;
        summary.agent_role = typeof payload.agent_role === "string" ? payload.agent_role : null;
        sawSessionMeta = true;
        if (summary.preview_text) break;
        continue;
      }

      if (!summary.preview_text && entry?.type === "event_msg" && entry.payload?.type === "user_message") {
        const preview = truncatePreviewText(normalizePreviewText(entry.payload?.message ?? ""));
        if (preview && !isBootstrapPreview(preview)) {
          summary.preview_text = preview;
          if (sawSessionMeta) break;
        }
        continue;
      }

      if (!fallbackPreview && entry?.type === "response_item") {
        const preview = truncatePreviewText(extractResponseItemPreview(entry.payload));
        if (preview && !isBootstrapPreview(preview)) {
          fallbackPreview = preview;
        }
      }
    } catch {
      // Ignore malformed lines and keep scanning.
    }
  }

  if (!summary.preview_text && fallbackPreview) {
    summary.preview_text = fallbackPreview;
  }

  return summary;
}

function collectRolloutFiles(rootDir) {
  if (!existsSync(rootDir)) return [];

  const queue = [rootDir];
  const files = [];

  while (queue.length) {
    const current = queue.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function createHistorySessionSummaries(filePath, codexHome) {
  let stats = null;
  try {
    stats = statSync(filePath);
  } catch {
    return [];
  }

  const displayPath = toRelativeDisplayPath(filePath, codexHome);
  const sessions = new Map();

  for (const line of readJsonLines(filePath)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const entry = JSON.parse(trimmed);
      if (typeof entry?.session_id !== "string" || typeof entry?.text !== "string") continue;

      const sessionId = entry.session_id;
      const text = normalizePreviewText(entry.text);
      const timestamp = toDateValue(entry.ts) ?? stats.mtime ?? null;
      const sortTimeMs =
        timestamp instanceof Date && !Number.isNaN(timestamp.getTime())
          ? timestamp.getTime()
          : stats?.mtimeMs ?? 0;

      if (!sessions.has(sessionId)) {
        sessions.set(sessionId, {
          kind: "history-session",
          session_id: sessionId,
          history_path: filePath,
          history_display_path: displayPath,
          display_path: `${displayPath}#${shortenSessionId(sessionId)}`,
          display_time: formatDate(timestamp),
          sort_time_ms: sortTimeMs,
          preview_text: text ? truncatePreviewText(text) : null,
          entry_count: 0,
          search_parts: [displayPath, filePath, sessionId],
        });
      }

      const session = sessions.get(sessionId);
      session.entry_count += 1;
      if (sortTimeMs >= session.sort_time_ms) {
        session.sort_time_ms = sortTimeMs;
        session.display_time = formatDate(timestamp);
      }
      if (!session.preview_text && text) {
        session.preview_text = truncatePreviewText(text);
      }
      if (text) session.search_parts.push(text);
    } catch {
      // Ignore malformed lines and keep scanning.
    }
  }

  return Array.from(sessions.values())
    .map((session) => ({
      ...session,
      search_text: session.search_parts.join(" ").toLowerCase(),
    }))
    .sort((left, right) => right.sort_time_ms - left.sort_time_ms);
}

function createRolloutCandidate(filePath, codexHome) {
  let stats = null;
  try {
    stats = statSync(filePath);
  } catch {
    return null;
  }

  const fileName = basename(filePath);
  const fileTimestamp = parseRolloutFilenameTimestamp(fileName);
  const metadata = readRolloutSummary(filePath);
  const sessionDate =
    typeof metadata.timestamp === "string" && metadata.timestamp
      ? new Date(metadata.timestamp)
      : fileTimestamp ?? stats?.mtime ?? null;
  const displayPath = toRelativeDisplayPath(filePath, codexHome);
  const cwdName = metadata.cwd ? basename(metadata.cwd) : null;

  return {
    path: filePath,
    paths: [filePath],
    display_path: displayPath,
    display_time: formatDate(sessionDate),
    sort_time_ms:
      sessionDate instanceof Date && !Number.isNaN(sessionDate.getTime())
        ? sessionDate.getTime()
        : stats?.mtimeMs ?? 0,
    cwd: metadata.cwd ? normalizeHomePath(metadata.cwd) : null,
    cwd_name: cwdName || null,
    session_id: metadata.session_id ?? null,
    root_session_id: metadata.session_id ?? null,
    model_provider: metadata.model_provider ?? null,
    parent_thread_id: metadata.parent_thread_id ?? null,
    agent_nickname: metadata.agent_nickname ?? null,
    agent_role: metadata.agent_role ?? null,
    preview_text: metadata.preview_text ?? null,
    member_count: 1,
    participant_labels: [],
    grouped_session_ids: metadata.session_id ? [metadata.session_id] : [],
    search_text: [
      "rollout",
      displayPath,
      filePath,
      cwdName,
      metadata.cwd,
      metadata.session_id,
      metadata.parent_thread_id,
      metadata.model_provider,
      metadata.agent_nickname,
      metadata.agent_role,
      metadata.preview_text,
      formatDate(sessionDate),
      fileName,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase(),
  };
}

function resolveRootSessionId(candidate, bySessionId) {
  if (!candidate.session_id) return candidate.path;
  let current = candidate;
  const seen = new Set();
  while (
    current.parent_thread_id &&
    bySessionId.has(current.parent_thread_id) &&
    !seen.has(current.parent_thread_id)
  ) {
    seen.add(current.session_id);
    current = bySessionId.get(current.parent_thread_id);
  }
  return current.session_id ?? candidate.session_id;
}

function buildRolloutGroups(rolloutCandidates) {
  const bySessionId = new Map(
    rolloutCandidates
      .filter((candidate) => typeof candidate.session_id === "string" && candidate.session_id)
      .map((candidate) => [candidate.session_id, candidate])
  );
  const grouped = new Map();

  for (const candidate of rolloutCandidates) {
    const rootKey = resolveRootSessionId(candidate, bySessionId);
    if (!grouped.has(rootKey)) grouped.set(rootKey, []);
    grouped.get(rootKey).push(candidate);
  }

  return Array.from(grouped.values())
    .map((members) => {
      const sortedMembers = members.slice().sort((left, right) => left.sort_time_ms - right.sort_time_ms);
      const latestMember =
        members.slice().sort((left, right) => right.sort_time_ms - left.sort_time_ms)[0] ?? members[0];
      const rootMember =
        sortedMembers.find((candidate) => candidate.session_id === resolveRootSessionId(candidate, bySessionId)) ??
        sortedMembers.find((candidate) => !candidate.parent_thread_id) ??
        sortedMembers[0];
      const participantLabels = Array.from(
        new Set(
          sortedMembers
            .filter((candidate) => candidate.path !== rootMember.path)
            .map(
              (candidate) =>
                candidate.agent_nickname ??
                (candidate.session_id ? shortenSessionId(candidate.session_id) : null)
            )
            .filter(Boolean)
        )
      );
      const searchText = sortedMembers
        .flatMap((candidate) => [
          candidate.search_text,
          candidate.session_id,
          candidate.parent_thread_id,
          candidate.agent_nickname,
          candidate.agent_role,
          candidate.display_path,
          candidate.path,
        ])
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const previewText =
        rootMember.preview_text ??
        sortedMembers.find((candidate) => candidate.preview_text)?.preview_text ??
        null;

      return {
        path: rootMember.path,
        paths: sortedMembers.map((candidate) => candidate.path),
        display_path: rootMember.display_path,
        display_time: latestMember.display_time,
        sort_time_ms: latestMember.sort_time_ms,
        cwd: rootMember.cwd ?? sortedMembers.find((candidate) => candidate.cwd)?.cwd ?? null,
        cwd_name: rootMember.cwd_name ?? sortedMembers.find((candidate) => candidate.cwd_name)?.cwd_name ?? null,
        session_id: rootMember.session_id ?? null,
        root_session_id: rootMember.session_id ?? null,
        model_provider:
          rootMember.model_provider ??
          sortedMembers.find((candidate) => candidate.model_provider)?.model_provider ??
          null,
        preview_text: previewText,
        member_count: sortedMembers.length,
        participant_labels: participantLabels,
        grouped_session_ids: sortedMembers
          .map((candidate) => candidate.session_id)
          .filter((sessionId) => typeof sessionId === "string" && sessionId),
        search_text: searchText,
      };
    })
    .sort((left, right) => right.sort_time_ms - left.sort_time_ms);
}

function createLinkedSessionCandidate(historySession, rolloutGroup) {
  const sortTimeMs = Math.max(historySession.sort_time_ms, rolloutGroup?.sort_time_ms ?? 0);
  return {
    kind: "session",
    session_kind: rolloutGroup ? "history+rollout" : "history-only",
    format: rolloutGroup ? "rollout" : "history",
    path: rolloutGroup ? rolloutGroup.path : historySession.history_path,
    paths: rolloutGroup ? rolloutGroup.paths.slice() : undefined,
    history_path: historySession.history_path,
    history_session_id: historySession.session_id,
    display_path: rolloutGroup ? rolloutGroup.display_path : historySession.display_path,
    display_time: formatDate(new Date(sortTimeMs)),
    sort_time_ms: sortTimeMs,
    cwd: rolloutGroup?.cwd ?? null,
    cwd_name: rolloutGroup?.cwd_name ?? null,
    session_id: historySession.session_id,
    root_session_id: rolloutGroup?.root_session_id ?? historySession.session_id,
    model_provider: rolloutGroup?.model_provider ?? null,
    preview_text: historySession.preview_text ?? rolloutGroup?.preview_text ?? null,
    entry_count: historySession.entry_count,
    member_count: rolloutGroup?.member_count ?? 0,
    participant_labels: rolloutGroup?.participant_labels ?? [],
    search_text: [
      historySession.search_text,
      rolloutGroup?.search_text,
      rolloutGroup?.cwd,
      rolloutGroup?.cwd_name,
      rolloutGroup?.participant_labels?.join(" "),
      rolloutGroup ? "linked" : "history-only",
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase(),
  };
}

function createRolloutOnlyCandidate(rolloutGroup) {
  return {
    kind: "session",
    session_kind: "rollout-only",
    format: "rollout",
    path: rolloutGroup.path,
    paths: rolloutGroup.paths.slice(),
    history_path: null,
    history_session_id: null,
    display_path: rolloutGroup.display_path,
    display_time: rolloutGroup.display_time,
    sort_time_ms: rolloutGroup.sort_time_ms,
    cwd: rolloutGroup.cwd ?? null,
    cwd_name: rolloutGroup.cwd_name ?? null,
    session_id: rolloutGroup.root_session_id ?? rolloutGroup.session_id ?? null,
    root_session_id: rolloutGroup.root_session_id ?? rolloutGroup.session_id ?? null,
    model_provider: rolloutGroup.model_provider ?? null,
    preview_text: rolloutGroup.preview_text ?? null,
    entry_count: 0,
    member_count: rolloutGroup.member_count,
    participant_labels: rolloutGroup.participant_labels ?? [],
    search_text: [rolloutGroup.search_text, "rollout-only"].filter(Boolean).join(" ").toLowerCase(),
  };
}

function buildSessionCandidates(historySessions, rolloutGroups) {
  const byRootSessionId = new Map(
    rolloutGroups
      .filter((candidate) => typeof candidate.root_session_id === "string" && candidate.root_session_id)
      .map((candidate) => [candidate.root_session_id, candidate])
  );
  const usedRolloutPaths = new Set();
  const candidates = historySessions.map((historySession) => {
    const rolloutGroup = byRootSessionId.get(historySession.session_id) ?? null;
    if (rolloutGroup?.path) usedRolloutPaths.add(rolloutGroup.path);
    return createLinkedSessionCandidate(historySession, rolloutGroup);
  });

  for (const rolloutGroup of rolloutGroups) {
    if (usedRolloutPaths.has(rolloutGroup.path)) continue;
    candidates.push(createRolloutOnlyCandidate(rolloutGroup));
  }

  return candidates.sort((left, right) => right.sort_time_ms - left.sort_time_ms);
}

export function getDefaultCodexHome() {
  if (HOME_DIR) return join(HOME_DIR, ".codex");
  return ".codex";
}

export function discoverCodexInputs({ codexHome = getDefaultCodexHome() } = {}) {
  const historyPath = join(codexHome, "history.jsonl");
  const historySessions = existsSync(historyPath)
    ? createHistorySessionSummaries(historyPath, codexHome)
    : [];

  const rolloutRoot = join(codexHome, "sessions");
  const rolloutCandidates = collectRolloutFiles(rolloutRoot)
    .map((filePath) => createRolloutCandidate(filePath, codexHome))
    .filter(Boolean);
  const rolloutGroups = buildRolloutGroups(rolloutCandidates);

  return buildSessionCandidates(historySessions, rolloutGroups);
}
