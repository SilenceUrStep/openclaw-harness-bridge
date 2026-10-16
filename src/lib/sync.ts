import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expandHome, type Adapter, type DshModelSyncConfig } from "./adapters.js";
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

export function backupAndWrite(file: string, json: unknown): string {
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

// ---------- dsh-patch 格式（cordis.patch.yml 行式结构，零依赖生成） ----------

const DSH_LLM_PLUGIN = { id: "llm-pi-ai", name: "@deepseek-ai/dsh-llm-pi-ai" };
const DSH_DEFAULT_MODEL_PLUGIN = { id: "agent-default-model", name: "@deepseek-ai/dsh-agent-default-model" };

export interface DshPatchModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
}

interface DshPatchDefault {
  provider: string;
  model: string;
}

/**
 * 最小 YAML block-style emitter（与 dsh 自家 cordis.patch.yml 风格一致）。
 * 普通值裸写；含特殊字符（指示符开头 / ": " / " #" / 引号 / 首尾空白）时单引号包裹（'' 转义）。
 * 输出确定性（幂等文本比对依赖）；仅覆盖 patch 所需结构：嵌套 object/list + 简单标量。
 */
function pad(indent: number): string {
  return " ".repeat(indent);
}

function needsQuote(s: string): boolean {
  if (s === "" || s.trim() !== s) return true;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)) return true;
  if (/:(\s|$)/.test(s) || /\s#/.test(s)) return true;
  return false;
}

function emitScalar(v: unknown): string {
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === null || v === undefined) return "null";
  const s = String(v);
  return needsQuote(s) ? `'${s.replace(/'/g, "''")}'` : s;
}

function isContainer(v: unknown): boolean {
  return v !== null && typeof v === "object";
}

function emitMappingEntries(entries: [string, unknown][], indent: number): string[] {
  const lines: string[] = [];
  for (const [k, v] of entries) {
    if (isContainer(v)) {
      const arr = v as unknown[];
      const obj = v as Record<string, unknown>;
      const empty = Array.isArray(arr) ? arr.length === 0 : Object.keys(obj).length === 0;
      if (empty) {
        lines.push(`${pad(indent)}${k}: ${Array.isArray(arr) ? "[]" : "{}"}`);
        continue;
      }
      lines.push(`${pad(indent)}${k}:`);
      lines.push(...emitNode(v, indent + 2));
    } else {
      lines.push(`${pad(indent)}${k}: ${emitScalar(v)}`);
    }
  }
  return lines;
}

function emitListItem(item: Record<string, unknown>, indent: number): string[] {
  const entries = Object.entries(item);
  const [firstKey, firstVal] = entries[0];
  const lines: string[] = [];
  if (isContainer(firstVal)) {
    lines.push(`${pad(indent)}- ${firstKey}:`);
    lines.push(...emitNode(firstVal, indent + 2));
  } else {
    lines.push(`${pad(indent)}- ${firstKey}: ${emitScalar(firstVal)}`);
  }
  lines.push(...emitMappingEntries(entries.slice(1), indent + 2));
  return lines;
}

function emitNode(v: unknown, indent: number): string[] {
  if (Array.isArray(v)) {
    return v.flatMap((item) => {
      if (isContainer(item) && !Array.isArray(item)) {
        return emitListItem(item as Record<string, unknown>, indent);
      }
      return [`${pad(indent)}- ${emitScalar(item)}`];
    });
  }
  return emitMappingEntries(Object.entries(v as Record<string, unknown>), indent);
}

/** patch 全文确定性生成（block-style：llm 行 providers.<providerId> + agent-default-model 行） */
export function generateDshPatch(
  ms: DshModelSyncConfig,
  models: DshPatchModel[],
  defaultModel: DshPatchDefault,
): string {
  const lines = emitNode(
    [
      {
        id: DSH_LLM_PLUGIN.id,
        name: DSH_LLM_PLUGIN.name,
        config: {
          providers: {
            [ms.gateway.providerId]: {
              apiKeyEnv: ms.gateway.apiKeyEnv,
              api: ms.gateway.api,
              baseURL: ms.gateway.baseURL,
              models,
            },
          },
        },
      },
      {
        id: DSH_DEFAULT_MODEL_PLUGIN.id,
        name: DSH_DEFAULT_MODEL_PLUGIN.name,
        config: {
          provider: defaultModel.provider,
          model: defaultModel.model,
        },
      },
    ],
    0,
  );
  return `${lines.join("\n")}\n`;
}

