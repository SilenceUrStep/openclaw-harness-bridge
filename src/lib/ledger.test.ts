import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Ledger, summarizeCost, truncate2kb, type TaskRecord, type TaskStatus } from "./ledger.js";

const dirs: string[] = [];

function tmpLedger(opts?: { legacyFile?: string }): Ledger {
  const dir = mkdtempSync(path.join(tmpdir(), "hb-ledger-"));
  dirs.push(dir);
  return new Ledger(path.join(dir, "ledger.db"), { legacyFile: opts?.legacyFile });
}

afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function rec(partial: Partial<TaskRecord> & { id: string; harness: string }): TaskRecord {
  return { status: "running", transport: "cli", startedAt: new Date().toISOString(), ...partial };
}

describe("Ledger (SQLite)", () => {
  it("upsert 合并：running → 终态两次 append 只留一行，后写覆盖", async () => {
    const l = tmpLedger();
    const id = "hb_t1";
    l.append(rec({ id, harness: "echo", status: "running", prompt: "p", pid: 123 }));
    l.append({
      ...rec({ id, harness: "echo", status: "success", exitCode: 0, finishedAt: new Date().toISOString() }),
    });
    const got = l.getById(id);
    expect(got).toBeDefined();
    expect(got?.status).toBe("success");
    expect(got?.prompt).toBe("p");
    expect(got?.pid).toBe(123);
    expect(got?.exitCode).toBe(0);
    expect(got?.transport).toBe("cli");
  });

  it("latest 过滤：harness/status/since/until，按时间倒序", async () => {
    const l = tmpLedger();
    l.append(rec({ id: "a1", harness: "echo", status: "success", startedAt: "2026-10-01T00:00:00Z" }));
    l.append(rec({ id: "a2", harness: "opencode", status: "failed", startedAt: "2026-10-02T00:00:00Z" }));
    l.append(rec({ id: "a3", harness: "echo", status: "failed", startedAt: "2026-10-03T00:00:00Z" }));
    expect(l.latest({ harness: "echo" }).map((r) => r.id)).toEqual(["a3", "a1"]);
    expect(l.latest({ status: "failed" }).map((r) => r.id)).toEqual(["a3", "a2"]);
    expect(l.latest({ since: "2026-10-02T00:00:00Z" }).map((r) => r.id)).toEqual(["a3", "a2"]);
    expect(l.latest({ until: "2026-10-02T00:00:00Z" }).map((r) => r.id)).toEqual(["a2", "a1"]);
    expect(l.latest({ since: "2026-10-02T00:00:00Z", until: "2026-10-02T00:00:00Z" }).map((r) => r.id)).toEqual(["a2"]);
  });

  it("状态别名归一：succeeded → success", async () => {
    const l = tmpLedger();
    l.append(rec({ id: "n1", harness: "x", status: "succeeded" as unknown as TaskStatus }));
    expect(l.getById("n1")?.status).toBe("success");
    expect(l.latest({ status: "success" }).map((r) => r.id)).toEqual(["n1"]);
  });

  it("http 任务记录 transport/cost/tokens/fail_reason/fallback_used", async () => {
    const l = tmpLedger();
    l.append(
      rec({
        id: "h1",
        harness: "opencode",
        transport: "http",
        status: "failed",
        failReason: "permission denied: bash",
        cost: 0.0123,
        tokensInput: 100,
        tokensOutput: 50,
        tokensReasoning: 10,
        tokensCacheRead: 5,
        tokensCacheWrite: 6,
        fallbackUsed: true,
      }),
    );
    const got = l.getById("h1");
    expect(got?.transport).toBe("http");
    expect(got?.failReason).toBe("permission denied: bash");
    expect(got?.cost).toBeCloseTo(0.0123);
    expect(got?.tokensInput).toBe(100);
    expect(got?.tokensOutput).toBe(50);
    expect(got?.tokensReasoning).toBe(10);
    expect(got?.tokensCacheRead).toBe(5);
    expect(got?.tokensCacheWrite).toBe(6);
    expect(got?.fallbackUsed).toBe(true);
  });

  it("addEvents：seq 跨批次自增、getEvents 按 seq 排序、payload 2KB 截断", async () => {
    const l = tmpLedger();
    const id = "ev1";
    l.append(rec({ id, harness: "opencode", transport: "http", status: "running" }));
    l.addEvents(id, [
      { type: "step", payload: { phase: "start" }, ts: "2026-10-16T00:00:01Z" },
      { type: "text", payload: { text: "x".repeat(5000) }, ts: "2026-10-16T00:00:02Z" },
    ]);
    l.addEvents(id, [
      { type: "error", payload: { message: "boom" }, ts: "2026-10-16T00:00:03Z" },
    ]);
    const events = l.getEvents(id);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(events.map((e) => e.type)).toEqual(["step", "text", "error"]);
    const textPayload = events[1].payload as { text: string };
    expect(typeof textPayload).toBe("object");
    expect(textPayload.text.length).toBeLessThanOrEqual(2048);
    expect(textPayload.text).toContain("[truncated");
    expect(events[2].payload).toEqual({ message: "boom" });
    // 存储层整行也受 2KB 约束
    expect(JSON.stringify(events[1].payload).length).toBeLessThanOrEqual(2048);
  });

  it("v0.4.11 getEvents limit：不传全量兼容；传 limit 只回最新 N 条且按 seq 正序；countEvents 总数", async () => {
    const l = tmpLedger();
    const id = "ev-limit";
    l.append(rec({ id, harness: "opencode", status: "running" }));
    for (let i = 0; i < 10; i++) {
      l.addEvents(id, [{ type: "step", payload: { i }, ts: new Date().toISOString() }]);
    }
    // 不传 limit：全量（既有调用兼容）
    expect(l.getEvents(id)).toHaveLength(10);
    expect(l.getEvents(id).map((e) => (e.payload as { i: number }).i)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // limit=3：取最新 3 条（seq 7/8/9），仍按 seq 正序返回保持时间线可读
    const last3 = l.getEvents(id, 3);
    expect(last3.map((e) => e.seq)).toEqual([7, 8, 9]);
    expect(last3.map((e) => (e.payload as { i: number }).i)).toEqual([7, 8, 9]);
    // limit 超过总数：等价全量
    expect(l.getEvents(id, 100)).toHaveLength(10);
    // limit=0：空集（调用方限流语义由工具层 clamp，存储层如实执行）
    expect(l.getEvents(id, 0)).toEqual([]);
    // countEvents：total 与 truncated 判断依据
    expect(l.countEvents(id)).toBe(10);
    expect(l.countEvents("no-such-task")).toBe(0);
    // 截断组合：total(10) > 返回条数(3) → truncated 语义成立
    const total = l.countEvents(id);
    const returned = l.getEvents(id, 3);
    expect(total > returned.length).toBe(true);
    await l.close();
  });

  it("truncate2kb 行为", () => {
    expect(truncate2kb("abc")).toBe("abc");
    const long = "y".repeat(3000);
    const out = truncate2kb(long);
    expect(out.startsWith("y".repeat(2048))).toBe(true);
    expect(out).toContain("[truncated 952 chars]");
  });

  it("legacyLatest：JSON Lines 只读，同 id 取最后一条", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hb-legacy-"));
    dirs.push(dir);
    const file = path.join(dir, "ledger.jsonl");
    const r1 = { id: "l1", harness: "echo", status: "running", startedAt: "2026-09-01T00:00:00Z" };
    const r2 = { id: "l1", harness: "echo", status: "success", startedAt: "2026-09-01T00:00:00Z", exitCode: 0 };
    const r3 = { id: "l2", harness: "opencode", status: "failed", startedAt: "2026-09-02T00:00:00Z" };
    writeFileSync(file, [JSON.stringify(r1), "not-json", JSON.stringify(r2), JSON.stringify(r3)].join("\n"));
    const l = tmpLedger({ legacyFile: file });
    const all = l.legacyLatest();
    expect(all.map((r) => r.id)).toEqual(["l2", "l1"]);
    expect(all.find((r) => r.id === "l1")?.status).toBe("success");
    expect(l.legacyLatest({ status: "failed" }).map((r) => r.id)).toEqual(["l2"]);
    expect(l.legacyLatest({ since: "2026-09-02T00:00:00Z" }).map((r) => r.id)).toEqual(["l2"]);
    // SQLite 与 legacy 互不干扰
    expect(l.getById("l1")).toBeUndefined();
  });

  it("旧 v0.3.0 库迁移：缺 cost_*/forked_from 列时自动补齐", () => {
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (p: string) => { exec(s: string): void; prepare(s: string): { run(...a: unknown[]): void }; close(): void };
    };
    const dir = mkdtempSync(path.join(tmpdir(), "hb-mig-"));
    dirs.push(dir);
    const dbPath = path.join(dir, "ledger.db");
    const old = new DatabaseSync(dbPath);
    old.exec(`CREATE TABLE task (
      id TEXT PRIMARY KEY, harness TEXT NOT NULL, transport TEXT DEFAULT 'cli',
      status TEXT NOT NULL, exit_code INTEGER, fail_reason TEXT, cost REAL,
      tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
      tokens_cache_read INTEGER, tokens_cache_write INTEGER, fallback_used INTEGER DEFAULT 0
    )`);
    old.prepare("INSERT INTO task (id, harness, status) VALUES ('m1', 'echo', 'success')").run();
    old.close();
    const l = new Ledger(dbPath);
    expect(l.getById("m1")?.status).toBe("success");
    l.append({ id: "m1", harness: "echo", status: "success", costTotal: 1.5, costInputTokens: 10, forkedFrom: "m0" });
    const got = l.getById("m1");
    expect(got?.costTotal).toBe(1.5);
    expect(got?.costInputTokens).toBe(10);
    expect(got?.forkedFrom).toBe("m0");
    l.close();
  });

  it("summarizeCost 汇总", async () => {
    const l = tmpLedger();
    l.append(rec({ id: "s1", harness: "opencode", transport: "http", status: "success", costTotal: 0.1, costInputTokens: 10, costOutputTokens: 20, costReasoningTokens: 1, costCacheReadTokens: 2 }));
    l.append(rec({ id: "s2", harness: "echo", status: "failed" }));
    l.append(rec({ id: "s3", harness: "opencode", transport: "http", status: "success", cost: 0.3, tokensInput: 5 }));
    const sum = summarizeCost(l.latest());
    expect(sum.tasks).toBe(3);
    expect(sum.withCost).toBe(2);
    expect(sum.costTotal).toBeCloseTo(0.4);
    expect(sum.costInputTokens).toBe(15);
    expect(sum.costOutputTokens).toBe(20);
    expect(sum.costReasoningTokens).toBe(1);
    expect(sum.costCacheReadTokens).toBe(2);
  });

  it("close 后可重新打开（连接不泄漏到测试进程外）", async () => {
    const l = tmpLedger();
    l.append(rec({ id: "c1", harness: "echo", status: "success" }));
    l.close();
    const dir = path.dirname(l.dbPath);
    const l2 = new Ledger(l.dbPath);
    expect(l2.getById("c1")?.status).toBe("success");
    l2.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("cleanupEvents：老事件删、新事件留、task 主表保留（v0.4.1）", () => {
    const l = tmpLedger();
    l.append(rec({ id: "e1", harness: "echo", status: "success" }));
    const oldTs = new Date(Date.now() - 40 * 86400_000).toISOString();
    const newTs = new Date().toISOString();
    l.addEvents("e1", [
      { type: "started", payload: { v: "old" }, ts: oldTs },
      { type: "finished", payload: { v: "new" }, ts: newTs },
    ]);
    const deleted = l.cleanupEvents(30);
    expect(deleted).toBe(1);
    const events = l.getEvents("e1");
    expect(events.length).toBe(1);
    expect(events[0].ts).toBe(newTs);
    // task 主表不受清理影响
    expect(l.getById("e1")).toBeDefined();
    l.close();
    rmSync(path.dirname(l.dbPath), { recursive: true, force: true });
  });

  it("cleanupEvents retentionDays=0 语义由调用方控制（负数/0 不调用即可）", () => {
    const l = tmpLedger();
    l.append(rec({ id: "e2", harness: "echo", status: "success" }));
    l.addEvents("e2", [{ type: "started", payload: {}, ts: new Date().toISOString() }]);
    // 保留 365 天 → 什么都不删
    expect(l.cleanupEvents(365)).toBe(0);
    expect(l.getEvents("e2").length).toBe(1);
    l.close();
    rmSync(path.dirname(l.dbPath), { recursive: true, force: true });
  });
});

describe("v0.4.4 timeout 字段 + WAL checkpoint", () => {
  it("timeoutMs / timeoutSource 落库并可读回", () => {
    const l = tmpLedger();
    l.append(rec({ id: "t8a", harness: "opencode", status: "running", timeoutMs: 2_700_000, timeoutSource: "taskType_default" }));
    l.append(rec({ id: "t8a", harness: "opencode", status: "success" }));
    const got = l.getById("t8a");
    expect(got?.timeoutMs).toBe(2_700_000);
    expect(got?.timeoutSource).toBe("taskType_default");
    // 未设置时不误读
    l.append(rec({ id: "t8b", harness: "echo", status: "success" }));
    expect(l.getById("t8b")?.timeoutMs).toBeUndefined();
    expect(l.getById("t8b")?.timeoutSource).toBeUndefined();
    l.close();
    rmSync(path.dirname(l.dbPath), { recursive: true, force: true });
  });

  it("checkpoint() 返回 WAL 页数统计且不抛错（TRUNCATE 后 log=0）", () => {
    const l = tmpLedger();
    l.append(rec({ id: "t9a", harness: "echo", status: "success" }));
    const r = l.checkpoint();
    expect(r).toBeDefined();
    expect(typeof r!.busy).toBe("number");
    expect(typeof r!.log).toBe("number");
    expect(typeof r!.checkpointed).toBe("number");
    expect(r!.checkpointed).toBeGreaterThanOrEqual(0);
    l.close();
    rmSync(path.dirname(l.dbPath), { recursive: true, force: true });
  });

  it("checkpoint / timeout_resolved 事件类型入事件台账（合成任务 id 自动补父行）", () => {
    const l = tmpLedger();
    l.addEvents("hb_checkpoint", [
      { type: "checkpoint", payload: { busy: 0, log: 0, checkpointed: 3 }, ts: new Date().toISOString() },
    ]);
    l.append(rec({ id: "t9c", harness: "opencode", status: "running" }));
    l.addEvents("t9c", [
      {
        type: "timeout_resolved",
        payload: { timeoutMs: 600_000, source: "taskType_default", taskType: "coding" },
        ts: new Date().toISOString(),
      },
    ]);
    const sys = l.getEvents("hb_checkpoint");
    expect(sys.length).toBe(1);
    expect(sys[0].type).toBe("checkpoint");
    expect(l.getById("hb_checkpoint")?.harness).toBe("__system__");
    const ev = l.getEvents("t9c");
    expect(ev[0].type).toBe("timeout_resolved");
    expect(ev[0].payload).toEqual({ timeoutMs: 600_000, source: "taskType_default", taskType: "coding" });
    l.close();
    rmSync(path.dirname(l.dbPath), { recursive: true, force: true });
  });

  it("workspace_resolved 事件类型入事件台账（v0.4.4 工作区三级解析）", () => {
    const l = tmpLedger();
    l.append(rec({ id: "t9w", harness: "opencode", status: "running", cwd: "/tmp/global" }));
    l.addEvents("t9w", [
      {
        type: "workspace_resolved",
        payload: { cwd: "/tmp/global", source: "globalWorkspace", transport: "http" },
        ts: new Date().toISOString(),
      },
    ]);
    const ev = l.getEvents("t9w");
    expect(ev.length).toBe(1);
    expect(ev[0].type).toBe("workspace_resolved");
    expect(ev[0].payload).toEqual({ cwd: "/tmp/global", source: "globalWorkspace", transport: "http" });
    expect(l.getById("t9w")?.cwd).toBe("/tmp/global");
    l.close();
    rmSync(path.dirname(l.dbPath), { recursive: true, force: true });
  });
});
