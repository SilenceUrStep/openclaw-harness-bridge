#!/usr/bin/env bash
# harness-bridge 随包告警分流脚本（v0.4.4，notifyCommand 推荐指向本脚本）
# 用法：notifyCommand 配置为 "bash <插件目录>/scripts/hb_notify.sh"
# 机器相关值经环境变量注入（不写入脚本）：
#   HB_NOTIFY_TARGET   必填，openclaw message send --target 的值（未设置则跳过发送，仅渲染不报错）
#   HB_NOTIFY_CHANNEL  可选，默认 openclaw-weixin
#   HB_NOTIFY_BIN      可选，默认 PATH 中的 openclaw
# 事件类型按 HB_ALERT 分流（每类事件的环境变量清单见 README "Alert channels"）：
#   task_failed（默认）: HB_TASK_ID / HB_HARNESS / HB_STATUS / HB_EXIT_CODE / HB_SESSION_ID /
#                        HB_LOG_FILE / HB_FAIL_REASON / HB_SUPPRESSED / HB_ADVICE / HB_HAS_OUTPUT
#   selfcheck:          HB_SELFCHECK / HB_HOST_VERSION / HB_DETAIL / HB_TIME
#   health_change:      HB_ADAPTER / HB_STATE / HB_PREV_STATE / HB_DETAIL / HB_TIME
#   task_stall:         HB_TASK_ID / HB_SESSION_ID / HB_DETAIL / HB_TIME
#   task_success:       HB_TASK_ID / HB_HARNESS / HB_DURATION / HB_COST_TOKENS(如有) / HB_TIME
set -u

OPENCLAW_BIN="${HB_NOTIFY_BIN:-$(command -v openclaw 2>/dev/null || true)}"
TARGET="${HB_NOTIFY_TARGET:-}"
CHANNEL="${HB_NOTIFY_CHANNEL:-openclaw-weixin}"

ALERT="${HB_ALERT:-task_failed}"

case "$ALERT" in
  selfcheck)
    MSG="[harness自检] 宿主 ${HB_HOST_VERSION:-?}
结果: ${HB_SELFCHECK:-?}
${HB_DETAIL:-}
时间: ${HB_TIME:-?}"
    ;;
  health_change)
    MSG="[harness探活] ${HB_ADAPTER:-?}: ${HB_PREV_STATE:-?} → ${HB_STATE:-?}
${HB_DETAIL:-}
时间: ${HB_TIME:-?}"
    ;;
  task_stall)
    MSG="[harness告警] 任务停滞（连续核查无进展）
任务: ${HB_TASK_ID:-?}
${HB_DETAIL:-}
时间: ${HB_TIME:-?}"
    ;;
  task_success)
    MSG="[harness通知] 长任务完成
任务: ${HB_HARNESS:-?} · ${HB_TASK_ID:-?}
时长: ${HB_DURATION:-?}"
    [ -n "${HB_COST_TOKENS:-}" ] && MSG="$MSG
Tokens: ${HB_COST_TOKENS}"
    MSG="$MSG
时间: ${HB_TIME:-?}"
    ;;
  *)
    MSG="[harness告警] 任务失败
任务: ${HB_HARNESS:-?} · ${HB_TASK_ID:-?}
状态: ${HB_STATUS:-?}  退出码: ${HB_EXIT_CODE:-?}
日志: ${HB_LOG_FILE:-无}"
    [ -n "${HB_FAIL_REASON:-}" ] && MSG="$MSG
原因: ${HB_FAIL_REASON}"
    [ -n "${HB_ADVICE:-}" ] && MSG="$MSG
建议: ${HB_ADVICE}"
    [ "${HB_HAS_OUTPUT:-}" = "1" ] && MSG="$MSG
（工作区有未提交产出，建议核查而非重派）"
    if [ -n "${HB_SUPPRESSED:-}" ]; then
      MSG="$MSG
（60s窗口内另有 ${HB_SUPPRESSED} 个同harness失败已合并，细节用 harness_status 查）"
    fi
    ;;
esac

if [ -z "$TARGET" ] || [ -z "$OPENCLAW_BIN" ]; then
  exit 0
fi
"$OPENCLAW_BIN" message send --channel "$CHANNEL" --target "$TARGET" --message "$MSG" >/dev/null 2>&1 || true
