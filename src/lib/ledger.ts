import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

export type TaskStatus =
  | "running"
  | "success"
  | "failed"
  | "timeout"
  | "lost"
  | "queued"
  | "cancelled"
  | "waiting_permission";

export type TransportType = "cli" | "http" | "stdio-rpc";

export interface TaskRecord {
  id: string;
  harness: string;
  prompt?: string;
  cwd?: string;
  /** 实际执行的 transport（降级后为实际值，fallback_used=1 标记原计划） */
  transport?: TransportType | string;
  status: TaskStatus;
  pid?: number;
  sessionId?: string | null;
  exitCode?: number | null;
  signal?: string | null;
  /** RFC 表字段 time_created */
  createdAt?: string;
  /** RFC 表字段 time_started */
  startedAt?: string;
  /** RFC 表字段 time_finished */
  finishedAt?: string;
  durationMs?: number;
  logFile?: string;
  outputTail?: string;
  error?: string;
  title?: string;
  /** 事件流归因：tool error / permission denied / timeout / protocol error */
  failReason?: string;
  cost?: number | null;
  tokensInput?: number | null;
  tokensOutput?: number | null;
  tokensReasoning?: number | null;
  tokensCacheRead?: number | null;
  tokensCacheWrite?: number | null;
  /** v0.3.1 成本核算列（与上列同源，命名对齐成本报表） */
  costTotal?: number | null;
  costInputTokens?: number | null;
  costOutputTokens?: number | null;
  costReasoningTokens?: number | null;
  costCacheReadTokens?: number | null;
  /** fork-before-retry：本次任务 fork 自哪个源会话任务 */
  forkedFrom?: string | null;
  /** transport 降级标记：1 = http 探活失败回落 cli */
  fallbackUsed?: boolean;
}

export type LedgerEventType = "step" | "tool_use" | "text" | "error" | "status" | "permission" | "retry";

export interface LedgerEvent {
  taskId: string;
  seq: number;
  type: LedgerEventType | string;
  payload: unknown;
  ts: string;
}

/** payload JSON 与其中长字符串的单条截断上限（RFC 5.1：2KB） */
export const MAX_PAYLOAD_BYTES = 2048;

