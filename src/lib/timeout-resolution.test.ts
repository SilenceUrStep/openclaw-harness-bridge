import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Adapter } from "./adapters.js";
import { Ledger } from "./ledger.js";
import {
  resolveTaskTimeout,
  resolveWorkspace,
  runTask,
  TASK_TYPE_DEFAULT_TIMEOUT_MS,
} from "./runner.js";

const dirs: string[] = [];
const ledgers: Ledger[] = [];

afterAll(() => {
  for (const l of ledgers) l.close();
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function tmpLedger(): Ledger {
  const dir = mkdtempSync(path.join(tmpdir(), "hb-timeout-"));
  dirs.push(dir);
  const l = new Ledger(path.join(dir, "ledger.db"));
  ledgers.push(l);
  return l;
}

describe("resolveTaskTimeout（v0.4.4 taskType 感知默认超时）", () => {
  it("显式 timeoutMs 最优先 → explicit", () => {
    expect(
      resolveTaskTimeout({ explicitTimeoutMs: 1234, taskType: "coding", isHttp: true }),
    ).toEqual({ timeoutMs: 1234, source: "explicit" });
  });

  it("taskType 显式配置（defaultTimeoutByTaskType）覆盖内置默认 → taskType_default", () => {
    expect(
      resolveTaskTimeout({
        taskType: "coding",
        defaultTimeoutByTaskType: { coding: 5_400_000 },
        maxDurationMs: 7_200_000,
        isHttp: true,
      }),
    ).toEqual({ timeoutMs: 5_400_000, source: "taskType_default" });
  });

  it("http 全局兜底配置（timeouts.maxDurationMs）压过内置 taskType 默认（v0.4.3 兼容）", () => {
    expect(
      resolveTaskTimeout({ taskType: "coding", maxDurationMs: 7_200_000, isHttp: true }),
    ).toEqual({ timeoutMs: 7_200_000, source: "global_default" });
    expect(
      resolveTaskTimeout({ taskType: "general", maxDurationMs: 7_200_000, isHttp: true }),
    ).toEqual({ timeoutMs: 7_200_000, source: "global_default" });
  });

  it("内置 taskType 默认：coding 45min，general/analysis/search 10min", () => {
    expect(resolveTaskTimeout({ taskType: "coding" })).toEqual({
      timeoutMs: 2_700_000,
      source: "taskType_default",
    });
    expect(TASK_TYPE_DEFAULT_TIMEOUT_MS).toEqual({
      coding: 2_700_000,
      general: 600_000,
      analysis: 600_000,
      search: 600_000,
    });
    for (const t of ["general", "analysis", "search"]) {
      expect(resolveTaskTimeout({ taskType: t })).toEqual({
        timeoutMs: 600_000,
        source: "taskType_default",
      });
    }
  });

  it("无 taskType → 全局默认（defaultTimeoutMs 或 600000，保持现状）", () => {
    expect(resolveTaskTimeout({})).toEqual({ timeoutMs: 600_000, source: "global_default" });
    expect(resolveTaskTimeout({ defaultTimeoutMs: 123000 })).toEqual({
      timeoutMs: 123_000,
      source: "global_default",
    });
  });

  it("未知 taskType → 落到全局默认", () => {
    expect(resolveTaskTimeout({ taskType: "research" })).toEqual({
      timeoutMs: 600_000,
      source: "global_default",
    });
  });

  it("非 http 任务不吃 timeouts.maxDurationMs 分支", () => {
    expect(
      resolveTaskTimeout({ taskType: "general", maxDurationMs: 7_200_000, isHttp: false }),
    ).toEqual({ timeoutMs: 600_000, source: "taskType_default" });
  });
});

describe("runTask（cli）回写实际生效超时到台账", () => {
  it("记录 timeoutMs / timeoutSource（库中可读回）", () => {
    const l = tmpLedger();
    const adapter = {
      id: "echo",
      binary: "echo",
      delegate: { run: ["echo", "{prompt}"] },
    } as unknown as Adapter;
    const rec = runTask({
      adapter,
      prompt: "hi",
      wait: true,
      timeoutMs: 5000,
      timeoutSource: "taskType_default",
      ledger: l,
      tasksDir: path.join(path.dirname(l.dbPath), "tasks"),
    });
    expect(rec.status).toBe("success");
    expect(rec.timeoutMs).toBe(5000);
    expect(rec.timeoutSource).toBe("taskType_default");
    const fromDb = l.getById(rec.id);
    expect(fromDb?.timeoutMs).toBe(5000);
    expect(fromDb?.timeoutSource).toBe("taskType_default");
  });
});

describe("resolveWorkspace（v0.4.4 工作区三级解析）", () => {
  it("显式 cwd 优先", () => {
    const r = resolveWorkspace("/tmp/proj", "/tmp/global");
    expect(r).toEqual({ cwd: "/tmp/proj", source: "explicit" });
  });

  it("未传 cwd 时用 globalWorkspace 兜底", () => {
    const r = resolveWorkspace(undefined, "/tmp/global");
    expect(r).toEqual({ cwd: "/tmp/global", source: "globalWorkspace" });
  });

  it("都未配置时回退 serve 进程默认（undefined）", () => {
    expect(resolveWorkspace(undefined, undefined)).toEqual({
      cwd: undefined,
      source: "serve_default",
    });
  });

  it("空白字符串视为未配置", () => {
    expect(resolveWorkspace("   ", "  ")).toEqual({ cwd: undefined, source: "serve_default" });
    expect(resolveWorkspace("  /tmp/proj  ", " ")).toEqual({
      cwd: "/tmp/proj",
      source: "explicit",
    });
  });
});
