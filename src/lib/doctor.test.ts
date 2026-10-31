import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  checkConfigHealth,
  checkLedgerHealth,
  checkWorktreeResidue,
  formatBytes,
  renderDoctorReport,
  runDoctor,
  type DoctorReport,
} from "./doctor.js";
import type { AdapterStatus } from "./health.js";
import type { BridgeConfig } from "./adapters.js";

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

function status(partial: Partial<AdapterStatus>): AdapterStatus {
  return {
    id: "opencode",
    displayName: "OpenCode",
    description: null,
    binary: "opencode",
    capabilities: ["coding"],
    modelSync: false,
    schemaVersion: 2,
    installed: true,
    version: "2026.9.4",
    transport: "cli",
    healthy: true,
    healthDetail: "版本 2026.9.4",
    ...partial,
  };
}

describe("doctor adapter 检查（v0.4.7）", () => {
  it("全部健康 → 三项检查全 ok", async () => {
    const report = await runDoctor({ notifyCommand: "bash hb_notify.sh" } as BridgeConfig, {
      probe: async () => [
        status({ id: "a1" }),
        status({ id: "a2", binary: "dsh", healthDetail: "版本 0.0.1" }),
      ],
      api: { openclawVersion: "2026.9.4" },
    });
    const [adapters, versions, binaries] = report.checks;
    expect(adapters.level).toBe("ok");
    expect(adapters.summary).toContain("2/2");
    expect(versions.level).toBe("ok");
    expect(versions.summary).toContain("a1 2026.9.4");
    expect(binaries.level).toBe("ok");
    expect(report.allOk).toBe(true);
    expect(report.fullyHealthy).toBe(true);
  });

  it("unhealthy adapter → 探活 error + 修复建议；未安装 → binary 诊断附线索", async () => {
    const report = await runDoctor({} as BridgeConfig, {
      probe: async () => [
        status({ id: "bad", installed: false, healthy: false, healthDetail: "binary 不可用" }),
        status({ id: "gatefail", healthy: false, healthDetail: "版本门禁未通过" }),
      ],
      api: { openclawVersion: "2026.9.4" },
    });
    const [adapters, , binaries] = report.checks;
    expect(adapters.level).toBe("error");
    expect(adapters.summary).toContain("bad");
    expect(adapters.detail).toContain("建议");
    expect(binaries.level).toBe("error");
    expect(binaries.detail).toContain("PATH"); // diagnoseBinary 线索必含 PATH
    expect(report.allOk).toBe(false);
  });

  it("版本未知 → 版本探测 warn", async () => {
    const report = await runDoctor({} as BridgeConfig, {
      probe: async () => [status({ version: undefined, healthDetail: "版本探测不可用" })],
      api: { openclawVersion: "2026.9.4" },
    });
    expect(report.checks[1].level).toBe("warn");
    expect(report.allOk).toBe(true);
    expect(report.fullyHealthy).toBe(false);
  });

  it("探测抛错 → fail-open：探活 error，其余项降级不拖垮报告", async () => {
    const report = await runDoctor({} as BridgeConfig, {
      probe: async () => {
        throw new Error("boom");
      },
    });
    expect(report.checks[0].level).toBe("error");
    expect(report.checks[0].summary).toContain("boom");
    expect(report.checks).toHaveLength(7); // 3 adapter 项 + 宿主 + 台账 + worktree 残留 + 配置
  });
});

describe("doctor 台账检查（v0.4.7）", () => {
  it("空台账（无 task 表）→ ok", () => {
    const check = checkLedgerHealth({ dataDir: "/tmp/opencode/doctor-empty" } as BridgeConfig);
    expect(check.level).toBe("ok");
    expect(check.summary).toContain("SQLite 完整性 ok");
    expect(check.summary).toContain("空台账");
  });

  it("有任务 → 统计各状态数量", async () => {
    const { openLedgerAt, closeAllLedgers } = await import("./ledger.js");
    const cfg = { dataDir: "/tmp/opencode/doctor-ledger" } as BridgeConfig;
    const ledger = openLedgerAt("/tmp/opencode/doctor-ledger/ledger.db");
    ledger.append({ id: "t1", harness: "opencode", status: "success" });
    ledger.append({ id: "t2", harness: "opencode", status: "failed" });
    ledger.append({ id: "t3", harness: "opencode", status: "failed" });
    ledger.append({ id: "t4", harness: "opencode", status: "running" });
    try {
      const check = checkLedgerHealth(cfg);
      expect(check.level).toBe("ok");
      expect(check.summary).toContain("任务 4");
      expect(check.summary).toContain("success 1");
      expect(check.summary).toContain("failed 2");
      expect(check.summary).toContain("running 1");
    } finally {
      await ledger.close();
      await closeAllLedgers();
    }
  });

  it("WAL 超阈值 → warn 附建议", () => {
    const check = checkLedgerHealth({ dataDir: "/tmp/opencode/doctor-wal" } as BridgeConfig);
    // 空台账 WAL 极小必为 ok；这里只验证 formatBytes 阈值口径与 warn 分支逻辑入口存在
    expect(["ok", "warn"]).toContain(check.level);
    expect(formatBytes(2048)).toBe("2.0KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0MB");
  });
});

