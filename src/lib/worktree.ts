import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { newTaskId } from "./runner.js";

/**
 * v0.4.8 worktree 隔离：harness_run(worktree=true) 时在 <dataDir>/worktrees/<taskId>
 * 建立独立 git worktree（分支 hb-wt/<taskId>，基于当前 HEAD），任务在该目录内执行。
 * 任务结束后 worktree 保留（产出在专属分支上，供人工审查合并），不自动删除；
 * 残留检查交给 doctor（worktree residue check），清理由人工执行。
 */

/** worktree 专属分支前缀（分支名 = 前缀 + taskId） */
export const WORKTREE_BRANCH_PREFIX = "hb-wt/";

export interface WorktreeCreateResult {
  ok: boolean;
  path?: string;
  branch?: string;
  /** 失败原因（中文，与代码库错误文案风格一致），成功时不返回 */
  reason?: string;
}

/** cwd 是否为 git 仓库（工作树内均可，含子目录） */
export function isGitRepo(cwd: string): boolean {
  try {
    const r = spawnSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    return r.status === 0 && String(r.stdout ?? "").trim() === "true";
  } catch {
    return false;
  }
}

/** worktree 母目录：<dataDir>/worktrees */
export function worktreeDir(dataDir: string): string {
  return path.join(dataDir, "worktrees");
}

/** worktree 目录名/分支名共用的任务段：hb_20260101T000000Z_ab12 → 20260101T000000Z_ab12 */
function shortTaskId(taskId: string): string {
  return taskId.startsWith("hb_") ? taskId.slice(3) : taskId;
}

/**
 * 建立独立 worktree：git worktree add -b hb-wt/<taskId> <dataDir>/worktrees/<taskId>（基于 HEAD）。
 * 母目录不存在时先建；git 命令失败（含分支已存在等）返回 ok:false + 原因。
 */
export function createWorktree(opts: { baseCwd: string; dataDir: string; taskId: string }): WorktreeCreateResult {
  const dir = worktreeDir(opts.dataDir);
  const wtPath = path.join(dir, shortTaskId(opts.taskId));
  const branch = `${WORKTREE_BRANCH_PREFIX}${opts.taskId}`;
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { ok: false, reason: `创建 worktree 母目录失败：${(e as Error).message}` };
  }
  try {
    const r = spawnSync(
      "git",
      ["-C", opts.baseCwd, "worktree", "add", "-b", branch, wtPath],
      { encoding: "utf8", timeout: 30_000 },
    );
    if (r.status !== 0) {
      const detail = String(r.stderr ?? r.stdout ?? "").trim() || `exit ${r.status}`;
      return { ok: false, reason: `git worktree add 失败：${detail}` };
    }
  } catch (e) {
    return { ok: false, reason: `git worktree add 执行异常：${(e as Error).message}` };
  }
  return { ok: true, path: wtPath, branch };
}

/** 列出 worktree 母目录下已存在的任务目录名（doctor 残留检查用） */
export function listWorktreeTaskIds(dataDir: string): string[] {
  const dir = worktreeDir(dataDir);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export type WorktreeDecision =
  | { action: "skip" }
  | { action: "degrade"; reason: string }
  | { action: "create"; taskId: string; path: string; branch: string };

export interface PlanWorktreeOptions {
  /** 用户是否请求了 worktree（harness_run worktree 参数） */
  requested: boolean;
  /** 配置开关 cfg.worktree.enabled（默认 false） */
  enabled: boolean;
  /** 解析后的任务 cwd（无 cwd 无法判定是否 git 仓库） */
  cwd?: string;
  dataDir: string;
  taskId?: string;
}

/**
 * worktree 隔离决策：未请求 → skip；请求但未开开关/无 cwd/非 git 仓库 → degrade（带原因，任务照常执行）；
 * 通过 → create（先定 taskId 再建目录，保证分支名与任务 ID 一致）。
 * 注意：本函数只做决策，真正建目录由 createWorktree 完成（plan 不做副作用）。
 */
export function planWorktree(opts: PlanWorktreeOptions): WorktreeDecision {
  if (!opts.requested) return { action: "skip" };
  if (!opts.enabled) {
    return { action: "degrade", reason: "worktree 隔离未启用（worktree.enabled 默认 false）" };
  }
  if (!opts.cwd) {
    return { action: "degrade", reason: "任务无工作目录，无法建立 worktree" };
  }
  if (!isGitRepo(opts.cwd)) {
    return { action: "degrade", reason: `目录不是 git 仓库（${opts.cwd}），降级为普通执行` };
  }
  // 决策阶段只生成 taskId；createWorktree 失败时按同路径重试建一次由调用方处理
  const taskId = opts.taskId ?? newTaskId();
  const wtPath = path.join(worktreeDir(opts.dataDir), shortTaskId(taskId));
  return { action: "create", taskId, path: wtPath, branch: `${WORKTREE_BRANCH_PREFIX}${taskId}` };
}
