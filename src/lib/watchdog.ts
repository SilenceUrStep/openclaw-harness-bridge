import { spawn } from "node:child_process";
import type { BridgeConfig } from "./adapters.js";
import { probeAllAdapters, type AdapterStatus } from "./health.js";
import type { Ledger } from "./ledger.js";

/**
 * v0.4.3 定时探活 + 状态变化告警：
 * - 插件内部定时器周期性对所有已注册 adapter 探活（复用 harness_list 健康检查逻辑）。
 * - 每轮探活结果写事件台账（steady id = hb_watchdog）；healthy↔unhealthy 变化单独记事件。
 * - 状态变化时经 notifyCommand 推送告警（含 adapter、变化方向、健康详情、时间）；
 *   持续故障不重复告警（只有状态翻转才触发），恢复时发恢复通知。
 */

export const WATCHDOG_TASK_ID = "hb_watchdog";

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
      try {
        this.opts.ledger.addEvents(WATCHDOG_TASK_ID, [
          {
            type: "health",
            payload: {
              round: ts,
              results: results.map((r) => ({ id: r.id, healthy: r.healthy, detail: r.healthDetail })),
            },
            ts,
          },
          ...changes.map((c) => ({ type: "health_change", payload: c, ts: c.ts })),
        ]);
      } catch {
        // 台账写入失败不影响告警
      }
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
