import { monitorEventLoopDelay, type ELDHistogram } from "node:perf_hooks";
import { memoryUsage } from "node:process";
import { getHeapStatistics } from "node:v8";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";

/**
 * v0.4.1 观测采样器：网关进程内每分钟采样内存与事件循环延迟，
 * 环形缓冲保留 24h（1440 条），供 harness_status metrics=true 查询。
 * 数据说话：攒一周数据再决定是否调 Node 参数。
 */

export interface MetricsSample {
  ts: string;
  /** 进程 RSS（MB） */
  rssMb: number;
  /** V8 堆已用（MB） */
  heapUsedMb: number;
  /** V8 堆总量（MB） */
  heapTotalMb: number;
  /** external + arrayBuffers（MB） */
  externalMb: number;
  /** 事件循环延迟 p99（ms，采样窗口内） */
  eventLoopP99Ms: number;
  /** 事件循环延迟最大值（ms） */
  eventLoopMaxMs: number;
}

export interface MetricsSummary {
  samples: number;
  windowHours: number;
  latest: MetricsSample | null;
  /** 窗口内 RSS 峰值（MB） */
  rssPeakMb: number;
  /** 窗口内 heapUsed 峰值（MB） */
  heapUsedPeakMb: number;
  /** 窗口内事件循环 p99 峰值（ms） */
  eventLoopP99PeakMs: number;
}

const MB = 1024 * 1024;

