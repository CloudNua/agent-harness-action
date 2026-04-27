# CloudNua Agent Harness

[![CI](https://github.com/cloudnua/agent-harness-action/actions/workflows/ci.yml/badge.svg)](https://github.com/cloudnua/agent-harness-action/actions/workflows/ci.yml)
[![GitHub release](https://img.shields.io/github/v/release/cloudnua/agent-harness-action)](https://github.com/cloudnua/agent-harness-action/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A GitHub Action that wraps AI coding agents with pre/post policy scanning. Before the agent runs, it fetches your organization's policies from CloudNua and snapshots the workspace. After the agent finishes, it scans any changed manifest files against those policies and reports the result as a GitHub Check Run.

## Table of Contents

- [How It Works](#how-it-works)
- [Quick Start](#quick-start)
- [Inputs](#inputs)
- [Outputs and Telemetry](#outputs-and-telemetry)
- [Supported Manifest Files](#supported-manifest-files)
- [Policy Types](#policy-types)
- [Examples](#examples)
- [Check Run Output](#check-run-output)
- [Permissions](#permissions)
- [Versioning and Pinning](#versioning-and-pinning)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

## How It Works

```
Pre-step          Main step              Post-step
┌─────────┐      ┌──────────────┐       ┌────────────────┐
│ Fetch    │      │ Run agent    │       │ Diff workspace  │
│ policies │ ──── │ command      │ ───── │ Scan manifests  │
│ Snapshot │      │              │       │ Post Check Run  │
│ workspace│      │              │       │ Write telemetry │
└─────────┘      └──────────────┘       └────────────────┘
```

1. **Pre-step**: Fetches tenant policies from the CloudNua API, snapshots workspace file state.
2. **Main step**: Executes the configured agent command.
3. **Post-step**: Diffs workspace, scans changed manifest files against policies, posts a Check Run, writes a telemetry JSON to the workspace.

## Quick Start

```yaml
name: Agent with Policy Scanning

on:
  workflow_dispatch:

jobs:
  agent-run:
    runs-on: ubuntu-latest
    permissions:
      checks: write
      contents: read
    steps:
      - uses: actions/checkout@v4

      - uses: cloudnua/agent-harness-action@v1
        with:
          api-token: ${{ secrets.CLOUDNUA_API_TOKEN }}
          agent-command: "your-agent-command here"
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

To get a `CLOUDNUA_API_TOKEN`, sign in at [app.cloudnua.com](https://app.cloudnua.com) and generate one under **Settings → API Keys**.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `api-token` | Yes | | CloudNua API token (generate in **Settings → API Keys**). |
| `api-url` | No | `https://app.cloudnua.com` | CloudNua API base URL. Override only for self-hosted or staging deployments. |
| `agent-command` | Yes | | Shell command to execute the AI agent. |
| `policy-types` | No | `all` | Comma-separated policy types to enforce: `dependency`, `mcp`, `compliance`. Currently advisory — policy filtering is performed server-side. |
| `firewall-url` | No | | URL of the CloudNua MCP firewall gateway. When set, the harness exposes `CLOUDNUA_FIREWALL_URL` to the agent subprocess; the agent is responsible for routing MCP traffic through it. |
| `allow-http` | No | `"false"` | Allow non-TLS URLs for `api-url` and `firewall-url`. Intended for local development and testing only — never enable in production. |
| `fail-on-violation` | No | `"true"` | Fail the action if any blocking violations are found. Set to `"false"` for warn-only mode. |
| `github-token` | No | `${{ github.token }}` | GitHub token used to post Check Runs. Needs `checks: write`. |

## Outputs and Telemetry

The action does not declare GitHub Action `outputs:` — results are surfaced via two channels:

1. **GitHub Check Run** posted to the commit being scanned (see [Check Run Output](#check-run-output)).
2. **Telemetry artifact** written to `.cloudnua/scan-result.json` in the workspace. Upload it as a workflow artifact for archival or downstream tooling:

```yaml
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: cloudnua-scan-result
    path: .cloudnua/scan-result.json
```

The JSON contains the full scan summary, violation list, file-level annotations, and a redacted firewall origin (when `firewall-url` is configured).

## Supported Manifest Files

| File | Ecosystem |
| --- | --- |
| `package.json` | npm |
| `requirements.txt` | pip |
| `pyproject.toml` | pip |
| `go.mod` | Go |
| `Cargo.toml` | Cargo |

## Policy Types

| Type | Description | Example Conditions |
| --- | --- | --- |
| `dependency` | Block or warn on specific packages. | `blockedPackages`, `blockedPatterns`, `allowedEcosystems` |
| `mcp` | Detect MCP server packages. | `blockedMcpServers`, `mcpPatterns` |
| `compliance` | Enforce dependency limits and required packages. | `maxDependencies`, `requiredPackages` |

## Examples

Self-contained workflow files for common agents are in [`examples/`](./examples). The snippets below show typical usage.

### GitHub Copilot CLI

```yaml
- uses: cloudnua/agent-harness-action@v1
  with:
    api-token: ${{ secrets.CLOUDNUA_API_TOKEN }}
    agent-command: "copilot-cli suggest --target package.json"
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### Claude Code

```yaml
- uses: cloudnua/agent-harness-action@v1
  with:
    api-token: ${{ secrets.CLOUDNUA_API_TOKEN }}
    agent-command: "claude -p 'Add error handling to src/api.ts'"
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

### Cursor (Headless)

```yaml
- uses: cloudnua/agent-harness-action@v1
  with:
    api-token: ${{ secrets.CLOUDNUA_API_TOKEN }}
    agent-command: "cursor --headless --apply changes.md"
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### Scan Only Dependency Policies

```yaml
- uses: cloudnua/agent-harness-action@v1
  with:
    api-token: ${{ secrets.CLOUDNUA_API_TOKEN }}
    agent-command: "your-agent-command"
    policy-types: "dependency"
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### Warn-Only Mode

```yaml
- uses: cloudnua/agent-harness-action@v1
  with:
    api-token: ${{ secrets.CLOUDNUA_API_TOKEN }}
    agent-command: "your-agent-command"
    fail-on-violation: "false"
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## Check Run Output

The action posts a GitHub Check Run with:

- **Conclusion**: `failure` (blocking violations), `neutral` (warnings only), or `success` (clean).
- **Summary**: Markdown table with violation counts by severity.
- **Annotations**: File-level annotations for each blocking or warning violation.

## Permissions

The action requires these GitHub token permissions:

```yaml
permissions:
  checks: write    # Post Check Runs
  contents: read   # Read repository files
```

## Versioning and Pinning

This action follows [GitHub's Action versioning conventions](https://docs.github.com/en/actions/sharing-automations/creating-actions/about-custom-actions#using-release-management-for-actions). Three pinning options:

| Reference | Behaviour | Recommended for |
| --- | --- | --- |
| `@v1` | Moving major-version tag — always points at the latest backwards-compatible release. | Most consumers. |
| `@v1.2.3` | Immutable tag pinned to a specific release. | Teams that want explicit version control. |
| `@<commit-sha>` | Immutable commit pin. | Teams with strict supply-chain pinning policies. |

Breaking changes (input renames, output removals, runtime upgrades) will only land in a new major version (`@v2`). Within `v1`, the input/output contract is stable.

## Development

```bash
# Install dependencies
bun install

# Type check
bun run lint

# Run tests
bun run test

# Build (regenerates dist/pre, dist/main, dist/post via @vercel/ncc)
bun run build
```

The action ships its compiled JavaScript in `dist/` because GitHub Actions executes the bundled output directly — `dist/` must be committed alongside source changes.

## Contributing

Pull requests are welcome. Please:

1. Open an issue first for non-trivial changes so the design can be discussed.
2. Run `bun run lint && bun run test` before pushing.
3. Run `bun run build` and commit the regenerated `dist/` in a separate commit so the diff is reviewable.
4. Follow [Conventional Commits](https://www.conventionalcommits.org/) for commit messages.

Bugs and security issues: please open a GitHub issue, or email `security@cloudnua.com` for sensitive disclosures.

## License

[MIT](LICENSE) © CloudNua Ltd.
