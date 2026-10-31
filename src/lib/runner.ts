import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Adapter } from "./adapters.js";
import type { Ledger, TaskRecord, TaskStatus, TimeoutSource, WorkspaceSource } from "./ledger.js";
import { classifyFailure, failureAdvice } from "./resilience.js";

/** v0.4.7 时间戳 id 生成（taskId / dsh sessionId 共用）：hb_20260101T000000Z_ab12 */
export function timestampId(prefix: string, randLen = 4, now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  return `${prefix}_${ts}_${Math.random().toString(36).slice(2, 2 + randLen)}`;
}

export function newTaskId(now: Date = new Date()): string {
  return timestampId("hb", 4, now);
}

/** v0.4.7 prompt 截断共用（台账 prompt 列 500 字符封顶） */
export function truncatePrompt(prompt: string): string {
  return prompt.length > 500 ? `${prompt.slice(0, 500)}…` : prompt;
}

/** argv 模板占位替换（整段或内嵌 {prompt}/{sessionId}）；argv 数组避免 shell 注入 */
export function fillTemplate(argv: string[], vars: Record<string, string>): string[] {
  return argv.map((a) => {
    let out = a;
    for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(v);
    return out;
  });
}

export function extractSessionId(text: string, pattern?: string): string | null {
  if (!pattern) return null;
  try {
    const matches = text.match(new RegExp(pattern, "g"));
    return matches && matches.length > 0 ? matches[matches.length - 1] : null;
  } catch {
    return null; // 非法 pattern 不阻断主流程
  }
}

export function tailFile(file: string, maxChars = 2000): string {
  try {
    const content = readFileSync(file, "utf8");
    return content.length > maxChars ? `…${content.slice(-maxChars)}` : content;
  } catch {
    return "";
  }
}

export interface RunOptions {
  adapter: Adapter;
  prompt: string;
  resumeSessionId?: string;
  cwd?: string;
  /** v0.4.8 worktree 隔离：显式指定任务 ID（worktree 分支/目录名与之一致），缺省自动生成 */
  taskId?: string;
  wait: boolean;
  timeoutMs: number;
  /** v0.4.4 实际生效超时的来源（resolveTaskTimeout 解析结果，记台账） */
  timeoutSource?: TimeoutSource;
  /** v0.4.4 成功通知阈值毫秒：任务时长达到阈值才推成功通知；≤0 禁用（默认 300000） */
  successNotifyMinDurationMs?: number;
  ledger: Ledger;
  tasksDir: string;
  notifyCommand?: string;
  /** v0.4.3 后台任务终态回调（重试/降级编排用）；wait=true 不触发 */
  onFinal?: (rec: TaskRecord) => void;
}

/** v0.4.4 内置 taskType 默认超时（毫秒）：coding 45 分钟，其余 10 分钟 */
export const TASK_TYPE_DEFAULT_TIMEOUT_MS: Record<string, number> = {
  coding: 2_700_000,
  general: 600_000,
  analysis: 600_000,
  search: 600_000,
};

export interface ResolvedTimeout {
  timeoutMs: number;
  source: TimeoutSource;
}

/**
 * v0.4.4 统一超时解析（各 transport 共用，治「漏传 timeoutMs 被默认 600s 掐」）。
 * 优先级：显式 params.timeoutMs > taskType 显式配置（defaultTimeoutByTaskType）>
 * http 全局兜底配置（timeouts.maxDurationMs，v0.4.3 兼容）> 内置 taskType 默认 >
 * 全局 defaultTimeoutMs / 600000。taskType 未知时落到全局默认。
 */