/** v0.4.10 本地时区日期键（YYYYMMDD），按天归档用 */
function localDateKey(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

export class MetricsSampler {
  private histogram: ELDHistogram | null = null;
  private timer: NodeJS.Timeout | null = null;
  private buffer: MetricsSample[] = [];

  constructor(
    private readonly intervalMs = 60_000,
    private readonly maxEntries = 1440, // 24h @ 1min
  ) {}

  start(): void {
    if (this.timer) return;
    try {
      this.histogram = monitorEventLoopDelay({ resolution: 20 });
      this.histogram.enable();
    } catch {
      this.histogram = null; // 事件循环观测不可用时降级为仅内存采样
    }
    this.timer = setInterval(() => this.sample(), this.intervalMs);
    this.timer.unref?.();
    this.sample(); // 启动即采一条
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    try {
      this.histogram?.disable();
    } catch {
      // ignore
    }
    this.histogram = null;
  }

  private sample(): void {
    try {
      const mem = memoryUsage();
      const heap = getHeapStatistics();
      let p99 = 0;
      let max = 0;
      if (this.histogram) {
        p99 = this.histogram.percentile(99) / 1e6; // ns → ms
        max = this.histogram.max / 1e6;
        this.histogram.reset(); // 每窗口独立统计
      }
      const s: MetricsSample = {
        ts: new Date().toISOString(),
        rssMb: Math.round((mem.rss / MB) * 10) / 10,
        heapUsedMb: Math.round((mem.heapUsed / MB) * 10) / 10,
        heapTotalMb: Math.round((mem.heapTotal / MB) * 10) / 10,
        externalMb: Math.round(((mem.external + mem.arrayBuffers) / MB) * 10) / 10,
        eventLoopP99Ms: Math.round(p99 * 10) / 10,
        eventLoopMaxMs: Math.round(max * 10) / 10,
      };
      this.buffer.push(s);
      if (this.buffer.length > this.maxEntries) this.buffer.shift();
    } catch {
      // 采样失败静默跳过（观测自身绝不影响网关）
    }
  }

  /** 堆上限（MB），来自 V8 heap_size_limit */
  heapLimitMb(): number {
    try {
      return Math.round(getHeapStatistics().heap_size_limit / MB);
    } catch {
      return 0;
    }
  }

  summary(windowHours = 24): MetricsSummary {
    const cutoff = Date.now() - windowHours * 3600_000;
    const windowed = this.buffer.filter((s) => Date.parse(s.ts) >= cutoff);
    const latest = windowed.length > 0 ? windowed[windowed.length - 1] : null;
    return {
      samples: windowed.length,
      windowHours,
      latest,
      rssPeakMb: windowed.length ? Math.max(...windowed.map((s) => s.rssMb)) : 0,
      heapUsedPeakMb: windowed.length ? Math.max(...windowed.map((s) => s.heapUsedMb)) : 0,
      eventLoopP99PeakMs: windowed.length ? Math.max(...windowed.map((s) => s.eventLoopP99Ms)) : 0,
    };
  }

  /** 调参判断：heapUsed 是否逼近堆上限（默认阈值 85%） */
  heapPressure(thresholdPct = 85): { pressured: boolean; usedPct: number } {
    const limit = this.heapLimitMb();
    const latest = this.buffer[this.buffer.length - 1];
    if (!limit || !latest) return { pressured: false, usedPct: 0 };
    const usedPct = Math.round((latest.heapUsedMb / limit) * 100);
    return { pressured: usedPct >= thresholdPct, usedPct };
  }

  /** v0.4.2 落盘：环形缓冲写 JSON（原子写 tmp+rename），网关重启后观测数据不断档 */
  saveToDisk(path: string): boolean {
    try {
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ savedAt: new Date().toISOString(), samples: this.buffer }), "utf8");
      renameSync(tmp, path);
      return true;
    } catch {
      return false;
    }
  }

  /** v0.4.2 启动恢复：从落盘文件加载历史采样（按 maxEntries 截断） */
  loadFromDisk(path: string): boolean {
    try {
      if (!existsSync(path)) return false;
      const data = JSON.parse(readFileSync(path, "utf8")) as { samples?: MetricsSample[] };
      if (Array.isArray(data?.samples) && data.samples.length > 0) {
        this.buffer = data.samples.slice(-this.maxEntries);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * v0.4.10 按天归档：把缓冲中当天的采样写 <archiveDir>/metrics-YYYYMMDD.json（原子写 tmp+rename，与 saveToDisk 同风格），
   * 破解覆盖写只能留 24h 窗口的问题；同日重复调用幂等跳过，当天无采样不建空归档；
   * 顺带清理 archiveDir 下修改时间超过 archiveDays 天的 metrics-*.json。
   * 全程 fail-open：失败返回 false，观测自身绝不影响网关。
   */
  archiveToDisk(metricsFile: string, archiveDir: string, archiveDays = 30): boolean {
    try {
      // 清理过期归档（修改时间超过 archiveDays 天的 metrics-*.json，单文件失败不影响整体）
      const cutoff = Date.now() - archiveDays * 86_400_000;
      if (existsSync(archiveDir)) {
        for (const f of readdirSync(archiveDir)) {
          if (!/^metrics-\d{8}\.json$/.test(f)) continue;
          try {
            if (statSync(`${archiveDir}/${f}`).mtimeMs < cutoff) unlinkSync(`${archiveDir}/${f}`);
          } catch {
            // 单个归档清理失败不影响其余文件
          }
        }
      }
      const date = localDateKey(new Date());
      const archiveFile = `${archiveDir}/metrics-${date}.json`;
      if (existsSync(archiveFile)) return true; // 幂等：当天归档已存在则跳过
      // 当天采样归属按本地时区判定（sample.ts 为 UTC ISO 串）
      const todays = this.buffer.filter((s) => {
        const t = Date.parse(s.ts);
        return !Number.isNaN(t) && localDateKey(new Date(t)) === date;
      });
      if (todays.length === 0) return true; // 当天无采样不建空归档
      mkdirSync(archiveDir, { recursive: true });
      const tmp = `${archiveFile}.tmp`;
      writeFileSync(tmp, JSON.stringify({ archivedAt: new Date().toISOString(), date, samples: todays }), "utf8");
      renameSync(tmp, archiveFile);
      return true;
    } catch {
      return false;
    }
  }
}
