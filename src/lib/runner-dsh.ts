import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { checkHealth, type Adapter } from "./adapters.js";
import { truncate2kb, type Ledger, type TaskRecord } from "./ledger.js";
import { newTaskId, notify } from "./runner.js";
import { checkVersionGate } from "./transport.js";

/** RFC §4.1 事件线界：单行 8KB / 单事件 32KB，超限截断并带标记 */
const MAX_LINE_CHARS = 8 * 1024;
const MAX_EVENT_CHARS = 32 * 1024;

export interface StdioRpcConfig {
  type: "stdio-rpc";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface DshRunOptions {
  adapter: Adapter;
  transport: StdioRpcConfig;
  prompt: string;
  cwd?: string;
  /** DSH_HOME 隔离目录（绝不碰用户交互式 ~/.dsh） */
  dshHome?: string;
  wait: boolean;
  timeoutMs: number;
  ledger: Ledger;
  tasksDir: string;
  notifyCommand?: string;
  fallbackUsed?: boolean;
  /** v0.4.3 后台任务终态回调（重试/降级编排用）；wait=true 不触发 */
  onFinal?: (rec: TaskRecord) => void;
}

interface RpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
}

interface DshProc {
  child: ChildProcess;
  /** wire-stable 标识（serverInfo.version，dsh 固定 0.0.1），仅记录台账不参与门禁 */
  serverVersion?: string;
  ready: Promise<void>;
  nextId: number;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  subscribers: Set<(m: RpcMessage) => void>;
  protocolWarnings: number;
  closed: boolean;
}

const processes = new Map<string, DshProc>();

function procKey(adapterId: string, opts: DshRunOptions): string {
  return `${adapterId}::${opts.transport.command}::${opts.dshHome ?? ""}`;
}

/** 关闭全部驻留进程（测试与进程退出用） */
export function closeAllDshProcesses(): void {
  for (const p of processes.values()) {
    try {
      p.child.kill("SIGTERM");
    } catch {
      // 已退出
    }
    p.closed = true;
  }
  processes.clear();
}

function writeLine(p: DshProc, msg: RpcMessage): void {
  if (p.closed) throw new Error("dsh sdk 进程已退出");
  p.child.stdin?.write(`${JSON.stringify(msg)}\n`);
}

