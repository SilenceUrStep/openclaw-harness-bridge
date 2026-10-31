import { spawnSync } from "node:child_process";
import { Type } from "typebox";
import {
  defineToolPlugin,
  getToolPluginMetadata,
} from "openclaw/plugin-sdk/tool-plugin";
import {
  buildJsonPluginConfigSchema,
  definePluginEntry,
} from "openclaw/plugin-sdk/core";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  PKG_ROOT,
  expandHome,
  getAdapter,
  listAdapters,
  resolveDataDir,
  type BridgeConfig,
} from "./lib/adapters.js";
import { Ledger, openLedgerAt, summarizeCost, type LedgerEvent, type TaskRecord } from "./lib/ledger.js";
import {
  extractSessionId,
  fillTemplate,
  formatTaskLine,
  resolveTaskTimeout,
  resolveWorkspace,
  runTask,
} from "./lib/runner.js";
import { runHttpTask } from "./lib/runner-http.js";
import { runDshTask } from "./lib/runner-dsh.js";
import {
  cliFallbackOf,
  probeHttpHealth,
  resolveTransport,
  type HttpTransport,
  type StdioRpcTransport,
} from "./lib/transport.js";
import { loadParamDict } from "./lib/params.js";
import { switchDefaultModel, syncAdapterModels, syncDshPatch, switchDshDefaultModel } from "./lib/sync.js";
import { mountAdapterKnowledge } from "./lib/mount.js";
import { appendStatusLine, buildStatusLine, processAlive } from "./lib/statusline.js";
import { buildTurnContext } from "./lib/turnprepare.js";
import { MetricsSampler } from "./lib/metrics.js";
import { registerDispatch, bindTaskId, removeEntry, pruneFinished } from "./lib/taskboard-auto.js";
import { logAgentOps, shouldLogAgentOps } from "./lib/agent-ops-log.js";
import { registerDailyReport } from "./lib/daily-report.js";
import { registerDoctorSchedule } from "./lib/doctor-schedule.js";
import { registerLostSweeper } from "./lib/lost-sweep.js";
import { createWorktree, planWorktree, type WorktreeDecision } from "./lib/worktree.js";
import { resolvePolicy, resolveRoute } from "./lib/routing.js";
import {
  orchestrate,
  type DispatchMeta,
  type DispatchResult,
  type OrchestrationOutcome,
} from "./lib/resilience.js";
import { probeAllAdapters, probeAvailability } from "./lib/health.js";
import { renderDoctorReport, runDoctor } from "./lib/doctor.js";
import { HealthWatchdog } from "./lib/watchdog.js";
import { startupVersionCheck, type HostVersionApi } from "./lib/selfcheck.js";

/** v0.4.1 进程内观测采样器（模块级单例，register 时启动） */
const metricsSampler = new MetricsSampler();
let cleanupTimer: NodeJS.Timeout | null = null;
let metricsSaveTimer: NodeJS.Timeout | null = null;
let checkpointTimer: NodeJS.Timeout | null = null;
/** v0.4.8 running 残留定时清扫（启动 + 每小时） */
let lostSweepTimer: NodeJS.Timeout | null = null;
/** v0.4.8 doctor 定时体检（每分钟 tick，到点执行） */
let doctorScheduleTimer: NodeJS.Timeout | null = null;
/** v0.4.8 台账日报定时器（每分钟 tick，到点执行） */
let dailyReportTimer: NodeJS.Timeout | null = null;
/** v0.4.11 watchdog 提升为模块级：插件 reload 不经 gateway_stop，闭包局部引用重建后旧实例失控 */
let watchdog: HealthWatchdog | null = null;
/** v0.4.2 自动登记：toolCallId → 预登记条目 key（before/after 钩子串联） */
const autoRegMap = new Map<string, string>();

/**
 * v0.4.11 统一定时器收口：停 watchdog + 全部周期 timer（每类均有 null 守卫，幂等可重复调用）。
 * register 重载入口先调一次防多实例并行累积；gateway_stop 复用同一收口。
 */
function stopAllTimers(): void {
  try {
    watchdog?.stop();
    watchdog = null;
  } catch {
    // fail-open：清理失败不影响其余定时器与主功能
  }
  for (const t of [cleanupTimer, metricsSaveTimer, checkpointTimer, lostSweepTimer, doctorScheduleTimer, dailyReportTimer]) {
    if (t) clearInterval(t);
  }
  cleanupTimer = null;
  metricsSaveTimer = null;
  checkpointTimer = null;
  lostSweepTimer = null;
  doctorScheduleTimer = null;
  dailyReportTimer = null;
}

/** v0.4.2 惰性清理用：台账中仍 running（pid 存活）的 taskId 集合 */
function aliveRunningTaskIds(cfg: BridgeConfig): Set<string> {
  try {
    const ledger = openLedger(cfg);
    const recs = ledger.latest({ status: "running" }, 50);
    const ids = new Set<string>();
    for (const r of recs) {
      if (r.pid ? processAlive(r.pid) : true) ids.add(r.id);
    }
    return ids;
  } catch {
    return new Set();
  }
}

