import { statSync } from "node:fs";
import path from "node:path";
import type { BridgeConfig } from "./adapters.js";
import { resolveDataDir } from "./adapters.js";
import { diagnoseBinary } from "./diagnose.js";
import { openDriverSync } from "./ledger.js";
import { probeAllAdapters, type AdapterStatus } from "./health.js";
import { detectHostVersion, type HostVersionApi } from "./selfcheck.js";
import { listWorktreeTaskIds, worktreeDir } from "./worktree.js";

/**
 * v0.4.7 一键体检（harness_doctor）：检查项收口成一个工具，输出人话体检报告——
 * 每项一行结论 + ✅/⚠️/❌ 分级 + 异常项修复建议：
 *   1. adapter 探活健康（复用 harness_list 的 probeAllAdapters，一轮探测共用）
 *   2. 宿主与 binary 版本探测
 *   3. binary 诊断（PATH、悬空符号链接线索，同 harness_list healthDetail 的 diagnoseBinary）
 *   4. 台账健康（SQLite 完整性 / WAL 大小 / 任务状态统计）
 *   5. worktree 残留（v0.4.8：已结束任务遗留的 worktree 目录清单，供人工清理）
 *   6. 配置校验（全部配置键当前值 vs 默认值对比；全部键均有默认值，不配置也能跑）
 * 只做只读探测，绝不执行任何 harness binary；单项检查失败不拖垮整个报告（fail-open）。
 */

export type DoctorLevel = "ok" | "warn" | "error";

export interface DoctorCheck {
  name: string;
  level: DoctorLevel;
  /** 一行结论（人话） */
  summary: string;
  /** 异常项的修复建议 / 附加线索 */
  detail?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  /** 无 error 级异常 */
  allOk: boolean;
  /** 连 warn 也没有（完全干净） */
  fullyHealthy: boolean;
}

export const DOCTOR_ICONS: Record<DoctorLevel, string> = {
  ok: "✅",
  warn: "⚠️",
  error: "❌",
};

/** 报告渲染：每项一行（图标 + 名称 + 结论），异常项缩进附建议 */
export function renderDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  for (const c of report.checks) {
    lines.push(`${DOCTOR_ICONS[c.level]} ${c.name}：${c.summary}`);
    if (c.detail) {
      for (const d of c.detail.split("\n")) lines.push(`   ↳ ${d}`);
    }
  }
  lines.push(
    report.allOk
      ? report.fullyHealthy
        ? "体检结论：全部通过 ✅"
        : "体检结论：可用，存在告警项 ⚠️"
      : "体检结论：存在异常项，请按建议处理 ❌",
  );
  return lines.join("\n");
}

/* ---------------- 检查 1-3：adapter 健康 / 版本 / binary 诊断（共用一轮探测） ---------------- */

