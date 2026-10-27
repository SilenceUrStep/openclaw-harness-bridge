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

## What's new in v0.4.5

- **agent-ops logging hook** — `before_tool_call` / `after_tool_call` hooks now log agent-layer tool calls (exec / edit / write / apply_patch / harness_run, etc.) to a unified ops log (default `/root/jarvisLogs/jarvis-tools.log`) in jlog format (`[agent-ops] [tool] summary + duration`). exec logs a truncated one-line command, file tools log the path, harness_run logs harness + taskId + status + duration. Read-only tools (read / ls / grep / glob / memory_search) are skipped to control noise. Fully fail-open: logging failures never block tool calls. Configurable via `agentOpsLogEnabled` (default on) and `agentOpsLogFile`.
- **dsh adapter sdk config fix** — the built-in dsh adapter shipped `sdk.provider = deepseek-official` while `modelSync` injects a `tokenhub` provider; the mismatch was masked by `DSH_PROVIDER` / `DSH_MODEL` env vars and surfaced as `initialize` failures (`paths[0] undefined`) once the gateway restarted without them. The sdk config now matches the modelSync provider (`tokenhub` / `glm-5.3-flash`).

## What's new in v0.4.4

- **taskType-aware default timeout** — when `timeoutMs` is omitted, the default is resolved per `taskType`: coding → 45 min, general/analysis/search → 10 min, none → 10 min (previous behavior). Overridable via `defaultTimeoutByTaskType` config. The effective value and its source (`explicit` / `taskType_default` / `global_default`) are recorded on the task row (`timeout_ms` / `timeout_source`) plus a `timeout_resolved` ledger event. Resolution is unified across cli / dsh / http transports.
- **Alert channel consolidation** — the alert dispatch script ships with the plugin (`scripts/hb_notify.sh`); machine-specific values are injected via `HB_NOTIFY_TARGET` / `HB_NOTIFY_CHANNEL` / `HB_NOTIFY_BIN`. See "Alert channels" below.
- **Long-task success notification** — successful tasks no longer stay silent: when the task duration reaches `successNotifyMinDurationMs` (default 300000 = 5 min; `<=0` disables), a one-shot `HB_ALERT=task_success` notification is sent (not throttled, once per task). Short successful tasks remain silent.
- **globalWorkspace fallback** — workspace semantics inverted: coding tasks run in the target project folder (pass `cwd` explicitly); when omitted, the configured `globalWorkspace` is used; when that is unset, the serve process default applies (the plugin data directory is no longer used as a fallback). The effective cwd and its source (`explicit` / `globalWorkspace` / `serve_default`) are recorded on the task row (`cwd`) plus a `workspace_resolved` ledger event.
- **Periodic WAL checkpoint** — the ledger runs `PRAGMA wal_checkpoint(TRUNCATE)` hourly (fail-open) to keep the WAL from growing unboundedly on long-running hosts; a `checkpoint` event records the WAL page stats.
- **opencode version probe fixed** — the new SDK serves versions at `GET /global/health`; the legacy `/version` endpoint now returns the web SPA HTML. The probe tries explicit `versionPath` → `/global/health` → `/version` and only accepts version-looking text; when unavailable the health detail says so explicitly ("版本探测不可用") instead of a vague "未知".
- **dsh process adjudicator** — on timeout the dsh runner now checks process liveness before settling: exited → settle by exit code (0=success, non-zero=failed); alive but RPC-unresponsive for N consecutive probes (default 3, shares `sessionCheckMaxRetries`) → mark stalled + alert, never kill automatically; responsive again → settle normally. The opencode session-check adjudicator and this process adjudicator are the two per-transport implementations; the runner layer only dispatches.

## What's new in v0.4.3

