const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const WebSocket = require("ws");

let pty;
try {
  pty = require("@homebridge/node-pty-prebuilt-multiarch");
} catch (primaryError) {
  try {
    pty = require("node-pty");
  } catch (fallbackError) {
    console.error("Could not load a PTY library.");
    console.error(primaryError);
    process.exit(1);
  }
}

const DEFAULT_PORT = 4317;
const MAX_OUTPUT_CHARS = Number(process.env.OUTPUT_LIMIT || 1024 * 1024);
const BUILT_IN_MODELS = Object.freeze([
  { id: "", label: "Default (Claude Code)", detail: "Use Claude Code's current default model." },
  { id: "opus", label: "Opus", detail: "Current Opus alias." },
  { id: "claude-opus-4-8", label: "Opus 4.8", detail: "Specific Opus 4.8 model." },
  { id: "claude-opus-4-8[1m]", label: "Opus 4.8 (1M context)", detail: "Specific Opus 4.8 long-context model." },
  { id: "claude-opus-4-7", label: "Opus 4.7", detail: "Specific Opus 4.7 model." },
  { id: "claude-opus-4-7[1m]", label: "Opus 4.7 (1M context)", detail: "Specific Opus 4.7 long-context model." },
  { id: "claude-opus-4-6", label: "Opus 4.6", detail: "Specific Opus 4.6 model." },
  { id: "claude-opus-4-6[1m]", label: "Opus 4.6 (1M context)", detail: "Specific Opus 4.6 long-context model." },
  { id: "sonnet", label: "Sonnet", detail: "Current Sonnet alias." },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6", detail: "Specific Sonnet 4.6 model." },
  { id: "claude-sonnet-4-6[1m]", label: "Sonnet 4.6 (1M context)", detail: "Specific Sonnet 4.6 long-context model." },
  { id: "haiku", label: "Haiku", detail: "Current Haiku alias." },
  { id: "claude-haiku-4-5", label: "Haiku 4.5", detail: "Specific Haiku 4.5 model." },
  { id: "fable", label: "Fable", detail: "Current Fable alias." },
  { id: "claude-fable-5", label: "Fable 5", detail: "Specific Fable 5 model." },
  { id: "claude-fable-5[1m]", label: "Fable 5 (1M context)", detail: "Specific Fable 5 long-context model." }
]);

const args = parseArgs(process.argv.slice(2));
const host = process.env.HOST || args.host || "127.0.0.1";
const requestedPort = Number(process.env.PORT || args.port || DEFAULT_PORT);
const explicitPort = Boolean(process.env.PORT || args.port);
const command = process.env.CLAUDE_COMMAND || args.cmd || "claude";
const baseCommandArgs = buildBaseCommandArgs(args);
const claudeCwd = path.resolve(args.cwd || process.env.CLAUDE_CWD || path.join(__dirname, ".."));
const claudeDataDir = path.join(os.homedir(), ".claude");
let persistSession = resolveInitialPersistSession(args.persistSession, process.env.CLAUDE_PERSIST_SESSION);
let resumeSessionId = args.resumeSessionId || null;
let selectedModel = normalizeModelId(args.model || process.env.CLAUDE_MODEL || process.env.ANTHROPIC_MODEL || "");

let term = null;
let outputBuffer = "";
let cursorBase = 0;
let cursorEnd = 0;
let lastExit = null;
let activeGeneration = 0;
let currentListenPort = requestedPort;
const sockets = new Set();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });

app.use(express.json({ type: ["application/json", "application/*+json"], limit: "2mb" }));
app.use(express.text({ type: "*/*", limit: "2mb" }));
app.use("/vendor/xterm", express.static(path.join(__dirname, "node_modules", "xterm")));
app.use("/vendor/xterm-addon-fit", express.static(path.join(__dirname, "node_modules", "xterm-addon-fit")));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/status", (req, res) => {
  res.json(statusPayload());
});

app.get("/api/output", (req, res) => {
  const since = Number(req.query.since);
  const hasUsableCursor = Number.isFinite(since) && since >= cursorBase && since <= cursorEnd;
  const start = hasUsableCursor ? since - cursorBase : 0;

  res.json({
    output: outputBuffer.slice(start),
    cursor: cursorEnd,
    baseCursor: cursorBase,
    truncated: Boolean(Number.isFinite(since) && since < cursorBase),
    status: statusPayload()
  });
});

