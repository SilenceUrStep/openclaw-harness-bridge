import type { Ledger, TaskRecord } from "./ledger.js";

/**
 * v0.4.3 失败自动重试 + 降级路由状态机。
 *
 * 语义：
 * - 任务失败后同 harness 自动重试（retryAttempts，默认 1）；failed/timeout/lost 均视为失败。
 * - 失败分类（classifyFailure）：仅"harness 不可用"类（探活失败/进程启动失败/超时）
 *   在重试耗尽后沿 fallback 链降级接管；业务性失败（任务本身报错）不降级只告警。
 * - 超时类失败（failReason 含 timeout）的告警/事件附建议「任务过大请拆分」。
 * - 全程写事件台账（retry / fallback 事件挂到对应任务记录上），可区分首次失败/重试/降级接管。
 */

export interface DispatchMeta {
  /** 首次派发（manual retryOf 的 fork 语义只在此生效） */
  isInitial: boolean;
  /** 自动重试：本次任务重试自哪个失败任务 */
  retryOf?: string;
  /** 降级接管：本次任务接管自哪个失败任务 */
  fallbackFrom?: string;
}

/** 失败分类：timeout=超时；unavailable=探活失败/进程启动失败等 harness 不可用；business=任务本身报错 */
export type FailureKind = "timeout" | "unavailable" | "business";

/** 超时类失败的告警建议 */
export const TIMEOUT_ADVICE = "任务过大请拆分";

/** harness 不可用类错误特征（探活失败/进程启动失败/连接失败） */
const UNAVAILABLE_PATTERN =
  /探活|探活失败|不可用|未注册|enoent|eacces|econnrefused|econnreset|enotfound|ehostunreach|etimedout|spawn|无法连接|connection (refused|reset)/i;

/** 失败分类：优先超时（failReason 含 timeout / status=timeout），再不可用类，其余视为业务失败 */
export function classifyFailure(rec?: TaskRecord | null, dispatchError?: string): FailureKind {
  const reason = rec ? (rec.failReason ?? rec.error ?? "") : (dispatchError ?? "");
  if (rec?.status === "timeout" || /timeout|timed out/i.test(reason)) return "timeout";
  if (dispatchError !== undefined || UNAVAILABLE_PATTERN.test(reason)) return "unavailable";
  return "business";
}

/** 失败处置建议：超时类建议拆分任务，其余无 */
export function failureAdvice(kind: FailureKind): string | undefined {
  return kind === "timeout" ? TIMEOUT_ADVICE : undefined;
}

export type DispatchResult = { ok: true; rec: TaskRecord } | { ok: false; error: string; fatal?: boolean };

export interface OrchestrationOutcome {
  /** 终态记录（wait 模式）或运行中快照（后台模式）；派发被拒时为 null */
  rec: TaskRecord | null;
  error?: string;
  /** 同 harness 已尝试次数（含首次） */
  attempts: number;
  fallbackUsed: boolean;
  retryOfChain: string[];
}

export interface OrchestrateDeps {
  ledger: Ledger;
  wait: boolean;
  initialHarness: string;
  retryAttempts: number;
  fallbackChain: string[];
  /** 可用性探测（降级决策时留痕台账；不改变分类决策） */
  probe: (harnessId: string) => Promise<{ available: boolean; detail: string }>;
  dispatch: (harnessId: string, meta: DispatchMeta) => Promise<DispatchResult>;
  /** 后台模式：注册终态回调（runner 的 onFinal 路由到这里） */
  setOnFinal?: (fn: (rec: TaskRecord) => void) => void;
}

const nowIso = (): string => new Date().toISOString();

function attachEvent(ledger: Ledger, taskId: string, type: string, payload: unknown): void {
  try {
    ledger.addEvents(taskId, [{ type, payload, ts: nowIso() }]);
  } catch {
    // 事件写入失败不影响任务链
  }
}

interface Decision {
  action: "retry" | "fallback" | "stop";
  nextHarness?: string;
  /** 待挂到下一次派发记录上的决策事件 */
  event?: { type: string; payload: unknown };
}

