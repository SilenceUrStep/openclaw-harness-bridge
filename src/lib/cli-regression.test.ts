import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Adapter } from "./adapters.js";
import { Ledger } from "./ledger.js";
import { extractSessionId, fillTemplate, newTaskId, runTask } from "./runner.js";

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

const echoAdapter = {
  id: "echo",
  displayName: "Echo (example)",
  binary: "echo",
  versionCheck: ["echo", "ok"],
  delegate: { run: ["echo", "{prompt}"], timeoutMs: 30000 },
  session: { idPattern: "ses_[a-zA-Z0-9]+" },
} as unknown as Adapter;

function newRunEnv() {
  const dir = mkdtempSync(path.join(tmpdir(), "hb-cli-"));
  dirs.push(dir);
  const ledger = new Ledger(path.join(dir, "ledger.db"));
  const tasksDir = path.join(dir, "tasks");
  mkdirSync(tasksDir, { recursive: true });
  return { dir, ledger, tasksDir };
}

describe("cli 模式回归（v0.1 行为不变）", () => {
  it("newTaskId / fillTemplate / extractSessionId 行为不变", () => {
    expect(newTaskId()).toMatch(/^hb_\d{8}T\d{6}Z_[0-9a-z]{4}$/);
    expect(fillTemplate(["run", "{prompt}", "-s", "{sessionId}"], { prompt: "hi there", sessionId: "ses_x" })).toEqual([
      "run",
      "hi there",
      "-s",
      "ses_x",
    ]);
    expect(extractSessionId("before ses_abc123 after", "ses_[a-zA-Z0-9]+")).toBe("ses_abc123");
    expect(extractSessionId("no id", "ses_[a-zA-Z0-9]+")).toBeNull();
    expect(extractSessionId("x", "[invalid")).toBeNull();
  });

  it("echo adapter wait=true：success/exitCode 0/outputTail 含 prompt/台账终态", () => {
    const env = newRunEnv();
    const rec = runTask({
      adapter: echoAdapter,
      prompt: "hello bridge",
      wait: true,
      timeoutMs: 30000,
      ledger: env.ledger,
      tasksDir: env.tasksDir,
    });
    expect(rec.status).toBe("success");
    expect(rec.exitCode).toBe(0);
    expect(rec.outputTail).toContain("hello bridge");
    expect(rec.finishedAt).toBeTruthy();
    expect(rec.durationMs).toBeGreaterThanOrEqual(0);
    expect(rec.sessionId ?? null).toBeNull();
    const final = env.ledger.getById(rec.id);
    expect(final?.status).toBe("success");
    expect(final?.transport ?? "cli").toBe("cli");
  });

  it("echo adapter wait=false：立即返回 pid，退出后台回写台账", async () => {
    const env = newRunEnv();
    const rec = runTask({
      adapter: echoAdapter,
      prompt: "background task",
      wait: false,
      timeoutMs: 30000,
      ledger: env.ledger,
      tasksDir: env.tasksDir,
    });
    expect(rec.status).toBe("running");
    expect(rec.pid).toBeGreaterThan(0);
    expect(rec.logFile).toBeTruthy();
    const deadline = Date.now() + 5000;
    let final = env.ledger.getById(rec.id);
    while ((!final || final.status === "running") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
      final = env.ledger.getById(rec.id);
    }
    expect(final?.status).toBe("success");
    expect(final?.exitCode).toBe(0);
  });

  it("非零退出码 → failed；超时 → timeout", () => {
    const env = newRunEnv();
    const failAdapter = { ...echoAdapter, delegate: { run: ["false"], timeoutMs: 30000 } } as unknown as Adapter;
    const rec = runTask({
      adapter: failAdapter,
      prompt: "x",
      wait: true,
      timeoutMs: 30000,
      ledger: env.ledger,
      tasksDir: env.tasksDir,
    });
    expect(rec.status).toBe("failed");
    expect(rec.exitCode).not.toBe(0);

    const env2 = newRunEnv();
    const slowAdapter = {
      ...echoAdapter,
      delegate: { run: [process.execPath, "-e", "setTimeout(()=>{},10000)"], timeoutMs: 30000 },
    } as unknown as Adapter;
    const rec2 = runTask({
      adapter: slowAdapter,
      prompt: "x",
      wait: true,
      timeoutMs: 300,
      ledger: env2.ledger,
      tasksDir: env2.tasksDir,
    });
    expect(rec2.status).toBe("timeout");
  });

  it("notifyCommand 收到 HB_* 环境变量（wait=false 后台完成时通知，v0.1 语义）", async () => {
    const env = newRunEnv();
    const notifyFile = path.join(env.dir, "notify.txt");
    const rec = runTask({
      adapter: echoAdapter,
      prompt: "notify me",
      wait: false,
      timeoutMs: 30000,
      ledger: env.ledger,
      tasksDir: env.tasksDir,
      notifyCommand: `printf '%s|%s' "$HB_STATUS" "$HB_HARNESS" > ${notifyFile}`,
    });
    expect(rec.status).toBe("running");
    const deadline = Date.now() + 5000;
    while (!existsSync(notifyFile) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(readFileSync(notifyFile, "utf8")).toBe("success|echo");
  });

  it("prompt 超长截断到 500 字符（含省略号）", () => {
    const env = newRunEnv();
    const rec = runTask({
      adapter: echoAdapter,
      prompt: "x".repeat(600),
      wait: true,
      timeoutMs: 30000,
      ledger: env.ledger,
      tasksDir: env.tasksDir,
    });
    expect(rec.prompt?.length).toBe(501);
    expect(rec.prompt?.endsWith("…")).toBe(true);
    expect(rec.status).toBe("success");
  });

  it("resumeSessionId 命中 resume 模板并可从输出提取 sessionId", () => {
    const env = newRunEnv();
    const resumeAdapter = {
      ...echoAdapter,
      delegate: { run: ["echo", "{prompt}"], resume: ["echo", "resume:{sessionId}", "{prompt}"], timeoutMs: 30000 },
    } as unknown as Adapter;
    const rec = runTask({
      adapter: resumeAdapter,
      prompt: "continue work",
      resumeSessionId: "ses_resume1",
      wait: true,
      timeoutMs: 30000,
      ledger: env.ledger,
      tasksDir: env.tasksDir,
    });
    expect(rec.outputTail).toContain("resume:ses_resume1");
    expect(rec.status).toBe("success");
  });

  it("legacy JSONL 台账仍可只读查看（v0.1 数据不迁移）", () => {
    const env = newRunEnv();
    const legacyFile = path.join(env.dir, "ledger.jsonl");
    writeFileSync(
      legacyFile,
      `${JSON.stringify({ id: "old1", harness: "echo", status: "success", startedAt: "2026-01-01T00:00:00Z" })}\n`,
    );
    const legacyLedger = new Ledger(env.ledger.dbPath.replace(/ledger\.db$/, "ledger2.db"), {
      legacyFile,
    });
    expect(legacyLedger.legacyLatest()[0]?.id).toBe("old1");
    expect(legacyLedger.getById("old1")).toBeUndefined();
  });
});