app.get("/api/sessions", async (req, res) => {
  try {
    res.json(await listProjectSessions());
  } catch (error) {
    res.status(500).json({ error: error.message || "Could not load Claude sessions." });
  }
});

app.get("/api/models", (req, res) => {
  res.json({
    ok: true,
    selectedModel,
    models: listModels(),
    status: statusPayload()
  });
});

app.delete("/api/sessions/:sessionId", async (req, res) => {
  const sessionId = normalizeSessionId(req.params.sessionId);
  if (!sessionId) {
    res.status(400).json({ error: "Missing or invalid session id." });
    return;
  }

  try {
    const deleted = await deleteProjectSession(sessionId);
    if (!deleted) {
      res.status(404).json({ error: "Claude session not found for this folder." });
      return;
    }

    res.json({
      ok: true,
      deletedSessionId: sessionId,
      status: statusPayload(),
      sessions: await listProjectSessions()
    });
  } catch (error) {
    res.status(500).json({ error: error.message || "Could not delete Claude session." });
  }
});

app.post("/api/input", (req, res) => {
  const text = readTextBody(req.body);
  if (text === null) {
    res.status(400).json({ error: "Expected text/plain body or JSON with text/data/input." });
    return;
  }

  writeToTerminal(text);
  res.json({ ok: true, wrote: text.length, status: statusPayload() });
});

app.post("/api/key", (req, res) => {
  const sequence = keyToSequence(req.body);
  if (!sequence) {
    res.status(400).json({ error: "Unknown key. Try Enter, Ctrl+C, Ctrl+D, Ctrl+Z, Escape, Tab, Backspace, Up, Down, Left, Right." });
    return;
  }

  writeToTerminal(sequence);
  res.json({ ok: true, status: statusPayload() });
});

app.post("/api/model", (req, res) => {
  const requestedModel = readRequestedModel(req.body);
  if (requestedModel.error) {
    res.status(400).json({ error: requestedModel.error });
    return;
  }

  if (!requestedModel.present || requestedModel.value === null) {
    writeToTerminal("/model\r");
    res.json({ ok: true, model: selectedModel, status: statusPayload() });
    return;
  }

  selectedModel = requestedModel.value;
  writeToTerminal(`/model ${selectedModel}\r`);
  res.json({ ok: true, model: selectedModel, status: statusPayload() });
});

app.post("/api/restart", (req, res) => {
  const requestedPersistSession = readPersistSessionValue(req.body);
  if (requestedPersistSession !== null) {
    persistSession = requestedPersistSession;
  }

  const requestedResumeSessionId = readResumeSessionId(req.body);
  if (requestedResumeSessionId !== undefined) {
    resumeSessionId = requestedResumeSessionId;
  }

  const requestedModel = readRequestedModel(req.body);
  if (requestedModel.error) {
    res.status(400).json({ error: requestedModel.error });
    return;
  }
  if (requestedModel.present) {
    selectedModel = requestedModel.value;
  }

  restartTerminal();
  res.json({ ok: true, status: statusPayload() });
});

wss.on("connection", (socket) => {
  sockets.add(socket);
  socket.send(JSON.stringify({ type: "status", data: statusPayload() }));
  if (outputBuffer) {
    socket.send(JSON.stringify({ type: "output", data: outputBuffer }));
  }

  socket.on("message", (message) => {
    handleSocketMessage(socket, message);
  });

  socket.on("close", () => {
    sockets.delete(socket);
  });
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE" && !explicitPort && currentListenPort < DEFAULT_PORT + 100) {
    listen(currentListenPort + 1);
    return;
  }

  throw error;
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

startTerminal();
listen(requestedPort);

function listen(port) {
  currentListenPort = port;
  server.listen(port, host, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    console.log(`Shared Claude terminal listening at http://${host}:${actualPort}`);
    console.log(`Claude command: ${formatCommand(command, buildRuntimeCommandArgs())}`);
    console.log(`Claude cwd: ${claudeCwd}`);
    console.log(`Session persistence: ${persistSession ? "enabled" : "disabled"}`);
    console.log(`Resume session: ${resumeSessionId || "new conversation"}`);
    console.log("HTTP API: POST /api/input, POST /api/key, POST /api/restart, GET /api/output, GET /api/status, GET /api/sessions, DELETE /api/sessions/:sessionId");
  });
}

