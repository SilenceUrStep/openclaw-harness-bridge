import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Adapter } from "./adapters.js";
import { Ledger } from "./ledger.js";
import {
  extractUsage,
  mapEnvelope,
  mapPart,
  parseSseBlock,
  runHttpTask,
  truncateText,
  type HttpRunOptions,
} from "./runner-http.js";
import type { HttpTransport } from "./transport.js";

const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  delete process.env.HB_TEST_USER;
  delete process.env.HB_TEST_PASS;
});

const adapter = {
  id: "opencode",
  displayName: "OpenCode",
  binary: "opencode",
  schemaVersion: 2,
  delegate: { run: ["opencode"], timeoutMs: 600000 },
  session: { idPattern: "ses_[a-zA-Z0-9]+" },
} as unknown as Adapter;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface CapturedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body?: string;
}

class MockOpencode {
  server: Server | null = null;
  baseUrl = "";
  readonly requests: CapturedRequest[] = [];
  readonly sseClients = new Set<ServerResponse>();
  readonly sockets = new Set<import("node:net").Socket>();
  sessionCount = 0;
  messageParts: Array<Record<string, unknown>> = [];
  sessionInfo: Record<string, unknown> = {};
  onPrompt?: (sessionId: string) => Promise<void> | void;
  auth?: string;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.route(req, res);
    });
    this.server.on("connection", (s) => {
      this.sockets.add(s);
      s.on("close", () => this.sockets.delete(s));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    for (const c of [...this.sseClients]) c.destroy();
    this.sseClients.clear();
    for (const s of [...this.sockets]) s.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      let s = "";
      req.on("data", (c) => (s += c));
      req.on("end", () => resolve(s));
    });
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.baseUrl);
    const body = ["POST", "PUT"].includes(req.method ?? "") ? await this.readBody(req) : undefined;
    this.requests.push({ method: req.method ?? "", url: url.pathname, headers: req.headers, body });
    if (this.auth && req.headers.authorization !== this.auth) {
      res.writeHead(401);
      res.end("unauthorized");
      return;
    }
    if (req.method === "POST" && url.pathname === "/session") {
      this.sessionCount += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: `ses_mock${this.sessionCount}`, title: JSON.parse(body ?? "{}").title }));
      return;
    }
    const promptAsync = url.pathname.match(/^\/session\/([^/]+)\/prompt_async$/);
    if (req.method === "POST" && promptAsync) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ messageId: "msg_1" }));
      await this.waitForSseClient();
      await this.onPrompt?.(promptAsync[1]);
      return;
    }
    if (url.pathname === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      this.sseClients.add(res);
      req.on("close", () => this.sseClients.delete(res));
      return;
    }
    const fork = url.pathname.match(/^\/session\/([^/]+)\/fork$/);
    if (req.method === "POST" && fork) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "ses_fork1" }));
      return;
    }
    const sessionGet = url.pathname.match(/^\/session\/([^/]+)$/);
    if (req.method === "GET" && sessionGet) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: sessionGet[1], ...this.sessionInfo }));
      return;
    }
    const messageGet = url.pathname.match(/^\/session\/([^/]+)\/message$/);
    if (req.method === "GET" && messageGet) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify([{ info: { id: "msg_1", sessionID: messageGet[1] }, parts: this.messageParts }]),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  }

  private async waitForSseClient(timeoutMs = 2000): Promise<boolean> {
    const start = Date.now();
    while (this.sseClients.size === 0) {
      if (Date.now() - start > timeoutMs) return false;
      await delay(10);
    }
    return true;
  }

  emit(env: Record<string, unknown>, sessionId: string, id?: string): void {
    for (const c of [...this.sseClients]) {
      c.write(`${id ? `id: ${id}\n` : ""}data: ${JSON.stringify({ ...env, sessionID: env.sessionID ?? sessionId })}\n\n`);
    }
  }

  async emitParts(parts: Array<Record<string, unknown>>, sessionId: string): Promise<void> {
    for (const p of parts) {
      this.emit(
        {
          type: "message.part.updated",
          properties: { part: { ...p, sessionID: sessionId, messageID: "msg_1" } },
        },
        sessionId,
      );
      await delay(10);
    }
  }

  destroyClients(): void {
    for (const c of [...this.sseClients]) c.destroy();
    this.sseClients.clear();
  }
}

