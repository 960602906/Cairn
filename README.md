# Cairn

一个类似 Codex 的编程类桌面 agent 应用：**自研 Agent 平台 + 可插拔的 Agent 引擎**（首选 pi）。平台负责运行编排、工具与权限、审批、检查点、存储和界面；引擎只负责模型循环与模型通信，经 `AgentRuntime` 接口接入（ADR-0004、ADR-0023）。基于 Electron 与 React，支持接入多种 LLM。

A Codex-like coding agent desktop app: **our own agent platform + a pluggable agent engine** (pi preferred). The platform owns run orchestration, tools and permissions, approvals, checkpoints, storage and the UI; the engine only runs the model loop behind the `AgentRuntime` interface. Built with Electron and React, with support for multiple LLM providers.

> M0、M1 已完成，M2 可审阅已完成（进度见 [docs/plan/m2.md](docs/plan/m2.md)）。 / M0 and M1 are done; M2 (reviewable UI) is done.

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
  - [M2 可审阅：界面任务分解](docs/plan/m2.md)

## 开发 / Development

需要 Node 24.11+（与 Electron 45 内置的 Node 主版本一致）与 pnpm 10（可通过 `corepack enable` 启用）。

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm dev     # 启动桌面应用（开发模式，数据放在独立的 Cairn-dev 目录）
pnpm build   # 构建桌面应用
pnpm smoke   # 用构建产物做启动冒烟测试
pnpm e2e     # 用构建产物跑端到端测试（Playwright；Linux 无显示器时用 xvfb-run -a pnpm e2e）
```

## 当前计划 / Plan

- 首发平台：Windows，后续支持 macOS 与 Linux
- 首批模型：Anthropic、OpenAI、Gemini 三种协议格式（DeepSeek 等兼容服务走 OpenAI 格式）
- 界面语言：中文、英文

作者 / Author：960602906
