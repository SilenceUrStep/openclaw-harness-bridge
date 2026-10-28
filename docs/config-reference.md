# Configuration reference

All keys live in `openclaw.json → plugins.entries["harness-bridge"].config`.
**Every key is optional** — the plugin is fully functional with zero configuration
(data directory, ledger, adapters, status line, turn injection, metrics, agent-ops log,
watchdog and daily report all come with working defaults). This table is generated from
the same source the `harness_doctor` config check uses (`src/lib/doctor.ts → CONFIG_KEY_TABLE`).

| Key | Default (unset behavior) | Description |
|-----|--------------------------|-------------|
| `dataDir` | `~/.openclaw/harness-bridge` | Data directory (SQLite ledger / task logs / user adapters) |
| `adaptersDir` | `<dataDir>/adapters` | Extra adapter directory (same-name file overrides a built-in) |
| `paramsFile` | built-in `params/model_params.json` | Model parameter dictionary JSON path |
| `notifyCommand` | *(none — alert & daily-report push disabled, everything else runs)* | Shell command executed on task finish / alerts. v0.4.7 event types: `task_failed` (default) / `task_success` / `task_stall` / `health_change` / `selfcheck` / `daily_report` |
| `defaultTimeoutMs` | `600000` | Default `harness_run` timeout ms (when no taskType applies) |
| `defaultTimeoutByTaskType` | `{coding: 2700000, general/analysis/search: 600000}` | taskType → default timeout ms map (overrides built-ins when `timeoutMs` omitted) |
| `globalWorkspace` | *(none — serve process cwd is used)* | v0.4.4 fallback workspace when `harness_run` omits `cwd` |
| `successNotifyMinDurationMs` | `300000` | v0.4.4 notify on success only when duration ≥ threshold (`<=0` disables) |
| `statusLineEnabled` | `true` | v0.4 append a background-tasks status line to every outbound reply |
| `taskboardFile` | *(none — status line uses the ledger only)* | v0.4 markdown taskboard path (status line merge + auto dispatch logging) |
| `turnPrepareEnabled` | `true` | v0.4.1 inject running-task list into every agent turn (zero injection when idle) |
| `metricsEnabled` | `true` | v0.4.1 in-process metrics sampler (memory / event-loop p99, 24h ring) |
| `eventRetentionDays` | `30` | v0.4.1 `task_event` retention days (`0` disables cleanup) |
| `agentOpsLogEnabled` | `true` | v0.4.5 agent-layer tool-call ops log |
| `agentOpsLogFile` | `<dataDir>/agent-ops.log` | v0.4.5 ops log file path |
| `agentOpsLogMaxBytes` | `10485760` | v0.4.6 ops log rotation threshold bytes (`0` disables rotation) |
| `agentOpsLogKeep` | `7` | v0.4.6 ops log rotation kept files (`.1`–`.N`) |
| `dailyReport.enabled` | `true` | v0.4.6 daily ledger report push (via `notifyCommand`, fail-open) |
| `dailyReport.hour` | `21` | v0.4.6 push hour (Asia/Shanghai), once per day |
| `healthWatchdog.enabled` | `true` | v0.4.3 periodic adapter health probing |
| `healthWatchdog.intervalMs` | `300000` | v0.4.3 probe interval ms (5 min) |
| `routing.retryAttempts` | `1` when a `routing` section exists; `0` (no retry/fallback, v0.4.2 behavior) when the section is absent | v0.4.3 same-harness auto-retry count after failure |
| `routing.default` | *(none — capabilities / taskType routing decides)* | v0.4.3 default harness when nothing matches |
| `routing.rules` | *(none — capability-based routing)* | v0.4.3 taskType → harness routing rule overrides |
| `routing.fallback` | *(none)* | v0.4.3 harness → fallback chain |
| `timeouts.idleTimeoutMs` | `300000` | v0.4.3 HTTP SSE idle-silence check threshold ms (`0` disables) |
| `timeouts.maxDurationMs` | `7200000` | v0.4.3 HTTP total-duration backstop ms (`0` disables); check-then-settle, never a blind kill |
| `timeouts.sessionCheckMaxRetries` | `3` | v0.4.3 consecutive still-running checks before a stall alert |

Adapter credentials are not plugin config: e.g. the OpenCode HTTP transport reads
`OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD` from the gateway environment.

Machine-specific alert delivery values are env-injected into `scripts/hb_notify.sh`:
`HB_NOTIFY_TARGET` (required to actually send), `HB_NOTIFY_CHANNEL` (default `openclaw-weixin`),
`HB_NOTIFY_BIN` (default `openclaw` from PATH).