export function truncate2kb(text: string, max = MAX_PAYLOAD_BYTES): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…[truncated ${text.length - max} chars]`;
}

/** 整行 payload ≤ 2KB：先字段级截断保 JSON 可解析，超限再硬截断兜底 */
function truncatePayload(payload: unknown): string {
  const safe = (v: unknown): string => {
    try {
      return JSON.stringify(v) ?? "null";
    } catch {
      return JSON.stringify({ unserializable: true });
    }
  };
  let json = safe(payload);
  if (json.length <= MAX_PAYLOAD_BYTES) return json;
  for (const cap of [2016, 128, 24]) {
    json = safe(shrinkStrings(payload, cap, 0));
    if (json.length <= MAX_PAYLOAD_BYTES) return json;
  }
  return `${json.slice(0, MAX_PAYLOAD_BYTES)}…[truncated]`;
}

function shrinkStrings(v: unknown, cap: number, depth: number): unknown {
  if (depth > 4) return v;
  if (typeof v === "string") return v.length > cap ? truncate2kb(v, cap) : v;
  if (Array.isArray(v)) return v.map((x) => shrinkStrings(x, cap, depth + 1));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = shrinkStrings(val, cap, depth + 1);
    }
    return out;
  }
  return v;
}

const STATUS_ALIASES: Record<string, TaskStatus> = {
  succeeded: "success",
  ok: "success",
  error: "failed",
};

export function normalizeStatus(s: string): TaskStatus {
  return STATUS_ALIASES[s] ?? (s as TaskStatus);
}

interface SqlStatement {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

interface SqlDriver {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

/**
 * 驱动优先级：node:sqlite（node 22+ 内置，零依赖）→ better-sqlite3（动态加载，
 * 仅当运行时 node:sqlite 不可用时才需要显式安装该依赖）。
 * 用 createRequire 同步加载：保证 append 在同步代码路径（cli runner）里立即落盘。
 */
function openDriverSync(dbPath: string): SqlDriver {
  const require = createRequire(import.meta.url);
  try {
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (p: string) => SqlDriver;
    };
    return new DatabaseSync(dbPath);
  } catch (err) {
    try {
      const BetterSqlite3 = require("better-sqlite3") as new (p: string) => SqlDriver;
      return new BetterSqlite3(dbPath);
    } catch {
      throw new Error(
        `无法打开 SQLite 台账 ${dbPath}: node:sqlite 不可用（${(err as Error).message}），且 better-sqlite3 未安装`,
      );
    }
  }
}

/** 旧库迁移：对 task 表补齐所有缺失列（CREATE IF NOT EXISTS 不改已存在表） */
function migrateColumns(driver: SqlDriver): void {
  const COLUMN_TYPES: Record<string, string> = {
    transport: "TEXT",
    session_id: "TEXT",
    title: "TEXT",
    exit_code: "INTEGER",
    fail_reason: "TEXT",
    cost: "REAL",
    tokens_input: "INTEGER",
    tokens_output: "INTEGER",
    tokens_reasoning: "INTEGER",
    tokens_cache_read: "INTEGER",
    tokens_cache_write: "INTEGER",
    cost_total: "REAL",
    cost_input_tokens: "INTEGER",
    cost_output_tokens: "INTEGER",
    cost_reasoning_tokens: "INTEGER",
    cost_cache_read_tokens: "INTEGER",
    forked_from: "TEXT",
    fallback_used: "INTEGER",
    prompt: "TEXT",
    cwd: "TEXT",
    pid: "INTEGER",
    log_file: "TEXT",
    output_tail: "TEXT",
    error: "TEXT",
    signal: "TEXT",
    duration_ms: "INTEGER",
    time_created: "TEXT",
    time_started: "TEXT",
    time_finished: "TEXT",
  };
  let existing: string[] = [];
  try {
    const rows = driver.prepare("PRAGMA table_info(task)").all() as Array<{ name: string }>;
    existing = rows.map((r) => r.name);
  } catch {
    return;
  }
  for (const col of TASK_COLUMNS) {
    const type = COLUMN_TYPES[col];
    if (type && !existing.includes(col)) {
      try {
        driver.exec(`ALTER TABLE task ADD COLUMN ${col} ${type}`);
      } catch {
        // 并发迁移竞态：列已存在则忽略
      }
    }
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS task (
  id TEXT PRIMARY KEY,
  harness TEXT NOT NULL,
  transport TEXT NOT NULL DEFAULT 'cli',
  session_id TEXT,
  title TEXT,
  status TEXT NOT NULL,
  exit_code INTEGER,
  fail_reason TEXT,
  cost REAL,
  tokens_input INTEGER,
  tokens_output INTEGER,
  tokens_reasoning INTEGER,
  tokens_cache_read INTEGER,
  tokens_cache_write INTEGER,
  cost_total REAL,
  cost_input_tokens INTEGER,
  cost_output_tokens INTEGER,
  cost_reasoning_tokens INTEGER,
  cost_cache_read_tokens INTEGER,
  forked_from TEXT,
  fallback_used INTEGER DEFAULT 0,
  prompt TEXT,
  cwd TEXT,
  pid INTEGER,
  log_file TEXT,
  output_tail TEXT,
  error TEXT,
  signal TEXT,
  duration_ms INTEGER,
  time_created TEXT,
  time_started TEXT,
  time_finished TEXT
);
CREATE TABLE IF NOT EXISTS task_event (
  task_id TEXT REFERENCES task(id),
  seq INTEGER,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  ts TEXT NOT NULL,
  PRIMARY KEY (task_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_task_status ON task(status);
CREATE INDEX IF NOT EXISTS idx_task_harness ON task(harness);
CREATE INDEX IF NOT EXISTS idx_task_time_created ON task(time_created);
`;

