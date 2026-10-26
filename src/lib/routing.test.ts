import { describe, expect, it } from "vitest";
import type { Adapter, BridgeConfig } from "./adapters.js";
import { resolvePolicy, resolveRoute } from "./routing.js";

const adapters = [
  { id: "opencode", binary: "opencode", capabilities: ["coding"], delegate: { run: ["x"] } },
  { id: "dsh", binary: "dsh", capabilities: ["general", "analysis", "search"], delegate: { run: ["x"] } },
  { id: "echo", binary: "echo", delegate: { run: ["x"] } },
] as unknown as Adapter[];

describe("resolveRoute（v0.4.3 能力路由）", () => {
  it("显式 harness 优先于 taskType 与 routing 配置", () => {
    const cfg: BridgeConfig = { routing: { default: "echo", rules: [{ taskType: "coding", harness: "dsh" }] } };
    const r = resolveRoute(cfg, adapters, { harness: "opencode", taskType: "analysis" });
    expect("error" in r && false).toBe(false);
    if ("error" in r) throw new Error(r.error);
    expect(r.harness).toBe("opencode");
    expect(r.reason).toBe("explicit");
  });

  it("taskType 按 capabilities 匹配（声明顺序第一个）", () => {
    const r = resolveRoute({}, adapters, { taskType: "analysis" });
    if ("error" in r) throw new Error(r.error);
    expect(r.harness).toBe("dsh");
    expect(r.reason).toBe("capability");
    expect(r.detail).toContain("capabilities");
  });

  it("rules 覆盖 capabilities 匹配", () => {
    const cfg: BridgeConfig = { routing: { rules: [{ taskType: "coding", harness: "dsh" }] } };
    const r = resolveRoute(cfg, adapters, { taskType: "coding" });
    if ("error" in r) throw new Error(r.error);
    expect(r.harness).toBe("dsh");
    expect(r.reason).toBe("rule");
  });

  it("taskType 无匹配回落 default 并标注原因", () => {
    const cfg: BridgeConfig = { routing: { default: "echo" } };
    const r = resolveRoute(cfg, adapters, { taskType: "no-such-type" });
    if ("error" in r) throw new Error(r.error);
    expect(r.harness).toBe("echo");
    expect(r.reason).toBe("default-unmatched");
    expect(r.detail).toContain("无匹配");
  });

  it("未指定 taskType 时直接走 default", () => {
    const cfg: BridgeConfig = { routing: { default: "echo" } };
    const r = resolveRoute(cfg, adapters, {});
    if ("error" in r) throw new Error(r.error);
    expect(r.harness).toBe("echo");
    expect(r.reason).toBe("default");
  });

  it("无 harness/taskType 且未配置 default → 报错并列出可用 harness", () => {
    const r = resolveRoute({}, adapters, {});
    expect("error" in r).toBe(true);
    if (!("error" in r)) return;
    expect(r.error).toContain("routing.default");
    expect(r.error).toContain("opencode, dsh, echo");
  });

  it("规则目标未注册 → 跳过规则回落 default", () => {
    const cfg: BridgeConfig = { routing: { default: "echo", rules: [{ taskType: "coding", harness: "ghost" }] } };
    const r = resolveRoute(cfg, adapters, { taskType: "coding" });
    if ("error" in r) throw new Error(r.error);
    expect(r.harness).toBe("echo");
    expect(r.detail).toContain("ghost 未注册");
  });

  it("routing.default 未注册 → 报错", () => {
    const cfg: BridgeConfig = { routing: { default: "ghost" } };
    const r = resolveRoute(cfg, adapters, {});
    expect("error" in r).toBe(true);
  });
});

describe("resolvePolicy（v0.4.3 重试/降级策略）", () => {
  it("默认 retryAttempts=1，fallback 按目标 harness 查全局映射", () => {
    const cfg: BridgeConfig = { routing: { fallback: { opencode: ["dsh"] } } };
    const r = resolveRoute(cfg, adapters, { harness: "opencode" });
    if ("error" in r) throw new Error(r.error);
    const p = resolvePolicy(cfg, r);
    expect(p.retryAttempts).toBe(1);
    expect(p.fallbackChain).toEqual(["dsh"]);
  });

  it("retryAttempts 可配置（0 = 关闭重试）", () => {
    const cfg: BridgeConfig = { routing: { retryAttempts: 0 } };
    const r = resolveRoute(cfg, adapters, { harness: "dsh" });
    if ("error" in r) throw new Error(r.error);
    expect(resolvePolicy(cfg, r).retryAttempts).toBe(0);
  });

  it("规则级 fallback 覆盖全局映射", () => {
    const cfg: BridgeConfig = {
      routing: {
        fallback: { dsh: ["echo"] },
        rules: [{ taskType: "coding", harness: "dsh", fallback: ["opencode"] }],
      },
    };
    const r = resolveRoute(cfg, adapters, { taskType: "coding" });
    if ("error" in r) throw new Error(r.error);
    expect(resolvePolicy(cfg, r).fallbackChain).toEqual(["opencode"]);
  });
});