const configSchema = Type.Object({
  dataDir: Type.Optional(
    Type.String({ description: "数据目录（台账/任务日志/用户 adapter），默认 ~/.openclaw/harness-bridge" }),
  ),
  adaptersDir: Type.Optional(Type.String({ description: "额外 adapter 目录，同名文件覆盖内置" })),
  paramsFile: Type.Optional(Type.String({ description: "模型参数字典 JSON 路径，覆盖内置字典" })),
  notifyCommand: Type.Optional(
    Type.String({
      description:
        "后台任务完成时执行的 shell 命令（env: HB_TASK_ID/HB_HARNESS/HB_STATUS/HB_EXIT_CODE/HB_SESSION_ID/HB_LOG_FILE）",
    }),
  ),
  defaultTimeoutMs: Type.Optional(Type.Number({ description: "harness_run 默认超时毫秒" })),
  defaultTimeoutByTaskType: Type.Optional(
    Type.Record(Type.String(), Type.Number(), {
      description:
        "v0.4.4 taskType → 默认超时毫秒映射（未显式传 timeoutMs 时优先于内置默认：coding 45min，general/analysis/search 10min）",
    }),
  ),
  globalWorkspace: Type.Optional(
    Type.String({
      description:
        "v0.4.4 全局兜底工作空间：harness_run 未传 cwd 时用它（经 directory header 传给 serve）；再未配置则用 serve 进程默认目录",
    }),
  ),
  successNotifyMinDurationMs: Type.Optional(
    Type.Number({
      description:
        "v0.4.4 成功通知阈值毫秒：后台任务时长达到阈值才推 HB_ALERT=task_success 通知；≤0 禁用（默认 300000=5 分钟，短任务成功维持静默）",
    }),
  ),
  statusLineEnabled: Type.Optional(
    Type.Boolean({ description: "出站消息强制追加「后台任务」状态行（默认开启）" }),
  ),
  taskboardFile: Type.Optional(
    Type.String({ description: "taskboard.md 路径，状态行合并其「进行中」段" }),
  ),
  turnPrepareEnabled: Type.Optional(
    Type.Boolean({
      description: "v0.4.1 每回合 agent_turn_prepare 注入后台任务清单（默认开启，无任务零注入）",
    }),
  ),
  metricsEnabled: Type.Optional(
    Type.Boolean({
      description: "v0.4.1 进程内观测采样器：内存/事件循环延迟每分钟采样，环形缓冲24h（默认开启）",
    }),
  ),
  sampler: Type.Optional(
    Type.Object({
      enabled: Type.Optional(
        Type.Boolean({
          description: "v0.4.10 观测采样器开关，默认关闭；开启后每分钟采样并按天归档",
        }),
      ),
      archiveDays: Type.Optional(
        Type.Number({ description: "v0.4.10 采样归档保留天数，超期归档文件自动清理" }),
      ),
    }),
  ),
  eventRetentionDays: Type.Optional(
    Type.Number({
      description: "v0.4.1 task_event 事件流水保留天数，默认 30，0 表示不清理",
    }),
  ),
  agentOpsLogEnabled: Type.Optional(
    Type.Boolean({
      description: "v0.4.5 agent 层操作日志：exec/edit/harness_run 等自动打进统一日志（默认开启）",
    }),
  ),
  agentOpsLogFile: Type.Optional(
    Type.String({
      description: "v0.4.5 agent 层操作日志文件路径，默认 <dataDir>/agent-ops.log",
    }),
  ),
  agentOpsLogMaxBytes: Type.Optional(
    Type.Number({
      description: "v0.4.6 agent-ops 日志轮转阈值字节，默认 10485760（10MB），0=禁用轮转",
    }),
  ),
  agentOpsLogKeep: Type.Optional(
    Type.Number({
      description: "v0.4.6 agent-ops 日志轮转保留份数（.1~.N），默认 7",
    }),
  ),
  dailyReport: Type.Optional(
    Type.Object({
      enabled: Type.Optional(
        Type.Boolean({ description: "v0.4.6 台账日报推送开关，默认开启" }),
      ),
      hour: Type.Optional(
        Type.Number({
          description: "v0.4.6 日报推送时刻（Asia/Shanghai 小时），默认 21 点，到达即发（当日仅一次）",
        }),
      ),
    }),
  ),
  worktree: Type.Optional(
    Type.Object({
      enabled: Type.Optional(
        Type.Boolean({
          description:
            "v0.4.8 worktree 隔离开关（默认 false）：开启后 harness_run 传 worktree=true 才会在 <dataDir>/worktrees/<taskId> 建独立 git worktree（分支 hb-wt/<taskId>）执行任务",
        }),
      ),
    }),
  ),
  doctorSchedule: Type.Optional(
    Type.Object({
      enabled: Type.Optional(
        Type.Boolean({ description: "v0.4.8 doctor 定时体检开关，默认开启" }),
      ),
      hour: Type.Optional(
        Type.Number({
          description: "v0.4.8 体检时刻（Asia/Shanghai 小时），默认 8 点，到达即检（当日仅一次）；error 级异常经 notifyCommand 推送",
        }),
      ),
    }),
  ),
  hostVersionOverride: Type.Optional(
    Type.String({
      description:
        "v0.4.8 宿主版本覆盖：设置后 selfcheck/doctor 直接采用该版本号，跳过特性检测（旧宿主无版本 API 时用，如 \"2026.7.1-2\"）",
    }),
  ),
  routing: Type.Optional(
    Type.Object({
      default: Type.Optional(
        Type.String({ description: "v0.4.3 默认 harness（未显式指定且 taskType 无匹配时使用）" }),
      ),
      rules: Type.Optional(
        Type.Array(
          Type.Object({
            taskType: Type.String({ description: "任务类型，如 coding/general/analysis/search" }),
            harness: Type.String({ description: "目标 adapter id" }),
            fallback: Type.Optional(
              Type.Array(Type.String(), { description: "规则级降级链（覆盖 routing.fallback 同名项）" }),
            ),
          }),
          { description: "v0.4.3 taskType → harness 路由规则覆盖（优先于 capabilities 匹配）" },
        ),
      ),
      fallback: Type.Optional(
        Type.Record(Type.String(), Type.Array(Type.String()), {
          description: "v0.4.3 harness → 降级链（重试耗尽且 harness 不可用时依次接管）",
        }),
      ),
      retryAttempts: Type.Optional(
        Type.Number({ description: "v0.4.3 失败后同 harness 自动重试次数，默认 1，0 关闭" }),
      ),
    }),
  ),
  healthWatchdog: Type.Optional(
    Type.Object({
      enabled: Type.Optional(Type.Boolean({ description: "v0.4.3 定时探活开关，默认开启" })),
      intervalMs: Type.Optional(
        Type.Number({ description: "v0.4.3 探活间隔毫秒，默认 300000（5 分钟）" }),
      ),
    }),
  ),
  timeouts: Type.Optional(
    Type.Object({
      idleTimeoutMs: Type.Optional(
        Type.Number({
          description: "http 任务 SSE 流静默核查阈值毫秒，默认 300000（5 分钟），0=禁用静默核查",
        }),
      ),
      maxDurationMs: Type.Optional(
        Type.Number({
          description:
            "http 任务总时长兜底毫秒，默认 7200000（2 小时）；触发后核查会话状态而非直接判失败；旧 timeoutMs 参数继续兼容",
        }),
      ),
      sessionCheckMaxRetries: Type.Optional(
        Type.Number({ description: "连续会话核查仍 running 的告警阈值次数，默认 3" }),
      ),
    }),
  ),
});

function paramDictFile(cfg: BridgeConfig): string {
  return expandHome(cfg.paramsFile ?? path.join(PKG_ROOT, "params", "model_params.json"));
}

function openLedger(cfg: BridgeConfig): Ledger {
  const dataDir = resolveDataDir(cfg);
  return openLedgerAt(path.join(dataDir, "ledger.db"), {
    legacyFile: path.join(dataDir, "ledger.jsonl"),
  });
}

/**
 * v0.4.11 harness_status events 查询限流参数解析：
 * 默认 50、上限 1000、非法值（非有限数字 / <1）回落默认。导出仅供单测复用。
 */
