import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import entry, { resolveEventLimit } from "./index.js";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import { closeAllLedgers, Ledger, type TaskRecord } from "./lib/ledger.js";

const dirs: string[] = [];
afterAll(async () => {
  await closeAllLedgers();
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe("harness-bridge", () => {
  it("declares the MVP tools (v0.4.7: + harness_doctor, v0.4.12: + harness_permission)", () => {
    expect(getToolPluginMetadata(entry)?.tools.map((t) => t.name).sort()).toEqual([
      "harness_doctor",
      "harness_list",
      "harness_mount",
      "harness_permission",
      "harness_run",
      "harness_status",
      "harness_sync_models",
    ]);
  });

  it("harness_status 工具描述注明 events 限流（v0.4.11：默认最新 50 条，传 limit 调整）", () => {
    const tool = getToolPluginMetadata(entry)?.tools.find((t) => t.name === "harness_status");
    expect(tool?.description).toContain("默认只回最新 50 条");
    expect(tool?.description).toContain("truncated");
  });
});

describe("harness_status events 查询限流（v0.4.11）", () => {
  it("resolveEventLimit：默认 50、上限 1000、非法值回落默认", () => {
    expect(resolveEventLimit(undefined)).toBe(50);
    expect(resolveEventLimit(30)).toBe(30);
    expect(resolveEventLimit(1000)).toBe(1000);
    expect(resolveEventLimit(5000)).toBe(1000); // 上限钳制
    expect(resolveEventLimit(99.9)).toBe(99); // 向下取整
    expect(resolveEventLimit(0)).toBe(50); // 非法回落默认
    expect(resolveEventLimit(-1)).toBe(50);
    expect(resolveEventLimit(Number.NaN)).toBe(50);
    expect(resolveEventLimit("80" as unknown as number)).toBe(50);
  });

  it("total/truncated 字段语义：默认最新 50 条，total 为全量事件总数", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hb-status-"));
    dirs.push(dir);
    const ledger = new Ledger(path.join(dir, "ledger.db"));
    const id = "hb_t_events";
    ledger.append({ id, harness: "opencode", transport: "cli", status: "running" } as TaskRecord);
    for (let i = 0; i < 120; i++) {
      ledger.addEvents(id, [{ type: "step", payload: { i }, ts: new Date().toISOString() }]);
    }
    // 与 harness_status execute 的 events 分支同构：total=COUNT(*)、truncated=total > 返回条数
    const query = (rawLimit?: number) => {
      const total = ledger.countEvents(id);
      const events = ledger.getEvents(id, resolveEventLimit(rawLimit));
      return { events, total, truncated: total > events.length };
    };
    const def = query(undefined); // 不传 limit：默认 50
    expect(def.events).toHaveLength(50);
    expect(def.total).toBe(120);
    expect(def.truncated).toBe(true);
    expect((def.events[0].payload as { i: number }).i).toBe(70); // 最新 50 条（70..119）且正序
    expect((def.events.at(-1)!.payload as { i: number }).i).toBe(119);
    const full = query(200); // limit 调大到超过总数：不截断
    expect(full.events).toHaveLength(120);
    expect(full.total).toBe(120);
    expect(full.truncated).toBe(false);
    await ledger.close();
  });
});
