import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { TaskRecord } from "./ledger.js";
import { Ledger } from "./ledger.js";
import { classifyFailure, orchestrate, type DispatchMeta, type DispatchResult } from "./resilience.js";

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

function newLedger(): Ledger {
  const dir = mkdtempSync(path.join(tmpdir(), "hb-res-"));
  dirs.push(dir);
  return new Ledger(path.join(dir, "ledger.db"));
}

function rec(id: string, status: TaskRecord["status"], harness = "a", error?: string): TaskRecord {
  return { id, harness, transport: "cli", status, ...(error ? { error } : {}) } as TaskRecord;
}

describe("classifyFailure（v0.4.3 失败分类边界）", () => {
  it("超时类：status=timeout 或 failReason 含 timeout", () => {
    expect(classifyFailure({ status: "timeout" } as TaskRecord)).toBe("timeout");
    expect(classifyFailure({ status: "failed", failReason: "timeout after 600000ms" } as TaskRecord)).toBe("timeout");
  });

  it("不可用类：探活失败/进程启动失败（ENOENT/ECONNREFUSED）", () => {
    expect(classifyFailure({ status: "failed", error: "spawn dsh ENOENT" } as TaskRecord)).toBe("unavailable");
    expect(classifyFailure({ status: "failed", error: "http 探活失败: connect ECONNREFUSED" } as TaskRecord)).toBe("unavailable");
  });

  it("派发被拒（dispatchError）→ 不可用类", () => {
    expect(classifyFailure(undefined, "http 探活失败: connect ECONNREFUSED")).toBe("unavailable");
  });

  it("业务失败：任务本身报错不命中不可用特征", () => {
    expect(classifyFailure({ status: "failed", failReason: "模型配额超限" } as TaskRecord)).toBe("business");
  });
});