function startTerminal() {
  lastExit = null;
  activeGeneration += 1;
  const generation = activeGeneration;
  const runtimeCommandArgs = buildRuntimeCommandArgs();
  const spawnSpec = getSpawnSpec(command, runtimeCommandArgs);

  resetTerminalState();
  broadcast({ type: "reset" });

  term = pty.spawn(spawnSpec.file, spawnSpec.args, {
    name: "xterm-256color",
    cols: Number(process.env.COLS || 120),
    rows: Number(process.env.ROWS || 34),
    cwd: claudeCwd,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      FORCE_COLOR: "1"
    }
  });

  term.onData((data) => {
    appendOutput(data);
    broadcast({ type: "output", data });
  });

  term.onExit((event) => {
    if (generation !== activeGeneration) return;
    lastExit = event;
    const message = `\r\n[shared-claude-terminal] Claude process exited with code ${event.exitCode}, signal ${event.signal || "none"}.\r\n`;
    appendOutput(message);
    broadcast({ type: "output", data: message });
    broadcast({ type: "status", data: statusPayload() });
  });

  broadcast({ type: "status", data: statusPayload() });
}

function resetTerminalState() {
  outputBuffer = "";
  cursorBase = 0;
  cursorEnd = 0;
}

function restartTerminal() {
  if (term) {
    try {
      term.kill();
    } catch (_) {
      // Already gone.
    }
  }
  startTerminal();
}

function shutdown() {
  if (term) {
    try {
      term.kill();
    } catch (_) {
      // Ignore shutdown races.
    }
  }
  server.close(() => process.exit(0));
}

function handleSocketMessage(socket, message) {
  let payload;
  try {
    payload = JSON.parse(message.toString());
  } catch (_) {
    writeToTerminal(message.toString());
    return;
  }

  if (payload.type === "input") {
    writeToTerminal(String(payload.data || ""));
    return;
  }

  if (payload.type === "key") {
    const sequence = keyToSequence(payload);
    if (sequence) writeToTerminal(sequence);
    return;
  }

  if (payload.type === "resize") {
    const cols = clamp(Number(payload.cols), 20, 300);
    const rows = clamp(Number(payload.rows), 5, 120);
    if (term && cols && rows) term.resize(cols, rows);
  }
}

function writeToTerminal(text) {
  if (!term) {
    throw new Error("PTY is not running.");
  }
  term.write(text);
}

function appendOutput(data) {
  outputBuffer += data;
  cursorEnd += data.length;

  if (outputBuffer.length > MAX_OUTPUT_CHARS) {
    const drop = outputBuffer.length - MAX_OUTPUT_CHARS;
    outputBuffer = outputBuffer.slice(drop);
    cursorBase += drop;
  }
}

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(data);
    }
  }
}

function statusPayload() {
  return {
    pid: term ? term.pid : null,
    alive: Boolean(term && !lastExit),
    cwd: claudeCwd,
    command,
    args: buildRuntimeCommandArgs(),
    commandLine: formatCommand(command, buildRuntimeCommandArgs()),
    model: selectedModel,
    persistSession,
    resumeSessionId,
    cursor: cursorEnd,
    baseCursor: cursorBase,
    lastExit
  };
}

function getSpawnSpec(file, spawnArgs) {
  if (process.platform !== "win32") {
    return { file, args: spawnArgs };
  }

  const shell = process.env.ComSpec || "cmd.exe";
  const commandLine = [file, ...spawnArgs].map(cmdQuote).join(" ");
  return { file: shell, args: ["/d", "/s", "/c", commandLine] };
}

function keyToSequence(body) {
  const raw = typeof body === "string"
    ? body
    : body && (body.sequence || body.key || body.name || body.data);

  if (!raw || typeof raw !== "string") return "";
  if (body && typeof body === "object" && typeof body.sequence === "string") return body.sequence;

  const key = raw.toLowerCase().replace(/\s+/g, "");
  const keys = {
    enter: "\r",
    return: "\r",
    ctrlc: "\x03",
    "ctrl+c": "\x03",
    ctrld: "\x04",
    "ctrl+d": "\x04",
    ctrlz: "\x1a",
    "ctrl+z": "\x1a",
    escape: "\x1b",
    esc: "\x1b",
    tab: "\t",
    backspace: "\x7f",
    up: "\x1b[A",
    arrowup: "\x1b[A",
    down: "\x1b[B",
    arrowdown: "\x1b[B",
    right: "\x1b[C",
    arrowright: "\x1b[C",
    left: "\x1b[D",
    arrowleft: "\x1b[D"
  };

  return keys[key] || "";
}