interface MachineState {
  harness: string;
  attempt: number;
  fallbackUsed: boolean;
  chain: string[];
  retryOfChain: string[];
}

function createMachine(deps: OrchestrateDeps): MachineState {
  return {
    harness: deps.initialHarness,
    attempt: 1,
    fallbackUsed: false,
    chain: [...deps.fallbackChain],
    retryOfChain: [],
  };
}

/** 失败处置决策：重试 → 分类判定 → 降级/停止（业务失败不降级只告警） */
async function decide(
  deps: OrchestrateDeps,
  state: MachineState,
  rec: TaskRecord | undefined,
  dispatchError?: string,
): Promise<Decision> {
  const kind = classifyFailure(rec, dispatchError);
  const reason = rec ? (rec.failReason ?? rec.error ?? rec.status) : (dispatchError ?? "未知错误");
  const advice = failureAdvice(kind);
  if (state.attempt <= deps.retryAttempts) {
    state.attempt += 1;
    return {
      action: "retry",
      event: {
        type: "retry",
        payload: {
          kind: "auto_retry",
          failureKind: kind,
          ...(advice ? { advice } : {}),
          attempt: state.attempt - 1,
          harness: state.harness,
          originTaskId: rec?.id ?? null,
          reason,
        },
      },
    };
  }
  if (kind === "business") {
    return {
      action: "stop",
      event: rec
        ? {
            type: "fallback",
            payload: {
              action: "skipped",
              reason: "业务性失败（任务本身报错），不降级只告警",
              detail: reason,
            },
          }
        : undefined,
    };
  }
  // timeout / unavailable：harness 不可用类，走降级链（探活结果仅作台账留痕，不改变决策）
  let probeDetail: string;
  try {
    const avail = await deps.probe(state.harness);
    probeDetail = `${avail.available ? "探活可用" : "探活不可用"}: ${avail.detail}`;
  } catch (err) {
    probeDetail = `探活异常: ${(err as Error).message}`;
  }
  const next = state.chain.shift();
  if (!next) {
    return {
      action: "stop",
      event: rec
        ? {
            type: "fallback",
            payload: {
              action: "exhausted",
              ...(advice ? { advice } : {}),
              reason: `harness 不可用（${kind}；${probeDetail}）且降级链为空`,
              detail: reason,
            },
          }
        : undefined,
    };
  }
  return {
    action: "fallback",
    nextHarness: next,
    event: {
      type: "fallback",
      payload: {
        action: "takeover",
        from: state.harness,
        to: next,
        failureKind: kind,
        ...(advice ? { advice } : {}),
        originTaskId: rec?.id ?? null,
        reason: `harness 不可用（${kind}；${probeDetail}）`,
      },
    },
  };
}

function applyMeta(
  deps: OrchestrateDeps,
  state: MachineState,
  rec: TaskRecord,
  meta: DispatchMeta,
  decisionEvent?: Decision["event"],
): TaskRecord {
  const patch: TaskRecord = { id: rec.id, harness: rec.harness, status: rec.status };
  if (meta.retryOf) {
    patch.retryOf = meta.retryOf;
    state.retryOfChain.push(meta.retryOf);
  }
  if (state.fallbackUsed || meta.fallbackFrom) patch.fallbackUsed = true;
  deps.ledger.append(patch);
  if (decisionEvent) attachEvent(deps.ledger, rec.id, decisionEvent.type, decisionEvent.payload);
  return { ...rec, ...patch };
}

/**
 * 重试/降级编排。
 * - wait=true：同步循环直到终态/致命拒绝，返回终态 outcome。
 * - wait=false：启动首个后台任务即返回快照；终态经 setOnFinal 注册的回调驱动后续重试/降级。
 */
