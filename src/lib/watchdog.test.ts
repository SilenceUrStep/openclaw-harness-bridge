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
