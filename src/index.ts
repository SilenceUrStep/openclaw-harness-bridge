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
  type BridgeConfig,
} from "./lib/adapters.js";
import { Ledger, type TaskRecord } from "./lib/ledger.js";
import { runTask } from "./lib/runner.js";
import { loadParamDict } from "./lib/params.js";
import { switchDefaultModel, syncAdapterModels } from "./lib/sync.js";

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
  return new Ledger(path.join(resolveDataDir(cfg), "ledger.jsonl"));
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
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
        "列出已注册的编码 harness（声明式 adapter）及健康状态：二进制是否安装、版本、模型配置文件存在性。",
      parameters: Type.Object({}),
      execute: async (_params, config) => {
        const cfg = config as BridgeConfig;
        return listAdapters(cfg).map((a) => ({
          id: a.id,
          displayName: a.displayName,
          description: a.description ?? null,
          binary: a.binary,
          modelSync: Boolean(a.config?.modelConfig),
          ...checkHealth(a),
        }));
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
        const rec = runTask({
          adapter,
          prompt: params.prompt,
          resumeSessionId: params.resumeSessionId,
          cwd: params.cwd ?? dataDir,
          wait: params.wait === true,
          timeoutMs:
            params.timeoutMs ?? adapter.delegate.timeoutMs ?? cfg.defaultTimeoutMs ?? 600000,
          ledger: openLedger(cfg),
          tasksDir,
          notifyCommand: cfg.notifyCommand,
        });
        if (params.wait === true) {
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
          };
        }
        return {
          taskId: rec.id,
          harness: rec.harness,
          status: rec.status,
          pid: rec.pid ?? null,
          logFile: rec.logFile ?? null,
          hint: "后台执行中，用 harness_status 查询进度与结果",
        };
      },
    }),

    tool({
      name: "harness_status",
      label: "Harness Status",
      description:
        "查询委派任务台账：状态/退出码/会话 ID/耗时/输出尾部。running 任务若进程已消失且无退出记录，自动标记 lost（gateway 重启等场景）。",
      parameters: Type.Object({
        taskId: Type.Optional(Type.String({ description: "精确查询单个任务" })),
        harness: Type.Optional(Type.String({ description: "按 harness 过滤" })),
        status: Type.Optional(
          Type.String({ description: "按状态过滤: running/success/failed/timeout/lost" }),
        ),
        limit: Type.Optional(Type.Number({ description: "返回条数上限，默认 20" })),
      }),
      execute: async (params, config) => {
        const cfg = config as BridgeConfig;
        const ledger = openLedger(cfg);
        const recs = ledger.latest({
          taskId: params.taskId,
          harness: params.harness,
          status: params.status,
        });
        const limit = params.limit ?? 20;
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
        return { total: recs.length, returned: tasks.length, tasks };
      },
    }),
  ],
});
