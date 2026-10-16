# RFC v0.3: harness-bridge — 从 CLI 编排到 SDK 级管理

> 状态：草案 · 作者：李冠华 & Jarvis · 日期：2026-10-16
> 前置：v0.1 RFC（docs/RFC.md）已落地为 v0.1/v0.2 并发布 ClawHub（4+1 工具、4 adapter、参数字典同步）
> 本文基于对 OpenCode v1.18.10 与 DeepSeek Harness (dsh) 0.2.1-alpha.3 的源码级分析，定义 v0.3 演进设计

---

## 1. 现状与升级动机

### 1.1 v0.1/v0.2 已交付

- 工具：`harness_list` / `harness_sync_models` / `harness_run` / `harness_status` / `harness_mount`
- 接入：全部走 **CLI spawn**（argv 数组模板，防 shell 注入）
- 台账：JSON Lines，记录退出码 + 产出路径
- 生产验证：62 处模型参数漂移写回收敛、90+ 模型参数字典、6 provider

### 1.2 CLI spawn 模式的天花板（源码分析实锤）

| 痛点 | 证据 |
|------|------|
| 每任务冷启动整棵插件树 | opencode run 每次起 Bun 进程 + 加载配置；dsh headless 同样冷启动 profile 组合树 |
| 只有退出码，无过程 | opencode 非交互权限默认自动 reject，工具静默失败、退出码仍为 0——**只看退出码会把失败当成功** |
| 无成本数据 | opencode SQLite session 表有 cost/tokens 全套累计值，CLI 模式拿不到 |
| 无限流可见性 | opencode session.status 的 retry 事件（attempt/next.attempt/reason）CLI 模式不可见 |
| 会话操作受限 | fork/title/variant 等能力 CLI 有但编排层无法组合进台账 |

**结论**：两家 harness 的官方设计路径都是 SDK/编程接入（opencode：HTTP API + 生成式 SDK；dsh：stdio JSON-RPC SDK）。v0.3 跟进，把插件从「进程编排」升级为「SDK 级管理」。

---

## 2. 核心设计一：Transport 抽象层

Adapter schema v2 新增 `transport` 字段，三种模式并存，**缺省 `cli` 保持向后兼容**：

```json
{
  "id": "opencode",
  "transport": {
    "type": "http",
    "baseUrl": "http://127.0.0.1:4096",
    "auth": { "type": "basic", "usernameEnv": "OPENCODE_SERVER_USERNAME", "passwordEnv": "OPENCODE_SERVER_PASSWORD" },
    "directoryHeader": "x-opencode-directory",
    "healthCheck": { "method": "GET", "path": "/session", "expectStatus": 200 }
  }
}
```

| type | 适用 harness | 机制 |
|------|--------------|------|
| `cli` | 任意（兜底） | spawn argv 模板，v0.1 行为不变 |
| `http` | opencode（serve 模式）、任何暴露 HTTP API 的 harness | 长驻 server 直调，prompt_async + SSE |
| `stdio-rpc` | dsh（`dsh --profile sdk`）、ACP 类 | 常驻子进程 + JSON-RPC，多会话复用一进程 |

设计原则：
- **transport 与工具解耦**：`harness_run` 等五个工具不感知 transport 差异，由 adapter 驱动层分发
- **健康检查进 adapter**：`harness_list` 的健康状态从「二进制存在 + 版本号」升级为「transport 探活」
- **降级链**：http 探活失败 → 自动回落 cli 模式并在台账标记 `transport_fallback`

---

## 3. 核心设计二：opencode adapter v2（HTTP 直调）

### 3.1 调用模型

```
harness_run(task)
  → POST /session                    （带 title，可选 fork 自源会话）
  → POST /session/:id/prompt_async   （提交即返回 messageId，不阻塞）
  → 订阅 GET /event (SSE)，按 sessionID 过滤
  → session.status=idle → 结算 → 通知
```