export function resolveTaskTimeout(input: {
  explicitTimeoutMs?: number;
  taskType?: string;
  defaultTimeoutMs?: number;
  defaultTimeoutByTaskType?: Record<string, number>;
  maxDurationMs?: number;
  isHttp?: boolean;
}): ResolvedTimeout {
  if (input.explicitTimeoutMs != null) {
    return { timeoutMs: input.explicitTimeoutMs, source: "explicit" };
  }
  if (input.taskType) {
    const perType = input.defaultTimeoutByTaskType?.[input.taskType];
    if (perType != null) return { timeoutMs: perType, source: "taskType_default" };
  }
  if (input.isHttp && input.maxDurationMs != null) {
    return { timeoutMs: input.maxDurationMs, source: "global_default" };
  }
  if (input.taskType) {
    const builtin = TASK_TYPE_DEFAULT_TIMEOUT_MS[input.taskType];
    if (builtin != null) return { timeoutMs: builtin, source: "taskType_default" };
  }
  return { timeoutMs: input.defaultTimeoutMs ?? 600_000, source: "global_default" };
}

/** 任务记录回写实际生效超时（cli/dsh/http 共用的 base 字段片段） */
export function timeoutRecordFields(
  timeoutMs: number,
  source?: TimeoutSource,
): Pick<TaskRecord, "timeoutMs" | "timeoutSource"> {
  return {
    timeoutMs,
    ...(source ? { timeoutSource: source } : {}),
  };
}

/**
 * v0.4.7 http / stdio-rpc runner 共用的 running 快照基记录（进程型 transport：
 * pid = 网关进程号，cli runner 的 spawn 子进程语义不同，不共用）。
 */
export function buildBaseTaskRecord(input: {
  id: string;
  adapterId: string;
  transport: TaskRecord["transport"];
  prompt: string;
  cwd?: string;
  startedAt: string;
  logFile: string;
  timeoutMs: number;
  timeoutSource?: TimeoutSource;
  fallbackUsed?: boolean;
}): TaskRecord {
  return {
    id: input.id,
    harness: input.adapterId,
    transport: input.transport,
    prompt: truncatePrompt(input.prompt),
    cwd: input.cwd,
    status: "running",
    pid: process.pid,
    createdAt: input.startedAt,
    startedAt: input.startedAt,
    logFile: input.logFile,
    title: `${input.id}; ${input.prompt.slice(0, 60)}`,
    ...timeoutRecordFields(input.timeoutMs, input.timeoutSource),
    ...(input.fallbackUsed ? { fallbackUsed: true } : {}),
  };
}

/**
 * v0.4.4 工作区三级解析：显式 cwd > globalWorkspace 兜底 > serve 进程默认（undefined）。
 * 语义反转：编码任务默认在目标项目文件夹，不再兜底插件数据目录。
 */
export function resolveWorkspace(
  explicitCwd?: string,
  globalWorkspace?: string,
): { cwd?: string; source: WorkspaceSource } {
  const explicit = explicitCwd?.trim() ? explicitCwd.trim() : undefined;
  const global = globalWorkspace?.trim() ? globalWorkspace.trim() : undefined;
  if (explicit) return { cwd: explicit, source: "explicit" };
  if (global) return { cwd: global, source: "globalWorkspace" };
  return { cwd: undefined, source: "serve_default" };
}

/** v0.4.4 成功通知阈值默认 5 分钟（短于阈值的成功维持静默） */
export const DEFAULT_SUCCESS_NOTIFY_MIN_MS = 300_000;

/** 时长人性化（成功通知用）：1h2m3s / 2m3s / 3s */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

/**
 * v0.4.7 摘要模式：一行一任务（taskId / harness / 状态 / 耗时 / 成本），方便人扫读。
 * running 任务无 durationMs 时按 startedAt 计算已运行时长；成本显示 cost 与 token 合计（缺失显示 —）。
 */
export function formatTaskLine(rec: TaskRecord): string {
  const durMs =
    rec.durationMs ??
    (rec.startedAt ? Date.now() - Date.parse(rec.startedAt) : null);
  const dur =
    durMs != null && Number.isFinite(durMs) && durMs >= 0 ? formatDuration(durMs) : "—";
  const cost = rec.costTotal ?? rec.cost;
  const tokens = totalTokens(rec);
  const costParts: string[] = [];
  if (cost != null) costParts.push(`cost ${cost}`);
  if (tokens != null) costParts.push(`${tokens} tok`);
  return [
    rec.id,
    rec.harness,
    rec.status,
    `耗时 ${dur}`,
    costParts.length > 0 ? costParts.join(" / ") : "成本 —",
  ].join(" ｜ ");
}

