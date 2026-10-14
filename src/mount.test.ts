import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Adapter } from "./lib/adapters.js";
import { mountAdapterKnowledge } from "./lib/mount.js";

function makeAdapter(configFile: string, withMount = true): Adapter {
  return {
    id: "test",
    displayName: "Test",
    binary: "true",
    delegate: { run: ["true"] },
    config: withMount
      ? {
          mount: {
            configPath: configFile,
            format: "opencode-json",
            externalDirectoryPointer: "$.permission.external_directory",
            instructionsPointer: "$.instructions",
          },
        }
      : {},
  };
}

function writeConfig(dir: string): string {
  const file = path.join(dir, "opencode.json");
  writeFileSync(file, JSON.stringify({ model: "glm-5.2" }));
  return file;
}

describe("mountAdapterKnowledge", () => {
  it("dry-run 报告 changes 且不写文件", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hb-mount-"));
    try {
      const file = writeConfig(dir);
      const before = readFileSync(file, "utf8");
      const report = mountAdapterKnowledge(makeAdapter(file), {
        path: "/data/knowledge",
        inject: "README.md",
        apply: false,
      });
      expect(report.error).toBeUndefined();
      expect(report.applied).toBe(false);
      expect(report.changes).toEqual([
        { field: "external_directory./data/knowledge", from: null, to: "allow" },
        { field: "instructions", from: null, to: "/data/knowledge/README.md" },
      ]);
      expect(report.backupFile).toBeUndefined();
      expect(readFileSync(file, "utf8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("apply=true 写回+备份文件存在+配置内容正确", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hb-mount-"));
    try {
      const file = writeConfig(dir);
      const report = mountAdapterKnowledge(makeAdapter(file), {
        path: "/data/knowledge",
        inject: "README.md",
        apply: true,
      });
      expect(report.applied).toBe(true);
      expect(report.backupFile).toBeDefined();
      expect(existsSync(report.backupFile as string)).toBe(true);
      expect(report.backupFile).toMatch(/\.bak\.hb-\d{14}$/);
      const written = JSON.parse(readFileSync(file, "utf8")) as {
        model: string;
        permission: { external_directory: Record<string, string> };
        instructions: string[];
      };
      expect(written.model).toBe("glm-5.2");
      expect(written.permission.external_directory["/data/knowledge"]).toBe("allow");
      expect(written.instructions).toEqual(["/data/knowledge/README.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("幂等：同 path 第二次 apply changes 为空且进 skipped", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hb-mount-"));
    try {
      const file = writeConfig(dir);
      const adapter = makeAdapter(file);
      const opts = { path: "/data/knowledge", inject: "README.md", apply: true };
      const first = mountAdapterKnowledge(adapter, opts);
      expect(first.applied).toBe(true);
      const second = mountAdapterKnowledge(adapter, opts);
      expect(second.changes).toEqual([]);
      expect(second.skipped).toEqual([
        "external_directory:/data/knowledge",
        "instructions:/data/knowledge/README.md",
      ]);
      expect(second.applied).toBe(false);
      expect(second.backupFile).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("无 mount 配置的 adapter 返回 error", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hb-mount-"));
    try {
      const file = writeConfig(dir);
      const report = mountAdapterKnowledge(makeAdapter(file, false), {
        path: "/data/knowledge",
        apply: false,
      });
      expect(report.error).toBe("adapter 未配置 mount");
      expect(report.applied).toBe(false);
      expect(report.changes).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
