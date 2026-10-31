import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "./adapters.js";
import type { AdapterStatus } from "./health.js";
import { Ledger } from "./ledger.js";

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  spawnSync: vi.fn(),
}));

const { HealthWatchdog, WATCHDOG_TASK_ID } = await import("./watchdog.js");

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

function status(id: string, healthy: boolean, detail = ""): AdapterStatus {
  return {
    id,
    displayName: id,
    description: null,
    binary: id,
    capabilities: [],
    modelSync: false,
    schemaVersion: 1,
    installed: healthy,
    transport: "cli",
    healthy,
    healthDetail: detail || (healthy ? "版本 1.0" : "binary 不可用；诊断：…"),
  };
}

function newWatchdog(
  probeResults: AdapterStatus[][],
  notifyCommand?: string,
): { wd: InstanceType<typeof HealthWatchdog>; ledger: Ledger; rounds: { i: number } } {
  const dir = mkdtempSync(path.join(tmpdir(), "hb-wd-"));
  dirs.push(dir);
  const ledger = new Ledger(path.join(dir, "ledger.db"));
  let i = 0;
  const wd = new HealthWatchdog({
    cfg: { dataDir: dir } as BridgeConfig,
    intervalMs: 60_000,
    ledger,
    notifyCommand,
    probe: async () => probeResults[Math.min(i++, probeResults.length - 1)],
  });
  return { wd, ledger, rounds: { i } };
}

beforeEach(() => {
  spawnMock.mockReset();
});

