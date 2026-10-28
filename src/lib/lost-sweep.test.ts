import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Ledger, type TaskRecord } from "./ledger.js";
import { registerLostSweeper, sweepLostTasks } from "./lost-sweep.js";

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
  const dir = mkdtempSync(path.join(tmpdir(), "hb-sweep-"));
  dirs.push(dir);
  return new Ledger(path.join(dir, "ledger.db"));
}

function rec(partial: Partial<TaskRecord> & { id: string; status: TaskRecord["status"] }): TaskRecord {
  return { harness: "opencode", transport: "cli", ...partial };
}

/** 起一个立即退出的真进程，拿到确定的「已死」pid */
async function deadPid(): Promise<number> {
  const child = spawn("true");
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  return child.pid as number;
}

describe("sweepLostTasks（v0.4.8 running 残留清扫）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pid 已死且无退出记录 → 标记 lost + 写 lost_sweep 事件（含 lastActivity）", async () => {
    const l = tmpLedger();
    const pid = await deadPid();
    l.append(rec({ id: "t_dead", status: "running", pid, startedAt: "2026-10-27T01:00:00.000Z" }));
    const r = sweepLostTasks(l);
    expect(r.swept).toEqual([
      { taskId: "t_dead", pid, lastActivity: "2026-10-27T01:00:00.000Z" },
    ]);
    const got = l.getById("t_dead");
    expect(got?.status).toBe("lost");
    expect(got?.finishedAt).toBeTruthy();
    expect(got?.error).toContain("gateway 重启");
    const events = l.getEvents("t_dead");
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("lost_sweep");
    expect(events[0].payload).toMatchObject({ taskId: "t_dead", pid });
  });

  it("pid 存活 → 不动；无 pid → 跳过；已有 finishedAt → 不重复标记", async () => {
    const l = tmpLedger();
    l.append(rec({ id: "t_alive", status: "running", pid: process.pid }));
    l.append(rec({ id: "t_nopid", status: "running" }));
    l.append(
      rec({ id: "t_finished", status: "running", pid: process.pid, finishedAt: "2026-10-27T02:00:00.000Z" }),
    );
    const r = sweepLostTasks(l);
    expect(r.swept).toEqual([]);
    expect(l.getById("t_alive")?.status).toBe("running");
    expect(l.getById("t_nopid")?.status).toBe("running");
    expect(l.getById("t_finished")?.status).toBe("running");
  });

  it("isAlive 注入点：探活判定可替换（false = 全部视为死亡）", () => {
    const l = tmpLedger();
    l.append(rec({ id: "t1", status: "running", pid: 999_999 }));
    const r = sweepLostTasks(l, { isAlive: () => false });
    expect(r.swept).toHaveLength(1);
    expect(l.getById("t1")?.status).toBe("lost");
  });

  it("空台账 / 无 running 任务 → 零清扫不报错", () => {
    const l = tmpLedger();
    l.append(rec({ id: "ok1", status: "success", pid: process.pid }));
    expect(sweepLostTasks(l).swept).toEqual([]);
  });
});

describe("registerLostSweeper", () => {
  it("注册即清扫一次并返回定时器（interval 注入大值避免重复执行）", async () => {
    const l = tmpLedger();
    const pid = await deadPid();
    l.append(rec({ id: "t_reg", status: "running", pid }));
    const isAlive = vi.fn(() => false);
    const timer = registerLostSweeper({ ledger: l, intervalMs: 3_600_000, isAlive });
    expect(l.getById("t_reg")?.status).toBe("lost");
    expect(isAlive).toHaveBeenCalled();
    clearInterval(timer);
  });
});