function readTextBody(body) {
  if (typeof body === "string") return body;
  if (!body || typeof body !== "object") return null;

  for (const field of ["text", "data", "input"]) {
    if (typeof body[field] === "string") return body[field];
  }

  return null;
}

function buildBaseCommandArgs(parsed) {
  const result = [];

  if (process.env.CLAUDE_ARGS) {
    result.push(...splitCommandLine(process.env.CLAUDE_ARGS));
  }

  if (parsed.remoteControl) {
    result.push("--remote-control");
  }

  if (parsed.extra.length) {
    result.push(...parsed.extra);
  }

  return result;
}

function buildRuntimeCommandArgs() {
  const result = [...baseCommandArgs];

  if (!persistSession) {
    result.push("--no-session-persistence");
  }

  if (selectedModel) {
    result.push("--model", selectedModel);
  }

  if (resumeSessionId) {
    result.push("--resume", resumeSessionId);
  }

  return result;
}

function parseArgs(rawArgs) {
  const parsed = {
    cwd: "",
    port: "",
    host: "",
    cmd: "",
    remoteControl: false,
    persistSession: null,
    resumeSessionId: null,
    model: null,
    extra: []
  };

  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (arg === "--cwd") {
      parsed.cwd = rawArgs[++i] || "";
    } else if (arg.startsWith("--cwd=")) {
      parsed.cwd = arg.slice("--cwd=".length);
    } else if (arg === "--port") {
      parsed.port = rawArgs[++i] || "";
    } else if (arg.startsWith("--port=")) {
      parsed.port = arg.slice("--port=".length);
    } else if (arg === "--host") {
      parsed.host = rawArgs[++i] || "";
    } else if (arg.startsWith("--host=")) {
      parsed.host = arg.slice("--host=".length);
    } else if (arg === "--cmd") {
      parsed.cmd = rawArgs[++i] || "";
    } else if (arg.startsWith("--cmd=")) {
      parsed.cmd = arg.slice("--cmd=".length);
    } else if (arg === "--resume" || arg === "-r") {
      parsed.resumeSessionId = normalizeSessionId(rawArgs[++i]);
    } else if (arg.startsWith("--resume=")) {
      parsed.resumeSessionId = normalizeSessionId(arg.slice("--resume=".length));
    } else if (arg === "--model") {
      parsed.model = normalizeModelId(rawArgs[++i] || "");
    } else if (arg.startsWith("--model=")) {
      parsed.model = normalizeModelId(arg.slice("--model=".length));
    } else if (arg === "--no-session-persistence") {
      parsed.persistSession = false;
    } else if (arg === "--session-persistence") {
      parsed.persistSession = parsePersistValue(rawArgs[++i]);
    } else if (arg.startsWith("--session-persistence=")) {
      parsed.persistSession = parsePersistValue(arg.slice("--session-persistence=".length));
    } else if (arg === "--remote-control") {
      parsed.remoteControl = true;
    } else if (arg === "--") {
      parsed.extra.push(...rawArgs.slice(i + 1));
      break;
    } else {
      parsed.extra.push(arg);
    }
  }

  return parsed;
}

function resolveInitialPersistSession(parsedValue, envValue) {
  if (typeof parsedValue === "boolean") return parsedValue;

  const envParsed = parsePersistValue(envValue);
  if (typeof envParsed === "boolean") return envParsed;

  return true;
}

function parsePersistValue(value) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;

  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;

  if (["1", "true", "yes", "on", "persist", "persistent", "save", "keep"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off", "temporary", "ephemeral", "nosave", "do-not-save"].includes(normalized)) {
    return false;
  }

  return null;
}

function readPersistSessionValue(body) {
  if (typeof body === "string") {
    return parsePersistValue(body);
  }

  if (!body || typeof body !== "object") {
    return null;
  }

  if (Object.prototype.hasOwnProperty.call(body, "persistSession")) {
    return Boolean(body.persistSession);
  }

  if (Object.prototype.hasOwnProperty.call(body, "saveHistory")) {
    return Boolean(body.saveHistory);
  }

  if (Object.prototype.hasOwnProperty.call(body, "temporarySession")) {
    return !Boolean(body.temporarySession);
  }

  return null;
}

