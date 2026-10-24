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
  checkHealth,
  expandHome,
  getAdapter,
  listAdapters,
  resolveDataDir,
  type Adapter,
  type BridgeConfig,
} from "./lib/adapters.js";
import { Ledger, openLedgerAt, summarizeCost, type LedgerEvent, type TaskRecord } from "./lib/ledger.js";
import { extractSessionId, fillTemplate, runTask } from "./lib/runner.js";
import { runHttpTask } from "./lib/runner-http.js";
import { runDshTask } from "./lib/runner-dsh.js";
import {
  checkVersionGate,
  cliFallbackOf,
  fetchHttpVersion,
  probeHttpHealth,
  resolveTransport,
  type HttpTransport,
  type StdioRpcTransport,
} from "./lib/transport.js";
import { loadParamDict } from "./lib/params.js";
import { switchDefaultModel, syncAdapterModels, syncDshPatch, switchDshDefaultModel } from "./lib/sync.js";
import { mountAdapterKnowledge } from "./lib/mount.js";
import { appendStatusLine, buildStatusLine } from "./lib/statusline.js";
import { buildTurnContext } from "./lib/turnprepare.js";
import { MetricsSampler } from "./lib/metrics.js";
import { registerDispatch, bindTaskId, removeEntry, pruneFinished } from "./lib/taskboard-auto.js";

