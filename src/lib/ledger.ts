import { appendFileSync, existsSync, readFileSync } from "node:fs";

export type TaskStatus = "running" | "success" | "failed" | "timeout" | "lost";

export interface TaskRecord {
  id: string;
  harness: string;
  prompt: string;
  cwd?: string;
  status: TaskStatus;
  pid?: number;
  sessionId?: string | null;
  exitCode?: number | null;
  signal?: string | null;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  logFile?: string;
  outputTail?: string;
  error?: string;
}

/**
 * 追加式 JSONL 台账：同一任务可有多条记录（running → 终态），读取时按 id 取最新一条。
 * 崩溃安全：单行追加，坏行跳过。
 */
export class Ledger {
  constructor(readonly file: string) {}

  append(rec: TaskRecord): void {
    appendFileSync(this.file, `${JSON.stringify(rec)}\n`);
  }

  latest(filter?: { taskId?: string; harness?: string; status?: string }): TaskRecord[] {
    if (!existsSync(this.file)) return [];
    const byId = new Map<string, TaskRecord>();
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        const rec = JSON.parse(s) as TaskRecord;
        if (rec && rec.id) byId.set(rec.id, rec);
      } catch {
        // 跳过坏行
      }
    }
    let recs = [...byId.values()].sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
    if (filter?.taskId) recs = recs.filter((r) => r.id === filter.taskId);
    if (filter?.harness) recs = recs.filter((r) => r.harness === filter.harness);
    if (filter?.status) recs = recs.filter((r) => r.status === filter.status);
    return recs;
  }
}