function request(p: DshProc, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
  const id = ++p.nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      p.pending.delete(id);
      reject(new Error(`dsh rpc ${method} 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    p.pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    try {
      writeLine(p, { jsonrpc: "2.0", id, method, params });
    } catch (err) {
      clearTimeout(timer);
      p.pending.delete(id);
      reject(err as Error);
    }
  });
}

function handleLine(p: DshProc, line: string, onProtocolWarning?: (msg: string) => void): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: RpcMessage;
  try {
    msg = JSON.parse(trimmed) as RpcMessage;
  } catch {
    // stdout 纯度契约：污染帧记 warning 跳过，不崩插件
    p.protocolWarnings += 1;
    onProtocolWarning?.(trimmed.slice(0, 200));
    return;
  }
  if (msg.id !== undefined && msg.id !== null) {
    const entry = p.pending.get(Number(msg.id));
    if (!entry) return;
    p.pending.delete(Number(msg.id));
    if (msg.error) entry.reject(new Error(`dsh rpc error: ${msg.error.message ?? JSON.stringify(msg.error)}`));
    else entry.resolve(msg.result);
    return;
  }
  if (msg.method) {
    for (const sub of p.subscribers) sub(msg);
  }
}

/** 常驻 sdk 进程（多会话复用一进程），首次使用时 spawn + 版本门禁 + initialize */
function ensureProcess(opts: DshRunOptions): DshProc {
  const key = procKey(opts.adapter.id, opts);
  const existing = processes.get(key);
  if (existing && !existing.closed) return existing;
  if (opts.dshHome) {
    try {
      mkdirSync(opts.dshHome, { recursive: true });
    } catch {
      // 目录已存在
    }
  }
  const child = spawn(opts.transport.command, opts.transport.args ?? ["--profile", "sdk"], {
    env: {
      ...process.env,
      ...(opts.transport.env ?? {}),
      ...(opts.dshHome ? { DSH_HOME: opts.dshHome } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const p: DshProc = {
    child,
    nextId: 0,
    pending: new Map(),
    subscribers: new Set(),
    protocolWarnings: 0,
    closed: false,
    ready: Promise.resolve(),
  };
  let buf = "";
  let stdoutError: Error | undefined;
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buf += chunk;
    for (;;) {
      const idx = buf.indexOf("\n");
      if (idx < 0) break;
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      handleLine(p, line.slice(0, MAX_LINE_CHARS));
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", () => {
    // stderr 仅丢弃：协议流只认 stdout（stdout 纯度契约）
  });
  child.on("error", (err) => {
    p.closed = true;
    processes.delete(key);
    stdoutError = err;
    for (const [, entry] of p.pending) entry.reject(err);
    p.pending.clear();
  });
  child.on("exit", () => {
    p.closed = true;
    processes.delete(key);
    for (const [, entry] of p.pending) entry.reject(stdoutError ?? new Error("dsh sdk 进程已退出"));
    p.pending.clear();
  });
  processes.set(key, p);
  p.ready = (async () => {
    // 门禁取真实二进制版本（adapter.versionCheck）；serverInfo.version 是 wire-stable
    // 固定标识（dsh 返回 0.0.1），不是 dsh 版本，不参与门禁
    const health = checkHealth(opts.adapter);
    const gateResult = checkVersionGate(health.version, opts.adapter.versionGate ?? {});
    if (!gateResult.ok) {
      p.closed = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // 已退出
      }
      processes.delete(key);
      throw new Error(`版本协商失败: ${gateResult.detail ?? "未知原因"}`);
    }
    const sdkCfg = opts.adapter.sdk;
    const result = (await request(
      p,
      "initialize",
      {
        cwd: opts.cwd,
        provider: process.env.DSH_PROVIDER ?? sdkCfg?.provider,
        model: process.env.DSH_MODEL ?? sdkCfg?.model,
        ...(sdkCfg?.reasoningEffort ? { reasoningEffort: sdkCfg.reasoningEffort } : {}),
        ...(sdkCfg?.maxTokens != null ? { maxTokens: sdkCfg.maxTokens } : {}),
      },
      15000,
    )) as { serverInfo?: { version?: string } } | undefined;
    p.serverVersion = result?.serverInfo?.version;
  })();
  return p;
}

export function newDshSessionId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  return `dsh_${ts}_${Math.random().toString(36).slice(2, 8)}`;
}

interface DshEventSink {
  push: (type: string, payload: unknown) => void;
  setError: (msg: string) => void;
  markDone: () => void;
}

function mapDshNotification(msg: RpcMessage, sessionId: string, sink: DshEventSink): void {
  const params = (msg.params ?? {}) as Record<string, unknown>;
  const sid = (params.sessionId as string | undefined) ?? (params.sessionID as string | undefined);
  if (sid && sid !== sessionId) return; // 单进程多会话：只取本会话
  switch (msg.method) {
    case "session.event": {
      const event = (params.event ?? params) as Record<string, unknown>;
      const type = event.type as string | undefined;
      if (type === "step_start" || type === "step_finish") {
        sink.push("step", { phase: type === "step_start" ? "start" : "finish" });
      } else if (type === "tool_use") {
        sink.push("tool_use", {
          tool: event.tool,
          state: event.state ?? event.status,
          input: typeof event.input === "string" ? truncate2kb(event.input) : event.input,
          output: typeof event.output === "string" ? truncate2kb(event.output) : event.output,
          error: event.error,
        });
      } else if (type === "text") {
        sink.push("text", { text: truncate2kb(String(event.text ?? "")) });
      } else if (type === "error") {
        sink.push("error", { message: event.message ?? JSON.stringify(event).slice(0, 2000) });
        sink.setError(String(event.message ?? "unknown dsh error"));
      } else {
        sink.push("status", { type: type ?? "session.event", envelope: truncate2kb(JSON.stringify(event)) });
      }
      return;
    }
    case "session.status": {
      const status = (params.status ?? {}) as Record<string, unknown>;
      const type = String(status.type ?? status);
      if (type === "retry") {
        sink.push("retry", {
          attempt: status.attempt,
          reason: status.reason,
          nextAttemptAt: (status.next as { time?: string } | undefined)?.time,
        });
      } else if (type === "idle" || type === "done" || type === "completed" || type === "finished") {
        sink.push("status", { status: "idle" });
        sink.markDone();
      } else {
        sink.push("status", { status: type });
      }
      return;
    }
    case "subagent.started":
      sink.push("status", { subagent: "started", name: params.name });
      return;
    case "subagent.finished":
      sink.push("status", { subagent: "finished", name: params.name });
      return;
    default:
      return;
  }
}

/**
 * dsh stdio JSON-RPC 任务：常驻 sdk 进程（initialize 版本门禁）→ session/prompt →
 * 通知流 → session/wait 结算。spawn 失败且 delegate.run 可用时回落 headless NDJSON（fallback_used=1）。
 * 版本越界显性拒绝，不做 headless 兜底。
 */
export async function runDshTask(opts: DshRunOptions): Promise<TaskRecord> {
  const id = newTaskId();
  const startedAt = new Date().toISOString();
  const logFile = path.join(opts.tasksDir, `${id}.log`);
  const base: TaskRecord = {
    id,
    harness: opts.adapter.id,
    transport: "stdio-rpc",
    prompt: opts.prompt.length > 500 ? `${opts.prompt.slice(0, 500)}…` : opts.prompt,
    cwd: opts.cwd,
    status: "running",
    pid: process.pid,
    createdAt: startedAt,
    startedAt,
    logFile,
    title: `${id}; ${opts.prompt.slice(0, 60)}`,
    ...(opts.fallbackUsed ? { fallbackUsed: true } : {}),
  };
  opts.ledger.append(base);
  const exec = executeDshTask(opts, base);
  if (opts.wait) return exec;
  exec
    .then((rec) => {
      try {
        opts.onFinal?.(rec);
      } catch {
        // 编排回调失败不影响台账
      }
    })
    .catch(() => {}); // 失败已在 executeDshTask 内部落台账，防止 unhandled rejection
  return { ...base };
}

async function executeDshTask(opts: DshRunOptions, base: TaskRecord): Promise<TaskRecord> {
  const startedMs = Date.now();
  let finished = false;
  let failReason: string | undefined;
  const pendingEvents: Array<{ type: string; payload: unknown; ts: string }> = [];
  let lastText = "";

  const flush = (): void => {
    if (pendingEvents.length === 0) return;
    opts.ledger.addEvents(base.id, pendingEvents.splice(0));
  };

  const finalize = (status: TaskRecord["status"], reason?: string): TaskRecord => {
    if (finished) return { ...base, status };
    finished = true;
    flush();
    const fr = reason ?? failReason;
    const rec: TaskRecord = {
      ...base,
      sessionId,
      status,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      outputTail: lastText ? truncate2kb(lastText) : "",
      ...(fr ? { failReason: fr } : {}),
    };
    opts.ledger.append(rec);
    notify(opts.notifyCommand, rec);
    return rec;
  };

  const sessionId = newDshSessionId();

  let proc: DshProc;
  try {
    proc = ensureProcess(opts);
    await proc.ready;
    opts.ledger.addEvents(base.id, [
      {
        type: "status",
        payload: { sdk_server_version: proc.serverVersion ?? null },
        ts: new Date().toISOString(),
      },
    ]);
  } catch (err) {
    const msg = (err as Error).message;
    // 版本门禁拒绝 → 显性失败不兜底；spawn 失败（ENOENT 等）→ headless 兜底
    if (msg.includes("版本协商失败")) {
      return finalize("failed", msg);
    }
    if ((err as NodeJS.ErrnoException).code === "ENOENT" && Array.isArray(opts.adapter.delegate?.run)) {
      opts.ledger.append({ ...base, failReason: `sdk 进程不可用（${msg}），回落 headless` });
      return runDshHeadless(opts, base);
    }
    return finalize("failed", `dsh sdk 启动失败: ${msg}`);
  }

  const unsub = (() => {
    const sub = (m: { method?: string; params?: unknown }) => {
      mapDshNotification(m, sessionId, {
        push: (type, payload) => {
          pendingEvents.push({ type, payload, ts: new Date().toISOString() });
          if (type === "text") {
            const t = (payload as { text?: string }).text;
            if (t) lastText = t;
          }
        },
        setError: (msg) => {
          failReason ??= msg;
        },
        markDone: () => {
          done = true;
        },
      });
      if (pendingEvents.length >= 25) flush();
    };
    proc.subscribers.add(sub);
    return () => proc.subscribers.delete(sub);
  })();

  let done = false;
  const timer = setTimeout(() => {
    failReason ??= `timeout after ${opts.timeoutMs}ms`;
    done = true;
  }, opts.timeoutMs);

  try {
    await request(
      proc,
      "session/prompt",
      { sessionId, contentBlocks: [{ type: "text", text: opts.prompt }] },
      Math.min(opts.timeoutMs, 30000),
    );
    const waitStart = Date.now();
    while (!done && Date.now() - waitStart < opts.timeoutMs) {
      await new Promise((r) => setTimeout(r, 25));
      if (done) break;
      try {
        await request(proc, "session/wait", { sessionId }, Math.max(1000, opts.timeoutMs - (Date.now() - waitStart)));
        break;
      } catch (err) {
        if ((err as Error).message.includes("超时")) continue;
        failReason ??= (err as Error).message;
        break;
      }
    }
  } catch (err) {
    failReason ??= (err as Error).message;
  } finally {
    clearTimeout(timer);
    unsub();
  }
  if (!done && !failReason) failReason = "dsh 会话未在超时内结束";
  return finalize(failReason ? "failed" : "success");
}

/** headless NDJSON 兜底：`dsh headless --json {prompt}`，逐行事件（线界截断），退出码结算 */
export async function runDshHeadless(opts: DshRunOptions, base?: TaskRecord): Promise<TaskRecord> {
  const rec0: TaskRecord = base ?? {
    id: newTaskId(),
    harness: opts.adapter.id,
    transport: "stdio-rpc",
    prompt: opts.prompt.slice(0, 500),
    cwd: opts.cwd,
    status: "running",
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    logFile: path.join(opts.tasksDir, "headless.log"),
  };
  const argv = opts.adapter.delegate.run.map((a) =>
    a.split("{prompt}").join(opts.prompt).split("{sessionId}").join(""),
  );
  const startedMs = Date.now();
  const events: Array<{ type: string; payload: unknown; ts: string }> = [];
  let failReason: string | undefined;
  let lastText = "";
  try {
    const r = spawnSync(argv[0], argv.slice(1), {
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ...(opts.dshHome ? { DSH_HOME: opts.dshHome } : {}) },
    });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    for (const rawLine of out.split("\n")) {
      if (!rawLine.trim()) continue;
      const line = rawLine.length > MAX_LINE_CHARS ? `${rawLine.slice(0, MAX_LINE_CHARS)}…[line truncated]` : rawLine;
      let env: Record<string, unknown>;
      try {
        env = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // 非事件行（banner 等）跳过
      }
      const json = JSON.stringify(env);
      if (json.length > MAX_EVENT_CHARS) {
        events.push({ type: "status", payload: { protocol_event_truncated: true }, ts: new Date().toISOString() });
        continue;
      }
      mapDshNotification(
        { method: typeof env.method === "string" ? env.method : "session.event", params: env },
        "",
        {
          push: (type, payload) => events.push({ type, payload, ts: new Date().toISOString() }),
          setError: (msg) => {
            failReason ??= msg;
          },
          markDone: () => {},
        },
      );
      if (env.type === "text" && typeof env.text === "string") lastText = env.text;
    }
    const timedOut = r.signal === "SIGTERM";
    const status = timedOut ? "timeout" : r.status === 0 && !failReason ? "success" : "failed";
    const rec: TaskRecord = {
      ...rec0,
      status,
      exitCode: r.status ?? null,
      signal: r.signal ?? null,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      outputTail: lastText ? truncate2kb(lastText) : "",
      fallbackUsed: true,
      ...(failReason ? { failReason } : {}),
      ...(timedOut && !failReason ? { failReason: `timeout after ${opts.timeoutMs}ms` } : {}),
    };
    if (events.length) opts.ledger.addEvents(rec.id, events);
    opts.ledger.append(rec);
    notify(opts.notifyCommand, rec);
    return rec;
  } catch (err) {
    const rec: TaskRecord = {
      ...rec0,
      status: "failed",
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      fallbackUsed: true,
      failReason: `headless 执行失败: ${(err as Error).message}`,
    };
    if (events.length) opts.ledger.addEvents(rec.id, events);
    opts.ledger.append(rec);
    notify(opts.notifyCommand, rec);
    return rec;
  }
}
