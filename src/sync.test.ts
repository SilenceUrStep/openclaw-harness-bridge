import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Adapter } from "./lib/adapters.js";
import type { ParamDict } from "./lib/params.js";
import { syncAdapterModels } from "./lib/sync.js";

function makeAdapter(configFile: string): Adapter {
  return {
    id: "test",
    displayName: "Test",
    binary: "true",
    delegate: { run: ["true"] },
    config: {
      modelConfig: {
        path: configFile,
        format: "opencode-json",
        modelsPointer: "$.providers.test.models",
      },
    },
  };
}

describe("syncAdapterModels 备份文件名", () => {
  it("备份时间戳为14位数字、无尾部点号（v0.2 修复回归）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hb-test-"));
    try {
      const file = path.join(dir, "opencode.json");
      writeFileSync(
        file,
        JSON.stringify({
          providers: { test: { models: { "glm-5.2": { name: "GLM-5.2", contextWindow: 1 } } } },
        }),
      );
      const dict: ParamDict = { exact: { "glm-5.2": { contextWindow: 200000 } } };
      const report = syncAdapterModels(makeAdapter(file), dict, true);
      expect(report.applied).toBe(true);
      expect(report.backupFile).toBeDefined();
      // 修复前：.bak.hb-20261015052631.（slice(0,15) 把毫秒点号带进来）
      // 修复后：.bak.hb-20261015052631（14位纯数字）
      expect(report.backupFile).toMatch(/\.bak\.hb-\d{14}$/);
      const written = JSON.parse(readFileSync(file, "utf8")) as {
        providers: { test: { models: { "glm-5.2": { contextWindow: number } } } };
      };
      expect(written.providers.test.models["glm-5.2"].contextWindow).toBe(200000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
