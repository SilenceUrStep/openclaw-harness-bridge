import { spawn } from "node:child_process";
import type { BridgeConfig } from "./adapters.js";
import { openDriverSync, type SqlDriver } from "./ledger.js";

/**
 * v0.4.6 台账日报：每天固定时间（Asia/Shanghai，默认 21 点）聚合昨日任务数据，
 * 经 notifyCommand 推送微信友好的一段报告文本。
 * - 聚合项：任务总数 / 成功数 / 失败数（failed+timeout+lost）/ 成功率 / token 合计 /
 *   平均耗时 / 最长耗时 / 失败任务明细（最多 5 条）。
 * - 「今日未发过」状态存内存 Map（日期→已发），发过跳过；进程重启最多重发一次。
 * - 全链路 fail-open：打开台账失败 / 推送失败都静默吞掉，下一分钟重试，绝不阻断主流程。
 */

const TZ = "Asia/Shanghai";

/** 上海时区（固定 UTC+8 无夏令时）当前日期与小时 */
function shanghaiNow(d: Date = new Date()): { date: string; hour: number } {
  const s = d.toLocaleString("sv-SE", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return { date: s.slice(0, 10), hour: Number(s.slice(11, 13)) };
}

/** 解析目标日期（YYYY-MM-DD）：缺省昨日；兼容 MM-DD（补当前上海年份） */
function resolveTargetDate(date?: string): string {
  if (!date) return shanghaiNow(new Date(Date.now() - 86400_000)).date;
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  if (/^\d{2}-\d{2}$/.test(date)) return `${shanghaiNow().date.slice(0, 5)}${date}`;
  return date;
}

/** 上海某一天 [00:00, 24:00) 对应的 UTC ISO 窗口（半开区间，台账时间为 ISO UTC 串可直接字典序比较） */
function shanghaiDayWindow(date: string): { since: string; until: string } {
  const startMs = Date.parse(`${date}T00:00:00+08:00`);
  return { since: new Date(startMs).toISOString(), until: new Date(startMs + 86400_000).toISOString() };
}

/** 耗时格式化（对齐 statusline 的 m/h 风格；均值保留一位小数，缺失显示 —） */
function formatDuration(ms?: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = ms / 1000;
  if (s < 60) return `${Math.round(s)}s`;
  const m = s / 60;
  if (m < 60) return `${m < 10 ? m.toFixed(1) : Math.round(m)}m`;
  return `${Math.floor(m / 60)}h${Math.round(m % 60)}m`;
}

function formatInt(n: number): string {
  return n.toLocaleString("en-US");
}

interface DailyStatsRow {
  total?: number | bigint;
  successCount?: number | bigint | null;
  failedCount?: number | bigint | null;
  tokens?: number | bigint | null;
  avgDuration?: number | null;
  maxDuration?: number | null;
}

interface FailedRow {
  id?: unknown;
  harness?: unknown;
  status?: unknown;
  duration_ms?: unknown;
}

const WINDOW_COND = "COALESCE(time_created, time_started) >= ? AND COALESCE(time_created, time_started) < ?";

/**
 * 聚合台账（task 表）昨日（或指定日期，上海时区）数据，返回微信友好的报告文本。
 * 台账打开失败时抛错（由 registerDailyReport 的 fail-open 兜底），无任务返回简短文本。
 */
export function buildDailyReport(ledgerDbPath: string, date?: string): string {
  const target = resolveTargetDate(date);
  const { since, until } = shanghaiDayWindow(target);
  const db: SqlDriver = openDriverSync(ledgerDbPath);
  const title = `📊 harness 台账日报 ${resolveTargetDate(date).slice(5)}`;
  try {
    db.exec("PRAGMA busy_timeout=5000");
    // 台账从未初始化（task 表不存在）视同无任务
    const hasTable = db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'task'")
      .get() as { n?: number | bigint };
    if (Number(hasTable?.n ?? 0) === 0) {
      return date ? `${title}\n${target} 无任务` : `${title}\n昨日无任务`;
    }
    const stats = db
      .prepare(
        `SELECT COUNT(*) AS total,
           SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successCount,
           SUM(CASE WHEN status IN ('failed', 'timeout', 'lost') THEN 1 ELSE 0 END) AS failedCount,
           SUM(COALESCE(tokens_input, 0) + COALESCE(tokens_output, 0) + COALESCE(tokens_cache_read, 0)) AS tokens,
           AVG(duration_ms) AS avgDuration,
           MAX(duration_ms) AS maxDuration
         FROM task WHERE ${WINDOW_COND}`,
      )
      .get(since, until) as DailyStatsRow | undefined;
    const total = Number(stats?.total ?? 0);
    if (total === 0) return date ? `${title}\n${target} 无任务` : `${title}\n昨日无任务`;

    const success = Number(stats?.successCount ?? 0);
    const failed = Number(stats?.failedCount ?? 0);
    const tokens = Number(stats?.tokens ?? 0);
    const rate = `${Math.round((success / total) * 100)}%`;
    const lines = [
      title,
      `任务：${total} 个｜成功 ${success}｜失败 ${failed}｜成功率 ${rate}`,
      `Token 消耗：${formatInt(tokens)}`,
      // AVG/MAX 无耗时样本时为 null，Number(null)=0 会误显示 0ms，需先判空
      `耗时：平均 ${formatDuration(stats?.avgDuration == null ? undefined : Number(stats.avgDuration))}｜最长 ${formatDuration(stats?.maxDuration == null ? undefined : Number(stats.maxDuration))}`,
    ];
    if (failed > 0) {
      const rows = db
        .prepare(
          `SELECT id, harness, status, duration_ms FROM task
           WHERE status IN ('failed', 'timeout', 'lost') AND ${WINDOW_COND}
           ORDER BY COALESCE(time_created, time_started) DESC LIMIT 5`,
        )
        .all(since, until) as FailedRow[];
      if (rows.length > 0) {
        lines.push("失败明细：");
        for (const r of rows) {
          const dur = r.duration_ms == null ? undefined : Number(r.duration_ms);
          lines.push(`- ${String(r.id)}｜${String(r.harness)}｜${String(r.status)}｜${formatDuration(dur)}`);
        }
      }
    }
    return lines.join("\n");
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

export interface DailyReportOptions {
  cfg: BridgeConfig;
  ledgerDbPath: string;
  notifyCommand?: string;
}

/** 「今日未发过」状态（日期→已发），进程内存态，重启即清零 */
const sentDates = new Map<string, boolean>();

/**
 * 注册台账日报定时器：每分钟检查上海时间到达 cfg.dailyReport.hour（默认 21）点
 * 且今日未发过 → buildDailyReport → 经 notifyCommand 推送（HB_NOTIFY 环境变量注入，同 watchdog 通道）。
 * 未配置 notifyCommand 时不发送。timer.unref()，全链路 fail-open。
 */
export function registerDailyReport(opts: DailyReportOptions): void {
  const hour = opts.cfg.dailyReport?.hour ?? 21;
  const tick = (): void => {
    try {
      const now = shanghaiNow();
      if (now.hour < hour) return; // 未到推送时刻
      if (sentDates.has(now.date)) return; // 今日已发过
      const cmd = opts.notifyCommand;
      if (!cmd) return; // 未配置推送通道，跳过（不标记已发）
      const report = buildDailyReport(opts.ledgerDbPath);
      const child = spawn("bash", ["-c", cmd], {
        env: { ...process.env, HB_NOTIFY: report, HB_REPORT_DATE: now.date },
        stdio: "ignore",
      });
      child.unref?.();
      sentDates.set(now.date, true);
      // 只留最近 7 天标记，防长驻进程缓慢膨胀
      if (sentDates.size > 7) {
        const oldest = sentDates.keys().next().value;
        if (oldest) sentDates.delete(oldest);
      }
    } catch {
      // fail-open：日报失败静默，下一分钟重试
    }
  };
  tick();
  const timer = setInterval(tick, 60_000);
  timer.unref?.();
}
