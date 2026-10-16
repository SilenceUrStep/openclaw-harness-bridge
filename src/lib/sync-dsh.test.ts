import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { load } from "js-yaml";
import type { Adapter } from "./adapters.js";
import type { ParamDict } from "./params.js";
import { generateDshPatch, switchDshDefaultModel, syncDshPatch } from "./sync.js";

const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

const dict: ParamDict = {
  defaults: { contextWindow: 128000, maxTokens: 8192 },
  exact: {
    "glm-5.3-flash": { name: "GLM-5.3 Flash", contextWindow: 200000, maxTokens: 128000 },
    "glm-5.2": { name: "GLM-5.2", contextWindow: 128000, maxTokens: 96000 },
  },
  prefix: [{ match: "deepseek-v4", contextWindow: 160000, maxTokens: 64000 }],
};

function dshAdapter(): Adapter {
  return {
    id: "dsh",
    displayName: "DeepSeek Harness (dsh)",
    binary: "dsh",
    schemaVersion: 2,
    modelSync: {
      format: "dsh-patch",
      patchFile: "dsh-home/cordis.patch.yml",
      gateway: {
        providerId: "tokenhub",
        displayName: "TokenHub",
        api: "openai-completions",
        baseURL: "https://api.lkeap.cloud.tencent.com/plan/v3",
        apiKeyEnv: "TOKENHUB_API_KEY",
      },
      models: ["glm-5.3-flash", "glm-5.2", "deepseek-v4-pro", "unknown-model"],
      defaultModel: { provider: "tokenhub", model: "glm-5.3-flash" },
    },
    delegate: { run: ["dsh"] },
  } as unknown as Adapter;
}

function newEnv(): { dataDir: string; patchFile: string } {
  const dataDir = mkdtempSync(path.join(tmpdir(), "hb-dshsync-"));
  dirs.push(dataDir);
  return { dataDir, patchFile: path.join(dataDir, "dsh-home", "cordis.patch.yml") };
}

const EXPECTED_LLM_BLOCK = [
  "- id: llm-pi-ai",
  "  name: '@deepseek-ai/dsh-llm-pi-ai'",
  "  config:",
  "    providers:",
  "      tokenhub:",
  "        apiKeyEnv: TOKENHUB_API_KEY",
  "        api: openai-completions",
  "        baseURL: https://api.lkeap.cloud.tencent.com/plan/v3",
  "        models:",
  "          - id: glm-5.3-flash",
  "            name: GLM-5.3 Flash",
  "            contextWindow: 200000",
  "            maxTokens: 128000",
  "          - id: glm-5.2",
  "            name: GLM-5.2",
  "            contextWindow: 128000",
  "            maxTokens: 96000",
  "          - id: deepseek-v4-pro",
  "            name: deepseek-v4-pro",
  "            contextWindow: 160000",
  "            maxTokens: 64000",
].join("\n");
const EXPECTED_DEFAULT_BLOCK = [
  "- id: agent-default-model",
  "  name: '@deepseek-ai/dsh-agent-default-model'",
  "  config:",
  "    provider: tokenhub",
  "    model: glm-5.3-flash",
].join("\n");

