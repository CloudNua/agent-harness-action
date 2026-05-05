# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-05-05

### Added

- **Scan-only mode.** `agent-command` is now optional. When omitted, the action
  walks the workspace for manifest files (`package.json`, `requirements.txt`,
  `pyproject.toml`, `go.mod`, `Cargo.toml`) and runs the post-scan path against
  them — no agent is executed. This is the mode the
  [CloudNua GitHub App](https://github.com/apps/cloudnua) auto-injects via
  `.github/workflows/cloudnua.yml` for repos that opt in to advisory scanning
  without changing their existing agent workflows.

### Changed

- `agent-command` input is now `required: false`. Existing workflows that
  supply `agent-command` are unaffected — the agent-wrap behaviour is unchanged.

### Migration

- No action required for existing consumers. The `v1` tag is moved to point
  at v1.1.0; `@v1` references will pick up scan-only mode automatically.

## [1.0.0] - 2026-04-27

### Added

- First public release. CloudNua Agent Harness wraps AI coding agents
  (Claude Code, Copilot CLI, etc.) with pre-execution snapshot, post-execution
  diff + manifest scan, GitHub Check Runs with annotations, and a telemetry
  artifact. Server-side policy resolution against the CloudNua control plane.

[1.1.0]: https://github.com/cloudnua/agent-harness-action/releases/tag/v1.1.0
[1.0.0]: https://github.com/cloudnua/agent-harness-action/releases/tag/v1.0.0
