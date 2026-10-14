import { existsSync, readFileSync } from "node:fs";
import { expandHome, type Adapter } from "./adapters.js";
import { setAtPath, walkPointer } from "./params.js";
import { backupAndWrite } from "./sync.js";

export interface MountChange {
  field: string;
  from: unknown;
  to: unknown;
}

export interface MountReport {
  harness: string;
  configFile: string;
  changes: MountChange[];
  skipped: string[];
  applied: boolean;
  backupFile?: string;
  error?: string;
}

/**
 * 把共享知识库目录挂载进指定 harness 的配置：
 * external_directory 放行 map + instructions 注入入口文件。
 * 默认只出报告（dry-run）；apply=true 字段级写回（自动备份 + 写后验证）。
 */
export function mountAdapterKnowledge(
  adapter: Adapter,
  opts: { path: string; inject?: string; apply: boolean },
): MountReport {
  const mount = adapter.config?.mount;
  const report: MountReport = {
    harness: adapter.id,
    configFile: mount?.configPath ?? "",
    changes: [],
    skipped: [],
    applied: false,
  };
  if (!mount?.configPath) {
    report.error = "adapter 未配置 mount";
    return report;
  }
  if (mount.format !== "opencode-json") {
    report.error = `MVP 仅支持 opencode-json 格式，当前格式: ${mount.format}`;
    return report;
  }
  const file = expandHome(mount.configPath);
  report.configFile = file;
  if (!existsSync(file)) {
    report.error = `配置文件不存在: ${file}`;
    return report;
  }
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    report.error = `配置文件解析失败: ${(e as Error).message}`;
    return report;
  }

  if (mount.externalDirectoryPointer) {
    const hits = walkPointer(json, mount.externalDirectoryPointer);
    const hit = hits[0]?.value;
    let map: Record<string, unknown>;
    if (hit && typeof hit === "object" && !Array.isArray(hit)) {
      map = hit as Record<string, unknown>;
    } else {
      map = {};
      setAtPath(json, mount.externalDirectoryPointer, map);
    }
    if (map[opts.path] === "allow") {
      report.skipped.push(`external_directory:${opts.path}`);
    } else {
      report.changes.push({
        field: `external_directory.${opts.path}`,
        from: map[opts.path] ?? null,
        to: "allow",
      });
      if (opts.apply) map[opts.path] = "allow";
    }
  }

  if (mount.instructionsPointer && opts.inject) {
    const target = `${opts.path}/${opts.inject}`;
    const hits = walkPointer(json, mount.instructionsPointer);
    const hit = hits[0]?.value;
    let list: unknown[];
    if (Array.isArray(hit)) {
      list = hit;
    } else {
      list = [];
      setAtPath(json, mount.instructionsPointer, list);
    }
    if (list.includes(target)) {
      report.skipped.push(`instructions:${target}`);
    } else {
      report.changes.push({ field: "instructions", from: null, to: target });
      if (opts.apply) list.push(target);
    }
  }

  if (opts.apply && report.changes.length > 0) {
    report.backupFile = backupAndWrite(file, json);
    report.applied = true;
  }
  return report;
}