- **Capability-based routing** — adapters declare `capabilities` (e.g. opencode=`["coding"]`, dsh=`["general","analysis","search"]`); `harness_run` accepts an optional `taskType`; priority: explicit harness > taskType match > default. Declarative `routing` config with per-rule fallback chains; every routing decision is logged to the ledger.
- **Auto-retry + fallback routing** — failed tasks retry on the same harness (configurable, default 1), then fall down the configured fallback chain. Only infrastructure-class failures (probe failure / process start failure) trigger fallback; business failures alert without degrading.
- **Periodic health probing** — all registered adapters probed every 5 minutes (configurable); healthy↔unhealthy transitions push alerts via `notifyCommand` with anti-spam (no repeat alerts for a persistent fault, recovery notification on heal).
- **Host version awareness + upgrade self-check** — the plugin records the host version at startup; on change it runs a smoke self-check (adapter registration, echo round-trip, hooks confirmation) and pushes the report.
- **Enhanced binary diagnostics** — `harness_list` healthDetail now includes the current PATH, the actual binary location when findable, and the likely cause (e.g. a dangling `~/.nvm/current` symlink).
- **Two-level timeout for HTTP tasks** — replaces the blunt total-duration kill: idle timeout (default 5 min without events) triggers a `GET /session` check; running → re-attach SSE and keep watching; idle → settle success; missing → workspace output probe (`git status`) marks `hasOutput` so finished work is never mistaken for garbage and re-dispatched over. Total-duration backstop (default 2 h) goes through the same check flow and never aborts blindly.
- New config keys: `idleTimeoutMs`, `maxDurationMs`, `sessionCheckMaxRetries`, `routing`.

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
| `defaultTimeoutByTaskType` | none | v0.4.4 — taskType → default timeout ms map (overrides built-ins when `timeoutMs` is omitted) |
| `globalWorkspace` | none | v0.4.4 — fallback workspace for `harness_run` when `cwd` is omitted; unset → serve process default |
| `successNotifyMinDurationMs` | 300000 | v0.4.4 — notify on success only when the task ran at least this long (`<=0` disables) |
| `statusLineEnabled` | `true` | v0.4 — append a background-tasks status line to every outbound reply |
| `taskboardFile` | none | v0.4 — markdown taskboard whose "in progress" section feeds the status line |

## Alert channels

All alerts flow through the single `notifyCommand` shell command; the event type is passed via the `HB_ALERT` env var. The plugin ships a reference implementation at `scripts/hb_notify.sh` (included in the published package) — recommended config:

```json
"notifyCommand": "bash <plugin-dir>/scripts/hb_notify.sh"
```

Machine-specific values are injected via env (never hardcoded in the script): `HB_NOTIFY_TARGET` (required, the `--target` value; sending is skipped when unset), `HB_NOTIFY_CHANNEL` (default `openclaw-weixin`), `HB_NOTIFY_BIN` (default `openclaw` from PATH).

| `HB_ALERT` | Trigger | Environment variables |
|------------|---------|----------------------|
| `task_failed` (default) | Task terminal failure / timeout | `HB_TASK_ID` `HB_HARNESS` `HB_STATUS` `HB_EXIT_CODE` `HB_SESSION_ID` `HB_LOG_FILE` `HB_FAIL_REASON` `HB_SUPPRESSED` `HB_ADVICE` `HB_HAS_OUTPUT` |
| `task_stall` | Session/process stalled (consecutive checks without progress; not auto-killed) | `HB_TASK_ID` `HB_SESSION_ID` `HB_DETAIL` `HB_TIME` |
| `task_success` | v0.4.4 — long task finished successfully (duration ≥ `successNotifyMinDurationMs`) | `HB_TASK_ID` `HB_HARNESS` `HB_DURATION` `HB_COST_TOKENS` (when available) `HB_TIME` |
| `health_change` | Watchdog health state transition | `HB_ADAPTER` `HB_STATE` `HB_PREV_STATE` `HB_DETAIL` `HB_TIME` |
| `selfcheck` | Post-upgrade smoke self-check report | `HB_SELFCHECK` `HB_HOST_VERSION` `HB_DETAIL` `HB_TIME` |

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
