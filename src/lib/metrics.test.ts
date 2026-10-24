import { describe, expect, it } from "vitest";
import { MetricsSampler } from "./metrics.js";

describe("MetricsSampler", () => {
  it("start 后立即采样，summary 有数据", () => {
    const s = new MetricsSampler(60_000, 1440);
    s.start();
    try {
      const sum = s.summary();
      expect(sum.samples).toBeGreaterThanOrEqual(1);
      expect(sum.latest).not.toBeNull();
      expect(sum.latest!.rssMb).toBeGreaterThan(0);
      expect(sum.latest!.heapUsedMb).toBeGreaterThan(0);
      expect(sum.rssPeakMb).toBeGreaterThan(0);
    } finally {
      s.stop();
    }
  });

  it("heapPressure 返回百分比且不超 100", () => {
    const s = new MetricsSampler();
    s.start();
    try {
      const p = s.heapPressure(85);
      expect(p.usedPct).toBeGreaterThan(0);
      expect(p.usedPct).toBeLessThanOrEqual(100);
      expect(typeof p.pressured).toBe("boolean");
    } finally {
      s.stop();
    }
  });

  it("heapLimitMb 返回合理值（>0）", () => {
    const s = new MetricsSampler();
    expect(s.heapLimitMb()).toBeGreaterThan(0);
  });

  it("stop 后可重复 stop 不抛错", () => {
    const s = new MetricsSampler();
    s.start();
    s.stop();
    expect(() => s.stop()).not.toThrow();
  });

  it("环形缓冲按 maxEntries 截断", () => {
    const s = new MetricsSampler(1, 3); // 1ms 间隔，缓冲 3 条
    s.start();
    try {
      const buf = (s as unknown as { buffer: unknown[] }).buffer;
      // 等待采样超过 3 条
      const deadline = Date.now() + 2000;
      while (buf.length < 5 && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
      expect(buf.length).toBeLessThanOrEqual(3);
    } finally {
      s.stop();
    }
  });

  it("落盘+恢复往返（v0.4.2）：重启后观测数据不断档", () => {
    const { mkdtempSync, rmSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const path = require("node:path");
    const dir = mkdtempSync(path.join(tmpdir(), "hb-metrics-"));
    const file = path.join(dir, "metrics.json");
    try {
      const s1 = new MetricsSampler();
      s1.start();
      expect(s1.saveToDisk(file)).toBe(true);
      s1.stop();
      // 新实例模拟网关重启后恢复
      const s2 = new MetricsSampler();
      expect(s2.loadFromDisk(file)).toBe(true);
      const sum = s2.summary();
      expect(sum.samples).toBeGreaterThanOrEqual(1);
      expect(sum.latest).not.toBeNull();
      // 不留临时文件
      expect(require("node:fs").existsSync(`${file}.tmp`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loadFromDisk：文件不存在返回 false 不抛错", () => {
    const s = new MetricsSampler();
    expect(s.loadFromDisk(`/tmp/hb-nonexistent-${Date.now()}.json`)).toBe(false);
  });
});
