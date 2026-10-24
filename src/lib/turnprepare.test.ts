import { describe, expect, it, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { buildTurnContext } from "./turnprepare.js";
import { openLedgerAt, closeAllLedgers } from "./ledger.js";

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

function tmpSources() {
  const dir = mkdtempSync(path.join(tmpdir(), "hb-tp-"));
  dirs.push(dir);
  return {
    dir,
    sources: {
      ledgerDbPath: path.join(dir, "ledger.db"),
      taskboardFile: path.join(dir, "taskboard.md"),
    },
  };
}

describe("buildTurnContext", () => {
  it("无任务返回 undefined（零注入）", () => {
    const { sources } = tmpSources();
    expect(buildTurnContext(sources)).toBeUndefined();
  });

  it("台账 running 任务注入清单", async () => {
    const { sources } = tmpSources();
    const ledger = openLedgerAt(sources.ledgerDbPath!);
    const { spawn: sp } = { spawn };
    const child = sp("sleep", ["5"]);
    ledger.append({
      id: "hb_test_tp1",
      harness: "opencode",
      prompt: "修复登录bug",
      status: "running",
      transport: "cli",
      startedAt: new Date().toISOString(),
      pid: child.pid,
    });
    const ctx = buildTurnContext(sources);
    expect(ctx).toBeDefined();
    expect(ctx).toContain("后台任务 1 个");
    expect(ctx).toContain("opencode·");
    expect(ctx).toContain("harness_status");
    child.kill("SIGKILL");
  });

  it("taskboard 进行中段合并注入", () => {
    const { sources } = tmpSources();
    writeFileSync(
      sources.taskboardFile!,
      "# 任务台账\n\n## 🔄 进行中\n\n- **测试任务A**（进行中）\n- **测试任务B**\n\n## ✅ 已完成\n\n- 旧任务\n",
    );
    const ctx = buildTurnContext(sources);
    expect(ctx).toBeDefined();
    expect(ctx).toContain("测试任务A");
    expect(ctx).toContain("测试任务B");
    expect(ctx).not.toContain("旧任务");
  });

  it("maxItems 截断并提示总数", () => {
    const { sources } = tmpSources();
    writeFileSync(
      sources.taskboardFile!,
      "## 🔄 进行中\n\n- 任务1\n- 任务2\n- 任务3\n- 任务4\n- 任务5\n- 任务6\n- 任务7\n",
    );
    const ctx = buildTurnContext({ ...sources, maxItems: 3 });
    expect(ctx).toContain("共 7 个");
    expect(ctx).toContain("- 任务3");
    expect(ctx).not.toContain("- 任务4");
  });
});
