import { describe, expect, it, vi, beforeEach } from "vitest";

const spawnSyncMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
  spawn: vi.fn(),
}));

const { notify, resetNotifyThrottle } = await import("./runner.js");
type TaskRecord = Parameters<typeof notify>[1];

function rec(partial: Partial<TaskRecord>): TaskRecord {
  return {
    id: "hb_test_n1",
    harness: "opencode",
    prompt: "p",
    status: "failed",
    transport: "cli",
    startedAt: new Date().toISOString(),
    ...partial,
  } as TaskRecord;
}

beforeEach(() => {
  spawnSyncMock.mockReset();
  spawnSyncMock.mockReturnValue({ status: 0, error: null }); // 默认送达成功，首次即返回
  resetNotifyThrottle();
});

describe("notify 节流（v0.4.1）", () => {
  it("未配置 notifyCommand 不通知", () => {
    notify(undefined, rec({}));
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("success 不通知（成功不打扰）", () => {
    notify("echo ok", rec({ status: "success" }));
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("失败触发通知，env 带 HB_* 变量", () => {
    notify("echo ok", rec({ status: "failed", exitCode: 1 }));
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const opts = spawnSyncMock.mock.calls[0][2] as { env: Record<string, string> };
    expect(opts.env.HB_TASK_ID).toBe("hb_test_n1");
    expect(opts.env.HB_STATUS).toBe("failed");
    expect(opts.env.HB_EXIT_CODE).toBe("1");
  });

  it("同 harness 60s 窗口内第二次失败被抑制", () => {
    notify("echo ok", rec({ id: "t1", status: "failed" }));
    notify("echo ok", rec({ id: "t2", status: "failed" }));
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it("不同 harness 不互相抑制", () => {
    notify("echo ok", rec({ id: "t1", harness: "opencode", status: "failed" }));
    notify("echo ok", rec({ id: "t2", harness: "dsh", status: "failed" }));
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
  });

  it("窗口过后再通知，HB_SUPPRESSED 带抑制计数", async () => {
    vi.useFakeTimers();
    try {
      notify("echo ok", rec({ id: "t1", status: "failed" }));
      notify("echo ok", rec({ id: "t2", status: "failed" }));
      notify("echo ok", rec({ id: "t3", status: "failed" }));
      vi.advanceTimersByTime(61_000);
      notify("echo ok", rec({ id: "t4", status: "failed" }));
      expect(spawnSyncMock).toHaveBeenCalledTimes(2);
      const opts = spawnSyncMock.mock.calls[1][2] as { env: Record<string, string> };
      expect(opts.env.HB_SUPPRESSED).toBe("2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("timeout 状态也触发通知", () => {
    notify("echo ok", rec({ status: "timeout" }));
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  it("送达失败时重试穿透（v0.4.2 兑底，最多3次尝试）", () => {
    spawnSyncMock.mockReturnValue({ status: 1, error: null }); // 模拟微信重连窗口内发送失败
    notify("echo ok", rec({ status: "failed" }));
    expect(spawnSyncMock).toHaveBeenCalledTimes(3);
  }, 15000); // 真实重试间隔 3s×2，放宽超时

  it("送达失败重试后成功则提前返回", () => {
    spawnSyncMock.mockReturnValueOnce({ status: 1, error: null }).mockReturnValueOnce({ status: 1, error: null }).mockReturnValue({ status: 0, error: null });
    notify("echo ok", rec({ status: "failed" }));
    expect(spawnSyncMock).toHaveBeenCalledTimes(3);
  }, 15000);
});
