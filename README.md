# openclaw-plugin-harness-bridge

Register, configure, delegate and monitor coding-agent harnesses (OpenCode, Claude Code, Codex CLI, …) from your OpenClaw assistant.

> **Status**: MVP v0.2 running in production · RFC under community review — [openclaw/openclaw#172583](https://github.com/openclaw/openclaw/issues/172583)
>
> Design background and the community discussion draft: [docs/RFC.md](docs/RFC.md) · [中文文档](README.zh-CN.md)

## Positioning

OpenClaw already ships three layers for integrating external agents (Agent Harness SDK / CLI backend / Tool plugin). This plugin covers the **task-level orchestration layer** they don't: your AI assistant becomes the control plane for multiple harnesses — check status, sync model configs, delegate tasks, track progress, and keep a durable ledger.

- Official layers solve "OpenClaw sessions running ON a harness" (conversation-level)
- This plugin solves "the assistant directing harnesses to do work" (task-level)

## Tools

| Tool | Purpose |
|------|---------|
| `harness_list` | List registered harnesses and their health (binary / version / config-file presence) |
| `harness_sync_models` | Calibrate each harness's model config against a shared parameter dictionary (report / field-level merge write-back / default-model switch) |
| `harness_run` | Delegate a task (background + ledger by default; `wait=true` for synchronous runs) |
| `harness_status` | Query the task ledger (status / exit code / session id / duration / output tail) |
| `harness_mount` | Mount a shared knowledge directory into a harness (`external_directory` allow + `instructions` injection; dry-run/apply, idempotent) |

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

## Ledger and logs

- Ledger: `<dataDir>/ledger.jsonl`, append-only JSONL; multiple records for the same task resolve to the latest by id (crash-safe)
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
