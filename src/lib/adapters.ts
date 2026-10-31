import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PermissionAskConfig } from "./permission.js";
import type { WakeAgentOptions } from "./wake-agent.js";

/** 插件包根目录（本文件编译后在 dist/lib/，回退两级到包根） */
export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface AdapterDelegate {
  /** 启动新任务的 argv 模板，支持 {prompt} 占位 */
  run: string[];
  /** 续接会话的 argv 模板，支持 {sessionId}/{prompt} 占位（可选） */
  resume?: string[];
  /**
   * fork-before-retry（可选）：http 型为端点配置（如 {path:"/session/{sessionId}/fork"}）；
   * cli 型为 argv 模板，输出需含新会话 ID（按 session.idPattern 提取）
   */
  fork?: string | string[] | { path?: string };
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

/** dsh-patch 模型同步配置（patchFile 相对 dataDir；DSH_HOME = <dataDir>/dsh-home） */
export interface DshModelSyncConfig {
  format: "dsh-patch";
  patchFile: string;
  gateway: {
    providerId: string;
    displayName: string;
    api: string;
    baseURL: string;
    apiKeyEnv: string;
  };
  models: string[];
  defaultModel?: { provider: string; model: string };
}

export interface Adapter {
  id: string;
  displayName: string;
  description?: string;
  binary: string;
  /** v0.4.3 能力路由：本 adapter 擅长的任务类型（如 coding/general/analysis/search） */
  capabilities?: string[];
  /** adapter schema 版本；v1 文件无此字段 = 缺省 1（无 transport 字段即 cli 模式） */
  schemaVersion?: number;
  /** 版本门禁（http / stdio-rpc transport 通用）：越界显性拒绝执行 */
  versionGate?: { min?: string; max?: string };
  /** dsh SDK 握手参数（initialize 的 provider/model；env DSH_PROVIDER/DSH_MODEL 可覆盖） */
  sdk?: {
    provider?: string;
    model?: string;
    reasoningEffort?: string;
    maxTokens?: number;
  };
  /** dsh 模型配置同步（dsh-patch 格式，与 opencode 的 config.modelConfig 互斥使用） */
  modelSync?: DshModelSyncConfig;
  versionCheck?: string[];
  delegate: AdapterDelegate;
  config?: { modelConfig?: AdapterModelConfig; mount?: AdapterMountConfig };
  session?: { idPattern?: string };
}

/** v0.4.3 路由规则：taskType → harness 覆盖（优先级高于 capabilities 匹配） */
export interface RoutingRule {
  taskType: string;
  harness: string;
  /** 规则级降级链（覆盖 routing.fallback 中该 harness 的配置） */
  fallback?: string[];
}

/** v0.4.3 能力路由配置段 */
export interface RoutingConfig {
  /** 默认 harness（未显式指定且 taskType 无匹配时使用） */
  default?: string;
  /** taskType → harness 路由规则覆盖 */
  rules?: RoutingRule[];
  /** harness → 降级链（重试耗尽且 harness 不可用时依次尝试） */
  fallback?: Record<string, string[]>;
  /** 任务失败后同 harness 自动重试次数，默认 1，0 关闭 */
  retryAttempts?: number;
}

/** v0.4.3 定时探活配置段 */
export interface WatchdogConfig {
  enabled?: boolean;
  /** 探活间隔毫秒，默认 300000（5 分钟） */
  intervalMs?: number;
}

/** http 任务超时两级判定配置段（SSE 静默核查 + 总时长兜底） */
export interface RunTimeoutsConfig {
  /** SSE 流静默核查阈值毫秒，默认 300000（5 分钟），0=禁用静默核查 */
  idleTimeoutMs?: number;
  /** 总时长兜底毫秒，默认 7200000（2 小时），0=禁用兜底；替代旧 delegate.timeoutMs 一刀切语义 */
  maxDurationMs?: number;
  /** 连续会话核查仍 running 的告警阈值次数，默认 3 */
  sessionCheckMaxRetries?: number;
}

/** v0.4.6 台账日报推送配置段 */
export interface DailyReportConfig {
  /** 默认开启（false 关闭） */
  enabled?: boolean;
  /** 推送时刻（Asia/Shanghai 小时），默认 21 点，到达即发（当日仅一次） */
  hour?: number;
}

/** v0.4.8 worktree 隔离配置段 */
export interface WorktreeConfig {
  /** 默认关闭：开启后 harness_run 传 worktree=true 才会建立独立 git worktree */
  enabled?: boolean;
}

/** v0.4.8 doctor 定时体检配置段 */
export interface DoctorScheduleConfig {
  /** 默认开启（false 关闭定时体检） */
  enabled?: boolean;
  /** 体检时刻（Asia/Shanghai 小时），默认 8 点，到达即检（当日仅一次） */
  hour?: number;
}

export interface BridgeConfig {
  dataDir?: string;
  adaptersDir?: string;
  paramsFile?: string;
  notifyCommand?: string;
  /** v0.4.4 全局兜底工作空间：harness_run 未传 cwd 时用它（再未配置则用 serve 进程默认） */
  globalWorkspace?: string;
  /** v0.4.4 成功通知阈值毫秒：任务时长达到阈值才推成功通知；≤0 禁用（默认 300000） */
  successNotifyMinDurationMs?: number;
  defaultTimeoutMs?: number;
  /** v0.4.4 taskType → 默认超时毫秒映射（未显式传 timeoutMs 时覆盖内置默认：coding 45min，其余 10min） */
  defaultTimeoutByTaskType?: Record<string, number>;
  /** v0.4.3 能力路由 + 重试降级（不配置则行为与 0.4.2 一致） */
  routing?: RoutingConfig;
  /** v0.4.3 定时探活 + 状态变化告警（默认开启，间隔 5 分钟） */
  healthWatchdog?: WatchdogConfig;
  /** http 任务超时两级判定（idleTimeoutMs/maxDurationMs/sessionCheckMaxRetries） */
  timeouts?: RunTimeoutsConfig;
  /** v0.4.12 OpenCode 权限 ask 人工批准通道（enabled 默认 true，timeoutMs 挂起超时默认 30 分钟自动 reject） */
  permissionAsk?: PermissionAskConfig;
  /** v0.4.12 任务终态唤醒编排 agent（openclaw system event 注入；enabled 默认 true，timeoutMs 默认 15000） */
  wakeAgent?: WakeAgentOptions;
  /** v0.4.5 agent 层操作日志开关（默认开启，false 关闭） */
  agentOpsLogEnabled?: boolean;
  /** v0.4.5 agent 层操作日志文件路径，默认 <dataDir>/agent-ops.log */
  agentOpsLogFile?: string;
  /** v0.4.6 agent-ops 日志轮转阈值字节，默认 10485760（10MB），0=禁用轮转 */
  agentOpsLogMaxBytes?: number;
  /** v0.4.6 agent-ops 日志轮转保留份数，默认 7 */
  agentOpsLogKeep?: number;
  /** v0.4.6 台账日报推送（默认开启，每天 21 点 Asia/Shanghai 经 notifyCommand 推送） */
  dailyReport?: DailyReportConfig;
  /** v0.4.8 worktree 隔离（默认关闭；开启后 harness_run worktree=true 才生效） */
  worktree?: WorktreeConfig;
  /** v0.4.8 doctor 定时体检（默认开启，每天 8 点 Asia/Shanghai，异常项经 notifyCommand 推送） */
  doctorSchedule?: DoctorScheduleConfig;
  /** v0.4.8 宿主版本覆盖：设置后 selfcheck/doctor 直接采用该版本号，跳过特性检测（旧宿主无版本 API 时用） */
  hostVersionOverride?: string;
  /** v0.4 出站消息追加后台任务状态行（默认开启，false 关闭） */
  statusLineEnabled?: boolean;
  /** v0.4 markdown taskboard 路径：状态行合并其「进行中」段 + harness_run 自动登记 */
  taskboardFile?: string;
  /** v0.4.1 每回合 agent_turn_prepare 注入后台任务清单（默认开启，false 关闭） */
  turnPrepareEnabled?: boolean;
  /** v0.4.1 进程内观测采样器（默认开启，false 关闭） */
  metricsEnabled?: boolean;
  /** v0.4.1 task_event 事件流水保留天数，默认 30，0=不清理 */
  eventRetentionDays?: number;
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
