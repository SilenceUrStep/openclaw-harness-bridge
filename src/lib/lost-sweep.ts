import type { Ledger, TaskRecord } from "./ledger.js";
import { processAlive } from "./statusline.js";

/**
 * v0.4.8 running 残留定时清扫：gateway 重启会让后台任务永远停在 status=running
 * （退出回写回调随旧进程消失）。本模块在插件启动时 + 每小时主动扫描：
 * pid 进程已消失且无退出记录（finishedAt 为空）→ 标记 lost 并写 lost_sweep 事件。
 * 与 harness_status 查询时的即时判定互补：那边只是查询时展示，这边主动写回台账。
 */

export interface SweepLostOptions {
  /** 探活判定注入点（测试用）；缺省用 process.kill(pid, 0) */
  isAlive?: (pid: number) => boolean;
}

export interface SweptItem {
  taskId: string;
  pid?: number;
  /** 最后活动时间（startedAt ?? createdAt，可能缺失） */
  lastActivity?: string;
}

export interface SweepLostResult {
  swept: SweptItem[];
}

/** 扫描台账中 status=running 的残留任务并标记 lost；返回本次清扫清单（含零清扫） */
export function sweepLostTasks(ledger: Ledger, opts: SweepLostOptions = {}): SweepLostResult {
  const isAlive = opts.isAlive ?? processAlive;
  const swept: SweptItem[] = [];
  let candidates: TaskRecord[];
  try {
    candidates = ledger.latest({ status: "running" }, 500);
  } catch {
    return { swept };
  }
  for (const r of candidates) {
    if (r.pid == null) continue;
    if (isAlive(r.pid)) continue;
    if (r.finishedAt) continue; // 已有退出记录（兜底：过滤竞态）
    const lastActivity = r.startedAt ?? r.createdAt;
    try {
      ledger.append({
        ...r,
        status: "lost",
        finishedAt: new Date().toISOString(),
        error: "进程已不存在且无退出记录（可能 gateway 重启），定时清扫标记",
      });
      ledger.addEvents(r.id, [
        {
          type: "lost_sweep",
          payload: { taskId: r.id, pid: r.pid, lastActivity, sweptAt: new Date().toISOString() },
          ts: new Date().toISOString(),
        },
      ]);
      swept.push({ taskId: r.id, pid: r.pid, lastActivity });
    } catch {
      // 单条失败不阻断整体清扫
    }
  }
  return { swept };
}

export interface RegisterLostSweeperOptions {
  ledger: Ledger;
  /** 扫描间隔毫秒（默认 1 小时） */
  intervalMs?: number;
  /** 探活判定注入点（测试用） */
  isAlive?: (pid: number) => boolean;
}

/** 注册定时清扫：启动时立即扫一次 + 每 intervalMs 重复；fail-open（异常静默）。返回 timer 供 gateway_stop 清理 */
export function registerLostSweeper(opts: RegisterLostSweeperOptions): NodeJS.Timeout {
  const sweep = (): void => {
    try {
      sweepLostTasks(opts.ledger, { isAlive: opts.isAlive });
    } catch {
      // fail-open：清扫失败静默，下个周期重试
    }
  };
  sweep();
  const timer = setInterval(sweep, opts.intervalMs ?? 3_600_000);
  timer.unref?.();
  return timer;
}