const TASK_COLUMNS = [
  "id",
  "harness",
  "transport",
  "session_id",
  "title",
  "status",
  "exit_code",
  "fail_reason",
  "cost",
  "tokens_input",
  "tokens_output",
  "tokens_reasoning",
  "tokens_cache_read",
  "tokens_cache_write",
  "cost_total",
  "cost_input_tokens",
  "cost_output_tokens",
  "cost_reasoning_tokens",
  "cost_cache_read_tokens",
  "forked_from",
  "fallback_used",
  "prompt",
  "cwd",
  "pid",
  "log_file",
  "output_tail",
  "error",
  "signal",
  "duration_ms",
  "time_created",
  "time_started",
  "time_finished",
] as const;

type TaskRow = { [K in (typeof TASK_COLUMNS)[number]]?: unknown };

function rowToRecord(r: TaskRow): TaskRecord {
  const rec: TaskRecord = {
    id: r.id as string,
    harness: r.harness as string,
    transport: (r.transport as string) ?? "cli",
    status: normalizeStatus(String(r.status)),
  };
  if (r.session_id != null) rec.sessionId = r.session_id as string;
  if (r.title != null) rec.title = r.title as string;
  if (r.exit_code != null) rec.exitCode = r.exit_code as number;
  if (r.fail_reason != null) rec.failReason = r.fail_reason as string;
  if (r.cost != null) rec.cost = r.cost as number;
  if (r.tokens_input != null) rec.tokensInput = r.tokens_input as number;
  if (r.tokens_output != null) rec.tokensOutput = r.tokens_output as number;
  if (r.tokens_reasoning != null) rec.tokensReasoning = r.tokens_reasoning as number;
  if (r.tokens_cache_read != null) rec.tokensCacheRead = r.tokens_cache_read as number;
  if (r.tokens_cache_write != null) rec.tokensCacheWrite = r.tokens_cache_write as number;
  if (r.cost_total != null) rec.costTotal = r.cost_total as number;
  if (r.cost_input_tokens != null) rec.costInputTokens = r.cost_input_tokens as number;
  if (r.cost_output_tokens != null) rec.costOutputTokens = r.cost_output_tokens as number;
  if (r.cost_reasoning_tokens != null) rec.costReasoningTokens = r.cost_reasoning_tokens as number;
  if (r.cost_cache_read_tokens != null) rec.costCacheReadTokens = r.cost_cache_read_tokens as number;
  if (r.forked_from != null) rec.forkedFrom = r.forked_from as string;
  if (r.fallback_used != null) rec.fallbackUsed = r.fallback_used === 1;
  if (r.prompt != null) rec.prompt = r.prompt as string;
  if (r.cwd != null) rec.cwd = r.cwd as string;
  if (r.pid != null) rec.pid = r.pid as number;
  if (r.log_file != null) rec.logFile = r.log_file as string;
  if (r.output_tail != null) rec.outputTail = r.output_tail as string;
  if (r.error != null) rec.error = r.error as string;
  if (r.signal != null) rec.signal = r.signal as string;
  if (r.duration_ms != null) rec.durationMs = r.duration_ms as number;
  if (r.time_created != null) rec.createdAt = r.time_created as string;
  if (r.time_started != null) rec.startedAt = r.time_started as string;
  if (r.time_finished != null) rec.finishedAt = r.time_finished as string;
  return rec;
}

