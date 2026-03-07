/**
 * Ephemeral localhost preview server for replay HTML.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const DEFAULT_IDLE_MS = 90_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;

function parsePositiveInteger(value, label) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return parsed;
}

function delay(ms) {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

function isUrlTarget(value) {
  return typeof value === "string" && /^[a-z]+:\/\//i.test(value);
}

export function launchTarget(target) {
  const normalizedTarget = isUrlTarget(target) ? target : resolve(target);
  let command;
  let args;

  if (process.platform === "darwin") {
    command = "open";
    args = [normalizedTarget];
  } else if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", normalizedTarget];
  } else {
    command = "xdg-open";
    args = [normalizedTarget];
  }

  try {
    const result = spawnSync(command, args, { stdio: "ignore" });
    return result.status === 0;
  } catch {
    return false;
  }
}

async function waitForHandshakeFile(handshakeFile, { timeoutMs, childState }) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (childState.error) throw childState.error;
    if (childState.exit) {
      const exit = childState.exit;
      throw new Error(`Preview server exited before becoming ready (${exit.code ?? exit.signal ?? "unknown"})`);
    }

    if (existsSync(handshakeFile)) {
      try {
        const payload = JSON.parse(readFileSync(handshakeFile, "utf-8"));
        if (Number.isInteger(payload.port) && typeof payload.token === "string" && payload.token) {
          return payload;
        }
      } catch {
        // The child may still be writing the handshake file.
      }
    }

    await delay(50);
  }

  throw new Error("Preview server did not become ready in time.");
}

export async function openEphemeralPreview(
  html,
  {
    idleMs = DEFAULT_IDLE_MS,
    handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
    token = randomBytes(10).toString("hex"),
  } = {}
) {
  const resolvedIdleMs = parsePositiveInteger(idleMs, "idle timeout");
  const resolvedHandshakeTimeoutMs = parsePositiveInteger(
    handshakeTimeoutMs,
    "handshake timeout"
  );
  const handshakeDir = mkdtempSync(join(tmpdir(), "codex-replay-preview-"));
  const handshakeFile = join(handshakeDir, "ready.json");
  const childScript = fileURLToPath(import.meta.url);
  const childState = { error: null, exit: null };
  const child = spawn(
    process.execPath,
    [
      childScript,
      "--serve-preview",
      "--handshake-file",
      handshakeFile,
      "--token",
      token,
      "--idle-ms",
      String(resolvedIdleMs),
    ],
    {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
    }
  );

  child.once("error", (error) => {
    childState.error = error;
  });
  child.once("exit", (code, signal) => {
    childState.exit = { code, signal };
  });

  child.stdin.end(html);
  child.unref();

  try {
    const handshake = await waitForHandshakeFile(handshakeFile, {
      timeoutMs: resolvedHandshakeTimeoutMs,
      childState,
    });
    return {
      url: `http://127.0.0.1:${handshake.port}/${handshake.token}`,
      port: handshake.port,
      token: handshake.token,
    };
  } finally {
    rmSync(handshakeDir, { recursive: true, force: true });
  }
}

async function readStreamText(stream) {
  stream.setEncoding("utf8");
  let text = "";
  for await (const chunk of stream) {
    text += chunk;
  }
  return text;
}

export async function runPreviewServerCli({
  argv = process.argv.slice(2),
  input = process.stdin,
  host = "127.0.0.1",
} = {}) {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      "serve-preview": { type: "boolean", default: false },
      "handshake-file": { type: "string" },
      token: { type: "string" },
      "idle-ms": { type: "string", default: String(DEFAULT_IDLE_MS) },
      port: { type: "string", default: "0" },
    },
  });

  if (!values["serve-preview"]) {
    throw new Error("Missing --serve-preview");
  }
  if (!values["handshake-file"]) {
    throw new Error("Missing --handshake-file");
  }

  const token = values.token || randomBytes(10).toString("hex");
  const idleMs = parsePositiveInteger(values["idle-ms"], "idle timeout");
  const port = Number.parseInt(values.port, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid port: ${values.port}`);
  }

  const html = await readStreamText(input);
  const startedAt = Date.now();
  let lastActivityAt = startedAt;

  const server = createServer((request, response) => {
    lastActivityAt = Date.now();
    const url = request.url || "/";

    if (url === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }

    if (url === "/" || url === "") {
      response.writeHead(302, {
        Location: `/${token}`,
        "Cache-Control": "no-store",
      });
      response.end();
      return;
    }

    if (url === `/${token}` || url === `/${token}/`) {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(html);
      return;
    }

    response.writeHead(404, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end("Preview expired or unavailable.");
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(idleTimer);
    server.close(() => {
      process.exit(0);
    });
  };

  const idleTimer = setInterval(() => {
    if (Date.now() - lastActivityAt >= idleMs) {
      shutdown();
    }
  }, Math.max(250, Math.min(2_000, Math.floor(idleMs / 6))));

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, resolveListen);
  });

  const address = server.address();
  if (!address || typeof address !== "object" || !Number.isInteger(address.port)) {
    throw new Error("Preview server did not bind to a TCP port.");
  }

  writeFileSync(
    values["handshake-file"],
    JSON.stringify({ port: address.port, token })
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  runPreviewServerCli().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
