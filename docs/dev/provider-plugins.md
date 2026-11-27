# 供应商插件 / Provider plugins

供应商插件为“设置 → 模型供应商 → 添加供应商”的目录添加更多服务（ADR-0049）。插件是一个 JSON 文件，
只有数据、不运行代码。用户从插件添加的供应商与内置服务一样，只需粘贴 Key。

A provider plugin is a JSON file that adds services to the catalog under Settings → Model providers →
Add provider (ADR-0049). It contains only data and runs no code. Providers added from a plugin work
like built-in ones: the user pastes a key and is done.

## 安装 / Installing

- 在“添加供应商”对话框底部点“从文件安装…”，选择插件文件，确认预览中的服务与地址。
  In the Add provider dialog, choose **Install from file…**, pick the plugin, and confirm the preview.
- 或者直接把文件放进应用数据目录下的 `provider-plugins/`（与 `credentials.json` 同级，见
  [凭据存储](credentials.md)），重新打开对话框即可。
  Or drop the file into `provider-plugins/` in the app data folder (next to `credentials.json`).

安装时文件会被校验，并以 `<插件 id>.json` 保存；同 id 的插件会被替换。卸载插件不影响已经用它添加的
供应商：创建时所有值都复制进了供应商配置。

## 格式 / Format

完整示例见 [`examples/provider-plugin.example.json`](examples/provider-plugin.example.json)
（测试会校验它，保证示例始终可用）。Schema：`@cairn/protocol` 的 `ProviderPluginManifest`。

```json
{
  "schemaVersion": 1,
  "id": "acme",
  "name": "Acme Cloud",
  "version": "1.0.0",
  "providers": [
    {
      "id": "gateway",
      "name": "Acme Gateway",
      "kind": "openai",
      "baseUrl": "https://api.acme.example/v1",
      "keysUrl": "https://console.acme.example/keys",
      "suggestedModels": ["acme-coder"]
    }
  ]
}
```

顶层字段 / Top-level fields:

| 字段 | 必填 | 说明 |
|---|---|---|
| `schemaVersion` | 是 | 固定为 `1`。更高的版本会被拒绝（“需要更新版本的 Cairn”）。 |
| `id` | 是 | 小写字母、数字与 `-`，1～64 个字符。决定文件名与模板 id 前缀。 |
| `name` | 是 | 插件名，显示在插件列表中。 |
| `version`、`description` | 否 | 显示在插件列表中。 |
| `homepage` | 否 | https 地址。 |
| `providers` | 是 | 1～32 个服务，条目 `id` 不能重复。 |

每个服务 / Each provider:

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 同插件 id 的规则。模板 id 为 `<插件 id>.<条目 id>`，也是新建供应商的默认 id。 |
| `name` | 是 | 服务名，显示在目录与新建的供应商上。 |
| `kind` | 是 | 接口格式：`openai`（Chat Completions）、`anthropic`（Messages）或 `gemini`。 |
| `baseUrl` | 是 | 默认地址，`http` 或 `https`，不能带用户名或密码。`openai` 通常以 `/v1` 结尾；`anthropic` 不带 `/v1`；`gemini` 带版本，如 `/v1beta`。 |
| `category` | 否 | `vendor`、`relay`（默认）或 `local`，决定在目录中的分组。 |
| `regions` | 否 | 2～4 个接入点 `{ "id": "global" \| "cn", "baseUrl", "keysUrl"? }`；`baseUrl` 必须是其中之一。中文界面默认选 `cn`。 |
| `requiresKey` | 否 | 默认 `true`。本机服务设为 `false`，Key 变为可选，打开即拉取模型列表。 |
| `keysUrl` | 否 | 申请 Key 的 https 页面，显示为“获取 API Key”。 |
| `compat` | 否 | OpenAI 兼容服务之间的差异（只对 `openai` 生效），字段同 `ModelCompat`：`thinkingFormat`（`openai`、`deepseek`、`qwen`、`openrouter`、`zai`）、`maxTokensField`、`supportsDeveloperRole`、`supportsStore`、`supportsReasoningEffort`、`supportsUsageInStreaming`、`requiresReasoningContentOnAssistantMessages`、`supportsStrictMode`。未知字段会报错。 |
| `models` | 否 | 预置的模型，最多 64 个。只有 `id` 必填，其余能力缺省时取 `modelDefaults`。 |
| `suggestedModels` | 否 | 没有预置模型时，填 Key 后拉取到的列表中自动启用这些模型（大小写不敏感，不存在的忽略）。 |
| `modelDefaults` | 否 | 手动添加或拉取到的模型的默认能力：`contextWindow`、`maxOutputTokens`、`supportsTools`、`supportsParallelToolCalls`、`supportsReasoning`。缺省时为 128k 上下文、16k 输出、支持工具与并行工具调用、不支持思考。 |

顶层与服务中的未知字段会被忽略，便于以后扩展格式。

## 注意 / Notes

- 用户为插件中的服务填写的 Key 会发送到它声明的地址。只分发、只安装你信任的插件；安装预览会列出每个地址。
  Keys are sent to the addresses a plugin declares, so only install plugins you trust.
- 插件只能使用 Cairn 已支持的接口格式与兼容参数。需要特殊鉴权或请求改写的服务需要在 `runtime-pi` 中适配。
- 需要 Key 而地址就在本机的服务（例如带 Key 的自建网关），把 `category` 设为 `local`、`requiresKey`
  保持 `true` 即可。
