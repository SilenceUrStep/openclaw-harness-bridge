import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendStatusLine,
  buildStatusLine,
  clearTaskboardCache,
  formatStatusLine,
  ledgerRunningItems,
  processAlive,
  taskboardRunningItems,
} from "./statusline.js";
import { openLedgerAt } from "./ledger.js";

describe("formatStatusLine", () => {
  it("无任务", () => {
    expect(formatStatusLine([])).toBe("后台任务：无");
  });

  it("有任务带耗时", () => {
    expect(formatStatusLine([{ name: "opencode·编码", detail: "42m" }])).toBe(
      "后台任务：1个（opencode·编码（42m））",
    );
  });

  it("超过5个截断加等", () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ name: `t${i}` }));
    const line = formatStatusLine(items);
    expect(line).toContain("7个");
    expect(line).toContain("等");
    expect(line).not.toContain("t5");
  });
});

describe("ledgerRunningItems", () => {
  it("running 且 pid 存活才计入", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hb-sl-"));
    const dbPath = path.join(dir, "ledger.db");
    const { spawn } = await import("node:child_process");
    const child = spawn("sleep", ["5"]);
    const ledger = openLedgerAt(dbPath);
    ledger.append({
      id: "t1",
      harness: "opencode",
      prompt: "编码任务测试",
      status: "running",
      pid: child.pid,
      startedAt: new Date().toISOString(),
    });
    ledger.append({
      id: "t2",
      harness: "opencode",
      prompt: "死任务",
      status: "running",
      pid: 2147400000,
      startedAt: new Date().toISOString(),
    });
    ledger.append({
      id: "t3",
      harness: "opencode",
      prompt: "无pid任务",
      status: "running",
      startedAt: new Date().toISOString(),
    });
    const items = ledgerRunningItems({ ledgerDbPath: dbPath });
    child.kill();
    const names = items.map((i) => i.name);
    expect(names).toHaveLength(2);
    expect(names.some((n) => n.includes("opencode·编码任务测试"))).toBe(true);
    expect(names.some((n) => n.includes("opencode·无pid任务"))).toBe(true);
    expect(names.some((n) => n.includes("死任务"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("taskboardRunningItems", () => {
  it("解析进行中段顶层条目", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hb-sl-"));
    const file = path.join(dir, "taskboard.md");
    writeFileSync(
      file,
      [
        "# 任务台账",
        "",
        "## 🔄 进行中",
        "",
        "- **编码任务**（运行中）",
        "  - 缩进子项不计",
        "",
        "## 📋 待办",
        "",
        "- ⏳ 等待审核",
      ].join("\n"),
    );
    const items = taskboardRunningItems(file);
    expect(items).toHaveLength(1);
    expect(items[0].name).toContain("编码任务");
    rmSync(dir, { recursive: true, force: true });
  });

  it("进行中为（无）返回空", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hb-sl-"));
    const file = path.join(dir, "taskboard.md");
    writeFileSync(file, "# 任务台账\n\n## 🔄 进行中\n\n（无）\n\n## 📋 待办\n");
    expect(taskboardRunningItems(file)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("appendStatusLine", () => {
  it("追加状态行", () => {
    expect(appendStatusLine("你好", "后台任务：无")).toBe("你好\n后台任务：无");
  });

  it("已有状态行尊重原文", () => {
    expect(appendStatusLine("你好\n后台任务：1个（x）", "后台任务：无")).toBe(
      "你好\n后台任务：1个（x）",
    );
  });

  it("NO_REPLY 跳过", () => {
    expect(appendStatusLine("NO_REPLY", "后台任务：无")).toBe("NO_REPLY");
  });

  it("空内容跳过", () => {
    expect(appendStatusLine("", "后台任务：无")).toBe("");
    expect(appendStatusLine("  \n ", "后台任务：无")).toBe("  \n ");
  });

  it("MEDIA 行前插入", () => {
    expect(appendStatusLine("看图\n\nMEDIA:/tmp/a.png", "后台任务：无")).toBe(
      "看图\n后台任务：无\n\nMEDIA:/tmp/a.png",
    );
  });

  it("纯 MEDIA 消息也可插入", () => {
    expect(appendStatusLine("MEDIA:/tmp/a.png", "后台任务：无")).toBe(
      "后台任务：无\n\nMEDIA:/tmp/a.png",
    );
  });
});

describe("buildStatusLine", () => {
  it("双源合并", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hb-sl-"));
    const tb = path.join(dir, "taskboard.md");
    writeFileSync(tb, "# t\n\n## 🔄 进行中\n\n- 面板任务A\n");
    const line = buildStatusLine({ taskboardFile: tb });
    expect(line).toBe("后台任务：1个（面板任务A）");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("processAlive", () => {
  it("当前进程存活", () => {
    expect(processAlive(process.pid)).toBe(true);
  });
});

describe("taskboardRunningItems 缓存（v0.4.1）", () => {
  it("mtime 不变时走缓存，文件变化后重新读取", async () => {
    clearTaskboardCache();
    const dir = mkdtempSync(path.join(tmpdir(), "hb-sl-cache-"));
    const tb = path.join(dir, "taskboard.md");
    writeFileSync(tb, "## 🔄 进行中\n\n- 任务甲\n");
    expect(taskboardRunningItems(tb).map((i) => i.name)).toEqual(["任务甲"]);
    // 同内容重读（缓存命中路径）
    expect(taskboardRunningItems(tb).map((i) => i.name)).toEqual(["任务甲"]);
    // 修改文件（mtime 变化）→ 缓存失效重新读
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(tb, "## 🔄 进行中\n\n- 任务乙\n");
    const { utimesSync } = await import("node:fs");
    const now = new Date();
    utimesSync(tb, now, now); // 确保 mtime 变化
    expect(taskboardRunningItems(tb).map((i) => i.name)).toEqual(["任务乙"]);
    clearTaskboardCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("buildStatusLine 软超时预算：默认预算内双源合并正常", () => {
    clearTaskboardCache();
    const dir = mkdtempSync(path.join(tmpdir(), "hb-sl-budget-"));
    const tb = path.join(dir, "taskboard.md");
    writeFileSync(tb, "## 🔄 进行中\n\n- 预算任务\n");
    const line = buildStatusLine({ taskboardFile: tb }, 50);
    expect(line).toContain("预算任务");
    clearTaskboardCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("buildStatusLine 预算为 0 时跳过 taskboard 段（仍返回台账结果）", () => {
    clearTaskboardCache();
    const dir = mkdtempSync(path.join(tmpdir(), "hb-sl-budget0-"));
    const tb = path.join(dir, "taskboard.md");
    writeFileSync(tb, "## 🔄 进行中\n\n- 不该出现的任务\n");
    const line = buildStatusLine({ taskboardFile: tb }, 0);
    expect(line).toBe("后台任务：无");
    clearTaskboardCache();
    rmSync(dir, { recursive: true, force: true });
  });
});