function readResumeSessionId(body) {
  if (!body || typeof body !== "object") {
    return undefined;
  }

  if (Object.prototype.hasOwnProperty.call(body, "resumeSessionId")) {
    return normalizeSessionId(body.resumeSessionId);
  }

  if (Object.prototype.hasOwnProperty.call(body, "sessionId")) {
    return normalizeSessionId(body.sessionId);
  }

  if (Object.prototype.hasOwnProperty.call(body, "newConversation")) {
    return body.newConversation ? null : undefined;
  }

  return undefined;
}

function normalizeSessionId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeModelId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^[A-Za-z0-9._:@/\-\[\]]{1,180}$/.test(trimmed)) return null;
  return trimmed;
}

function readRequestedModel(body) {
  if (!body || typeof body !== "object" || !Object.prototype.hasOwnProperty.call(body, "model")) {
    return { present: false, value: undefined, error: "" };
  }

  if (body.model === null || body.model === "") {
    return { present: true, value: null, error: "" };
  }

  const normalized = normalizeModelId(String(body.model));
  if (!normalized) {
    return { present: false, value: undefined, error: "Model IDs may only contain letters, numbers, '.', '-', '_', ':', '/', '@', and '[...]'." };
  }

  return { present: true, value: normalized, error: "" };
}

function parseBooleanValue(value) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parseModelIdList(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const ids = value
    .split(",")
    .map((item) => normalizeModelId(item))
    .filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

function listModels() {
  return BUILT_IN_MODELS.map((model) => ({
    ...model,
    selected: (model.id || "") === (selectedModel || "")
  }));
}

async function discoverModelCandidates() {
  const models = new Map();
  const add = (id, label, source) => addModelCandidate(models, id, label, source);

  add("", "Default (Claude Code)", "built-in");
  add("opus", "Opus alias", "built-in");
  add("sonnet", "Sonnet alias", "built-in");
  add("haiku", "Haiku alias", "built-in");
  add("fable", "Fable alias", "built-in");
  add("claude-opus-4-8", "Opus 4.8", "built-in");
  add("claude-opus-4-8[1m]", "Opus 4.8 (1M context)", "built-in");
  add("claude-opus-4-7", "Opus 4.7", "built-in");
  add("claude-opus-4-7[1m]", "Opus 4.7 (1M context)", "built-in");
  add("claude-opus-4-6", "Opus 4.6", "built-in");
  add("claude-opus-4-6[1m]", "Opus 4.6 (1M context)", "built-in");
  add("claude-sonnet-4-6", "Sonnet 4.6", "built-in");
  add("claude-sonnet-4-6[1m]", "Sonnet 4.6 (1M context)", "built-in");
  add("claude-haiku-4-5", "Haiku 4.5", "built-in");
  add("claude-fable-5", "Fable 5", "built-in");
  add("claude-fable-5[1m]", "Fable 5 (1M context)", "built-in");

  collectEnvModelCandidates(models);
  await collectSettingsModelCandidates(models);
  await collectHistoryModelCandidates(models);
  await collectChangelogModelCandidates(models);

  return Array.from(models.values()).sort(compareModelCandidates);
}

function addModelCandidate(models, rawId, label, source) {
  if (rawId === undefined || rawId === null) return;
  const id = rawId ? normalizeModelId(rawId) : "";
  if (id === null) return;

  const key = id || "";
  const existing = models.get(key);
  if (existing) {
    if (source && !existing.sources.includes(source)) existing.sources.push(source);
    if (label && existing.label === existing.id) existing.label = label;
    return;
  }

  models.set(key, {
    id,
    label: label || humanizeModelId(id),
    sources: source ? [source] : [],
    checked: false,
    available: id ? null : true,
    error: ""
  });
}

function collectEnvModelCandidates(models) {
  const keys = [
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "CLAUDE_MODEL",
    "CLAUDE_CODE_MODEL"
  ];

  for (const key of keys) {
    addModelCandidate(models, process.env[key], "", `env:${key}`);
  }
}

async function collectSettingsModelCandidates(models) {
  const candidateFiles = [
    path.join(claudeDataDir, "settings.json"),
    path.join(claudeDataDir, "settings.local.json"),
    path.join(claudeDataDir, "managed-settings.json")
  ];

  for (const filePath of candidateFiles) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const parsed = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
      collectModelIdsFromValue(parsed, (id) => addModelCandidate(models, id, "", `settings:${path.basename(filePath)}`));
    } catch (_) {
      // Ignore malformed settings files.
    }
  }
}

