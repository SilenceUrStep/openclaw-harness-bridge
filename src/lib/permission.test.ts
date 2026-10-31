import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HttpTransport } from "./transport.js";
import {
  DEFAULT_PERMISSION_ASK_TIMEOUT_MS,
  describePermission,
  fetchPendingPermissions,
  listPendingPermissions,
  replyPermission,
  resolvePermissionAskConfig,
  type PendingPermissionRequest,
} from "./permission.js";

// ── sendPermissionAlert（runner.ts）：child_process mock（vitest hoist，同 notify-throttle.test.ts 模式）──
const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
  spawn: (...args: unknown[]) => spawnMock(...args),
}));
const { sendPermissionAlert, resetPermissionAlerts } = await import("./runner.js");

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

function transport(baseUrl: string): HttpTransport {
  return {
    type: "http",
    baseUrl,
    directoryHeader: "x-opencode-directory",
    auth: { type: "basic", usernameEnv: "HB_TEST_USER", passwordEnv: "HB_TEST_PASS" },
  };
}

interface MockCtx {
  server: Server;
  baseUrl: string;
  requests: Array<{ method: string; url: string; headers: IncomingHttpHeaders; body?: string }>;
  handler: (req: IncomingMessage, res: ServerResponse, body?: string) => void;
}

