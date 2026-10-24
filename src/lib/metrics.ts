import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import { memoryUsage } from "node:process";
import { getHeapStatistics } from "node:v8";

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

export class MetricsSampler {
  private histogram: IntervalHistogram | null = null;
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
}
