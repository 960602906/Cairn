# Cairn

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/home-dark.png">
    <img src="docs/images/home-light.png" alt="Cairn desktop app home" width="100%">
  </picture>
</p>

<p align="center">
  A Codex-like desktop coding agent<br>
  <strong>Our own agent platform + a pluggable agent engine</strong> (pi preferred)
</p>

<p align="center">
  <a href="README.md">中文</a> · English
</p>

## What it is

Cairn is a **local-first** desktop coding agent. Pick a local project folder, describe a task in
natural language, and the agent reads code, edits files and runs commands on its own. Every step,
tool call and file change is visible in the UI; sensitive actions require approval, and every
change can be rolled back.

Architecturally, Cairn = **our own agent platform** + **a pluggable agent engine**:

- **Platform (ours)**: run orchestration, context, the tool registry and tool pipeline, permissions
  and approvals, checkpoints, the event log, storage, credentials, UI, and multi-agent
  collaboration.
- **Engine (replaceable)**: only the agent loop (call the model → parse tool calls → feed results
  back) and model communication, plugged in through the `AgentRuntime` interface; pi is the
  preferred engine. Tool execution stays in the platform, so swapping engines does not affect
  permissions, auditing or storage.

> **Status**: 0.1.0 unsigned beta, MIT licensed. M0–M5 are implemented and installable; stable is
> still blocked on code signing, legal review and a clean-VM acceptance matrix. Windows x64 ships
> first, per-user install. See the [M5 release acceptance report](docs/plan/m5-report.md) and the
> [M6 plan](docs/plan/m6.md) for cross-platform support and open sourcing.

## Highlights

- **Local first**: sessions, projects, file changes and checkpoints live in local SQLite. API keys
  are encrypted with the OS secure storage (safeStorage); no cloud account needed.
- **Controlled**: tool calls are shown live; writing files and running commands require approval by
  default; project-level permission rules and sandboxed execution are supported.
- **Reviewable**: diffs per file and per hunk; accept or revert a single file or hunk, or return to
  any checkpoint.
- **Multi-model**: Anthropic, OpenAI and Gemini protocol formats, with custom `baseUrl`; services
  like DeepSeek work through the OpenAI-compatible format.
- **Extensible**: built-in tools, skills, MCP servers, custom agents, delegation and isolated
  workspaces all go through one tool registry.
- **Observable**: activity center, background commands, run inspector, context usage and redacted
  diagnostics bundles.

## Screenshots

| Chat and tool timeline | Change review |
| --- | --- |
| <img src="docs/images/chat-light.png" alt="Chat and tool timeline" width="100%"> | <img src="docs/images/changes-light.png" alt="Per-file change review and diff" width="100%"> |
| **Model providers** | **Dark theme** |
| <img src="docs/images/settings-provider-dialog-light.png" alt="Configure model providers and capabilities" width="100%"> | <img src="docs/images/chat-dark.png" alt="Chat in dark theme" width="100%"> |

> Screenshots use a local mock model service for illustration only; actual content depends on the
> model you configure.

## Architecture

```mermaid
flowchart LR
  UI["Renderer<br/>React · chat · workspace · settings"] --> Main["Main process<br/>windows · IPC · session scheduling<br/>sole SQLite writer · credentials · updates"]
  Main --> Host["Agent host<br/>one utilityProcess per running session"]
  Host --> Engine["AgentRuntime<br/>pi adapter preferred"]
  Host --> Cap["Tool pipeline<br/>tools · skills · MCP · shell"]
  Host --> Guard["Permissions & approvals<br/>checkpoints · context"]
  Engine --> LLM["Anthropic · OpenAI · Gemini"]
```

Three key boundaries:

- **UI ↔ main process**: the UI has no Node access; it can only call the typed API exposed by the
  preload script.
- **Main process ↔ agent host**: one process per session, so a crash or hang does not affect the
  window or other sessions.
- **Business code ↔ engine**: only `packages/runtime-pi` may reference pi; everything else uses the
  `AgentRuntime` interface.

See [architecture](docs/architecture.md) and the [ADRs](docs/adr/README.md) for details.

## Repository layout

```text
apps/desktop           Electron app (main / preload / renderer / agent-host)
packages/core          Domain types, AgentRuntime interface, permission engine, path validation
packages/protocol      IPC protocol and event definitions (zod schemas + TS types)
packages/runtime-pi    pi adapter (the only package allowed to reference pi)
packages/tools         Built-in tool implementations
packages/skills        Skill parsing, indexing and on-demand loading
packages/mcp           MCP client, connection management and tool adaptation
packages/shell         Shell adapters (PowerShell / cmd / bash / zsh)
packages/checkpoint    Checkpoint implementation
packages/storage       Storage interfaces, SQLite implementation and migrations
packages/i18n          Chinese and English string resources
```

## Quick start

Requires **Node 24.11+** (matching the Node major inside Electron 45) and **pnpm 10**
(`corepack enable`).

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm dev     # run the app in development mode (data goes to a separate Cairn-dev folder)
pnpm build   # build the desktop app
pnpm smoke   # startup smoke test against the build output
pnpm e2e     # end-to-end tests against the build output (Playwright; on headless Linux use xvfb-run -a pnpm e2e)
```

Install-form acceptance (Windows; build the package first):

```bash
pnpm package:dir; pnpm e2e:packaged        # unpacked output: installed-form smoke + full release flow
pnpm package:nsis; pnpm acceptance:installed  # real NSIS: install / uninstall / reinstall recovery
```

See [install](docs/dev/install.md) and [troubleshooting](docs/dev/troubleshooting.md).

## Plan

- Shipping platform: Windows first; macOS and Linux next.
- Initial models: Anthropic, OpenAI and Gemini protocol formats; services like DeepSeek use the
  OpenAI-compatible format.
- UI languages: Chinese and English; light, dark and follow-system themes.
- Stable still needs code signing, legal review and a clean-VM acceptance matrix.

## Docs

- [Architecture / 架构设计](docs/architecture.md)
- [Architecture decision records / 架构决策记录](docs/adr/README.md)
- [Agent Runtime](docs/design/agent-runtime.md) (accepted)
- [Agent management UI](docs/design/agent-management-ui.md) (accepted)
- [Multi-agent collaboration](docs/design/multi-agent.md) (accepted)
- [Install, upgrade and uninstall](docs/dev/install.md)
- [Troubleshooting](docs/dev/troubleshooting.md)
- [M5 release acceptance report](docs/plan/m5-report.md)
- [Changelog](CHANGELOG.md)
- [Privacy notice](PRIVACY.md)
- [Contributing](CONTRIBUTING.md)
- [Code of conduct](CODE_OF_CONDUCT.md)
- [Security policy](SECURITY.md)

## Milestones

- [M0 Foundations](docs/plan/m0.md)
- [M1 Minimum viable](docs/plan/m1.md)
- [M2 Reviewable](docs/plan/m2.md)
- [M3 Daily usable](docs/plan/m3.md)
- [M4 Multi-agent collaboration](docs/plan/m4.md)
- [M5 Release](docs/plan/m5.md)
- [M6 Cross-platform and open source](docs/plan/m6.md)

## License

[MIT](LICENSE). Third-party components keep their own licenses; see the bundled notices and
[ADR-0039](docs/adr/0039-open-source-license-and-dco.md). Contributions are accepted under the
DCO (`git commit -s`).

Author: 960602906