function buildArgv(opts: RunOptions): string[] {
  const d = opts.adapter.delegate;
  const template =
    opts.resumeSessionId && Array.isArray(d.resume) && d.resume.length > 0 ? d.resume : d.run;
  return fillTemplate(template, { prompt: opts.prompt, sessionId: opts.resumeSessionId ?? "" });
}

function finalize(
  base: TaskRecord,
  status: TaskStatus,
  exitCode: number | null,
  signal: string | null,
  startedMs: number,
  sessionId: string | null,
  logFile: string,
  error?: string,
): TaskRecord {
  return {
    ...base,
    status,
    exitCode,
    signal,
    sessionId,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    outputTail: tailFile(logFile),
    ...(error ? { error } : {}),
  };
}

/**
 * v0.4.1 失败告警节流：per-harness 滑动窗口，窗口内同 harness 只推一条，
 * 被抑制的失败计数并入下一条通知（防批量任务失败时的微信轰炸）。
 * v0.4.7 信息保全：被抑制告警同时攒 taskId 列表（上限 SUPPRESSED_IDS_CAP，
 * 超出只记条数），随下一条告警列出（HB_SUPPRESSED_IDS），发出后清空。
 */
const NOTIFY_WINDOW_MS = 60_000;
const SUPPRESSED_IDS_CAP = 20;
const notifyState = new Map<
  string,
  { lastTs: number; suppressed: number; suppressedIds: string[] }
>();

export function resetNotifyThrottle(): void {
  notifyState.clear();
}

/** v0.4.4 成功通知去重：同一任务只发一次 */
const successNotified = new Set<string>();

/** 成功通知的 tokens 合计（input+output+reasoning，有任一字段才输出） */
function totalTokens(rec: TaskRecord): number | null {
  const fields = [rec.tokensInput, rec.tokensOutput, rec.tokensReasoning];
  if (fields.every((v) => v == null)) return null;
  return fields.reduce<number>((sum, v) => sum + (v ?? 0), 0);
}

/** v0.4.4 长任务成功通知：单次尝试、不参与失败节流、同一任务只发一次 */
function notifySuccess(notifyCommand: string, rec: TaskRecord): void {
  if (successNotified.has(rec.id)) return;
  successNotified.add(rec.id);
  const tokens = totalTokens(rec);
  const env = {
    ...process.env,
    HB_ALERT: "task_success",
    HB_TASK_ID: rec.id,
    HB_HARNESS: rec.harness,
    HB_DURATION: formatDuration(rec.durationMs ?? 0),
    ...(tokens != null ? { HB_COST_TOKENS: String(tokens) } : {}),
    HB_TIME: new Date().toISOString(),
  };
  try {
    spawnSync("bash", ["-c", notifyCommand], { timeout: 15000, encoding: "utf8", env });
  } catch {
    // 成功通知失败不重试（非关键路径）
  }
}

