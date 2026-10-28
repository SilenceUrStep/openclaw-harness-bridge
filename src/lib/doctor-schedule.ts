import { spawn } from "node:child_process";
import type { BridgeConfig } from "./adapters.js";
import { runDoctor, type DoctorReport } from "./doctor.js";
import type { Ledger } from "./ledger.js";
import { shanghaiNow } from "./daily-report.js";

/**
 * v0.4.8 doctor 定时体检：每天固定时刻（Asia/Shanghai，默认 8 点）自动跑一次
 * runDoctor，结果写台账事件（hb_doctor / doctor_report）；存在 error 级检查项时
 * 额外经 notifyCommand 推送告警（HB_ALERT=doctor_report，HB_DETAIL=异常项摘要），
 * 全绿或仅 warn 不推送（不打扰）。每日最多推送一次（内存 sentDates 去重，
 * 与台账日报同模式，进程重启最多重发一次）。全链路 fail-open。
 */

export const DOCTOR_TASK_ID = "hb_doctor";

/** HB_DETAIL 摘要截断上限（通知渠道友好长度） */
const DETAIL_MAX_CHARS = 1200;

/** 「今日已体检」状态（日期→已处理），进程内存态，重启即清零 */
const sentDates = new Map<string, boolean>();

export interface ScheduledDoctorOptions {
  cfg: BridgeConfig;
  ledger: Ledger;
  notifyCommand?: string;
  /** 体检执行注入点（测试用）；缺省 runDoctor(cfg) */
  doctor?: () => Promise<DoctorReport> | DoctorReport;
}

export interface ScheduledDoctorResult {
  /** 是否真正执行了体检（false = 今日已做过，去重跳过） */
  ran: boolean;
  /** 是否推送了告警 */
  pushed: boolean;
  report?: DoctorReport;
}

/** 异常项摘要（❌ 项一行一条，附 ↳ 建议；再补一行 warn 计数） */
function buildDetail(report: DoctorReport): string {
  const errors = report.checks.filter((c) => c.level === "error");
  const warns = report.checks.filter((c) => c.level === "warn");
  const lines: string[] = [];
  for (const c of errors) {
    lines.push(`❌ ${c.name}：${c.summary}`);
    if (c.detail) lines.push(`   ↳ ${c.detail}`);
  }
  if (warns.length > 0) lines.push(`另有 ${warns.length} 个 warn 项（未推送，可用 harness_doctor 查看完整报告）`);
  return lines.join("\n").slice(0, DETAIL_MAX_CHARS);
}

/**
 * 执行一次定时体检（含每日去重）：已处理过 → {ran:false}；
 * 否则跑体检 → 写 doctor_report 台账事件 → 有 error 项且配置了推送通道才发告警。
 * 注意：只要体检真正执行过就标记当日已处理（无论是否推送）。
 */
export async function runScheduledDoctorOnce(opts: ScheduledDoctorOptions): Promise<ScheduledDoctorResult> {
  const today = shanghaiNow().date;
  if (sentDates.has(today)) return { ran: false, pushed: false };
  const report = opts.doctor ? await opts.doctor() : await runDoctor(opts.cfg);
  const errorChecks = report.checks.filter((c) => c.level === "error");
  const warnChecks = report.checks.filter((c) => c.level === "warn");
  const pushed = errorChecks.length > 0 && Boolean(opts.notifyCommand?.trim());
  try {
    opts.ledger.addEvents(DOCTOR_TASK_ID, [
      {
        type: "doctor_report",
        payload: {
          date: today,
          allOk: report.allOk,
          fullyHealthy: report.fullyHealthy,
          errorCount: errorChecks.length,
          warnCount: warnChecks.length,
          anomalies: [...errorChecks, ...warnChecks].map((c) => ({ name: c.name, level: c.level, summary: c.summary })),
          pushed,
        },
        ts: new Date().toISOString(),
      },
    ]);
  } catch {
    // 事件写失败不阻断推送
  }
  if (errorChecks.length > 0 && opts.notifyCommand?.trim()) {
    try {
      const now = new Date();
      const child = spawn("bash", ["-c", opts.notifyCommand], {
        env: {
          ...process.env,
          HB_ALERT: "doctor_report",
          HB_DETAIL: buildDetail(report),
          HB_TIME: now.toISOString(),
        },
        stdio: "ignore",
      });
      child.unref?.();
    } catch {
      // 推送失败 fail-open（不标记失败，仅本次丢失）
    }
  }
  sentDates.set(today, true);
  // 只留最近 7 天标记，防长驻进程缓慢膨胀
  if (sentDates.size > 7) {
    const oldest = sentDates.keys().next().value;
    if (oldest) sentDates.delete(oldest);
  }
  return { ran: true, pushed, report };
}

export interface RegisterDoctorScheduleOptions {
  cfg: BridgeConfig;
  ledger: Ledger;
  notifyCommand?: string;
  /** 体检执行注入点（测试用） */
  doctor?: () => Promise<DoctorReport> | DoctorReport;
}

/**
 * 注册定时体检：每分钟检查上海时间到达 cfg.doctorSchedule.hour（默认 8）点
 * 且今日未体检过 → runScheduledDoctorOnce。timer.unref()，异常静默（下一分钟重试）。
 * 返回 timer 供 gateway_stop 清理。
 */
export function registerDoctorSchedule(opts: RegisterDoctorScheduleOptions): NodeJS.Timeout {
  const hour = opts.cfg.doctorSchedule?.hour ?? 8;
  const tick = (): void => {
    const now = shanghaiNow();
    if (now.hour < hour) return; // 未到体检时刻
    void runScheduledDoctorOnce(opts).catch(() => {
      // fail-open：体检失败静默，下一分钟重试
    });
  };
  tick();
  const timer = setInterval(tick, 60_000);
  timer.unref?.();
  return timer;
}

/** 测试辅助：清空「今日已体检」内存态（仅测试使用） */
export function resetDoctorScheduleForTest(): void {
  sentDates.clear();
}
