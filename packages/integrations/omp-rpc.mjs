import { spawn as nodeSpawn } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline";

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_EVENT_COUNT = 500;
const MAX_STDERR_CHARS = 8_000;

const CHILD_ENV_ALLOWLIST = Object.freeze([
  "PATH",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "PI_CODING_AGENT_DIR",
  "OMP_AUTH_BROKER_URL",
  "OMP_AUTH_BROKER_TOKEN"
]);

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor", "open_url"]);

function numericOption(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolvePromise = resolveValue;
    rejectPromise = rejectValue;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function tail(value, limit = MAX_STDERR_CHARS) {
  const text = String(value ?? "");
  return text.length > limit ? text.slice(-limit) : text;
}

function safePath(candidate, root) {
  const full = resolve(candidate);
  const base = resolve(root);
  const rel = relative(base, full);
  return (
    rel === "" ||
    (rel !== ".." &&
      !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      !isAbsolute(rel))
  );
}

export function normalizeOmpExecutionMode(value = "manual") {
  const mode = String(value ?? "manual")
    .trim()
    .toLowerCase();
  if (!["manual", "auto"].includes(mode)) {
    throw new Error(`unsupported_coding_execution_mode:${mode}`);
  }
  return mode;
}

export function ompApprovalMode(executionMode) {
  return normalizeOmpExecutionMode(executionMode) === "auto" ? "yolo" : "always-ask";
}

export function ompRpcArgs(options = {}) {
  const args = [
    "--mode",
    "rpc",
    "--session-dir",
    options.sessionDir,
    "--approval-mode",
    options.approvalMode ?? ompApprovalMode(options.executionMode)
  ];
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.provider) {
    args.push("--provider", options.provider);
  }
  if (options.noLsp === true) {
    args.push("--no-lsp");
  }
  return args;
}

export function ompChildEnvironment(options = {}) {
  const source = options.env ?? process.env;
  const child = {};
  for (const name of options.allowlist ?? CHILD_ENV_ALLOWLIST) {
    if (source[name] !== undefined && source[name] !== "") {
      child[name] = String(source[name]);
    }
  }
  child.HOME = options.homeDir;
  child.PI_CODING_AGENT_DIR = options.agentDir ?? source.PI_CODING_AGENT_DIR;
  child.CONDUCTOR_PORT = String(options.conductorPort ?? source.CONDUCTOR_PORT ?? "");
  child.NO_COLOR = "1";
  return Object.fromEntries(
    Object.entries(child).filter(([, value]) => value !== undefined && value !== "")
  );
}

export function sanitizeOmpRpcFrame(frame = {}) {
  const result = {
    type: String(frame.type ?? "unknown")
  };
  if (frame.type === "response") {
    return {
      ...result,
      id: frame.id,
      command: frame.command,
      success: frame.success,
      error: frame.success === false ? tail(frame.error, 500) : undefined
    };
  }
  if (frame.type === "extension_ui_request") {
    return {
      ...result,
      id: frame.id,
      method: frame.method,
      title: tail(frame.title, 300),
      message: tail(frame.message, 500),
      requiresResponse: DIALOG_METHODS.has(frame.method)
    };
  }
  if (frame.type === "tool_execution_start" || frame.type === "tool_execution_end") {
    return {
      ...result,
      toolName: frame.toolName,
      toolCallId: frame.toolCallId,
      isError: frame.isError === true
    };
  }
  if (frame.type === "agent_end" || frame.type === "turn_end") {
    return {
      ...result,
      stopReason: frame.stopReason ?? frame.message?.stopReason,
      usage: frame.usage ?? frame.message?.usage
    };
  }
  if (frame.type === "prompt_result") {
    return { ...result, id: frame.id, agentInvoked: frame.agentInvoked === true };
  }
  if (frame.type === "session_state") {
    return {
      ...result,
      sessionId: frame.sessionId,
      sessionPath: frame.sessionPath
    };
  }
  return result;
}

async function canonicalWorktree(worktreeDir, workRoot) {
  if (!worktreeDir || !workRoot) {
    throw new Error("coding_agent_worktree_and_root_required");
  }
  const [worktree, root] = await Promise.all([realpath(worktreeDir), realpath(workRoot)]);
  if (!safePath(worktree, root)) {
    throw new Error("coding_agent_worktree_outside_allowed_root");
  }
  return worktree;
}

