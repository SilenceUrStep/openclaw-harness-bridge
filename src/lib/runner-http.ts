import { appendFileSync } from "node:fs";
import path from "node:path";
import type { Adapter } from "./adapters.js";
import { truncate2kb, type Ledger, type LedgerEventType, type TaskRecord, type TaskStatus } from "./ledger.js";
import { buildHttpHeaders, type HttpTransport } from "./transport.js";
import { newTaskId, notify } from "./runner.js";

const SSE_ACCEPT = "text/event-stream";
const EVENT_FLUSH_BATCH = 25;
const MAX_SSE_RECONNECT = 30;
/** v0.3.1：指数退避 1s/2s/4s/... 上限 30s */
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const OUTPUT_TAIL_CHARS = 2000;
/** opencode fork 端点缺省（RFC §7 delegate.fork） */
const DEFAULT_FORK_PATH = "/session/{sessionId}/fork";

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
  wait: boolean;
  timeoutMs: number;
  ledger: Ledger;
  tasksDir: string;
  notifyCommand?: string;
  fallbackUsed?: boolean;
}

/**
 * opencode HTTP 直调任务：POST /session → prompt_async → SSE /event（sessionID 过滤，
 * 断线退避重连 + /message 补拉）→ idle 结算（GET /session 读 cost/tokens）。
 * wait=true 返回终态记录；wait=false 后台执行并立即返回运行中快照。
 */
export async function runHttpTask(opts: HttpRunOptions): Promise<TaskRecord> {
  const id = newTaskId();
  const startedAt = new Date().toISOString();
  const logFile = path.join(opts.tasksDir, `${id}.log`);
  const base: TaskRecord = {
    id,
    harness: opts.adapter.id,
    transport: "http",
    prompt: opts.prompt.length > 500 ? `${opts.prompt.slice(0, 500)}…` : opts.prompt,
    cwd: opts.cwd,
    status: "running",
    pid: process.pid,
    createdAt: startedAt,
    startedAt,
    logFile,
    title: `${id}; ${opts.prompt.slice(0, 60)}`,
    ...(opts.forkFromSessionId ? { forkedFrom: opts.forkFromSessionId } : {}),
    ...(opts.fallbackUsed ? { fallbackUsed: true } : {}),
  };
  opts.ledger.append(base);
  const exec = executeHttpTask(opts, base);
  if (opts.wait) return exec;
  exec.catch(() => {}); // 失败已在 executeHttpTask 内部落台账，防止 unhandled rejection
  return { ...base };
}

async function executeHttpTask(opts: HttpRunOptions, base: TaskRecord): Promise<TaskRecord> {
  const { transport, ledger, adapter } = opts;
  const baseUrl = transport.baseUrl.replace(/\/$/, "");
  const headers = buildHttpHeaders(transport, opts.cwd);
  const jsonHeaders = { ...headers, "content-type": "application/json" };
  const startedMs = Date.now();
  const ac = new AbortController();
  const streamAc = new AbortController();

  let settled = false;
  let finished = false;
  let timedOut = false;
  let sessionId: string | null = opts.resumeSessionId ?? null;
  let lastText = "";
  let failReason: string | undefined;
  let permissionPending: { id?: string; title?: string } | null = null;
  const seenKeys = new Set<string>();
  const pendingEvents: Array<{ type: string; payload: unknown; ts: string }> = [];

  const timer = setTimeout(() => {
    timedOut = true;
    try {
      ac.abort();
      streamAc.abort();
    } catch {
      // 已 abort
    }
  }, opts.timeoutMs);

  const flush = (): void => {
    if (pendingEvents.length === 0) return;
    ledger.addEvents(base.id, pendingEvents.splice(0));
  };

  const logEvent = (e: StructuredEvent): void => {
    try {
      appendFileSync(base.logFile as string, `${JSON.stringify(e)}\n`);
    } catch {
      // 日志落盘失败不阻断
    }
  };

  const finalize = (status: TaskStatus, reason?: string, extra?: Partial<TaskRecord>): TaskRecord => {
    if (finished) return { ...base, status };
    finished = true;
    clearTimeout(timer);
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
    notify(opts.notifyCommand, rec);
    return rec;
  };

  const handleStructured = (e: StructuredEvent): void => {
    if (settled || finished) return;
    logEvent(e);
    const le = structuredToLedger(e);
    pendingEvents.push({ type: le.type, payload: le.payload, ts: e.ts });
    if (pendingEvents.length >= EVENT_FLUSH_BATCH) flush();
    if (e.kind === "text" && e.text) {
      lastText = e.text;
      if (permissionPending) {
        permissionPending = null;
        ledger.append({ ...base, sessionId, status: "running" });
      }
    } else if (e.kind === "error") {
      if (!failReason && e.error) failReason = e.error;
    } else if (e.kind === "permission") {
      if (isDeny(e.permissionResponse)) {
        failReason ??= `permission denied: ${e.permissionTitle ?? e.permissionId ?? "unknown"}`;
        permissionPending = null;
      } else {
        permissionPending = { id: e.permissionId, title: e.permissionTitle };
        ledger.append({ ...base, sessionId, status: "waiting_permission" });
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
    while (!settled && !timedOut) {
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
        if (settled || timedOut) break;
        if (streamAc.signal.aborted) break;
        if (ac.signal.aborted) break;
        if (err instanceof HttpError && [401, 403, 404].includes(err.status)) {
          return finalize("failed", `SSE 订阅失败: ${err.message}`);
        }
      }
      if (settled || timedOut) break;
      reconnects += 1;
      if (reconnects > MAX_SSE_RECONNECT) {
        return finalize("failed", "SSE 重连次数超限");
      }
      await backfill().catch(() => {});
      const delay = Math.min(BACKOFF_BASE_MS * 2 ** (reconnects - 1), BACKOFF_MAX_MS);
      await sleep(delay, ac.signal).catch(() => {});
    }

    if (timedOut) {
      return finalize("failed", `timeout after ${opts.timeoutMs}ms`);
    }
    if (settled) {
      let usage: ReturnType<typeof extractUsage> = {};
      try {
        const res = await fetch(`${baseUrl}/session/${sessionId}`, { headers, signal: ac.signal });
        if (res.ok) usage = extractUsage((await res.json()) as Record<string, unknown>);
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
    }
    return finalize("failed", "SSE 连接中断且任务未结算");
  } catch (err) {
    if ((err as Error).name === "AbortError" || ac.signal.aborted) {
      return finalize(timedOut ? "failed" : "failed", timedOut ? `timeout after ${opts.timeoutMs}ms` : "aborted");
    }
    return finalize("failed", (err as Error).message);
  }
}