async function startMock(handler: MockCtx["handler"]): Promise<MockCtx> {
  const ctx: MockCtx = {
    server: createServer(),
    baseUrl: "",
    requests: [],
    handler,
  };
  ctx.server.on("request", (req, res) => {
    const chunks: string[] = [];
    req.on("data", (c) => chunks.push(String(c)));
    req.on("end", () => {
      const body = chunks.length > 0 ? chunks.join("") : undefined;
      ctx.requests.push({ method: req.method ?? "", url: req.url ?? "/", headers: req.headers, body });
      ctx.handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => ctx.server.listen(0, "127.0.0.1", resolve));
  ctx.baseUrl = `http://127.0.0.1:${(ctx.server.address() as AddressInfo).port}`;
  return ctx;
}

function stopMock(ctx: MockCtx): Promise<void> {
  return new Promise((resolve) => ctx.server.close(() => resolve()));
}

beforeAll(() => {
  process.env.HB_TEST_USER = "u1";
  process.env.HB_TEST_PASS = "p1";
});

afterAll(() => {
  delete process.env.HB_TEST_USER;
  delete process.env.HB_TEST_PASS;
});

const PENDING_RAW = [
  {
    id: "per_1",
    sessionID: "ses_a",
    permission: "bash",
    patterns: ["rm -rf *"],
    metadata: { tool: "bash", input: { command: "rm -rf /tmp/x" } },
    always: [],
  },
  { id: "per_2", sessionID: "ses_b", permission: "edit", patterns: [], metadata: { filepath: "a.ts" } },
  { id: "per_3", permission: "broken" }, // 缺 sessionID → 丢弃
];

describe("permission: fetchPendingPermissions（mock HTTP）", () => {
  it("拉取并规范化挂起权限，按 sessionId 过滤，携带 basic auth + directory header", async () => {
    const ctx = await startMock((req, res) => {
      if (req.method === "GET" && req.url === "/permission") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(PENDING_RAW));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    try {
      const all = await fetchPendingPermissions(transport(ctx.baseUrl), { cwd: "/tmp/proj-a" });
      expect(all.map((p) => p.requestId)).toEqual(["per_1", "per_2"]); // 脏数据（缺 sessionID）被丢弃
      expect(all[0]).toEqual({
        requestId: "per_1",
        sessionId: "ses_a",
        permission: "bash",
        patterns: ["rm -rf *"],
        metadata: { tool: "bash", input: { command: "rm -rf /tmp/x" } },
        always: [],
      });
      const onlyA = await fetchPendingPermissions(transport(ctx.baseUrl), { sessionId: "ses_b", cwd: "/tmp/proj-a" });
      expect(onlyA.map((p) => p.requestId)).toEqual(["per_2"]);
      const req = ctx.requests[0];
      expect(req.headers.authorization).toBe(`Basic ${Buffer.from("u1:p1").toString("base64")}`);
      expect(req.headers["x-opencode-directory"]).toBe("/tmp/proj-a");
    } finally {
      await stopMock(ctx);
    }
  });

  it("非 2xx 抛 PermissionHttpError（携带状态码）", async () => {
    const ctx = await startMock((req, res) => {
      res.writeHead(500);
      res.end("boom");
    });
    try {
      await expect(fetchPendingPermissions(transport(ctx.baseUrl))).rejects.toMatchObject({ status: 500 });
    } finally {
      await stopMock(ctx);
    }
  });
});

describe("permission: listPendingPermissions fail-open", () => {
  it("HTTP 500 → 返回空数组（不影响任务执行）", async () => {
    const ctx = await startMock((req, res) => {
      res.writeHead(500);
      res.end();
    });
    try {
      expect(await listPendingPermissions(transport(ctx.baseUrl), "ses_a")).toEqual([]);
    } finally {
      await stopMock(ctx);
    }
  });

  it("连接拒绝（服务不在）→ 返回空数组", async () => {
    const dead = transport("http://127.0.0.1:1"); // port 1 无服务
    expect(await listPendingPermissions(dead, "ses_a")).toEqual([]);
  });
});

describe("permission: replyPermission（mock HTTP）", () => {
  it("POST /permission/{requestID}/reply 带 reply body 与鉴权头", async () => {
    const ctx = await startMock((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("true");
    });
    try {
      await replyPermission(transport(ctx.baseUrl), "per_9", "once", { cwd: "/tmp/ws", message: "ok go" });
      const req = ctx.requests[0];
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/permission/per_9/reply");
      expect(JSON.parse(req.body ?? "{}")).toEqual({ reply: "once", message: "ok go" });
      expect(req.headers.authorization).toBe(`Basic ${Buffer.from("u1:p1").toString("base64")}`);
      expect(req.headers["x-opencode-directory"]).toBe("/tmp/ws");
      expect(req.headers["content-type"]).toBe("application/json");
    } finally {
      await stopMock(ctx);
    }
  });

  it("404 → 错误信息含「权限请求不存在或已处理」提示", async () => {
    const ctx = await startMock((req, res) => {
      res.writeHead(404);
      res.end();
    });
    try {
      await expect(replyPermission(transport(ctx.baseUrl), "per_x", "reject")).rejects.toThrow(
        /权限请求不存在或已处理/,
      );
    } finally {
      await stopMock(ctx);
    }
  });
});

describe("permission: 配置与详情摘要", () => {
  it("resolvePermissionAskConfig：enabled 默认 true，timeoutMs 默认 30 分钟，非法值回落默认", () => {
    expect(resolvePermissionAskConfig(undefined)).toEqual({
      enabled: true,
      timeoutMs: DEFAULT_PERMISSION_ASK_TIMEOUT_MS,
    });
    expect(resolvePermissionAskConfig({ enabled: false, timeoutMs: 5000 })).toEqual({
      enabled: false,
      timeoutMs: 5000,
    });
    expect(resolvePermissionAskConfig({ timeoutMs: 0 }).timeoutMs).toBe(DEFAULT_PERMISSION_ASK_TIMEOUT_MS);
    expect(resolvePermissionAskConfig({ timeoutMs: -1 }).timeoutMs).toBe(DEFAULT_PERMISSION_ASK_TIMEOUT_MS);
  });

  it("describePermission：权限名 + patterns + metadata 摘要，metadata 截断", () => {
    const p: PendingPermissionRequest = {
      requestId: "per_1",
      sessionId: "ses_a",
      permission: "bash",
      patterns: ["rm -rf *"],
      metadata: { tool: "bash", input: { command: "rm -rf /" } },
    };
    const text = describePermission(p);
    expect(text).toContain("权限=bash");
    expect(text).toContain("patterns=[rm -rf *]");
    expect(text).toContain("rm -rf /");
    const long: PendingPermissionRequest = { ...p, metadata: { blob: "x".repeat(900) } };
    const truncated = describePermission(long, 100);
    expect(truncated.length).toBeLessThan(200);
    expect(truncated).toContain("…");
  });
});

describe("runner.sendPermissionAlert（v0.4.12 去重 + 60s 节流）", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockReturnValue({ unref: () => {} });
    resetPermissionAlerts();
  });

  it("推 permission_ask：env 带 HB_ALERT/HB_TASK_ID/HB_SESSION_ID/HB_REQUEST_ID/HB_PERMISSION_DETAIL/HB_TIME", () => {
    sendPermissionAlert("echo ok", "permission_ask", {
      taskId: "hb_t1",
      sessionId: "ses_a",
      requestId: "per_1",
      detail: "权限=bash patterns=[rm -rf *]",
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0] as [string, string[], { env: Record<string, string> }];
    expect(cmd).toBe("bash");
    expect(args).toEqual(["-c", "echo ok"]);
    expect(opts.env.HB_ALERT).toBe("permission_ask");
    expect(opts.env.HB_TASK_ID).toBe("hb_t1");
    expect(opts.env.HB_SESSION_ID).toBe("ses_a");
    expect(opts.env.HB_REQUEST_ID).toBe("per_1");
    expect(opts.env.HB_PERMISSION_DETAIL).toContain("权限=bash");
    expect(typeof opts.env.HB_TIME).toBe("string");
  });

  it("详情超 800 字截断加省略号", () => {
    sendPermissionAlert("echo ok", "permission_ask", {
      taskId: "hb_t1",
      requestId: "per_1",
      detail: "x".repeat(900),
    });
    const opts = spawnMock.mock.calls[0][2] as { env: Record<string, string> };
    expect(opts.env.HB_PERMISSION_DETAIL.length).toBe(801); // 800 + …
    expect(opts.env.HB_PERMISSION_DETAIL.endsWith("…")).toBe(true);
  });

  it("同一 requestID 的 permission_ask 只推一次（内存 Set 去重）", () => {
    const info = { taskId: "hb_t1", requestId: "per_1", detail: "d" };
    sendPermissionAlert("echo ok", "permission_ask", info);
    sendPermissionAlert("echo ok", "permission_ask", info);
    sendPermissionAlert("echo ok", "permission_ask", info);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("不同告警类型不去重：permission_ask 后（出节流窗）permission_timeout 仍推送", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-31T08:00:00Z"));
      const info = { taskId: "hb_t1", requestId: "per_1", detail: "d" };
      sendPermissionAlert("echo ok", "permission_ask", info);
      vi.setSystemTime(new Date("2026-10-31T08:31:00Z")); // +31min（典型挂起超时时刻，早已出 60s 窗）
      sendPermissionAlert("echo ok", "permission_timeout", info);
      const types = spawnMock.mock.calls.map((c) => (c[2] as { env: Record<string, string> }).env.HB_ALERT);
      expect(types).toEqual(["permission_ask", "permission_timeout"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("60s 节流窗口：窗口内其它 request 被抑制（不标记可补推），窗口过后推送", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-31T08:00:00Z"));
      const mk = (id: string) => ({ taskId: "hb_t1", requestId: id, detail: "d" });
      sendPermissionAlert("echo ok", "permission_ask", mk("per_1")); // 窗口起点
      sendPermissionAlert("echo ok", "permission_ask", mk("per_2")); // 窗口内 → 抑制
      expect(spawnMock).toHaveBeenCalledTimes(1);
      vi.setSystemTime(new Date("2026-10-31T08:01:01Z")); // +61s
      sendPermissionAlert("echo ok", "permission_ask", mk("per_2")); // 窗口外 → 补推
      expect(spawnMock).toHaveBeenCalledTimes(2);
      sendPermissionAlert("echo ok", "permission_ask", mk("per_2")); // 已推过 → 去重
      expect(spawnMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("permission_timeout 豁免 60s 节流窗口（安全关键通知，仅 dedup 去重）", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-31T08:00:00Z"));
      const info = { taskId: "hb_t1", requestId: "per_1", detail: "d" };
      sendPermissionAlert("echo ok", "permission_ask", info); // 占住 60s 窗口
      sendPermissionAlert("echo ok", "permission_ask", { ...info, requestId: "per_2" }); // 窗口内 → 抑制
      sendPermissionAlert("echo ok", "permission_timeout", info); // 窗口内但豁免 → 推送
      expect(spawnMock).toHaveBeenCalledTimes(2);
      const types = spawnMock.mock.calls.map((c) => (c[2] as { env: Record<string, string> }).env.HB_ALERT);
      expect(types).toEqual(["permission_ask", "permission_timeout"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("未配置 notifyCommand 不推送", () => {
    sendPermissionAlert(undefined, "permission_ask", { taskId: "hb_t1", requestId: "per_1", detail: "d" });
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