/** v0.4.1 进程内观测采样器（模块级单例，register 时启动） */
const metricsSampler = new MetricsSampler();
let cleanupTimer: NodeJS.Timeout | null = null;
let metricsSaveTimer: NodeJS.Timeout | null = null;
/** v0.4.2 自动登记：toolCallId → 预登记条目 key（before/after 钩子串联） */
const autoRegMap = new Map<string, string>();

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
  eventRetentionDays: Type.Optional(
    Type.Number({
      description: "v0.4.1 task_event 事件流水保留天数，默认 30，0 表示不清理",
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

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
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
      ...(rec.failReason ? { failReason: rec.failReason } : {}),
      ...(rec.forkedFrom ? { forkedFrom: rec.forkedFrom } : {}),
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
        "列出已注册的编码 harness（声明式 adapter）及健康状态：二进制是否安装、版本、模型配置文件存在性；http 型 adapter 额外做 transport 探活（超时 3s）。",
      parameters: Type.Object({}),
      execute: async (_params, config) => {
        const cfg = config as BridgeConfig;
        return Promise.all(
          listAdapters(cfg).map(async (a) => {
            const t = resolveTransport(a);
            const base = {
              id: a.id,
              displayName: a.displayName,
              description: a.description ?? null,
              binary: a.binary,
              modelSync: Boolean(a.config?.modelConfig),
              schemaVersion: a.schemaVersion ?? 1,
              ...checkHealth(a),
            };
            if (t.kind === "http") {
              const probe = await probeHttpHealth(t.config as HttpTransport);
              let gate = checkVersionGate(undefined, a.versionGate ?? {});
              if (a.versionGate && probe.ok) {
                const v = await fetchHttpVersion(t.config as HttpTransport);
                gate = checkVersionGate(v, a.versionGate);
              }
              return {
                ...base,
                transport: "http",
                healthy: probe.ok && gate.ok,
                healthDetail: !probe.ok
                  ? (probe.error ?? `HTTP ${probe.status}`)
                  : gate.ok
                    ? `HTTP ${probe.status}，版本 ${gate.version ?? "未知"}`
                    : gate.detail,
                cliFallback: cliFallbackOf(a),
                versionGate: a.versionGate ?? null,
              };
            }
            if (t.kind === "stdio-rpc") {
              const h = checkHealth(a);
              const gate = checkVersionGate(h.version, a.versionGate ?? {});
              return {
                ...base,
                transport: "stdio-rpc",
                healthy: h.installed && gate.ok,
                healthDetail: !h.installed
                  ? "binary 不可用"
                  : gate.ok
                    ? `版本 ${gate.version ?? "未知"}（SDK 就绪，运行时握手复核）`
                    : gate.detail,
                versionGate: a.versionGate ?? null,
              };
            }
            return { ...base, transport: "cli", healthy: base.installed };
          }),
        );
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
        "把编码任务委派给指定 harness。默认后台执行（台账记录，完成后可用 harness_status 查询）；wait=true 同步等待并返回输出尾部。",
      parameters: Type.Object({
        harness: Type.String({ description: "adapter id，见 harness_list" }),
        prompt: Type.String({ description: "任务指令全文" }),
        resumeSessionId: Type.Optional(
          Type.String({ description: "续接会话 ID（adapter 需支持 resume）" }),
        ),
        cwd: Type.Optional(Type.String({ description: "工作目录，默认插件数据目录" })),
        wait: Type.Optional(
          Type.Boolean({ description: "同步等待完成，默认 false（后台执行）" }),
        ),
        timeoutMs: Type.Optional(
          Type.Number({ description: "超时毫秒，默认 adapter 配置或 600000" }),
        ),
        retryOf: Type.Optional(
          Type.String({
            description:
              "重试指定失败任务（fork-before-retry）：先 fork 原会话再续跑，幂等不污染原会话。值 = 原 taskId（须为 failed/timeout/lost 且有 sessionId）",
          }),
        ),
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
        const dataDir = resolveDataDir(cfg);
        const tasksDir = path.join(dataDir, "tasks");
        mkdirSync(tasksDir, { recursive: true });
        const ledger = openLedger(cfg);
        const wait = params.wait === true;
        const timeoutMs =
          params.timeoutMs ?? adapter.delegate.timeoutMs ?? cfg.defaultTimeoutMs ?? 600000;

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

        const transport = resolveTransport(adapter);
        if (transport.kind === "stdio-rpc") {
          const rec = await runDshTask({
            adapter,
            transport: (transport.config ?? { type: "stdio-rpc", command: adapter.binary }) as StdioRpcTransport,
            prompt: params.prompt,
            cwd: params.cwd ?? dataDir,
            dshHome: path.join(dataDir, "dsh-home"),
            wait,
            timeoutMs,
            ledger,
            tasksDir,
            notifyCommand: cfg.notifyCommand,
          });
          return runResponse(rec, wait);
        }

        if (transport.kind === "http") {
          const ht = transport.config as HttpTransport;
          const probe = await probeHttpHealth(ht, { cwd: params.cwd ?? dataDir });
          if (!probe.ok && cliFallbackOf(adapter)) {
            const rec = runTask({
              adapter,
              prompt: params.prompt,
              resumeSessionId: cliResumeSessionId,
              cwd: params.cwd ?? dataDir,
              wait,
              timeoutMs,
              ledger,
              tasksDir,
              notifyCommand: cfg.notifyCommand,
            });
            ledger.append({ ...rec, transport: "cli", fallbackUsed: true });
            return runResponse(rec, wait);
          }
          if (!probe.ok) {
            return {
              error: `http 探活失败: ${probe.error ?? `HTTP ${probe.status}`}，adapter 未配置 fallback，任务未执行`,
            };
          }
          const rec = await runHttpTask({
            adapter,
            transport: ht,
            prompt: params.prompt,
            resumeSessionId: cliResumeSessionId,
            forkFromSessionId,
            cwd: params.cwd ?? dataDir,
            wait,
            timeoutMs,
            ledger,
            tasksDir,
            notifyCommand: cfg.notifyCommand,
          });
          return runResponse(rec, wait);
        }

        // cli：fork-before-retry 走 delegate.fork argv 模板，输出按 idPattern 提取新会话
        if (forkFromSessionId) {
          const forkTpl = adapter.delegate.fork;
          if (!Array.isArray(forkTpl) || forkTpl.length === 0) {
            return { error: "adapter 未配置 delegate.fork（argv 模板），cli 模式不支持 fork-before-retry" };
          }
          const forkArgv = fillTemplate(forkTpl, { sessionId: forkFromSessionId, prompt: params.prompt });
          const fr = spawnSync(forkArgv[0], forkArgv.slice(1), {
            cwd: params.cwd ?? dataDir,
            timeout: 30000,
            encoding: "utf8",
          });
          const forked = extractSessionId(
            `${fr.stdout ?? ""}${fr.stderr ?? ""}`,
            adapter.session?.idPattern,
          );
          if (!forked) {
            return { error: `fork 命令未产出新会话 ID（exit=${fr.status}）` };
          }
          cliResumeSessionId = forked;
        }

        const rec = runTask({
          adapter,
          prompt: params.prompt,
          resumeSessionId: cliResumeSessionId,
          cwd: params.cwd ?? dataDir,
          wait,
          timeoutMs,
          ledger,
          tasksDir,
          notifyCommand: cfg.notifyCommand,
        });
        return runResponse(rec, wait);
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
        "查询委派任务台账（SQLite）：状态/退出码/会话 ID/耗时/输出尾部/成本与 token 聚合/失败归因（fail_reason）。running 任务若进程已消失且无退出记录，自动标记 lost。新增：events=taskId 输出单任务事件时间线；since/until 时间窗过滤；legacy=true 只读查看 v0.1 JSON Lines 旧台账；metrics=true 输出进程内存/事件循环延迟观测摘要（v0.4.1）。",
      parameters: Type.Object({
        taskId: Type.Optional(Type.String({ description: "精确查询单个任务" })),
        harness: Type.Optional(Type.String({ description: "按 harness 过滤" })),
        status: Type.Optional(
          Type.String({ description: "按状态过滤: running/success/failed/timeout/lost" }),
        ),
        limit: Type.Optional(Type.Number({ description: "返回条数上限，默认 20" })),
        events: Type.Optional(
          Type.String({ description: "输出指定任务的事件时间线（值 = taskId）" }),
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
          const events: LedgerEvent[] = ledger.getEvents(params.events);
          return { task, events, total: events.length };
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
    toolEntry.register(api);
    const cfg = (api.pluginConfig ?? {}) as BridgeConfig & {
      statusLineEnabled?: boolean;
      taskboardFile?: string;
      turnPrepareEnabled?: boolean;
      metricsEnabled?: boolean;
      eventRetentionDays?: number;
    };
    const dataDir = resolveDataDir(cfg);
    const ledgerDbPath = path.join(dataDir, "ledger.db");
    const ledgerLegacyFile = path.join(dataDir, "ledger.jsonl");

    // v0.4 状态行钩子：出站消息强制追加「后台任务」状态行
    if (cfg.statusLineEnabled !== false) {
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

    // v0.4.1 观测采样器：内存/事件循环延迟每分钟采样，环形缓冲 24h
    if (cfg.metricsEnabled !== false) {
      try {
        metricsSampler.start();
        // v0.4.2 落盘：启动恢复 + 每小时持久化，网关重启观测数据不断档
        const metricsFile = path.join(dataDir, "metrics.json");
        metricsSampler.loadFromDisk(metricsFile);
        if (metricsSaveTimer) clearInterval(metricsSaveTimer);
        metricsSaveTimer = setInterval(() => {
          try {
            metricsSampler.saveToDisk(metricsFile);
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

    // 网关停止时释放采样器与定时器（v0.4.2：停止前 flush 观测数据）
    api.on("gateway_stop", async () => {
      try {
        metricsSampler.saveToDisk(path.join(dataDir, "metrics.json"));
      } catch {
        // ignore
      }
      try {
        metricsSampler.stop();
      } catch {
        // ignore
      }
      if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
      }
      if (metricsSaveTimer) {
        clearInterval(metricsSaveTimer);
        metricsSaveTimer = null;
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