- **prompt_async 替代同步 prompt**：长任务不占 gateway 连接；轮询 `GET /session/:id/status` 或纯 SSE 驱动
- **单 server 多项目**：每个请求带 `x-opencode-directory` 头路由到对应工作区实例——一个 serve 进程服务多个仓库
- **SSE 生命周期**：断线自动重连（指数退避），重连后用 `GET /session/:id/message` 补拉缺口，台账不丢事件

### 3.2 事件级台账（本版本最关键升级）

订阅 `--format json` 同源的事件流，每类事件的处理策略：

| 事件 | 台账动作 |
|------|----------|
| `step_start/step_finish` | 记录步骤序号与耗时 |
| `tool_use`（completed/error） | 记录 tool 名、input 摘要、output 摘要、error 详情——**失败归因到具体工具调用** |
| `text` | 末条文本存为 `final_response` |
| `error` | 显式记为失败原因（不再依赖退出码） |
| `session.status=retry` | 记录限流事件（attempt/reason/next.attempt），触发等待或告警 |
| `permission.asked → denied` | **显性记录权限拒绝**——这是 CLI 模式下静默失败的根源，必须可见 |

### 3.3 成本核算

任务结算时从 session 数据读取：`cost`、`tokens_input/output/reasoning/cache_read/cache_write`，写入台账聚合列。`harness_status` 支持按 harness/时间窗汇总成本。

### 3.4 会话管理能力

- **fork-before-retry**：重试失败任务时先 `POST /session/:id/fork` 复制会话再续跑，原会话历史不被污染——幂等重试的基础设施
- **title 规范**：`{任务标识}; {步骤}`（如 `CHNLNETCOR-33413; 接口评估`），台账按 title 前缀检索
- **variant 分层**：adapter/任务级可指定 reasoning effort（简单任务 minimal 档省 token）
- **agent 选择**：纯查询任务可路由到 `explore` agent（只读、快速）

### 3.5 安全模型（生产红线）

- 禁用 `--auto`/`--yolo` 等价物（自动批准全部权限）；HTTP 模式下通过 config `permission` ruleset 显式声明
- 学 opencode run 的默认注入：非交互场景 `question: deny`，未显式 allow 的写操作走 ask → 台账记录等待人工
- serve 必须配 Basic Auth（无密码时 opencode 会警告，adapter 健康检查直接判 unhealthy）

---

## 4. 核心设计三：dsh adapter（stdio JSON-RPC）

### 4.1 调用模型

```
spawn `dsh --profile sdk`（专用 DSH_HOME）
  → initialize {cwd, provider, model, reasoningEffort, maxTokens}
  → session/prompt {sessionId, contentBlocks} → {messageId}
  → 通知流：session.event（全量信封）/ session.status / subagent.started / subagent.finished
  → session/wait {sessionId}（等会话及受管后代全部结束）
  → shutdown
```

- **多会话复用一进程**：一个 sdk 子进程承载多个 session/prompt，摊薄冷启动
- **专用 DSH_HOME**：`DSH_HOME` env 指向插件数据目录下隔离环境，绝不碰用户交互式 `~/.dsh`（profile/凭证隔离）
- **headless 兜底**：`dsh headless --json` NDJSON 事件流作为零依赖集成路径（事件有界：单字符串 8KB/单事件 32KB，截断标记 `truncated: true`）

### 4.2 版本协商（pre-stable 风险对策）

dsh 官方明示 pre-stable：alpha 间隔内就有 10 项破坏性变更，TS SDK 与 dsh 二进制**精确同版本锁**。对策：

1. adapter 声明 `maxSupportedVersion` 与 `minSupportedVersion`；`initialize` 返回的 `serverInfo.version` 落在区间外 → 拒绝启动并在 `harness_list` 标红，**不静默尝试**
2. `session.event` 信封做线界验证（malformed → 记台账 protocol_error，不崩插件）
3. 升级 dsh 时同步升 adapter 的协议快照（事件类型/字段枚举），CI 加协议快照 diff 检查

