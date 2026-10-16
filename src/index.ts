import { spawnSync } from "node:child_process";
import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
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
import { switchDefaultModel, syncAdapterModels } from "./lib/sync.js";
import { mountAdapterKnowledge } from "./lib/mount.js";

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

export default defineToolPlugin({
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
        let adapters = listAdapters(cfg).filter((a) => a.config?.modelConfig);
        if (params.harness) adapters = adapters.filter((a) => a.id === params.harness);
        if (adapters.length === 0) {
          return { error: "没有匹配的 adapter（或所选 adapter 未配置 modelConfig）" };
        }
        const reports = adapters.map((a) => {
          const r = syncAdapterModels(a, dict, apply);
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
          ? adapters.map((a) => switchDefaultModel(a, params.setDefaultModel as string, apply))
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
        "查询委派任务台账（SQLite）：状态/退出码/会话 ID/耗时/输出尾部/成本与 token 聚合/失败归因（fail_reason）。running 任务若进程已消失且无退出记录，自动标记 lost。新增：events=taskId 输出单任务事件时间线；since/until 时间窗过滤；legacy=true 只读查看 v0.1 JSON Lines 旧台账。",
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
      }),
      execute: async (params, config) => {
        const cfg = config as BridgeConfig;
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