async function collectHistoryModelCandidates(models) {
  const historyPath = path.join(claudeDataDir, "history.jsonl");
  if (!fs.existsSync(historyPath)) return;

  try {
    const raw = await fs.promises.readFile(historyPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (typeof record.display === "string") {
          const match = record.display.match(/^\/model\s+(.+)$/);
          if (match) addModelCandidate(models, match[1].trim(), "", "history");
        }
      } catch (_) {
        // Ignore malformed history lines.
      }
    }
  } catch (_) {
    // Ignore unreadable history.
  }
}

async function collectChangelogModelCandidates(models) {
  const changelogPath = path.join(claudeDataDir, "cache", "changelog.md");
  if (!fs.existsSync(changelogPath)) return;

  try {
    const raw = await fs.promises.readFile(changelogPath, "utf8");
    const matches = raw.matchAll(/\b(?:[a-z]{2}\.)?anthropic\.claude-(?:opus|sonnet|haiku|fable)-[A-Za-z0-9_.:\-/\[\]]+|\bclaude-(?:opus|sonnet|haiku|fable)-[A-Za-z0-9_.:\-/\[\]]+/gi);
    for (const match of matches) {
      const cleaned = match[0].replace(/[),.;]+$/, "");
      if (looksLikeModelId(cleaned)) addModelCandidate(models, cleaned, "", "changelog");
    }
  } catch (_) {
    // Ignore unreadable changelog.
  }
}

function collectModelIdsFromValue(value, add) {
  if (typeof value === "string") {
    if (looksLikeModelId(value)) add(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectModelIdsFromValue(item, add);
    return;
  }

  if (!value || typeof value !== "object") return;

  for (const [key, item] of Object.entries(value)) {
    if (/model/i.test(key)) collectModelIdsFromValue(item, add);
    if (key === "availableModels") collectModelIdsFromValue(item, add);
  }
}

function looksLikeModelId(value) {
  const normalized = normalizeModelId(value);
  if (!normalized) return false;
  return /^(default|opus|sonnet|haiku|fable)$/i.test(normalized)
    || /^(?:[a-z]{2}\.)?anthropic\.claude-(?:opus|sonnet|haiku|fable)-/i.test(normalized)
    || /^claude-(?:opus|sonnet|haiku|fable)-/i.test(normalized);
}

async function probeModelCandidates(candidates, requestedIds) {
  const results = candidates.map((model) => ({ ...model, sources: [...model.sources] }));
  const byId = new Map(results.map((model) => [model.id || "", model]));
  const toProbe = results.filter((model) => model.id && (!requestedIds || requestedIds.has(model.id)));
  let index = 0;

  async function worker() {
    while (index < toProbe.length) {
      const model = toProbe[index++];
      const result = await probeModel(model.id);
      const target = byId.get(model.id);
      if (target) {
        target.checked = true;
        target.available = result.available;
        target.error = result.error;
        target.probeExitCode = result.exitCode;
      }
    }
  }

  await Promise.all([worker(), worker()]);

  return results;
}

function probeModel(modelId) {
  return new Promise((resolve) => {
    const probeArgs = [
      "--model", modelId,
      "--no-session-persistence",
      "--max-budget-usd", "0.01",
      "-p", "Reply with exactly OK."
    ];
    const spawnSpec = getSpawnSpec(command, probeArgs);
    let stdout = "";
    let stderr = "";
    let finished = false;
    const child = childProcess.spawn(spawnSpec.file, spawnSpec.args, {
      cwd: claudeCwd,
      windowsHide: true,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        FORCE_COLOR: "0"
      }
    });

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try {
        child.kill();
      } catch (_) {
        // Ignore kill races.
      }
      resolve({ available: false, error: "Timed out while checking this model.", exitCode: null });
    }, 45000);

    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-12000);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-12000);
    });
    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ available: false, error: error.message || "Could not start Claude.", exitCode: null });
    });
    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const combined = stripAnsi(`${stdout}\n${stderr}`).trim();
      const budgetLimited = /Exceeded USD budget/i.test(combined);
      const denied = /403|无权访问模型|not authorized|not authorised|permission denied|does not have access/i.test(combined);
      const invalid = /model.*(not found|not available|invalid|unsupported|unknown)|invalid model|unknown model|model not found/i.test(combined);
      const available = (code === 0 || budgetLimited) && !denied && !invalid;
      resolve({
        available,
        error: available
          ? (budgetLimited ? "Probe hit the safety budget cap, but Claude accepted the model name before generation." : "")
          : truncateText(combined || `Claude exited with code ${code}.`, 180),
        exitCode: code
      });
    });
  });
}