function recordToRow(rec: TaskRecord): TaskRow {
  const row: TaskRow = { id: rec.id, harness: rec.harness };
  row.transport = rec.transport ?? "cli";
  row.status = normalizeStatus(rec.status);
  if (rec.sessionId !== undefined) row.session_id = rec.sessionId ?? null;
  if (rec.title !== undefined) row.title = rec.title ?? null;
  if (rec.exitCode !== undefined) row.exit_code = rec.exitCode ?? null;
  if (rec.failReason !== undefined) row.fail_reason = rec.failReason ?? null;
  if (rec.cost !== undefined) row.cost = rec.cost ?? null;
  if (rec.tokensInput !== undefined) row.tokens_input = rec.tokensInput ?? null;
  if (rec.tokensOutput !== undefined) row.tokens_output = rec.tokensOutput ?? null;
  if (rec.tokensReasoning !== undefined) row.tokens_reasoning = rec.tokensReasoning ?? null;
  if (rec.tokensCacheRead !== undefined) row.tokens_cache_read = rec.tokensCacheRead ?? null;
  if (rec.tokensCacheWrite !== undefined) row.tokens_cache_write = rec.tokensCacheWrite ?? null;
  if (rec.costTotal !== undefined) row.cost_total = rec.costTotal ?? null;
  if (rec.costInputTokens !== undefined) row.cost_input_tokens = rec.costInputTokens ?? null;
  if (rec.costOutputTokens !== undefined) row.cost_output_tokens = rec.costOutputTokens ?? null;
  if (rec.costReasoningTokens !== undefined) row.cost_reasoning_tokens = rec.costReasoningTokens ?? null;
  if (rec.costCacheReadTokens !== undefined) row.cost_cache_read_tokens = rec.costCacheReadTokens ?? null;
  if (rec.forkedFrom !== undefined) row.forked_from = rec.forkedFrom ?? null;
  if (rec.fallbackUsed !== undefined) row.fallback_used = rec.fallbackUsed ? 1 : 0;
  if (rec.prompt !== undefined) row.prompt = rec.prompt ?? null;
  if (rec.cwd !== undefined) row.cwd = rec.cwd ?? null;
  if (rec.pid !== undefined) row.pid = rec.pid ?? null;
  if (rec.logFile !== undefined) row.log_file = rec.logFile ?? null;
  if (rec.outputTail !== undefined) row.output_tail = rec.outputTail ?? null;
  if (rec.error !== undefined) row.error = rec.error ?? null;
  if (rec.signal !== undefined) row.signal = rec.signal ?? null;
  if (rec.durationMs !== undefined) row.duration_ms = rec.durationMs ?? null;
  if (rec.createdAt !== undefined) row.time_created = rec.createdAt ?? null;
  if (rec.startedAt !== undefined) row.time_started = rec.startedAt ?? null;
  if (rec.finishedAt !== undefined) row.time_finished = rec.finishedAt ?? null;
  return row;
}

export interface LedgerFilter {
  taskId?: string;
  harness?: string;
  status?: string;
  /** RFC 5.2 时间窗过滤（ISO 时间，含边界） */
  since?: string;
  until?: string;
}

export class Ledger {
  private driver: SqlDriver | null = null;
  private inited = false;
  private seqCounters = new Map<string, number>();

  constructor(
    readonly dbPath: string,
    private opts?: { legacyFile?: string },
  ) {}

