import { readFileSync } from "node:fs";

export interface ParamEntry {
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
}

export interface ParamDict {
  _comment?: string;
  defaults?: ParamEntry;
  exact?: Record<string, ParamEntry>;
  prefix?: Array<{ match: string } & ParamEntry>;
  skip_patterns?: string[];
}

export function loadParamDict(file: string): ParamDict {
  return JSON.parse(readFileSync(file, "utf8")) as ParamDict;
}

export interface ParamMatch {
  cfg: ParamEntry;
  source: "exact" | "prefix" | "default";
}

/** 三级匹配：exact 全称 → prefix 家族前缀 → defaults 兜底（生产环境验证过的口径） */
export function matchParams(dict: ParamDict, modelId: string): ParamMatch {
  const low = modelId.toLowerCase();
  const ex = dict.exact?.[low];
  if (ex) return { cfg: ex, source: "exact" };
  for (const p of dict.prefix ?? []) {
    if (p.match && low.startsWith(p.match.toLowerCase())) {
      const { match, ...cfg } = p;
      return { cfg, source: "prefix" };
    }
  }
  return { cfg: dict.defaults ?? {}, source: "default" };
}

export function isSkipped(dict: ParamDict, modelId: string): boolean {
  return (dict.skip_patterns ?? []).some((p) => {
    try {
      return new RegExp(p, "i").test(modelId);
    } catch {
      return modelId.toLowerCase().includes(p.toLowerCase());
    }
  });
}

/** 极简 JSON Pointer 子集：$.a.b.*.c（* 匹配任意对象键），返回全部命中及路径 */
export function walkPointer(obj: unknown, pointer: string): Array<{ path: string[]; value: unknown }> {
  const parts = pointer
    .replace(/^\$\.?/, "")
    .split(".")
    .filter(Boolean);
  const results: Array<{ path: string[]; value: unknown }> = [];
  const walk = (cur: unknown, idx: number, acc: string[]) => {
    if (idx === parts.length) {
      results.push({ path: acc, value: cur });
      return;
    }
    if (!cur || typeof cur !== "object") return;
    const part = parts[idx];
    if (part === "*") {
      for (const [k, v] of Object.entries(cur as Record<string, unknown>)) {
        walk(v, idx + 1, [...acc, k]);
      }
    } else if (part in (cur as Record<string, unknown>)) {
      walk((cur as Record<string, unknown>)[part], idx + 1, [...acc, part]);
    }
  };
  walk(obj, 0, []);
  return results;
}

/** 按 JSON Pointer 写值（中间层不存在则创建），仅支持对象键路径 */
export function setAtPath(obj: unknown, pointer: string, value: unknown): boolean {
  const parts = pointer
    .replace(/^\$\.?/, "")
    .split(".")
    .filter(Boolean);
  if (parts.length === 0) return false;
  let cur = obj as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!cur[p] || typeof cur[p] !== "object") cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
  return true;
}