function stripAnsi(value) {
  return String(value || "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "");
}

function compareModelCandidates(a, b) {
  const rank = (model) => {
    const id = model.id || "";
    if (!id) return 0;
    if (/^opus$/i.test(id)) return 10;
    if (/claude-opus-4-8/i.test(id)) return 11;
    if (/claude-opus-4-7/i.test(id)) return 12;
    if (/claude-opus-4-6/i.test(id)) return 13;
    if (/^sonnet$/i.test(id)) return 20;
    if (/claude-sonnet/i.test(id)) return 21;
    if (/^haiku$/i.test(id)) return 30;
    if (/claude-haiku/i.test(id)) return 31;
    if (/^fable$/i.test(id)) return 40;
    if (/claude-fable/i.test(id)) return 41;
    return 90;
  };
  const byRank = rank(a) - rank(b);
  if (byRank) return byRank;
  return (a.label || a.id || "").localeCompare(b.label || b.id || "");
}

function humanizeModelId(id) {
  if (!id) return "Default (Claude Code)";
  const alias = {
    opus: "Opus alias",
    sonnet: "Sonnet alias",
    haiku: "Haiku alias",
    fable: "Fable alias"
  }[id.toLowerCase()];
  if (alias) return alias;

  const match = id.match(/claude-(opus|sonnet|haiku|fable)-([0-9-]+)(\[1m\])?/i);
  if (match) {
    const family = match[1][0].toUpperCase() + match[1].slice(1).toLowerCase();
    const version = match[2].replace(/-/g, ".");
    const suffix = match[3] ? " (1M context)" : "";
    return `${family} ${version}${suffix}`;
  }

  return id;
}

async function listProjectSessions() {
  const { projectKey, projectDir } = getProjectContext();
  const activeSessionId = await findActiveSessionId();

  if (!fs.existsSync(projectDir)) {
    return {
      projectKey,
      projectDir,
      activeSessionId,
      sessions: []
    };
  }

  const dirEntries = await fs.promises.readdir(projectDir, { withFileTypes: true });
  const files = dirEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => entry.name);

  const stats = await Promise.all(files.map(async (name) => {
    const fullPath = path.join(projectDir, name);
    const fileStat = await fs.promises.stat(fullPath);
    return {
      name,
      fullPath,
      mtimeMs: fileStat.mtimeMs,
      updatedAt: fileStat.mtime.toISOString()
    };
  }));

  stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const recentStats = stats.slice(0, 40);
  const sessions = await Promise.all(recentStats.map(readSessionSummary));

  return {
    projectKey,
    projectDir,
    activeSessionId,
    sessions: sessions.filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs)
  };
}

async function deleteProjectSession(sessionId) {
  const { projectDir } = getProjectContext();
  const projectSessionPath = path.join(projectDir, `${sessionId}.jsonl`);
  const existsInProject = fs.existsSync(projectSessionPath);

  if (!existsInProject) {
    return false;
  }

  const activeSessionId = await findActiveSessionId();
  const isCurrentSession = sessionId === activeSessionId || sessionId === resumeSessionId;

  if (isCurrentSession) {
    resumeSessionId = null;
    stopTerminal();
  }

  await fs.promises.unlink(projectSessionPath);
  await deleteSessionMetadataFiles(sessionId);
  await pruneHistoryFile(sessionId);

  if (isCurrentSession) {
    startTerminal();
  }

  return true;
}

async function readSessionSummary(fileInfo) {
  const raw = await fs.promises.readFile(fileInfo.fullPath, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  let firstUserText = "";
  let lastUserText = "";
  let lastAssistantText = "";
  let messageCount = 0;

  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch (_) {
      continue;
    }

    if (record.type === "user") {
      messageCount += 1;
      const text = extractMessageText(record.message && record.message.content);
      if (text && !firstUserText) firstUserText = text;
      if (text) lastUserText = text;
    } else if (record.type === "assistant") {
      messageCount += 1;
      const text = extractMessageText(record.message && record.message.content);
      if (text) lastAssistantText = text;
    }
  }

  return {
    id: path.basename(fileInfo.name, ".jsonl"),
    path: fileInfo.fullPath,
    updatedAt: fileInfo.updatedAt,
    mtimeMs: fileInfo.mtimeMs,
    firstUserText: truncateText(firstUserText, 120),
    lastUserText: truncateText(lastUserText, 120),
    lastAssistantText: truncateText(lastAssistantText, 160),
    messageCount
  };
}