export function resolveEventLimit(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 1 ? Math.min(Math.floor(raw), 1000) : 50;
}

/** harness_run 返回体（cli/http 共用，字段与 v0.1 完全兼容，http 额外追加成本/归因字段） */
function runResponse(rec: TaskRecord, wait: boolean): Record<string, unknown> {
  if (wait) {
    return {
      taskId: rec.id,
      harness: rec.harness,
      status: rec.status,
      exitCode: rec.exitCode ?? null,
      sessionId: rec.sessionId ?? null,
      durationMs: rec.durationMs ?? null,
      outputTail: rec.outputTail ?? "",
      logFile: rec.logFile ?? null,
      error: rec.error ?? null,
      ...(rec.transport ? { transport: rec.transport } : {}),
      ...(rec.fallbackUsed ? { fallbackUsed: true } : {}),
      ...(rec.retryOf ? { retryOf: rec.retryOf } : {}),
      ...(rec.failReason ? { failReason: rec.failReason } : {}),
      ...(rec.forkedFrom ? { forkedFrom: rec.forkedFrom } : {}),
      ...(rec.hasOutput != null ? { hasOutput: rec.hasOutput } : {}),
      ...(rec.cost != null ? { cost: rec.cost } : {}),
      ...(rec.costTotal != null ? { costTotal: rec.costTotal } : {}),
      ...(rec.costInputTokens != null ? { costInputTokens: rec.costInputTokens } : {}),
      ...(rec.costOutputTokens != null ? { costOutputTokens: rec.costOutputTokens } : {}),
      ...(rec.costReasoningTokens != null ? { costReasoningTokens: rec.costReasoningTokens } : {}),
      ...(rec.costCacheReadTokens != null ? { costCacheReadTokens: rec.costCacheReadTokens } : {}),
      ...(rec.tokensInput != null ? { tokensInput: rec.tokensInput } : {}),
      ...(rec.tokensOutput != null ? { tokensOutput: rec.tokensOutput } : {}),
      ...(rec.tokensReasoning != null ? { tokensReasoning: rec.tokensReasoning } : {}),
      ...(rec.tokensCacheRead != null ? { tokensCacheRead: rec.tokensCacheRead } : {}),
      ...(rec.tokensCacheWrite != null ? { tokensCacheWrite: rec.tokensCacheWrite } : {}),
      ...(rec.worktreePath ? { worktreePath: rec.worktreePath, worktreeBranch: rec.worktreeBranch } : {}),
    };
  }
  return {
    taskId: rec.id,
    harness: rec.harness,
    status: rec.status,
    pid: rec.pid ?? null,
    logFile: rec.logFile ?? null,
    hint: "后台执行中，用 harness_status 查询进度与结果",
    ...(rec.transport ? { transport: rec.transport } : {}),
    ...(rec.fallbackUsed ? { fallbackUsed: true } : {}),
    ...(rec.worktreePath ? { worktreePath: rec.worktreePath, worktreeBranch: rec.worktreeBranch } : {}),
  };
}

/** 工具返回里 changes 最多带多少条，防止刷屏 */
const MAX_CHANGES = 100;