describe("orchestrate wait=true（v0.4.3 重试/降级状态机）", () => {
  it("首次成功：不重试、无 retry 事件", async () => {
    const ledger = newLedger();
    const out = await orchestrate({
      ledger,
      wait: true,
      initialHarness: "a",
      retryAttempts: 1,
      fallbackChain: [],
      probe: async () => ({ available: true, detail: "" }),
      dispatch: async () => ({ ok: true, rec: rec("t1", "success") }),
    });
    expect(out.rec?.status).toBe("success");
    expect(out.attempts).toBe(1);
    expect(out.fallbackUsed).toBe(false);
    expect(out.retryOfChain).toEqual([]);
    expect(ledger.getEvents("t1").filter((e) => e.type === "retry" || e.type === "fallback")).toEqual([]);
  });

  it("失败后同 harness 重试成功：retry 事件挂新记录，retryOf 指向失败任务", async () => {
    const ledger = newLedger();
    ledger.append(rec("f1", "failed", "a", "模型配额超限"));
    const calls: Array<{ harness: string; meta: DispatchMeta }> = [];
    const out = await orchestrate({
      ledger,
      wait: true,
      initialHarness: "a",
      retryAttempts: 1,
      fallbackChain: [],
      probe: async () => ({ available: true, detail: "" }),
      dispatch: async (harness, meta) => {
        calls.push({ harness, meta });
        return calls.length === 1
          ? { ok: true, rec: rec("f1", "failed", "a", "模型配额超限") }
          : { ok: true, rec: rec("f2", "success") };
      },
    });
    expect(out.rec?.id).toBe("f2");
    expect(out.attempts).toBe(2);
    expect(calls[1]).toMatchObject({ harness: "a", meta: { isInitial: false, retryOf: "f1" } });
    const events = ledger.getEvents("f2");
    expect(
      events.some((e) => e.type === "retry" && (e.payload as { originTaskId?: string }).originTaskId === "f1"),
    ).toBe(true);
  });

  it("重试耗尽且不可用类失败 → 沿降级链接管，fallbackUsed 标记", async () => {
    const ledger = newLedger();
    ledger.append(rec("f1", "failed", "a", "spawn dsh ENOENT"));
    ledger.append(rec("f2", "failed", "a", "spawn dsh ENOENT"));
    const calls: string[] = [];
    const probes: string[] = [];
    const out = await orchestrate({
      ledger,
      wait: true,
      initialHarness: "a",
      retryAttempts: 1,
      fallbackChain: ["b"],
      probe: async (h) => {
        probes.push(h);
        return { available: h !== "a", detail: h === "a" ? "binary 不可用" : "binary 可用" };
      },
      dispatch: async (harness, meta) => {
        calls.push(`${harness}:${meta.isInitial ? "initial" : meta.retryOf ?? meta.fallbackFrom}`);
        if (harness === "a") return { ok: true, rec: rec(`f${calls.filter((c) => c.startsWith("a")).length}`, "failed", "a", "spawn dsh ENOENT") };
        return { ok: true, rec: rec("f3", "success", "b") };
      },
    });
    expect(out.rec?.id).toBe("f3");
    expect(out.rec?.fallbackUsed).toBe(true);
    expect(out.fallbackUsed).toBe(true);
    expect(calls).toEqual(["a:initial", "a:f1", "b:f2"]);
    expect(probes).toEqual(["a"]); // 探活仅作台账留痕，业务上不改写降级决策
    const ev = ledger.getEvents("f3").find((e) => e.type === "fallback"); // takeover 事件挂接管记录
    expect(ev).toBeTruthy();
    const payload = ev?.payload as { action?: string; from?: string; to?: string };
    expect(payload.action).toBe("takeover");
    expect(payload.from).toBe("a");
    expect(payload.to).toBe("b");
  });

  it("业务性失败（任务本身报错）不降级不探活，事件标注 skipped 仅告警", async () => {
    const ledger = newLedger();
    let probeCalls = 0;
    let n = 0;
    const out = await orchestrate({
      ledger,
      wait: true,
      initialHarness: "a",
      retryAttempts: 1,
      fallbackChain: ["b"],
      probe: async () => {
        probeCalls += 1;
        return { available: true, detail: "" };
      },
      dispatch: async () => {
        n += 1;
        return { ok: true, rec: rec(n === 1 ? "f1" : "f2", "failed", "a", "模型配额超限") };
      },
    });
    expect(probeCalls).toBe(0); // 业务失败连探活都不需要
    expect(n).toBe(2); // 重试 1 次后停止，不降级
    expect(out.fallbackUsed).toBe(false);
    const ev = ledger.getEvents("f2").find((e) => e.type === "fallback");
    expect((ev?.payload as { action?: string }).action).toBe("skipped");
  });

  it("降级链耗尽：exhausted 事件且返回失败", async () => {
    const ledger = newLedger();
    let n = 0;
    const out = await orchestrate({
      ledger,
      wait: true,
      initialHarness: "a",
      retryAttempts: 1,
      fallbackChain: ["b"],
      probe: async (h) => ({ available: false, detail: `${h} binary 不可用` }),
      dispatch: async (harness) => {
        n += 1;
        return { ok: true, rec: rec(`f${n}`, "failed", harness, "spawn ENOENT") };
      },
    });
    expect(out.fallbackUsed).toBe(true);
    expect(out.rec?.harness).toBe("b");
    const ev = ledger
      .getEvents("f3")
      .find((e) => e.type === "fallback" && (e.payload as { action?: string }).action === "exhausted");
    expect(ev).toBeTruthy();
  });

  it("派发被拒（http 探活失败形态）→ 降级目标启动成功", async () => {
    const ledger = newLedger();
    let n = 0;
    const out = await orchestrate({
      ledger,
      wait: true,
      initialHarness: "a",
      retryAttempts: 0,
      fallbackChain: ["b"],
      probe: async (h) => ({ available: h !== "a", detail: "探活失败" }),
      dispatch: async (harness) => {
        n += 1;
        return harness === "a"
          ? { ok: false, error: "http 探活失败: connect ECONNREFUSED，adapter 未配置 fallback，任务未执行" }
          : { ok: true, rec: rec(`r${n}`, "running", "b") };
      },
    });
    expect(out.error).toBeUndefined();
    expect(out.rec?.id).toBe("r2");
    expect(out.rec?.fallbackUsed).toBe(true);
    expect(out.fallbackUsed).toBe(true);
  });

  it("fatal 拒绝（fork 失败形态）立即返回不重试", async () => {
    const ledger = newLedger();
    let calls = 0;
    const out = await orchestrate({
      ledger,
      wait: true,
      initialHarness: "a",
      retryAttempts: 3,
      fallbackChain: ["b"],
      probe: async () => ({ available: true, detail: "" }),
      dispatch: async () => {
        calls += 1;
        return { ok: false, error: "fork 命令未产出新会话 ID", fatal: true };
      },
    });
    expect(calls).toBe(1);
    expect(out.rec).toBeNull();
    expect(out.error).toContain("fork");
  });
});

