import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { checkHealth, type Adapter } from "./adapters.js";
import { truncate2kb, type Ledger, type LedgerEventType, type TaskRecord, type TimeoutSource } from "./ledger.js";
import { buildBaseTaskRecord, newTaskId, notify, sendStallAlert, timestampId } from "./runner.js";
import { checkVersionGate } from "./transport.js";
import type { WakeAgentOptions } from "./wake-agent.js";

/** RFC §4.1 事件线界：单行 8KB / 单事件 32KB，超限截断并带标记 */
const MAX_LINE_CHARS = 8 * 1024;
const MAX_EVENT_CHARS = 32 * 1024;

/** v0.4.4 进程判定器单次 RPC 探活的超时（短探针，不占用任务预算） */
const PROBE_TIMEOUT_MS = 2000;

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
  /** v0.4.8 worktree 隔离：显式指定任务 ID（worktree 分支/目录名与之一致），缺省自动生成 */
  taskId?: string;
  /** DSH_HOME 隔离目录（绝不碰用户交互式 ~/.dsh） */
  dshHome?: string;
  wait: boolean;
  timeoutMs: number;
  /** v0.4.4 实际生效超时的来源（resolveTaskTimeout 解析结果，记台账） */
  timeoutSource?: TimeoutSource;
  /** v0.4.4 成功通知阈值毫秒：任务时长达到阈值才推成功通知；≤0 禁用（默认 300000） */
  successNotifyMinDurationMs?: number;
  /** v0.4.4 进程判定器：连续探活无响应的告警阈值次数（默认 3，与 http sessionCheckMaxRetries 同语义） */
  sessionCheckMaxRetries?: number;
  /** v0.4.4 测试钩子：两次探活的间隔毫秒（默认 5000） */
  checkIntervalMs?: number;
  ledger: Ledger;
  tasksDir: string;
  notifyCommand?: string;
  /** v0.4.12 任务终态唤醒 agent（openclaw system event 注入）；缺省不注入 */
  wakeAgent?: WakeAgentOptions;
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
  return timestampId("dsh", 6);
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
  const id = opts.taskId ?? newTaskId();
  const startedAt = new Date().toISOString();
  const logFile = path.join(opts.tasksDir, `${id}.log`);
  const base: TaskRecord = buildBaseTaskRecord({
    id,
    adapterId: opts.adapter.id,
    transport: "stdio-rpc",
    prompt: opts.prompt,
    cwd: opts.cwd,
    startedAt,
    logFile,
    timeoutMs: opts.timeoutMs,
    timeoutSource: opts.timeoutSource,
    fallbackUsed: opts.fallbackUsed,
  });
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

/**
 * v0.4.4 进程判定器的存活视图（窄接口，测试可直接构造假实现）：
 * dsh 是进程型（stdio-rpc），判定信号源 = 进程退出码（权威）+ RPC 探活响应。
 * 与 runner-http 的会话核查判定器（GET /session 分流）并列，runner 层只按 transport 调度。
 */
export interface DshProcessView {
  /** 进程是否已退出（exit 回调置位） */
  closed: boolean;
  /** 退出码（未退出为 null；被信号杀死时 exitCode 为 null，需看 signal） */
  exitCode: number | null;
  /** RPC 探活：session/wait 短探针（返回 = 会话已结束；reject 超时 = 无响应） */
  probe: (timeoutMs: number) => Promise<unknown>;
}

/** 从常驻 DshProc 构造存活视图 */
export function dshProcessView(p: DshProc, sessionId: string): DshProcessView {
  return {
    get closed() {
      return p.closed;
    },
    get exitCode() {
      return p.child.exitCode;
    },
    probe: (timeoutMs) => request(p, "session/wait", { sessionId }, timeoutMs),
  };
}

export interface DshAdjudicateDeps {
  view: DshProcessView;
  sessionId: string;
  taskId: string;
  /** 触发判定的总时长超时值（failReason 语义沿用） */
  timeoutMs: number;
  ledger: Ledger;
  notifyCommand?: string;
  sessionCheckMaxRetries?: number;
  checkIntervalMs?: number;
  finalize: (status: TaskRecord["status"], reason?: string) => TaskRecord;
}

