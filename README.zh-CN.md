# openclaw-plugin-harness-bridge

[English](README.md) · 中文

从 OpenClaw 助手注册、配置、委派并监控多个编码 agent harness（OpenCode、Claude Code、Codex CLI 等）。

> **状态**：v0.4.0 生产运行中 · RFC 社区评审中 — [openclaw/openclaw#172583](https://github.com/openclaw/openclaw/issues/172583)
>
> 设计背景与社区讨论稿见 [docs/RFC.md](docs/RFC.md)（v0.1）· [docs/RFC-v0.3.md](docs/RFC-v0.3.md)（v0.3：SDK 级管理）

## 定位

OpenClaw 官方已有三层接入外部 agent 的机制（Agent Harness SDK / CLI backend / Tool plugin）。
本插件是官方尚未覆盖的**任务级编排层**：AI 助手作为多 harness 的控制平面——
查状态、同步模型配置、委派任务、跟踪进度、沉淀台账。

- 官方解决「OpenClaw 会话跑在 harness 上」（对话级）
- 本插件解决「OpenClaw 助手指挥 harness 干活」（任务级）

## 安装

从 ClawHub 安装：

```bash
openclaw plugins install clawhub:openclaw-plugin-harness-bridge
```

或从本地目录安装：

```bash
openclaw plugins install /path/to/openclaw-plugin-harness-bridge
```

重启网关并验证：

```bash
openclaw gateway restart
openclaw plugins inspect harness-bridge --runtime
```

## 快速开始

**开箱即用（零配置）：**

- 数据目录 `~/.openclaw/harness-bridge` 自动创建（SQLite 台账 + 任务日志）
- 五个工具立即可用——跑 `harness_list` 查看各 adapter 健康状态
- v0.4 状态行默认开启：每条出站回复自动追加「后台任务：…」状态行（数据来自台账）

**可选配置（openclaw.json → plugins.entries["harness-bridge"].config）：**

- `taskboardFile` — 把 markdown 任务台账的「进行中」段合并进状态行
- `notifyCommand` — 后台任务完成时执行 shell 命令（webhook / 推送通知）
- adapter 凭证 — 如 OpenCode HTTP transport 从网关环境变量读 `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD`

**第一次委派：**

```
harness_run { "harness": "opencode", "prompt": "..." }   // 默认后台执行 + 台账
harness_status { }                                        // 查进度 / 结果
```

## 工具

| 工具 | 作用 |
|------|------|
| `harness_list` | 列出已注册 harness 及健康状态（二进制/版本/配置文件存在性） |
| `harness_sync_models` | 按统一参数字典校准各 harness 模型配置（报告 / 字段级 merge 写回 / 切默认模型） |
| `harness_run` | 委派任务（默认后台执行 + 台账；`wait=true` 同步等待） |
| `harness_status` | 查询任务台账（状态/退出码/会话 ID/耗时/输出尾部） |
| `harness_mount` | 把共享知识库目录挂载进 harness（external_directory 放行 + instructions 注入；dry-run/apply，幂等） |

## v0.4.4 新特性

- **taskType 感知默认超时** — 未显式传 `timeoutMs` 时按任务类型取默认：coding → 45 分钟，general/analysis/search → 10 分钟，无 taskType → 10 分钟（保持现状）。可用 `defaultTimeoutByTaskType` 配置覆盖。实际生效值与来源（`explicit` / `taskType_default` / `global_default`）记入台账 task 行（`timeout_ms` / `timeout_source` 列）并记 `timeout_resolved` 事件；cli / dsh / http 三路统一解析。
- **长任务完成通知** — 成功不再静默：任务时长达到 `successNotifyMinDurationMs`（默认 300000=5 分钟；≤0 禁用）时推送一次性 `HB_ALERT=task_success` 通知（不参与失败节流，同一任务只发一次）。短任务成功维持静默。
- **globalWorkspace 全局兜底工作空间** — 工作区语义反转：编码任务默认在目标项目文件夹（推荐显式传 `cwd`）；不传时用配置的 `globalWorkspace` 兜底；仍未配置则用 serve 进程默认目录（不再兜底插件数据目录）。实际生效 cwd 与来源（`explicit` / `globalWorkspace` / `serve_default`）记入台账 task 行（`cwd` 列）并记 `workspace_resolved` 事件。
- **告警通道收口** — 告警分发脚本随包分发（`scripts/hb_notify.sh`），机器相关值经环境变量注入（`HB_NOTIFY_TARGET` / `HB_NOTIFY_CHANNEL` / `HB_NOTIFY_BIN`），不再散落外部。详见「告警通道」小节。
- **WAL 定期 checkpoint** — 台账每小时执行 `PRAGMA wal_checkpoint(TRUNCATE)`（失败 fail-open），防长驻进程 WAL 无限膨胀；`checkpoint` 事件记录 WAL 页数。
- **opencode 版本探测修复** — 新版 SDK 版本端点为 `GET /global/health`（旧 `/version` 已变成网页 SPA HTML）。探测顺序：显式 `versionPath` → `/global/health` → `/version`，纯文本仅在形似版本时采信；确实拿不到时显性输出「版本探测不可用」而非含糊的「未知」。
- **dsh 进程判定器** — dsh 超时不再直接判死：先查进程存活——已退 → 按退出码结算（0=success 非 0=failed）；存活但 RPC 连续 N 次探活无响应（默认 3，复用 `sessionCheckMaxRetries`）→ 标记 stalled 并告警（不自动杀进程，人工介入）；恢复响应 → 正常结算。opencode 会话核查判定器与 dsh 进程判定器并列，runner 层只按 transport 调度。

## v0.4.2 新特性

- **派发自动登记** — `before_tool_call`/`after_tool_call` 双钩子：`harness_run` 派发时自动往 taskboard「🤖 自动登记」段写条目（pending → 绑定 taskId → 终态惰性清理），治承诺悬空，全链路 fail-open。
- **告警送达兑底** — 失败通知重试穿透（最多 3 次尝试，间隔 3s），微信 20 分钟重连窗口内不再静默丢告警。
- **观测数据落盘** — 采样器环形缓冲每小时持久化 + 启动恢复 + 网关停止 flush，重启后观测数据不断档。

## v0.4.1 新特性

- **回合任务注入** — `agent_turn_prepare` hook 每回合注入后台任务清单（无任务零注入），治承诺悬空。
- **失败主动告警** — 任务失败/超时推微信（`notifyCommand`），per-harness 60s 节流防轰炸，抑制计数并入下一条。
- **性能优化** — taskboard mtime 缓存（30s TTL）+ 状态行软超时预算（50ms）。
- **观测采样器** — 内存/堆/事件循环延迟每分钟采样，环形缓冲 24h，`harness_status metrics=true` 查询，堆压力判断（85% 阈值）。
- **台账自动清理** — `task_event` 保留 30 天自动清理。
- 新增配置键：`turnPrepareEnabled`、`metricsEnabled`、`eventRetentionDays`、`notifyCommand`。

## v0.4 新特性

- **会话透明度状态行** — `message_sending` hook 在每条出站回复末尾强制追加「后台任务：…」状态行。数据源：SQLite 台账 running 任务（pid 存活校验，死进程剔除）+ 可选 markdown 任务台账「进行中」段。AI 手写状态行时尊重原文不重复；`MEDIA:` 指令保持独立末行；`NO_REPLY`/空消息跳过；hook 全链路 fail-open——状态行失败绝不阻断消息发送。
- 新增配置键：`statusLineEnabled`（默认开）、`taskboardFile`。

## v0.3 新特性

- **Transport 抽象** — adapter 可声明 `cli` / `http` / `stdio-rpc` 三种 transport（schema v2；无 transport 字段 = cli，完全向后兼容）。HTTP 探活失败自动回落 cli（台账记 `fallback_used=1`）。
- **OpenCode HTTP runner** — 直连长驻 `opencode serve`：`POST /session` → `prompt_async` → SSE 事件流 → idle 结算。Last-Event-ID 断点续传 + 指数退避，事件级台账，成本/token 核算，fork 端点支持幂等重试。
- **事件级 SQLite 台账** — `task` + `task_event` 双表（WAL、`busy_timeout`），旧库自动补列迁移；旧 JSONL 台账只读保留。`harness_status --events <taskId>` 输出完整事件时间线，含成本汇总。
- **dsh adapter** — DeepSeek Harness 走 stdio JSON-RPC：常驻进程多会话复用、隔离 `DSH_HOME`、对真实二进制做版本协商（`dsh --version`；握手返回的 wire 版本仅记录不参与门禁）、headless NDJSON 兑底。
- **fork-before-retry** — `harness_run retryOf=<taskId>` 先 fork 失败任务的会话再续跑，重试不污染原会话。

## 声明式 Adapter

内置：`opencode`（生产验证）/ `claude-code`、`codex`（社区 stub）/ `echo`（联调示例）。

接入新 harness 只需一个 JSON 文件——放到插件数据目录 `adapters/` 即可覆盖内置同名文件，**不改插件代码**：

```json
{
  "id": "opencode",
  "displayName": "OpenCode",
  "binary": "opencode",
  "versionCheck": ["opencode", "--version"],
  "delegate": {
    "run": ["opencode", "run", "{prompt}"],
    "resume": ["opencode", "run", "-s", "{sessionId}", "{prompt}"],
    "timeoutMs": 600000
  },
  "config": {
    "modelConfig": {
      "path": "~/.config/opencode/opencode.json",
      "format": "opencode-json",
      "modelsPointer": "$.provider.*.models",
      "fieldMap": { "contextWindow": "context", "maxTokens": "maxTokensOutput" },
      "defaultModelPointer": "$.model"
    },
    "mount": {
      "configPath": "~/.config/opencode/opencode.json",
      "format": "opencode-json",
      "externalDirectoryPointer": "$.permission.external_directory",
      "instructionsPointer": "$.instructions"
    }
  },
  "session": { "idPattern": "ses_[a-zA-Z0-9]+" }
}
```

`mount` 块声明知识目录挂载机制：`harness_mount` 按它把知识库目录写进 harness 配置
（`external_directory` 放行 + 可选 `instructions` 注入入口文件），dry-run 默认，`apply=true` 写回，
复用字段级 merge + 时间戳备份 + 写后验证，重复挂载自动跳过（幂等）。

## 配置（openclaw.json → plugins.entries["harness-bridge"].config）

| 键 | 默认 | 说明 |
|----|------|------|
| `dataDir` | `~/.openclaw/harness-bridge` | 台账 / 任务日志 / 用户 adapter |
| `adaptersDir` | `<dataDir>/adapters` | 额外 adapter 目录（覆盖内置同名文件） |
| `paramsFile` | 内置字典 | 模型参数字典（exact/prefix/defaults 三级匹配 + skip_patterns） |
| `notifyCommand` | 无 | 后台任务完成时执行的 shell 命令（env: `HB_TASK_ID`/`HB_HARNESS`/`HB_STATUS`/`HB_EXIT_CODE`/`HB_SESSION_ID`/`HB_LOG_FILE`） |
| `defaultTimeoutMs` | 600000 | `harness_run` 默认超时 |
| `defaultTimeoutByTaskType` | 无 | v0.4.4 — taskType → 默认超时毫秒映射（未显式传 `timeoutMs` 时覆盖内置默认） |
| `globalWorkspace` | 无 | v0.4.4 — `harness_run` 未传 `cwd` 时的兜底工作空间；未配置则用 serve 进程默认目录 |
| `successNotifyMinDurationMs` | 300000 | v0.4.4 — 任务时长达到阈值才推成功通知（≤0 禁用） |
| `statusLineEnabled` | `true` | v0.4 — 每条出站回复追加后台任务状态行 |
| `taskboardFile` | 无 | v0.4 — markdown 任务台账「进行中」段并入状态行 |

## 告警通道（Alert channels）

所有告警走唯一的 `notifyCommand` shell 命令，事件类型经 `HB_ALERT` 环境变量区分。插件自带参考实现 `scripts/hb_notify.sh`（随包分发），推荐配置：

```json
"notifyCommand": "bash <插件目录>/scripts/hb_notify.sh"
```

机器相关值经环境变量注入（不写死在脚本里）：`HB_NOTIFY_TARGET`（必填，`--target` 的值；未设置则跳过发送）、`HB_NOTIFY_CHANNEL`（默认 `openclaw-weixin`）、`HB_NOTIFY_BIN`（默认 PATH 中的 `openclaw`）。

| `HB_ALERT` | 触发场景 | 环境变量 |
|------------|----------|----------|
| `task_failed`（默认） | 任务终态失败 / 超时 | `HB_TASK_ID` `HB_HARNESS` `HB_STATUS` `HB_EXIT_CODE` `HB_SESSION_ID` `HB_LOG_FILE` `HB_FAIL_REASON` `HB_SUPPRESSED` `HB_ADVICE` `HB_HAS_OUTPUT` |
| `task_stall` | 会话/进程停滞（连续核查无进展；不自动杀） | `HB_TASK_ID` `HB_SESSION_ID` `HB_DETAIL` `HB_TIME` |
| `task_success` | v0.4.4 — 长任务成功完成（时长 ≥ `successNotifyMinDurationMs`） | `HB_TASK_ID` `HB_HARNESS` `HB_DURATION` `HB_COST_TOKENS`（如有） `HB_TIME` |
| `health_change` | 探活状态翻转 | `HB_ADAPTER` `HB_STATE` `HB_PREV_STATE` `HB_DETAIL` `HB_TIME` |
| `selfcheck` | 升级后冒烟自检报告 | `HB_SELFCHECK` `HB_HOST_VERSION` `HB_DETAIL` `HB_TIME` |

## 台账与日志

- 台账：`<dataDir>/ledger.db` — SQLite（WAL），`task` + `task_event` 双表；事件级明细（step / tool_use / text / error / status / retry / permission），payload 字段级 2KB 截断；旧 JSONL 台账自动迁移并只读保留（`harness_status legacy=true` 仍可读）
- 任务日志：`<dataDir>/tasks/<taskId>.log`（stdout+stderr 全量）
- `harness_status` 发现 running 任务进程已消失且无退出记录时，自动标记 `lost`

## 写回纪律（sync_models apply=true）

字段级 merge（只写字典提供的键，不碰用户手工调优的其他字段）+ 时间戳备份（`*.bak.hb-<ts>`）+ 写后验证（tmp 文件可完整解析才原子替换）。

## 开发

```bash
npm install
npm run plugin:build     # tsc + 生成 manifest 元数据
npm run plugin:validate
npm test
```

本地安装到网关：

```bash
openclaw plugins install /path/to/this/plugin
openclaw plugins inspect harness-bridge --runtime
```

## License

MIT
