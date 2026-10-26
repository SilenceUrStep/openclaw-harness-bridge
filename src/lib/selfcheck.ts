import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { listAdapters, resolveDataDir, type BridgeConfig } from "./adapters.js";
import type { Ledger } from "./ledger.js";
import { runTask } from "./runner.js";

/**
 * v0.4.3 宿主版本感知 + 升级自检：
 * - 启动时读取宿主版本号写入台账（steady id = hb_selfcheck）。
 * - 版本与上次记录不同（升级后首次启动）→ 自动跑冒烟自检：
 *   adapter 注册数、echo 派单往返、hooks 注册确认。
 * - 自检报告写台账并经 notifyCommand 推送（全绿/异常逐项列出）。
 * - 宿主版本探测全部走特性检测（api 字段 → env → 动态 import try/catch → unknown），旧版宿主回落。
 */

export const SELFCHECK_TASK_ID = "hb_selfcheck";

export interface HostVersionState {
  hostVersion: string;
  previousVersion?: string;
  updatedAt: string;
  lastSelfCheckAt?: string;
}

export function loadHostState(file: string): HostVersionState | null {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as HostVersionState;
    return raw && typeof raw.hostVersion === "string" ? raw : null;
  } catch {
    return null;
  }
}

export function saveHostState(file: string, state: HostVersionState): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    // 状态落盘失败不影响主流程（下次启动当作无基线）
  }
}

export interface HostVersionApi {
  openclawVersion?: unknown;
  version?: unknown;
  hostVersion?: unknown;
}

/** 宿主版本探测（特性检测优先级：api 字段 → OPENCLAW_VERSION → openclaw/package.json 动态 import → unknown） */
export async function detectHostVersion(api?: HostVersionApi): Promise<string> {
  for (const v of [api?.openclawVersion, api?.version, api?.hostVersion]) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  if (process.env.OPENCLAW_VERSION?.trim()) return process.env.OPENCLAW_VERSION.trim();
  try {
    // 特性检测：宿主是否导出 package.json subpath（旧版未导出 → 回落 unknown）
    const spec = "openclaw/package.json";
    const mod = (await import(spec)) as { version?: string };
    if (typeof mod?.version === "string" && mod.version.trim()) return mod.version.trim();
  } catch {
    // 旧版宿主未导出 package.json subpath → 回落
  }
  return "unknown";
}

export interface SelfCheckItem {
  name: string;
  pass: boolean;
  skipped?: boolean;
  detail: string;
}

export interface SelfCheckReport {
  hostVersion: string;
  previousVersion?: string;
  startedAt: string;
  durationMs: number;
  allGreen: boolean;
  items: SelfCheckItem[];
}

export interface SelfCheckOptions {
  cfg: BridgeConfig;
  hooks: string[];
  hostVersion: string;
  previousVersion?: string;
  ledger: Ledger;
  /** 测试注入；默认用内置 echo 派单往返 */
  runEcho?: (opts: SelfCheckOptions) => Promise<{ ok: boolean; detail: string }>;
}

async function echoRoundtripDefault(opts: SelfCheckOptions): Promise<{ ok: boolean; detail: string }> {
  const { cfg, ledger } = opts;
  const tasksDir = path.join(resolveDataDir(cfg), "tasks");
  try {
    mkdirSync(tasksDir, { recursive: true });
  } catch {
    // 已存在
  }
  const echo = listAdapters(cfg).find((a) => a.id === "echo");
  if (!echo) return { ok: false, detail: "无 echo adapter，无法验证派单往返" };
  const rec = runTask({
    adapter: echo,
    prompt: "v0.4.3 升级自检探针（可忽略）",
    wait: true,
    timeoutMs: 30_000,
    ledger,
    tasksDir,
  });
  return rec.status === "success"
    ? { ok: true, detail: `echo 派单往返 success（exit=${rec.exitCode ?? 0}，${rec.durationMs ?? 0}ms）` }
    : { ok: false, detail: `echo 派单往返 ${rec.status}（exit=${rec.exitCode ?? "?"}，${rec.error ?? rec.failReason ?? ""}）` };
}

