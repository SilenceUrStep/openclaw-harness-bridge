import type { Adapter } from "./adapters.js";

export type TransportKind = "cli" | "http" | "stdio-rpc";

export interface BasicAuth {
  type: "basic";
  usernameEnv: string;
  passwordEnv: string;
}

export interface HttpTransport {
  type: "http";
  baseUrl: string;
  auth?: BasicAuth;
  /** 每个请求携带的工作区路由头，值 = 任务 cwd */
  directoryHeader?: string;
  healthCheck?: {
    method?: string;
    path?: string;
    expectStatus?: number;
  };
  /** versionGate 声明时的版本读取端点，默认 /version */
  versionPath?: string;
  /** 探活失败时回落的目标 transport，默认 cli */
  fallback?: { type: "cli" };
}

export interface StdioRpcTransport {
  type: "stdio-rpc";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export type TransportConfig = HttpTransport | StdioRpcTransport | { type: "cli" };

export interface ResolvedTransport {
  kind: TransportKind;
  config?: TransportConfig;
}

/** 无 transport 字段的 v1 adapter = cli（RFC 9 兼容承诺） */
export function resolveTransport(adapter: Adapter): ResolvedTransport {
  const t = (adapter as Adapter & { transport?: TransportConfig }).transport;
  if (!t) return { kind: "cli" };
  if (t.type === "http" || t.type === "stdio-rpc" || t.type === "cli") {
    return { kind: t.type, config: t };
  }
  return { kind: "cli" };
}

export function cliFallbackOf(adapter: Adapter): boolean {
  const t = (adapter as Adapter & { transport?: TransportConfig }).transport;
  if (!t || t.type !== "http") return false;
  return (t as HttpTransport).fallback?.type !== undefined
    ? (t as HttpTransport).fallback?.type === "cli"
    : true;
}

function basicAuthHeader(auth: BasicAuth): string {
  const username = process.env[auth.usernameEnv] ?? "";
  const password = process.env[auth.passwordEnv] ?? "";
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

/** 组装 http transport 的请求头（Basic Auth + directory 路由头） */
export function buildHttpHeaders(
  transport: HttpTransport,
  cwd?: string,
  extra?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = { ...(extra ?? {}) };
  if (transport.auth?.type === "basic") {
    headers.Authorization = basicAuthHeader(transport.auth);
  }
  if (transport.directoryHeader && cwd) {
    headers[transport.directoryHeader] = cwd;
  }
  return headers;
}

export interface HttpProbeResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/** adapter schema versionGate（http / stdio-rpc transport 通用） */
export interface VersionGate {
  min?: string;
  max?: string;
}

export interface VersionGateResult {
  ok: boolean;
  version?: string;
  detail?: string;
}

interface Semver {
  major: number;
  minor: number;
  patch: number;
  pre?: string;
}

/** 解析 semver（容忍前缀噪声，如 "dsh 0.2.1-alpha.3"；x/* 通配在比较侧处理） */
export function parseSemver(text: string): Semver | undefined {
  const m = /(\d+|[xX*])\.(\d+|[xX*])\.(\d+|[xX*])(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?/.exec(text.trim());
  if (!m) return undefined;
  return {
    major: m[1].match(/^\d+$/) ? Number(m[1]) : -1,
    minor: m[2].match(/^\d+$/) ? Number(m[2]) : -1,
    patch: m[3].match(/^\d+$/) ? Number(m[3]) : -1,
    pre: m[4],
  };
}

function cmpInt(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cmpPre(a?: string, b?: string): number {
  if (!a && !b) return 0;
  if (!a) return 1; // release > prerelease
  if (!b) return -1;
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const c = cmpInt(Number(x), Number(y));
      if (c !== 0) return c;
    } else if (nx !== ny) {
      return nx ? -1 : 1; // 数字段 < 字母段
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** -1 = a<b, 0 = a==b, 1 = a>b；b 分量为 x/* 时视为通配（相等） */
export function compareSemver(a: Semver, b: Semver): number {
  for (const [ka, kb] of [
    [a.major, b.major],
    [a.minor, b.minor],
    [a.patch, b.patch],
  ] as const) {
    if (kb === -1) continue; // x/* 通配
    const c = cmpInt(ka, kb);
    if (c !== 0) return c;
  }
  return cmpPre(a.pre, b.pre);
}

/**
 * 版本门禁：version 落在 [min, max] 内放行，越界显性拒绝（不静默尝试）。
 * max 通配（如 "0.3.x"）= 0.3 段内任意 patch。版本不可解析也拒绝。
 */
export function checkVersionGate(version: string | undefined, gate: VersionGate): VersionGateResult {
  if (!gate.min && !gate.max) return { ok: true, version };
  if (!version) {
    return { ok: false, detail: `版本不可读（gate min=${gate.min ?? "-"} max=${gate.max ?? "-"}）` };
  }
  const v = parseSemver(version);
  if (!v) return { ok: false, version, detail: `版本格式不可解析: ${version}` };
  if (gate.min) {
    const min = parseSemver(gate.min);
    if (!min) return { ok: false, version, detail: `versionGate.min 非法: ${gate.min}` };
    if (compareSemver(v, min) < 0) {
      // 精确同版本锁语义：min 版本自身的 prerelease（如 min=0.2.1 vs 0.2.1-alpha.3）放行
      const sameBase = v.major === min.major && v.minor === min.minor && v.patch === min.patch;
      if (!(sameBase && v.pre)) {
        return { ok: false, version, detail: `版本 ${version} 低于最小支持 ${gate.min}` };
      }
    }
  }
  if (gate.max) {
    const max = parseSemver(gate.max);
    if (!max) return { ok: false, version, detail: `versionGate.max 非法: ${gate.max}` };
    if (compareSemver(v, max) > 0) {
      return { ok: false, version, detail: `版本 ${version} 超过最大支持 ${gate.max}` };
    }
  }
  return { ok: true, version };
}

/**
 * http 型 adapter 的版本读取（v0.4.4 多端点适配）：
 * 显式 transport.versionPath 优先；否则先试 GET /global/health（新 SDK，{"healthy":true,"version":"1.18.x"}），
 * 再回退 /version（旧 SDK）。全部失败返回 undefined（调用方显性提示探测不可用）。
 */
export async function fetchHttpVersion(
  transport: HttpTransport,
  opts?: { timeoutMs?: number; cwd?: string },
): Promise<string | undefined> {
  const candidates = transport.versionPath
    ? [transport.versionPath]
    : ["/global/health", "/version"];
  for (const path of candidates) {
    const v = await fetchHttpVersionAt(transport, path, opts);
    if (v !== undefined) return v;
  }
  return undefined;
}

async function fetchHttpVersionAt(
  transport: HttpTransport,
  path: string,
  opts?: { timeoutMs?: number; cwd?: string },
): Promise<string | undefined> {
  const url = `${transport.baseUrl.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts?.timeoutMs ?? 3000);
    try {
      const res = await fetch(url, { headers: buildHttpHeaders(transport, opts?.cwd), signal: ac.signal });
      if (!res.ok) return undefined;
      const text = (await res.text()).trim();
      if (!text) return undefined;
      try {
        const json = JSON.parse(text) as Record<string, unknown>;
        if (typeof json.version === "string") return json.version;
        if (typeof json.data === "string") return json.data;
      } catch {
        // 纯文本版本号：仅当形似版本才采信（防 SPA fallback HTML 被当版本，v0.4.4）
        if (parseSemver(text)) return text;
        return undefined;
      }
      return text;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return undefined;
  }
}

/** http 探活：healthCheck 配置（缺省 GET / 期望 2xx），超时 3s */
export async function probeHttpHealth(
  transport: HttpTransport,
  opts?: { timeoutMs?: number; cwd?: string },
): Promise<HttpProbeResult> {
  const hc = transport.healthCheck;
  const method = hc?.method ?? "GET";
  const path = hc?.path ?? "/";
  const expect = hc?.expectStatus;
  const timeoutMs = opts?.timeoutMs ?? 3000;
  const url = `${transport.baseUrl.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: buildHttpHeaders(transport, opts?.cwd, { accept: "application/json" }),
        signal: ac.signal,
      });
      const ok = expect != null ? res.status === expect : res.status >= 200 && res.status < 300;
      return { ok, status: res.status, error: ok ? undefined : `HTTP ${res.status}` };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