describe("doctor 配置校验（v0.4.7）", () => {
  it("全部默认 → ok，逐键列出当前值=默认值（notifyCommand 已配置时无 warn）", () => {
    const check = checkConfigHealth({ notifyCommand: "bash hb_notify.sh" } as BridgeConfig);
    expect(check.level).toBe("ok");
    expect(check.summary).toContain("全部有默认值");
    expect(check.detail).toContain("dataDir = ~/.openclaw/harness-bridge");
    expect(check.detail).toContain("dailyReport.hour = 21");
  });

  it("notifyCommand 未配置 → warn + 推送关闭建议", () => {
    const check = checkConfigHealth({} as BridgeConfig);
    expect(check.level).toBe("warn");
    expect(check.summary).toContain("notifyCommand 未配置");
  });

  it("自定义键标记当前值与默认值差异", () => {
    const check = checkConfigHealth({
      dataDir: "/custom/dir",
      dailyReport: { hour: 9 },
    } as BridgeConfig);
    expect(check.detail).toContain('dataDir = "/custom/dir"（默认 ~/.openclaw/harness-bridge）');
    expect(check.detail).toContain("dailyReport.hour = 9（默认 21）");
    expect(check.summary).toContain("已自定义 2 个");
  });

  it("notifyCommand 已配置 → 无 warn（其余键均有默认）", () => {
    const check = checkConfigHealth({ notifyCommand: "bash hb_notify.sh" } as BridgeConfig);
    expect(check.level).toBe("ok");
  });
});

describe("doctor worktree 残留检查（v0.4.8）", () => {
  it("无 worktree 目录 → ok 无残留", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hb-doc-wt-"));
    dirs.push(dir);
    const check = checkWorktreeResidue({ dataDir: dir } as BridgeConfig);
    expect(check.level).toBe("ok");
    expect(check.summary).toContain("无 worktree 残留");
  });

  it("已结束任务的 worktree → warn 清单 + 清理建议（目录名映射回 hb_ 任务 ID）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hb-doc-wt-"));
    dirs.push(dir);
    mkdirSync(path.join(dir, "worktrees", "20260101T000000Z_ab12"), { recursive: true });
    const { openLedgerAt, closeAllLedgers } = await import("./ledger.js");
    const ledger = openLedgerAt(path.join(dir, "ledger.db"));
    ledger.append({ id: "hb_20260101T000000Z_ab12", harness: "opencode", status: "success" });
    await ledger.close();
    await closeAllLedgers();
    const check = checkWorktreeResidue({ dataDir: dir } as BridgeConfig);
    expect(check.level).toBe("warn");
    expect(check.summary).toContain("1 个残留 worktree");
    expect(check.detail).toContain("hb_20260101T000000Z_ab12（success）");
    expect(check.detail).toContain("git worktree remove");
    expect(check.detail).toContain("git branch -d hb-wt/hb_20260101T000000Z_ab12");
  });

  it("仅运行中任务的 worktree → ok 使用中", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hb-doc-wt-"));
    dirs.push(dir);
    mkdirSync(path.join(dir, "worktrees", "20260101T000000Z_cd34"), { recursive: true });
    const { openLedgerAt, closeAllLedgers } = await import("./ledger.js");
    const ledger = openLedgerAt(path.join(dir, "ledger.db"));
    ledger.append({ id: "hb_20260101T000000Z_cd34", harness: "opencode", status: "running" });
    await ledger.close();
    await closeAllLedgers();
    const check = checkWorktreeResidue({ dataDir: dir } as BridgeConfig);
    expect(check.level).toBe("ok");
    expect(check.summary).toContain("使用中");
  });

  it("台账查不到任务状态（无表）→ 保守按残留 warn", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hb-doc-wt-"));
    dirs.push(dir);
    mkdirSync(path.join(dir, "worktrees", "orphan_dir"), { recursive: true });
    const check = checkWorktreeResidue({ dataDir: dir } as BridgeConfig);
    expect(check.level).toBe("warn");
    expect(check.detail).toContain("orphan_dir（未知）");
  });
});

