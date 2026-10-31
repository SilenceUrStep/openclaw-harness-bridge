import { appendFileSync } from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import type { Adapter } from "./adapters.js";
import {
  truncate2kb,
  type Ledger,
  type LedgerEventType,
  type TaskRecord,
  type TaskStatus,
  type TimeoutSource,
} from "./ledger.js";
import { buildHttpHeaders, type HttpTransport } from "./transport.js";
import {
  describePermission,
  fetchPendingPermissions,
  replyPermission,
  resolvePermissionAskConfig,
  type PendingPermissionRequest,
  type PermissionAskConfig,
} from "./permission.js";
import {
  buildBaseTaskRecord,
  newTaskId,
  notify,
  sendPermissionAlert,
  sendStallAlert,
  truncatePrompt,
} from "./runner.js";
import type { WakeAgentOptions } from "./wake-agent.js";

const SSE_ACCEPT = "text/event-stream";
const EVENT_FLUSH_BATCH = 25;
const MAX_SSE_RECONNECT = 30;
/** v0.3.1：指数退避 1s/2s/4s/... 上限 30s */
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const OUTPUT_TAIL_CHARS = 2000;
/** opencode fork 端点缺省（RFC §7 delegate.fork） */
const DEFAULT_FORK_PATH = "/session/{sessionId}/fork";
/** 超时两级判定默认值：SSE 静默 5 分钟核查一次，总时长兜底 2 小时 */
const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_DURATION_MS = 7_200_000;
const DEFAULT_SESSION_CHECK_RETRIES = 3;
/** 产出探测 git 命令超时 */
const OUTPUT_PROBE_TIMEOUT_MS = 10_000;

export type StructuredKind =
  | "step_start"
  | "step_finish"
  | "tool_use"
  | "text"
  | "error"
  | "status"
  | "retry"
  | "permission";

export interface StructuredEvent {
  kind: StructuredKind;
  ts: string;
  phase?: string;
  tool?: string;
  toolState?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  text?: string;
  status?: string;
  attempt?: number;
  reason?: string;
  nextAttemptAt?: string;
  permissionId?: string;
  permissionTitle?: string;
  permissionKind?: string;
  permissionResponse?: string;
  durationMs?: number;
  messageId?: string;
  sessionId?: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function truncateText(text: string, max = OUTPUT_TAIL_CHARS): string {
  return text.length > max ? `…${text.slice(-max)}` : text;
}

/** SSE 块（以空行分隔）→ {data, id}；忽略注释行与 [DONE]；id 行用于 Last-Event-ID 续传 */
export function parseSseBlock(block: string): { data: string; id?: string } | null {
  const data: string[] = [];
  let id: string | undefined;
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    else if (line.startsWith("id:")) id = line.slice(3).trim();
  }
  if (data.length === 0) return null;
  const joined = data.join("\n");
  if (!joined || joined === "[DONE]") return null;
  return { data: joined, id };
}

export function extractEventSessionId(env: Record<string, unknown>): string | undefined {
  const p = env?.properties as Record<string, unknown> | undefined;
  const part = p?.part as Record<string, unknown> | undefined;
  const info = p?.info as Record<string, unknown> | undefined;
  const perm = p?.permission as Record<string, unknown> | undefined;
  return (
    (env?.sessionID as string | undefined) ??
    (p?.sessionID as string | undefined) ??
    (part?.sessionID as string | undefined) ??
    (info?.sessionID as string | undefined) ??
    (perm?.sessionID as string | undefined)
  );
}

function messageOf(e: unknown): string | undefined {
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const m = (e as Record<string, unknown>).message;
    if (typeof m === "string") return m;
  }
  return undefined;
}

/** 会话核查状态：missing=404 不存在；error=非 404 HTTP 错误或网络失败；unknown=响应无状态字段（保守按 running 处理） */
export type SessionState = "idle" | "running" | "missing" | "error" | "unknown";

/**
 * /session/{id} 响应 → 会话状态。兼容三种形态：
 * status 字符串、status 对象 {type}（与 SSE session.status 信封同构）、time.finished 时间戳。
 * 枚举：busy/running/active/retry/working → running；idle/completed/finished/done → idle；
 * error/failed/errored → error；无字段 → unknown（保守视为 running，绝不据此杀任务）。
 */
export function parseSessionState(session: unknown): SessionState {
  if (!session || typeof session !== "object") return "unknown";
  const s = session as Record<string, unknown>;
  const status = s.status;
  const raw =
    typeof status === "string"
      ? status
      : status && typeof status === "object"
        ? ((status as Record<string, unknown>).type as string | undefined)
        : undefined;
  if (raw) {
    const v = raw.toLowerCase();
    if (["busy", "running", "active", "retry", "working"].includes(v)) return "running";
    if (["idle", "completed", "finished", "done"].includes(v)) return "idle";
    if (["error", "failed", "errored"].includes(v)) return "error";
    return "unknown";
  }
  const time = s.time as Record<string, unknown> | undefined;
  if (time && typeof time === "object" && typeof time.finished === "string") return "idle";
  return "unknown";
}

