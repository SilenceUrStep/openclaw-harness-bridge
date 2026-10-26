import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { diagnoseBinary } from "./diagnose.js";

const dirs: string[] = [];
const savedPath = process.env.PATH;

function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), "hb-diag-"));
  dirs.push(d);
  return d;
}

afterAll(() => {
  process.env.PATH = savedPath;
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

afterEach(() => {
  process.env.PATH = savedPath;
});

describe("diagnoseBinary（v0.4.3 binary 探测诊断）", () => {
  it("PATH 中可定位：输出实际路径", () => {
    const d = tmp();
    writeFileSync(path.join(d, "toolx"), "#!/bin/sh\n");
    process.env.PATH = d;
    const out = diagnoseBinary("toolx");
    expect(out).toContain(`定位到可执行文件: ${path.join(d, "toolx")}`);
    expect(out).toContain(`当前 PATH=${d}`);
  });

  it("PATH 目录为悬空符号链接 → 直接提示根因（2026-10-25 nvm current 案例）", () => {
    const root = tmp();
    // current → versions/v24.21.0（该版本目录不存在 = 悬空）
    symlinkSync(path.join(root, "versions", "v24.21.0"), path.join(root, "current"));
    const binDir = path.join(root, "current", "bin");
    process.env.PATH = binDir;
    const out = diagnoseBinary("dsh");
    expect(out).toContain("悬空符号链接");
    expect(out).toContain(path.join(root, "versions", "v24.21.0"));
    expect(out).toContain("疑似原因");
    expect(out).toContain("PATH 中的");
  });

  it("PATH 候选本身是悬空链接 → 标注失效候选", () => {
    const d = tmp();
    symlinkSync(path.join(d, "missing-target"), path.join(d, "toolx"));
    process.env.PATH = d;
    const out = diagnoseBinary("toolx");
    expect(out).toContain("失效候选");
    expect(out).toContain("missing-target");
  });

  it("全未找到：含当前 PATH 与疑似原因（gateway 进程 PATH 提示）", () => {
    const d = tmp();
    process.env.PATH = d;
    const out = diagnoseBinary("no-such-binary-xyz");
    expect(out).toContain("PATH 中未找到 no-such-binary-xyz");
    expect(out).toContain(`当前 PATH=${d}`);
    expect(out).toContain("疑似原因");
  });

  it("PATH 之外定位到候选（nvm versions/bin）→ 给出实际路径", () => {
    const root = tmp();
    const savedHome = process.env.HOME;
    process.env.HOME = root; // scanCommonLocations 按 homedir() 扫描
    try {
      const vbin = path.join(root, ".nvm", "versions", "v24.21.0", "bin");
      mkdirSync(vbin, { recursive: true });
      writeFileSync(path.join(vbin, "tooly"), "#!/bin/sh\n");
      process.env.PATH = path.join(root, "empty-bin");
      mkdirSync(path.join(root, "empty-bin"), { recursive: true });
      const out = diagnoseBinary("tooly");
      expect(out).toContain(path.join(vbin, "tooly"));
      expect(out).toContain("PATH 之外");
    } finally {
      process.env.HOME = savedHome;
    }
  });
});