const toolEntry = defineToolPlugin({
  id: "harness-bridge",
  name: "Harness Bridge",
  description:
    "Register, configure, delegate and monitor coding-agent harnesses (OpenCode, Claude Code, Codex CLI, ...) from OpenClaw.",
  configSchema,
  tools: (tool) => [
    tool({
      name: "harness_list",
      label: "Harness List",
      description:
        "列出已注册的编码 harness（声明式 adapter）及健康状态：二进制是否安装、版本、模型配置文件存在性；http 型 adapter 额外做 transport 探活（超时 3s）；binary 不可用时附诊断线索（PATH/悬空符号链接/候选路径，v0.4.3）。",
      parameters: Type.Object({}),
      execute: async (_params, config) => {
        const cfg = config as BridgeConfig;
        return probeAllAdapters(cfg);
      },
    }),

    tool({
      name: "harness_doctor",
      label: "Harness Doctor",
      description:
        "v0.4.7 一键体检，检查项收口：各 adapter 探活健康 / 宿主与 binary 版本探测 / binary 诊断（PATH、悬空符号链接线索）/ 台账健康（SQLite 完整性、WAL 大小、任务统计）/ worktree 残留（v0.4.8，已结束任务遗留的 worktree 清理提示）/ 配置校验（全部配置键当前值 vs 默认值）。输出人话体检报告：每项一行结论 + ✅/⚠️/❌ 分级 + 异常项修复建议。",
      parameters: Type.Object({}),
      execute: async (_params, config) => {
        const cfg = config as BridgeConfig;
        const report = await runDoctor(cfg);
        return {
          allOk: report.allOk,
          fullyHealthy: report.fullyHealthy,
          checks: report.checks,
          report: renderDoctorReport(report),
        };
      },
    }),

    tool({
      name: "harness_sync_models",
      label: "Harness Sync Models",
      description:
        "按统一参数字典（exact/prefix/defaults 三级匹配）校准各 harness 的模型配置。默认只出报告；apply=true 时字段级 merge 写回（自动备份 + 写后验证）；setDefaultModel 切换默认模型。",
      parameters: Type.Object({
        harness: Type.Optional(
          Type.String({ description: "只处理指定 adapter id，默认全部支持模型配置的" }),
        ),
        apply: Type.Optional(Type.Boolean({ description: "写回配置，默认 false（只出报告）" })),
        setDefaultModel: Type.Optional(
          Type.String({ description: "切换默认模型，值如 provider/model" }),
        ),
      }),
      execute: async (params, config) => {
        const cfg = config as BridgeConfig;
        const dict = loadParamDict(paramDictFile(cfg));
        const apply = params.apply === true;
        let adapters = listAdapters(cfg).filter(
          (a) => a.config?.modelConfig || a.modelSync?.format === "dsh-patch",
        );
        if (params.harness) adapters = adapters.filter((a) => a.id === params.harness);
        if (adapters.length === 0) {
          return { error: "没有匹配的 adapter（或所选 adapter 未配置 modelConfig/modelSync）" };
        }
        const dataDir = resolveDataDir(cfg);
        const reports = adapters.map((a) => {
          const r =
            a.modelSync?.format === "dsh-patch"
              ? syncDshPatch(a, dict, apply, dataDir)
              : syncAdapterModels(a, dict, apply);
          if (r.changes.length > MAX_CHANGES) {
            return {
              ...r,
              changes: r.changes.slice(0, MAX_CHANGES),
              changesTruncated: true,
              totalChanges: r.changes.length,
            };
          }
          return r;
        });
        const defaultSwitches = params.setDefaultModel
          ? adapters.map((a) =>
              a.modelSync?.format === "dsh-patch"
                ? switchDshDefaultModel(a, params.setDefaultModel as string, apply, dataDir)
                : switchDefaultModel(a, params.setDefaultModel as string, apply),
            )
          : [];
        return { apply, reports, defaultSwitches };
      },
    }),

    tool({
      name: "harness_run",
      label: "Harness Run",
      description:
        "把编码任务委派给指定 harness。默认后台执行（台账记录，完成后可用 harness_status 查询）；wait=true 同步等待并返回输出尾部。v0.4.3：harness 可省略，按 taskType 的 capabilities 路由或 routing.default 兜底；失败自动重试（默认 1 次）+ harness 不可用时按降级链接管，全程记事件台账。",
      parameters: Type.Object({
        harness: Type.Optional(
          Type.String({ description: "adapter id（见 harness_list）；省略时按 taskType/路由配置选择" }),
        ),
        taskType: Type.Optional(
          Type.String({ description: "v0.4.3 任务类型（如 coding/general/analysis/search），按 capabilities 路由" }),
        ),
        prompt: Type.String({ description: "任务指令全文" }),
        resumeSessionId: Type.Optional(
          Type.String({ description: "续接会话 ID（adapter 需支持 resume）" }),
        ),
        cwd: Type.Optional(
          Type.String({
            description:
              "工作目录（编码任务推荐显式传项目文件夹）；不传时用 globalWorkspace 兜底，仍未配置则用 serve 进程默认目录",
          }),
        ),
        wait: Type.Optional(
          Type.Boolean({ description: "同步等待完成，默认 false（后台执行）" }),
        ),
        timeoutMs: Type.Optional(
          Type.Number({
            description:
              "超时毫秒；省略时按 taskType 默认（v0.4.4：coding 2700000，general/analysis/search 600000，无 taskType 600000）",
          }),
        ),
        retryOf: Type.Optional(
          Type.String({
            description:
              "重试指定失败任务（fork-before-retry）：先 fork 原会话再续跑，幂等不污染原会话。值 = 原 taskId（须为 failed/timeout/lost 且有 sessionId）",
          }),
        ),
        worktree: Type.Optional(
          Type.Boolean({
            description:
              "v0.4.8 在独立 git worktree 中执行（默认 false）：需配置 worktree.enabled=true；在 <dataDir>/worktrees/<taskId> 建基于 HEAD 的 worktree（分支 hb-wt/<taskId>），任务结束后保留供人工审查合并；非 git 仓库/未开开关时降级为普通执行并记台账事件",
          }),
        ),
      }),
      execute: async (params, config) => {
        const cfg = config as BridgeConfig;
        const adapters = listAdapters(cfg);
        const route = resolveRoute(cfg, adapters, {
          harness: params.harness,
          taskType: params.taskType,
        });
        if ("error" in route) return { error: route.error };
        const target = adapters.find((a) => a.id === route.harness);
        if (!target) {
          const known = adapters.map((a) => a.id).join(", ");
          return { error: `未知 harness: ${route.harness}（可用: ${known}）` };
        }
        const dataDir = resolveDataDir(cfg);
        const tasksDir = path.join(dataDir, "tasks");
        mkdirSync(tasksDir, { recursive: true });
        const ledger = openLedger(cfg);
        const wait = params.wait === true;

        // v0.4.4 工作区三级解析：显式 cwd > globalWorkspace 兜底 > serve 进程默认（不再兜底插件数据目录）
        let ws = resolveWorkspace(params.cwd, cfg.globalWorkspace);

        // v0.4.8 worktree 隔离：请求 worktree 且开关开启 → 建独立 worktree 接管 cwd（后续重试/降级同样在 worktree 内执行）；
        // 未开开关 / 无 cwd / 非 git 仓库 / 创建失败 → 降级为普通执行（原因记台账 worktree 事件）
        let worktreePlan: WorktreeDecision = { action: "skip" };
        if (params.worktree === true) {
          worktreePlan = planWorktree({
            requested: true,
            enabled: cfg.worktree?.enabled === true,
            cwd: ws.cwd,
            dataDir,
          });
          if (worktreePlan.action === "create") {
            const created = createWorktree({ baseCwd: ws.cwd as string, dataDir, taskId: worktreePlan.taskId });
            if (created.ok && created.path && created.branch) {
              ws = { ...ws, cwd: created.path };
              worktreePlan = { action: "create", taskId: worktreePlan.taskId, path: created.path, branch: created.branch };
            } else {
              worktreePlan = { action: "degrade", reason: created.reason ?? "worktree 创建失败，降级为普通执行" };
            }
          }
        }

        // manual retryOf（fork-before-retry）保持 0.4.2 语义：仅首次派发生效
        let forkFromSessionId: string | undefined;
        let cliResumeSessionId = params.resumeSessionId;
        if (params.retryOf) {
          const old = ledger.getById(params.retryOf);
          if (!old) return { error: `retryOf 任务不存在: ${params.retryOf}` };
          if (!["failed", "timeout", "lost"].includes(old.status)) {
            return { error: `仅失败任务可重试（原任务状态: ${old.status}）` };
          }
          if (!old.sessionId) return { error: "原任务无 sessionId，无法 fork 续跑" };
          forkFromSessionId = old.sessionId;
        }

        const policy = resolvePolicy(cfg, route);
        let onFinalHandler: ((rec: TaskRecord) => void) | undefined;
        const onFinalRef = wait ? undefined : (rec: TaskRecord) => onFinalHandler?.(rec);
        const dispatch = async (harnessId: string, meta: DispatchMeta): Promise<DispatchResult> => {
          const adapter = harnessId === route.harness ? target : adapters.find((a) => a.id === harnessId);
          if (!adapter) return { ok: false, error: `路由目标 harness 未注册: ${harnessId}` };
          const transport = resolveTransport(adapter);
          // v0.4.4 统一超时解析：显式 > taskType 显式配置 > http 全局兜底 > 内置 taskType 默认 > 全局默认
          const resolved = resolveTaskTimeout({
            explicitTimeoutMs: params.timeoutMs,
            taskType: params.taskType,
            defaultTimeoutMs: cfg.defaultTimeoutMs,
            defaultTimeoutByTaskType: cfg.defaultTimeoutByTaskType,
            maxDurationMs: cfg.timeouts?.maxDurationMs,
            isHttp: transport.kind === "http",
          });
          const timeoutMs = resolved.timeoutMs;
          const trackResolved = (rec: TaskRecord): TaskRecord => {
            try {
              ledger.addEvents(rec.id, [
                {
                  type: "timeout_resolved",
                  payload: {
                    timeoutMs: resolved.timeoutMs,
                    source: resolved.source,
                    taskType: params.taskType ?? null,
                    transport: transport.kind,
                  },
                  ts: new Date().toISOString(),
                },
                {
                  type: "workspace_resolved",
                  payload: {
                    cwd: ws.cwd ?? null,
                    source: ws.source,
                    transport: transport.kind,
                  },
                  ts: new Date().toISOString(),
                },
              ]);
            } catch {
              // 事件写入失败不影响派发
            }
            return rec;
          };
          const runCommon = {
            adapter,
            prompt: params.prompt,
            cwd: ws.cwd,
            wait,
            timeoutMs,
            timeoutSource: resolved.source,
            successNotifyMinDurationMs: cfg.successNotifyMinDurationMs,
            ledger,
            tasksDir,
            notifyCommand: cfg.notifyCommand,
            // v0.4.8 worktree 隔离：仅首次派发沿用计划好的 taskId（与 worktree 目录/分支名一致）；重试/降级任务自生成 ID
            ...(worktreePlan.action === "create" && meta.isInitial ? { taskId: worktreePlan.taskId } : {}),
            ...(onFinalRef ? { onFinal: onFinalRef } : {}),
          };
          if (transport.kind === "stdio-rpc") {
            const rec = await runDshTask({
              ...runCommon,
              transport: (transport.config ?? {
                type: "stdio-rpc",
                command: adapter.binary,
              }) as StdioRpcTransport,
              dshHome: path.join(dataDir, "dsh-home"),
              sessionCheckMaxRetries: cfg.timeouts?.sessionCheckMaxRetries,
            });
            return { ok: true, rec: trackResolved(rec) };
          }
          if (transport.kind === "http") {
            const ht = transport.config as HttpTransport;
            const probe = await probeHttpHealth(ht, { cwd: ws.cwd });
            if (!probe.ok && cliFallbackOf(adapter)) {
              const rec = runTask({ ...runCommon, resumeSessionId: cliResumeSessionId });
              ledger.append({ ...rec, transport: "cli", fallbackUsed: true });
              return { ok: true, rec: { ...rec, transport: "cli", fallbackUsed: true } };
            }
            if (!probe.ok) {
              return {
                ok: false,
                error: `http 探活失败: ${probe.error ?? `HTTP ${probe.status}`}，adapter 未配置 fallback，任务未执行`,
              };
            }
            const rec = await runHttpTask({
              ...runCommon,
              transport: ht,
              resumeSessionId: cliResumeSessionId,
              forkFromSessionId: meta.isInitial ? forkFromSessionId : undefined,
              maxDurationMs: timeoutMs,
              idleTimeoutMs: cfg.timeouts?.idleTimeoutMs,
              sessionCheckMaxRetries: cfg.timeouts?.sessionCheckMaxRetries,
            });
            return { ok: true, rec: trackResolved(rec) };
          }
          // cli：fork-before-retry 走 delegate.fork argv 模板，输出按 idPattern 提取新会话（仅首次派发）
          let effectiveResume = cliResumeSessionId;
          if (meta.isInitial && forkFromSessionId) {
            const forkTpl = adapter.delegate.fork;
            if (!Array.isArray(forkTpl) || forkTpl.length === 0) {
              return {
                ok: false,
                fatal: true,
                error: "adapter 未配置 delegate.fork（argv 模板），cli 模式不支持 fork-before-retry",
              };
            }
            const forkArgv = fillTemplate(forkTpl, { sessionId: forkFromSessionId, prompt: params.prompt });
            const fr = spawnSync(forkArgv[0], forkArgv.slice(1), {
              cwd: ws.cwd ?? dataDir,
              timeout: 30000,
              encoding: "utf8",
            });
            const forked = extractSessionId(
              `${fr.stdout ?? ""}${fr.stderr ?? ""}`,
              adapter.session?.idPattern,
            );
            if (!forked) {
              return { ok: false, fatal: true, error: `fork 命令未产出新会话 ID（exit=${fr.status}）` };
            }
            effectiveResume = forked;
          }
          const rec = runTask({ ...runCommon, resumeSessionId: effectiveResume });
          return { ok: true, rec: trackResolved(rec) };
        };

        // v0.4.3 兼容门控：未配置 routing（不重试不降级）时单次派发，行为与 0.4.2 完全一致
        const orchestrationActive = policy.retryAttempts > 0 || policy.fallbackChain.length > 0;
        let outcome: OrchestrationOutcome;
        if (orchestrationActive) {
          outcome = await orchestrate({
            ledger,
            wait,
            initialHarness: route.harness,
            retryAttempts: policy.retryAttempts,
            fallbackChain: policy.fallbackChain,
            probe: (hid) => probeAvailability(cfg, hid),
            dispatch,
            ...(wait ? {} : { setOnFinal: (fn: (rec: TaskRecord) => void) => { onFinalHandler = fn; } }),
          });
        } else {
          const res = await dispatch(route.harness, { isInitial: true }).catch(
            (err): DispatchResult => ({ ok: false, error: (err as Error).message }),
          );
          outcome = res.ok
            ? { rec: res.rec, attempts: 1, fallbackUsed: false, retryOfChain: [] }
            : { rec: null, error: res.error, attempts: 1, fallbackUsed: false, retryOfChain: [] };
        }

        // 路由决策入事件台账（挂首个任务记录：选了谁、为什么）
        if (outcome.rec) {
          // v0.4.8 worktree 决策入台账：created = worktree 接管 cwd（挂 worktreePath/branch 字段）；degraded = 降级原因
          try {
            if (worktreePlan.action === "create") {
              ledger.append({
                ...outcome.rec,
                worktreePath: worktreePlan.path,
                worktreeBranch: worktreePlan.branch,
              });
              ledger.addEvents(outcome.rec.id, [
                {
                  type: "worktree",
                  payload: {
                    decision: "created",
                    path: worktreePlan.path,
                    branch: worktreePlan.branch,
                    ownerTaskId: worktreePlan.taskId,
                    attempt: outcome.rec.id,
                  },
                  ts: new Date().toISOString(),
                },
              ]);
            } else if (worktreePlan.action === "degrade") {
              ledger.addEvents(outcome.rec.id, [
                {
                  type: "worktree",
                  payload: { decision: "degraded", reason: worktreePlan.reason },
                  ts: new Date().toISOString(),
                },
              ]);
            }
          } catch {
            // 事件写入失败不影响响应
          }
          try {
            ledger.addEvents(outcome.rec.id, [
              {
                type: "route",
                payload: {
                  decision: { harness: route.harness, reason: route.reason, detail: route.detail },
                  taskType: params.taskType ?? null,
                  policy,
                  fallbackUsed: outcome.fallbackUsed,
                  retryOfChain: outcome.retryOfChain,
                },
                ts: new Date().toISOString(),
              },
            ]);
          } catch {
            // 事件写入失败不影响响应
          }
          return runResponse(outcome.rec, wait);
        }
        return { error: outcome.error ?? "任务派发失败" };
      },
    }),

    tool({
      name: "harness_mount",
      label: "Harness Mount",
      description:
        "把共享知识库目录挂载进指定 harness 的配置：external_directory 目录放行 + instructions 注入入口文件。默认只出报告；apply=true 字段级写回（自动备份 + 写后验证），已挂载内容自动跳过（幂等）。",
      parameters: Type.Object({
        harness: Type.String({ description: "adapter id，见 harness_list" }),
        path: Type.String({ description: "知识库目录绝对路径" }),
        inject: Type.Optional(
          Type.String({ description: "注入 instructions 的入口文件名，如 README.md" }),
        ),
        apply: Type.Optional(Type.Boolean({ description: "写回配置，默认 false（只出报告）" })),
      }),
      execute: async (params, config) => {
        const cfg = config as BridgeConfig;
        const adapter = getAdapter(cfg, params.harness);
        if (!adapter) {
          const known = listAdapters(cfg)
            .map((a) => a.id)
            .join(", ");
          return { error: `未知 harness: ${params.harness}（可用: ${known}）` };
        }
        return mountAdapterKnowledge(adapter, {
          path: params.path,
          inject: params.inject,
          apply: params.apply === true,
        });
      },
    }),

    tool({
      name: "harness_status",
      label: "Harness Status",
      description:
        "查询委派任务台账（SQLite）：状态/退出码/会话 ID/耗时/输出尾部/成本与 token 聚合/失败归因（fail_reason）。running 任务若进程已消失且无退出记录，自动标记 lost。新增：events=taskId 输出单任务事件时间线（v0.4.11 默认只回最新 50 条，传 limit 调整，上限 1000；返回体含 total 事件总数与 truncated 是否截断）；since/until 时间窗过滤；legacy=true 只读查看 v0.1 JSON Lines 旧台账；metrics=true 输出进程内存/事件循环延迟观测摘要（v0.4.1）；v0.4.7 摘要模式（默认开）：一行一任务（taskId/harness/状态/耗时/成本），summary=false 保留原始 JSON 输出。",
      parameters: Type.Object({
        taskId: Type.Optional(Type.String({ description: "精确查询单个任务" })),
        harness: Type.Optional(Type.String({ description: "按 harness 过滤" })),
        status: Type.Optional(
          Type.String({ description: "按状态过滤: running/success/failed/timeout/lost" }),
        ),
        limit: Type.Optional(
          Type.Number({
            description:
              "任务列表返回条数上限（默认 20）；events 查询时为事件条数上限（v0.4.11 默认 50、上限 1000，非法值回落默认）",
          }),
        ),
        summary: Type.Optional(
          Type.Boolean({
            description:
              "v0.4.7 摘要模式（默认 true）：一行一任务（taskId/harness/状态/耗时/成本）方便人看；false 返回原始 JSON 任务列表",
          }),
        ),
        events: Type.Optional(
          Type.String({
            description: "输出指定任务的事件时间线（值 = taskId）；v0.4.11 默认只回最新 50 条，传 limit 调整（上限 1000）",
          }),
        ),
        since: Type.Optional(Type.String({ description: "时间窗起点（ISO 时间，含边界）" })),
        until: Type.Optional(Type.String({ description: "时间窗终点（ISO 时间，含边界）" })),
        legacy: Type.Optional(
          Type.Boolean({ description: "只读查看 v0.1 JSON Lines 旧台账（不迁移不写入）" }),
        ),
        metrics: Type.Optional(
          Type.Boolean({
            description: "v0.4.1 输出进程观测摘要：RSS/堆/事件循环延迟峰值与堆压力判断",
          }),
        ),
      }),
      execute: async (params, config) => {
        const cfg = config as BridgeConfig;
        if (params.metrics === true) {
          const summary = metricsSampler.summary();
          const pressure = metricsSampler.heapPressure();
          return {
            metrics: summary,
            heapLimitMb: metricsSampler.heapLimitMb(),
            heapPressure: pressure,
            hint: pressure.pressured
              ? `堆已用 ${pressure.usedPct}% 超过阈值 85%，建议排查泄漏或调堆`
              : `堆已用 ${pressure.usedPct}%，正常范围（阈值 85%）`,
          };
        }
        const ledger = openLedger(cfg);
        const limit = params.limit ?? 20;
        if (params.events) {
          const task = ledger.getById(params.events) ?? null;
          // v0.4.11 事件查询限流：默认只回最新 50 条（上限 1000，非法值回落默认），防止大任务
          // 全量事件（如 hb_watchdog 7000+ 条）撑爆调用方上下文；total=事件总数、truncated=是否截断
          const total = ledger.countEvents(params.events);
          const events: LedgerEvent[] = ledger.getEvents(params.events, resolveEventLimit(params.limit));
          return { task, events, total, truncated: total > events.length };
        }
        const filter = {
          taskId: params.taskId,
          harness: params.harness,
          status: params.status,
          since: params.since,
          until: params.until,
        };
        if (params.legacy === true) {
          const recs = ledger.legacyLatest(filter);
          return { legacy: true, total: recs.length, returned: Math.min(recs.length, limit), tasks: recs.slice(0, limit) };
        }
        const recs = ledger.latest(filter);
        const tasks: TaskRecord[] = recs.slice(0, limit).map((r) => {
          if (r.status === "running" && r.pid && !processAlive(r.pid)) {
            const lost: TaskRecord = {
              ...r,
              status: "lost",
              error: "进程已不存在且无退出记录（可能 gateway 重启）",
            };
            ledger.append(lost);
            return lost;
          }
          return r;
        });
        // v0.4.7 摘要模式（默认 true）：一行一任务方便人看；summary=false 保留原始 JSON 输出
        if (params.summary !== false) {
          const lines = tasks.map(formatTaskLine);
          // v0.4.8 worktree 提示：有 worktree 隔离任务时输出产出位置与清理方式（人工审查合并后清理）
          const wtTasks = tasks.filter((t) => t.worktreePath);
          const worktreeHint =
            wtTasks.length > 0
              ? `worktree 隔离任务 ${wtTasks.length} 个：${wtTasks
                  .map((t) => `${t.id} → ${t.worktreePath}（${t.worktreeBranch}，${t.status}）`)
                  .join("；")}；产出在专属分支上，人工审查合并后可 git worktree remove 清理`
              : undefined;
          return {
            total: recs.length,
            returned: tasks.length,
            lines,
            text: lines.join("\n"),
            summary: summarizeCost(recs),
            ...(worktreeHint ? { worktreeHint } : {}),
            hint: worktreeHint
              ? `摘要模式（每行: taskId ｜ harness ｜ 状态 ｜ 耗时 ｜ 成本）；${worktreeHint}；summary=false 返回原始 JSON 任务列表`
              : "摘要模式（每行: taskId ｜ harness ｜ 状态 ｜ 耗时 ｜ 成本）；summary=false 返回原始 JSON 任务列表",
          };
        }
        return {
          total: recs.length,
          returned: tasks.length,
          tasks,
          summary: summarizeCost(recs),
        };
      },
    }),
  ],
});