/**
 * 产出探测：cwd 下执行 git status --porcelain，非空输出即视为有未提交产出。
 * 非 git 仓库 / 命令失败 / 无 cwd 一律视为无产出，不抛错。
 */
export function probeWorkspaceOutput(cwd?: string): boolean {
  if (!cwd) return false;
  try {
    const out = execSync("git status --porcelain", {
      cwd,
      encoding: "utf8",
      timeout: OUTPUT_PROBE_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return String(out).trim().length > 0;
  } catch {
    return false;
  }
}

/** message part → 结构化事件（SSE 与 /message 补拉共用） */
export function mapPart(part: Record<string, unknown>, ts = new Date().toISOString()): StructuredEvent | null {
  const t = part?.type as string | undefined;
  if (t === "step-start" || t === "step_start") {
    return { kind: "step_start", ts, phase: "start" };
  }
  if (t === "step-finish" || t === "step_finish") {
    return { kind: "step_finish", ts, phase: "finish" };
  }
  if (t === "tool") {
    const st = (part.state ?? {}) as Record<string, unknown>;
    return {
      kind: "tool_use",
      ts,
      tool: (part.tool as string | undefined) ?? (part.name as string | undefined),
      toolState: (st.status as string | undefined) ?? (st.state as string | undefined),
      input: st.input,
      output: st.output,
      error: messageOf(st.error),
    };
  }
  if (t === "text") {
    return { kind: "text", ts, text: part.text as string | undefined };
  }
  return null;
}

/** opencode SSE 信封（{type, properties}）→ 结构化事件；未知类型返回 null */
export function mapEnvelope(env: Record<string, unknown>, ts = new Date().toISOString()): StructuredEvent | null {
  const type = env?.type as string | undefined;
  const props = (env?.properties ?? {}) as Record<string, unknown>;
  const part = props.part as Record<string, unknown> | undefined;
  if (type === "message.part.updated" || type === "message.part.updated.v2") {
    const raw = (part ?? (props.delta as Record<string, unknown> | undefined)?.part ?? {}) as Record<string, unknown>;
    const se = mapPart(raw, ts);
    if (se) {
      se.messageId = part?.messageID as string | undefined;
      se.sessionId = part?.sessionID as string | undefined;
    }
    return se;
  }
  if (type === "session.status") {
    const s = props.status as Record<string, unknown> | string | undefined;
    const statusType =
      typeof s === "string" ? s : s && typeof s === "object" ? ((s.type as string | undefined) ?? undefined) : undefined;
    if (statusType === "retry") {
      const obj = (typeof s === "object" ? s : {}) as Record<string, unknown>;
      const next = obj.next as Record<string, unknown> | string | undefined;
      const nextTime =
        typeof next === "string"
          ? next
          : next && typeof next === "object"
            ? ((next.time as string | undefined) ?? undefined)
            : undefined;
      return {
        kind: "retry",
        ts,
        status: "retry",
        attempt: typeof obj.attempt === "number" ? obj.attempt : undefined,
        reason: typeof obj.reason === "string" ? obj.reason : undefined,
        nextAttemptAt: nextTime,
      };
    }
    return { kind: "status", ts, status: statusType };
  }
  if (type === "session.idle") return { kind: "status", ts, status: "idle" };
  if (type === "session.error") {
    return { kind: "error", ts, error: messageOf(props.error) ?? messageOf(env.error) };
  }
  if (type === "permission.asked" || type === "permission.updated" || type === "permission.ask") {
    const response = (props.response ?? props.status) as string | undefined;
    return {
      kind: "permission",
      ts,
      permissionId: props.id as string | undefined,
      permissionTitle: (props.title as string | undefined) ?? (props.pattern as string | undefined),
      permissionKind: props.type as string | undefined,
      permissionResponse: typeof response === "string" ? response : undefined,
    };
  }
  if (type === "step_start" || type === "step_start.v2") return { kind: "step_start", ts, phase: "start" };
  if (type === "step_finish" || type === "step_finish.v2") return { kind: "step_finish", ts, phase: "finish" };
  if (type === "tool_use") {
    return {
      kind: "tool_use",
      ts,
      tool: (env.tool as string | undefined) ?? (props.tool as string | undefined),
      toolState: (props.state as string | undefined) ?? (props.status as string | undefined),
      input: props.input,
      output: props.output,
      error: messageOf(props.error),
    };
  }
  if (type === "text") return { kind: "text", ts, text: (env.text as string | undefined) ?? (props.text as string | undefined) };
  if (type === "error") {
    return { kind: "error", ts, error: messageOf(env.error) ?? (env.message as string | undefined) };
  }
  return null;
}

function isDeny(response?: string): boolean {
  return ["deny", "denied", "reject", "rejected", "no"].includes(String(response ?? "").toLowerCase());
}

export function structuredToLedger(e: StructuredEvent): { type: LedgerEventType; payload: unknown } {
  switch (e.kind) {
    case "step_start":
      return { type: "step", payload: { phase: "start" } };
    case "step_finish":
      return { type: "step", payload: { phase: "finish", durationMs: e.durationMs } };
    case "tool_use":
      return {
        type: "tool_use",
        payload: {
          tool: e.tool,
          state: e.toolState,
          input: typeof e.input === "string" ? truncate2kb(e.input) : e.input,
          output: typeof e.output === "string" ? truncate2kb(e.output) : e.output,
          error: e.error,
          messageId: e.messageId,
        },
      };
    case "text":
      return { type: "text", payload: { text: truncate2kb(e.text ?? ""), messageId: e.messageId } };
    case "error":
      return { type: "error", payload: { message: e.error ?? "" } };
    case "retry":
      return {
        type: "retry",
        payload: { attempt: e.attempt, reason: e.reason, nextAttemptAt: e.nextAttemptAt },
      };
    case "permission":
      return {
        type: "permission",
        payload: {
          id: e.permissionId,
          title: e.permissionTitle,
          kind: e.permissionKind,
          response: e.permissionResponse,
        },
      };
    case "status":
      return { type: "status", payload: { status: e.status } };
  }
}

/** opencode session 结算数据 → 台账聚合列 */
export function extractUsage(session: Record<string, unknown>): {
  cost?: number | null;
  tokensInput?: number | null;
  tokensOutput?: number | null;
  tokensReasoning?: number | null;
  tokensCacheRead?: number | null;
  tokensCacheWrite?: number | null;
} {
  const tokens = (session?.tokens ?? {}) as Record<string, unknown>;
  const cache = (tokens.cache ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
  return {
    cost: typeof session?.cost === "number" ? (session.cost as number) : num(tokens.cost),
    tokensInput: num(tokens.input),
    tokensOutput: num(tokens.output),
    tokensReasoning: num(tokens.reasoning),
    tokensCacheRead: num(cache.read),
    tokensCacheWrite: num(cache.write),
  };
}

async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onData: (data: string, id?: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (;;) {
        const m = /(?:\r?\n){2}/.exec(buf);
        if (!m) break;
        const block = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        const parsed = parseSseBlock(block);
        if (parsed) onData(parsed.data, parsed.id);
      }
    }
    buf += decoder.decode();
    const parsed = parseSseBlock(buf);
    if (parsed) onData(parsed.data, parsed.id);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 流可能已被取消
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

export interface HttpRunOptions {
  adapter: Adapter;
  transport: HttpTransport;
  prompt: string;
  resumeSessionId?: string;
  /** fork-before-retry：先 fork 源会话再续跑，原会话历史不被污染 */
  forkFromSessionId?: string;
  cwd?: string;
  /** v0.4.8 worktree 隔离：显式指定任务 ID（worktree 分支/目录名与之一致），缺省自动生成 */
  taskId?: string;
  wait: boolean;
  /** 旧版总时长超时（保留映射兼容）：未显式传 maxDurationMs 时作为总时长兜底 */
  timeoutMs: number;
  /** SSE 流静默核查阈值毫秒（默认 300000，0=禁用静默核查） */
  idleTimeoutMs?: number;
  /** 总时长兜底毫秒（默认 7200000，0=禁用兜底），触发后核查会话状态而非直接判失败 */
  maxDurationMs?: number;
  /** 连续会话核查仍 running 的告警阈值次数（默认 3） */
  sessionCheckMaxRetries?: number;
  /** v0.4.4 实际生效超时的来源（resolveTaskTimeout 解析结果，记台账） */
  timeoutSource?: TimeoutSource;
  /** v0.4.4 成功通知阈值毫秒：任务时长达到阈值才推成功通知；≤0 禁用（默认 300000） */
  successNotifyMinDurationMs?: number;
  /** v0.4.12 权限 ask 人工批准通道配置（enabled 默认 true，timeoutMs 挂起超时默认 30 分钟） */
  permissionAsk?: PermissionAskConfig;
  ledger: Ledger;
  tasksDir: string;
  notifyCommand?: string;
  /** v0.4.12 任务终态唤醒 agent（openclaw system event 注入）；缺省不注入 */
  wakeAgent?: WakeAgentOptions;
  fallbackUsed?: boolean;
  /** v0.4.3 后台任务终态回调（重试/降级编排用）；wait=true 不触发 */
  onFinal?: (rec: TaskRecord) => void;
}

/**
 * opencode HTTP 直调任务：POST /session → prompt_async → SSE /event（sessionID 过滤，
 * 断线退避重连 + /message 补拉）→ idle 结算（GET /session 读 cost/tokens）。
 * 超时两级判定：流静默超 idleTimeoutMs 触发会话核查（不判死，按会话真实状态分流）；
 * 总时长 maxDurationMs 兜底（核查后按会话状态结算，绝不直接 abort 判 failed）。
 * wait=true 返回终态记录；wait=false 后台执行并立即返回运行中快照。
 */
export async function runHttpTask(opts: HttpRunOptions): Promise<TaskRecord> {
  const id = opts.taskId ?? newTaskId();
  const startedAt = new Date().toISOString();
  const logFile = path.join(opts.tasksDir, `${id}.log`);
  const base: TaskRecord = {
    ...buildBaseTaskRecord({
      id,
      adapterId: opts.adapter.id,
      transport: "http",
      prompt: opts.prompt,
      cwd: opts.cwd,
      startedAt,
      logFile,
      timeoutMs: opts.timeoutMs,
      timeoutSource: opts.timeoutSource,
      fallbackUsed: opts.fallbackUsed,
    }),
    ...(opts.forkFromSessionId ? { forkedFrom: opts.forkFromSessionId } : {}),
  };
  opts.ledger.append(base);
  const exec = executeHttpTask(opts, base);
  if (opts.wait) return exec;
  exec
    .then((rec) => {
      try {
        opts.onFinal?.(rec);
      } catch {
        // 编排回调失败不影响台账
      }
    })
    .catch(() => {}); // 失败已在 executeHttpTask 内部落台账，防止 unhandled rejection
  return { ...base };
}

async function executeHttpTask(opts: HttpRunOptions, base: TaskRecord): Promise<TaskRecord> {
  const { transport, ledger, adapter } = opts;
  const baseUrl = transport.baseUrl.replace(/\/$/, "");
  const headers = buildHttpHeaders(transport, opts.cwd);
  const jsonHeaders = { ...headers, "content-type": "application/json" };
  const startedMs = Date.now();
  const ac = new AbortController();
  let streamAc = new AbortController();

  const maxDurationMs = opts.maxDurationMs ?? opts.timeoutMs ?? DEFAULT_MAX_DURATION_MS;
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const sessionCheckMaxRetries = opts.sessionCheckMaxRetries ?? DEFAULT_SESSION_CHECK_RETRIES;

  let settled = false;
  let finished = false;
  let maxFired = false;
  /** 待处理的核查请求（idle 定时器/兜底定时器打断 SSE 读循环时置位，循环顶部消费） */
  let checkCause: "idle_silence" | "max_duration" | null = null;
  let sessionId: string | null = opts.resumeSessionId ?? null;
  let lastEventAt = Date.now();
  let consecutiveRunningChecks = 0;
  let stallAlerted = false;
  let lastText = "";
  let failReason: string | undefined;
  let permissionPending: { id?: string; title?: string } | null = null;
  const seenKeys = new Set<string>();
  const pendingEvents: Array<{ type: string; payload: unknown; ts: string }> = [];

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let maxTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    if (pendingEvents.length === 0) return;
    ledger.addEvents(base.id, pendingEvents.splice(0));
  };

  /** 超时两级判定的核查过程事件（idle_triggered/session_check/...）即时落台账 */
  const trackEvent = (type: string, payload: unknown): void => {
    if (finished) return;
    pendingEvents.push({ type, payload, ts: new Date().toISOString() });
    flush();
  };

  const logEvent = (e: StructuredEvent): void => {
    try {
      appendFileSync(base.logFile as string, `${JSON.stringify(e)}\n`);
    } catch {
      // 日志落盘失败不阻断
    }
  };

  /** 核查请求：打断当前 SSE 读循环（会话核查自身用独立 controller，不受影响） */
  const requestCheck = (cause: "idle_silence" | "max_duration"): void => {
    if (settled || finished) return;
    if (cause === "idle_silence" && maxFired) return;
    if (cause === "max_duration") {
      if (maxFired) return;
      maxFired = true;
      try {
        ac.abort(); // 打断派发阶段挂起的请求，防止任务悬挂
      } catch {
        // 已 abort
      }
    }
    checkCause = cause;
    try {
      streamAc.abort();
    } catch {
      // 已 abort
    }
  };

  const armIdle = (): void => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (idleTimeoutMs <= 0) return; // 0=禁用 idle 检测
    idleTimer = setTimeout(() => {
      if (settled || finished) return;
      trackEvent("idle_triggered", {
        silentMs: idleTimeoutMs,
        lastEventAt: new Date(lastEventAt).toISOString(),
      });
      requestCheck("idle_silence");
    }, idleTimeoutMs);
  };

  /** SSE 事件活性：刷新 lastEventAt、重置连续核查计数、重挂 idle 定时器 */
  const touchActivity = (): void => {
    lastEventAt = Date.now();
    consecutiveRunningChecks = 0;
    stallAlerted = false;
    armIdle();
  };

  maxTimer = maxDurationMs > 0 ? setTimeout(() => requestCheck("max_duration"), maxDurationMs) : null;

  const finalize = (status: TaskStatus, reason?: string, extra?: Partial<TaskRecord>): TaskRecord => {
    if (finished) return { ...base, status };
    finished = true;
    if (maxTimer) clearTimeout(maxTimer);
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    try {
      streamAc.abort();
    } catch {
      // 已 abort
    }
    flush();
    const fr = reason ?? failReason;
    const rec: TaskRecord = {
      ...base,
      sessionId,
      status,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      outputTail: truncateText(lastText),
      ...(fr ? { failReason: fr } : {}),
      ...extra,
    };
    try {
      appendFileSync(
        base.logFile as string,
        `${JSON.stringify({ summary: { status, failReason: fr ?? null, durationMs: rec.durationMs } })}\n`,
      );
    } catch {
      // 日志落盘失败不阻断
    }
    ledger.append(rec);
    notify(opts.notifyCommand, rec, opts.successNotifyMinDurationMs, opts.wakeAgent);
    return rec;
  };

  const handleStructured = (e: StructuredEvent): void => {
    if (settled || finished) return;
    touchActivity();
    logEvent(e);
    const le = structuredToLedger(e);
    pendingEvents.push({ type: le.type, payload: le.payload, ts: e.ts });
    if (pendingEvents.length >= EVENT_FLUSH_BATCH) flush();
    if (e.kind === "text" && e.text) {
      lastText = e.text;
      if (permissionPending) {
        permissionPending = null;
        perm = null; // v0.4.12 会话已恢复产出，挂起权限视为已批准
        ledger.append({ ...base, sessionId, status: "running" });
      }
    } else if (e.kind === "error") {
      if (!failReason && e.error) failReason = e.error;
    } else if (e.kind === "permission") {
      if (isDeny(e.permissionResponse)) {
        failReason ??= `permission denied: ${e.permissionTitle ?? e.permissionId ?? "unknown"}`;
        permissionPending = null;
        perm = null;
      } else {
        permissionPending = { id: e.permissionId, title: e.permissionTitle };
        // v0.4.12 记录挂起起点（SSE 事件即探针），并即时触发探测补齐详情 + 推 permission_ask 告警
        if (e.permissionId && (!perm || perm.requestId !== e.permissionId)) {
          perm = {
            requestId: e.permissionId,
            title: e.permissionTitle ?? "unknown",
            askedAt: Date.now(),
            alerted: false,
            rejected: false,
          };
        }
        ledger.append({ ...base, sessionId, status: "waiting_permission" });
        void syncPermissions().catch(() => {});
      }
    } else if (e.kind === "status" && e.status === "idle") {
      settled = true;
      try {
        streamAc.abort(); // 退出 consumeSse 的阻塞读，进入结算
      } catch {
        // 已 abort
      }
    } else if ((e.kind === "step_start" || e.kind === "tool_use") && permissionPending) {
      permissionPending = null;
      perm = null; // v0.4.12 权限已批准，会话恢复执行
      ledger.append({ ...base, sessionId, status: "running" });
    }
  };

  const handleData = (data: string): void => {
    let env: Record<string, unknown>;
    try {
      env = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return; // 非法帧跳过（stdout 纯度契约同款语义）
    }
    touchActivity();
    const sid = extractEventSessionId(env);
    if (sessionId && sid && sid !== sessionId) return;
    const part = (env?.properties as Record<string, unknown> | undefined)?.part as
      | Record<string, unknown>
      | undefined;
    if (part?.id) {
      const key = String(part.id);
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
    }
    const se = mapEnvelope(env);
    if (se) handleStructured(se);
  };

  // ── v0.4.12 权限 ask 人工批准通道（OpenCode http）───────────────────────────
  // 探测/告警/超时守护全挂既有循环节拍（while 循环顶部 + permission 事件即时触发），不新增独立定时器。
  const permissionCfg = resolvePermissionAskConfig(opts.permissionAsk);
  /** 当前挂起权限（单请求模型：OpenCode 每 session 一次只阻塞一个 ask） */
  let perm: { requestId: string; title: string; askedAt: number; alerted: boolean; rejected: boolean } | null = null;

  /**
   * 权限挂起探测（fail-open）：GET /permission 按当前 session 过滤，发现新挂起请求即推
   * HB_ALERT=permission_ask（env 含 HB_REQUEST_ID/HB_PERMISSION_DETAIL；同 requestID 只推一次，
   * 60s 节流见 runner.sendPermissionAlert）。探测失败静默返回，绝不影响任务执行。
   */
  const syncPermissions = async (): Promise<void> => {
    if (!permissionCfg.enabled || settled || finished || !sessionId) return;
    let pending: PendingPermissionRequest[];
    try {
      pending = await fetchPendingPermissions(transport, { sessionId, cwd: opts.cwd });
    } catch {
      return; // 探测失败不影响任务执行（fail-open）
    }
    const cur = pending[0];
    if (!cur) return;
    if (!perm || perm.requestId !== cur.requestId) {
      perm = { requestId: cur.requestId, title: cur.permission, askedAt: Date.now(), alerted: false, rejected: false };
    }
    if (!perm.alerted) {
      perm.alerted = true;
      const detail = describePermission(cur);
      sendPermissionAlert(opts.notifyCommand, "permission_ask", {
        taskId: base.id,
        sessionId,
        requestId: cur.requestId,
        detail,
      });
      trackEvent("permission_alert", { requestId: cur.requestId, permission: cur.permission, detail });
    }
  };

  /**
   * 挂起超时守护：挂起超 permissionAsk.timeoutMs（默认 30 分钟）→ 自动 POST reject（fail-open）
   * + 推 HB_ALERT=permission_timeout。挂在 while 循环节拍上（SSE 静默期由 idle 定时器驱动节拍）。
   */
  const guardPermissionTimeout = async (): Promise<void> => {
    if (!permissionCfg.enabled || settled || finished || !sessionId) return;
    await syncPermissions(); // 顺带补探测（同 requestID 去重内建）
    if (!perm || perm.rejected || Date.now() - perm.askedAt < permissionCfg.timeoutMs) return;
    perm.rejected = true;
    let rejected = false;
    let rejectError: string | undefined;
    try {
      await replyPermission(transport, perm.requestId, "reject", { cwd: opts.cwd });
      rejected = true;
    } catch (err) {
      rejectError = (err as Error).message; // reject 失败不阻断任务（fail-open），仍推告警请人工介入
    }
    const snapshot: PendingPermissionRequest = {
      requestId: perm.requestId,
      sessionId,
      permission: perm.title,
      patterns: [],
    };
    sendPermissionAlert(opts.notifyCommand, "permission_timeout", {
      taskId: base.id,
      sessionId,
      requestId: perm.requestId,
      detail: `权限挂起超 ${permissionCfg.timeoutMs}ms 已自动${rejected ? "" : "尝试"}拒绝${
        rejectError ? `（reject 失败: ${rejectError}）` : ""
      }，请人工核查：${describePermission(snapshot)}`,
    });
    trackEvent("permission_auto_reject", {
      requestId: perm.requestId,
      permission: perm.title,
      pendingMs: Date.now() - perm.askedAt,
      rejected,
      ...(rejectError ? { error: rejectError } : {}),
    });
    permissionPending = null; // 已代为拒绝，终态结算不再记「permission.asked 未响应」
    ledger.append({ ...base, sessionId, status: "running" });
  };

  const backfill = async (): Promise<void> => {
    if (!sessionId || settled) return;
    const res = await fetch(`${baseUrl}/session/${sessionId}/message`, { headers, signal: ac.signal });
    if (!res.ok) return;
    const data = (await res.json()) as unknown;
    const messages = Array.isArray(data)
      ? data
      : Array.isArray((data as Record<string, unknown>)?.messages)
        ? ((data as Record<string, unknown>).messages as unknown[])
        : [];
    for (const m of messages) {
      const msg = (m ?? {}) as Record<string, unknown>;
      const info = (msg.info ?? {}) as Record<string, unknown>;
      const messageId = (info.id as string | undefined) ?? (msg.id as string | undefined);
      const parts = Array.isArray(msg.parts) ? (msg.parts as Record<string, unknown>[]) : [];
      parts.forEach((part, i) => {
        if (!part) return;
        const key = String(part.id ?? `${messageId}:${i}:${part.type ?? "unknown"}`);
        if (seenKeys.has(key)) return;
        seenKeys.add(key);
        const se = mapPart(part);
        if (se) {
          se.messageId = messageId ?? undefined;
          handleStructured(se);
        }
      });
    }
  };

  /** 正常结算（session.idle 或核查发现已 idle）：读 cost/tokens → success（带 failReason 时 failed） */
  const settleSuccess = async (sessionJson?: Record<string, unknown>): Promise<TaskRecord> => {
    settled = true;
    let usage: ReturnType<typeof extractUsage> = {};
    try {
      if (sessionJson) {
        usage = extractUsage(sessionJson);
      } else {
        const res = await fetch(`${baseUrl}/session/${sessionId}`, { headers, signal: ac.signal });
        if (res.ok) usage = extractUsage((await res.json()) as Record<string, unknown>);
      }
    } catch {
      // 结算读不到 session 数据不阻断终态写入
    }
    if (permissionPending && !failReason) {
      const pending = permissionPending as { id?: string; title?: string };
      failReason = `permission.asked 未响应: ${pending.title ?? pending.id ?? "unknown"}`;
    }
    const extra: Partial<TaskRecord> = {
      ...usage,
      ...(usage.cost != null ? { costTotal: usage.cost } : {}),
      ...(usage.tokensInput != null ? { costInputTokens: usage.tokensInput } : {}),
      ...(usage.tokensOutput != null ? { costOutputTokens: usage.tokensOutput } : {}),
      ...(usage.tokensReasoning != null ? { costReasoningTokens: usage.tokensReasoning } : {}),
      ...(usage.tokensCacheRead != null ? { costCacheReadTokens: usage.tokensCacheRead } : {}),
    };
    return finalize(failReason ? "failed" : "success", undefined, extra);
  };

  /**
   * 会话核查（两级判定核心）：GET /session/{id} 按真实状态分流，绝不直接判死。
   * 返回 null = 会话仍存活，调用方重挂 SSE 继续观察；否则已落终态并返回记录。
   */
  const runSessionCheck = async (cause: "idle_silence" | "max_duration"): Promise<TaskRecord | null> => {
    if (finished) return null;
    if (!sessionId) {
      // 会话尚未创建（兜底在派发阶段触发）：无会话可查，直接按总时长兜底落终态
      return cause === "max_duration" ? finalize("timeout", `timeout after ${maxDurationMs}ms`) : null;
    }
    trackEvent("session_check", { cause, sessionId });
    const checkAc = new AbortController();
    let state: SessionState = "error";
    let httpStatus: number | undefined;
    let sessionJson: Record<string, unknown> | undefined;
    try {
      const res = await fetch(`${baseUrl}/session/${sessionId}`, { headers, signal: checkAc.signal });
      httpStatus = res.status;
      if (res.ok) {
        sessionJson = (await res.json()) as Record<string, unknown>;
        state = parseSessionState(sessionJson);
      } else {
        state = res.status === 404 ? "missing" : "error";
      }
    } catch {
      state = "error"; // 网络失败按「报错」分支处理，产出探测兜底
    }
    if (cause === "idle_silence" && maxFired) return null; // 核查期间总时长兜底已触发，交由 max 流程结算

    if (state === "idle") {
      // idle 事件在断线窗口丢失：补走正常结算
      trackEvent("session_settled", { cause, sessionId });
      return await settleSuccess(sessionJson);
    }
    if (state === "missing" || state === "error") {
      const hasOutput = probeWorkspaceOutput(opts.cwd);
      trackEvent("output_detected", { hasOutput, state, httpStatus: httpStatus ?? null });
      const detail =
        state === "missing"
          ? `会话不存在（GET /session/${sessionId} → HTTP ${httpStatus}）`
          : `会话核查失败（GET /session/${sessionId} → ${httpStatus ? `HTTP ${httpStatus}` : "连接失败"}）`;
      const reason = hasOutput ? `${detail}；工作区有未提交产出，建议核查而非重派` : detail;
      return finalize("failed", reason, { hasOutput });
    }
    // running / unknown：会话仍存活
    consecutiveRunningChecks += 1;
    trackEvent("session_still_running", { cause, consecutive: consecutiveRunningChecks });
    if (cause === "max_duration") {
      const hasOutput = probeWorkspaceOutput(opts.cwd);
      trackEvent("output_detected", { hasOutput });
      return finalize("timeout", `timeout after ${maxDurationMs}ms`, { hasOutput });
    }
    if (consecutiveRunningChecks >= sessionCheckMaxRetries && !stallAlerted) {
      stallAlerted = true;
      sendStallAlert(
        opts.notifyCommand,
        base.id,
        sessionId,
        `SSE 静默 ${idleTimeoutMs}ms，连续 ${consecutiveRunningChecks} 次会话核查仍 running，请人工介入`,
      );
    }
    return null; // 重挂 SSE（Last-Event-ID 续传 + /message 补拉）继续观察
  };

  try {
    if (opts.forkFromSessionId) {
      const forkTemplate =
        (adapter.delegate as { fork?: string | { path?: string } } | undefined)?.fork ?? undefined;
      const forkCfg =
        typeof forkTemplate === "string" ? { path: forkTemplate } : (forkTemplate ?? undefined);
      const forkPath = (forkCfg?.path ?? DEFAULT_FORK_PATH).replace(
        "{sessionId}",
        opts.forkFromSessionId,
      );
      const res = await fetch(`${baseUrl}${forkPath}`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ title: base.title }),
        signal: ac.signal,
      });
      if (!res.ok) throw new HttpError(res.status, `POST ${forkPath} → HTTP ${res.status}`);
      const data = (await res.json()) as Record<string, unknown>;
      const forked = (data?.id as string | undefined) ?? ((data?.session as Record<string, unknown>)?.id as string | undefined);
      if (!forked) throw new Error(`POST ${forkPath} 响应缺少 id`);
      sessionId = forked;
      ledger.append({ ...base, sessionId });
    } else if (!opts.resumeSessionId) {
      const res = await fetch(`${baseUrl}/session`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ title: base.title }),
        signal: ac.signal,
      });
      if (!res.ok) throw new HttpError(res.status, `POST /session → HTTP ${res.status}`);
      const data = (await res.json()) as Record<string, unknown>;
      const created = (data?.id as string | undefined) ?? ((data?.session as Record<string, unknown>)?.id as string | undefined);
      if (!created) throw new Error("POST /session 响应缺少 id");
      sessionId = created;
      ledger.append({ ...base, sessionId });
    } else {
      ledger.append({ ...base, sessionId });
    }

    const promptRes = await fetch(`${baseUrl}/session/${sessionId}/prompt_async`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ parts: [{ type: "text", text: opts.prompt }] }),
      signal: ac.signal,
    });
    if (!promptRes.ok) {
      throw new HttpError(promptRes.status, `POST /session/${sessionId}/prompt_async → HTTP ${promptRes.status}`);
    }

    let reconnects = 0;
    let lastEventId: string | undefined;
    armIdle();
    while (!settled && !maxFired) {
      // v0.4.12 权限挂起守护：复用循环节拍检查挂起超时（SSE 静默期由 idle 定时器驱动节拍，不新增定时器）
      await guardPermissionTimeout().catch(() => {});
      // 核查分流：idle/兜底定时器置位的核查请求统一在循环顶部消费
      if (checkCause === "max_duration") {
        const rec = await runSessionCheck("max_duration");
        if (rec) return rec;
        break;
      }
      if (checkCause === "idle_silence") {
        checkCause = null;
        const rec = await runSessionCheck("idle_silence");
        if (rec) return rec;
        if (maxFired || settled || finished) break;
        // 会话仍存活：重挂 SSE（Last-Event-ID 续传 + /message 补拉）继续观察
        reconnects = 0;
        streamAc = new AbortController();
        await backfill().catch(() => {});
        armIdle();
        continue;
      }
      try {
        const res = await fetch(`${baseUrl}/event`, {
          headers: {
            ...headers,
            accept: SSE_ACCEPT,
            ...(lastEventId ? { "last-event-id": lastEventId } : {}),
          },
          signal: streamAc.signal,
        });
        if (!res.ok || !res.body) throw new HttpError(res.status, `SSE /event → HTTP ${res.status}`);
        reconnects = 0;
        await consumeSse(res.body, (data, id) => {
          if (id) lastEventId = id;
          handleData(data);
        });
      } catch (err) {
        if (settled || finished) break;
        if (ac.signal.aborted) break;
        if (err instanceof HttpError && [401, 403, 404].includes(err.status)) {
          return finalize("failed", `SSE 订阅失败: ${err.message}`);
        }
      }
      if (settled || finished) break;
      if (checkCause) continue;
      reconnects += 1;
      if (reconnects > MAX_SSE_RECONNECT) {
        return finalize("failed", "SSE 重连次数超限");
      }
      await backfill().catch(() => {});
      const delay = Math.min(BACKOFF_BASE_MS * 2 ** (reconnects - 1), BACKOFF_MAX_MS);
      await sleep(delay, ac.signal).catch(() => {});
    }

    if (settled && !finished) return await settleSuccess();
    if (maxFired && !finished) {
      const rec = await runSessionCheck("max_duration");
      if (rec) return rec;
    }
    if (!finished) return finalize("failed", "SSE 连接中断且任务未结算");
    return { ...base, status: "running" };
  } catch (err) {
    if ((err as Error).name === "AbortError" || ac.signal.aborted) {
      if (maxFired) {
        const rec = await runSessionCheck("max_duration");
        if (rec) return rec;
        return finalize("timeout", `timeout after ${maxDurationMs}ms`);
      }
      return finalize("failed", "aborted");
    }
    return finalize("failed", (err as Error).message);
  }
}
