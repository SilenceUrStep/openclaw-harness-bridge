import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildDailyReport } from "./daily-report.js";
import { Ledger, type TaskRecord } from "./ledger.js";

const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function tmpLedger(): Ledger {
  const dir = mkdtempSync(path.join(tmpdir(), "hb-daily-"));
  dirs.push(dir);
  return new Ledger(path.join(dir, "ledger.db"));
}

/** 造任务：显式 createdAt（time_created，ISO UTC）决定归属日期（上海时区窗口） */
function rec(
  partial: Partial<TaskRecord> & { id: string; harness: string; status: TaskRecord["status"]; createdAt: string },
): TaskRecord {
  return { transport: "cli", ...partial };
}

describe("buildDailyReport（v0.4.6 台账日报）", () => {
  it("全成功：总数/成功率/token 合计/平均与最长耗时，无失败明细段", () => {
    const l = tmpLedger();
    l.append(rec({ id: "s1", harness: "opencode", status: "success", createdAt: "2026-10-26T01:00:00.000Z", tokensInput: 100, tokensOutput: 50, tokensCacheRead: 10, durationMs: 60_000 }));
    l.append(rec({ id: "s2", harness: "codex", status: "success", createdAt: "2026-10-26T05:00:00.000Z", tokensInput: 200, tokensOutput: 100, tokensCacheRead: 40, durationMs: 120_000 }));
    l.append(rec({ id: "s3", harness: "opencode", status: "success", createdAt: "2026-10-26T07:30:00.000Z", tokensInput: 1000, durationMs: 180_000 }));
    const report = buildDailyReport(l.dbPath, "2026-10-26");
    expect(report.startsWith("📊 harness 台账日报 10-26")).toBe(true);
    expect(report).toContain("任务：3 个｜成功 3｜失败 0｜成功率 100%");
    expect(report).toContain("Token 消耗：1,500"); // 160+340+1000
    expect(report).toContain("平均 2.0m｜最长 3.0m"); // (60+120+180)/3 / 180
    expect(report).not.toContain("失败明细");
  });

  it("含失败：失败数/成功率/失败明细（含上海时区窗口边界取舍）", () => {
    const l = tmpLedger();
    l.append(rec({ id: "s1", harness: "opencode", status: "success", createdAt: "2026-10-26T01:00:00.000Z", tokensInput: 10, tokensOutput: 10, tokensCacheRead: 10, durationMs: 30_000 }));
    // 边界：上海 10-26 00:00 整（UTC 前一日 16:00）计入
    l.append(rec({ id: "b3", harness: "opencode", status: "success", createdAt: "2026-10-25T16:00:00.000Z", tokensInput: 60, durationMs: 60_000 }));
    // cancelled 不计入失败
    l.append(rec({ id: "c1", harness: "opencode", status: "cancelled", createdAt: "2026-10-26T05:00:00.000Z", durationMs: 45_000 }));
    l.append(rec({ id: "f1", harness: "opencode", status: "failed", createdAt: "2026-10-26T01:30:00.000Z", durationMs: 60_000 }));
    l.append(rec({ id: "f2", harness: "codex", status: "failed", createdAt: "2026-10-26T02:00:00.000Z", durationMs: 120_000 }));
    l.append(rec({ id: "t1", harness: "codex", status: "timeout", createdAt: "2026-10-26T03:00:00.000Z", durationMs: 300_000 }));
    l.append(rec({ id: "l1", harness: "codex", status: "lost", createdAt: "2026-10-26T04:00:00.000Z" }));
    // 窗口外：上海 10-27 00:00 整 / 上海 10-25 23:59:59，均不计入
    l.append(rec({ id: "x1", harness: "opencode", status: "success", createdAt: "2026-10-26T16:00:00.000Z" }));
    l.append(rec({ id: "x2", harness: "opencode", status: "failed", createdAt: "2026-10-25T15:59:59.000Z" }));
    const report = buildDailyReport(l.dbPath, "2026-10-26");
    expect(report).toContain("任务：7 个｜成功 2｜失败 4｜成功率 29%");
    expect(report).toContain("Token 消耗：90"); // 30+60
    expect(report).toContain("失败明细：");
    // 按时间倒序，l1 无耗时显示 —
    expect(report).toContain("- l1｜codex｜lost｜—");
    expect(report).toContain("- t1｜codex｜timeout｜5.0m");
    expect(report).toContain("- f2｜codex｜failed｜2.0m");
    expect(report).toContain("- f1｜opencode｜failed｜1.0m");
    expect(report).not.toContain("x1");
    expect(report).not.toContain("x2");
  });

  it("失败明细最多 5 条；MM-DD 简写自动补当前上海年份", () => {
    const l = tmpLedger();
    const year = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric" });
    const base = Date.parse(`${year}-10-26T01:00:00+08:00`);
    for (let i = 0; i < 6; i++) {
      l.append(rec({ id: `ft${i}`, harness: "opencode", status: "failed", createdAt: new Date(base + i * 60_000).toISOString(), durationMs: 1000 }));
    }
    const report = buildDailyReport(l.dbPath, "10-26");
    expect(report.startsWith("📊 harness 台账日报 10-26")).toBe(true);
    expect(report).toContain("任务：6 个｜成功 0｜失败 6｜成功率 0%");
    expect(report.split("\n").filter((x) => x.startsWith("- "))).toHaveLength(5);
  });

  it("空库：返回简短无任务文本", () => {
    const l = tmpLedger();
    const report = buildDailyReport(l.dbPath, "2026-10-26");
    expect(report.startsWith("📊 harness 台账日报 10-26")).toBe(true);
    expect(report).toContain("无任务");
  });

  it("缺省日期：聚合上海昨日数据", () => {
    const l = tmpLedger();
    const yest = new Date(Date.now() - 86400_000).toLocaleString("sv-SE", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    l.append(rec({ id: "y1", harness: "opencode", status: "success", createdAt: new Date(Date.parse(`${yest}T12:00:00+08:00`)).toISOString() }));
    const report = buildDailyReport(l.dbPath);
    expect(report).toContain(`台账日报 ${yest.slice(5)}`);
    expect(report).toContain("任务：1 个｜成功 1｜失败 0｜成功率 100%");
  });
});
