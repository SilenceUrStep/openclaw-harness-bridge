import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskRecord } from "./ledger.js";

const spawnSyncMock = vi.fn();
const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

function rec(patch: Partial<TaskRecord> = {}): TaskRecord {
  return { id: "t1", harness: "opencode", status: "success", ...patch };
}

function childStub() {
  return { on: vi.fn(), unref: vi.fn() };
}

beforeEach(() => {
  spawnSyncMock.mockReset();
  spawnMock.mockReset();
  spawnSyncMock.mockReturnValue({ status: 0 });
});

const { buildWakeText, wakeAgent, resetWakeAgentState, extractTargetFromSessionKey } = await import("./wake-agent.js");

describe("wake-agent v0.4.12", () => {
  describe("buildWakeText 唤醒文本", () => {
    it("success：单行模板含任务号/harness/状态/退出码，且确认指示在最前", () => {
      const text = buildWakeText(rec({ id: "hb_x", harness: "dsh", status: "success", exitCode: 0 }));
      expect(text).toBe(
        "[harness-bridge] 任务 hb_x（dsh）状态 success，退出码 0。收到后请立即用 message 工具向用户发送一条简短确认（如「已自动唤醒，正在收口」），再用 harness_status 查收并执行后续动作（收口/汇报）。",
      );
      expect(text).toContain("立即用 message 工具");
      expect(text.indexOf("立即用 message 工具")).toBeLessThan(text.indexOf("harness_status"));
    });

    it("退出码缺失渲染为「无」", () => {
      const text = buildWakeText(rec({ exitCode: null }));
      expect(text).toContain("退出码 无");
    });

    it("failed：追加单行化失败原因", () => {
      const text = buildWakeText(rec({ status: "failed", exitCode: 1, failReason: "a\nb\r\nc" }));
      expect(text.endsWith("。 失败原因: a b c")).toBe(true);
    });

    it("failed：失败原因截断到 200 字", () => {
      const text = buildWakeText(rec({ status: "timeout", failReason: "x".repeat(300) }));
      const reason = text.split("失败原因: ")[1];
      expect(reason.length).toBe(201); // 200 字 + 省略号
    });

    it("success 态不追加失败原因", () => {
      const text = buildWakeText(rec({ status: "success", failReason: "stale" }));
      expect(text).not.toContain("失败原因");
    });

    it("failedReason 缺失时回退 error 字段", () => {
      const text = buildWakeText(rec({ status: "failed", error: "spawn ENOENT" }));
      expect(text).toContain("失败原因: spawn ENOENT");
    });

    it("ackTarget 有值：确认指示带显式 action/target/channel/accountId 与唤醒文案", () => {
      const text = buildWakeText(rec(), "wx_user1@im.wechat");
      expect(text).toContain(
        "（action=send，target=wx_user1@im.wechat，channel=openclaw-weixin，accountId=90e2cc4ed712-im-bot），消息内容如「✅ 已自动唤醒，正在收口」",
      );
      expect(text).not.toContain("如「已自动唤醒，正在收口」）");
    });

    it("ackTarget 缺省：保持原指示（不带 target 细节）", () => {
      const text = buildWakeText(rec());
      expect(text).toContain("（如「已自动唤醒，正在收口」）");
      expect(text).not.toContain("action=send");
    });
  });

  describe("extractTargetFromSessionKey", () => {
    it("微信 direct 格式：取 direct: 之后最后一段（含 @im.wechat）", () => {
      expect(extractTargetFromSessionKey("agent:main:openclaw-weixin:direct:wx_user1@im.wechat")).toBe(
        "wx_user1@im.wechat",
      );
    });

    it("无 direct: 段 / 空白 / 缺省：返回 undefined", () => {
      expect(extractTargetFromSessionKey("agent:main:weixin")).toBeUndefined();
      expect(extractTargetFromSessionKey("  ")).toBeUndefined();
      expect(extractTargetFromSessionKey(undefined)).toBeUndefined();
    });

    it("direct: 后为空：返回 undefined", () => {
      expect(extractTargetFromSessionKey("agent:main:openclaw-weixin:direct:")).toBeUndefined();
    });
  });

  describe("wakeAgent 注入", () => {
    beforeEach(() => resetWakeAgentState());

    it("未传 cfg / enabled=false：不探测不注入", () => {
      wakeAgent(rec());
      wakeAgent(rec(), { enabled: false });
      expect(spawnSyncMock).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it("enabled：CLI 探测后经 HB_WAKE_TEXT 注入（不传 session-key）", () => {
      const child = childStub();
      spawnMock.mockReturnValue(child);
      wakeAgent(rec({ id: "hb_ok", harness: "dsh", status: "success", exitCode: 0 }), { enabled: true });
      expect(spawnSyncMock).toHaveBeenCalledTimes(1);
      expect(spawnSyncMock.mock.calls[0][1]).toEqual(["-c", "command -v openclaw >/dev/null 2>&1"]);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [bin, argv, opts] = spawnMock.mock.calls[0];
      expect(bin).toBe("bash");
      expect(argv[0]).toBe("-c");
      expect(String(argv[1])).toContain("openclaw system event");
      expect(String(argv[1])).toContain("--mode now");
      expect(String(argv[1])).not.toContain("session-key");
      expect(opts.env.HB_WAKE_TEXT).toContain("任务 hb_ok（dsh）状态 success");
      expect(child.unref).toHaveBeenCalled();
    });

    it("sessionKey 非空：命令追加 --session-key 且经 HB_WAKE_SESSION 传值", () => {
      const child = childStub();
      spawnMock.mockReturnValue(child);
      wakeAgent(rec({ id: "hb_sk", harness: "dsh", status: "success", exitCode: 0 }), {
        enabled: true,
        sessionKey: "agent:main:openclaw-weixin:direct:wx_user1",
      });
      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [bin, argv, opts] = spawnMock.mock.calls[0];
      expect(bin).toBe("bash");
      expect(String(argv[1])).toContain('--session-key "$HB_WAKE_SESSION"');
      expect(opts.env.HB_WAKE_SESSION).toBe("agent:main:openclaw-weixin:direct:wx_user1");
      expect(opts.env.HB_WAKE_TEXT).toContain("任务 hb_sk（dsh）状态 success");
      // v0.4.12 direct 会话：确认指示自动携带显式 target 与 accountId
      expect(opts.env.HB_WAKE_TEXT).toContain("target=wx_user1，channel=openclaw-weixin，accountId=90e2cc4ed712-im-bot");
      expect(opts.env.HB_WAKE_TEXT).toContain("✅ 已自动唤醒，正在收口");
      expect(child.unref).toHaveBeenCalled();
    });

    it("sessionKey 缺省/空白：命令不含 --session-key 且不设 HB_WAKE_SESSION（向后兼容）", () => {
      spawnMock.mockReturnValue(childStub());
      wakeAgent(rec({ id: "hb_default" }), { enabled: true });
      expect(String(spawnMock.mock.calls[0][1][1])).not.toContain("session-key");
      expect(spawnMock.mock.calls[0][2].env.HB_WAKE_SESSION).toBeUndefined();
      spawnMock.mockClear();
      spawnMock.mockReturnValue(childStub());
      wakeAgent(rec({ id: "hb_blank" }), { enabled: true, sessionKey: "   " });
      expect(String(spawnMock.mock.calls[0][1][1])).not.toContain("session-key");
      expect(spawnMock.mock.calls[0][2].env.HB_WAKE_SESSION).toBeUndefined();
    });

    it("sessionKey 首尾空白：trim 后经 HB_WAKE_SESSION 传值", () => {
      spawnMock.mockReturnValue(childStub());
      wakeAgent(rec({ id: "hb_trim" }), { enabled: true, sessionKey: "  agent:main:weixin  " });
      expect(spawnMock.mock.calls[0][2].env.HB_WAKE_SESSION).toBe("agent:main:weixin");
    });

    it("sessionKey 非 direct 格式：唤醒文本不携带显式 target（保持原指示）", () => {
      spawnMock.mockReturnValue(childStub());
      wakeAgent(rec({ id: "hb_nodirect" }), { enabled: true, sessionKey: "agent:main:weixin" });
      const text = spawnMock.mock.calls[0][2].env.HB_WAKE_TEXT as string;
      expect(text).toContain("（如「已自动唤醒，正在收口」）");
      expect(text).not.toContain("action=send");
    });

    it("防重：同任务同终态只注入一次，不同终态各自注入", () => {
      spawnMock.mockReturnValue(childStub());
      const cfg = { enabled: true };
      wakeAgent(rec({ id: "hb_d" }), cfg);
      wakeAgent(rec({ id: "hb_d" }), cfg);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      wakeAgent(rec({ id: "hb_d", status: "failed", exitCode: 1, failReason: "x" }), cfg);
      expect(spawnMock).toHaveBeenCalledTimes(2);
    });

    it("CLI 缺失：跳过注入并 warning（含 taskId）", () => {
      spawnSyncMock.mockReturnValue({ status: 1 });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      wakeAgent(rec({ id: "hb_no_cli" }), { enabled: true });
      expect(spawnMock).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("hb_no_cli");
      warn.mockRestore();
    });

    it("spawn error 事件：fail-open 只打一行 warning（含 taskId）", () => {
      const child = childStub();
      spawnMock.mockReturnValue(child);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      wakeAgent(rec({ id: "hb_err" }), { enabled: true });
      const errorHandler = child.on.mock.calls.find(([evt]) => evt === "error")?.[1] as (e: Error) => void;
      expect(errorHandler).toBeTypeOf("function");
      errorHandler(new Error("boom"));
      expect(String(warn.mock.calls[0][0])).toContain("hb_err");
      warn.mockRestore();
    });

    it("探测异常：catch 兜底 warning（含 taskId）不抛出", () => {
      spawnSyncMock.mockImplementation(() => {
        throw new Error("probe exploded");
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(() => wakeAgent(rec({ id: "hb_throw" }), { enabled: true })).not.toThrow();
      expect(String(warn.mock.calls[0][0])).toContain("hb_throw");
      warn.mockRestore();
    });
  });

  describe("notify() 接线集成", () => {
    beforeEach(() => resetWakeAgentState());

    it("success 达门槛：notify 送达后注入唤醒；短任务不注入", async () => {
      const { notify, resetNotifyThrottle } = await import("./runner.js");
      resetNotifyThrottle();
      spawnMock.mockReturnValue(childStub());
      notify("echo ok", rec({ id: "w1", status: "success", durationMs: 400_000 }), undefined, { enabled: true });
      expect(spawnMock).toHaveBeenCalledTimes(1);
      spawnMock.mockClear();
      notify("echo ok", rec({ id: "w2", status: "success", durationMs: 1000 }), undefined, { enabled: true });
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it("failed 节流窗口内被抑制的不注入；窗口外注入一次", async () => {
      const { notify, resetNotifyThrottle } = await import("./runner.js");
      resetNotifyThrottle();
      spawnMock.mockReturnValue(childStub());
      notify("echo ok", rec({ id: "f1", harness: "claude", status: "failed", exitCode: 1 }), undefined, { enabled: true });
      expect(spawnMock).toHaveBeenCalledTimes(1);
      notify("echo ok", rec({ id: "f2", harness: "claude", status: "failed", exitCode: 1 }), undefined, { enabled: true });
      expect(spawnMock).toHaveBeenCalledTimes(1); // 窗口内抑制，同步不注入
    });

    it("不传 wakeCfg：零注入（既有 runner 测试安全）", async () => {
      const { notify, resetNotifyThrottle } = await import("./runner.js");
      resetNotifyThrottle();
      notify("echo ok", rec({ id: "n1", harness: "gemini", status: "failed", exitCode: 1 }));
      notify("echo ok", rec({ id: "n2", status: "success", durationMs: 400_000 }));
      expect(spawnMock).not.toHaveBeenCalled();
    });
  });
});
