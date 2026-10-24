# openclaw-plugin-harness-bridge

Register, configure, delegate and monitor coding-agent harnesses (OpenCode, Claude Code, Codex CLI, …) from your OpenClaw assistant.

> **Status**: v0.4.2 running in production · RFC under community review — [openclaw/openclaw#172583](https://github.com/openclaw/openclaw/issues/172583)
>
> Design background and the community discussion draft: [docs/RFC.md](docs/RFC.md) (v0.1) · [docs/RFC-v0.3.md](docs/RFC-v0.3.md) (v0.3: SDK-level management) · [中文文档](README.zh-CN.md)

## Positioning

OpenClaw already ships three layers for integrating external agents (Agent Harness SDK / CLI backend / Tool plugin). This plugin covers the **task-level orchestration layer** they don't: your AI assistant becomes the control plane for multiple harnesses — check status, sync model configs, delegate tasks, track progress, and keep a durable ledger.

- Official layers solve "OpenClaw sessions running ON a harness" (conversation-level)
- This plugin solves "the assistant directing harnesses to do work" (task-level)

## Installation

From ClawHub:

```bash
openclaw plugins install clawhub:openclaw-plugin-harness-bridge
```

Or from a local checkout:

```bash
openclaw plugins install /path/to/openclaw-plugin-harness-bridge
```

Then restart the gateway and verify:

```bash
openclaw gateway restart
openclaw plugins inspect harness-bridge --runtime
```

## Quick start

**Out of the box (zero config):**

- Data directory `~/.openclaw/harness-bridge` is created automatically (SQLite ledger + task logs)
- All five tools are available immediately — run `harness_list` to see every adapter's health
- The v0.4 status line is on by default: every outbound reply gets a `后台任务：…` (background tasks) line built from the ledger

**Optional setup (openclaw.json → plugins.entries["harness-bridge"].config):**

- `taskboardFile` — merge a markdown taskboard's "in progress" section into the status line
- `notifyCommand` — run a shell command when a background task finishes (webhook / push notification)
- Adapter credentials — e.g. the OpenCode HTTP transport reads `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD` from the gateway environment

**First delegation:**

```
harness_run { "harness": "opencode", "prompt": "..." }   // background + ledger by default
harness_status { }                                        // poll progress / results
```

## Tools

| Tool | Purpose |
|------|---------|
| `harness_list` | List registered harnesses and their health (binary / version / config-file presence) |
| `harness_sync_models` | Calibrate each harness's model config against a shared parameter dictionary (report / field-level merge write-back / default-model switch) |
| `harness_run` | Delegate a task (background + ledger by default; `wait=true` for synchronous runs) |
| `harness_status` | Query the task ledger (status / exit code / session id / duration / output tail) |
| `harness_mount` | Mount a shared knowledge directory into a harness (`external_directory` allow + `instructions` injection; dry-run/apply, idempotent) |

## What's new in v0.4.2

- **Auto dispatch logging** — `before_tool_call`/`after_tool_call` hooks: every background `harness_run` dispatch is auto-logged to the taskboard's "🤖 自动登记" section (pending entry → bound taskId → lazy prune on completion). Cures "promised but untracked"; fail-open throughout.
- **Notify delivery retry** — failure notifications retry up to 3 attempts (3s apart), surviving the WeChat 20-minute reconnect windows that used to silently drop alerts.
- **Metrics persistence** — sampler ring buffer persisted hourly + restored on startup + flushed on gateway stop; observation data survives restarts.

## What's new in v0.4.1

- **Per-turn task injection** — an `agent_turn_prepare` hook injects the running-task list into every turn (zero injection when idle).
- **Proactive failure alerts** — failed/timed-out tasks push a WeChat alert via `notifyCommand`, with a per-harness 60s throttle (suppressed counts carried into the next alert).
- **Performance** — taskboard mtime cache (30s TTL) + status-line soft time budget (50ms).
- **Metrics sampler** — memory/heap/event-loop p99 sampled every minute into a 24h ring buffer; query via `harness_status metrics=true`; heap-pressure check (85% threshold).
- **Ledger auto-cleanup** — `task_event` rows older than 30 days pruned automatically.
- New config keys: `turnPrepareEnabled`, `metricsEnabled`, `eventRetentionDays`, `notifyCommand`.

## What's new in v0.4

- **Session-transparency status line** — a `message_sending` hook appends a `后台任务：…` (background tasks) line to every outbound reply. Sources: running tasks from the SQLite ledger (with pid liveness check, dead processes dropped) plus an optional markdown taskboard section. Hand-written status lines are respected (no duplication), `MEDIA:` directives stay on their own line, `NO_REPLY` / empty messages are skipped, and the hook is fail-open — a status-line failure never blocks message delivery.
- New config keys: `statusLineEnabled` (default on) and `taskboardFile`.

## What's new in v0.3

- **Transport abstraction** — adapters declare `cli`, `http`, or `stdio-rpc` transports (schema v2; no `transport` field = `cli`, fully backward compatible). HTTP health-probe failure auto-falls back to `cli` (`fallback_used=1` in the ledger).
- **OpenCode HTTP runner** — talks to a long-running `opencode serve` directly: `POST /session` → `prompt_async` → SSE event stream → idle settlement. Last-Event-ID resume with exponential backoff, per-event ledger entries, cost/token accounting, fork endpoint for idempotent retries.
- **Event-level SQLite ledger** — `task` + `task_event` tables (WAL, `busy_timeout`), automatic column migration for older databases; the legacy JSONL ledger is kept read-only. `harness_status --events <taskId>` prints a full event timeline; cost summary included.
- **dsh adapter** — DeepSeek Harness over stdio JSON-RPC: one resident process multiplexes sessions, isolated `DSH_HOME`, version negotiation against the real binary (`dsh --version`; the handshake's wire-stable version is recorded but not gated), headless NDJSON fallback.
- **fork-before-retry** — `harness_run retryOf=<taskId>` forks the failed task's session first, so retries never pollute the original session.

## Declarative adapters

Built-in: `opencode` (production-verified) / `claude-code`, `codex` (community stubs) / `echo` (smoke-test example).

Adding a new harness takes one JSON file — drop it into the plugin data directory `adapters/` to override a built-in of the same name, **no plugin code changes**:

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

The `mount` block declares the knowledge-directory mounting mechanism: `harness_mount` uses it to write a knowledge directory into the harness config (`external_directory` allow + optional `instructions` entry-file injection). Dry-run by default, `apply=true` to write back — reusing field-level merge + timestamped backup + post-write validation. Repeated mounts are skipped (idempotent).

## Configuration (openclaw.json → plugins.entries["harness-bridge"].config)

| Key | Default | Description |
|-----|---------|-------------|
| `dataDir` | `~/.openclaw/harness-bridge` | Ledger / task logs / user adapters |
| `adaptersDir` | `<dataDir>/adapters` | Extra adapter directory (overrides built-ins by filename) |
| `paramsFile` | built-in dictionary | Model parameter dictionary (exact / prefix / defaults 3-tier matching + skip_patterns) |
| `notifyCommand` | none | Shell command executed when a background task finishes (env: `HB_TASK_ID` / `HB_HARNESS` / `HB_STATUS` / `HB_EXIT_CODE` / `HB_SESSION_ID` / `HB_LOG_FILE`) |
| `defaultTimeoutMs` | 600000 | Default timeout for `harness_run` |
| `statusLineEnabled` | `true` | v0.4 — append a background-tasks status line to every outbound reply |
| `taskboardFile` | none | v0.4 — markdown taskboard whose "in progress" section feeds the status line |

## Ledger and logs

- Ledger: `<dataDir>/ledger.db` — SQLite (WAL) with `task` + `task_event` tables; event-level detail (step / tool_use / text / error / status / retry / permission) with per-field 2KB payload truncation; older JSONL ledgers migrate automatically and are kept read-only (`harness_status legacy=true` still reads them)
- Task logs: `<dataDir>/tasks/<taskId>.log` (full stdout + stderr)
- When `harness_status` finds a running task whose process is gone with no exit record, it marks the task `lost`

## Write-back discipline (sync_models apply=true)

Field-level merge (only writes dictionary-provided keys, never touches your hand-tuned fields) + timestamped backup (`*.bak.hb-<ts>`) + post-write validation (the tmp file must parse fully before the atomic replace).

## Development

```bash
npm install
npm run plugin:build     # tsc + generate manifest metadata
npm run plugin:validate
npm test
```

Install into your gateway locally:

```bash
openclaw plugins install /path/to/this/plugin
openclaw plugins inspect harness-bridge --runtime
```

## License

MIT