export function notify(
  notifyCommand: string | undefined,
  rec: TaskRecord,
  successNotifyMinDurationMs?: number,
): void {
  if (!notifyCommand) return;
  // v0.4.4 成功通知：任务时长 ≥ 阈值（默认 5 分钟）才推，≤0 禁用
  if (rec.status === "success") {
    const minMs = successNotifyMinDurationMs ?? DEFAULT_SUCCESS_NOTIFY_MIN_MS;
    if (minMs <= 0) return;
    if ((rec.durationMs ?? 0) < minMs) return;
    notifySuccess(notifyCommand, rec);
    return;
  }
  // 失败/超时终态通知（60s 节流见下）
  const now = Date.now();
  const key = rec.harness;
  const st = notifyState.get(key);
  if (st && now - st.lastTs < NOTIFY_WINDOW_MS) {
    st.suppressed += 1;
    if (st.suppressedIds.length < SUPPRESSED_IDS_CAP) st.suppressedIds.push(rec.id);
    return; // 窗口内已通知过该 harness，抑制本次
  }
  const suppressed = st?.suppressed ?? 0;
  const suppressedIds = st?.suppressedIds ?? [];
  notifyState.set(key, { lastTs: now, suppressed: 0, suppressedIds: [] });
  // v0.4.3 超时类失败（failReason 含 timeout）告警附建议：任务过大请拆分
  const advice = failureAdvice(classifyFailure(rec));
  const env = {
    ...process.env,
    HB_TASK_ID: rec.id,
    HB_HARNESS: rec.harness,
    HB_STATUS: rec.status,
    HB_EXIT_CODE: String(rec.exitCode ?? ""),
    HB_SESSION_ID: rec.sessionId ?? "",
    HB_LOG_FILE: rec.logFile ?? "",
    HB_FAIL_REASON: rec.failReason ?? "",
    ...(suppressed > 0
      ? {
          HB_SUPPRESSED: String(suppressed),
          ...(suppressedIds.length > 0 ? { HB_SUPPRESSED_IDS: suppressedIds.join(", ") } : {}),
        }
      : {}),
    ...(advice ? { HB_ADVICE: advice } : {}),
    ...(rec.hasOutput === true ? { HB_HAS_OUTPUT: "1" } : {}),
  };
  // v0.4.2 送达兜底：微信每20分钟重连窗口(:02/:22/:42)内发送必失败，
  // 失败告警自身不能静默丢失，重试穿透（最多3次尝试，间隔3s）
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = spawnSync("bash", ["-c", notifyCommand], {
        timeout: 15000,
        encoding: "utf8",
        env,
      });
      if (r.status === 0 && !r.error) return; // 送达成功
    } catch {
      // 重试
    }
    if (attempt < 3) syncSleep(3000);
  }
}

/** 同步等待（child exit 回调内无异步上下文，Atomics.wait 标准用法） */
function syncSleep(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // 平台不支持时退化为继续（不阻塞主流程）
  }
}

/**
 * 任务停滞告警（v0.4.4 自 runner-http 收口至此，cli/dsh/http 共用）：
 * spawn fire-and-forget（同 watchdog 告警通道；任务未终态，不走 notify 节流）。
 */
export function sendStallAlert(
  notifyCommand: string | undefined,
  taskId: string,
  sessionId: string,
  detail: string,
): void {
  if (!notifyCommand) return;
  try {
    const child = spawn("bash", ["-c", notifyCommand], {
      env: {
        ...process.env,
        HB_ALERT: "task_stall",
        HB_TASK_ID: taskId,
        HB_SESSION_ID: sessionId,
        HB_DETAIL: detail.length > 800 ? `${detail.slice(0, 800)}…` : detail,
        HB_TIME: new Date().toISOString(),
      },
      stdio: "ignore",
    });
    child.unref?.();
  } catch {
    // 告警失败不影响观察
  }
}

/**
 * v0.4.12 权限 ask 告警（permission_ask / permission_timeout，OpenCode http 任务）：
 * spawn fire-and-forget（同 stall 告警通道）；permission_ask 60s 节流窗口与既有告警一致，
 * 同一 requestID 只推一次（内存 Set 去重；窗口内被节流的 request 不标记，待下个轮询节拍补推）；
 * permission_timeout 每requestID仅一次且豁免节流（安全关键：自动拒绝必须告知人工）。
 */
const PERMISSION_ALERT_WINDOW_MS = 60_000;
const permissionAlertSeen = new Set<string>();
let permissionAlertLastTs = 0;

/** 供测试重置去重与节流状态 */
export function resetPermissionAlerts(): void {
  permissionAlertSeen.clear();
  permissionAlertLastTs = 0;
}