function processError(message, stderr) {
  return new Error(`${message}${stderr ? `: ${tail(stderr)}` : ""}`);
}

export async function runOmpRpcSession(options = {}) {
  const worktreeDir = await canonicalWorktree(options.worktreeDir, options.workRoot);
  const executionMode = normalizeOmpExecutionMode(options.executionMode);
  const sessionDir = resolve(options.sessionDir);
  const homeDir = resolve(options.homeDir);
  const agentDir = resolve(options.agentDir);
  const resumeSessionPath = options.resumeSessionPath
    ? resolve(options.resumeSessionPath)
    : undefined;
  if (resumeSessionPath && !safePath(resumeSessionPath, sessionDir)) {
    throw new Error("omp_resume_session_outside_task_session_dir");
  }
  await Promise.all([
    mkdir(sessionDir, { recursive: true, mode: 0o700 }),
    mkdir(homeDir, { recursive: true, mode: 0o700 }),
    mkdir(agentDir, { recursive: true, mode: 0o700 })
  ]);

  const command = options.command ?? "omp";
  const args = ompRpcArgs({
    sessionDir,
    executionMode,
    approvalMode: options.approvalMode,
    model: options.model,
    provider: options.provider,
    noLsp: options.noLsp
  });
  const child = (options.spawn ?? nodeSpawn)(command, args, {
    cwd: worktreeDir,
    env: ompChildEnvironment({
      env: options.env,
      homeDir,
      agentDir,
      conductorPort: options.conductorPort,
      allowlist: options.envAllowlist
    }),
    stdio: ["pipe", "pipe", "pipe"]
  });
  const events = [];
  const approvals = [];
  const pending = new Map();
  const ready = deferred();
  const terminal = deferred();
  const promptResult = deferred();
  let stderr = "";
  let closed = false;
  let abortRequested = false;
  let abortKillTimer;
  let commandSequence = 0;
  let terminalFrame;

  const record = (frame) => {
    const event = { ...sanitizeOmpRpcFrame(frame), observedAt: new Date().toISOString() };
    if (events.length < (options.maxEvents ?? MAX_EVENT_COUNT)) {
      events.push(event);
    }
    options.onEvent?.(event);
  };

  function write(frame) {
    if (closed || !child.stdin?.writable) {
      throw processError("omp_rpc_stdin_closed", stderr);
    }
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  function request(type, payload = {}, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
    const id = `dashboard_${++commandSequence}`;
    const waiting = deferred();
    const timeout = setTimeout(
      () => {
        pending.delete(id);
        waiting.reject(processError(`omp_rpc_${type}_timeout`, stderr));
      },
      numericOption(timeoutMs, DEFAULT_COMMAND_TIMEOUT_MS)
    );
    pending.set(id, {
      resolve: (response) => {
        clearTimeout(timeout);
        if (response.success === false) {
          waiting.reject(processError(`omp_rpc_${type}_failed:${response.error}`, stderr));
        } else {
          waiting.resolve(response);
        }
      },
      reject: (error) => {
        clearTimeout(timeout);
        waiting.reject(error);
      }
    });
    write({ id, type, ...payload });
    return waiting.promise;
  }

  const abortRun = () => {
    abortRequested = true;
    try {
      write({ id: `dashboard_${++commandSequence}`, type: "abort" });
    } catch (_error) {
      // The process may already be gone.
    }
    abortKillTimer = setTimeout(() => child.kill?.("SIGTERM"), 5_000);
  };
  options.signal?.addEventListener("abort", abortRun, { once: true });
  if (options.signal?.aborted) abortRun();

  const stdoutLines = createInterface({ input: child.stdout });
  stdoutLines.on("line", (line) => {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch (_error) {
      record({ type: "protocol_error" });
      return;
    }
    record(frame);
    if (frame.type === "ready") {
      ready.resolve(frame);
      return;
    }
    if (frame.type === "response" && frame.id && pending.has(frame.id)) {
      const waiter = pending.get(frame.id);
      pending.delete(frame.id);
      waiter.resolve(frame);
      return;
    }
    if (frame.type === "prompt_result") {
      promptResult.resolve(frame);
      return;
    }
    if (frame.type === "extension_ui_request" && DIALOG_METHODS.has(frame.method)) {
      approvals.push(sanitizeOmpRpcFrame(frame));
      write({ type: "extension_ui_response", id: frame.id, cancelled: true });
      return;
    }
    if (frame.type === "agent_end") {
      terminalFrame = frame;
      terminal.resolve(frame);
    }
  });
  child.stderr?.on("data", (chunk) => {
    stderr = tail(`${stderr}${chunk}`);
  });
  child.once("error", (error) => {
    ready.reject(error);
    terminal.reject(error);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });
  child.once("exit", (code, signal) => {
    closed = true;
    const error = processError(`omp_rpc_exited:${code ?? signal ?? "unknown"}`, stderr);
    if (!terminalFrame) terminal.reject(error);
    ready.reject(error);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });

  const startupTimeout = setTimeout(
    () => ready.reject(processError("omp_rpc_ready_timeout", stderr)),
    numericOption(options.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS)
  );

  try {
    await ready.promise;
    clearTimeout(startupTimeout);
    if (abortRequested) throw new Error("omp_rpc_cancelled");
    let stateResponse = await request("get_state", {}, options.commandTimeoutMs);
    if (resumeSessionPath && resumeSessionPath !== stateResponse.data?.sessionFile) {
      await request("switch_session", { sessionPath: resumeSessionPath }, options.commandTimeoutMs);
      stateResponse = await request("get_state", {}, options.commandTimeoutMs);
    }
    record({
      type: "session_state",
      sessionId: stateResponse.data?.sessionId,
      sessionPath: stateResponse.data?.sessionFile
    });
    const promptResponse = await request(
      "prompt",
      { message: String(options.prompt ?? "") },
      options.commandTimeoutMs
    );
    const turnTimeoutMs = numericOption(options.turnTimeoutMs, DEFAULT_TURN_TIMEOUT_MS);
    const withTurnTimeout = async (promise) => {
      let turnTimer;
      return Promise.race([
        promise,
        new Promise((_, reject) => {
          turnTimer = setTimeout(
            () => reject(processError("omp_rpc_turn_timeout", stderr)),
            turnTimeoutMs
          );
        })
      ]).finally(() => clearTimeout(turnTimer));
    };
    let agentInvoked = promptResponse.data?.agentInvoked;
    if (agentInvoked === undefined) {
      const firstOutcome = await withTurnTimeout(
        Promise.race([
          promptResult.promise.then((frame) => ({ type: "prompt_result", frame })),
          terminal.promise.then((frame) => ({ type: "agent_end", frame }))
        ])
      );
      agentInvoked =
        firstOutcome.type === "agent_end" ? true : firstOutcome.frame.agentInvoked !== false;
    }
    if (agentInvoked && !terminalFrame) {
      await withTurnTimeout(terminal.promise);
    }
    const [lastTextResponse, finalStateResponse] = await Promise.all([
      request("get_last_assistant_text", {}, options.commandTimeoutMs).catch(() => undefined),
      request("get_state", {}, options.commandTimeoutMs).catch(() => undefined)
    ]);
    const finalState = finalStateResponse?.data ?? stateResponse.data;
    return {
      status: abortRequested
        ? "cancelled"
        : approvals.length
          ? "waiting-for-approval"
          : "completed",
      executionMode,
      approvalMode: ompApprovalMode(executionMode),
      agentInvoked,
      sessionId: finalState?.sessionId,
      sessionPath: finalState?.sessionFile,
      finalText: tail(lastTextResponse?.data?.text, options.maxFinalTextChars ?? 12_000),
      approvals,
      events,
      terminal: terminalFrame ? sanitizeOmpRpcFrame(terminalFrame) : undefined,
      stderrTail: stderr || undefined
    };
  } catch (error) {
    try {
      write({ id: `dashboard_${++commandSequence}`, type: "abort" });
    } catch (_abortError) {
      // The process may already be gone.
    }
    return {
      status: abortRequested ? "cancelled" : "failed",
      executionMode,
      approvalMode: ompApprovalMode(executionMode),
      error: error instanceof Error ? error.message : String(error),
      approvals,
      events,
      stderrTail: stderr || undefined
    };
  } finally {
    clearTimeout(startupTimeout);
    clearTimeout(abortKillTimer);
    options.signal?.removeEventListener("abort", abortRun);
    stdoutLines.close();
    if (!closed) {
      child.stdin?.end();
      child.kill?.("SIGTERM");
    }
  }
}