function adapterChecks(results: AdapterStatus[]): DoctorCheck[] {
  if (results.length === 0) {
    return [
      {
        name: "adapter 探活",
        level: "error",
        summary: "未注册任何 adapter（内置 + 用户目录均无可用 adapter 文件）",
        detail: "检查插件数据目录 adapters/ 与 adaptersDir 配置；内置 adapter 随包提供",
      },
      {
        name: "版本探测",
        level: "warn",
        summary: "无 adapter 可探测版本",
      },
      {
        name: "binary 诊断",
        level: "warn",
        summary: "无 adapter 可诊断",
      },
    ];
  }
  const healthy = results.filter((r) => r.healthy);
  const unhealthy = results.filter((r) => !r.healthy);
  const knownVersions = results.filter((r) => r.version != null && r.version.trim() !== "");
  const notInstalled = results.filter((r) => !r.installed);

  // 1) adapter 探活健康
  const healthCheck: DoctorCheck = {
    name: "adapter 探活",
    level: unhealthy.length === 0 ? "ok" : "error",
    summary:
      unhealthy.length === 0
        ? `${healthy.length}/${results.length} 个 adapter 健康`
        : `${healthy.length}/${results.length} 个 adapter 健康，异常: ${unhealthy.map((r) => r.id).join(", ")}`,
    detail:
      unhealthy.length === 0
        ? undefined
        : unhealthy
            .map((r) => {
              const fix =
                r.transport === "http"
                  ? "检查 serve 进程是否在运行、baseUrl/认证是否正确"
                  : r.installed
                    ? "版本门禁未通过：升级/降级 binary 到 adapter 声明的版本范围"
                    : "安装 binary 或修正 adapter 的 binary/PATH 配置";
              return `${r.id}: ${r.healthDetail}；建议: ${fix}`;
            })
            .join("\n"),
  };

  // 2) 宿主与 binary 版本
  const versionCheck: DoctorCheck = {
    name: "版本探测",
    level: "ok",
    summary: "",
    detail: undefined,
  };
  const unknownVersions = results.filter(
    (r) => r.version == null || r.version.trim() === "" || r.version.startsWith("error:"),
  );
  if (unknownVersions.length === 0) {
    versionCheck.summary = `各 adapter 版本已知（${knownVersions
      .map((r) => `${r.id} ${r.version}`)
      .join(", ")}）`;
  } else {
    versionCheck.level = "warn";
    versionCheck.summary = `${knownVersions.length}/${results.length} 个 adapter 版本已知，${unknownVersions
      .map((r) => r.id)
      .join(", ")} 版本未知`;
    versionCheck.detail = unknownVersions
      .map((r) => `${r.id}: ${r.healthDetail}；建议: 确认 binary 可用后重试，或忽略（http 型依赖 SDK 端点提供版本）`)
      .join("\n");
  }

  // 3) binary 诊断（PATH / 悬空符号链接线索，同 harness_list healthDetail）
  let binaryCheck: DoctorCheck;
  if (notInstalled.length === 0) {
    binaryCheck = {
      name: "binary 诊断",
      level: "ok",
      summary: `全部 ${results.length} 个 adapter binary 可定位`,
    };
  } else {
    binaryCheck = {
      name: "binary 诊断",
      level: "error",
      summary: `${notInstalled.length} 个 binary 不可定位: ${notInstalled.map((r) => r.binary).join(", ")}`,
      detail: notInstalled
        .map((r) => `${r.id}（${r.binary}）: ${diagnoseBinary(r.binary)}`)
        .join("\n"),
    };
  }

  return [healthCheck, versionCheck, binaryCheck];
}

/* ---------------- 检查 4：台账健康 ---------------- */

const WAL_WARN_BYTES = 10 * 1024 * 1024;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

interface StatusCountRow {
  status?: unknown;
  n?: number | bigint;
}

