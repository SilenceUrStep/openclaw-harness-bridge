import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { Adapter } from "./adapters.js";
import { Ledger, type TaskRecord } from "./ledger.js";
import { adjudicateDshTimeout, closeAllDshProcesses, runDshTask, type DshRunOptions } from "./runner-dsh.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  delete process.env.MOCK_DSH_VERSION;
  delete process.env.MOCK_DSH_POLLUTE;
});

afterEach(() => {
  closeAllDshProcesses();
});

function writeMockScripts(): { sdkScript: string; headlessScript: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "hb-dsh-"));
  dirs.push(dir);
  const sdkScript = path.join(dir, "mock-dsh-sdk.mjs");
  writeFileSync(
    sdkScript,
    `import { createInterface } from "node:readline";
import fs from "node:fs";
const respond = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
if (process.env.MOCK_DSH_POLLUTE === "1") {
  console.log("!!! polluted banner not json !!!");
}
let inits = 0;
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (method === "initialize") {
    inits += 1;
    if (process.env.DSH_HOME) {
      try { fs.appendFileSync(process.env.DSH_HOME + "/inits.log", \`init provider=\${params.provider} model=\${params.model}\\n\`); } catch {}
    }
    // 模拟 dsh server.ts:171：provider 非法即抛
    if (params.provider !== "deepseek-official") {
      respond({ id, error: { message: \`no adapter registered for provider "\${params.provider}"\` } });
      return;
    }
    // wire-stable 标识：固定 0.0.1，不随 dsh 二进制版本变化
    respond({ id, result: { serverInfo: { name: "deepseek-harness-sdk-runtime", version: "0.0.1" } } });
    return;
  }
  if (method === "session/prompt") {
    respond({ id, result: { messageId: "m1" } });
    setTimeout(() => {
      respond({ method: "session.event", params: { sessionId: params.sessionId, event: { type: "step_start" } } });
      respond({ method: "session.event", params: { sessionId: params.sessionId, event: { type: "tool_use", tool: "bash", state: "completed", output: "ok" } } });
      respond({ method: "session.event", params: { sessionId: params.sessionId, event: { type: "text", text: "dsh done" } } });
      respond({ method: "session.status", params: { sessionId: params.sessionId, status: { type: "idle" } } });
    }, 30);
    return;
  }
  if (method === "session/wait") {
    // 真实 dsh 语义：阻塞到会话结束才返回
    setTimeout(() => respond({ id, result: { status: "ok" } }), 120);
    return;
  }
  if (method === "shutdown") {
    respond({ id, result: {} });
    process.exit(0);
  }
});
`,
  );
  const headlessScript = path.join(dir, "mock-dsh-headless.mjs");
  writeFileSync(
    headlessScript,
    `console.log(JSON.stringify({ type: "step_start" }));
console.log(JSON.stringify({ type: "tool_use", tool: "bash", state: "completed", output: "x" }));
console.log("banner-not-json-skipped");
console.log(JSON.stringify({ type: "text", text: "headless done" }));
process.exit(0);
`,
  );
  return { sdkScript, headlessScript };
}

function dshAdapter(
  sdkScript: string,
  headlessScript: string,
  opts?: { gate?: { min?: string; max?: string }; version?: string; sdk?: { provider?: string; model?: string } },
): Adapter {
  const versionCheck = opts?.version
    ? [process.execPath, "-e", `console.log('dsh ${opts.version}')`]
    : undefined;
  return {
    id: "dsh",
    displayName: "DeepSeek Harness (dsh)",
    binary: "dsh",
    schemaVersion: 2,
    versionGate: opts?.gate,
    sdk: opts?.sdk ?? { provider: "deepseek-official", model: "deepseek-flash" },
    versionCheck,
    delegate: { run: [process.execPath, headlessScript, "{prompt}"], timeoutMs: 30000 },
    session: { idPattern: "dsh_[a-zA-Z0-9]+" },
  } as unknown as Adapter;
}