  private init(): void {
    if (this.inited) return;
    const dir = this.dbPath.replace(/[/\\][^/\\]+$/, "");
    if (dir && dir !== this.dbPath) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        // 目录已存在或不可建
      }
    }
    const driver = openDriverSync(this.dbPath);
    driver.exec("PRAGMA journal_mode=WAL");
    driver.exec("PRAGMA busy_timeout=5000");
    driver.exec("PRAGMA synchronous=NORMAL");
    migrateColumns(driver); // 先补列，SCHEMA_SQL 的索引才能引用
    driver.exec(SCHEMA_SQL);
    this.driver = driver;
    this.inited = true;
  }

  /** 供测试与进程退出时关闭连接 */
  close(): void {
    if (this.inited) {
      this.driver?.close();
      this.driver = null;
      this.inited = false;
    }
    this.seqCounters.clear();
  }

  private ready(): SqlDriver {
    this.init();
    return this.driver as SqlDriver;
  }

  /**
   * 写入（upsert 合并）任务记录：同 id 后写覆盖前写的非空字段。
   * 兼容 v0.1 的 append-only 语义（running → 终态两次追加）。
   */
  append(rec: TaskRecord): void {
    const db = this.ready();
    const existing = this.getById(rec.id);
    const merged: TaskRecord = { ...existing, ...rec };
    if (rec.status !== undefined) merged.status = normalizeStatus(rec.status);
    const row = recordToRow(merged);
    const cols = TASK_COLUMNS.filter((c) => row[c] !== undefined);
    const placeholders = cols.map(() => "?").join(", ");
    const updates = cols.filter((c) => c !== "id").map((c) => `${c} = excluded.${c}`);
    db.prepare(
      `INSERT INTO task (${cols.join(", ")}) VALUES (${placeholders})
       ON CONFLICT(id) DO UPDATE SET ${updates.length ? updates.join(", ") : "id = id"}`,
    ).run(...cols.map((c) => row[c]));
  }

  getById(id: string): TaskRecord | undefined {
    const db = this.ready();
    const r = db.prepare(`SELECT ${TASK_COLUMNS.join(", ")} FROM task WHERE id = ?`).get(id) as
      | TaskRow
      | undefined;
    return r ? rowToRecord(r) : undefined;
  }

  latest(filter?: LedgerFilter, limit = 20): TaskRecord[] {
    const db = this.ready();
    const conds: string[] = [];
    const params: unknown[] = [];
    if (filter?.taskId) {
      conds.push("id = ?");
      params.push(filter.taskId);
    }
    if (filter?.harness) {
      conds.push("harness = ?");
      params.push(filter.harness);
    }
    if (filter?.status) {
      conds.push("status = ?");
      params.push(normalizeStatus(filter.status));
    }
    if (filter?.since) {
      conds.push(`COALESCE(time_created, time_started) >= ?`);
      params.push(filter.since);
    }
    if (filter?.until) {
      conds.push(`COALESCE(time_created, time_started) <= ?`);
      params.push(filter.until);
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const sql = `SELECT ${TASK_COLUMNS.join(", ")} FROM task ${where}
      ORDER BY COALESCE(time_created, time_started) DESC LIMIT ?`;
    params.push(limit);
    const rows = db.prepare(sql).all(...params) as TaskRow[];
    return rows.map(rowToRecord);
  }

  /** 事件批量写入（单事务）；seq 在 task 内自增，调用方无需指定 */
  addEvents(taskId: string, events: Array<Omit<LedgerEvent, "taskId" | "seq">>): void {
    if (events.length === 0) return;
    const db = this.ready();
    let seq = this.seqCounters.get(taskId) ?? -1;
    if (seq < 0) {
      const r = db
        .prepare("SELECT COALESCE(MAX(seq), -1) AS max_seq FROM task_event WHERE task_id = ?")
        .get(taskId) as { max_seq: number } | undefined;
      seq = r?.max_seq ?? -1;
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      const stmt = db.prepare(
        "INSERT OR REPLACE INTO task_event (task_id, seq, type, payload, ts) VALUES (?, ?, ?, ?, ?)",
      );
      for (const e of events) {
        seq += 1;
        stmt.run(taskId, seq, e.type, truncatePayload(e.payload), e.ts);
      }
      db.exec("COMMIT");
      this.seqCounters.set(taskId, seq);
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // 事务可能已自动回滚
      }
      throw err;
    }
  }

  getEvents(taskId: string): LedgerEvent[] {
    const db = this.ready();
    const rows = db
      .prepare("SELECT task_id, seq, type, payload, ts FROM task_event WHERE task_id = ? ORDER BY seq")
      .all(taskId) as Array<{ task_id: string; seq: number; type: string; payload: string; ts: string }>;
    return rows.map((r) => {
      let payload: unknown = r.payload;
      try {
        payload = JSON.parse(r.payload);
      } catch {
        // 保留原始字符串
      }
      return { taskId: r.task_id, seq: r.seq, type: r.type, payload, ts: r.ts };
    });
  }

  /**
   * v0.4.1 台账自动清理：task_event 事件流水按保留天数清理（默认 30 天），
   * task 主表保留（每任务一行量小，历史任务可查）。返回删除行数。
   */
  cleanupEvents(retentionDays = 30): number {
    const db = this.ready();
    const cutoff = new Date(Date.now() - retentionDays * 86400_000).toISOString();
    const r = db.prepare("DELETE FROM task_event WHERE ts < ?").run(cutoff) as {
      changes?: number | bigint;
    };
    return Number(r.changes ?? 0);
  }

  /**
   * v0.1 JSON Lines 台账只读读取（不迁移、不写入）。
   * 同 id 多条时取最后一条（与旧行为一致：最新追加生效）。
   */
  legacyLatest(filter?: LedgerFilter): TaskRecord[] {
    const file = this.opts?.legacyFile;
    if (!file) return [];
    let raw: string;
    try {
      raw = readLegacySync(file);
    } catch {
      return [];
    }
    const byId = new Map<string, TaskRecord>();
    for (const line of raw.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        const rec = JSON.parse(s) as TaskRecord;
        if (rec && rec.id) byId.set(rec.id, rec);
      } catch {
        // 坏行跳过
      }
    }
    let recs = [...byId.values()].sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
    if (filter?.taskId) recs = recs.filter((r) => r.id === filter.taskId);
    if (filter?.harness) recs = recs.filter((r) => r.harness === filter.harness);
    if (filter?.status) recs = recs.filter((r) => r.status === filter.status);
    if (filter?.since) recs = recs.filter((r) => (r.startedAt || "") >= (filter.since as string));
    if (filter?.until) recs = recs.filter((r) => (r.startedAt || "") <= (filter.until as string));
    return recs;
  }
}

