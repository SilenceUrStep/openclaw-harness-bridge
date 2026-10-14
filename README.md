# openclaw-plugin-harness-bridge

Register, configure, delegate and monitor coding-agent harnesses (OpenCode, Claude Code, Codex CLI, …) from your OpenClaw assistant.

> **Status**: MVP v0.2 running in production · RFC under community review — [openclaw/openclaw#172583](https://github.com/openclaw/openclaw/issues/172583)
>
> 设计背景与社区讨论稿见 [docs/RFC.md](docs/RFC.md)

## 定位

OpenClaw 官方已有三层接入外部 agent 的机制（Agent Harness SDK / CLI backend / Tool plugin）。
本插件是官方尚未覆盖的**任务级编排层**：AI 助手作为多 harness 的控制平面——
查状态、同步模型配置、委派任务、跟踪进度、沉淀台账。

- 官方解决「OpenClaw 会话跑在 harness 上」（对话级）
- 本插件解决「OpenClaw 助手指挥 harness 干活」（任务级）

## 工具（MVP v0.1）

| 工具 | 作用 |
|------|------|
| `harness_list` | 列出已注册 harness 及健康状态（二进制/版本/配置文件存在性） |
| `harness_sync_models` | 按统一参数字典校准各 harness 模型配置（报告 / 字段级 merge 写回 / 切默认模型） |
| `harness_run` | 委派任务（默认后台执行 + 台账；`wait=true` 同步等待） |
| `harness_status` | 查询任务台账（状态/退出码/会话 ID/耗时/输出尾部） |

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
    }
  },
  "session": { "idPattern": "ses_[a-zA-Z0-9]+" }
}
```

## 配置（openclaw.json → plugins.entries["harness-bridge"].config）

| 键 | 默认 | 说明 |
|----|------|------|
| `dataDir` | `~/.openclaw/harness-bridge` | 台账 / 任务日志 / 用户 adapter |
| `adaptersDir` | `<dataDir>/adapters` | 额外 adapter 目录（覆盖内置同名文件） |
| `paramsFile` | 内置字典 | 模型参数字典（exact/prefix/defaults 三级匹配 + skip_patterns） |
| `notifyCommand` | 无 | 后台任务完成时执行的 shell 命令（env: `HB_TASK_ID`/`HB_HARNESS`/`HB_STATUS`/`HB_EXIT_CODE`/`HB_SESSION_ID`/`HB_LOG_FILE`） |
| `defaultTimeoutMs` | 600000 | `harness_run` 默认超时 |

## 台账与日志

- 台账：`<dataDir>/ledger.jsonl`，追加式 JSONL，同一任务多条记录按 id 取最新（崩溃安全）
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
