import type { Adapter, BridgeConfig, RoutingConfig } from "./adapters.js";

export type RouteReason = "explicit" | "rule" | "capability" | "default" | "default-unmatched";

export interface RouteDecision {
  harness: string;
  reason: RouteReason;
  taskType?: string;
  /** 命中的路由规则（用于规则级 fallback 链） */
  rule?: { taskType: string; harness: string; fallback?: string[] };
  /** 人类可读的路由依据（写入事件台账） */
  detail: string;
}

export interface RouteFailure {
  error: string;
}

/**
 * v0.4.3 能力路由解析。
 * 优先级：显式指定 harness > taskType 按 rules 覆盖 / capabilities 匹配 > routing.default。
 * taskType 无匹配时回落 default，决策理由（选了谁、为什么）由 detail 描述并记入事件台账。
 */
export function resolveRoute(
  cfg: BridgeConfig,
  adapters: Adapter[],
  input: { harness?: string; taskType?: string },
): RouteDecision | RouteFailure {
  const rc: RoutingConfig = cfg.routing ?? {};
  const harness = input.harness?.trim();
  if (harness) {
    return {
      harness,
      reason: "explicit",
      ...(input.taskType ? { taskType: input.taskType } : {}),
      detail: `显式指定 harness=${harness}`,
    };
  }
  const known = () => adapters.map((a) => a.id).join(", ");
  const defaultOf = rc.default?.trim();
  const fallbackDefault = (why: string): RouteDecision | RouteFailure => {
    if (!defaultOf) {
      return { error: `未指定 harness${input.taskType ? `（taskType=${input.taskType} 无匹配）` : ""} 且未配置 routing.default（可用: ${known()}）` };
    }
    if (!adapters.some((a) => a.id === defaultOf)) {
      return { error: `routing.default=${defaultOf} 未注册（可用: ${known()}）` };
    }
    return {
      harness: defaultOf,
      reason: input.taskType ? "default-unmatched" : "default",
      ...(input.taskType ? { taskType: input.taskType } : {}),
      detail: `${why}回落 routing.default=${defaultOf}`,
    };
  };

  const taskType = input.taskType?.trim();
  if (!taskType) return fallbackDefault("未指定 harness 与 taskType，");

  // 1) rules 覆盖（声明式，优先于 capabilities）
  const rule = (rc.rules ?? []).find((r) => r.taskType === taskType);
  if (rule) {
    if (adapters.some((a) => a.id === rule.harness)) {
      return {
        harness: rule.harness,
        reason: "rule",
        taskType,
        rule,
        detail: `taskType=${taskType} 命中路由规则 → ${rule.harness}`,
      };
    }
    // 规则目标未注册：跳过规则继续匹配，避免死路由
    return fallbackDefault(`taskType=${taskType} 的规则目标 ${rule.harness} 未注册，`);
  }

  // 2) capabilities 匹配（取声明顺序第一个）
  const cap = adapters.find((a) => (a.capabilities ?? []).includes(taskType));
  if (cap) {
    return {
      harness: cap.id,
      reason: "capability",
      taskType,
      detail: `taskType=${taskType} 按 capabilities 命中 ${cap.id}（capabilities: ${(cap.capabilities ?? []).join("/")}）`,
    };
  }

  // 3) 回落 default（决策记入台账）
  return fallbackDefault(`taskType=${taskType} 在 rules/capabilities 中均无匹配，`);
}

export interface ResolvedPolicy {
  retryAttempts: number;
  fallbackChain: string[];
}

/**
 * 失败重试与降级策略：规则级 fallback 覆盖全局 fallback 映射。
 * retryAttempts 默认 1（routing 段存在时）；未配置 routing 段 → 不重试不降级，行为与 0.4.2 完全一致。
 */
export function resolvePolicy(cfg: BridgeConfig, decision: RouteDecision): ResolvedPolicy {
  const rc: RoutingConfig | undefined = cfg.routing;
  if (!rc) return { retryAttempts: 0, fallbackChain: [] };
  const retryAttempts = Math.max(0, Math.floor(rc.retryAttempts ?? 1));
  const fallbackChain =
    decision.reason === "rule" && decision.rule?.fallback?.length
      ? [...decision.rule.fallback]
      : [...(rc.fallback?.[decision.harness] ?? [])];
  return { retryAttempts, fallbackChain };
}