export function sendPermissionAlert(
  notifyCommand: string | undefined,
  alert: "permission_ask" | "permission_timeout",
  info: { taskId: string; sessionId?: string; requestId: string; detail: string },
): void {
  if (!notifyCommand) return;
  // 去重键 = 告警类型:requestID —— 同一 requestID 的 permission_ask 只推一次，
  // 且不吞掉后续 permission_timeout（不同告警类型，语义不同需分别告知）
  const dedupKey = `${alert}:${info.requestId}`;
  if (permissionAlertSeen.has(dedupKey)) return;
  const now = Date.now();
  // permission_timeout 豁免节流窗口：每 requestID 仅一次（dedupKey 已去重），且属安全关键通知
  // （自动拒绝需告知人工），不参与 60s 滑窗；permission_ask 与既有告警一致按 60s 节流
  if (alert !== "permission_timeout" && now - permissionAlertLastTs < PERMISSION_ALERT_WINDOW_MS) return;
  permissionAlertSeen.add(dedupKey);
  permissionAlertLastTs = now;
  try {
    const child = spawn("bash", ["-c", notifyCommand], {
      env: {
        ...process.env,
        HB_ALERT: alert,
        HB_TASK_ID: info.taskId,
        HB_SESSION_ID: info.sessionId ?? "",
        HB_REQUEST_ID: info.requestId,
        HB_PERMISSION_DETAIL: info.detail.length > 800 ? `${info.detail.slice(0, 800)}…` : info.detail,
        HB_TIME: new Date().toISOString(),
      },
      stdio: "ignore",
    });
    child.unref?.();
  } catch {
    // 告警失败不影响任务执行
  }
}

/** 执行任务：wait=true 同步等待；wait=false 后台执行（退出后回写台账 + 可选通知） */
export function runTask(opts: RunOptions): TaskRecord {
  const argv = buildArgv(opts);
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const id = opts.taskId ?? newTaskId();
  const logFile = path.join(opts.tasksDir, `${id}.log`);
  const base: TaskRecord = {
    id,
    harness: opts.adapter.id,
    prompt: truncatePrompt(opts.prompt),
    cwd: opts.cwd,
    status: "running",
    startedAt,
    logFile,
    ...timeoutRecordFields(opts.timeoutMs, opts.timeoutSource),
  };
  opts.ledger.append(base);

  if (opts.wait) {
    const r = spawnSync(argv[0], argv.slice(1), {
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
      encoding: "utf8",
    });
    const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    try {
      appendFileSync(logFile, output);
    } catch {
      // 日志落盘失败不阻断
    }
    const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || r.signal === "SIGTERM";
    const status: TaskStatus = timedOut
      ? "timeout"
      : r.error
        ? "failed"
        : r.status === 0
          ? "success"
          : "failed";
    const rec = finalize(
      base,
      status,
      r.status ?? null,
      r.signal ?? null,
      startedMs,
      extractSessionId(output, opts.adapter.session?.idPattern),
      logFile,
      r.error?.message,
    );
    opts.ledger.append(rec);
    return rec;
  }

  const fd = openSync(logFile, "a");
  const child = spawn(argv[0], argv.slice(1), { cwd: opts.cwd, stdio: ["ignore", fd, fd] });
  try {
    closeSync(fd); // 子进程已持有 fd 副本，父侧关闭
  } catch {
    // ignore
  }
  const withPid: TaskRecord = { ...base, pid: child.pid };
  opts.ledger.append(withPid);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGTERM");
    } catch {
      // 进程可能已退出
    }
  }, opts.timeoutMs);

  child.on("error", (err) => {
    clearTimeout(timer);
    const rec = finalize(withPid, "failed", null, null, startedMs, null, logFile, err.message);
    opts.ledger.append(rec);
    notify(opts.notifyCommand, rec, opts.successNotifyMinDurationMs);
    try {
      opts.onFinal?.(rec);
    } catch {
      // 编排回调失败不影响台账
    }
  });

  child.on("exit", (code, signal) => {
    clearTimeout(timer);
    const output = tailFile(logFile, 200000);
    const status: TaskStatus = timedOut ? "timeout" : code === 0 ? "success" : "failed";
    const rec = finalize(
      withPid,
      status,
      code,
      signal,
      startedMs,
      extractSessionId(output, opts.adapter.session?.idPattern),
      logFile,
    );
    opts.ledger.append(rec);
    notify(opts.notifyCommand, rec, opts.successNotifyMinDurationMs);
    try {
      opts.onFinal?.(rec);
    } catch {
      // 编排回调失败不影响台账
    }
  });

  return withPid;
}
