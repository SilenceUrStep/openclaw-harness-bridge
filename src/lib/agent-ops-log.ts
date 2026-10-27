import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { expandHome } from "./adapters.js";

/**
 * v0.4.5 agent-ops 日志：把 agent 层工具调用（exec/edit/write/apply_patch/harness_run 等）
 * 自动打进统一日志（默认 <dataDir>/agent-ops.log），治「agent 层操作无自动日志」缺口。
 *
 * 格式对齐 jlog：`YYYY-MM-DD HH:mm:ss.SSS [INFO] [agent-ops] [工具名] 摘要`（北京时间 Asia/Shanghai）。
 * 只读工具（read/ls/grep/memory_search 等）跳过不记，控制噪音。
 * v0.4.6 日志轮转：写入前检查文件大小，超 maxBytes 滚动（.log → .1 → .2 …），最多保留 keep 份。
 * 全链路 fail-open：写日志/轮转失败静默吞掉，绝不阻断工具调用主流程。
 */

/** 只读工具名单：调用频繁且观测价值低，跳过不记 */
const READONLY_TOOLS = new Set(["read", "ls", "grep", "glob", "memory_search"]);

/** 摘要单行化：换行统一替换为 ⏎ */
function oneLine(s: string): string {
  return s.replace(/\r?\n/g, "⏎");
}

/** 从 result 提取错误信息（result 含 error 字段即视为失败） */
function extractErrorMessage(result: unknown): string | null {
  if (result == null || typeof result !== "object") return null;
  const err = (result as Record<string, unknown>).error;
  if (typeof err === "string" && err.trim()) return err;
  if (err != null) return String(err);
  return null;
}

/** exec 摘要：command 前 120 字符，单行化 */
function execSummary(params: unknown): string {
  const p = (params ?? {}) as Record<string, unknown>;
  const cmd = p.command;
  const s = Array.isArray(cmd) ? cmd.join(" ") : typeof cmd === "string" ? cmd : cmd == null ? "" : String(cmd);
  return oneLine(s).slice(0, 120);
}

/** edit/write/apply_patch 摘要：文件路径 */
function pathSummary(params: unknown): string {
  const p = (params ?? {}) as Record<string, unknown>;
  const pth = p.path ?? p.file_path;
  return typeof pth === "string" && pth ? pth : "(无路径)";
}

/** harness_run 摘要：harness + taskId（从 result 取）+ status + durationMs */
function harnessRunSummary(params: unknown, result: unknown, durationMs?: number): string {
  const p = (params ?? {}) as Record<string, unknown>;
  const r = result != null && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const parts: string[] = [typeof p.harness === "string" && p.harness ? p.harness : "(未知harness)"];
  if (r.taskId != null && String(r.taskId)) parts.push(`task=${String(r.taskId)}`);
  if (typeof r.status === "string" && r.status) parts.push(`status=${r.status}`);
  if (durationMs !== undefined) parts.push(`${durationMs}ms`);
  return parts.join(" ");
}

/** 其他工具摘要：params 首个字符串值截断 80 字符 */
function genericSummary(params: unknown): string {
  const p = params;
  if (p != null && typeof p === "object") {
    for (const v of Object.values(p as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) return oneLine(v).slice(0, 80);
    }
    return "(无参数)";
  }
  if (typeof p === "string" && p.trim()) return oneLine(p).slice(0, 80);
  return "(无参数)";
}

/** 北京时间（Asia/Shanghai）时间戳：YYYY-MM-DD HH:mm:ss.SSS */
export function beijingTimestamp(d: Date = new Date()): string {
  const base = d.toLocaleString("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return `${base}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

/** 该工具是否需要记 agent-ops 日志（只读工具跳过；index.ts 计时判断复用） */
export function shouldLogAgentOps(toolName: string): boolean {
  return !READONLY_TOOLS.has(toolName.toLowerCase());
}

/**
 * v0.4.6 日志轮转：主文件超 maxBytes 时滚动（.log → .1，原 .1→.2 … 从大到小 renameSync 循环），
 * 删超出 keep 的旧份（含历史遗留的更大序号）。文件不存在 / 轮转失败静默跳过（fail-open），
 * 主文件照常写入。
 */
function rotateAgentOpsLog(file: string, maxBytes: number, keep: number): void {
  try {
    if (statSync(file).size <= maxBytes) return;
    for (let i = keep; i >= 1; i--) {
      const src = `${file}.${i}`;
      if (!existsSync(src)) continue;
      if (i >= keep) {
        rmSync(src, { force: true }); // 最老一份滚动出保留窗口，直接删
      } else {
        renameSync(src, `${file}.${i + 1}`);
      }
    }
    // 历史遗留的超序号旧份（keep 调小过）一并清掉
    for (let i = keep + 1; i <= keep + 10; i++) {
      rmSync(`${file}.${i}`, { force: true });
    }
    renameSync(file, `${file}.1`);
  } catch {
    // fail-open：轮转失败照常写入主文件
  }
}

/**
 * 记录一条 agent 层工具调用日志（追加写入，失败静默吞掉）。
 * 工具抛错时把错误包成 { error } 传进 result 即可记 [ERROR] 级别。
 * v0.4.6 传入 maxBytes（字节）启用写入前轮转，keep 为保留份数（默认 7）。
 */
export function logAgentOps(opts: {
  toolName: string;
  params?: unknown;
  result?: unknown;
  durationMs?: number;
  logFile: string;
  maxBytes?: number;
  keep?: number;
}): void {
  try {
    const toolName = String(opts.toolName ?? "").trim();
    if (!toolName || !shouldLogAgentOps(toolName)) return;

    let summary: string;
    const lower = toolName.toLowerCase();
    if (lower === "exec") {
      summary = execSummary(opts.params);
    } else if (lower === "edit" || lower === "write" || lower === "apply_patch") {
      summary = pathSummary(opts.params);
    } else if (lower === "harness_run") {
      summary = harnessRunSummary(opts.params, opts.result, opts.durationMs);
    } else {
      summary = genericSummary(opts.params);
    }

    const errMsg = extractErrorMessage(opts.result);
    const level = errMsg ? "ERROR" : "INFO";
    if (errMsg) summary = `${summary} | error: ${oneLine(errMsg).slice(0, 120)}`;

    const line = `${beijingTimestamp()} [${level}] [agent-ops] [${toolName}] ${summary}\n`;
    const file = expandHome(opts.logFile);
    mkdirSync(path.dirname(file), { recursive: true });
    // v0.4.6 写入前轮转：超 maxBytes 滚动旧内容到 .1（未传 maxBytes 不轮转，行为同 v0.4.5）
    if (opts.maxBytes != null && opts.maxBytes > 0) {
      rotateAgentOpsLog(file, opts.maxBytes, opts.keep ?? 7);
    }
    appendFileSync(file, line, "utf8");
  } catch {
    // fail-open：日志失败绝不抛错，不影响工具调用主流程
  }
}