function part(id: string, p: Record<string, unknown>): Record<string, unknown> {
  return { id, ...p };
}

function makeOpts(mock: MockOpencode, over?: Partial<HttpRunOptions>): HttpRunOptions {
  const transport: HttpTransport = {
    type: "http",
    baseUrl: mock.baseUrl,
    directoryHeader: "x-opencode-directory",
    auth: { type: "basic", usernameEnv: "HB_TEST_USER", passwordEnv: "HB_TEST_PASS" },
  };
  const tasksDir = mkdtempSync(path.join(tmpdir(), "hb-http-"));
  dirs.push(tasksDir);
  mkdirSync(tasksDir, { recursive: true });
  return {
    adapter,
    transport,
    prompt: "写一个斐波那契函数",
    wait: true,
    timeoutMs: 5000,
    ledger: new Ledger(path.join(tasksDir, "ledger.db")),
    tasksDir,
    ...over,
  };
}

function defaultScript(mock: MockOpencode): void {
  mock.onPrompt = async (sid) => {
    mock.emit({ type: "session.status", properties: { status: { type: "busy" } } }, sid);
    await mock.emitParts(
      [
        part("p1", { type: "step-start" }),
        part("p2", {
          type: "tool",
          tool: "read_file",
          state: { status: "completed", input: { path: "a.ts" }, output: "contents" },
        }),
        part("p3", { type: "text", text: "done" }),
      ],
      sid,
    );
    mock.emit({ type: "session.status", properties: { status: { type: "idle" } } }, sid);
  };
}

describe("runner-http: SSE 解析与事件映射（纯函数）", () => {
  it("parseSseBlock：data 聚合/注释忽略/[DONE]/id 行", () => {
    expect(parseSseBlock('data: {"a":1}')).toEqual({ data: '{"a":1}' });
    expect(parseSseBlock(": keepalive")).toBeNull();
    expect(parseSseBlock("event: x\ndata: 1\ndata: 2")).toEqual({ data: "1\n2" });
    expect(parseSseBlock("id: evt-9\ndata: {}")).toEqual({ data: "{}", id: "evt-9" });
    expect(parseSseBlock("data: [DONE]")).toBeNull();
    expect(parseSseBlock("")).toBeNull();
  });

  it("mapPart/mapEnvelope 覆盖 opencode 信封与 RFC 直名事件", () => {
    expect(mapPart({ type: "step-start" })?.kind).toBe("step_start");
    expect(mapPart({ type: "step-finish" })?.kind).toBe("step_finish");
    const tool = mapPart({ type: "tool", tool: "bash", state: { status: "error", error: { message: "boom" } } });
    expect(tool).toMatchObject({ kind: "tool_use", tool: "bash", toolState: "error", error: "boom" });
    expect(mapPart({ type: "text", text: "hi" })).toMatchObject({ kind: "text", text: "hi" });
    expect(
      mapEnvelope({ type: "message.part.updated", properties: { part: { type: "text", text: "x" } } })?.kind,
    ).toBe("text");
    const retry = mapEnvelope({
      type: "session.status",
      properties: { status: { type: "retry", attempt: 2, reason: "rate_limited", next: { time: "2026-10-16T00:00:00Z" } } },
    });
    expect(retry).toMatchObject({ kind: "retry", attempt: 2, reason: "rate_limited", nextAttemptAt: "2026-10-16T00:00:00Z" });
    expect(mapEnvelope({ type: "session.idle" })?.status).toBe("idle");
    expect(mapEnvelope({ type: "session.error", properties: { error: { message: "e1" } } })).toMatchObject({
      kind: "error",
      error: "e1",
    });
    expect(
      mapEnvelope({ type: "permission.asked", properties: { id: "pm1", title: "bash" } }),
    ).toMatchObject({ kind: "permission", permissionId: "pm1", permissionTitle: "bash" });
    expect(mapEnvelope({ type: "error", message: "legacy" })).toMatchObject({ kind: "error", error: "legacy" });
    expect(mapEnvelope({ type: "message.updated", properties: {} })).toBeNull();
  });

  it("extractUsage 兼容扁平/嵌套 cache 字段", () => {
    const u = extractUsage({ cost: 0.5, tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } } });
    expect(u).toEqual({ cost: 0.5, tokensInput: 1, tokensOutput: 2, tokensReasoning: 3, tokensCacheRead: 4, tokensCacheWrite: 5 });
    const u2 = extractUsage({ tokens: { input: 1, cache_read: 7 } });
    expect(u2.tokensInput).toBe(1);
    expect(u2.tokensCacheRead).toBeNull();
  });

  it("truncateText 保留尾部", () => {
    expect(truncateText("abcdef", 3)).toBe("…def");
    expect(truncateText("ab", 3)).toBe("ab");
  });
});

