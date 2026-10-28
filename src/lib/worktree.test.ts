import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  createWorktree,
  isGitRepo,
  listWorktreeTaskIds,
  planWorktree,
  worktreeDir,
  WORKTREE_BRANCH_PREFIX,
} from "./worktree.js";

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

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** 造一个真实 git 仓库（有初始提交，worktree add -b 才有 HEAD 可指） */
function gitRepo(): string {
  const dir = tmpDir("hb-wt-repo-");
  const git = (args: string[]): void => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  };
  git(["init"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  writeFileSync(path.join(dir, "README.md"), "# test\n");
  git(["add", "."]);
  git(["commit", "-m", "init"]);
  return dir;
}

describe("isGitRepo / 目录探测", () => {
  it("git 仓库内 → true；普通目录 → false", () => {
    const repo = gitRepo();
    const plain = tmpDir("hb-wt-plain-");
    expect(isGitRepo(repo)).toBe(true);
    expect(isGitRepo(plain)).toBe(false);
  });
});

describe("createWorktree（v0.4.8 worktree 隔离）", () => {
  it("创建成功：目录与分支命名 hb-wt/<taskId>，基于 HEAD，git worktree list 可见", () => {
    const repo = gitRepo();
    const dataDir = tmpDir("hb-wt-data-");
    const taskId = "hb_20260101T000000Z_ab12";
    const r = createWorktree({ baseCwd: repo, dataDir, taskId });
    expect(r.ok).toBe(true);
    expect(r.branch).toBe("hb-wt/hb_20260101T000000Z_ab12");
    expect(r.path).toBe(path.join(worktreeDir(dataDir), "20260101T000000Z_ab12"));
    expect(existsSync(r.path!)).toBe(true);
    // 分支名核对
    const br = spawnSync("git", ["-C", r.path!, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" });
    expect(br.stdout.trim()).toBe("hb-wt/hb_20260101T000000Z_ab12");
    // 主仓库 worktree list 能看到
    const list = spawnSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf8" });
    expect(list.stdout).toContain(r.path!);
    // 产出落专属分支：worktree 内 HEAD 与主仓库 HEAD 同一提交（基于 HEAD 创建）
    const baseHead = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    const wtHead = spawnSync("git", ["-C", r.path!, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    expect(wtHead).toBe(baseHead);
    // 目录清单返回短名（去 hb_ 前缀）
    expect(listWorktreeTaskIds(dataDir)).toEqual(["20260101T000000Z_ab12"]);
  });

  it("同名分支/目录已存在时创建失败：ok:false + 中文原因（不抛错）", () => {
    const repo = gitRepo();
    const dataDir = tmpDir("hb-wt-data2-");
    const taskId = "hb_20260101T000000Z_cd34";
    const first = createWorktree({ baseCwd: repo, dataDir, taskId });
    expect(first.ok).toBe(true);
    const second = createWorktree({ baseCwd: repo, dataDir, taskId });
    expect(second.ok).toBe(false);
    expect(second.reason).toContain("git worktree add 失败");
  });
});

describe("planWorktree 决策", () => {
  const dataDir = path.join(tmpDir("hb-wt-plan-"));
  const repo = gitRepo();
  const plain = tmpDir("hb-wt-plain2-");

  it("未请求 → skip（零副作用）", () => {
    expect(planWorktree({ requested: false, enabled: true, cwd: repo, dataDir })).toEqual({ action: "skip" });
  });

  it("请求但开关关闭 → degrade（worktree.enabled 默认 false）", () => {
    const r = planWorktree({ requested: true, enabled: false, cwd: repo, dataDir });
    expect(r.action).toBe("degrade");
    if (r.action === "degrade") expect(r.reason).toContain("worktree.enabled");
  });

  it("请求且开启但无 cwd → degrade", () => {
    const r = planWorktree({ requested: true, enabled: true, dataDir });
    expect(r.action).toBe("degrade");
  });

  it("非 git 仓库 → degrade（普通执行 + 原因）", () => {
    const r = planWorktree({ requested: true, enabled: true, cwd: plain, dataDir });
    expect(r.action).toBe("degrade");
    if (r.action === "degrade") expect(r.reason).toContain("不是 git 仓库");
  });

  it("请求 + 开启 + git 仓库 → create（显式 taskId 时目录名去 hb_ 前缀，分支全名）", () => {
    const r = planWorktree({ requested: true, enabled: true, cwd: repo, dataDir, taskId: "hb_test456" });
    expect(r).toEqual({
      action: "create",
      taskId: "hb_test456",
      path: path.join(worktreeDir(dataDir), "test456"),
      branch: `${WORKTREE_BRANCH_PREFIX}hb_test456`,
    });
  });

  it("create 决策缺省 taskId 时自动生成 hb_ 前缀新 ID", () => {
    const r = planWorktree({ requested: true, enabled: true, cwd: repo, dataDir });
    expect(r.action).toBe("create");
    if (r.action === "create") expect(r.taskId).toMatch(/^hb_/);
  });
});
