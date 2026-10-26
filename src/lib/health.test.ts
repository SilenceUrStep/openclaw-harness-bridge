import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Adapter, BridgeConfig } from "./adapters.js";
import { probeAdapterStatus, probeAvailability } from "./health.js";
import { fetchHttpVersion, type HttpTransport } from "./transport.js";

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

describe("v0.4.4 http 版本探测（/global/health 适配 + 显性不可用）", () => {
  const servers: Server[] = [];

  afterAll(() => {
    for (const s of servers) s.close();
  });

  function startServer(
    routes: Record<string, { status?: number; body: string; ct?: string }>,
  ): Promise<number> {
    return new Promise((resolve) => {
      const server = createServer((req, res) => {
        const r = routes[req.url ?? "/"] ?? { status: 404, body: "nope" };
        res.writeHead(r.status ?? 200, { "content-type": r.ct ?? "application/json" });
        res.end(r.body);
      });
      servers.push(server);
      server.listen(0, "127.0.0.1", () => {
        resolve((server.address() as { port: number }).port);
      });
    });
  }

  function httpAdapter(port: number, extra?: Record<string, unknown>): Adapter {
    return {
      id: "oc",
      displayName: "opencode",
      binary: "opencode",
      transport: { type: "http", baseUrl: `http://127.0.0.1:${port}`, healthCheck: { path: "/session", expectStatus: 200 } },
      delegate: { run: ["echo", "{prompt}"] },
      ...extra,
    } as unknown as Adapter;
  }

  it("新 SDK：/version 变 SPA HTML，/global/health 返回真实版本", async () => {
    const port = await startServer({
      "/session": { body: '{"ok":true}' },
      "/version": { body: "<html>SPA fallback</html>", ct: "text/html" },
      "/global/health": { body: '{"healthy":true,"version":"1.18.10"}' },
    });
    const t: HttpTransport = { type: "http", baseUrl: `http://127.0.0.1:${port}` };
    expect(await fetchHttpVersion(t)).toBe("1.18.10");
    const s = await probeAdapterStatus({} as BridgeConfig, httpAdapter(port));
    expect(s.healthy).toBe(true);
    expect(s.version).toBe("1.18.10");
    expect(s.healthDetail).toContain("版本 1.18.10");
  });

  it("版本端点全失效 → 显性「版本探测不可用（SDK 2026.9.4）」而非含糊未知", async () => {
    const port = await startServer({
      "/session": { body: '{"ok":true}' },
      "/version": { body: "<html>SPA fallback</html>", ct: "text/html" },
      "/global/health": { status: 404, body: "nope" },
    });
    const t: HttpTransport = { type: "http", baseUrl: `http://127.0.0.1:${port}` };
    expect(await fetchHttpVersion(t)).toBeUndefined();
    const s = await probeAdapterStatus({} as BridgeConfig, httpAdapter(port));
    expect(s.healthy).toBe(true); // 探测不可用不等于不健康
    expect(s.version).toBeUndefined();
    expect(s.healthDetail).toBe("版本探测不可用（SDK 2026.9.4）");
  });

  it("versionGate 配置时用探测到的版本判定（可读 → 通过；端点失效 → 显性拒绝）", async () => {
    const portOk = await startServer({
      "/session": { body: '{"ok":true}' },
      "/global/health": { body: '{"healthy":true,"version":"1.18.10"}' },
    });
    const s1 = await probeAdapterStatus({} as BridgeConfig, httpAdapter(portOk, { versionGate: { min: "1.0.0" } }));
    expect(s1.healthy).toBe(true);
    const portFail = await startServer({
      "/session": { body: '{"ok":true}' },
      "/global/health": { status: 404, body: "nope" },
    });
    const s2 = await probeAdapterStatus({} as BridgeConfig, httpAdapter(portFail, { versionGate: { min: "1.0.0" } }));
    expect(s2.healthy).toBe(false);
    expect(s2.healthDetail).toContain("版本不可读");
  });

  it("versionPath 显式配置优先（不走 /global/health 候选）", async () => {
    const port = await startServer({
      "/info": { body: '{"version":"3.2.1"}' },
      "/global/health": { body: '{"version":"wrong"}' },
    });
    const t: HttpTransport = { type: "http", baseUrl: `http://127.0.0.1:${port}`, versionPath: "/info" };
    expect(await fetchHttpVersion(t)).toBe("3.2.1");
  });
});
