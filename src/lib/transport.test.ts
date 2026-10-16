import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Adapter } from "./adapters.js";
import { cliFallbackOf, checkVersionGate, compareSemver, parseSemver, probeHttpHealth, resolveTransport } from "./transport.js";

let server: Server;
let baseUrl = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/ok") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    } else if (req.url === "/denied") {
      res.writeHead(401);
      res.end("unauthorized");
    } else if (req.url === "/slow") {
      setTimeout(() => {
        res.writeHead(200);
        res.end("{}");
      }, 1500);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const v1Adapter = {
  id: "echo",
  displayName: "Echo",
  binary: "echo",
  delegate: { run: ["echo", "{prompt}"] },
} as unknown as Adapter;

const httpAdapter = (transport: Record<string, unknown>) =>
  ({
    id: "opencode",
    displayName: "OpenCode",
    binary: "opencode",
    delegate: { run: ["opencode"] },
    schemaVersion: 2,
    transport,
  }) as unknown as Adapter;

describe("resolveTransport", () => {
  it("v1 adapter（无 transport 字段）= cli", () => {
    expect(resolveTransport(v1Adapter)).toEqual({ kind: "cli" });
  });

  it("v2 http 解析", () => {
    const t = resolveTransport(
      httpAdapter({ type: "http", baseUrl: "http://127.0.0.1:4096", fallback: { type: "cli" } }),
    );
    expect(t.kind).toBe("http");
    expect(t.config).toMatchObject({ baseUrl: "http://127.0.0.1:4096" });
  });

  it("stdio-rpc 识别（本期只解析不执行）", () => {
    const t = resolveTransport(httpAdapter({ type: "stdio-rpc", command: "dsh" }));
    expect(t.kind).toBe("stdio-rpc");
  });

  it("非法 type 兜底为 cli", () => {
    const t = resolveTransport(httpAdapter({ type: "pigeon" }));
    expect(t.kind).toBe("cli");
  });
});

describe("cliFallbackOf", () => {
  it("v1 / 无 fallback 配置默认回落 cli", () => {
    expect(cliFallbackOf(v1Adapter)).toBe(false);
    expect(cliFallbackOf(httpAdapter({ type: "http", baseUrl }))).toBe(true);
    expect(cliFallbackOf(httpAdapter({ type: "http", baseUrl, fallback: { type: "cli" } }))).toBe(true);
  });
});

describe("versionGate（http / stdio-rpc 通用）", () => {
  it("parseSemver 容忍前缀噪声与 prerelease", () => {
    expect(parseSemver("dsh 0.2.1-alpha.3")).toMatchObject({ major: 0, minor: 2, patch: 1, pre: "alpha.3" });
    expect(parseSemver("0.3.x")).toMatchObject({ major: 0, minor: 3, patch: -1 });
    expect(parseSemver("garbage")).toBeUndefined();
  });

  it("compareSemver：数值比较、通配、prerelease 排序", () => {
    expect(compareSemver(parseSemver("0.2.1")!, parseSemver("0.2.2")!)).toBe(-1);
    expect(compareSemver(parseSemver("1.0.0")!, parseSemver("1.0.0")!)).toBe(0);
    expect(compareSemver(parseSemver("0.4.0")!, parseSemver("0.3.x")!)).toBe(1);
    expect(compareSemver(parseSemver("0.3.9")!, parseSemver("0.3.x")!)).toBe(0);
    expect(compareSemver(parseSemver("0.2.1-alpha.3")!, parseSemver("0.2.1")!)).toBe(-1);
  });

  it("checkVersionGate：min/max 越界显性拒绝；min 同版本 prerelease 放行；x 通配上限", () => {
    const gate = { min: "0.2.1", max: "0.3.x" };
    expect(checkVersionGate("0.2.1", gate).ok).toBe(true);
    expect(checkVersionGate("0.2.1-alpha.3", gate).ok).toBe(true); // 精确同版本锁
    expect(checkVersionGate("0.3.9", gate).ok).toBe(true);
    expect(checkVersionGate("0.2.0", gate).ok).toBe(false);
    expect(checkVersionGate("0.2.0", gate).detail).toContain("低于");
    expect(checkVersionGate("0.4.0", gate).ok).toBe(false);
    expect(checkVersionGate("0.4.0", gate).detail).toContain("超过");
    expect(checkVersionGate(undefined, gate).ok).toBe(false);
    expect(checkVersionGate("0.2.1", {}).ok).toBe(true);
  });
});

describe("probeHttpHealth（超时 3s 语义）", () => {
  it("2xx 命中 → ok", async () => {
    const r = await probeHttpHealth({ type: "http", baseUrl, healthCheck: { path: "/ok" } });
    expect(r).toMatchObject({ ok: true, status: 200 });
  });

  it("expectStatus 匹配 401 也算 ok（显式声明）", async () => {
    const r = await probeHttpHealth({
      type: "http",
      baseUrl,
      healthCheck: { path: "/denied", expectStatus: 401 },
    });
    expect(r.ok).toBe(true);
  });

  it("401（未配 Basic Auth）→ unhealthy", async () => {
    const r = await probeHttpHealth({ type: "http", baseUrl, healthCheck: { path: "/denied" } });
    expect(r).toMatchObject({ ok: false, status: 401 });
  });

  it("连接拒绝 → unhealthy 且带错误信息", async () => {
    const r = await probeHttpHealth({ type: "http", baseUrl: "http://127.0.0.1:1", healthCheck: {} });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it("探活超时 → unhealthy", async () => {
    const r = await probeHttpHealth(
      { type: "http", baseUrl, healthCheck: { path: "/slow" } },
      { timeoutMs: 200 },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it("Basic Auth 头从 env 读取，凭证不硬编码", async () => {
    let sawAuth: string | undefined;
    const authServer = createServer((req, res) => {
      sawAuth = req.headers.authorization;
      res.writeHead(200);
      res.end("{}");
    });
    await new Promise<void>((resolve) => authServer.listen(0, "127.0.0.1", resolve));
    const authUrl = `http://127.0.0.1:${(authServer.address() as AddressInfo).port}`;
    process.env.HB_TEST_USER = "alice";
    process.env.HB_TEST_PASS = "s3cret";
    try {
      const r = await probeHttpHealth({
        type: "http",
        baseUrl: authUrl,
        auth: { type: "basic", usernameEnv: "HB_TEST_USER", passwordEnv: "HB_TEST_PASS" },
      });
      expect(r.ok).toBe(true);
      expect(sawAuth).toBe(`Basic ${Buffer.from("alice:s3cret").toString("base64")}`);
    } finally {
      delete process.env.HB_TEST_USER;
      delete process.env.HB_TEST_PASS;
      await new Promise<void>((resolve) => authServer.close(() => resolve()));
    }
  });
});