### 4.3 stdout 纯度契约

SDK/ACP 模式下 stdout 严格保留协议帧——adapter 读取时校验每行均为合法 JSON，发现污染帧记 warning 并跳过（官方已知用户插件可能污染 stdout）。

---

## 5. 核心设计四：台账升级（JSON Lines → SQLite）

### 5.1 存储选型

借鉴 opencode 自身的存储设计（SQLite WAL 单文件 + 聚合列与 JSON 明细列混合）：

```sql
CREATE TABLE task (
  id TEXT PRIMARY KEY,            -- tsk_ULID
  harness TEXT NOT NULL,
  transport TEXT NOT NULL,        -- cli | http | stdio-rpc
  session_id TEXT,
  title TEXT,                     -- {任务标识}; {步骤}
  status TEXT NOT NULL,           -- queued|running|succeeded|failed|cancelled|waiting_permission
  exit_code INTEGER,              -- cli 模式保留；sdk 模式为 NULL
  fail_reason TEXT,               -- 事件流归因（tool error / permission denied / protocol error）
  cost REAL, tokens_input INTEGER, tokens_output INTEGER,
  tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER,
  fallback_used INTEGER DEFAULT 0, -- transport 降级标记
  time_created TEXT, time_started TEXT, time_finished TEXT
);

CREATE TABLE task_event (
  task_id TEXT REFERENCES task(id),
  seq INTEGER,
  type TEXT NOT NULL,             -- step|tool_use|text|error|status|permission|retry
  payload TEXT NOT NULL,          -- JSON（input/output 摘要截断至 2KB）
  ts TEXT NOT NULL,
  PRIMARY KEY (task_id, seq)
);
```

- WAL + busy_timeout，单写者（gateway 进程内串行写），读多写少
- 保留策略：task 明细 90 天，task_event 30 天，`harness_status` 提供 vacuum 子命令
- **与官方机制对齐**：issue #172583 官方反馈将「插件级 SQLite 状态存储」列为候选能力——若官方 API 落地，存储层切换为官方实现，表结构保持不变

### 5.2 查询能力

`harness_status` 升级：
- 按任务/harness/状态/时间窗过滤
- 成本汇总（按 harness/按天）
- 失败归因视图：最近 N 个失败任务的 fail_reason 分布（tool error vs permission vs 限流）
- `--events <taskId>`：输出单任务事件时间线

---

## 6. 核心设计五：配置覆盖链（镜像 dsh 四层组合）

dsh 的 bundle → profile → $DSH_HOME → --patch 四层覆盖链是配置驱动的精髓，adapter 配置解析镜像为四级：

```
adapter 内置 defaults
  → 插件全局 config（openclaw.json harness-bridge 段）
    → adapter 文件声明
      → harness_run 任务级参数
```

- 覆盖语义：**按 key 整体替换，不做深合并**（dsh patch 同款语义，避免「部分覆盖」产生的隐式组合）
- 数组类字段（如 env）显式声明 `merge: true` 才合并
- `harness_list --dump-config <id>` 打印某 adapter 的最终生效组合树（对应 dsh --dump-config），排障用

---

## 7. Adapter Schema v2 全貌（opencode 示例）

