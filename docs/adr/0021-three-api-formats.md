# ADR-0021 首批支持 OpenAI、Anthropic、Gemini 三种接口格式

- 状态：已接受
- 日期：2026-11-02
- 替代：[ADR-0011](0011-openai-compatible-first.md) 中"第一版只实现 `openai-compatible`"一条；`ModelProfile` 与能力探测的决定保留。

## 背景

ADR-0011 计划第一版只实现 OpenAI 兼容接口，覆盖 DeepSeek 和 Ollama。实际使用中，用户希望首批就能直接接入 Anthropic、OpenAI、Google Gemini 的官方接口，以及与这三种格式兼容的第三方服务和代理。

pi-ai 已经内置这三种协议的实现（消息格式、工具调用、流式、推理内容），我们只需要在 `runtime-pi` 适配器中把提供方配置映射过去，额外成本主要是配置界面和每种格式的契约测试。

## 决定

- 提供方配置的 `kind` 首批支持三种接口格式：
  - `openai`：OpenAI Chat Completions 兼容接口。DeepSeek、Ollama 以及大多数兼容服务都使用它。
  - `anthropic`：Anthropic Messages 接口。
  - `gemini`：Google Gemini 接口。
- 每种格式都可以自定义 `baseUrl`，以便接入兼容服务或代理；官方地址作为默认值。
- `kind` 只描述线路协议，不绑定厂商；同一种格式可以配置多个提供方。
- 格式之间的差异（推理内容字段、工具调用结构、并行工具调用、缓存用量等）全部在 `runtime-pi` 中转换为 `CanonicalMessage` 与 `RuntimeEvent`，不进入事件与存储格式。
- `ModelProfile`、能力探测沿用 ADR-0011。
- 契约测试（S8、M1-02）对三种格式各录制一组响应。

## 备选方案

- **维持只做 OpenAI 兼容，后续再加**：Anthropic 与 Gemini 都提供 OpenAI 兼容层，但推理内容、缓存与部分工具调用特性会丢失，用户需要的正是官方格式。
- **按厂商定义 `kind`（如 `deepseek`、`ollama`）**：厂商数量多且常变化；按协议划分更稳定，厂商差异通过默认配置模板体现。

## 后果

- M1 的提供方配置、适配器转换与契约测试工作量增加，但都在 `runtime-pi` 与设置页内，不影响 M0 的事件、IPC 与存储格式（`ModelRef` 只记录提供方 id）。
- 推理内容需要按格式区分处理；`ReasoningPart.providerId` 已能区分来源（Runtime §14）。
- M1 的完成标准仍以 DeepSeek 为主，另两种格式至少完成一次真实对话验证（用户本地运行）。
