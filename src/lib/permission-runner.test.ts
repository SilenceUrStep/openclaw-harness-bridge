import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Adapter } from "./adapters.js";
import { Ledger } from "./ledger.js";
import { resetPermissionAlerts } from "./runner.js";
import { runHttpTask, type HttpRunOptions } from "./runner-http.js";
import type { HttpTransport } from "./transport.js";

/**
 * v0.4.12 权限 ask 人工批准通道：runner-http 集成测试（真实 child_process + mock OpenCode server）。
 * 覆盖：permission.asked → GET /permission 探测 + permission_ask 告警；
 *       挂起超时 → 自动 POST reject + permission_timeout 告警；
 *       探测 fail-open（/permission 不可用不影响任务执行）。
 */

const dirs: string[] = [];

beforeEach(() => {
  // 告警去重/节流是 runner.ts 模块级状态，同进程串行测试间必须重置
  resetPermissionAlerts();
});

afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const adapter = {
  id: "opencode",
  displayName: "OpenCode",
  binary: "opencode",
  schemaVersion: 2,
  delegate: { run: ["opencode"], timeoutMs: 600000 },
  session: { idPattern: "ses_[a-zA-Z0-9]+" },
} as unknown as Adapter;

interface CapturedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body?: string;
}

/** 带 /permission 端点的 mock OpenCode（同 runner-http.test.ts MockOpencode 骨架 + 权限路由） */
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
  /** GET /permission 返回体；null → 404 */
  permissionList: unknown[] | null = [];
  /** GET /permission 返回状态码（fail-open 用） */
  permissionStatus = 200;
  readonly replies: Array<{ requestId: string; body: Record<string, unknown> }> = [];

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
    if (req.method === "GET" && url.pathname === "/permission") {
      if (this.permissionList === null) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(this.permissionStatus, { "content-type": "application/json" });
      res.end(JSON.stringify(this.permissionList));
      return;
    }
    const reply = url.pathname.match(/^\/permission\/([^/]+)\/reply$/);
    if (req.method === "POST" && reply) {
      this.replies.push({ requestId: decodeURIComponent(reply[1]), body: JSON.parse(body ?? "{}") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("true");
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

  emit(env: Record<string, unknown>, sessionId: string): void {
    for (const c of [...this.sseClients]) {
      c.write(`data: ${JSON.stringify({ ...env, sessionID: env.sessionID ?? sessionId })}\n\n`);
    }
  }
}

function makeOpts(mock: MockOpencode, over?: Partial<HttpRunOptions>): HttpRunOptions {
  const transport: HttpTransport = {
    type: "http",
    baseUrl: mock.baseUrl,
    directoryHeader: "x-opencode-directory",
  };
  const tasksDir = mkdtempSync(path.join(tmpdir(), "hb-perm-"));
  dirs.push(tasksDir);
  mkdirSync(tasksDir, { recursive: true });
  return {
    adapter,
    transport,
    prompt: "跑一个 rm 命令",
    wait: true,
    timeoutMs: 5000,
    ledger: new Ledger(path.join(tasksDir, "ledger.db")),
    tasksDir,
    ...over,
  };
}

function alertFileOf(over?: string): { dir: string; file: string; cmd: (f: string) => string } {
  const dir = mkdtempSync(path.join(tmpdir(), "hb-perm-alert-"));
  dirs.push(dir);
  const file = over ?? path.join(dir, "alerts.txt");
  return { dir, file, cmd: (f) => `printf '%s|%s|%s\\n' "$HB_ALERT" "$HB_TASK_ID" "$HB_REQUEST_ID" >> "${f}"` };
}

/** 轮询等待告警文件出现指定标记（spawn fire-and-forget 异步送达） */
async function waitForAlert(file: string, marker: string, timeoutMs = 4000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let content = "";
  while (Date.now() < deadline) {
    content = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (content.includes(marker)) break;
    await delay(50);
  }
  return content;
}

const PENDING = [
  {
    id: "per_1",
    sessionID: "ses_mock1",
    permission: "bash",
    patterns: ["rm -rf *"],
    metadata: { tool: "bash", input: { command: "rm -rf /tmp/x" } },
    always: [],
  },
];

describe("runner-http 权限 ask 人工批准通道（v0.4.12）", () => {
  it("permission.asked → GET /permission 探测 + permission_ask 告警（不自动 reply）", async () => {
    const { file, cmd } = alertFileOf();
    const mock = new MockOpencode();
    mock.permissionList = PENDING;
    mock.onPrompt = async (sid) => {
      mock.emit({ type: "session.status", properties: { status: { type: "busy" } } }, sid);
      mock.emit({ type: "permission.asked", properties: { id: "per_1", title: "bash rm -rf" } }, sid);
    };
    await mock.start();
    try {
      const opts = makeOpts(mock, {
        idleTimeoutMs: 100,
        maxDurationMs: 900, // 总时长兜底结束任务（权限一直未批）
        permissionAsk: { enabled: true, timeoutMs: 600_000 }, // 超时窗口远大于用例时长 → 不触发守护
        notifyCommand: cmd(file),
      });
      const rec = await runHttpTask(opts);
      expect(["timeout", "failed"]).toContain(rec.status);
      // 探测请求：GET /permission（fail-open 失败静默）
      const probe = mock.requests.find((r) => r.method === "GET" && r.url === "/permission");
      expect(probe).toBeDefined();
      // 告警：permission_ask + taskId + requestID
      const content = await waitForAlert(file, "permission_ask");
      expect(content).toContain("permission_ask");
      expect(content).toContain(rec.id);
      expect(content).toContain("per_1");
      // 未配置超时 → 不自动 reply
      expect(mock.replies).toEqual([]);
      // 台账事件 permission_alert 落账
      expect(opts.ledger.getEvents(rec.id).some((e) => e.type === "permission_alert")).toBe(true);
    } finally {
      await mock.stop();
    }
  }, 15000);

  it("挂起超 permissionAsk.timeoutMs → 自动 POST reject + permission_timeout 告警", async () => {
    const { file, cmd } = alertFileOf();
    const mock = new MockOpencode();
    mock.permissionList = PENDING;
    mock.onPrompt = async (sid) => {
      mock.emit({ type: "session.status", properties: { status: { type: "busy" } } }, sid);
      mock.emit({ type: "permission.asked", properties: { id: "per_1", title: "bash rm -rf" } }, sid);
    };
    await mock.start();
    try {
      const opts = makeOpts(mock, {
        idleTimeoutMs: 60, // 驱动循环节拍（SSE 静默核查 → 重挂 → 循环顶守护）
        maxDurationMs: 1500,
        permissionAsk: { enabled: true, timeoutMs: 300 },
        notifyCommand: cmd(file),
      });
      const rec = await runHttpTask(opts);
      expect(["timeout", "failed"]).toContain(rec.status);
      // 自动拒绝已提交
      expect(mock.replies).toEqual([{ requestId: "per_1", body: { reply: "reject" } }]);
      const content = await waitForAlert(file, "permission_timeout");
      expect(content).toContain("permission_timeout");
      expect(content).toContain("per_1");
      expect(content).toContain(rec.id);
      const ev = opts.ledger.getEvents(rec.id).find((e) => e.type === "permission_auto_reject");
      expect(ev).toBeDefined();
      expect((ev!.payload as { requestId: string; rejected: boolean })).toMatchObject({
        requestId: "per_1",
        rejected: true,
      });
    } finally {
      await mock.stop();
    }
  }, 15000);

  it("探测 fail-open：GET /permission 500/404 不影响任务执行（happy path 结算 success）", async () => {
    const mock = new MockOpencode();
    mock.permissionList = null; // /permission 404
    mock.permissionStatus = 500;
    mock.onPrompt = async (sid) => {
      mock.emit({ type: "session.status", properties: { status: { type: "busy" } } }, sid);
      mock.emit(
        {
          type: "message.part.updated",
          properties: { part: { id: "p1", type: "text", text: "done", sessionID: sid, messageID: "msg_1" } },
        },
        sid,
      );
      mock.emit({ type: "session.status", properties: { status: { type: "idle" } } }, sid);
    };
    await mock.start();
    try {
      const opts = makeOpts(mock, {
        permissionAsk: { enabled: true, timeoutMs: 300 },
        notifyCommand: "bash -c 'exit 0'",
      });
      const rec = await runHttpTask(opts);
      expect(rec.status).toBe("success"); // 探测/守护失败不影响任务执行
      expect(rec.outputTail).toBe("done");
    } finally {
      await mock.stop();
    }
  }, 15000);

  it("permissionAsk.enabled=false 关闭探测（无 GET /permission 请求）", async () => {
    const mock = new MockOpencode();
    mock.permissionList = PENDING;
    mock.onPrompt = async (sid) => {
      mock.emit({ type: "session.status", properties: { status: { type: "busy" } } }, sid);
      mock.emit({ type: "permission.asked", properties: { id: "per_1", title: "bash" } }, sid);
      mock.emit({ type: "session.status", properties: { status: { type: "idle" } } }, sid);
    };
    await mock.start();
    try {
      const opts = makeOpts(mock, { permissionAsk: { enabled: false } });
      const rec = await runHttpTask(opts);
      expect(mock.requests.some((r) => r.method === "GET" && r.url === "/permission")).toBe(false);
      expect(rec.status).toBe("failed"); // 原生行为：permission.asked 未响应归因
      expect(rec.failReason).toContain("permission.asked");
    } finally {
      await mock.stop();
    }
  }, 15000);
});
