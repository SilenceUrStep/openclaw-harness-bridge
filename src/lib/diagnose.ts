import { existsSync, lstatSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * v0.4.3 binary 探测诊断：binary 未找到时给出可行动的线索——
 * 当前 PATH、实际定位到的候选路径、悬空符号链接根因（如
 * 2026-10-25 真实案例：~/.nvm/current → v24.21.0 悬空链接导致 dsh 探测失败）。
 */

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

/** 解析符号链接目标（绝对化），返回 null 表示非符号链接 */
function linkTarget(p: string): string | null {
  try {
    const st = lstatSync(p);
    if (!st.isSymbolicLink()) return null;
    return path.resolve(path.dirname(p), readlinkSync(p));
  } catch {
    return null;
  }
}

/** 候选路径是否可用（存在且非目录；悬空链接返回 {dangling: 目标}） */
function inspectCandidate(
  p: string,
): { kind: "ok" } | { kind: "dangling"; target: string } | { kind: "missing" } {
  let target: string | null = null;
  try {
    target = linkTarget(p);
  } catch {
    return { kind: "missing" };
  }
  if (target && !existsSync(target)) return { kind: "dangling", target };
  try {
    const st = statSync(p);
    if (st.isDirectory()) return { kind: "missing" };
    return { kind: "ok" };
  } catch {
    return { kind: "missing" };
  }
}

/** PATH 目录依赖的悬空符号链接（含祖先链，如 PATH=/root/.nvm/current/bin 而 current → 已卸载版本） */
function danglingPathDirs(pathEntries: string[]): string[] {
  const out: string[] = [];
  const reported = new Set<string>();
  for (const dir of pathEntries) {
    if (!dir) continue;
    // 自下而上走祖先链：PATH 条目本身往往不是链接，悬空的是其祖先（nvm current 形态）
    let cur = path.resolve(dir);
    for (;;) {
      const target = linkTarget(cur);
      if (target && !existsSync(target) && !reported.has(cur)) {
        reported.add(cur);
        out.push(
          `PATH 中的 ${dir} 依赖悬空符号链接 ${cur}（→ ${target} 不存在，指向的版本可能已被卸载或未安装）`,
        );
        break;
      }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  return out;
}

/** 常见安装位置扫描：PATH 找不到时，binary 若装在别处给出实际路径 */
function scanCommonLocations(binary: string, pathEntries: string[]): string[] {
  const notes: string[] = [];
  const inPath = new Set(pathEntries);
  const home = homedir();
  const nvmVersionsBin = path.join(home, ".nvm", "versions");
  const extraDirs: string[] = [];
  try {
    for (const v of readdirSync(nvmVersionsBin)) {
      extraDirs.push(path.join(nvmVersionsBin, v, "bin"));
    }
  } catch {
    // 无 nvm
  }
  extraDirs.push(path.join(home, ".local", "bin"), path.join(home, "bin"), "/usr/local/bin", "/usr/bin");
  const found: string[] = [];
  const dangling: string[] = [];
  for (const dir of extraDirs) {
    if (inPath.has(dir)) continue;
    const candidate = path.join(dir, binary);
    const r = inspectCandidate(candidate);
    if (r.kind === "ok") found.push(candidate);
    else if (r.kind === "dangling") dangling.push(`${candidate}（悬空链接 → ${r.target}）`);
  }
  if (found.length) notes.push(`在 PATH 之外定位到候选: ${found.join(", ")}（可修复 PATH 或用绝对路径配置 adapter）`);
  if (dangling.length) notes.push(`PATH 之外发现失效候选: ${dangling.join(", ")}`);
  return notes;
}

/**
 * 生成诊断文本（单行，用「；」分隔，直接可附在 harness_list healthDetail 后）。
 * 仅做只读探测，绝不执行 binary。
 */
export function diagnoseBinary(binary: string): string {
  const parts: string[] = [];
  const pathEnv = process.env.PATH ?? "";
  const pathEntries = pathEnv.split(path.delimiter).filter(Boolean);

  const inPathOk: string[] = [];
  const inPathDangling: string[] = [];
  for (const dir of pathEntries) {
    const candidate = path.join(dir, binary);
    const r = inspectCandidate(candidate);
    if (r.kind === "ok") inPathOk.push(candidate);
    else if (r.kind === "dangling") inPathDangling.push(`${candidate}（悬空链接 → ${r.target}）`);
  }

  if (inPathOk.length) parts.push(`定位到可执行文件: ${inPathOk.join(", ")}`);
  if (inPathDangling.length) parts.push(`PATH 中存在失效候选: ${inPathDangling.join(", ")}`);
  if (!inPathOk.length && !inPathDangling.length) parts.push(`PATH 中未找到 ${binary}`);

  const danglingDirs = danglingPathDirs(pathEntries);
  parts.push(...danglingDirs);
  if (!inPathOk.length) parts.push(...scanCommonLocations(binary, pathEntries));

  parts.push(`当前 PATH=${pathEnv || "(空)"}`);
  if (danglingDirs.length) {
    parts.push("疑似原因：PATH 依赖的符号链接指向不存在的版本，修复链接（nvm install <版本> 或重新 ln -s）后恢复");
  } else if (!inPathOk.length) {
    parts.push("疑似原因：binary 未安装或不在宿主进程可见的 PATH 中（gateway 进程 PATH 可能与交互 shell 不同）");
  }
  return parts.join("；");
}
