import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";

/**
 * v0.4.7 告警渲染集成测试：直接执行随包 scripts/hb_notify.sh（用假 openclaw bin 捕获 --message），
 * 锁死六类事件的标题/来源标记/显性兜底/失败必带信息——
 * 生产事故背景：旧版部署副本无 task_success 分支，长任务成功通知被渲染成「任务失败 ?·?」误报；
 * 日报调用不传 HB_ALERT 掉进 task_failed 分支。
 */

const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "hb_notify.sh");
let mockDir: string;
let mockBin: string;

beforeAll(() => {
  mockDir = mkdtempSync(path.join(tmpdir(), "hb-notify-"));
  mockBin = path.join(mockDir, "fake-openclaw");
  // 脚本把发送端 stdout/stderr 都重定向到 /dev/null，捕获走文件（MOCK_LOG 由测试注入）
  writeFileSync(mockBin, '#!/usr/bin/env bash\necho "$@" >> "$MOCK_LOG"\n');
  chmodSync(mockBin, 0o755);
});

afterAll(() => {
  try {
    rmSync(mockDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function render(env: Record<string, string>): string {
  const logFile = path.join(mockDir, `out-${Math.random().toString(36).slice(2)}.log`);
  const r = spawnSync("bash", [scriptPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      HB_NOTIFY_TARGET: "test-target",
      HB_NOTIFY_BIN: mockBin,
      MOCK_LOG: logFile,
      ...env,
    },
  });
  expect(r.status).toBe(0);
  const out = readFileSync(logFile, "utf8").trim();
  // fake-openclaw 把全部参数写入日志；取 --message 之后的正文
  const idx = out.indexOf("--message ");
  expect(idx).toBeGreaterThanOrEqual(0);
  return out.slice(idx + "--message ".length).trim();
}

describe("hb_notify.sh 渲染（v0.4.7 可行动性改造）", () => {
  it("daily_report 分支：[harness日报] 标题直接渲染报告原文，不落 task_failed", () => {
    const msg = render({
      HB_ALERT: "daily_report",
      HB_NOTIFY: "📊 harness 台账日报 10-27\n任务：5 个｜成功 4｜失败 1",
      HB_REPORT_DATE: "2026-10-27",
    });
    expect(msg).toContain("[harness日报] 2026-10-27");
    expect(msg).toContain("任务：5 个｜成功 4｜失败 1");
    expect(msg).not.toContain("任务失败");
  });

  it("task_failed（默认分支）必带：来源标记/失败原因/日志路径/查询提示", () => {
    const msg = render({
      HB_TASK_ID: "hb_x1",
      HB_HARNESS: "opencode",
      HB_STATUS: "failed",
      HB_EXIT_CODE: "1",
      HB_LOG_FILE: "/root/.openclaw/harness-bridge/tasks/hb_x1.log",
      HB_FAIL_REASON: "permission denied: rm -rf",
    });
    expect(msg).toContain("[harness告警·task-failed]");
    expect(msg).toContain("原因: permission denied: rm -rf");
    expect(msg).toContain("日志: /root/.openclaw/harness-bridge/tasks/hb_x1.log");
    expect(msg).toContain("详情: harness_status taskId=hb_x1");
  });

  it("task_failed 显性兜底：任务 ID 空 / 退出码空不再显示裸 ?", () => {
    const msg = render({ HB_STATUS: "failed" });
    expect(msg).toContain("[harness告警·task-failed]");
    expect(msg).toContain("(no task id)");
    expect(msg).toContain("no exit code (startup failure)");
    expect(msg).toContain("原因: (unknown failure reason)");
    expect(msg).not.toContain("? ·");
  });

  it("task_failed 抑制列表渲染 (60s window: N more tasks suppressed: id1, id2)", () => {
    const msg = render({ HB_TASK_ID: "t4", HB_SUPPRESSED: "2", HB_SUPPRESSED_IDS: "t2, t3" });
    expect(msg).toContain("(60s window: 2 more tasks suppressed: t2, t3)");
  });

  it("来源标记：stall / watchdog / selfcheck / task-success / doctor 各归其位", () => {
    expect(render({ HB_ALERT: "task_stall", HB_DETAIL: "d" })).toContain("[harness告警·stall]");
    expect(
      render({ HB_ALERT: "health_change", HB_ADAPTER: "dsh", HB_STATE: "unhealthy", HB_PREV_STATE: "healthy" }),
    ).toContain("[harness告警·watchdog]");
    expect(render({ HB_ALERT: "selfcheck", HB_SELFCHECK: "all_green" })).toContain("[harness告警·selfcheck]");
    expect(render({ HB_ALERT: "task_success", HB_DURATION: "6m40s" })).toContain("[harness通知·task-success]");
  });

  it("doctor_report 分支（v0.4.8）：[harness体检] 标题渲染 HB_DETAIL 异常摘要，不落 task_failed", () => {
    const msg = render({
      HB_ALERT: "doctor_report",
      HB_DETAIL: "❌ 台账健康：完整性 check fail\n   ↳ 建议: 恢复备份\n另有 1 个 warn 项",
      HB_TIME: "2026-10-28T08:00:00.000Z",
    });
    expect(msg).toContain("[harness体检]");
    expect(msg).toContain("❌ 台账健康：完整性 check fail");
    expect(msg).toContain("另有 1 个 warn 项");
    expect(msg).toContain("时间: 2026-10-28T08:00:00.000Z");
    expect(msg).not.toContain("任务失败");
  });

  it("task_success 正常渲染（回归旧版副本误报场景）", () => {
    const msg = render({
      HB_ALERT: "task_success",
      HB_HARNESS: "opencode",
      HB_TASK_ID: "hb_ok1",
      HB_DURATION: "12m0s",
      HB_COST_TOKENS: "4200",
    });
    expect(msg).toContain("长任务完成");
    expect(msg).toContain("opencode · hb_ok1");
    expect(msg).toContain("时长: 12m0s");
    expect(msg).toContain("Tokens: 4200");
    expect(msg).not.toContain("任务失败");
  });

  it("其余占位不再出现裸 ?（selfcheck/health_change/stall/doctor_report）", () => {
    for (const env of [
      { HB_ALERT: "selfcheck" },
      { HB_ALERT: "health_change" },
      { HB_ALERT: "task_stall" },
      { HB_ALERT: "task_success" },
      { HB_ALERT: "doctor_report" },
    ]) {
      const msg = render(env);
      expect(msg.includes("?")).toBe(false);
    }
  });
});