/**
 * v0.4.4 dsh 进程判定器（超时触发，绝不直接判 failed）：
 * ① 进程已退 → 按退出码结算（0=success，非 0=failed）；
 * ② 进程还在 → session/wait 探活：有响应（恢复响应）→ 会话已结束，正常结算 success；
 *    非超时类 rpc 错误 → 按 rpc 业务错误结算 failed；
 *    连续 N 次（sessionCheckMaxRetries，默认 3）无响应 → 标记 stalled 并告警
 *    （不自动杀进程，人工介入），结算 timeout。
 */
export async function adjudicateDshTimeout(deps: DshAdjudicateDeps): Promise<TaskRecord> {
  const maxRetries = deps.sessionCheckMaxRetries ?? 3;
  const intervalMs = deps.checkIntervalMs ?? 5000;
  const track = (type: LedgerEventType, payload: unknown): void => {
    try {
      deps.ledger.addEvents(deps.taskId, [{ type, payload, ts: new Date().toISOString() }]);
    } catch {
      // 事件台账失败不影响结算
    }
  };
  // ① 进程已退 → 退出码权威
  if (deps.view.closed) {
    const code = deps.view.exitCode;
    track("session_check", { judge: "process", alive: false, exitCode: code });
    track("session_settled", { outcome: code === 0 ? "success" : "failed", exitCode: code });
    return deps.finalize(
      code === 0 ? "success" : "failed",
      code === 0 ? undefined : `dsh sdk 进程已退出（exit=${code ?? "?"}）`,
    );
  }
  // ② 进程存活 → RPC 探活分流
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    track("session_check", { judge: "process", alive: true, attempt, maxRetries });
    try {
      await deps.view.probe(PROBE_TIMEOUT_MS);
      // 恢复响应：session/wait 返回 = 会话已结束，正常结算
      track("session_settled", { outcome: "success", probe: "responsive", attempt });
      return deps.finalize("success");
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (!msg.includes("超时")) {
        // rpc 业务错误（协议错误等）→ failed
        track("session_settled", { outcome: "failed", error: msg, attempt });
        return deps.finalize("failed", msg);
      }
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    }
  }
  const detail = `dsh 进程存活但 RPC 连续 ${maxRetries} 次探活无响应（会话 ${deps.sessionId}），疑似 stalled，需人工介入（进程未终止）`;
  sendStallAlert(deps.notifyCommand, deps.taskId, deps.sessionId, detail);
  track("session_still_running", { judge: "process", stalled: true, maxRetries });
  return deps.finalize("timeout", `${detail}；timeout after ${deps.timeoutMs}ms`);
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
    notify(opts.notifyCommand, rec, opts.successNotifyMinDurationMs, opts.wakeAgent);
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
  let timeoutFired = false;
  const timer = setTimeout(() => {
    timeoutFired = true;
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
    const msg = (err as Error).message;
    // v0.4.4：超时触发时的 rpc 超时/进程退出错误交给进程判定器统一分流，不抢先定因
    if (!timeoutFired || (!msg.includes("超时") && !msg.includes("已退出"))) {
      failReason ??= msg;
    }
  } finally {
    clearTimeout(timer);
    unsub();
  }

  // v0.4.4 dsh 进程判定器：超时触发时先查进程存活，按真实状态分流（不直接判 failed）
  if (timeoutFired && !failReason) {
    return adjudicateDshTimeout({
      view: dshProcessView(proc, sessionId),
      sessionId,
      taskId: base.id,
      timeoutMs: opts.timeoutMs,
      ledger: opts.ledger,
      notifyCommand: opts.notifyCommand,
      sessionCheckMaxRetries: opts.sessionCheckMaxRetries,
      checkIntervalMs: opts.checkIntervalMs,
      finalize,
    });
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
  let rec: TaskRecord;
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
    rec = {
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
  } catch (err) {
    rec = {
      ...rec0,
      status: "failed",
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      fallbackUsed: true,
      failReason: `headless 执行失败: ${(err as Error).message}`,
    };
  }
  // 统一收口：事件落台账 + 终态回写 + 通知（成功/异常两分支共用）
  if (events.length) opts.ledger.addEvents(rec.id, events);
  opts.ledger.append(rec);
  notify(opts.notifyCommand, rec, opts.successNotifyMinDurationMs, opts.wakeAgent);
  return rec;
}
