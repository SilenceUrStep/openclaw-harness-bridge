import type { Adapter, BridgeConfig } from "./adapters.js";
import { checkHealth, getAdapter, listAdapters } from "./adapters.js";
import { diagnoseBinary } from "./diagnose.js";
import {
  checkVersionGate,
  cliFallbackOf,
  fetchHttpVersion,
  probeHttpHealth,
  resolveTransport,
  type HttpTransport,
  type TransportKind,
  type VersionGate,
} from "./transport.js";

/** v0.4.3 共享探活结果（harness_list 输出结构，供定时探活/自检/降级探测复用） */
export interface AdapterStatus {
  id: string;
  displayName: string;
  description: string | null;
  binary: string;
  capabilities: string[];
  modelSync: boolean;
  schemaVersion: number;
  installed: boolean;
  version?: string;
  configFileExists?: boolean | null;
  transport: TransportKind;
  healthy: boolean;
  healthDetail: string;
  cliFallback?: boolean;
  versionGate?: VersionGate | null;
}

/**
 * 单 adapter 健康探测：binary 探测 + 版本门禁 + transport 探活（http）。
 * binary 不可用时 healthDetail 附带诊断线索（v0.4.3）。
 */
export async function probeAdapterStatus(_cfg: BridgeConfig, a: Adapter): Promise<AdapterStatus> {
  const t = resolveTransport(a);
  const h = checkHealth(a);
  const diagDetail = (base: string): string =>
    h.installed ? base : `${base}；诊断：${diagnoseBinary(a.binary)}`;
  const base = {
    id: a.id,
    displayName: a.displayName,
    description: a.description ?? null,
    binary: a.binary,
    capabilities: a.capabilities ?? [],
    modelSync: Boolean(a.config?.modelConfig),
    schemaVersion: a.schemaVersion ?? 1,
    installed: h.installed,
    ...(h.version !== undefined ? { version: h.version } : {}),
    ...(h.configFileExists !== undefined ? { configFileExists: h.configFileExists } : {}),
  };
  if (t.kind === "http") {
    const probe = await probeHttpHealth(t.config as HttpTransport);
    let gate = checkVersionGate(undefined, a.versionGate ?? {});
    if (a.versionGate && probe.ok) {
      const v = await fetchHttpVersion(t.config as HttpTransport);
      gate = checkVersionGate(v, a.versionGate);
    }
    return {
      ...base,
      transport: "http",
      healthy: probe.ok && gate.ok,
      healthDetail: !probe.ok
        ? (probe.error ?? `HTTP ${probe.status}`)
        : gate.ok
          ? `HTTP ${probe.status}，版本 ${gate.version ?? "未知"}`
          : (gate.detail ?? "版本门禁未通过"),
      cliFallback: cliFallbackOf(a),
      versionGate: a.versionGate ?? null,
    };
  }
  if (t.kind === "stdio-rpc") {
    const gate = checkVersionGate(h.version, a.versionGate ?? {});
    return {
      ...base,
      transport: "stdio-rpc",
      healthy: h.installed && gate.ok,
      healthDetail: diagDetail(
        !h.installed
          ? "binary 不可用"
          : gate.ok
            ? `版本 ${gate.version ?? "未知"}（SDK 就绪，运行时握手复核）`
            : (gate.detail ?? "版本门禁未通过"),
      ),
      versionGate: a.versionGate ?? null,
    };
  }
  return {
    ...base,
    transport: "cli",
    healthy: h.installed,
    healthDetail: h.installed ? `版本 ${h.version ?? "未知"}` : diagDetail("binary 不可用"),
  };
}

/** 全部 adapter 健康探测（harness_list / 定时探活共用） */
export async function probeAllAdapters(cfg: BridgeConfig): Promise<AdapterStatus[]> {
  return Promise.all(listAdapters(cfg).map((a) => probeAdapterStatus(cfg, a)));
}

/** 可用性探测（降级判定用）：http 走 transport 探活，cli/stdio-rpc 走 binary 探测 */
export async function probeAvailability(
  cfg: BridgeConfig,
  harnessId: string,
): Promise<{ available: boolean; detail: string }> {
  const a = getAdapter(cfg, harnessId);
  if (!a) return { available: false, detail: `adapter ${harnessId} 未注册` };
  const t = resolveTransport(a);
  if (t.kind === "http") {
    const probe = await probeHttpHealth(t.config as HttpTransport);
    return probe.ok
      ? { available: true, detail: `HTTP ${probe.status ?? 200}` }
      : { available: false, detail: probe.error ?? `HTTP ${probe.status}` };
  }
  const h = checkHealth(a);
  return h.installed
    ? { available: true, detail: `binary ${a.binary} 可用（版本 ${h.version ?? "未知"}）` }
    : { available: false, detail: `binary ${a.binary} 不可用（spawn 探测失败）` };
}
