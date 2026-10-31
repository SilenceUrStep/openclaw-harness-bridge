import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Ledger } from "./ledger.js";
import { shanghaiNow } from "./daily-report.js";
import type { DoctorReport } from "./doctor.js";
import {
  DOCTOR_TASK_ID,
  registerDoctorSchedule,
  resetDoctorScheduleForTest,
  runScheduledDoctorOnce,
} from "./doctor-schedule.js";

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

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
  const dir = mkdtempSync(path.join(tmpdir(), "hb-docsched-"));
  dirs.push(dir);
  return new Ledger(path.join(dir, "ledger.db"));
}

function report(levels: Array<"ok" | "warn" | "error">): DoctorReport {
  const checks = levels.map((level, i) => ({
    name: `check-${i}`,
    level,
    summary: `${level} summary ${i}`,
    ...(level === "error" ? { detail: `fix-${i}` } : {}),
  }));
  return {
    checks,
    allOk: checks.every((c) => c.level !== "error"),
    fullyHealthy: checks.every((c) => c.level === "ok"),
  };
}

describe("runScheduledDoctorOnce（v0.4.8 doctor 定时体检）", () => {
  beforeEach(() => {
    resetDoctorScheduleForTest();
    spawnMock.mockReset();
    spawnMock.mockReturnValue({ unref: () => {} });
  });

  it("error 级异常 + notifyCommand → 推送 HB_ALERT=doctor_report，台账写 doctor_report 事件", async () => {
    const l = tmpLedger();
    const r = await runScheduledDoctorOnce({
      cfg: {},
      ledger: l,
      notifyCommand: "echo sent",
      doctor: async () => report(["ok", "error", "warn"]),
    });
    expect(r.ran).toBe(true);
    expect(r.pushed).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const opts = spawnMock.mock.calls[0][2] as { env: Record<string, string> };
    expect(opts.env.HB_ALERT).toBe("doctor_report");
    expect(opts.env.HB_DETAIL).toContain("check-1");
    expect(opts.env.HB_DETAIL).toContain("fix-1");
    expect(opts.env.HB_DETAIL).toContain("另有 1 个 warn 项");
    expect(opts.env.HB_DETAIL).not.toContain("check-2"); // warn 项只报数量
    // 台账事件（挂在 hb_doctor 系统任务下）
    const events = l.getEvents(DOCTOR_TASK_ID);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("doctor_report");
    const payload = events[0].payload as { errorCount: number; warnCount: number; pushed: boolean; allOk: boolean };
    expect(payload.errorCount).toBe(1);
    expect(payload.warnCount).toBe(1);
    expect(payload.pushed).toBe(true);
    expect(payload.allOk).toBe(false);
  });

  it("全绿 → 不推送（无 spawn），台账仍写事件（allOk=true）", async () => {
    const l = tmpLedger();
    const r = await runScheduledDoctorOnce({
      cfg: {},
      ledger: l,
      notifyCommand: "echo sent",
      doctor: async () => report(["ok", "ok"]),
    });
    expect(r.ran).toBe(true);
    expect(r.pushed).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
    const events = l.getEvents(DOCTOR_TASK_ID);
    expect(events).toHaveLength(1);
    const payload = events[0].payload as { allOk: boolean; fullyHealthy: boolean; errorCount: number };
    expect(payload.allOk).toBe(true);
    expect(payload.fullyHealthy).toBe(true);
    expect(payload.errorCount).toBe(0);
  });

  it("仅 warn → 不推送（不打扰），事件含 warnCount", async () => {
    const l = tmpLedger();
    const r = await runScheduledDoctorOnce({
      cfg: {},
      ledger: l,
      notifyCommand: "echo sent",
      doctor: async () => report(["ok", "warn"]),
    });
    expect(r.pushed).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
    const payload = l.getEvents(DOCTOR_TASK_ID)[0].payload as { warnCount: number; pushed: boolean };
    expect(payload.warnCount).toBe(1);
    expect(payload.pushed).toBe(false);
  });

  it("有 error 但未配置 notifyCommand → 不推送，事件 pushed=false", async () => {
    const l = tmpLedger();
    const r = await runScheduledDoctorOnce({
      cfg: {},
      ledger: l,
      doctor: async () => report(["error"]),
    });
    expect(r.pushed).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
    const payload = l.getEvents(DOCTOR_TASK_ID)[0].payload as { pushed: boolean; errorCount: number };
    expect(payload.pushed).toBe(false);
    expect(payload.errorCount).toBe(1);
  });

  it("每日去重：同日第二次调用 ran=false 不重复执行不重复推送", async () => {
    const l = tmpLedger();
    const opts = {
      cfg: {},
      ledger: l,
      notifyCommand: "echo sent",
      doctor: async () => report(["error"]),
    };
    const first = await runScheduledDoctorOnce(opts);
    expect(first.ran).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const second = await runScheduledDoctorOnce(opts);
    expect(second.ran).toBe(false);
    expect(second.pushed).toBe(false);
    expect(second.report).toBeUndefined();
    expect(spawnMock).toHaveBeenCalledTimes(1); // 不重复推送
    expect(l.getEvents(DOCTOR_TASK_ID)).toHaveLength(1); // 不重复写事件
  });
});