/** 冒烟自检：adapter 注册数 / echo 派单往返 / hooks 注册确认 */
export async function runSelfCheck(opts: SelfCheckOptions): Promise<SelfCheckReport> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const items: SelfCheckItem[] = [];

  // 1) adapter 注册数
  let adapters: string[] = [];
  try {
    adapters = listAdapters(opts.cfg).map((a) => a.id);
  } catch (err) {
    items.push({ name: "adapter_registered", pass: false, detail: `adapter 枚举失败: ${(err as Error).message}` });
  }
  if (adapters.length > 0 || items.length === 0) {
    items.push({
      name: "adapter_registered",
      pass: adapters.length > 0,
      detail:
        adapters.length > 0
          ? `已注册 ${adapters.length} 个 adapter: ${adapters.join(", ")}`
          : "未注册任何 adapter（检查 adapters 目录与 adaptersDir 配置）",
    });
  }

  // 2) echo 派单往返
  const hasEcho = (() => {
    try {
      return listAdapters(opts.cfg).some((a) => a.id === "echo");
    } catch {
      return false;
    }
  })();
  if (!hasEcho) {
    items.push({ name: "echo_roundtrip", pass: false, skipped: true, detail: "无 echo adapter，跳过派单往返验证" });
  } else {
    const runEcho = opts.runEcho ?? echoRoundtripDefault;
    try {
      const r = await runEcho(opts);
      items.push({ name: "echo_roundtrip", pass: r.ok, detail: r.detail });
    } catch (err) {
      items.push({ name: "echo_roundtrip", pass: false, detail: `echo 派单异常: ${(err as Error).message}` });
    }
  }

  // 3) hooks 注册确认
  items.push(
    opts.hooks.length > 0
      ? { name: "hooks_registered", pass: true, detail: `已注册 hooks: ${opts.hooks.join(", ")}` }
      : { name: "hooks_registered", pass: false, skipped: true, detail: "无钩子启用（statusLineEnabled/turnPrepareEnabled 均关闭）" },
  );

  const allGreen = items.filter((i) => !i.skipped).every((i) => i.pass);
  return {
    hostVersion: opts.hostVersion,
    ...(opts.previousVersion ? { previousVersion: opts.previousVersion } : {}),
    startedAt,
    durationMs: Date.now() - t0,
    allGreen,
    items,
  };
}

/** 版本记录写台账（steady id = hb_selfcheck） */
export function recordHostVersion(
  ledger: Ledger,
  version: string,
  previous?: string,
): void {
  const changed = previous != null && previous !== "unknown" && previous !== version;
  try {
    ledger.addEvents(SELFCHECK_TASK_ID, [
      {
        type: "host_version",
        payload: { version, ...(previous ? { previous } : {}), changed },
        ts: new Date().toISOString(),
      },
    ]);
  } catch {
    // 台账失败不影响启动
  }
}

export function recordSelfCheckReport(ledger: Ledger, report: SelfCheckReport): void {
  try {
    ledger.addEvents(SELFCHECK_TASK_ID, [{ type: "selfcheck", payload: report, ts: new Date().toISOString() }]);
  } catch {
    // 台账失败不影响通知
  }
}

/** 自检报告推送（fire-and-forget）：全绿/异常逐项列出 */
export function pushSelfCheckNotify(notifyCommand: string | undefined, report: SelfCheckReport): void {
  if (!notifyCommand) return;
  const lines = report.items.map((i) => `${i.skipped ? "SKIP" : i.pass ? "PASS" : "FAIL"} ${i.name}: ${i.detail}`);
  try {
    const child = spawn("bash", ["-c", notifyCommand], {
      env: {
        ...process.env,
        HB_ALERT: "selfcheck",
        HB_SELFCHECK: report.allGreen ? "all_green" : "anomalies",
        HB_HOST_VERSION: report.hostVersion,
        HB_DETAIL: lines.join("\n").slice(0, 1200),
        HB_TIME: report.startedAt,
      },
      stdio: "ignore",
    });
    child.unref?.();
  } catch {
    // 推送失败不影响主流程
  }
}

/**
 * 启动时序：读宿主版本 → 与上次记录比对 → 记台账 → 升级则跑自检并推送。
 * 返回是否触发了自检（测试/调试用）。
 */
export async function startupVersionCheck(opts: {
  cfg: BridgeConfig;
  ledger: Ledger;
  hooks: string[];
  dataDir: string;
  api?: HostVersionApi;
  runSelfCheck?: typeof runSelfCheck;
}): Promise<{ hostVersion: string; selfCheckRan: boolean; report?: SelfCheckReport }> {
  const hostVersion = await detectHostVersion(opts.api);
  const stateFile = path.join(opts.dataDir, "host-state.json");
  const prev = loadHostState(stateFile);
  recordHostVersion(opts.ledger, hostVersion, prev?.hostVersion);
  saveHostState(stateFile, {
    hostVersion,
    ...(prev?.hostVersion ? { previousVersion: prev.hostVersion } : {}),
    updatedAt: new Date().toISOString(),
  });
  const isUpgrade = prev != null && prev.hostVersion !== "unknown" && prev.hostVersion !== hostVersion;
  if (!isUpgrade) return { hostVersion, selfCheckRan: false };
  const run = opts.runSelfCheck ?? runSelfCheck;
  const report = await run({
    cfg: opts.cfg,
    hooks: opts.hooks,
    hostVersion,
    previousVersion: prev.hostVersion,
    ledger: opts.ledger,
  });
  recordSelfCheckReport(opts.ledger, report);
  pushSelfCheckNotify(opts.cfg.notifyCommand, report);
  return { hostVersion, selfCheckRan: true, report };
}