export function checkLedgerHealth(cfg: BridgeConfig): DoctorCheck {
  const dbPath = path.join(resolveDataDir(cfg), "ledger.db");
  let walBytes = 0;
  try {
    walBytes = statSync(`${dbPath}-wal`).size;
  } catch {
    // 无 WAL 文件 = 0
  }
  let db: ReturnType<typeof openDriverSync>;
  try {
    db = openDriverSync(dbPath);
  } catch (err) {
    return {
      name: "台账健康",
      level: "error",
      summary: `台账打不开: ${dbPath}`,
      detail: `${(err as Error).message}；建议: 检查目录权限/磁盘空间，或备份后重建台账`,
    };
  }
  try {
    db.exec("PRAGMA busy_timeout=2000");
    let integrity = "ok";
    try {
      const r = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
      integrity = String(r?.integrity_check ?? "unknown");
    } catch (err) {
      integrity = `error: ${(err as Error).message}`;
    }
    let statLine = "空台账（尚无任务）";
    try {
      const rows = db.prepare("SELECT status, COUNT(*) AS n FROM task GROUP BY status").all() as StatusCountRow[];
      if (rows.length > 0) {
        const total = rows.reduce((s, r) => s + Number(r.n ?? 0), 0);
        statLine = `任务 ${total}（${rows.map((r) => `${String(r.status)} ${Number(r.n ?? 0)}`).join(" / ")}）`;
      }
    } catch {
      // task 表不存在 → 空台账
    }
    const walOk = walBytes < WAL_WARN_BYTES;
    const integrityOk = integrity === "ok";
    const level: DoctorLevel = !integrityOk ? "error" : walOk ? "ok" : "warn";
    const summary = `SQLite 完整性 ${integrityOk ? "ok" : integrity}；WAL ${formatBytes(walBytes)}；${statLine}`;
    let detail: string | undefined;
    if (!integrityOk) {
      detail = `完整性检查失败（${integrity}）；建议: 停写后用 .dump/备份迁移修复，或恢复 ledger.db 备份`;
    } else if (!walOk) {
      detail = `WAL 已 ${formatBytes(walBytes)}（阈值 ${formatBytes(WAL_WARN_BYTES)}）；建议: 排查是否有长驻只读连接阻塞 checkpoint（插件每小时自动 TRUNCATE checkpoint）`;
    }
    return { name: "台账健康", level, summary, ...(detail ? { detail } : {}) };
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

/* ---------------- 检查 5：worktree 残留（v0.4.8） ---------------- */

/**
 * worktree 残留检查：worktree 生命周期设计为「任务结束后保留，人工审查合并后清理」，
 * 本检查列出 <dataDir>/worktrees/ 下所有任务目录并对照台账任务状态：
 * 非运行中（或查不到状态）的目录即残留，warn 提示清理命令；只有运行中任务的 → ok。
 */
export function checkWorktreeResidue(cfg: BridgeConfig): DoctorCheck {
  const dataDir = resolveDataDir(cfg);
  const dirNames = listWorktreeTaskIds(dataDir);
  if (dirNames.length === 0) {
    return { name: "worktree 残留", level: "ok", summary: "无 worktree 残留（<dataDir>/worktrees/ 为空或不存在）" };
  }
  // 目录名 → 台账任务（目录名 = taskId 去 hb_ 前缀；台账打不开时全部视为状态未知）
  const infoByDir = new Map<string, { taskId: string; status: string }>();
  for (const name of dirNames) infoByDir.set(name, { taskId: name, status: "未知" });
  try {
    const db = openDriverSync(path.join(dataDir, "ledger.db"));
    try {
      db.exec("PRAGMA busy_timeout=2000");
      for (const name of dirNames) {
        try {
          const row = db
            .prepare("SELECT id, status FROM task WHERE id = ? OR id = ? LIMIT 1")
            .get(`hb_${name}`, name) as { id?: unknown; status?: unknown } | undefined;
          if (row?.status != null) {
            infoByDir.set(name, { taskId: String(row.id ?? `hb_${name}`), status: String(row.status) });
          }
        } catch {
          // 单条查询失败保持「未知」
        }
      }
    } finally {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  } catch {
    // 台账打不开 → 状态全部未知，仍按残留提示（保守）
  }
  const residue: string[] = [];
  const residueDirs: string[] = [];
  const active: string[] = [];
  for (const name of dirNames) {
    const info = infoByDir.get(name) ?? { taskId: name, status: "未知" };
    const line = `${info.taskId}（${info.status}）: ${path.join(worktreeDir(dataDir), name)}`;
    if (info.status === "running") active.push(line);
    else {
      residue.push(line);
      residueDirs.push(name);
    }
  }
  const cleanup = (dirName: string): string =>
    `git worktree remove ${path.join(worktreeDir(dataDir), dirName)}；分支已合并不再需要时 git branch -d hb-wt/hb_${dirName}（未合并需 -D）`;
  if (residue.length === 0) {
    return {
      name: "worktree 残留",
      level: "ok",
      summary: `${dirNames.length} 个 worktree 全部对应运行中任务（使用中，无残留）`,
      detail: active.join("\n"),
    };
  }
  return {
    name: "worktree 残留",
    level: "warn",
    summary: `${residue.length} 个残留 worktree（任务已结束，产出在 hb-wt/* 分支上待人工审查合并）${active.length > 0 ? `；另有 ${active.length} 个使用中` : ""}`,
    detail: `残留清单:\n${residue.map((l) => `- ${l}`).join("\n")}\n建议: 确认产出已合并后清理（主仓库内执行）\n${residueDirs.map(cleanup).join("\n")}`,
  };
}

/* ---------------- 检查 6：配置校验（当前值 vs 默认值） ---------------- */

export interface ConfigKeyInfo {
  key: string;
  defaultValue: string;
  description: string;
  get: (cfg: BridgeConfig) => unknown;
}

/** 全部配置键清单（键名 / 默认值 / 说明）——doctor 配置校验与 docs/config-reference.md 同源 */
export const CONFIG_KEY_TABLE: ConfigKeyInfo[] = [
  { key: "dataDir", defaultValue: "~/.openclaw/harness-bridge", description: "数据目录（台账/任务日志/用户 adapter）", get: (c) => c.dataDir },
  { key: "adaptersDir", defaultValue: "<dataDir>/adapters", description: "额外 adapter 目录（同名文件覆盖内置）", get: (c) => c.adaptersDir },
  { key: "paramsFile", defaultValue: "built-in params/model_params.json", description: "模型参数字典 JSON 路径", get: (c) => c.paramsFile },
  { key: "notifyCommand", defaultValue: "(none — 告警/日报推送关闭)", description: "后台任务完成/告警时执行的 shell 命令", get: (c) => c.notifyCommand },
  { key: "defaultTimeoutMs", defaultValue: "600000", description: "harness_run 默认超时毫秒（无 taskType 时）", get: (c) => c.defaultTimeoutMs },
  { key: "defaultTimeoutByTaskType", defaultValue: "{coding:2700000, general/analysis/search:600000}", description: "taskType → 默认超时毫秒映射", get: (c) => c.defaultTimeoutByTaskType },
  { key: "globalWorkspace", defaultValue: "(none — serve 进程默认目录)", description: "harness_run 未传 cwd 时的兜底工作区", get: (c) => c.globalWorkspace },
  { key: "successNotifyMinDurationMs", defaultValue: "300000", description: "成功通知阈值毫秒（≤0 禁用）", get: (c) => c.successNotifyMinDurationMs },
  { key: "statusLineEnabled", defaultValue: "true", description: "出站消息追加后台任务状态行", get: (c) => c.statusLineEnabled },
  { key: "taskboardFile", defaultValue: "(none — 状态行只用台账)", description: "markdown taskboard 路径（状态行/自动登记）", get: (c) => c.taskboardFile },
  { key: "turnPrepareEnabled", defaultValue: "true", description: "每回合注入后台任务清单", get: (c) => c.turnPrepareEnabled },
  { key: "metricsEnabled", defaultValue: "true", description: "进程内观测采样器", get: (c) => c.metricsEnabled },
  { key: "eventRetentionDays", defaultValue: "30", description: "task_event 保留天数（0=不清理）", get: (c) => c.eventRetentionDays },
  { key: "agentOpsLogEnabled", defaultValue: "true", description: "agent 层操作日志开关", get: (c) => c.agentOpsLogEnabled },
  { key: "agentOpsLogFile", defaultValue: "<dataDir>/agent-ops.log", description: "agent 层操作日志文件", get: (c) => c.agentOpsLogFile },
  { key: "agentOpsLogMaxBytes", defaultValue: "10485760", description: "agent-ops 日志轮转阈值字节（0=禁用）", get: (c) => c.agentOpsLogMaxBytes },
  { key: "agentOpsLogKeep", defaultValue: "7", description: "agent-ops 日志轮转保留份数", get: (c) => c.agentOpsLogKeep },
  { key: "dailyReport.enabled", defaultValue: "true", description: "台账日报推送开关", get: (c) => c.dailyReport?.enabled },
  { key: "dailyReport.hour", defaultValue: "21", description: "日报推送时刻（Asia/Shanghai 小时）", get: (c) => c.dailyReport?.hour },
  { key: "healthWatchdog.enabled", defaultValue: "true", description: "定时探活开关", get: (c) => c.healthWatchdog?.enabled },
  { key: "healthWatchdog.intervalMs", defaultValue: "300000", description: "探活间隔毫秒", get: (c) => c.healthWatchdog?.intervalMs },
  { key: "routing.retryAttempts", defaultValue: "1（配置了 routing 段时；未配置段=0 不重试）", description: "失败后同 harness 自动重试次数", get: (c) => c.routing?.retryAttempts },
  { key: "routing.default", defaultValue: "(none)", description: "默认 harness 兜底", get: (c) => c.routing?.default },
  { key: "routing.rules", defaultValue: "(none — 按 capabilities 路由)", description: "taskType → harness 路由规则", get: (c) => c.routing?.rules },
  { key: "routing.fallback", defaultValue: "(none)", description: "harness → 降级链", get: (c) => c.routing?.fallback },
  { key: "timeouts.idleTimeoutMs", defaultValue: "300000", description: "http SSE 静默核查阈值毫秒（0=禁用）", get: (c) => c.timeouts?.idleTimeoutMs },
  { key: "timeouts.maxDurationMs", defaultValue: "7200000", description: "http 总时长兜底毫秒（0=禁用）", get: (c) => c.timeouts?.maxDurationMs },
  { key: "timeouts.sessionCheckMaxRetries", defaultValue: "3", description: "连续核查仍 running 的告警阈值次数", get: (c) => c.timeouts?.sessionCheckMaxRetries },
  { key: "worktree.enabled", defaultValue: "false", description: "v0.4.8 worktree 隔离开关（开启后 harness_run worktree=true 才生效）", get: (c) => c.worktree?.enabled },
  { key: "doctorSchedule.enabled", defaultValue: "true", description: "v0.4.8 doctor 定时体检开关", get: (c) => c.doctorSchedule?.enabled },
  { key: "doctorSchedule.hour", defaultValue: "8", description: "v0.4.8 体检时刻（Asia/Shanghai 小时）", get: (c) => c.doctorSchedule?.hour },
  { key: "hostVersionOverride", defaultValue: "(none — 特性检测自动探测)", description: "v0.4.8 宿主版本覆盖（旧宿主无版本 API 时直接采用该值）", get: (c) => c.hostVersionOverride },
];

export function checkConfigHealth(cfg: BridgeConfig): DoctorCheck {
  const lines: string[] = [];
  let customized = 0;
  for (const info of CONFIG_KEY_TABLE) {
    let value: unknown;
    try {
      value = info.get(cfg);
    } catch {
      value = undefined;
    }
    const isDefault = value == null || value === "";
    if (!isDefault) customized += 1;
    lines.push(
      `${info.key} = ${isDefault ? info.defaultValue : JSON.stringify(value)}${isDefault ? "" : `（默认 ${info.defaultValue}）`}`,
    );
  }
  const detail = lines.join("\n");
  // 唯一的 warn 级建议项：告警/日报通道未配置（其余键均有可运行默认值）
  if (!cfg.notifyCommand?.trim()) {
    return {
      name: "配置校验",
      level: "warn",
      summary: `${CONFIG_KEY_TABLE.length} 个配置键全部有默认值（不配置也能跑）；已自定义 ${customized} 个；notifyCommand 未配置 → 告警与日报推送关闭`,
      detail: `建议: 需要微信/告警推送时配置 notifyCommand（推荐 "bash <插件目录>/scripts/hb_notify.sh"）\n全部配置键当前值 vs 默认值:\n${detail}`,
    };
  }
  return {
    name: "配置校验",
    level: "ok",
    summary: `${CONFIG_KEY_TABLE.length} 个配置键全部有默认值（不配置也能跑）；已自定义 ${customized} 个`,
    detail: `全部配置键当前值 vs 默认值:\n${detail}`,
  };
}

/* ---------------- 收口 ---------------- */

export interface DoctorOptions {
  /** 测试注入；默认 probeAllAdapters */
  probe?: (cfg: BridgeConfig) => Promise<AdapterStatus[]>;
  api?: HostVersionApi;
}

/** 一键体检：检查项收口，单项失败 fail-open（该项标 error，不拖垮整个报告） */
export async function runDoctor(cfg: BridgeConfig, opts: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  // 1-3 共用一轮 adapter 探测（探活 + 版本 + binary 诊断）
  try {
    const probe = opts.probe ?? probeAllAdapters;
    const results = await probe(cfg);
    checks.push(...adapterChecks(results));
  } catch (err) {
    checks.push({
      name: "adapter 探活",
      level: "error",
      summary: `adapter 探测失败: ${(err as Error).message}`,
    });
    checks.push({ name: "版本探测", level: "warn", summary: "探测不可用（adapter 探测失败）" });
    checks.push({ name: "binary 诊断", level: "warn", summary: "探测不可用（adapter 探测失败）" });
  }

  // 宿主版本（与 binary 版本并列展示在「版本探测」之外，单独一行）
  let hostVersion = "unknown";
  try {
    hostVersion = await detectHostVersion(opts.api, cfg.hostVersionOverride);
  } catch {
    // 保持 unknown
  }
  checks.push({
    name: "宿主版本",
    level: hostVersion === "unknown" ? "warn" : "ok",
    summary: hostVersion === "unknown" ? "宿主版本探测不可用（特性检测全回落）" : `宿主 ${hostVersion}`,
    ...(hostVersion === "unknown"
      ? { detail: "建议: 忽略（旧版宿主不导出版本 API）；或设置 hostVersionOverride 配置 / OPENCLAW_VERSION 环境变量" }
      : {}),
  });

  // 4) 台账健康
  try {
    checks.push(checkLedgerHealth(cfg));
  } catch (err) {
    checks.push({
      name: "台账健康",
      level: "error",
      summary: `台账检查异常: ${(err as Error).message}`,
    });
  }

  // 5) worktree 残留（v0.4.8，fail-open）
  try {
    checks.push(checkWorktreeResidue(cfg));
  } catch (err) {
    checks.push({
      name: "worktree 残留",
      level: "warn",
      summary: `worktree 检查异常: ${(err as Error).message}`,
    });
  }

  // 6) 配置校验
  try {
    checks.push(checkConfigHealth(cfg));
  } catch (err) {
    checks.push({
      name: "配置校验",
      level: "warn",
      summary: `配置对比异常: ${(err as Error).message}`,
    });
  }

  const allOk = checks.every((c) => c.level !== "error");
  const fullyHealthy = allOk && checks.every((c) => c.level !== "warn");
  return { checks, allOk, fullyHealthy };
}