```json
{
  "id": "opencode",
  "displayName": "OpenCode",
  "schemaVersion": 2,
  "transport": {
    "type": "http",
    "baseUrl": "http://127.0.0.1:4096",
    "auth": { "type": "basic", "usernameEnv": "OPENCODE_SERVER_USERNAME", "passwordEnv": "OPENCODE_SERVER_PASSWORD" },
    "directoryHeader": "x-opencode-directory",
    "fallback": { "type": "cli" }
  },
  "delegate": {
    "createSession": { "method": "POST", "path": "/session", "titleField": "title" },
    "fork": { "method": "POST", "path": "/session/{sessionId}/fork" },
    "promptAsync": { "method": "POST", "path": "/session/{sessionId}/prompt_async" },
    "status": { "method": "GET", "path": "/session/{sessionId}/status" },
    "events": { "type": "sse", "path": "/event", "filterBy": "sessionID" },
    "cli": {
      "run": ["opencode", "run", "--format", "json", "{prompt}"],
      "resume": ["opencode", "run", "-s", "{sessionId}", "{prompt}"]
    }
  },
  "events": {
    "map": {
      "tool_use": "tool_use", "text": "text", "error": "error",
      "session.status": "status", "permission.asked": "permission"
    },
    "costFields": { "cost": "cost", "tokens": ["tokens_input", "tokens_output", "tokens_reasoning", "tokens_cache_read", "tokens_cache_write"] }
  },
  "session": { "idPattern": "ses_[a-zA-Z0-9]+", "titleTemplate": "{taskKey}; {step}" },
  "config": { "modelConfig": { "...": "v0.1 字段不变" } },
  "mount": { "...": "v0.1 字段不变" }
}
```

dsh adapter 同构，`transport.type: "stdio-rpc"` + `versionGate: { min: "0.2.1", max: "0.3.x" }`。

---

## 8. 分期落地

| 版本 | 范围 | 验收标准 |
|------|------|----------|
| **v0.3.0** | transport 抽象 + opencode HTTP adapter + SQLite 台账（事件级） | 真实编码任务经 HTTP 直调完成；台账含 tool_use 事件与 fail_reason；cli 模式回归不破 |
| **v0.3.1** | 成本核算 + fork-before-retry + title/variant 会话管理 + SSE 断线补拉 | harness_status 出成本报表；重试不污染原会话；断网 30s 恢复后台账无缺口 |
| **v0.3.2** | dsh stdio-rpc adapter + 版本协商 + headless 兜底 | dsh 任务跑通 session/resume；版本越界显性拒绝 |
| **v0.4+** | 路由策略（按任务类型/成本选 harness）、skill 分发、官方 SQLite 状态存储切换 | 另立 RFC |

---

## 9. 兼容性承诺

1. `cli` transport 永久保留为合法选项——无 serve/SDK 的 harness 零门槛接入
2. adapter schema v1 文件继续可用（无 transport 字段 = cli 模式），加载时打 upgrade hint
3. JSON Lines 旧台账只读保留，不强制迁移；新台账双写期（v0.3.0）后切换
4. 五个既有工具的工具签名不变，`harness_status` 只增参数不改语义

---

## 10. 开放问题

1. **官方 SQLite 状态存储的时点**：自管 SQLite 先行，还是等官方 API？（倾向：先行，表结构按可迁移设计）
2. **SSE 长连接在 gateway 内的资源占用**：多 harness 并发订阅的上限与背压策略
3. **dsh 跟版成本**：精确同版本锁意味着每次 dsh 发版都要动 adapter——是否值得为它做 CI 级协议兼容测试，还是社区按需跟进？
4. **opencode DB 并发**：多 harness 进程共享同一 opencode.db 依赖 busy_timeout=5000，桥接层只读不写可规避，需在文档中明确
5. **权限 ask 的人工交互面**：waiting_permission 状态的通知与批准通道（OpenClaw 消息交互 or 仅记录等人工登终端处理）

---

## 11. 本次源码分析的可复用结论（附）

- opencode：HTTP API 是唯一契约（TUI 也只是 HTTP 客户端）；`opencode generate` 可输出 OpenAPI spec，adapter 的 HTTP 调用面可据其生成类型
- dsh：`dsh --dump-config` / `--dump-config-schema` 可程序化读取组合树，modelSync 未来可对接
- 两家都验证了同一趋势：**harness 的终局是「长驻服务 + 事件流 + 结构化会话存储」**，CLI 只是入口之一。harness-bridge 押注事件流与台账，方向与生态一致
