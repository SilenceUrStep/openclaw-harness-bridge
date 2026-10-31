import { spawn, spawnSync } from "node:child_process";
import type { TaskRecord } from "./ledger.js";

/**
 * v0.4.12 任务完成唤醒 agent（openclaw system event 注入）配置。
 * 终态通知送达后追加一条单行唤醒文本，提示编排 agent 先用 message 工具向用户发确认、再用 harness_status 查收并收口。
 */
export interface WakeAgentOptions {
  /** 是否启用（默认 true；接线层对未配置项兜底为开启） */
  enabled?: boolean;
  /** openclaw 注入的探测/执行超时（毫秒，默认 15000） */
  timeoutMs?: number;
  /** v0.4.12 注入目标会话 key（如 agent:main:openclaw-weixin:direct:xxx）；缺省不传 = openclaw 默认 main session，保持向后兼容 */
  sessionKey?: string;
}

/** v0.4.12 默认注入超时：与既有通知通道 timeout 保持一致 */
export const DEFAULT_WAKE_TIMEOUT_MS = 15000;

/** v0.4.12 失败原因最长保留字符数（超出截断） */
const FAIL_REASON_MAX_CHARS = 200;

/** v0.4.12 同任务同终态只注入一次（id + status 维度防重） */
const wokenKeys = new Set<string>();

/** v0.4.12 清空防重集合（仅供测试使用） */
export function resetWakeAgentState(): void {
  wokenKeys.clear();
}

/** v0.4.12 失败原因单行化（折叠所有空白）并截断到 200 字 */
function sanitizeFailReason(reason: string): string {
  const oneLine = reason.replace(/\s+/g, " ").trim();
  return oneLine.length > FAIL_REASON_MAX_CHARS ? `${oneLine.slice(0, FAIL_REASON_MAX_CHARS)}…` : oneLine;
}

/**
 * v0.4.12 从 sessionKey 提取确认消息投递 target：direct 会话取最后一段
 * （agent:main:openclaw-weixin:direct:<id> → <id>）；无 direct: 段返回 undefined。
 */
export function extractTargetFromSessionKey(sessionKey?: string): string | undefined {
  const key = sessionKey?.trim();
  if (!key) return undefined;
  const idx = key.lastIndexOf("direct:");
  if (idx === -1) return undefined;
  const target = key.slice(idx + "direct:".length).trim();
  return target || undefined;
}

/**
 * v0.4.12 构造单行唤醒文本（成功/失败共用模板，失败态追加失败原因）。
 * ackTarget 有值时确认指示带显式 message 参数（accountId 与 tools/hb_notify.sh 的 HB_NOTIFY_TARGET 同源）。
 */
export function buildWakeText(
  rec: Pick<TaskRecord, "id" | "harness" | "status" | "exitCode" | "failReason" | "error">,
  ackTarget?: string,
): string {
  const exit = typeof rec.exitCode === "number" ? String(rec.exitCode) : "无";
  const ack = ackTarget
    ? `收到后请立即用 message 工具向用户发送一条简短确认（action=send，target=${ackTarget}，channel=openclaw-weixin，accountId=90e2cc4ed712-im-bot），消息内容如「✅ 已自动唤醒，正在收口」`
    : "收到后请立即用 message 工具向用户发送一条简短确认（如「已自动唤醒，正在收口」）";
  let text = `[harness-bridge] 任务 ${rec.id}（${rec.harness}）状态 ${rec.status}，退出码 ${exit}。${ack}，再用 harness_status 查收并执行后续动作（收口/汇报）。`;
  const reason = rec.failReason ?? rec.error;
  if (rec.status !== "success" && reason) {
    text += ` 失败原因: ${sanitizeFailReason(reason)}`;
  }
  return text;
}

/**
 * v0.4.12 任务终态后通过 `openclaw system event --text <单行文本> --mode now` 唤醒编排 agent；
 * 配置 sessionKey 时追加 `--session-key` 定向注入用户可见会话，缺省走 openclaw 默认 main session。
 * fire-and-forget：spawn 后不等待结果；任何异常只打一行 warning（fail-open，不影响任务收尾）。
 * 未传 cfg 或 enabled===false 时直接返回 —— 原语层默认关闭，由 index.ts 接线层兜底开启。
 */
export function wakeAgent(rec: TaskRecord, cfg?: WakeAgentOptions): void {
  if (!cfg || cfg.enabled === false) return;
  const key = `${rec.id}:${rec.status}`;
  if (wokenKeys.has(key)) return;
  wokenKeys.add(key);
  // v0.4.12 direct 会话提取显式 target，让唤醒 turn 的确认消息能直接发出（system event run 无入站消息上下文）
  const sessionKey = cfg.sessionKey?.trim();
  const text = buildWakeText(rec, extractTargetFromSessionKey(sessionKey));
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_WAKE_TIMEOUT_MS;
  try {
    // CLI 探测：command -v openclaw，缺失则提示后跳过（不算失败重试，防重已生效）
    const probe = spawnSync("bash", ["-c", "command -v openclaw >/dev/null 2>&1"], { timeout: timeoutMs });
    if (probe.error || probe.status !== 0) {
      console.warn(`[harness-bridge] wakeAgent: openclaw CLI 不可用，跳过唤醒（taskId=${rec.id}）`);
      return;
    }
    // 文本经 HB_WAKE_TEXT 环境变量传入，规避引号/注入问题；v0.4.12 sessionKey 非空时经 HB_WAKE_SESSION 追加 --session-key 定向唤醒用户可见会话，缺省保持原命令（走默认 main session）
    const command = sessionKey
      ? 'exec openclaw system event --text "$HB_WAKE_TEXT" --mode now --session-key "$HB_WAKE_SESSION"'
      : 'exec openclaw system event --text "$HB_WAKE_TEXT" --mode now';
    const child = spawn("bash", ["-c", command], {
      env: { ...process.env, HB_WAKE_TEXT: text, ...(sessionKey ? { HB_WAKE_SESSION: sessionKey } : {}) },
      stdio: "ignore",
      detached: true,
    });
    child.on("error", () => {
      console.warn(`[harness-bridge] wakeAgent: openclaw 注入失败（taskId=${rec.id}）`);
    });
    child.unref();
  } catch (e) {
    console.warn(`[harness-bridge] wakeAgent: 唤醒异常（taskId=${rec.id}）：${e instanceof Error ? e.message : String(e)}`);
  }
}
