# NEXUS-OS

自研 Agent 平台 + 可插拔 Agent 引擎（首选 pi）。首个产品形态是一个类似 Codex 的编程类桌面 agent 应用，基于 Electron 和 React 构建，支持接入多种 LLM。

Our own agent platform with a pluggable agent engine (pi preferred). The first product is a Codex-like coding agent desktop app built with Electron and React, with support for multiple LLM providers.

- **平台层 / Platform**：Run 生命周期、工具管线与权限、事件日志与存储、凭据、界面、多 Agent 协作。
- **引擎层 / Engine**：只负责 agent 循环与模型通信，经 `AgentRuntime` 接口接入（[ADR-0004](docs/adr/0004-isolate-pi-behind-agentruntime.md)）；当前实现为 pi（`packages/runtime-pi`）。

> 设计已定稿，下一步进入 M0 基础阶段。 / Design finalized; next up is the M0 foundation phase.

## 文档 / Docs

- [架构设计 / Architecture](docs/architecture.md)
- [架构决策记录 / ADRs](docs/adr/README.md)
- 详细设计 / Detailed design
  - [Agent Runtime](docs/design/agent-runtime.md)（已确认）
  - [Agent 管理界面](docs/design/agent-management-ui.md)（已确认）
  - [多 Agent 协作](docs/design/multi-agent.md)（已确认）
- 开发计划 / Dev plan
  - [M0 基础：任务分解](docs/plan/m0.md)
  - [M1 最小可用：任务概要](docs/plan/m1.md)

## 开发 / Development

需要 Node 24.11+（与 Electron 45 内置的 Node 主版本一致）与 pnpm 10（可通过 `corepack enable` 启用）。

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm dev     # 启动桌面应用（开发模式，数据放在独立的 NEXUS-OS-dev 目录）
pnpm build   # 构建桌面应用
pnpm smoke   # 用构建产物做启动冒烟测试
pnpm e2e     # 用构建产物跑端到端测试（Playwright；Linux 无显示器时用 xvfb-run -a pnpm e2e）
```

## 当前计划 / Plan

- 首发平台：Windows，后续支持 macOS 与 Linux
- 首批模型：DeepSeek、Ollama
- 界面语言：中文、英文

作者 / Author：960602906
