import { buildHttpHeaders, type HttpTransport } from "./transport.js";

/**
 * v0.4.12 权限 ask 人工批准通道（OpenCode http transport 专用）。
 *
 * OpenCode 侧端点（v1.18.10 确认，与 /session /event 同根路径、同 BasicAuth）：
 * - GET  /permission                      → Schema.Array(PermissionV1.Request)，返回实例全部挂起权限（跨 session，需自行过滤）
 * - POST /permission/{requestID}/reply    → payload {reply: "once"|"always"|"reject", message?}，成功返回 true
 *
 * PermissionV1.Request 结构：{ id(per_ 前缀), sessionID(ses_ 前缀), permission(权限名如 bash/edit),
 * patterns: string[], metadata: Record<string,unknown>（edit→{filepath,diff}、doom_loop→{tool,input}）, always: string[] }
 */

/** 默认挂起超时毫秒：30 分钟（超时自动 reject，防止任务永久悬挂） */
export const DEFAULT_PERMISSION_ASK_TIMEOUT_MS = 1_800_000;

export interface PermissionAskConfig {
  /** 默认 true，false 关闭探测/告警/守护全链路 */
  enabled?: boolean;
  /** 挂起超时毫秒，默认 1800000（30 分钟），超时自动 POST reject 并推 permission_timeout 告警 */
  timeoutMs?: number;
}

/** 解析 permissionAsk 配置：未配置字段回落默认值（enabled 默认开，timeoutMs 默认 30 分钟） */
export function resolvePermissionAskConfig(cfg?: PermissionAskConfig): Required<PermissionAskConfig> {
  return {
    enabled: cfg?.enabled !== false,
    timeoutMs: typeof cfg?.timeoutMs === "number" && cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_PERMISSION_ASK_TIMEOUT_MS,
  };
}

/** GET /permission 返回的单条挂起权限请求（经规范化） */
export interface PendingPermissionRequest {
  /** requestID（per_ 前缀，reply 端点用它定位） */
  requestId: string;
  sessionId: string;
  /** 权限名（bash/edit/doom_loop...） */
  permission: string;
  patterns: string[];
  /** 工具调用细节（如 {tool, input} / {filepath, diff}），原样保留 */
  metadata?: Record<string, unknown>;
  /** 已批准的 always 规则（服务端结构，透传展示） */
  always?: string[];
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** 服务端原始请求 → 规范化结构；缺 id/sessionID 的脏数据丢弃（返回 null） */
function normalizePermissionRequest(raw: unknown): PendingPermissionRequest | null {
  const r = asRecord(raw);
  const requestId = typeof r.id === "string" ? r.id : undefined;
  const sessionId = typeof r.sessionID === "string" ? r.sessionID : undefined;
  if (!requestId || !sessionId) return null;
  return {
    requestId,
    sessionId,
    permission: typeof r.permission === "string" ? r.permission : "unknown",
    patterns: asStringArray(r.patterns),
    metadata: Object.keys(asRecord(r.metadata)).length > 0 ? asRecord(r.metadata) : undefined,
    always: asStringArray(r.always),
  };
}

export class PermissionHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * 拉取 OpenCode 实例挂起权限（可按 sessionId 过滤）。HTTP 非 2xx 或网络失败直接抛错，
 * 由调用方决定降级策略（runner 全链路 fail-open；harness_permission 工具转 error 返回体）。
 */
export async function fetchPendingPermissions(
  transport: HttpTransport,
  opts?: { sessionId?: string; cwd?: string; signal?: AbortSignal },
): Promise<PendingPermissionRequest[]> {
  const baseUrl = transport.baseUrl.replace(/\/$/, "");
  const res = await fetch(`${baseUrl}/permission`, {
    headers: buildHttpHeaders(transport, opts?.cwd),
    signal: opts?.signal,
  });
  if (!res.ok) {
    throw new PermissionHttpError(res.status, `GET /permission → HTTP ${res.status}`);
  }
  const data = (await res.json()) as unknown;
  const list = Array.isArray(data) ? data : [];
  const normalized = list
    .map(normalizePermissionRequest)
    .filter((x): x is PendingPermissionRequest => x !== null);
  const sessionId = opts?.sessionId;
  return sessionId ? normalized.filter((p) => p.sessionId === sessionId) : normalized;
}

/**
 * v0.4.12 可复用探测方法：按 sessionId 列挂起权限，fail-open —— 任何失败（网络/HTTP/解析）
 * 返回空数组，绝不影响调用方主流程（runner 等待路径与工具共用）。
 */
export async function listPendingPermissions(
  transport: HttpTransport,
  sessionId?: string,
  cwd?: string,
): Promise<PendingPermissionRequest[]> {
  try {
    return await fetchPendingPermissions(transport, { sessionId, cwd });
  } catch {
    return [];
  }
}

export type PermissionReply = "once" | "always" | "reject";

const REPLY_VALUES: readonly PermissionReply[] = ["once", "always", "reject"];

export function isPermissionReply(v: unknown): v is PermissionReply {
  return typeof v === "string" && (REPLY_VALUES as readonly string[]).includes(v);
}

/**
 * 提交权限审批（人工批准通道核心动作）：POST /permission/{requestID}/reply。
 * once=仅本次放行 / always=永久放行该规则 / reject=拒绝。失败抛错（HTTP 状态入 message）。
 */
export async function replyPermission(
  transport: HttpTransport,
  requestId: string,
  reply: PermissionReply,
  opts?: { cwd?: string; message?: string; signal?: AbortSignal },
): Promise<void> {
  const baseUrl = transport.baseUrl.replace(/\/$/, "");
  const res = await fetch(`${baseUrl}/permission/${encodeURIComponent(requestId)}/reply`, {
    method: "POST",
    headers: buildHttpHeaders(transport, opts?.cwd, { "content-type": "application/json" }),
    body: JSON.stringify({ reply, ...(opts?.message ? { message: opts.message } : {}) }),
    signal: opts?.signal,
  });
  if (!res.ok) {
    const hint = res.status === 404 ? "（权限请求不存在或已处理）" : "";
    throw new PermissionHttpError(res.status, `POST /permission/${requestId}/reply → HTTP ${res.status}${hint}`);
  }
}

/**
 * 权限详情摘要（告警 HB_PERMISSION_DETAIL 与工具 list 行共用）：
 * 权限名 + patterns + metadata JSON；metadata 截断防 env/输出膨胀。
 */
export function describePermission(p: PendingPermissionRequest, maxMetadataChars = 500): string {
  const parts: string[] = [`权限=${p.permission}`];
  if (p.patterns.length > 0) parts.push(`patterns=[${p.patterns.join(", ")}]`);
  if (p.metadata && Object.keys(p.metadata).length > 0) {
    let meta = "";
    try {
      meta = JSON.stringify(p.metadata);
    } catch {
      meta = String(p.metadata);
    }
    if (meta.length > maxMetadataChars) meta = `${meta.slice(0, maxMetadataChars)}…`;
    parts.push(`detail=${meta}`);
  }
  return parts.join(" ");
}