describe("HealthWatchdog（v0.4.3 定时探活）", () => {
  it("首轮只建立基线：写 health 事件、不告警", async () => {
    const { wd, ledger } = newWatchdog([[status("a", true), status("b", false)]], "echo alerted");
    const round = await wd.probeOnce();
    expect(round.changes).toEqual([]);
    expect(round.results).toHaveLength(2);
    expect(spawnMock).not.toHaveBeenCalled();
    const events = ledger.getEvents(WATCHDOG_TASK_ID).filter((e) => e.type === "health");
    expect(events).toHaveLength(1);
    expect((events[0].payload as { results: Array<{ id: string; healthy: boolean }> }).results).toContainEqual({
      id: "a",
      healthy: true,
      detail: "版本 1.0",
    });
  });

  it("healthy→unhealthy 变化：health_change 事件 + 告警（含方向/详情/时间）", async () => {
    const { wd, ledger } = newWatchdog(
      [[status("a", true)], [status("a", false, "binary 不可用；诊断：悬空链接")]],
      "echo alerted",
    );
    await wd.probeOnce();
    const round = await wd.probeOnce();
    expect(round.changes).toHaveLength(1);
    expect(round.changes[0]).toMatchObject({ adapter: "a", from: true, to: false });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0] as [string, string[], { env: Record<string, string> }];
    expect(cmd).toBe("bash");
    expect(args).toEqual(["-c", "echo alerted"]);
    expect(opts.env.HB_ALERT).toBe("health_change");
    expect(opts.env.HB_ADAPTER).toBe("a");
    expect(opts.env.HB_STATE).toBe("unhealthy");
    expect(opts.env.HB_PREV_STATE).toBe("healthy");
    expect(opts.env.HB_DETAIL).toContain("悬空链接");
    expect(opts.env.HB_TIME).toBeTruthy();
    const ev = ledger.getEvents(WATCHDOG_TASK_ID).find((e) => e.type === "health_change");
    expect(ev).toBeTruthy();
  });

  it("恢复时发恢复通知（HB_STATE=healthy）", async () => {
    const { wd } = newWatchdog([[status("a", false)], [status("a", true)]], "echo alerted");
    await wd.probeOnce();
    const round = await wd.probeOnce();
    expect(round.changes[0]).toMatchObject({ from: false, to: true });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const opts = spawnMock.mock.calls[0][2] as { env: Record<string, string> };
    expect(opts.env.HB_STATE).toBe("healthy");
  });

  it("持续故障不重复告警（无状态翻转则零通知）", async () => {
    const { wd } = newWatchdog([[status("a", false)], [status("a", false)], [status("a", false)]], "echo alerted");
    await wd.probeOnce();
    await wd.probeOnce();
    await wd.probeOnce();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("未配置 notifyCommand 时只记台账不推送", async () => {
    const { wd } = newWatchdog([[status("a", true)], [status("a", false)]]);
    await wd.probeOnce();
    const round = await wd.probeOnce();
    expect(round.changes).toHaveLength(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("start/stop 管理 定时器（unref 不阻断退出）", () => {
    const { wd } = newWatchdog([[status("a", true)]]);
    wd.start();
    expect(wd.running).toBe(true);
    wd.start(); // 幂等
    expect(wd.running).toBe(true);
    wd.stop();
    expect(wd.running).toBe(false);
  });
});

describe("HealthWatchdog 台账降噪（v0.4.11：health 快照限流）", () => {
  it("无变化且未到快照间隔：跳过写全量 health 快照（首轮基线外不再逐轮刷屏）", async () => {
    const { wd, ledger } = newWatchdog([[status("a", true)], [status("a", true)], [status("a", true)]]);
    await wd.probeOnce();
    await wd.probeOnce();
    await wd.probeOnce();
    const events = ledger.getEvents(WATCHDOG_TASK_ID);
    // 仅首轮基线 1 条快照；无 health_change
    expect(events.filter((e) => e.type === "health")).toHaveLength(1);
    expect(events.filter((e) => e.type === "health_change")).toHaveLength(0);
  });

  it("首轮必写快照建立基线（lastSnapshotTs 初始 null）", async () => {
    const { wd, ledger } = newWatchdog([[status("a", true)]]);
    await wd.probeOnce();
    const events = ledger.getEvents(WATCHDOG_TASK_ID).filter((e) => e.type === "health");
    expect(events).toHaveLength(1);
    expect(
      (events[0].payload as { results: Array<{ id: string }> }).results.map((r) => r.id),
    ).toEqual(["a"]);
  });

  it("状态变化轮：health_change 照常写，且同步补写全量快照（对照变化前后）并刷新基线", async () => {
    const { wd, ledger } = newWatchdog(
      [[status("a", true)], [status("a", false, "binary 不可用")], [status("a", false)]],
      "echo alerted",
    );
    await wd.probeOnce(); // 首轮基线
    await wd.probeOnce(); // 变化轮：health + health_change
    await wd.probeOnce(); // 无变化且基线刚刷新：不写
    const events = ledger.getEvents(WATCHDOG_TASK_ID);
    expect(events.filter((e) => e.type === "health")).toHaveLength(2);
    expect(events.filter((e) => e.type === "health_change")).toHaveLength(1);
    expect(spawnMock).toHaveBeenCalledTimes(1); // 告警逻辑不变
  });

  it("距上次快照 ≥ 1 小时无变化：补写全量快照（SNAPSHOT_INTERVAL_MS 到期）", async () => {
    vi.useFakeTimers();
    try {
      const { wd, ledger } = newWatchdog([[status("a", true)], [status("a", true)]]);
      await wd.probeOnce(); // 首轮基线
      expect(ledger.getEvents(WATCHDOG_TASK_ID).filter((e) => e.type === "health")).toHaveLength(1);
      // 时间前推 2 小时：无变化但超过快照间隔 → 补写
      vi.setSystemTime(Date.now() + 2 * 3_600_000);
      const round = await wd.probeOnce();
      expect(round.changes).toEqual([]);
      const health = ledger.getEvents(WATCHDOG_TASK_ID).filter((e) => e.type === "health");
      expect(health).toHaveLength(2);
      expect(ledger.getEvents(WATCHDOG_TASK_ID).filter((e) => e.type === "health_change")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("变化轮同时到快照间隔：只写一条全量快照（与 health_change 同批）", async () => {
    vi.useFakeTimers();
    try {
      const { wd, ledger } = newWatchdog([[status("a", true)], [status("a", false)]], "echo alerted");
      await wd.probeOnce();
      vi.setSystemTime(Date.now() + 2 * 3_600_000);
      await wd.probeOnce();
      const events = ledger.getEvents(WATCHDOG_TASK_ID);
      expect(events.filter((e) => e.type === "health")).toHaveLength(2);
      expect(events.filter((e) => e.type === "health_change")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
