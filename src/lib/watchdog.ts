import { spawn } from "node:child_process";
import type { BridgeConfig } from "./adapters.js";
import { probeAllAdapters, type AdapterStatus } from "./health.js";
import type { Ledger, LedgerEventType } from "./ledger.js";

/**
 * v0.4.3 定时探活 + 状态变化告警：
 * - 插件内部定时器周期性对所有已注册 adapter 探活（复用 harness_list 健康检查逻辑）。
 * - 每轮探活结果写事件台账（steady id = hb_watchdog）；healthy↔unhealthy 变化单独记事件。
 * - 状态变化时经 notifyCommand 推送告警（含 adapter、变化方向、健康详情、时间）；
 *   持续故障不重复告警（只有状态翻转才触发），恢复时发恢复通知。
 */

export const WATCHDOG_TASK_ID = "hb_watchdog";

/** v0.4.11 台账降噪：全量 health 快照最小写入间隔（1 小时；5 分钟一轮由 288 条/天降到约 24 条/天） */
export const SNAPSHOT_INTERVAL_MS = 3_600_000;

export interface HealthChange {
  adapter: string;
  from: boolean;
  to: boolean;
  detail: string;
  ts: string;
}

export interface WatchdogRound {
  results: AdapterStatus[];
  changes: HealthChange[];
}

export interface WatchdogOptions {
  cfg: BridgeConfig;
  intervalMs: number;
  ledger: Ledger;
  notifyCommand?: string;
  /** 测试注入；默认 probeAllAdapters */
  probe?: (cfg: BridgeConfig) => Promise<AdapterStatus[]>;
}

export class HealthWatchdog {
  private timer: NodeJS.Timeout | null = null;
  private states = new Map<string, boolean>();
  private probing = false;
  /** v0.4.11 台账降噪：上次写全量 health 快照的时间（null = 首轮必写快照建立基线） */
  private lastSnapshotTs: number | null = null;

  constructor(private readonly opts: WatchdogOptions) {}

  start(): void {
    if (this.timer) return;
    void this.probeOnce();
    this.timer = setInterval(() => void this.probeOnce(), Math.max(1000, this.opts.intervalMs));
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /** 单轮探活：结果+状态变化写台账，变化项推送告警。首轮只建立基线不告警。 */
  async probeOnce(): Promise<WatchdogRound> {
    if (this.probing) return { results: [], changes: [] }; // 上一轮未结束跳过本轮
    this.probing = true;
    try {
      const probe = this.opts.probe ?? probeAllAdapters;
      const results = await probe(this.opts.cfg).catch(
        (): AdapterStatus[] => [],
      );
      const ts = new Date().toISOString();
      const changes: HealthChange[] = [];
      for (const r of results) {
        const prev = this.states.get(r.id);
        if (prev !== undefined && prev !== r.healthy) {
          changes.push({ adapter: r.id, from: prev, to: r.healthy, detail: r.healthDetail, ts });
        }
        this.states.set(r.id, r.healthy);
      }
      // v0.4.11 台账降噪：仅「本轮存在状态变化」或「距上次写快照 ≥ SNAPSHOT_INTERVAL_MS」才写
      // 全量 health 快照（首轮 lastSnapshotTs=null 必写建立基线）；health_change 事件照常写，
      // 探活与告警逻辑完全不变。变化轮的全量快照一并写入，便于对照变化前后状态。
      const snapshotDue =
        this.lastSnapshotTs === null ||
        changes.length > 0 ||
        Date.now() - this.lastSnapshotTs >= SNAPSHOT_INTERVAL_MS;
      const events: Array<{ type: LedgerEventType | string; payload: unknown; ts: string }> = changes.map(
        (c) => ({ type: "health_change", payload: c, ts: c.ts }),
      );
      if (snapshotDue) {
        events.push({
          type: "health",
          payload: {
            round: ts,
            results: results.map((r) => ({ id: r.id, healthy: r.healthy, detail: r.healthDetail })),
          },
          ts,
        });
      }
      try {
        if (events.length > 0) this.opts.ledger.addEvents(WATCHDOG_TASK_ID, events);
      } catch {
        // 台账写入失败不影响告警
      }
      if (snapshotDue) this.lastSnapshotTs = Date.now();
      for (const c of changes) this.sendAlert(c);
      return { results, changes };
    } finally {
      this.probing = false;
    }
  }

  /** 状态变化告警：spawn fire-and-forget（不阻塞探活轮转） */
  private sendAlert(c: HealthChange): void {
    const cmd = this.opts.notifyCommand;
    if (!cmd) return;
    try {
      const child = spawn("bash", ["-c", cmd], {
        env: {
          ...process.env,
          HB_ALERT: "health_change",
          HB_ADAPTER: c.adapter,
          HB_STATE: c.to ? "healthy" : "unhealthy",
          HB_PREV_STATE: c.from ? "healthy" : "unhealthy",
          HB_DETAIL: c.detail.length > 800 ? `${c.detail.slice(0, 800)}…` : c.detail,
          HB_TIME: c.ts,
        },
        stdio: "ignore",
      });
      child.unref?.();
    } catch {
      // 告警失败不影响探活
    }
  }
}