describe("orchestrate wait=false（后台重试/降级链）", () => {
  it("终态失败经 onFinal 触发同 harness 重试（retryOf 串联）", async () => {
    const ledger = newLedger();
    ledger.append(rec("r1", "running"));
    ledger.append(rec("r2", "running"));
    const calls: Array<{ harness: string; meta: DispatchMeta }> = [];
    let onFinal: ((rec: TaskRecord) => void) | undefined;
    const out = await orchestrate({
      ledger,
      wait: false,
      initialHarness: "a",
      retryAttempts: 1,
      fallbackChain: [],
      probe: async () => ({ available: true, detail: "" }),
      dispatch: async (harness, meta) => {
        calls.push({ harness, meta });
        return { ok: true, rec: rec(calls.length === 1 ? "r1" : "r2", "running") };
      },
      setOnFinal: (fn) => {
        onFinal = fn;
      },
    });
    expect(out.rec?.id).toBe("r1");
    expect(calls.length).toBe(1);
    onFinal?.(rec("r1", "failed", "a", "模型配额超限"));
    await vi.waitFor(() => expect(calls.length).toBe(2));
    expect(calls[1]).toMatchObject({ harness: "a", meta: { retryOf: "r1" } });
    expect(ledger.getById("r2")?.retryOf).toBe("r1");
  });

  it("后台降级：重试耗尽 + 不可用 → 派发到降级 harness", async () => {
    const ledger = newLedger();
    ledger.append(rec("r1", "running", "a"));
    ledger.append(rec("r2", "running", "b"));
    const calls: Array<{ harness: string; meta: DispatchMeta }> = [];
    let onFinal: ((rec: TaskRecord) => void) | undefined;
    await orchestrate({
      ledger,
      wait: false,
      initialHarness: "a",
      retryAttempts: 0,
      fallbackChain: ["b"],
      probe: async (h) => ({ available: h !== "a", detail: h === "a" ? "binary 不可用" : "可用" }),
      dispatch: async (harness, meta) => {
        calls.push({ harness, meta });
        return { ok: true, rec: rec(calls.length === 1 ? "r1" : "r2", "running", harness) };
      },
      setOnFinal: (fn) => {
        onFinal = fn;
      },
    });
    onFinal?.(rec("r1", "failed", "a", "spawn dsh ENOENT"));
    await vi.waitFor(() => expect(calls.length).toBe(2));
    expect(calls[1]).toMatchObject({ harness: "b", meta: { fallbackFrom: "r1" } });
    expect(ledger.getById("r2")?.fallbackUsed).toBe(true);
    const ev = ledger.getEvents("r2").find((e) => e.type === "fallback");
    expect((ev?.payload as { action?: string }).action).toBe("takeover");
  });

  it("首次派发被拒：同步降级直到启动成功", async () => {
    const ledger = newLedger();
    let n = 0;
    const out = await orchestrate({
      ledger,
      wait: false,
      initialHarness: "a",
      retryAttempts: 0,
      fallbackChain: ["b"],
      probe: async (h) => ({ available: h !== "a", detail: "探活失败" }),
      dispatch: async (harness) => {
        n += 1;
        return harness === "a"
          ? { ok: false, error: "http 探活失败" }
          : { ok: true, rec: rec(`r${n}`, "running", harness) };
      },
    });
    expect(out.rec?.harness).toBe("b");
    expect(out.fallbackUsed).toBe(true);
  });
});