describe("runScheduledDoctorOnce sentDates 持久化（v0.4.11）", () => {
  let stateFile: string;
  beforeEach(() => {
    const dir = mkdtempSync(path.join(tmpdir(), "hb-docstate-"));
    dirs.push(dir);
    stateFile = path.join(dir, "doctor-sent-dates.json");
    resetDoctorScheduleForTest(stateFile); // 清内存 + 删文件（每例干净起步）
    spawnMock.mockReset();
    spawnMock.mockReturnValue({ unref: () => {} });
  });

  it("标记当日后原子写盘（无 .tmp 残留）；重载（清内存留文件）后不再重复推送", async () => {
    const l = tmpLedger();
    const opts = {
      cfg: {},
      ledger: l,
      notifyCommand: "echo sent",
      stateFile,
      doctor: async () => report(["error"]),
    };
    const first = await runScheduledDoctorOnce(opts);
    expect(first.ran).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // 原子写：最终态文件存在且无 .tmp 半截残留
    expect(existsSync(stateFile)).toBe(true);
    expect(existsSync(`${stateFile}.tmp`)).toBe(false);
    const persisted = JSON.parse(readFileSync(stateFile, "utf8")) as { dates: string[] };
    expect(persisted.dates).toEqual([shanghaiNow().date]);
    // 模拟插件重载：清内存态但保留文件 → 新实例启动读回「今日已推」
    resetDoctorScheduleForTest();
    const second = await runScheduledDoctorOnce(opts);
    expect(second.ran).toBe(false);
    expect(second.pushed).toBe(false);
    expect(second.report).toBeUndefined();
    expect(spawnMock).toHaveBeenCalledTimes(1); // 不重复推送
    expect(l.getEvents(DOCTOR_TASK_ID)).toHaveLength(1); // 不重复写事件
  });

  it("损坏 JSON → fail-open 退化为空内存态：不抛错、正常体检并重写", async () => {
    writeFileSync(stateFile, "{not-json");
    const l = tmpLedger();
    const r = await runScheduledDoctorOnce({
      cfg: {},
      ledger: l,
      notifyCommand: "echo sent",
      stateFile,
      doctor: async () => report(["ok"]),
    });
    expect(r.ran).toBe(true);
    const persisted = JSON.parse(readFileSync(stateFile, "utf8")) as { dates: string[] };
    expect(persisted.dates).toEqual([shanghaiNow().date]);
  });

  it("写盘只留最近 7 天（与内存裁剪同源）", async () => {
    writeFileSync(
      stateFile,
      JSON.stringify({
        dates: ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05", "2026-01-06", "2026-01-07"],
      }),
    );
    const l = tmpLedger();
    await runScheduledDoctorOnce({ cfg: {}, ledger: l, stateFile, doctor: async () => report(["ok"]) });
    const persisted = JSON.parse(readFileSync(stateFile, "utf8")) as { dates: string[] };
    expect(persisted.dates).toHaveLength(7);
    expect(persisted.dates[0]).toBe("2026-01-02"); // 最老的被裁剪
    expect(persisted.dates[6]).toBe(shanghaiNow().date);
  });

  it("registerDoctorSchedule 启动即读回持久化标记：同日到点也不触发体检/推送", async () => {
    writeFileSync(stateFile, JSON.stringify({ dates: [shanghaiNow().date] }));
    const doctorMock = vi.fn(async () => report(["error"]));
    const timer = registerDoctorSchedule({
      cfg: { doctorSchedule: { hour: 0 } }, // 0 点：任何时刻都已到点
      ledger: tmpLedger(),
      notifyCommand: "echo sent",
      stateFile,
      doctor: doctorMock,
    });
    // 去重判定在注册时同步完成；留 100ms 观察窗兜底异步调度
    await new Promise((r) => setTimeout(r, 100));
    expect(doctorMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    clearInterval(timer);
  });
});

describe("registerDoctorSchedule", () => {
  beforeEach(() => {
    resetDoctorScheduleForTest();
    spawnMock.mockReset();
    spawnMock.mockReturnValue({ unref: () => {} });
  });

  it("到达设定小时（tick 立即执行）→ 触发一次体检；未到点不触发", async () => {
    const now = new Date().toLocaleString("sv-SE", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const curHour = Number(now.slice(11, 13));
    const l = tmpLedger();
    const timer = registerDoctorSchedule({
      cfg: { doctorSchedule: { hour: curHour } },
      ledger: l,
      notifyCommand: "echo sent",
      doctor: async () => report(["error"]),
    });
    // 到点：立即 tick 触发（异步执行，轮询等待）
    for (let i = 0; i < 50 && spawnMock.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(spawnMock).toHaveBeenCalledTimes(1);
    clearInterval(timer);
  });
});