function readLegacySync(file: string): string {
  return readFileSync(file, "utf8");
}

export interface CostSummary {
  tasks: number;
  withCost: number;
  costTotal: number;
  costInputTokens: number;
  costOutputTokens: number;
  costReasoningTokens: number;
  costCacheReadTokens: number;
}

/** v0.3.1 成本核算：对过滤后的任务集做 cost/tokens 汇总 */
export function summarizeCost(records: TaskRecord[]): CostSummary {
  const sum = {
    tasks: records.length,
    withCost: 0,
    costTotal: 0,
    costInputTokens: 0,
    costOutputTokens: 0,
    costReasoningTokens: 0,
    costCacheReadTokens: 0,
  };
  for (const r of records) {
    if (r.costTotal != null || r.cost != null) {
      sum.withCost += 1;
      sum.costTotal += r.costTotal ?? r.cost ?? 0;
    }
    sum.costInputTokens += r.costInputTokens ?? r.tokensInput ?? 0;
    sum.costOutputTokens += r.costOutputTokens ?? r.tokensOutput ?? 0;
    sum.costReasoningTokens += r.costReasoningTokens ?? r.tokensReasoning ?? 0;
    sum.costCacheReadTokens += r.costCacheReadTokens ?? r.tokensCacheRead ?? 0;
  }
  return sum;
}

const openLedgers = new Map<string, Ledger>();

/** 进程内单连接缓存：同一 dbPath 复用 Ledger（避免 fd 泄漏） */
export function openLedgerAt(dbPath: string, opts?: { legacyFile?: string }): Ledger {
  let l = openLedgers.get(dbPath);
  if (!l) {
    l = new Ledger(dbPath, opts);
    openLedgers.set(dbPath, l);
  }
  return l;
}

/** 测试用：关闭并清除所有缓存的 Ledger 连接 */
export async function closeAllLedgers(): Promise<void> {
  for (const l of openLedgers.values()) await l.close();
  openLedgers.clear();
}