describe("syncDshPatch（dsh-patch 格式）", () => {
  it("生成：exact/prefix 命中出条目，default 档跳过计入 skipped，dry-run 不写文件", () => {
    const { dataDir, patchFile } = newEnv();
    const report = syncDshPatch(dshAdapter(), dict, false, dataDir);
    expect(report.format).toBe("dsh-patch");
    expect(report.totalModels).toBe(3);
    expect(report.skipped).toBe(1);
    expect(report.sources).toEqual({ exact: 2, prefix: 1 });
    expect(report.changes.length).toBe(4);
    expect(report.changes.every((c) => c.from === null)).toBe(true);
    expect(report.applied).toBe(false);
    expect(existsSync(patchFile)).toBe(false);
  });

  it("apply=true：确定性生成 block-style patch，目录自动创建，无残留 tmp", () => {
    const { dataDir, patchFile } = newEnv();
    const report = syncDshPatch(dshAdapter(), dict, true, dataDir);
    expect(report.applied).toBe(true);
    expect(report.backupFile).toBe("");
    const text = readFileSync(patchFile, "utf8");
    expect(text).toBe(`${EXPECTED_LLM_BLOCK}\n${EXPECTED_DEFAULT_BLOCK}\n`);
    const leftovers = readdirSync(path.dirname(patchFile)).filter((f) => f.includes(".tmp.hb-"));
    expect(leftovers).toEqual([]);
  });

  it("标准 YAML 解析验证（js-yaml）：2 个条目、键齐全、providers.tokenhub.models 4 条", () => {
    const { dataDir, patchFile } = newEnv();
    const hitAll: ParamDict = {
      ...dict,
      exact: {
        ...dict.exact,
        "unknown-model": { name: "Unknown Model: v1", contextWindow: 32000, maxTokens: 4096 },
      },
    };
    syncDshPatch(dshAdapter(), hitAll, true, dataDir);
    const doc = load(readFileSync(patchFile, "utf8")) as Array<{
      id: string;
      name: string;
      config: Record<string, unknown>;
    }>;
    expect(Array.isArray(doc)).toBe(true);
    expect(doc.length).toBe(2);
    expect(doc[0].id).toBe("llm-pi-ai");
    expect(doc[0].name).toBe("@deepseek-ai/dsh-llm-pi-ai");
    const gateway = (doc[0].config as { providers: Record<string, { apiKeyEnv: string; api: string; baseURL: string; models: Array<Record<string, unknown>> }> }).providers.tokenhub;
    expect(gateway.apiKeyEnv).toBe("TOKENHUB_API_KEY");
    expect(gateway.api).toBe("openai-completions");
    expect(gateway.baseURL).toBe("https://api.lkeap.cloud.tencent.com/plan/v3");
    expect(gateway.models.length).toBe(4);
    expect(gateway.models[0]).toEqual({ id: "glm-5.3-flash", name: "GLM-5.3 Flash", contextWindow: 200000, maxTokens: 128000 });
    expect(gateway.models[3]).toEqual({ id: "unknown-model", name: "Unknown Model: v1", contextWindow: 32000, maxTokens: 4096 });
    expect(doc[1].id).toBe("agent-default-model");
    expect(doc[1].config).toEqual({ provider: "tokenhub", model: "glm-5.3-flash" });
  });

  it("generateDshPatch：与 apply 产物逐字节一致（纯函数）", () => {
    const ms = dshAdapter().modelSync!;
    const models = [
      { id: "glm-5.3-flash", name: "GLM-5.3 Flash", contextWindow: 200000, maxTokens: 128000 },
    ];
    expect(generateDshPatch(ms, models, { provider: "tokenhub", model: "glm-5.3-flash" })).toBe(
      [
        "- id: llm-pi-ai",
        "  name: '@deepseek-ai/dsh-llm-pi-ai'",
        "  config:",
        "    providers:",
        "      tokenhub:",
        "        apiKeyEnv: TOKENHUB_API_KEY",
        "        api: openai-completions",
        "        baseURL: https://api.lkeap.cloud.tencent.com/plan/v3",
        "        models:",
        "          - id: glm-5.3-flash",
        "            name: GLM-5.3 Flash",
        "            contextWindow: 200000",
        "            maxTokens: 128000",
        "- id: agent-default-model",
        "  name: '@deepseek-ai/dsh-agent-default-model'",
        "  config:",
        "    provider: tokenhub",
        "    model: glm-5.3-flash",
        "",
      ].join("\n"),
    );
  });

  it("幂等：二次同步零变更不重写（applied=false）", () => {
    const { dataDir, patchFile } = newEnv();
    syncDshPatch(dshAdapter(), dict, true, dataDir);
    const before = readFileSync(patchFile, "utf8");
    const report = syncDshPatch(dshAdapter(), dict, true, dataDir);
    expect(report.changes).toEqual([]);
    expect(report.applied).toBe(false);
    expect(readFileSync(patchFile, "utf8")).toBe(before);
  });

  it("字典变更 → apply 产生 .bak 备份（内容为旧版）+ 新值落盘 + changes 报告 from=旧条目", () => {
    const { dataDir, patchFile } = newEnv();
    syncDshPatch(dshAdapter(), dict, true, dataDir);
    const oldText = readFileSync(patchFile, "utf8");
    const dict2: ParamDict = {
      ...dict,
      exact: {
        ...dict.exact,
        "glm-5.2": { name: "GLM-5.2 Updated", contextWindow: 128000, maxTokens: 90000 },
      },
    };
    const report = syncDshPatch(dshAdapter(), dict2, true, dataDir);
    expect(report.applied).toBe(true);
    expect(report.backupFile).toBeTruthy();
    expect(readFileSync(report.backupFile as string, "utf8")).toBe(oldText);
    const changed = report.changes.find((c) => c.model === "glm-5.2");
    expect(changed).toMatchObject({ field: "model", from: { maxTokens: 96000 }, to: { maxTokens: 90000 } });
    expect(readFileSync(patchFile, "utf8")).toContain("maxTokens: 90000");
  });

  it("switchDshDefaultModel：换默认模型重生成 patch，llm 行不动；幂等", () => {
    const { dataDir, patchFile } = newEnv();
    syncDshPatch(dshAdapter(), dict, true, dataDir);
    const llmBefore = readFileSync(patchFile, "utf8").split("\n")[0];
    const r1 = switchDshDefaultModel(dshAdapter(), "glm-5.2", true, dataDir);
    expect(r1.applied).toBe(true);
    expect(r1.pointer).toBe("agent-default-model.config.model");
    const after = readFileSync(patchFile, "utf8");
    expect(after.split("\n")[0]).toBe(llmBefore);
    expect(after).toContain("model: glm-5.2");
    expect(after).not.toContain("model: glm-5.3-flash");
    const r2 = switchDshDefaultModel(dshAdapter(), "glm-5.2", true, dataDir);
    expect(r2.applied).toBe(false);
    // dry-run 只报告不写
    const r3 = switchDshDefaultModel(dshAdapter(), "glm-5.3-flash", false, dataDir);
    expect(r3.applied).toBe(false);
    expect(readFileSync(patchFile, "utf8")).toContain("model: glm-5.2");
  });

  it("缺 modelSync / 无命中模型只跳过不报错", () => {
    const { dataDir } = newEnv();
    const noMs = { id: "dsh", delegate: { run: ["dsh"] } } as unknown as Adapter;
    const report = syncDshPatch(noMs, dict, false, dataDir);
    expect(report.error).toContain("未配置 modelSync");
    const emptyDict: ParamDict = { defaults: {} };
    const report2 = syncDshPatch(dshAdapter(), emptyDict, false, dataDir);
    expect(report2.totalModels).toBe(0);
    expect(report2.skipped).toBe(4);
    // 模型全部跳过，仅 default-model 行为新增
    expect(report2.changes.length).toBe(1);
    expect(report2.changes[0]).toMatchObject({ field: "defaultModel", from: null });
  });

  it("手工维护的 patch 文件（外部 block-style）→ 与生成结果不一致时按变更报告处理", () => {
    const { dataDir, patchFile } = newEnv();
    mkdirSync(path.dirname(patchFile), { recursive: true });
    writeFileSync(
      patchFile,
      [
        "- id: llm-pi-ai",
        "  name: '@deepseek-ai/dsh-llm-pi-ai'",
        "  config:",
        "    providers:",
        "      tokenhub:",
        "        apiKeyEnv: TOKENHUB_API_KEY",
        "        api: openai-completions",
        "        baseURL: https://api.lkeap.cloud.tencent.com/plan/v3",
        "        models: []",
        "- id: agent-default-model",
        "  name: '@deepseek-ai/dsh-agent-default-model'",
        "  config:",
        "    provider: tokenhub",
        "    model: glm-5.2",
        "",
      ].join("\n"),
    );
    const report = syncDshPatch(dshAdapter(), dict, false, dataDir);
    const modelChanges = report.changes.filter((c) => c.field === "model");
    expect(modelChanges.length).toBe(3);
    expect(modelChanges.every((c) => c.from === null)).toBe(true);
    const defChange = report.changes.find((c) => c.field === "defaultModel");
    expect(defChange).toMatchObject({ from: { model: "glm-5.2" }, to: { model: "glm-5.3-flash" } });
  });
});
