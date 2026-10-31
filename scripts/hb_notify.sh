#!/usr/bin/env bash
# harness-bridge bundled alert dispatch script (v0.4.7; recommended notifyCommand target)
# Usage: set notifyCommand to "bash <plugin-dir>/scripts/hb_notify.sh"
# Machine-specific values are injected via env (never hardcoded here):
#   HB_NOTIFY_TARGET   required, the --target value for `openclaw message send` (unset → render only, exit 0)
#   HB_NOTIFY_CHANNEL  optional, default openclaw-weixin
#   HB_NOTIFY_BIN      optional, default `openclaw` from PATH
# Event types branch on HB_ALERT (env vars per type, see README "Alert channels"):
#   task_failed (default): HB_TASK_ID / HB_HARNESS / HB_STATUS / HB_EXIT_CODE / HB_SESSION_ID /
#                          HB_LOG_FILE / HB_FAIL_REASON / HB_SUPPRESSED / HB_SUPPRESSED_IDS /
#                          HB_ADVICE / HB_HAS_OUTPUT
#   task_success:          HB_TASK_ID / HB_HARNESS / HB_DURATION / HB_COST_TOKENS(when set) / HB_TIME
#   task_stall:            HB_TASK_ID / HB_SESSION_ID / HB_DETAIL / HB_TIME
#   health_change:         HB_ADAPTER / HB_STATE / HB_PREV_STATE / HB_DETAIL / HB_TIME
#   selfcheck:             HB_SELFCHECK / HB_HOST_VERSION / HB_DETAIL / HB_TIME
#   daily_report:          HB_NOTIFY (report text) / HB_REPORT_DATE (v0.4.7 ledger daily report)
#   doctor_report:         HB_DETAIL (anomaly digest) / HB_TIME (v0.4.8 scheduled doctor check)
#   permission_ask:        HB_TASK_ID / HB_SESSION_ID / HB_REQUEST_ID / HB_PERMISSION_DETAIL / HB_TIME (v0.4.12)
#   permission_timeout:    HB_TASK_ID / HB_SESSION_ID / HB_REQUEST_ID / HB_PERMISSION_DETAIL / HB_TIME (v0.4.12)
# v0.4.7: every alert carries a source marker ([harness告警·type]); bare `?` fallbacks replaced
# with explicit placeholders; task_failed always renders fail reason + absolute log path +
# follow-up hint; suppressed alerts list the suppressed task ids, not just a count.
set -u

OPENCLAW_BIN="${HB_NOTIFY_BIN:-$(command -v openclaw 2>/dev/null || true)}"
TARGET="${HB_NOTIFY_TARGET:-}"
CHANNEL="${HB_NOTIFY_CHANNEL:-openclaw-weixin}"

ALERT="${HB_ALERT:-task_failed}"

case "$ALERT" in
  daily_report)
    MSG="[harness日报] ${HB_REPORT_DATE:-(unknown date)}
${HB_NOTIFY:-(no report content)}"
    ;;
  doctor_report)
    MSG="[harness体检] 定时体检发现异常项
${HB_DETAIL:-(no detail)}
时间: ${HB_TIME:-(unknown time)}"
    ;;
  selfcheck)
    MSG="[harness告警·selfcheck] 宿主 ${HB_HOST_VERSION:-(unknown host version)}
结果: ${HB_SELFCHECK:-(unknown result)}
${HB_DETAIL:-(no detail)}
时间: ${HB_TIME:-(unknown time)}"
    ;;
  health_change)
    MSG="[harness告警·watchdog] ${HB_ADAPTER:-(unknown adapter)}: ${HB_PREV_STATE:-(unknown previous state)} → ${HB_STATE:-(unknown state)}
${HB_DETAIL:-(no detail)}
时间: ${HB_TIME:-(unknown time)}"
    ;;
  task_stall)
    MSG="[harness告警·stall] 任务停滞（连续核查无进展）
任务: ${HB_TASK_ID:-(no task id)}
${HB_DETAIL:-(no detail)}
时间: ${HB_TIME:-(unknown time)}"
    ;;
  permission_ask)
    MSG="[harness告警·permission-ask] 任务等待权限批准（配合 harness_permission reply 人工放行）
任务: ${HB_TASK_ID:-(no task id)}
会话: ${HB_SESSION_ID:-(no session id)}
请求: ${HB_REQUEST_ID:-(no request id)}
${HB_PERMISSION_DETAIL:-(no detail)}
时间: ${HB_TIME:-(unknown time)}"
    ;;
  permission_timeout)
    MSG="[harness告警·permission-timeout] 权限挂起超时，已自动拒绝
任务: ${HB_TASK_ID:-(no task id)}
会话: ${HB_SESSION_ID:-(no session id)}
请求: ${HB_REQUEST_ID:-(no request id)}
${HB_PERMISSION_DETAIL:-(no detail)}
时间: ${HB_TIME:-(unknown time)}"
    ;;
  task_success)
    MSG="[harness通知·task-success] 长任务完成
任务: ${HB_HARNESS:-(unknown harness)} · ${HB_TASK_ID:-(no task id)}
时长: ${HB_DURATION:-(unknown duration)}"
    [ -n "${HB_COST_TOKENS:-}" ] && MSG="$MSG
Tokens: ${HB_COST_TOKENS}"
    MSG="$MSG
时间: ${HB_TIME:-(unknown time)}"
    ;;
  *)
    MSG="[harness告警·task-failed] 任务失败
任务: ${HB_HARNESS:-(unknown harness)} · ${HB_TASK_ID:-(no task id)}
状态: ${HB_STATUS:-(unknown status)}  退出码: ${HB_EXIT_CODE:-no exit code (startup failure)}
日志: ${HB_LOG_FILE:-(no log file)}
原因: ${HB_FAIL_REASON:-(unknown failure reason)}"
    [ -n "${HB_ADVICE:-}" ] && MSG="$MSG
建议: ${HB_ADVICE}"
    [ "${HB_HAS_OUTPUT:-}" = "1" ] && MSG="$MSG
（工作区有未提交产出，建议核查而非重派）"
    if [ -n "${HB_SUPPRESSED_IDS:-}" ]; then
      MSG="$MSG
(60s window: ${HB_SUPPRESSED:-?} more tasks suppressed: ${HB_SUPPRESSED_IDS})"
    elif [ -n "${HB_SUPPRESSED:-}" ]; then
      MSG="$MSG
(60s window: ${HB_SUPPRESSED} more tasks suppressed)"
    fi
    MSG="$MSG
详情: harness_status taskId=${HB_TASK_ID:-(no task id)}"
    ;;
esac

if [ -z "$TARGET" ] || [ -z "$OPENCLAW_BIN" ]; then
  exit 0
fi
"$OPENCLAW_BIN" message send --channel "$CHANNEL" --target "$TARGET" --message "$MSG" >/dev/null 2>&1 || true