/**
 * v0.4 session transparency：出站消息强制追加「后台任务」状态行（message_sending hook）。
 * 外层 definePluginEntry 包装 tool entry（工具注册复用 toolEntry.register），追加消息钩子。
 */
const entry: ReturnType<typeof definePluginEntry> = definePluginEntry({
  id: "harness-bridge",
  name: "Harness Bridge",
  description:
    "Register, configure, delegate and monitor coding-agent harnesses (OpenCode, Claude Code, Codex CLI, ...) from OpenClaw.",
  configSchema: buildJsonPluginConfigSchema(configSchema as unknown as Record<string, unknown>),
  register(api) {
    // v0.4.11 防重入清理：插件 reload 不触发 gateway_stop，先收口上一实例的全部定时器/watchdog，
    // 否则 HealthWatchdog/doctor-schedule/dailyReport 等多实例并行累积（task_event 6 倍速佐证）
    stopAllTimers();
    toolEntry.register(api);
    const cfg = (api.pluginConfig ?? {}) as BridgeConfig & {
      statusLineEnabled?: boolean;
      taskboardFile?: string;
      turnPrepareEnabled?: boolean;
      metricsEnabled?: boolean;
      eventRetentionDays?: number;
      /** v0.4.10 观测采样器开关（默认 false，不配置则采样器完全不启动） */
      sampler?: { enabled?: boolean; archiveDays?: number };
    };
    const dataDir = resolveDataDir(cfg);
    const ledgerDbPath = path.join(dataDir, "ledger.db");
    const ledgerLegacyFile = path.join(dataDir, "ledger.jsonl");
    /** v0.4.3 自检用：已注册 hook 名单（按实际注册顺序记录） */
    const activeHooks: string[] = [];

    // v0.4 状态行钩子：出站消息强制追加「后台任务」状态行
    if (cfg.statusLineEnabled !== false) {
      activeHooks.push("message_sending");
      api.on("message_sending", async (event) => {
        try {
          const line = buildStatusLine({
            ledgerDbPath,
            ledgerLegacyFile,
            taskboardFile: cfg.taskboardFile,
          });
          const next = appendStatusLine(event.content, line);
          if (next === event.content) return;
          return { content: next };
        } catch {
          return; // fail-open：状态行失败绝不阻断消息发送
        }
      });
    }

    // v0.4.1 透明度补全：每回合注入后台任务清单（无任务零注入）
    if (cfg.turnPrepareEnabled !== false) {
      activeHooks.push("agent_turn_prepare");
      api.on("agent_turn_prepare", async () => {
        try {
          const ctx = buildTurnContext({
            ledgerDbPath,
            ledgerLegacyFile,
            taskboardFile: cfg.taskboardFile,
          });
          return ctx ? { appendContext: ctx } : undefined;
        } catch {
          return; // fail-open：注入失败不阻断回合
        }
      });
    }

    // v0.4.10 观测采样器：默认关闭（不配置 sampler 则完全不启动）；
    // sampler.enabled 开启后内存/事件循环延迟每分钟采样，环形缓冲 24h，并每小时落盘 + 按天归档
    if (cfg.sampler?.enabled === true) {
      try {
        metricsSampler.start();
        // v0.4.2 落盘：启动恢复 + 每小时持久化，网关重启观测数据不断档
        const metricsFile = path.join(dataDir, "metrics.json");
        metricsSampler.loadFromDisk(metricsFile);
        if (metricsSaveTimer) clearInterval(metricsSaveTimer);
        metricsSaveTimer = setInterval(() => {
          try {
            metricsSampler.saveToDisk(metricsFile);
            // v0.4.10 每小时落盘时顺带按天归档 + 清理过期归档（失败不影响落盘）
            try {
              metricsSampler.archiveToDisk(
                metricsFile,
                path.join(dataDir, "metrics-archive"),
                cfg.sampler?.archiveDays ?? 30,
              );
            } catch {
              // 归档失败不影响落盘
            }
          } catch {
            // 落盘失败不影响采样
          }
        }, 3600_000);
        metricsSaveTimer.unref?.();
      } catch {
        // 采样器启动失败不影响插件主功能
      }
    }

    // v0.4.2 自动登记：harness_run 派发自动写 taskboard「🤖 自动登记」段，治承诺悬空
    if (cfg.turnPrepareEnabled !== false && cfg.taskboardFile) {
      activeHooks.push("before_tool_call", "after_tool_call");
      const tbFile = cfg.taskboardFile as string;
      api.on("before_tool_call", async (event) => {
        try {
          if (event.toolName !== "harness_run" || !event.toolCallId) return;
          if (event.params?.wait === true) return; // 同步任务不登记
          pruneFinished(tbFile, aliveRunningTaskIds(cfg));
          const key = registerDispatch(tbFile, String(event.params?.harness ?? ""), String(event.params?.prompt ?? ""));
          if (key) autoRegMap.set(event.toolCallId, key);
        } catch {
          return; // fail-open：登记失败不阻断派发
        }
      });
      api.on("after_tool_call", async (event) => {
        try {
          if (event.toolName !== "harness_run" || !event.toolCallId) return;
          const key = autoRegMap.get(event.toolCallId);
          if (!key) return;
          autoRegMap.delete(event.toolCallId);
          const result = event.result as { taskId?: string } | undefined;
          if (result?.taskId) {
            bindTaskId(tbFile, key, result.taskId);
          } else {
            removeEntry(tbFile, key); // 派发未成功不留痕
          }
        } catch {
          return; // fail-open
        }
      });
    }

    // v0.4.5 agent-ops 日志：agent 层工具调用自动打进统一日志，治「agent 层操作无自动日志」缺口
    if (cfg.agentOpsLogEnabled !== false) {
      activeHooks.push("agent_ops_log");
      const agentOpsLogFile = cfg.agentOpsLogFile ?? path.join(dataDir, "agent-ops.log");
      /** toolCallId → 开始时间（仅需计时的工具：非只读即记） */
      const agentOpsTimers = new Map<string, number>();
      api.on("before_tool_call", async (event) => {
        try {
          if (!event.toolCallId || !shouldLogAgentOps(event.toolName)) return;
          agentOpsTimers.set(event.toolCallId, Date.now());
        } catch {
          return; // fail-open
        }
      });
      api.on("after_tool_call", async (event) => {
        try {
          const start = event.toolCallId ? agentOpsTimers.get(event.toolCallId) : undefined;
          if (event.toolCallId) agentOpsTimers.delete(event.toolCallId); // 用完即删，防泄漏
          const durationMs = start !== undefined ? Date.now() - start : undefined;
          // 工具抛错时宿主把错误放 event.error，包成 { error } 传给日志记 [ERROR]
          const result = event.error !== undefined ? { error: event.error } : event.result;
          logAgentOps({
            toolName: event.toolName,
            params: event.params,
            result,
            durationMs,
            logFile: agentOpsLogFile,
            maxBytes: cfg.agentOpsLogMaxBytes ?? 10_485_760,
            keep: cfg.agentOpsLogKeep ?? 7,
          });
        } catch {
          return; // fail-open：日志失败绝不阻断工具调用
        }
      });
    }

    // v0.4.3 宿主版本感知 + 升级自检（异步，不阻塞注册）
    try {
      void startupVersionCheck({
        cfg,
        ledger: openLedger(cfg),
        hooks: [...activeHooks],
        dataDir,
        api: api as unknown as HostVersionApi,
      }).catch(() => {
        // 自检失败不影响主功能
      });
    } catch {
      // ignore
    }

    // v0.4.3 定时探活 + 状态变化告警（默认开启，间隔 5 分钟）
    if (cfg.healthWatchdog?.enabled !== false) {
      try {
        watchdog = new HealthWatchdog({
          cfg,
          intervalMs: cfg.healthWatchdog?.intervalMs ?? 300_000,
          ledger: openLedger(cfg),
          notifyCommand: cfg.notifyCommand,
        });
        watchdog.start();
      } catch {
        // 探活启动失败不影响主功能
      }
    }

    // v0.4.6 台账日报：每天固定时间（默认 21 点 Asia/Shanghai）聚合昨日数据经 notifyCommand 推送
    // （内部自带 setInterval，不是 hook，不进 activeHooks；v0.4.11 返回 timer 供统一收口清理）
    if (cfg.dailyReport?.enabled !== false) {
      try {
        dailyReportTimer = registerDailyReport({
          cfg,
          ledgerDbPath,
          notifyCommand: cfg.notifyCommand,
        });
      } catch {
        // 日报启动失败不影响主功能
      }
    }

    // v0.4.8 running 残留定时清扫：启动时 + 每小时主动扫台账，pid 已消失且无退出记录的 running 任务标记 lost
    try {
      lostSweepTimer = registerLostSweeper({ ledger: openLedger(cfg) });
    } catch {
      // 清扫启动失败不影响主功能
    }

    // v0.4.8 doctor 定时体检：每天固定时刻（默认 8 点 Asia/Shanghai）自动体检，
    // 结果写台账事件，error 级异常经 notifyCommand 推送（默认开启）
    if (cfg.doctorSchedule?.enabled !== false) {
      try {
        doctorScheduleTimer = registerDoctorSchedule({
          cfg,
          ledger: openLedger(cfg),
          notifyCommand: cfg.notifyCommand,
          // v0.4.11 「今日已推」标记持久化：重载后新实例读回标记，不再同秒重复推送
          stateFile: path.join(dataDir, "doctor-sent-dates.json"),
        });
      } catch {
        // 定时体检启动失败不影响主功能
      }
    }

    // v0.4.1 台账自动清理：task_event 保留 N 天（默认 30，0=不清理）
    const retentionDays = cfg.eventRetentionDays ?? 30;
    if (retentionDays > 0) {
      const cleanup = () => {
        try {
          const n = openLedger(cfg).cleanupEvents(retentionDays);
          if (n > 0) {
            console.log(`[harness-bridge] task_event 清理 ${n} 条（保留 ${retentionDays} 天）`);
          }
        } catch {
          // 清理失败不影响主流程
        }
      };
      cleanup();
      if (cleanupTimer) clearInterval(cleanupTimer);
      cleanupTimer = setInterval(cleanup, 24 * 3600_000);
      cleanupTimer.unref?.();
    }

    // v0.4.4 WAL 定期 checkpoint：每小时 TRUNCATE 合并（防长驻进程 WAL 膨胀），失败 fail-open
    const checkpoint = () => {
      try {
        const r = openLedger(cfg).checkpoint();
        if (r) {
          try {
            openLedger(cfg).addEvents("hb_checkpoint", [
              {
                type: "checkpoint",
                payload: { busy: r.busy, log: r.log, checkpointed: r.checkpointed },
                ts: new Date().toISOString(),
              },
            ]);
          } catch {
            // 事件写入失败不影响 checkpoint 本身
          }
        }
      } catch {
        // fail-open：checkpoint 失败不影响主流程
      }
    };
    checkpoint();
    if (checkpointTimer) clearInterval(checkpointTimer);
    checkpointTimer = setInterval(checkpoint, 3600_000);
    checkpointTimer.unref?.();

    // 网关停止时释放采样器与定时器（v0.4.2：停止前 flush 观测数据）
    // v0.4.11 定时器/watchdog 收口统一走 stopAllTimers()（与 register 重载入口共用）
    api.on("gateway_stop", async () => {
      // v0.4.10 采样器关闭时安全跳过（未启动即无数据可 flush）；flush 需 dataDir，保留在此处
      if (cfg.sampler?.enabled === true) {
        try {
          metricsSampler.saveToDisk(path.join(dataDir, "metrics.json"));
        } catch {
          // ignore
        }
      }
      stopAllTimers();
      if (cfg.sampler?.enabled === true) {
        try {
          metricsSampler.stop();
        } catch {
          // ignore
        }
      }
    });
  },
});

// 保留 tool-plugin 元数据（openclaw plugins build 生成 manifest 依赖）
const toolMeta = getToolPluginMetadata(toolEntry);
if (toolMeta) {
  Object.defineProperty(entry, Symbol.for("openclaw.plugin-sdk.tool-plugin.metadata"), {
    value: toolMeta,
    enumerable: false,
  });
}

export default entry;
