# 供应商插件 / Provider plugins

供应商插件为“设置 → 模型供应商 → 添加供应商”的目录添加更多服务（ADR-0050）。插件是一个 JSON 文件，
只有数据、不运行代码。用户从插件添加的供应商与内置服务一样，只需粘贴 Key。

A provider plugin is a JSON file that adds services to the catalog under Settings → Model providers →
Add provider (ADR-0050). It contains only data and runs no code. Providers added from a plugin work
like built-in ones: the user pastes a key and is done.

## 安装 / Installing

- **官方目录 / Official catalog**：在“添加供应商”对话框底部点“官方目录”，浏览
  [cairn-provider-plugins](https://github.com/960602906/cairn-provider-plugins) 中的插件，点“查看”下载并预览，
  确认后安装。已安装的插件标为“已安装”，目录中的版本不同时标为“可更新”。
  Choose **Official catalog**, pick a plugin, review the preview, then install. Installed plugins are
  marked, and a different catalog version is offered as an update.
- **本地文件 / Local file**：点“从文件安装…”，选择插件文件，确认预览。
  Choose **Install from file…**, pick the plugin, and confirm the preview.
- 或者直接把文件放进应用数据目录下的 `provider-plugins/`（与 `credentials.json` 同级，见
  [凭据存储](credentials.md)），重新打开对话框即可。
  Or drop the file into `provider-plugins/` in the app data folder (next to `credentials.json`).

两种安装方式都先预览：列出每个服务，以及填写的 Key 会发送到的**全部地址**（默认地址与各接入点）。确认后
文件被校验并以 `<插件 id>.json` 保存；同 id 的插件会被替换。卸载插件不影响已经用它添加的供应商：创建时
所有值都复制进了供应商配置。

Both paths preview first: every service and every address a pasted key may be sent to. Removing a
plugin does not affect providers already added from it.

## 官方目录的约定 / Official catalog contract

官方目录是 [`960602906/cairn-provider-plugins`](https://github.com/960602906/cairn-provider-plugins)
仓库的默认分支（`main`）。Cairn 只读这个仓库里的文件，地址为
`https://raw.githubusercontent.com/960602906/cairn-provider-plugins/main/<路径>`。目录是默认的信任来源，
不是开放市场：插件由仓库维护者审核后合入。

The catalog is the `main` branch of that repository. Cairn only reads files from it, through
`raw.githubusercontent.com`. It is the default trust source, not an open marketplace.

仓库结构 / Layout:

```text
index.json                 目录索引 / catalog index (required)
plugins/<id>.json          插件文件 / plugin files (default location)
icons/…                    可选的图标 / optional icons
```

`index.json`（示例见 [`examples/provider-catalog-index.example.json`](examples/provider-catalog-index.example.json)，
测试会校验它）：

```json
{
  "schemaVersion": 1,
  "plugins": [
    {
      "id": "acme",
      "name": "Acme Cloud",
      "version": "1.0.0",
      "description": "One hosted gateway and one local server.",
      "homepage": "https://acme.example",
      "icon": "icons/acme.svg",
      "url": "plugins/acme.json"
    }
  ]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `schemaVersion` | 是 | 固定为 `1`。更高的版本提示“需要更新版本的 Cairn”，其他值报“内容无效”。 |
| `plugins[].id` | 是 | 插件 id，必须与插件文件中的 `id` 一致，否则拒绝安装。 |
| `plugins[].name` | 是 | 目录中显示的名称。 |
| `plugins[].version` | 否 | 与已安装插件的 `version` 不同时显示“可更新”。应与插件文件中的一致。 |
| `plugins[].description`、`homepage` | 否 | 显示在目录中；`homepage` 为 https。 |
| `plugins[].icon` | 否 | 图标，规则见下文；相对路径相对仓库根目录。 |
| `plugins[].url` | 否 | 插件文件的位置：相对 `index.json`（仓库根目录）的路径，不能以 `/` 开头或含 `..`；或仓库内文件的 https 地址（必须以上面的 raw 地址开头，指向仓库以外的项被跳过）。省略时为 `plugins/<id>.json`。目录仓库中总是写 `plugins/<id>.json`。旧名 `path` 仍可用。 |

- 单个无效的项（字段不对、id 重复、地址越界）会被跳过，不影响其余插件；未知字段（如编辑器用的 `$schema`）忽略。
- 目录仓库用 JSON Schema（`schema/index.schema.json`、`schema/provider-plugin.schema.json`）与 CI 校验同样的规则；
  两边的格式变化要同时更新。
- 插件文件就是普通的插件（下文的格式），大小不超过 256 KB；`index.json` 不超过 512 KB。
- 预览时下载插件文件并计算 `sha256`，安装时内容必须与预览时一致；预览之后目录变了会提示重新查看。
- GitHub 的 raw 地址有几分钟的缓存，新合入的插件可能稍后才出现。
- 目录不可达（网络、HTTP 错误）或格式不对时，目录窗口就地说明并可重试；内置服务与本地文件安装不受影响。

## 格式 / Format

完整示例见 [`examples/provider-plugin.example.json`](examples/provider-plugin.example.json)
（测试会校验它，保证示例始终可用）。Schema：`@cairn/protocol` 的 `ProviderPluginManifest`。

```json
{
  "schemaVersion": 1,
  "id": "acme",
  "name": "Acme Cloud",
  "version": "1.0.0",
  "icon": "icons/acme.svg",
  "providers": [
    {
      "id": "gateway",
      "name": "Acme Gateway",
      "kind": "openai",
      "baseUrl": "https://api.acme.example/v1",
      "homepage": "https://acme.example",
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
| `homepage` | 否 | https 地址；没有 `icon` 时从这里取网站图标。 |
| `icon` | 否 | 插件的图标，显示在插件列表与目录中；规则见下文。 |
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
| `homepage` | 否 | 服务的 https 网站；没有 `icon` 时优先从这里取网站图标。省略时用插件的 `homepage`。 |
| `icon` | 否 | 服务的图标，显示在目录、编辑弹窗与供应商列表中；规则见下文。 |
| `compat` | 否 | OpenAI 兼容服务之间的差异（只对 `openai` 生效），字段同 `ModelCompat`：`thinkingFormat`（`openai`、`deepseek`、`qwen`、`openrouter`、`zai`）、`maxTokensField`、`supportsDeveloperRole`、`supportsStore`、`supportsReasoningEffort`、`supportsUsageInStreaming`、`requiresReasoningContentOnAssistantMessages`、`supportsStrictMode`。未知字段会报错。 |
| `models` | 否 | 预置的模型，最多 64 个。只有 `id` 必填，其余能力缺省时取 `modelDefaults`。 |
| `suggestedModels` | 否 | 没有预置模型时，填 Key 后拉取到的列表中自动启用这些模型（大小写不敏感，不存在的忽略）。 |
| `modelDefaults` | 否 | 手动添加或拉取到的模型的默认能力：`contextWindow`、`maxOutputTokens`、`supportsTools`、`supportsParallelToolCalls`、`supportsReasoning`。缺省时为 128k 上下文、16k 输出、支持工具与并行工具调用、不支持思考。 |

顶层与服务中的未知字段会被忽略，便于以后扩展格式。

## 图标 / Icons

`icon` 可以是 / may be:

- `https://…` 图片地址；
- `data:image/(png|jpeg|gif|webp|svg+xml|x-icon);base64,…` 内联图片（不超过约 96 KB）；
- 官方目录仓库内的相对路径，如 `icons/acme.svg`：无论写在 `index.json` 还是插件文件里，都**相对仓库根目录**
  解析为 `https://raw.githubusercontent.com/960602906/cairn-provider-plugins/main/icons/acme.svg`。从官方目录
  安装时解析成 https 地址后写入；本地文件中的相对路径无法解析，会被忽略（退回网站图标）。

查找顺序 / Fallback order:

1. 服务自己的 `icon`；没有时用插件的 `icon`。目录列表中用目录项的 `icon`。
2. 都没有（或图片加载失败）时，用**网站图标（favicon）**，像浏览器一样查找：依次打开 `homepage`、`keysUrl`、
   `baseUrl` 所在站点（`api.` 之类的子域名再试上一级域名）的页面，读取 `<link rel="icon">` /
   `apple-touch-icon`（SVG 与大尺寸优先；大页面只读开头），都没有时用站点根目录的 `/favicon.ico`。
   网站排在申请 Key 的页面之前：控制台页面常常跳到通用的登录页，图标不准确。目录列表中用目录项的 `homepage`。
3. 仍然没有时显示名称首字母（插件显示拼图符号）。内置服务同样如此：DeepSeek、Anthropic、OpenAI、Gemini 用随
应用的品牌图标，其余用网站图标，所以不需要每个服务都自带图片。

When `icon` is omitted or fails, Cairn uses the site favicon, found the way a browser would (homepage,
then key page, then the API host and its parent domain; `<link rel="icon">`, then `/favicon.ico`), and
falls back to initials.

- 图标由主进程下载，以 `data:` 地址交给界面（界面的 CSP 不加载远程图片）。只访问公网的 https 地址，每一跳
  跳转都检查；本机服务（如 `localhost`）不查找图标。
- 图片按内容识别格式，只接受 PNG、JPEG、GIF、WebP、ICO 与 SVG，单个不超过 96 KB；SVG 以 `<img>` 显示，
  不会执行脚本。
- 结果缓存在应用数据目录的 `icon-cache/`：找到的保留 14 天，找不到的 1 天后再试。图标在后台加载，不会挡住
  对话框。

## 注意 / Notes

- 用户为插件中的服务填写的 Key 会发送到它声明的地址。只分发、只安装你信任的插件；安装预览会列出每个地址。
  Keys are sent to the addresses a plugin declares, so only install plugins you trust.
- 插件只能使用 Cairn 已支持的接口格式与兼容参数。需要特殊鉴权或请求改写的服务需要在 `runtime-pi` 中适配。
- 需要 Key 而地址就在本机的服务（例如带 Key 的自建网关），把 `category` 设为 `local`、`requiresKey`
  保持 `true` 即可。
- 开发与测试时可以用环境变量 `CAIRN_PROVIDER_CATALOG_URL` 把目录指向别的地址（例如本机的静态文件服务）；
  正式使用总是官方仓库。
