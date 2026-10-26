import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "./adapters.js";
import { closeAllLedgers } from "./ledger.js";
import { Ledger } from "./ledger.js";

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  spawnSync: vi.fn(),
}));

const selfcheck = await import("./selfcheck.js");
const { SELFCHECK_TASK_ID, detectHostVersion, loadHostState, saveHostState, runSelfCheck, startupVersionCheck } =
  selfcheck;

const dirs: string[] = [];
afterAll(async () => {
  await closeAllLedgers();
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

beforeEach(() => {
  spawnMock.mockReset();
  delete process.env.OPENCLAW_VERSION;
});

function tmpDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "hb-sc-"));
  dirs.push(d);
  return d;
}

describe("detectHostVersion（v0.4.3 特性检测）", () => {
  it("api.openclawVersion 优先", async () => {
    expect(
      await detectHostVersion({ openclawVersion: "2026.9.4", version: "wrong" }),
    ).toBe("2026.9.4");
  });

  it("api.version 次优", async () => {
    expect(await detectHostVersion({ version: "2026.8.0" })).toBe("2026.8.0");
  });

  it("env OPENCLAW_VERSION 兜底（先于动态 import）", async () => {
    process.env.OPENCLAW_VERSION = "2026.7.1-2";
    expect(await detectHostVersion()).toBe("2026.7.1-2");
  });

  it("全部不可用 → unknown（不抛错）", async () => {
    const v = await detectHostVersion({});
    expect(typeof v).toBe("string");
    expect(v.length).toBeGreaterThan(0);
  });
});

describe("host-state.json（版本基线）", () => {
  it("save/load 往返；缺失文件返回 null", () => {
    const dir = tmpDir();
    const file = path.join(dir, "host-state.json");
    expect(loadHostState(file)).toBeNull();
    saveHostState(file, { hostVersion: "2026.9.4", updatedAt: "2026-10-26T00:00:00Z" });
    expect(loadHostState(file)?.hostVersion).toBe("2026.9.4");
  });
});

describe("startupVersionCheck（升级检测 + 冒烟自检）", () => {
  it("首启无基线：只记 host_version 事件，不自检", async () => {
    const dir = tmpDir();
    const ledger = new Ledger(path.join(dir, "ledger.db"));
    const r = await startupVersionCheck({
      cfg: { dataDir: dir } as BridgeConfig,
      ledger,
      hooks: ["message_sending"],
      dataDir: dir,
      api: { openclawVersion: "2026.9.4" },
    });
    expect(r.hostVersion).toBe("2026.9.4");
    expect(r.selfCheckRan).toBe(false);
    const ev = ledger.getEvents(SELFCHECK_TASK_ID).find((e) => e.type === "host_version");
    expect((ev?.payload as { version?: string; changed?: boolean }).version).toBe("2026.9.4");
    expect((ev?.payload as { changed?: boolean }).changed).toBe(false);
  });

  it("版本变化（升级）→ 自动自检：报告写台账 + notifyCommand 推送", async () => {
    const dir = tmpDir();
    writeFileSync(
      path.join(dir, "host-state.json"),
      JSON.stringify({ hostVersion: "2026.7.1-2", updatedAt: "2026-10-01T00:00:00Z" }),
    );
    const ledger = new Ledger(path.join(dir, "ledger.db"));
    const r = await startupVersionCheck({
      cfg: { dataDir: dir, notifyCommand: "echo notified" } as BridgeConfig,
      ledger,
      hooks: ["message_sending", "agent_turn_prepare"],
      dataDir: dir,
      api: { openclawVersion: "2026.9.4" },
      runSelfCheck: async () => ({
        hostVersion: "2026.9.4",
        previousVersion: "2026.7.1-2",
        startedAt: "2026-10-26T00:00:00Z",
        durationMs: 1,
        allGreen: true,
        items: [{ name: "adapter_registered", pass: true, detail: "ok" }],
      }),
    });
    expect(r.selfCheckRan).toBe(true);
    expect(r.report?.allGreen).toBe(true);
    const ev = ledger.getEvents(SELFCHECK_TASK_ID).find((e) => e.type === "selfcheck");
    expect(ev).toBeTruthy();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const opts = spawnMock.mock.calls[0][2] as { env: Record<string, string> };
    expect(opts.env.HB_ALERT).toBe("selfcheck");
    expect(opts.env.HB_SELFCHECK).toBe("all_green");
    expect(opts.env.HB_DETAIL).toContain("adapter_registered");
  });

  it("上次记录为 unknown 不视为升级（探测失败基线）", async () => {
    const dir = tmpDir();
    writeFileSync(
      path.join(dir, "host-state.json"),
      JSON.stringify({ hostVersion: "unknown", updatedAt: "2026-10-01T00:00:00Z" }),
    );
    const ledger = new Ledger(path.join(dir, "ledger2.db"));
    const r = await startupVersionCheck({
      cfg: { dataDir: dir } as BridgeConfig,
      ledger,
      hooks: [],
      dataDir: dir,
      api: { openclawVersion: "2026.9.4" },
    });
    expect(r.selfCheckRan).toBe(false);
  });
});

describe("runSelfCheck（冒烟项）", () => {
  it("三项检查：adapter 注册数 / echo 派单往返（注入）/ hooks 确认，全绿判定", async () => {
    const dir = tmpDir();
    const ledger = new Ledger(path.join(dir, "ledger.db"));
    const report = await runSelfCheck({
      cfg: { dataDir: dir } as BridgeConfig,
      hooks: ["message_sending", "before_tool_call"],
      hostVersion: "2026.9.4",
      previousVersion: "2026.7.1-2",
      ledger,
      runEcho: async () => ({ ok: true, detail: "echo 派单往返 success（exit=0）" }),
    });
    expect(report.items.map((i) => i.name)).toEqual([
      "adapter_registered",
      "echo_roundtrip",
      "hooks_registered",
    ]);
    expect(report.allGreen).toBe(true);
    expect(report.items[2].detail).toContain("before_tool_call");
  });

  it("无钩子启用 → hooks 项 skipped 不计入 allGreen（echo 为内置 adapter 始终存在）", async () => {
    const dir = tmpDir();
    const ledger = new Ledger(path.join(dir, "l2.db"));
    const report = await runSelfCheck({
      cfg: { dataDir: dir } as BridgeConfig,
      hooks: [],
      hostVersion: "2026.9.4",
      ledger,
      runEcho: async () => ({ ok: true, detail: "echo 派单往返 success（exit=0）" }),
    });
    const hooks = report.items.find((i) => i.name === "hooks_registered");
    expect(hooks?.skipped).toBe(true);
    expect(report.allGreen).toBe(true);
  });

  it("echo 往返失败 → allGreen=false 且逐项列出异常", async () => {
    const dir = tmpDir();
    const ledger = new Ledger(path.join(dir, "l3.db"));
    const report = await runSelfCheck({
      cfg: { dataDir: dir } as BridgeConfig,
      hooks: ["message_sending"],
      hostVersion: "2026.9.4",
      ledger,
      runEcho: async () => ({ ok: false, detail: "echo 派单往返 failed（exit=1）" }),
    });
    expect(report.allGreen).toBe(false);
    const echo = report.items.find((i) => i.name === "echo_roundtrip");
    expect(echo?.pass).toBe(false);
    expect(echo?.detail).toContain("failed");
  });
});
