import { describe, expect, it } from "vitest";
import { formatTaskLine } from "./runner.js";
import type { TaskRecord } from "./ledger.js";

function rec(partial: Partial<TaskRecord>): TaskRecord {
  return {
    id: "hb_20260101T000000Z_ab12",
    harness: "opencode",
    status: "success",
    ...partial,
  } as TaskRecord;
}

describe("harness_status 摘要模式 formatTaskLine（v0.4.7）", () => {
  it("一行含 taskId / harness / 状态 / 耗时 / 成本五段", () => {
    const line = formatTaskLine(
      rec({ durationMs: 400_000, costTotal: 0.5, tokensInput: 100, tokensOutput: 50 }),
    );
    const segs = line.split(" ｜ ");
    expect(segs[0]).toBe("hb_20260101T000000Z_ab12");
    expect(segs[1]).toBe("opencode");
    expect(segs[2]).toBe("success");
    expect(segs[3]).toBe("耗时 6m40s");
    expect(segs[4]).toBe("cost 0.5 / 150 tok");
  });

  it("无时长/成本 → 显性占位（— 与 成本 —）", () => {
    const line = formatTaskLine(rec({}));
    expect(line).toContain("耗时 —");
    expect(line).toContain("成本 —");
  });

  it("running 无 durationMs 按 startedAt 算已运行时长", () => {
    const line = formatTaskLine(rec({ status: "running", startedAt: new Date(Date.now() - 65_000).toISOString() }));
    expect(line).toContain("耗时 1m");
  });

  it("cost 优先取 costTotal，回落 cost；tokens 合计 input+output+reasoning", () => {
    expect(formatTaskLine(rec({ cost: 1.25 }))).toContain("cost 1.25");
    expect(formatTaskLine(rec({ costTotal: 2, cost: 1.25 }))).toContain("cost 2");
    expect(
      formatTaskLine(rec({ tokensInput: 10, tokensOutput: 20, tokensReasoning: 5 })),
    ).toContain("35 tok");
    expect(formatTaskLine(rec({ tokensInput: 10, tokensCacheRead: 99 }))).toContain("10 tok");
  });

  it("startedAt 非法时不崩（显示 —）", () => {
    const line = formatTaskLine(rec({ status: "running", startedAt: "not-a-date" }));
    expect(line).toContain("耗时 —");
  });
});
