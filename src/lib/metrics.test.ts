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

describe("MetricsSampler.archiveToDisk（v0.4.10）", () => {
  /** 本地时区当天日期键（YYYYMMDD），与 metrics.ts localDateKey 同逻辑 */
  function todayKey(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  }

  it("归档文件创建且内容含当天采样", () => {
    const { mkdtempSync, rmSync, existsSync, readFileSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const path = require("node:path");
    const dir = mkdtempSync(path.join(tmpdir(), "hb-metrics-arch-"));
    try {
      const s = new MetricsSampler();
      s.start();
      try {
        const archiveDir = path.join(dir, "metrics-archive");
        const metricsFile = path.join(dir, "metrics.json");
        expect(s.archiveToDisk(metricsFile, archiveDir)).toBe(true);
        const file = path.join(archiveDir, `metrics-${todayKey()}.json`);
        expect(existsSync(file)).toBe(true);
        expect(existsSync(`${file}.tmp`)).toBe(false); // 原子写不留 tmp
        const data = JSON.parse(readFileSync(file, "utf8")) as {
          archivedAt: string;
          date: string;
          samples: Array<{ ts: string; rssMb: number }>;
        };
        expect(data.date).toBe(todayKey());
        expect(typeof data.archivedAt).toBe("string");
        expect(data.samples.length).toBeGreaterThanOrEqual(1);
        expect(data.samples.every((x) => x.ts.startsWith(String(new Date().getFullYear())))).toBe(true);
        expect(data.samples[0]!.rssMb).toBeGreaterThan(0);
      } finally {
        s.stop();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("同日重复调用幂等：已有归档不被覆盖", () => {
    const { mkdtempSync, rmSync, readFileSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const path = require("node:path");
    const dir = mkdtempSync(path.join(tmpdir(), "hb-metrics-arch-"));
    try {
      const s = new MetricsSampler();
      s.start();
      try {
        const archiveDir = path.join(dir, "metrics-archive");
        const metricsFile = path.join(dir, "metrics.json");
        expect(s.archiveToDisk(metricsFile, archiveDir)).toBe(true);
        const file = path.join(archiveDir, `metrics-${todayKey()}.json`);
        const first = readFileSync(file, "utf8");
        expect(s.archiveToDisk(metricsFile, archiveDir)).toBe(true); // 同日再归档应跳过
        expect(readFileSync(file, "utf8")).toBe(first); // 内容不变
      } finally {
        s.stop();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("过期归档被清理（archiveDays=30）", () => {
    const { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, existsSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const path = require("node:path");
    const dir = mkdtempSync(path.join(tmpdir(), "hb-metrics-arch-"));
    try {
      const archiveDir = path.join(dir, "metrics-archive");
      mkdirSync(archiveDir, { recursive: true });
      // 40 天前的过期归档 + 一个不匹配命名模式的文件（不应被误删）
      const oldFile = path.join(archiveDir, "metrics-20200101.json");
      writeFileSync(oldFile, "{}", "utf8");
      const old = new Date(Date.now() - 40 * 86_400_000);
      utimesSync(oldFile, old, old);
      const otherFile = path.join(archiveDir, "other.json");
      writeFileSync(otherFile, "{}", "utf8");
      const s = new MetricsSampler();
      s.start();
      try {
        expect(s.archiveToDisk(path.join(dir, "metrics.json"), archiveDir, 30)).toBe(true);
        expect(existsSync(oldFile)).toBe(false); // 过期归档被清理
        expect(existsSync(otherFile)).toBe(true); // 非 metrics-*.json 不清理
        expect(existsSync(path.join(archiveDir, `metrics-${todayKey()}.json`))).toBe(true); // 当天归档仍在
      } finally {
        s.stop();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("当天无采样不建空归档", () => {
    const { mkdtempSync, rmSync, existsSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const path = require("node:path");
    const dir = mkdtempSync(path.join(tmpdir(), "hb-metrics-arch-"));
    try {
      const s = new MetricsSampler(); // 不 start，缓冲为空
      const archiveDir = path.join(dir, "metrics-archive");
      expect(s.archiveToDisk(path.join(dir, "metrics.json"), archiveDir)).toBe(true);
      expect(existsSync(archiveDir)).toBe(false); // 连目录都不建
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
