import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Adapter } from "./adapters.js";
import type { Ledger, TaskRecord, TaskStatus } from "./ledger.js";

export function newTaskId(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  return `hb_${ts}_${Math.random().toString(36).slice(2, 6)}`;
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
  wait: boolean;
  timeoutMs: number;
  ledger: Ledger;
  tasksDir: string;
  notifyCommand?: string;
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
 */
const NOTIFY_WINDOW_MS = 60_000;
const notifyState = new Map<string, { lastTs: number; suppressed: number }>();

export function resetNotifyThrottle(): void {
  notifyState.clear();
}

export function notify(notifyCommand: string | undefined, rec: TaskRecord): void {
  if (!notifyCommand) return;
  // 终态通知只对失败/超时触发（成功不打扰）
  if (rec.status === "success") return;
  const now = Date.now();
  const key = rec.harness;
  const st = notifyState.get(key);
  if (st && now - st.lastTs < NOTIFY_WINDOW_MS) {
    st.suppressed += 1;
    return; // 窗口内已通知过该 harness，抑制本次
  }
  const suppressed = st?.suppressed ?? 0;
  notifyState.set(key, { lastTs: now, suppressed: 0 });
  const env = {
    ...process.env,
    HB_TASK_ID: rec.id,
    HB_HARNESS: rec.harness,
    HB_STATUS: rec.status,
    HB_EXIT_CODE: String(rec.exitCode ?? ""),
    HB_SESSION_ID: rec.sessionId ?? "",
    HB_LOG_FILE: rec.logFile ?? "",
    HB_SUPPRESSED: suppressed > 0 ? String(suppressed) : "",
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

/** 执行任务：wait=true 同步等待；wait=false 后台执行（退出后回写台账 + 可选通知） */
export function runTask(opts: RunOptions): TaskRecord {
  const argv = buildArgv(opts);
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const id = newTaskId();
  const logFile = path.join(opts.tasksDir, `${id}.log`);
  const base: TaskRecord = {
    id,
    harness: opts.adapter.id,
    prompt: opts.prompt.length > 500 ? `${opts.prompt.slice(0, 500)}…` : opts.prompt,
    cwd: opts.cwd,
    status: "running",
    startedAt,
    logFile,
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
    notify(opts.notifyCommand, rec);
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
    notify(opts.notifyCommand, rec);
  });

  return withPid;
}