describe("runner-http: 任务执行（mock opencode server）", () => {
  it("happy path：session→prompt_async→SSE→idle 结算（cost/tokens/事件流/台账）", async () => {
    const mock = new MockOpencode();
    defaultScript(mock);
    mock.messageParts = [
      part("p1", { type: "step-start" }),
      part("p2", {
        type: "tool",
        tool: "read_file",
        state: { status: "completed", input: { path: "a.ts" }, output: "contents" },
      }),
      part("p3", { type: "text", text: "done" }),
    ];
    mock.sessionInfo = { cost: 0.05, tokens: { input: 100, output: 200, reasoning: 30, cache: { read: 4, write: 5 } } };
    await mock.start();
    try {
      const opts = makeOpts(mock, { cwd: "/tmp/proj-a" });
      const rec = await runHttpTask(opts);
      expect(rec.status).toBe("success");
      expect(rec.sessionId).toBe("ses_mock1");
      expect(rec.exitCode ?? null).toBeNull();
      expect(rec.outputTail).toBe("done");
      expect(rec.cost).toBe(0.05);
      expect(rec.tokensInput).toBe(100);
      expect(rec.tokensOutput).toBe(200);
      expect(rec.tokensReasoning).toBe(30);
      expect(rec.tokensCacheRead).toBe(4);
      expect(rec.tokensCacheWrite).toBe(5);
      expect(rec.failReason).toBeUndefined();
      expect(rec.durationMs).toBeGreaterThanOrEqual(0);
      expect(rec.title).toMatch(/^hb_/);
      const create = mock.requests.find((r) => r.method === "POST" && r.url === "/session");
      expect(JSON.parse(create!.body!).title).toBe(rec.title);
      expect(create!.headers["x-opencode-directory"]).toBe("/tmp/proj-a");
      const promptReq = mock.requests.find((r) => r.url!.endsWith("/prompt_async"));
      expect(JSON.parse(promptReq!.body!).parts[0].text).toBe("写一个斐波那契函数");
      const events = opts.ledger.getEvents(rec.id);
      expect(events.map((e) => e.type)).toEqual(["status", "step", "tool_use", "text", "status"]);
      expect(events[2].payload).toMatchObject({ tool: "read_file", state: "completed", output: "contents" });
      expect(events[3].payload).toMatchObject({ text: "done" });
      const final = opts.ledger.getById(rec.id);
      expect(final?.status).toBe("success");
      expect(final?.tokensInput).toBe(100);
      // v0.3.1 成本核算列
      expect(final?.costTotal).toBe(0.05);
      expect(final?.costInputTokens).toBe(100);
      expect(final?.costOutputTokens).toBe(200);
      expect(final?.costReasoningTokens).toBe(30);
      expect(final?.costCacheReadTokens).toBe(4);
      expect(rec.costTotal).toBe(0.05);
      expect(rec.costCacheReadTokens).toBe(4);
    } finally {
      await mock.stop();
    }
  });

  it("fork-before-retry：POST /session/:src/fork → 新会话续跑，forkedFrom 入台账", async () => {
    const mock = new MockOpencode();
    defaultScript(mock);
    await mock.start();
    try {
      const opts = makeOpts(mock);
      const rec = await runHttpTask({ ...opts, forkFromSessionId: "ses_src9" });
      expect(rec.status).toBe("success");
      expect(rec.sessionId).toBe("ses_fork1");
      expect(rec.forkedFrom).toBe("ses_src9");
      const forkReq = mock.requests.find((r) => r.method === "POST" && r.url === "/session/ses_src9/fork");
      expect(forkReq).toBeDefined();
      expect(mock.requests.some((r) => r.url === "/session/ses_fork1/prompt_async")).toBe(true);
      expect(opts.ledger.getById(rec.id)?.forkedFrom).toBe("ses_src9");
    } finally {
      await mock.stop();
    }
  });

  it("SSE 重连带 Last-Event-ID 头（断点续传）", async () => {
    const mock = new MockOpencode();
    mock.onPrompt = async (sid) => {
      mock.emit({ type: "message.part.updated", properties: { part: { id: "p1", type: "text", text: "a" } } }, sid, "evt-1");
      await delay(20);
      mock.emit({ type: "message.part.updated", properties: { part: { id: "p2", type: "text", text: "b" } } }, sid, "evt-2");
      await delay(20);
      mock.destroyClients();
    };
    let eventConnections = 0;
    const origRoute = mock["route"].bind(mock) as (req: IncomingMessage, res: ServerResponse) => Promise<void>;
    (mock as unknown as { route: (req: IncomingMessage, res: ServerResponse) => Promise<void> }).route =
      async (req, res) => {
        const url = new URL(req.url ?? "/", mock.baseUrl);
        if (url.pathname === "/event") {
          eventConnections += 1;
          if (eventConnections >= 2) {
            expect(req.headers["last-event-id"]).toBe("evt-2");
          }
          if (eventConnections === 1) {
            await origRoute(req, res);
            return;
          }
          res.writeHead(200, { "content-type": "text/event-stream" });
          mock.sseClients.add(res);
          req.on("close", () => mock.sseClients.delete(res));
          await delay(300);
          mock.emit({ type: "session.status", properties: { status: { type: "idle" } } }, "ses_mock1");
          return;
        }
        await origRoute(req, res);
      };
    await mock.start();
    try {
      const rec = await runHttpTask(makeOpts(mock));
      expect(rec.status).toBe("success");
      expect(eventConnections).toBeGreaterThanOrEqual(2);
    } finally {
      await mock.stop();
    }
  }, 15000);

  it("error 事件 → failed + fail_reason（不再依赖退出码）", async () => {
    const mock = new MockOpencode();
    mock.onPrompt = async (sid) => {
      await mock.emitParts([part("p1", { type: "step-start" })], sid);
      mock.emit({ type: "session.error", properties: { error: { message: "provider crashed" } } }, sid);
      mock.emit({ type: "session.status", properties: { status: { type: "idle" } } }, sid);
    };
    await mock.start();
    try {
      const opts = makeOpts(mock);
      const rec = await runHttpTask(opts);
      expect(rec.status).toBe("failed");
      expect(rec.failReason).toBe("provider crashed");
      expect(opts.ledger.getEvents(rec.id).some((e) => e.type === "error")).toBe(true);
    } finally {
      await mock.stop();
    }
  });

  it("session.status=retry 记为 retry 事件且任务继续到成功", async () => {
    const mock = new MockOpencode();
    mock.onPrompt = async (sid) => {
      mock.emit(
        { type: "session.status", properties: { status: { type: "retry", attempt: 1, reason: "rate_limited" } } },
        sid,
      );
      await delay(20);
      await mock.emitParts([part("p1", { type: "text", text: "ok-after-retry" })], sid);
      mock.emit({ type: "session.status", properties: { status: { type: "idle" } } }, sid);
    };
    await mock.start();
    try {
      const opts = makeOpts(mock);
      const rec = await runHttpTask(opts);
      expect(rec.status).toBe("success");
      const retry = opts.ledger.getEvents(rec.id).find((e) => e.type === "retry");
      expect(retry).toBeDefined();
      expect((retry!.payload as { reason: string }).reason).toBe("rate_limited");
    } finally {
      await mock.stop();
    }
  });

  it("tool output 超长 → 2KB 截断", async () => {
    const mock = new MockOpencode();
    mock.onPrompt = async (sid) => {
      await mock.emitParts(
        [part("p1", { type: "tool", tool: "read_file", state: { status: "completed", output: "z".repeat(5000) } })],
        sid,
      );
      mock.emit({ type: "session.status", properties: { status: { type: "idle" } } }, sid);
    };
    await mock.start();
    try {
      const opts = makeOpts(mock);
      const rec = await runHttpTask(opts);
      expect(rec.status).toBe("success");
      const ev = opts.ledger.getEvents(rec.id).find((e) => e.type === "tool_use");
      const payload = JSON.stringify(ev!.payload);
      expect(payload.length).toBeLessThanOrEqual(2048 + 20);
      expect(payload).toContain("[truncated");
    } finally {
      await mock.stop();
    }
  });

  it("任务级超时 → 取消并记 failed（fail_reason=timeout）", async () => {
    const mock = new MockOpencode();
    mock.onPrompt = async (sid) => {
      mock.emit({ type: "session.status", properties: { status: { type: "busy" } } }, sid);
    };
    await mock.start();
    try {
      const rec = await runHttpTask(makeOpts(mock, { timeoutMs: 400 }));
      expect(rec.status).toBe("failed");
      expect(rec.failReason).toBe("timeout after 400ms");
    } finally {
      await mock.stop();
    }
  }, 10000);

  it("Basic Auth 从 env 读取；401 → 任务 failed 且 fail_reason 归因", async () => {
    const mock = new MockOpencode();
    mock.auth = `Basic ${Buffer.from("u:p").toString("base64")}`;
    defaultScript(mock);
    await mock.start();
    try {
      const noAuth = await runHttpTask(makeOpts(mock));
      expect(noAuth.status).toBe("failed");
      expect(noAuth.failReason).toContain("HTTP 401");
      process.env.HB_TEST_USER = "u";
      process.env.HB_TEST_PASS = "p";
      const ok = await runHttpTask(makeOpts(mock));
      expect(ok.status).toBe("success");
      expect(ok.sessionId).toBe("ses_mock1");
    } finally {
      await mock.stop();
    }
  });

  it("permission.asked 未响应 → permission 事件 + failed 归因；显式 deny 亦归因", async () => {
    const mock = new MockOpencode();
    mock.onPrompt = async (sid) => {
      mock.emit({ type: "permission.asked", properties: { id: "pm1", title: "bash rm -rf" } }, sid);
      await delay(15);
      mock.emit({ type: "session.status", properties: { status: { type: "idle" } } }, sid);
    };
    await mock.start();
    try {
      const opts = makeOpts(mock);
      const rec = await runHttpTask(opts);
      expect(rec.status).toBe("failed");
      expect(rec.failReason).toContain("permission.asked");
      expect(opts.ledger.getEvents(rec.id).some((e) => e.type === "permission")).toBe(true);
    } finally {
      await mock.stop();
    }

    const mock2 = new MockOpencode();
    mock2.onPrompt = async (sid) => {
      mock2.emit({ type: "permission.updated", properties: { id: "pm2", title: "bash", response: "deny" } }, sid);
      await delay(15);
      mock2.emit({ type: "session.status", properties: { status: { type: "idle" } } }, sid);
    };
    await mock2.start();
    try {
      const opts2 = makeOpts(mock2);
      const rec2 = await runHttpTask(opts2);
      expect(rec2.status).toBe("failed");
      expect(rec2.failReason).toContain("permission denied: bash");
    } finally {
      await mock2.stop();
    }
  });

  it("SSE 断线 → 退避重连 + /message 补拉，台账无缺口无重复", async () => {
    const mock = new MockOpencode();
    mock.messageParts = [
      part("p1", { type: "step-start" }),
      part("p2", { type: "tool", tool: "read_file", state: { status: "completed", output: "x" } }),
      part("p3", { type: "text", text: "recovered" }),
    ];
    let eventConnections = 0;
    const origRoute = mock["route"].bind(mock) as (req: IncomingMessage, res: ServerResponse) => Promise<void>;
    (mock as unknown as { route: (req: IncomingMessage, res: ServerResponse) => Promise<void> }).route =
      async (req, res) => {
        const url = new URL(req.url ?? "/", mock.baseUrl);
        if (url.pathname === "/event") {
          eventConnections += 1;
          if (eventConnections === 1) {
            await origRoute(req, res);
            await delay(30);
            mock.destroyClients();
            return;
          }
          res.writeHead(200, { "content-type": "text/event-stream" });
          mock.sseClients.add(res);
          req.on("close", () => mock.sseClients.delete(res));
          await delay(600);
          mock.emit(
            {
              type: "message.part.updated",
              properties: { part: { ...mock.messageParts[2], sessionID: "ses_mock1", messageID: "msg_1" } },
            },
            "ses_mock1",
          );
          await delay(10);
          mock.emit({ type: "session.status", properties: { status: { type: "idle" } } }, "ses_mock1");
          return;
        }
        await origRoute(req, res);
      };
    mock.onPrompt = async (sid) => {
      await mock.emitParts([mock.messageParts[0], mock.messageParts[1]], sid);
    };
    await mock.start();
    try {
      const opts = makeOpts(mock);
      const rec = await runHttpTask(opts);
      expect(rec.status).toBe("success");
      expect(rec.outputTail).toBe("recovered");
      const counts = opts.ledger.getEvents(rec.id).reduce<Record<string, number>>((acc, e) => {
        acc[e.type] = (acc[e.type] ?? 0) + 1;
        return acc;
      }, {});
      expect(counts["step"]).toBe(1);
      expect(counts["tool_use"]).toBe(1);
      expect(counts["text"]).toBe(1);
      expect(eventConnections).toBeGreaterThanOrEqual(2);
    } finally {
      await mock.stop();
    }
  }, 15000);

  it("wait=false 后台执行：立即返回 running 快照，终态异步落台账", async () => {
    const mock = new MockOpencode();
    defaultScript(mock);
    await mock.start();
    try {
      const opts = makeOpts(mock, { wait: false });
      const snap = await runHttpTask(opts);
      expect(snap.status).toBe("running");
      expect(snap.pid).toBe(process.pid);
      expect(snap.logFile).toBeTruthy();
      const deadline = Date.now() + 5000;
      let final = opts.ledger.getById(snap.id);
      while ((!final || final.status === "running") && Date.now() < deadline) {
        await delay(50);
        final = opts.ledger.getById(snap.id);
      }
      expect(final?.status).toBe("success");
      expect(final?.sessionId).toBe("ses_mock1");
    } finally {
      await mock.stop();
    }
  }, 10000);
});