function makeOpts(adapter: Adapter, transport: { command: string; args?: string[] }, over?: Partial<DshRunOptions>): DshRunOptions {
  const dir = mkdtempSync(path.join(tmpdir(), "hb-dsh-run-"));
  dirs.push(dir);
  const tasksDir = path.join(dir, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  return {
    adapter,
    transport: { type: "stdio-rpc", command: transport.command, args: transport.args },
    prompt: "dsh 任务",
    cwd: dir,
    dshHome: path.join(dir, "dsh-home"),
    wait: true,
    timeoutMs: 8000,
    ledger: new Ledger(path.join(dir, "ledger.db")),
    tasksDir,
    ...over,
  };
}

describe("runner-dsh: stdio JSON-RPC", () => {
  it("happy path：initialize(provider/model) → 事件流 → 结算（多会话复用一进程）", async () => {
    const { sdkScript, headlessScript } = writeMockScripts();
    const adapter = dshAdapter(sdkScript, headlessScript, {
      gate: { min: "0.2.1", max: "0.3.x" },
      version: "0.2.1-alpha.4", // 本机真实 dsh 版本；serverInfo 的 0.0.1 不得参与门禁
    });
    const transport = { command: process.execPath, args: [sdkScript, "--profile", "sdk"] };
    const opts = makeOpts(adapter, transport);
    const rec1 = await runDshTask(opts);
    expect(rec1.status).toBe("success");
    expect(rec1.transport).toBe("stdio-rpc");
    expect(rec1.sessionId).toMatch(/^dsh_[0-9A-Za-z]+_[0-9a-z]+$/);
    expect(rec1.outputTail).toBe("dsh done");
    expect(rec1.failReason).toBeUndefined();
    // initialize 携带 provider/model（来自 adapter.sdk）
    const initsLog = readFileSync(path.join(opts.dshHome as string, "inits.log"), "utf8");
    expect(initsLog).toContain("provider=deepseek-official");
    expect(initsLog).toContain("model=deepseek-flash");
    // serverInfo.version 仅记录台账
    const events = opts.ledger.getEvents(rec1.id);
    expect(events[0].type).toBe("status");
    expect(events[0].payload).toMatchObject({ sdk_server_version: "0.0.1" });
    expect(events.slice(1).map((e) => e.type)).toEqual(["step", "tool_use", "text", "status"]);
    expect(events[2].payload).toMatchObject({ tool: "bash", state: "completed" });
    // DSH_HOME 隔离：initialize 在专用目录留痕
    expect(existsSync(path.join(opts.dshHome as string, "inits.log"))).toBe(true);
    // 多会话复用：第二个任务不再重新 initialize（同一常驻进程）
    const rec2 = await runDshTask(opts);
    expect(rec2.status).toBe("success");
    expect(rec2.sessionId).not.toBe(rec1.sessionId);
    expect(initsLog.split("\n").filter(Boolean).length).toBe(1);
  }, 20000);

  it("版本协商：门禁用 versionCheck 二进制版本（越界显性拒绝，不 headless 兜底）", async () => {
    const { sdkScript, headlessScript } = writeMockScripts();
    const transport = { command: process.execPath, args: [sdkScript] };
    const optsLow = makeOpts(
      dshAdapter(sdkScript, headlessScript, { gate: { min: "0.2.1", max: "0.3.x" }, version: "0.1.0" }),
      transport,
    );
    const recLow = await runDshTask(optsLow);
    expect(recLow.status).toBe("failed");
    expect(recLow.failReason).toContain("版本协商失败");
    expect(recLow.failReason).toContain("低于");
    expect(optsLow.ledger.getEvents(recLow.id)).toEqual([]);

    const optsHigh = makeOpts(
      dshAdapter(sdkScript, headlessScript, { gate: { min: "0.2.1", max: "0.3.x" }, version: "9.9.9" }),
      transport,
    );
    const recHigh = await runDshTask(optsHigh);
    expect(recHigh.status).toBe("failed");
    expect(recHigh.failReason).toContain("超过");

    // 握手 serverInfo 固定 0.0.1，门禁只看 versionCheck → alpha.4 放行
    const optsAlpha = makeOpts(
      dshAdapter(sdkScript, headlessScript, { gate: { min: "0.2.1", max: "0.3.x" }, version: "0.2.1-alpha.4" }),
      transport,
    );
    const recAlpha = await runDshTask(optsAlpha);
    expect(recAlpha.status).toBe("success");
    delete process.env.MOCK_DSH_VERSION;
  }, 30000);

  it("缺 sdk.provider → initialize 被服务端拒绝（provider=undefined 报错可见）", async () => {
    const { sdkScript, headlessScript } = writeMockScripts();
    const adapter = dshAdapter(sdkScript, headlessScript, {
      gate: { min: "0.2.1", max: "0.3.x" },
      version: "0.2.1-alpha.4",
      sdk: { provider: undefined, model: undefined },
    });
    const opts = makeOpts(adapter, { command: process.execPath, args: [sdkScript] });
    const rec = await runDshTask(opts);
    expect(rec.status).toBe("failed");
    expect(rec.failReason).toContain('no adapter registered for provider "undefined"');
  }, 20000);

  it("stdout 纯度：污染帧记 warning 跳过，不崩任务", async () => {
    const { sdkScript, headlessScript } = writeMockScripts();
    process.env.MOCK_DSH_POLLUTE = "1";
    const adapter = dshAdapter(sdkScript, headlessScript);
    const opts = makeOpts(adapter, { command: process.execPath, args: [sdkScript] });
    const rec = await runDshTask(opts);
    expect(rec.status).toBe("success");
    expect(rec.outputTail).toBe("dsh done");
    delete process.env.MOCK_DSH_POLLUTE;
  }, 20000);

  it("headless NDJSON 兜底：SDK 进程 ENOENT 时回落 delegate.run，fallback_used=1", async () => {
    const { sdkScript, headlessScript } = writeMockScripts();
    const adapter = dshAdapter(sdkScript, headlessScript);
    const opts = makeOpts(adapter, { command: "no-such-dsh-binary-xyz" });
    const rec = await runDshTask(opts);
    expect(rec.status).toBe("success");
    expect(rec.fallbackUsed).toBe(true);
    expect(rec.transport).toBe("stdio-rpc");
    expect(rec.outputTail).toBe("headless done");
    const events = opts.ledger.getEvents(rec.id);
    expect(events.map((e) => e.type)).toEqual(["step", "tool_use", "text"]);
  }, 20000);
});

describe("v0.4.4 dsh 进程判定器（超时触发 → 进程存活分流）", () => {
  function tmpLedger(): Ledger {
    const dir = mkdtempSync(path.join(tmpdir(), "hb-dsh-judge-"));
    dirs.push(dir);
    return new Ledger(path.join(dir, "ledger.db"));
  }

  function fakeFinalize() {
    return (status: TaskRecord["status"], reason?: string): TaskRecord => ({
      id: "hb_judge",
      harness: "dsh",
      transport: "stdio-rpc",
      status,
      ...(reason ? { failReason: reason } : {}),
    });
  }

  const timeoutErr = () => new Error("dsh rpc session/wait 超时（2000ms）");

  it("进程已退 exit=0 → 按退出码结算 success", async () => {
    const l = tmpLedger();
    const rec = await adjudicateDshTimeout({
      view: { closed: true, exitCode: 0, probe: async () => { throw new Error("never"); } },
      sessionId: "dsh_x",
      taskId: "hb_judge",
      timeoutMs: 5000,
      ledger: l,
      finalize: fakeFinalize(),
    });
    expect(rec.status).toBe("success");
    expect(rec.failReason).toBeUndefined();
    const types = l.getEvents("hb_judge").map((e) => e.type);
    expect(types).toContain("session_check");
    expect(types).toContain("session_settled");
    l.close();
  });

  it("进程已退 exit=1 → failed 且 failReason 带退出码", async () => {
    const l = tmpLedger();
    const rec = await adjudicateDshTimeout({
      view: { closed: true, exitCode: 1, probe: async () => { throw new Error("never"); } },
      sessionId: "dsh_x",
      taskId: "hb_judge",
      timeoutMs: 5000,
      ledger: l,
      finalize: fakeFinalize(),
    });
    expect(rec.status).toBe("failed");
    expect(rec.failReason).toContain("exit=1");
    l.close();
  });

  it("进程存活但 RPC 连续 3 次无响应 → stalled 告警 + timeout（不杀进程）", async () => {
    const l = tmpLedger();
    const dir = mkdtempSync(path.join(tmpdir(), "hb-dsh-alert-"));
    dirs.push(dir);
    const alertFile = path.join(dir, "alert.txt");
    let probes = 0;
    const rec = await adjudicateDshTimeout({
      view: {
        closed: false,
        exitCode: null,
        probe: async () => {
          probes += 1;
          throw timeoutErr();
        },
      },
      sessionId: "dsh_x",
      taskId: "hb_judge",
      timeoutMs: 5000,
      ledger: l,
      notifyCommand: `${process.execPath} -e 'require("fs").appendFileSync(${JSON.stringify(alertFile)}, "stalled\\n")'`,
      checkIntervalMs: 1,
      finalize: fakeFinalize(),
    });
    expect(rec.status).toBe("timeout");
    expect(rec.failReason).toContain("stalled");
    expect(rec.failReason).toContain("人工介入");
    expect(probes).toBe(3);
    await vi.waitFor(() => expect(existsSync(alertFile)).toBe(true), { timeout: 5000 });
    const stillRunning = l.getEvents("hb_judge").find((e) => e.type === "session_still_running");
    expect(stillRunning).toBeDefined();
    l.close();
  }, 15000);

  it("进程存活且探活恢复响应 → 正常结算 success", async () => {
    const l = tmpLedger();
    const rec = await adjudicateDshTimeout({
      view: { closed: false, exitCode: null, probe: async () => ({ status: "ok" }) },
      sessionId: "dsh_x",
      taskId: "hb_judge",
      timeoutMs: 5000,
      ledger: l,
      checkIntervalMs: 1,
      finalize: fakeFinalize(),
    });
    expect(rec.status).toBe("success");
    const settled = l.getEvents("hb_judge").find((e) => e.type === "session_settled");
    expect((settled?.payload as { probe?: string }).probe).toBe("responsive");
    l.close();
  });

  it("探活返回 rpc 业务错误（非超时）→ failed", async () => {
    const l = tmpLedger();
    const rec = await adjudicateDshTimeout({
      view: {
        closed: false,
        exitCode: null,
        probe: async () => {
          throw new Error("dsh rpc error: session not found");
        },
      },
      sessionId: "dsh_x",
      taskId: "hb_judge",
      timeoutMs: 5000,
      ledger: l,
      checkIntervalMs: 1,
      finalize: fakeFinalize(),
    });
    expect(rec.status).toBe("failed");
    expect(rec.failReason).toContain("session not found");
    l.close();
  });

  it("集成：runDshTask 超时触发判定器 → 探活恢复响应 → success（timeout 字段落库）", async () => {
    const { sdkScript, headlessScript } = writeMockScripts();
    const adapter = dshAdapter(sdkScript, headlessScript, { version: "0.2.1" });
    const transport = { command: process.execPath, args: [sdkScript, "--profile", "sdk"] };
    const opts = makeOpts(adapter, transport, { timeoutMs: 60, timeoutSource: "taskType_default" });
    const rec = await runDshTask(opts);
    // mock 的 session/wait 120ms 后响应 → 判定器探活恢复 → success
    expect(rec.status).toBe("success");
    expect(rec.timeoutMs).toBe(60);
    expect(rec.timeoutSource).toBe("taskType_default");
    const types = opts.ledger.getEvents(rec.id).map((e) => e.type);
    expect(types).toContain("session_check");
    expect(types).toContain("session_settled");
  }, 15000);
});