function extractMessageText(content) {
  if (typeof content === "string") {
    return squashWhitespace(content);
  }

  if (Array.isArray(content)) {
    const joined = content
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        if (item.type === "text" && typeof item.text === "string") return item.text;
        return "";
      })
      .filter(Boolean)
      .join(" ");

    return squashWhitespace(joined);
  }

  return "";
}

function squashWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function truncateText(value, limit) {
  if (!value || value.length <= limit) return value || "";
  return `${value.slice(0, Math.max(0, limit - 1)).trim()}...`;
}

function encodeClaudeProjectKey(cwd) {
  const resolved = path.resolve(cwd);

  if (process.platform === "win32") {
    return resolved
      .replace(/:\\/, "--")
      .replace(/[\\/]/g, "-")
      .replace(/:/g, "");
  }

  return resolved.replace(/\//g, "-");
}

function getProjectContext() {
  const projectKey = encodeClaudeProjectKey(claudeCwd);
  const projectDir = path.join(claudeDataDir, "projects", projectKey);
  return { projectKey, projectDir };
}

async function findActiveSessionId() {
  if (!persistSession || !term || !term.pid) return null;

  const sessionsDir = path.join(claudeDataDir, "sessions");
  if (!fs.existsSync(sessionsDir)) return null;

  const entries = await fs.promises.readdir(sessionsDir, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => entry.name);

  for (const fileName of files) {
    try {
      const raw = await fs.promises.readFile(path.join(sessionsDir, fileName), "utf8");
      const sessionMeta = JSON.parse(raw);
      if (sessionMeta.pid === term.pid && path.resolve(sessionMeta.cwd || "") === claudeCwd) {
        return typeof sessionMeta.sessionId === "string" ? sessionMeta.sessionId : null;
      }
    } catch (_) {
      // Ignore malformed or transient files.
    }
  }

  return null;
}

async function deleteSessionMetadataFiles(sessionId) {
  const sessionsDir = path.join(claudeDataDir, "sessions");
  if (!fs.existsSync(sessionsDir)) return;

  const entries = await fs.promises.readdir(sessionsDir, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => entry.name);

  for (const fileName of files) {
    const fullPath = path.join(sessionsDir, fileName);

    try {
      const raw = await fs.promises.readFile(fullPath, "utf8");
      const sessionMeta = JSON.parse(raw);
      if (sessionMeta && sessionMeta.sessionId === sessionId) {
        await fs.promises.unlink(fullPath);
      }
    } catch (_) {
      // Ignore transient or malformed metadata files.
    }
  }
}

async function pruneHistoryFile(sessionId) {
  const historyPath = path.join(claudeDataDir, "history.jsonl");
  if (!fs.existsSync(historyPath)) return;

  const raw = await fs.promises.readFile(historyPath, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const kept = [];
  let changed = false;

  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      if (record && record.sessionId === sessionId) {
        changed = true;
        continue;
      }
    } catch (_) {
      // Keep malformed history lines intact.
    }

    kept.push(line);
  }

  if (changed) {
    const nextContent = kept.length ? `${kept.join("\n")}\n` : "";
    await fs.promises.writeFile(historyPath, nextContent, "utf8");
  }
}

function stopTerminal() {
  if (!term) return;

  try {
    term.kill();
  } catch (_) {
    // Ignore stop races.
  }
}

function splitCommandLine(value) {
  const parts = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(value)) !== null) {
    parts.push(match[1] ?? match[2] ?? match[3]);
  }
  return parts;
}

function formatCommand(file, spawnArgs) {
  return [file, ...spawnArgs].map((part) => /\s/.test(part) ? JSON.stringify(part) : part).join(" ");
}

function cmdQuote(value) {
  const stringValue = String(value);
  if (!/[()\s^&|<>"]/.test(stringValue)) return stringValue;
  return `"${stringValue.replace(/"/g, '\\"')}"`;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