export function orchestrate(deps: OrchestrateDeps): Promise<OrchestrationOutcome> {
  const state = createMachine(deps);
  const outcome = (rec: TaskRecord | null, error?: string): OrchestrationOutcome => ({
    rec,
    ...(error ? { error } : {}),
    attempts: state.attempt,
    fallbackUsed: state.fallbackUsed,
    retryOfChain: [...state.retryOfChain],
  });

  const launch = async (
    harness: string,
    meta: DispatchMeta,
    decisionEvent?: Decision["event"],
  ): Promise<DispatchResult> => {
    const res = await deps.dispatch(harness, meta);
    if (res.ok) return { ok: true, rec: applyMeta(deps, state, res.rec, meta, decisionEvent) };
    return res;
  };

  if (deps.wait) {
    return (async (): Promise<OrchestrationOutcome> => {
      let lastRec: TaskRecord | null = null;
      let lastError: string | undefined;
      let nextMeta: DispatchMeta = { isInitial: true };
      let pendingEvent: Decision["event"];
      for (;;) {
        const res = await launch(state.harness, nextMeta, pendingEvent);
        pendingEvent = undefined;
        nextMeta = { isInitial: false };
        if (res.ok) {
          lastRec = res.rec;
          lastError = undefined;
          if (res.rec.status === "success") return outcome(lastRec);
        } else {
          lastError = res.error;
          if (res.fatal) return outcome(lastRec, res.error);
        }
        const d = await decide(deps, state, res.ok ? res.rec : undefined, res.ok ? undefined : res.error);
        if (d.action === "stop") {
          if (d.event && lastRec) attachEvent(deps.ledger, lastRec.id, d.event.type, d.event.payload);
          return outcome(lastRec, lastError);
        }
        pendingEvent = d.event;
        if (d.action === "retry") {
          nextMeta = { isInitial: false, ...(lastRec ? { retryOf: lastRec.id } : {}) };
        } else {
          state.harness = d.nextHarness as string;
          state.fallbackUsed = true;
          nextMeta = { isInitial: false, ...(lastRec ? { fallbackFrom: lastRec.id } : {}) };
        }
      }
    })();
  }

  // 后台模式：终态回调驱动重试/降级（每个后台任务终态都会再次进入 handleTerminal）
  const handleTerminal = async (rec: TaskRecord): Promise<void> => {
    if (rec.status === "success") return;
    let originRec: TaskRecord = rec;
    let refusedError: string | undefined;
    for (;;) {
      const d = refusedError
        ? await decide(deps, state, undefined, refusedError)
        : await decide(deps, state, originRec);
      refusedError = undefined;
      if (d.action === "stop") {
        if (d.event) attachEvent(deps.ledger, originRec.id, d.event.type, d.event.payload);
        return;
      }
      const meta: DispatchMeta =
        d.action === "retry"
          ? { isInitial: false, retryOf: originRec.id }
          : { isInitial: false, fallbackFrom: originRec.id };
      if (d.action === "fallback") {
        state.harness = d.nextHarness as string;
        state.fallbackUsed = true;
      }
      const res = await launch(state.harness, meta, d.event).catch(
        (err): DispatchResult => ({ ok: false, error: (err as Error).message }),
      );
      if (res.ok) return; // 新任务终态经 onFinal 再次进入 handleTerminal
      refusedError = res.error; // 派发被拒：继续决策直到停止（attempt 单调递增、链单调缩短，有界）
    }
  };

  return (async (): Promise<OrchestrationOutcome> => {
    deps.setOnFinal?.((rec) => {
      void handleTerminal(rec).catch(() => undefined);
    });
    const res = await launch(state.harness, { isInitial: true }).catch(
      (err): DispatchResult => ({ ok: false, error: (err as Error).message }),
    );
    if (res.ok) return outcome(res.rec);
    // 首次派发被拒：同步走决策循环直到启动成功或停止
    let lastError: string = res.error;
    for (;;) {
      const d = await decide(deps, state, undefined, lastError);
      if (d.action === "stop") return outcome(null, lastError);
      if (d.action === "fallback") {
        state.harness = d.nextHarness as string;
        state.fallbackUsed = true;
      }
      const r2 = await launch(state.harness, { isInitial: false }, d.event).catch(
        (err): DispatchResult => ({ ok: false, error: (err as Error).message }),
      );
      if (r2.ok) return outcome(r2.rec);
      lastError = r2.error;
    }
  })();
}
