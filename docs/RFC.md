# RFC: openclaw-harness-bridge — 从 OpenClaw 编排多个编码 Agent Harness

> 状态：草案 v0.1 · 作者：李冠华 & Jarvis（生产环境验证后起草）
> 目标读者：OpenClaw 社区、多 harness 用户、潜在共建者

## 1. 背景与动机

AI 编码 harness 正在井喷：OpenCode、Claude Code、Codex CLI、DeepSeek Harness、Gemini CLI……
长期使用 AI 助手（OpenClaw）的用户普遍面临同一个问题：**助手是控制中心，harness 是干活的，
但两者之间没有治理层**。

我们在生产环境跑了数月的"贾维斯模式"（OpenClaw 助手编排 OpenCode 编码），验证了四个真实痛点：

1. **配置分散**：每个 harness 一套配置文件、一套模型清单、一套参数格式。换模型/切额度要改 N 处，
   改完还要逐个验证生效。
2. **委派无台账**：让 harness 干活靠手敲 CLI，任务散落在终端历史里，没有状态、没有结果沉淀、
   没有完成通知。
3. **知识不共享**：harness 各自为政，A harness 学到的项目知识 B harness 看不见。
4. **进度不可见**：长任务跑起来后，人要盯着终端；助手也不知道任务死活。

我们用一套土办法解决了这些问题（参数字典 + 声明式挂载 + CLI 委派 + 台账 + 通知），
现在想把它泛化成 OpenClaw 插件，开源共建。

## 2. 与 OpenClaw 官方机制的边界（重要）

OpenClaw 已有三层"接入外部 agent"的机制，本插件**不重复**它们：

| 官方机制 | 层次 | 定位 | 本插件关系 |
|----------|------|------|-----------|
| Agent Harness SDK（实验性） | 对话运行时 | OpenClaw 会话由外部 harness 执行（官方已内置 Codex） | 不做。对话级集成走官方 |
| CLI backend plugin | 模型推理 | 本地 CLI 作为模型 fallback 后端 | 不做。推理层走官方 |
| Tool plugin + hooks | 工具/编排 | 给 AI 助手注册工具与工作流钩子 | **本插件的落点** |

**一句话定位**：官方解决"OpenClaw 会话跑在 harness 上"（对话级），
本插件解决"OpenClaw 助手指挥 harness 干活"（任务级编排）。
两者互补：你可以一边用官方 Codex harness 跑日常对话，
一边用本插件把编码任务委派给 OpenCode/Claude Code 并跟踪进度。

## 3. 插件定位

**openclaw-harness-bridge**：Register, configure, delegate and monitor coding-agent
harnesses from your OpenClaw assistant.

- 形态：Tool plugin（注册一组 agent 工具）+ workflow hooks + 声明式 harness adapter
- 用户价值：AI 助手成为多 harness 的控制平面——查状态、同步配置、委派任务、跟踪进度、沉淀产出
- 共建价值：**加一个新 harness 只需写一个声明式 adapter 文件，不改插件代码**

## 4. 核心设计：声明式 Adapter

共建门槛是本插件成败的关键。每个 harness 的接入被抽象为一个 JSON 描述文件
（argv 数组模板，避免 shell 注入与引号地狱）：

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
  "session": {
    "idPattern": "ses_[a-zA-Z0-9]+"
  }
}
```

插件内置常用 adapter（opencode / claude-code / codex / dsh），
社区通过 PR 贡献新 adapter——**只写 JSON，不写代码**。

## 5. MVP 范围

### P0（首个可用版本）
- `harness_list`：列出已注册 harness 及健康状态（版本、配置文件存在性）
- `harness_sync_models`：模型配置同步——从各 harness 配置读取模型清单，
  按统一参数字典（contextWindow/maxTokens/reasoning）校准后回写。
  支持全量同步与单 harness 切换默认模型
- `harness_run`：委派任务——后台执行 harness CLI，台账记录
  （任务/harness/session/状态/产出路径），完成后通过 OpenClaw 消息通道通知
- `harness_status`：查询台账（运行中/已完成/失败，含产出与耗时）

### P1
- `harness_mount`：知识目录挂载管理（把共享知识库以各 harness 的方式挂载：
  OpenCode external_directory / Claude Code CLAUDE.md 引用 / 通用 AGENTS.md）
- session 台账与清理策略（周期、归档）

### P2
- skill 分发（共享 skill 源 → 各 harness 格式转换）
- 路由策略（按任务类型/成本自动选 harness）

## 6. 技术要点（基于 OpenClaw 插件机制）

- `definePluginEntry` + `api.registerTool(...)` 注册上述工具；
  manifest `contracts.tools` 声明所有权
- `configSchema` 承载 harness 注册表与全局配置；adapter 文件放插件数据目录 `adapters/`
- 长任务执行：派生后台进程 + 台账落盘（JSON），不阻塞 gateway；完成时经 hooks/消息通道通知
- 台账存储：插件数据目录下 JSON Lines（可查询、可归档）
- 发布：ClawHub（`openclaw plugins install clawhub:<pkg>`）

## 7. 落地路径

1. **RFC 讨论**（本文件）：社区反馈定位与 API 形态，确认与官方 roadmap 无冲突
2. **MVP 开发**：以生产环境（真实多 harness 用户）为首用户，P0 三工具跑通
3. **ClawHub 发布** + 文档站
4. **共建启动**：adapter 生态（目标：主流 harness 各有一个社区维护的 adapter）

## 8. 开放问题

1. 长任务的进度回传粒度：仅完成通知，还是支持 stdout 流式摘要？（倾向 MVP 只做完成通知）
2. 台账与 OpenClaw 原生 session/subagent 机制的整合度：独立台账 vs 挂靠 OpenClaw session？
3. 模型配置同步的写回策略：全量覆盖 vs 字段级 merge？（生产经验：必须字段级 merge + 备份）
4. 命名：harness-bridge / harness-deck / agent-fleet？
5. Windows/macOS 兼容（我们只在 Linux 生产验证过）

## 9. 我们带来的已验证经验

- 模型参数字典：exact（已校准）/ prefix（估算）/ default（兜底）三级匹配，
  别名去重含日期后缀归一——已在 6 个 provider、90+ 模型上运行
- 配置写回纪律：字段级 merge + 时间戳备份 + 写后验证（防止覆盖用户手工调优）
- CLI 委派教训：ACP 类常驻协议不可靠（会话连续性差），CLI 一次性 + 状态外置最稳
- 知识挂载：声明式只读挂载 + raw/ 收件箱提炼转正，避免 harness 直写知识库
