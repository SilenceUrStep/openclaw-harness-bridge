import { existsSync, readFileSync, statSync } from "node:fs";
import { openLedgerAt } from "./ledger.js";
import { expandHome } from "./adapters.js";

export interface StatusLineSources {
  /** SQLite 台账路径（openLedgerAt 进程内单连接缓存，重复调用无 fd 泄漏） */
  ledgerDbPath?: string;
  /** 旧 JSONL 台账（兼容读取） */
  ledgerLegacyFile?: string;
  /** taskboard.md 路径（合并其「🔄 进行中」段） */
  taskboardFile?: string;
}

export interface RunningItem {
  name: string;
  detail?: string;
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function formatElapsed(startedAt?: string): string {
  if (!startedAt) return "";
  const t = Date.parse(startedAt);
  if (Number.isNaN(t)) return "";
  const ms = Math.max(0, Date.now() - t);
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

function snippet(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? `${oneLine.slice(0, n)}…` : oneLine;
}

const MAX_ITEMS = 5;

/** harness 台账 running 任务（pid 存活校验，死进程剔除） */
export function ledgerRunningItems(sources: StatusLineSources): RunningItem[] {
  if (!sources.ledgerDbPath) return [];
  try {
    const ledger = openLedgerAt(
      sources.ledgerDbPath,
      sources.ledgerLegacyFile ? { legacyFile: sources.ledgerLegacyFile } : undefined,
    );
    const recs = ledger.latest({ status: "running" }, 50);
    return recs
      .filter((r) => (r.pid ? processAlive(r.pid) : true))
      .map((r) => ({
        name: `${r.harness}·${snippet(r.title || r.prompt || r.id, 20)}`,
        detail: formatElapsed(r.startedAt),
      }));
  } catch {
    return [];
  }
}

/**
 * v0.4.1 性能优化：taskboard 内容缓存（mtime + 30s TTL 双重检查），
 * 每条出站消息不再重复读盘。
 */
const TASKBOARD_CACHE_TTL_MS = 30_000;
const taskboardCache = new Map<string, { mtimeMs: number; cachedAt: number; items: RunningItem[] }>();

export function clearTaskboardCache(): void {
  taskboardCache.clear();
}

/** taskboard.md「🔄 进行中」段顶层条目（缩进子项不计；mtime+TTL 缓存） */
export function taskboardRunningItems(taskboardFile?: string): RunningItem[] {
  if (!taskboardFile) return [];
  const file = expandHome(taskboardFile);
  if (!existsSync(file)) return [];
  try {
    const stat = statSync(file);
    const cached = taskboardCache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && Date.now() - cached.cachedAt < TASKBOARD_CACHE_TTL_MS) {
      return cached.items;
    }
    const text = readFileSync(file, "utf8");
    const block = text.split(/^##\s+/m).find((b) => b.startsWith("🔄 进行中"));
    const items: RunningItem[] = [];
    if (block) {
      for (const raw of block.split("\n").slice(1)) {
        const m = raw.match(/^[-*]\s+(.*)$/);
        if (!m) continue;
        const item = m[1].replace(/\*\*/g, "").trim();
        if (!item) continue;
        items.push({ name: snippet(item, 40) });
      }
    }
    taskboardCache.set(file, { mtimeMs: stat.mtimeMs, cachedAt: Date.now(), items });
    return items;
  } catch {
    return [];
  }
}

export function formatStatusLine(items: RunningItem[]): string {
  if (items.length === 0) return "后台任务：无";
  const shown = items
    .slice(0, MAX_ITEMS)
    .map((i) => (i.detail ? `${i.name}（${i.detail}）` : i.name));
  const more = items.length > MAX_ITEMS ? " 等" : "";
  return `后台任务：${items.length}个（${shown.join("｜")}${more}）`;
}

/**
 * v0.4.1 软超时预算：buildStatusLine 各步骤间检查耗时，
 * 超预算（默认 50ms）跳过后续数据源，返回已有结果（fail-open 不阻断消息发送）。
 */
export function buildStatusLine(sources: StatusLineSources, budgetMs = 50): string {
  const start = Date.now();
  const items: RunningItem[] = [];
  items.push(...ledgerRunningItems(sources));
  if (Date.now() - start < budgetMs) {
    items.push(...taskboardRunningItems(sources.taskboardFile));
  }
  return formatStatusLine(items);
}

const STATUS_LINE_RE = /^后台任务[：:]/m;

/**
 * 出站消息追加状态行：
 * - 空 / NO_REPLY 跳过
 * - 已有状态行（AI 手写）尊重原文不重复
 * - MEDIA 指令行前插入，保证 MEDIA 指令仍在独立末行
 */
export function appendStatusLine(content: string, line: string): string {
  if (!content || !content.trim()) return content;
  if (/^\s*NO_REPLY\s*$/.test(content)) return content;
  if (STATUS_LINE_RE.test(content)) return content;
  const mediaMatch = content.match(/^MEDIA:.*$/m);
  if (mediaMatch && mediaMatch.index !== undefined) {
    const before = content.slice(0, mediaMatch.index).replace(/\n+$/, "");
    const rest = content.slice(mediaMatch.index);
    return before ? `${before}\n${line}\n\n${rest}` : `${line}\n\n${rest}`;
  }
  return `${content.replace(/\s+$/, "")}\n${line}`;
}
