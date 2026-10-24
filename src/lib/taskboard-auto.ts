import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { expandHome } from "./adapters.js";

/**
 * v0.4.2 before_tool_call 自动登记：harness_run 派发时自动往 taskboard.md
 * 「🤖 自动登记」段写条目，治承诺悬空（AI 派任务自动留痕，不依赖手写）。
 *
 * 生命周期：before_tool_call 预登记(pending) → after_tool_call 绑定 taskId
 *   → 任务终态后由下次登记前的惰性清理(pruneFinished)移除。
 * 全链路 fail-open：登记失败绝不阻断派发主流程。
 */

const AUTO_SECTION = "## 🤖 自动登记";
const PENDING_PREFIX = "pending:";

function readTaskboard(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function writeTaskboardAtomic(file: string, content: string): boolean {
  try {
    const tmp = `${file}.hbtmp`;
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

function snippet(s: string, n = 30): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? `${oneLine.slice(0, n)}…` : oneLine || "(无描述)";
}

/**
 * 派发预登记：自动段追加条目，返回条目 key（供 after_tool_call 绑定 taskId）。
 * 条目格式：- [auto:pending:<key>] harness·摘要（HH:MM派发）
 */
export function registerDispatch(taskboardFile: string, harness: string, prompt: string): string | null {
  try {
    const file = expandHome(taskboardFile);
    if (!file) return null;
    const key = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const time = new Date().toTimeString().slice(0, 5);
    const entry = `- [auto:${PENDING_PREFIX}${key}] ${harness}·${snippet(prompt)}（${time}派发）`;
    const text = readTaskboard(file);
    let out: string;
    if (text.includes(AUTO_SECTION)) {
      out = text.replace(AUTO_SECTION, `${AUTO_SECTION}\n${entry}`);
    } else {
      const base = text.trimEnd();
      out = (base ? `${base}\n\n` : "") + `${AUTO_SECTION}\n${entry}\n`;
    }
    return writeTaskboardAtomic(file, out) ? key : null;
  } catch {
    return null; // fail-open
  }
}

/** after_tool_call 成功：pending 条目绑定真实 taskId */
export function bindTaskId(taskboardFile: string, key: string, taskId: string): boolean {
  try {
    const file = expandHome(taskboardFile);
    const text = readTaskboard(file);
    const updated = text.replace(`[auto:${PENDING_PREFIX}${key}]`, `[auto:${taskId}]`);
    if (updated === text) return false;
    return writeTaskboardAtomic(file, updated);
  } catch {
    return false;
  }
}

/** after_tool_call 失败/无 taskId：移除 pending 条目（派发未成功不留痕） */
export function removeEntry(taskboardFile: string, key: string): boolean {
  try {
    const file = expandHome(taskboardFile);
    const text = readTaskboard(file);
    const lines = text.split("\n");
    const out = lines.filter((l) => !l.includes(`[auto:${PENDING_PREFIX}${key}]`));
    if (out.length === lines.length) return false;
    return writeTaskboardAtomic(file, out.join("\n"));
  } catch {
    return false;
  }
}

/**
 * 惰性清理：移除自动段中已终态任务的条目（taskId 不在 alive 集合即已终态）。
 * pending 条目跳过（由 after_tool_call 负责成败分流）。返回移除条数。
 */
export function pruneFinished(taskboardFile: string, aliveTaskIds: Set<string>): number {
  try {
    const file = expandHome(taskboardFile);
    const text = readTaskboard(file);
    if (!text.includes(AUTO_SECTION)) return 0;
    const lines = text.split("\n");
    const out: string[] = [];
    let removed = 0;
    for (const line of lines) {
      const m = line.match(/^- \[auto:([^\]]+)\]/);
      if (m && !m[1].startsWith(PENDING_PREFIX) && !aliveTaskIds.has(m[1])) {
        removed += 1;
        continue;
      }
      out.push(line);
    }
    if (removed > 0) writeTaskboardAtomic(file, out.join("\n"));
    return removed;
  } catch {
    return 0;
  }
}
