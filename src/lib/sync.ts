import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { expandHome, type Adapter } from "./adapters.js";
import {
  isSkipped,
  matchParams,
  setAtPath,
  walkPointer,
  type ParamDict,
  type ParamEntry,
} from "./params.js";

export interface SyncModelChange {
  provider: string;
  model: string;
  field: string;
  from: unknown;
  to: unknown;
}

export interface SyncReport {
  harness: string;
  configFile: string;
  format: string;
  totalModels: number;
  skipped: number;
  sources: Record<string, number>;
  changes: SyncModelChange[];
  applied: boolean;
  backupFile?: string;
  error?: string;
}

export interface DefaultSwitchResult {
  harness: string;
  pointer: string;
  value: string;
  applied: boolean;
  error?: string;
}

/** 字典键 → 配置文件字段的默认映射；adapter 声明 fieldMap 时全量替换 */
const DEFAULT_FIELD_MAP: Record<string, string> = {
  name: "name",
  contextWindow: "contextWindow",
  maxTokens: "maxTokens",
  reasoning: "reasoning",
};

function backupAndWrite(file: string, json: unknown): string {
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const backup = `${file}.bak.hb-${ts}`;
  copyFileSync(file, backup);
  const tmp = `${file}.tmp.hb`;
  writeFileSync(tmp, `${JSON.stringify(json, null, 2)}\n`);
  JSON.parse(readFileSync(tmp, "utf8")); // 写后验证：能完整解析才替换
  renameSync(tmp, file);
  return backup;
}

/**
 * 按参数字典校准单个 adapter 的模型配置。
 * 字段级 merge：只写字典提供的键，不碰用户手工调优的其他字段；写回前自动备份。
 */
export function syncAdapterModels(adapter: Adapter, dict: ParamDict, apply: boolean): SyncReport {
  const mc = adapter.config?.modelConfig;
  const report: SyncReport = {
    harness: adapter.id,
    configFile: mc?.path ?? "",
    format: mc?.format ?? "",
    totalModels: 0,
    skipped: 0,
    sources: {},
    changes: [],
    applied: false,
  };
  if (!mc?.path || !mc.modelsPointer) {
    report.error = "adapter 未配置 modelConfig.path / modelsPointer";
    return report;
  }
  if (mc.format !== "opencode-json") {
    report.error = `MVP 仅支持 opencode-json 格式，当前格式: ${mc.format}`;
    return report;
  }
  const file = expandHome(mc.path);
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

  const fieldMap = mc.fieldMap ?? DEFAULT_FIELD_MAP;
  for (const container of walkPointer(json, mc.modelsPointer)) {
    const models = container.value;
    if (!models || typeof models !== "object") continue;
    const provider = container.path.slice(0, -1).join("/") || "(root)";
    for (const [modelId, raw] of Object.entries(models as Record<string, unknown>)) {
      if (isSkipped(dict, modelId)) {
        report.skipped++;
        continue;
      }
      if (!raw || typeof raw !== "object") continue;
      report.totalModels++;
      const { cfg, source } = matchParams(dict, modelId);
      report.sources[source] = (report.sources[source] ?? 0) + 1;
      const modelObj = raw as Record<string, unknown>;
      for (const [dictKey, cfgKey] of Object.entries(fieldMap)) {
        const target = cfg[dictKey as keyof ParamEntry];
        if (target === undefined) continue;
        if (modelObj[cfgKey] !== target) {
          report.changes.push({
            provider,
            model: modelId,
            field: cfgKey,
            from: modelObj[cfgKey] ?? null,
            to: target,
          });
          if (apply) modelObj[cfgKey] = target;
        }
      }
    }
  }

  if (apply && report.changes.length > 0) {
    report.backupFile = backupAndWrite(file, json);
    report.applied = true;
  }
  return report;
}

/** 切换 harness 默认模型（如 opencode 顶层 model 字段） */
export function switchDefaultModel(
  adapter: Adapter,
  model: string,
  apply: boolean,
): DefaultSwitchResult {
  const mc = adapter.config?.modelConfig;
  const base: DefaultSwitchResult = {
    harness: adapter.id,
    pointer: mc?.defaultModelPointer ?? "",
    value: model,
    applied: false,
  };
  if (!mc?.path || !mc.defaultModelPointer) {
    return { ...base, error: "adapter 未配置 modelConfig.path / defaultModelPointer" };
  }
  if (mc.format !== "opencode-json") {
    return { ...base, error: `MVP 仅支持 opencode-json 格式，当前格式: ${mc.format}` };
  }
  const file = expandHome(mc.path);
  if (!existsSync(file)) return { ...base, error: `配置文件不存在: ${file}` };
  try {
    const json = JSON.parse(readFileSync(file, "utf8")) as unknown;
    setAtPath(json, mc.defaultModelPointer, model);
    if (apply) {
      backupAndWrite(file, json);
      base.applied = true;
    }
    return base;
  } catch (e) {
    return { ...base, error: (e as Error).message };
  }
}