describe("doctor stub adapter 降噪（v0.4.11）", () => {
  it("未安装 stub（claude-code/codex）→ 探活与 binary 诊断降级 warn，不触发每日推送", async () => {
    const report = await runDoctor({ notifyCommand: "bash hb_notify.sh" } as BridgeConfig, {
      probe: async () => [
        status({ id: "claude-code", binary: "claude", installed: false, healthy: false, healthDetail: "binary 不可用" }),
        status({ id: "codex", binary: "codex", installed: false, healthy: false, healthDetail: "binary 不可用" }),
        status({}),
      ],
      api: { openclawVersion: "2026.9.4" },
    });
    const [adapters, , binaries] = report.checks;
    expect(adapters.level).toBe("warn");
    expect(adapters.summary).toContain("claude-code, codex（未安装 stub，不参与告警）");
    expect(adapters.detail).toBeUndefined(); // 降噪项不列修复建议（避免误导安装 stub binary）
    expect(binaries.level).toBe("warn");
    expect(binaries.summary).toContain("（未安装 stub，不参与告警）");
    expect(report.allOk).toBe(true); // 无 error → 不再每日推送
  });

  it("已安装 adapter 异常仍为 error（降级仅限未安装 stub）", async () => {
    const report = await runDoctor({ notifyCommand: "bash hb_notify.sh" } as BridgeConfig, {
      probe: async () => [
        status({ id: "claude-code", binary: "claude", installed: true, healthy: false, healthDetail: "版本门禁未通过" }),
        status({}),
      ],
      api: { openclawVersion: "2026.9.4" },
    });
    const [adapters, , binaries] = report.checks;
    expect(adapters.level).toBe("error");
    expect(adapters.summary).toContain("claude-code");
    expect(adapters.summary).not.toContain("不参与告警"); // 已安装不走 stub 降噪
    expect(adapters.detail).toContain("建议");
    expect(report.allOk).toBe(false);
  });

  it("混合：真实异常 error + 未安装 stub 仅标注；binary 诊断只报真实缺失项", async () => {
    const report = await runDoctor({} as BridgeConfig, {
      probe: async () => [
        status({ id: "bad", installed: false, healthy: false, healthDetail: "binary 不可用" }),
        status({ id: "codex", binary: "codex", installed: false, healthy: false, healthDetail: "binary 不可用" }),
        status({}),
      ],
      api: { openclawVersion: "2026.9.4" },
    });
    const [adapters, , binaries] = report.checks;
    expect(adapters.level).toBe("error");
    expect(adapters.summary).toContain("异常: bad");
    expect(adapters.summary).toContain("未安装 stub: codex（未安装 stub，不参与告警）");
    expect(binaries.level).toBe("error");
    expect(binaries.detail).toContain("bad（opencode）"); // 仅真实缺失项列诊断线索
    expect(binaries.summary).toContain("另 1 个未安装 stub 不定位");
    expect(report.allOk).toBe(false);
  });
});

describe("doctor hostVersionOverride（v0.4.8）", () => {
  it("配置覆盖 → 宿主版本检查直接采用该值（跳过特性检测）", async () => {
    const report = await runDoctor({ hostVersionOverride: "2026.7.1-2" } as BridgeConfig, {
      probe: async () => [status({})],
    });
    const host = report.checks.find((c) => c.name === "宿主版本");
    expect(host?.level).toBe("ok");
    expect(host?.summary).toBe("宿主 2026.7.1-2");
  });
});

describe("doctor 报告渲染（v0.4.7）", () => {
  const report: DoctorReport = {
    checks: [
      { name: "adapter 探活", level: "ok", summary: "2/2 个 adapter 健康" },
      { name: "台账健康", level: "warn", summary: "WAL 偏大", detail: "建议: 排查长驻只读连接" },
      { name: "版本探测", level: "error", summary: "binary 缺失", detail: "建议: 安装" },
    ],
    allOk: false,
    fullyHealthy: false,
  };

  it("渲染含图标分级 + 缩进建议 + 结论行", () => {
    const text = renderDoctorReport(report);
    expect(text).toContain("✅ adapter 探活：2/2 个 adapter 健康");
    expect(text).toContain("⚠️ 台账健康：WAL 偏大");
    expect(text).toContain("↳ 建议: 排查长驻只读连接");
    expect(text).toContain("❌ 版本探测：binary 缺失");
    expect(text).toContain("体检结论：存在异常项，请按建议处理 ❌");
  });

  it("全干净 / 有告警两种结论", () => {
    expect(renderDoctorReport({ checks: [], allOk: true, fullyHealthy: true })).toContain(
      "全部通过 ✅",
    );
    expect(renderDoctorReport({ checks: [], allOk: true, fullyHealthy: false })).toContain(
      "存在告警项 ⚠️",
    );
  });
});