/** 从本 emitter 固定 block 格式提取既有模型条目（幂等比对用，不解析任意第三方 YAML） */
function unquote(v: string): string {
  const s = v.trim();
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

function extractDshPatchModels(text: string): Map<string, DshPatchModel> {
  const map = new Map<string, DshPatchModel>();
  const re = /- id: (.*?)\n\s+name: (.*?)\n\s+contextWindow: (\d+)\n\s+maxTokens: (\d+)/g;
  for (const m of text.matchAll(re)) {
    map.set(unquote(m[1]), {
      id: unquote(m[1]),
      name: unquote(m[2]),
      contextWindow: Number(m[3]),
      maxTokens: Number(m[4]),
    });
  }
  return map;
}

function extractDshDefaultModel(text: string): DshPatchDefault | null {
  const re =
    /- id: agent-default-model\n\s+name: (.*?)\n\s+config:\n\s+provider: (.*?)\n\s+model: (.*?)(?:\n|$)/;
  const m = re.exec(text);
  if (!m) return null;
  return { provider: unquote(m[2]), model: unquote(m[3]) };
}

/** 备份（.bak.hb-<ts>）+ tmp 原子替换 + 写后校验（tmp 与目标内容字节一致才 rename） */
export function atomicWritePatch(file: string, content: string): string {
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  let backup: string | undefined;
  if (existsSync(file)) {
    backup = `${file}.bak.hb-${ts}`;
    copyFileSync(file, backup);
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.hb-${ts}`;
  writeFileSync(tmp, content);
  if (readFileSync(tmp, "utf8") !== content) {
    throw new Error(`patch 写后校验失败: ${tmp}`);
  }
  renameSync(tmp, file);
  return backup ?? "";
}

function dshPatchFile(ms: DshModelSyncConfig, dataDir: string): string {
  const p = expandHome(ms.patchFile);
  return path.isAbsolute(p) ? p : path.join(dataDir, p);
}

/**
 * dsh-patch 模型同步：按 modelSync.models 逐个 matchParams，
 * exact/prefix 命中生成模型条目，default 兜底档跳过计入 skipped；
 * 确定性生成 → 文本比对幂等 → 变更报告（from=null 为新增）→ apply 走备份原子写。
 */
export function syncDshPatch(
  adapter: Adapter,
  dict: ParamDict,
  apply: boolean,
  dataDir: string,
): SyncReport {
  const ms = adapter.modelSync;
  const report: SyncReport = {
    harness: adapter.id,
    configFile: "",
    format: "dsh-patch",
    totalModels: 0,
    skipped: 0,
    sources: {},
    changes: [],
    applied: false,
  };
  if (!ms || ms.format !== "dsh-patch" || !ms.patchFile) {
    report.error = "adapter 未配置 modelSync（dsh-patch）";
    return report;
  }
  const file = dshPatchFile(ms, dataDir);
  report.configFile = file;
  const defaultModel: DshPatchDefault = ms.defaultModel ?? {
    provider: ms.gateway.providerId,
    model: ms.models[0] ?? "",
  };
  const models: DshPatchModel[] = [];
  for (const modelId of ms.models) {
    if (isSkipped(dict, modelId)) {
      report.skipped++;
      continue;
    }
    const { cfg, source } = matchParams(dict, modelId);
    if (source === "default") {
      report.skipped++;
      continue;
    }
    if (cfg.contextWindow == null || cfg.maxTokens == null) {
      report.skipped++;
      continue;
    }
    report.totalModels++;
    report.sources[source] = (report.sources[source] ?? 0) + 1;
    models.push({
      id: modelId,
      name: cfg.name ?? modelId,
      contextWindow: cfg.contextWindow,
      maxTokens: cfg.maxTokens,
    });
  }
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (existing) {
    const existingModels = extractDshPatchModels(existing);
    const existingDefault = extractDshDefaultModel(existing);
    for (const m of models) {
      const old = existingModels.get(m.id) ?? null;
      if (!old || JSON.stringify(old) !== JSON.stringify(m)) {
        report.changes.push({
          provider: ms.gateway.providerId,
          model: m.id,
          field: "model",
          from: old,
          to: m,
        });
      }
    }
    if (!existingDefault || existingDefault.model !== defaultModel.model || existingDefault.provider !== defaultModel.provider) {
      report.changes.push({
        provider: ms.gateway.providerId,
        model: DSH_DEFAULT_MODEL_PLUGIN.id,
        field: "defaultModel",
        from: existingDefault,
        to: defaultModel,
      });
    }
  } else {
    for (const m of models) {
      report.changes.push({
        provider: ms.gateway.providerId,
        model: m.id,
        field: "model",
        from: null,
        to: m,
      });
    }
    report.changes.push({
      provider: ms.gateway.providerId,
      model: DSH_DEFAULT_MODEL_PLUGIN.id,
      field: "defaultModel",
      from: null,
      to: defaultModel,
    });
  }
  if (apply && report.changes.length > 0) {
    report.backupFile = atomicWritePatch(file, generateDshPatch(ms, models, defaultModel));
    report.applied = true;
  }
  return report;
}

/** dsh 默认模型切换：重新生成 patch（defaultModel 换新值），模型条目保持现状 */
export function switchDshDefaultModel(
  adapter: Adapter,
  model: string,
  apply: boolean,
  dataDir: string,
): DefaultSwitchResult {
  const ms = adapter.modelSync;
  const base: DefaultSwitchResult = {
    harness: adapter.id,
    pointer: `${DSH_DEFAULT_MODEL_PLUGIN.id}.config.model`,
    value: model,
    applied: false,
  };
  if (!ms || ms.format !== "dsh-patch") {
    return { ...base, error: "adapter 未配置 modelSync（dsh-patch）" };
  }
  const file = dshPatchFile(ms, dataDir);
  if (!existsSync(file)) return { ...base, error: `patch 文件不存在: ${file}` };
  try {
    const text = readFileSync(file, "utf8");
    const existingModels = [...extractDshPatchModels(text).values()];
    const current = extractDshDefaultModel(text);
    const next: DshPatchDefault = {
      provider: ms.defaultModel?.provider ?? ms.gateway.providerId,
      model,
    };
    if (current && current.provider === next.provider && current.model === next.model) {
      return base;
    }
    if (apply) {
      atomicWritePatch(file, generateDshPatch(ms, existingModels, next));
      base.applied = true;
    }
    return base;
  } catch (e) {
    return { ...base, error: (e as Error).message };
  }
}
