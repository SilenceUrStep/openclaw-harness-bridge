import { describe, expect, it, afterAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  registerDispatch,
  bindTaskId,
  removeEntry,
  pruneFinished,
} from "./taskboard-auto.js";

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

function tmpTaskboard(initial = "# 任务台账\n\n## 🔄 进行中\n\n- 手写任务A\n"): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hb-tba-"));
  dirs.push(dir);
  const file = path.join(dir, "taskboard.md");
  writeFileSync(file, initial);
  return file;
}

describe("taskboard-auto（v0.4.2 自动登记）", () => {
  it("registerDispatch：无自动段时创建段并追加条目，手写内容保留", () => {
    const file = tmpTaskboard();
    const key = registerDispatch(file, "opencode", "修复登录bug 很长的描述".repeat(3));
    expect(key).toBeTruthy();
    const text = readFileSync(file, "utf8");
    expect(text).toContain("## 🤖 自动登记");
    expect(text).toMatch(/- \[auto:pending:\w+\] opencode·修复登录bug.{0,35}（\d{2}:\d{2}派发）/);
    expect(text).toContain("手写任务A"); // 手写内容不受影响
    expect(text).toContain("# 任务台账");
  });

  it("registerDispatch：已有自动段时直接追加", () => {
    const file = tmpTaskboard("# t\n\n## 🤖 自动登记\n\n- [auto:old] 旧条目\n");
    const key = registerDispatch(file, "dsh", "跑测试");
    expect(key).toBeTruthy();
    const text = readFileSync(file, "utf8");
    expect(text).toContain("[auto:old]");
    expect(text).toMatch(/- \[auto:pending:\w+\] dsh·跑测试/);
  });

  it("bindTaskId：pending 条目绑定真实 taskId", () => {
    const file = tmpTaskboard();
    const key = registerDispatch(file, "opencode", "任务X") as string;
    expect(bindTaskId(file, key, "hb_20261024T035722Z_2jlw")).toBe(true);
    const text = readFileSync(file, "utf8");
    expect(text).toContain("[auto:hb_20261024T035722Z_2jlw]");
    expect(text).not.toContain(`[auto:pending:${key}]`);
  });

  it("removeEntry：移除 pending 条目（派发失败不留痕）", () => {
    const file = tmpTaskboard();
    const key = registerDispatch(file, "opencode", "任务Y") as string;
    expect(removeEntry(file, key)).toBe(true);
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain(`[auto:pending:${key}]`);
  });

  it("pruneFinished：终态条目删除、pending 保留、alive 保留", () => {
    const file = tmpTaskboard(
      "# t\n\n## 🤖 自动登记\n\n- [auto:hb_done1] 已完成任务\n- [auto:pending:xyz123] 派发中任务\n- [auto:hb_alive1] 运行中任务\n",
    );
    const removed = pruneFinished(file, new Set(["hb_alive1"]));
    expect(removed).toBe(1);
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain("hb_done1");
    expect(text).toContain("[auto:pending:xyz123]");
    expect(text).toContain("hb_alive1");
  });

  it("fail-open：文件不存在时不抛错", () => {
    const ghost = path.join(tmpdir(), `hb-ghost-${Date.now()}.md`);
    expect(registerDispatch(ghost, "opencode", "p")).toBeTruthy(); // 目录存在则可写
    expect(bindTaskId(ghost, "nokey", "hb_x")).toBe(false);
    expect(removeEntry(ghost, "nokey")).toBe(false);
    expect(pruneFinished(ghost, new Set())).toBe(0);
    if (existsSync(ghost)) rmSync(ghost, { force: true });
  });

  it("原子写：不留 .hbtmp 临时文件", () => {
    const file = tmpTaskboard();
    registerDispatch(file, "opencode", "原子性检查");
    expect(existsSync(`${file}.hbtmp`)).toBe(false);
  });
});
