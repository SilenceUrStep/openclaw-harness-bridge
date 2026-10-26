import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Adapter, BridgeConfig } from "./adapters.js";
import { probeAdapterStatus, probeAvailability } from "./health.js";

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

function tmpCfg(adapterJson?: Record<string, unknown>): BridgeConfig {
  const dir = mkdtempSync(path.join(tmpdir(), "hb-health-"));
  dirs.push(dir);
  if (adapterJson) {
    const adir = path.join(dir, "adapters");
    mkdirSync(adir, { recursive: true });
    writeFileSync(path.join(adir, "a.json"), JSON.stringify(adapterJson));
  }
  return { dataDir: dir, adaptersDir: path.join(dir, "adapters") } as BridgeConfig;
}

describe("probeAvailability（v0.4.3 降级判定）", () => {
  it("binary 可用（echo）→ available=true", async () => {
    const r = await probeAvailability({} as BridgeConfig, "echo");
    expect(r.available).toBe(true);
  });

  it("binary 缺失 → available=false（进程启动失败类）", async () => {
    const cfg = tmpCfg({
      id: "ghost",
      binary: "no-such-binary-hb",
      delegate: { run: ["no-such-binary-hb", "{prompt}"] },
    });
    const r = await probeAvailability(cfg, "ghost");
    expect(r.available).toBe(false);
    expect(r.detail).toContain("不可用");
  });

  it("未注册 adapter → available=false", async () => {
    const r = await probeAvailability({} as BridgeConfig, "nope");
    expect(r.available).toBe(false);
    expect(r.detail).toContain("未注册");
  });
});

describe("probeAdapterStatus（v0.4.3 诊断增强）", () => {
  it("cli healthy：healthDetail 带版本", async () => {
    const s = await probeAdapterStatus({} as BridgeConfig, {
      id: "echo2",
      binary: "echo",
      versionCheck: ["echo", "ok"],
      delegate: { run: ["echo", "{prompt}"] },
    } as unknown as Adapter);
    expect(s.healthy).toBe(true);
    expect(s.healthDetail).toContain("版本");
    expect(s.capabilities).toEqual([]);
  });

  it("cli binary 缺失：healthDetail 附诊断线索（PATH/疑似原因）", async () => {
    const s = await probeAdapterStatus({} as BridgeConfig, {
      id: "ghost",
      binary: "no-such-binary-hb",
      delegate: { run: ["no-such-binary-hb", "{prompt}"] },
    } as unknown as Adapter);
    expect(s.healthy).toBe(false);
    expect(s.healthDetail).toContain("binary 不可用");
    expect(s.healthDetail).toContain("诊断");
    expect(s.healthDetail).toContain("当前 PATH=");
    expect(s.healthDetail).toContain("疑似原因");
  });

  it("stdio-rpc binary 缺失：同样附诊断", async () => {
    const s = await probeAdapterStatus({} as BridgeConfig, {
      id: "dshx",
      binary: "no-such-binary-hb",
      transport: { type: "stdio-rpc", command: "no-such-binary-hb" },
      delegate: { run: ["no-such-binary-hb"] },
      capabilities: ["general"],
    } as unknown as Adapter);
    expect(s.healthy).toBe(false);
    expect(s.healthDetail).toContain("诊断");
    expect(s.capabilities).toEqual(["general"]);
  });
});
