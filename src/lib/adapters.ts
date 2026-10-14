import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 插件包根目录（本文件编译后在 dist/lib/，回退两级到包根） */
export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface AdapterDelegate {
  /** 启动新任务的 argv 模板，支持 {prompt} 占位 */
  run: string[];
  /** 续接会话的 argv 模板，支持 {sessionId}/{prompt} 占位（可选） */
  resume?: string[];
  /** 默认超时毫秒 */
  timeoutMs?: number;
}

export interface AdapterModelConfig {
  /** harness 模型配置文件路径（支持 ~） */
  path: string;
  /** 配置格式；MVP 支持 "opencode-json" */
  format: string;
  /** 模型清单 JSON Pointer，如 "$.provider.*.models" */
  modelsPointer?: string;
  /** 参数字典键 → 配置文件字段名映射（声明即全量，未声明的字典键不写回） */
  fieldMap?: Record<string, string>;
  /** 默认模型 JSON Pointer，如 "$.model" */
  defaultModelPointer?: string;
}

export interface AdapterMountConfig {
  /** harness 配置文件路径（支持 ~） */
  configPath: string;
  /** 配置格式；MVP 仅支持 "opencode-json" */
  format: string;
  /** 目录放行 map 的 JSON Pointer，如 "$.permission.external_directory" */
  externalDirectoryPointer?: string;
  /** instructions 数组的 JSON Pointer，如 "$.instructions" */
  instructionsPointer?: string;
}

export interface Adapter {
  id: string;
  displayName: string;
  description?: string;
  binary: string;
  versionCheck?: string[];
  delegate: AdapterDelegate;
  config?: { modelConfig?: AdapterModelConfig; mount?: AdapterMountConfig };
  session?: { idPattern?: string };
}

export interface BridgeConfig {
  dataDir?: string;
  adaptersDir?: string;
  paramsFile?: string;
  notifyCommand?: string;
  defaultTimeoutMs?: number;
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

export function resolveDataDir(cfg: BridgeConfig): string {
  const dir = expandHome(cfg.dataDir ?? "~/.openclaw/harness-bridge");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 内置 adapter（包内 adapters/）+ 用户 adapter（数据目录 adapters/，同名文件覆盖内置）。
 * 单个坏文件跳过，不拖垮整个插件。
 */
export function listAdapters(cfg: BridgeConfig): Adapter[] {
  const dirs = [path.join(PKG_ROOT, "adapters")];
  dirs.push(expandHome(cfg.adaptersDir ?? path.join(resolveDataDir(cfg), "adapters")));
  const byId = new Map<string, Adapter>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
      try {
        const a = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as Adapter;
        if (a && typeof a.id === "string" && Array.isArray(a.delegate?.run) && a.delegate.run.length > 0) {
          byId.set(a.id, a);
        }
      } catch {
        // 跳过无法解析的 adapter 文件
      }
    }
  }
  return [...byId.values()];
}

export function getAdapter(cfg: BridgeConfig, id: string): Adapter | undefined {
  return listAdapters(cfg).find((a) => a.id === id);
}

export interface AdapterHealth {
  installed: boolean;
  version?: string;
  configFileExists?: boolean | null;
}

export function checkHealth(a: Adapter): AdapterHealth {
  const argv = a.versionCheck?.length ? a.versionCheck : [a.binary, "--version"];
  let installed = false;
  let version: string | undefined;
  try {
    const r = spawnSync(argv[0], argv.slice(1), { timeout: 5000, encoding: "utf8" });
    if (!r.error) {
      installed = true;
      version = (r.stdout || r.stderr || "").trim().split("\n")[0] || "ok";
    } else if ((r.error as NodeJS.ErrnoException).code === "ENOENT") {
      installed = false;
    } else {
      installed = true;
      version = `error: ${r.error.message}`;
    }
  } catch {
    installed = false;
  }
  let configFileExists: boolean | null = null;
  const mc = a.config?.modelConfig;
  if (mc?.path) configFileExists = existsSync(expandHome(mc.path));
  return { installed, version, configFileExists };
}
