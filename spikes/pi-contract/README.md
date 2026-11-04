# S8：pi 版本锁定与契约测试

## 问题

1. pi 的精确版本怎样锁定，升级时怎样发现行为变化（m0.md 第 4 节 S8，ADR-0004）；
2. 录制 / 回放模型响应驱动契约测试的方案，能否用录制数据稳定复现事件序列（架构 §23、M1-02；ADR-0021 要求三种接口格式各一组录制）。

## 版本

| 组件 | 版本 | 说明 |
|---|---|---|
| @earendil-works/pi-agent-core | 1.5.0 | 2026-11-02 发布的最新版；另用 1.4.0、1.3.0 验证升级时的差异 |
| @earendil-works/pi-ai | 1.5.0 | OpenAI Chat Completions、Anthropic Messages、Gemini 三种接口 |
| Vitest | 5.0.5 | 与仓库一致；黄金文件用 `toMatchFileSnapshot` |

本目录不属于 pnpm workspace，用 npm 独立安装。另在临时目录用 pnpm 10 安装同一组依赖验证过（见观察 6）。

## 结论

- **版本锁定**：pi 自身对全部依赖（含 pi-ai 依赖的各家 SDK）都用精确版本，所以只需在 `packages/runtime-pi` 中把 pi-agent-core 与 pi-ai 声明为**同一个精确版本**（仓库已有 `save-exact=true`），CI 用 `--frozen-lockfile`（已有）。再加一组守卫测试（`test/version.test.mjs`），防止两者版本不一致而装出两份 pi-ai。
- **契约测试**：在 HTTP 层录制与回放。录制代理放在 pi 与上游之间，记录请求与原始响应分块；回放服务按顺序比对请求、返回录制的响应。三种格式、11 个场景，在 15 种分块方式与重复回放下事件轨迹完全一致，满足"用录制数据稳定复现事件序列"。用 pi 1.4.0 / 1.3.0 回放同一组录制，黄金文件的差异精确到一个新增字段，升级审阅成本很低。

## 方案

### 为什么在 HTTP 层，而不是注入 `fetch`

pi-ai 的 `StreamOptions.fetch` 可以注入自定义 fetch，但 **Gemini 适配器明确不支持**（`Custom fetch is not supported by the Google Generative AI adapter`）。三种格式都支持经模型的 `baseUrl` 指向任意地址，所以统一用本地 HTTP 服务：

- 录制：pi → `src/record-proxy.mjs`（`127.0.0.1`）→ 上游。代理原样转发，边转发边记录；
- 回放：pi → `src/replay-server.mjs`（`127.0.0.1`），完全离线。

这样各家 SDK（openai、@anthropic-ai/sdk、@google/genai）的 HTTP 与 SSE 解析都在测试范围内，pi 升级带来的 SDK 变化也能被发现。

### 录制文件（`cassettes/<名称>.json`）

一次场景运行中按顺序发生的全部 HTTP 交互：请求（方法、路径、查询参数、部分请求头、JSON 请求体）与响应（状态码、`content-type`、按到达顺序记录的原始分块）。另记场景名、模型 id、录制来源与 pi 版本。

- **不含凭据**：请求头只记录 `content-type`、`anthropic-version`、`anthropic-beta`；查询参数中的 `key` 被替换。测试检查录制文件中不出现所用的 Key。
- **可复现**：重新录制得到逐字节相同的文件（CI 中重新录制后 `git diff --exit-code`）。
- 体积：11 个录制共约 116 KB。

### 请求比对

回放时每个请求都与录制的请求比较（JSON 深比较，与键顺序无关），不一致返回 500 并记入 `mismatches`，测试失败。这能发现 pi 升级后请求格式的变化（例如多发一个字段）。

唯一的规范化：pi-ai 为不带 id 的 Gemini 工具调用生成 `<工具名>_<Date.now()>_<计数>`，对 Gemini 3 起的模型这个 id 会发回给服务（`gemini-3-tool` 场景），录制与比对时都替换为 `<工具名>_<generated>`。

### 事件轨迹与黄金文件（`golden/<名称>.events.json`）

订阅 `Agent` 的全部事件，规范化后与黄金文件比对（`src/trace.mjs`）：

- 去掉 `timestamp`、`durationMs`；
- 工具调用 id 按首次出现顺序替换为 `<toolcall-n>`（Gemini 生成的 id 随时间变化，且计数是模块级的，与同一进程中此前的调用次数有关）；
- 去掉 `message_update` 中的消息快照（可由增量推出）；
- `message_start` 只保留 `role`（见观察 3）。

其余内容（增量的切分、工具参数、用量、`responseId`、`rawStopReason`、错误信息）都来自录制的响应，回放时必须完全一致。

### 场景

`src/scenarios.mjs`，三种格式各三个，另加两个：

| 场景 | 内容 |
|---|---|
| `<格式>-tool` | 思考内容 + 文本 + 一次工具调用，工具结果发回后得到最终回复（含中文） |
| `<格式>-parallel` | 同一条回复中两个工具调用 |
| `<格式>-auth-fail` | 服务返回 401 |
| `gemini-3-tool` | 模型 id 为 `gemini-3-*`，pi 会把生成的工具调用 id 发回服务 |
| `openai-abort` | 收到第 2 个文本增量时 `abort()` |

容器中没有真实 API Key，录制来源是 `src/upstream-mock.mjs`：按三种格式的协议输出 SSE（OpenAI 的 `reasoning_content` 与分段的工具参数、Anthropic 的内容块与 `signature_delta`、Gemini 的 `thought` 与不带 id 的 `functionCall`、`\r\n` 分隔），并故意按 7 / 13 / 29 字节切开、不对齐事件边界。

## 检查项

`test/contract.test.mjs`（对 `cassettes/` 下的每个录制）：

- 回放：没有请求不一致，录制的交互全部用完，事件轨迹与黄金文件相同；
- 稳定性：整块、1 / 2 / 3 / 64 字节（会切开多字节字符）、10 种随机分块，以及按录制分块重复 5 次，事件轨迹与工具收到的参数完全相同；
- 回放服务：提示词改变时报告请求体不一致，pi 以 `stopReason: 'error'` 结束；录制之外的请求被报告；
- 录制文件：每个场景都有录制；不含凭据。

`test/version.test.mjs`：

- `package.json` 中 pi 各包为精确版本，且版本相同；
- 锁文件中每个 pi 包（`@earendil-works/*`，集合随版本变化）只有一个版本，与声明一致；安装的版本与锁文件一致；
- pi-agent-core 实际解析到的 pi-ai 与直接依赖的是同一份（按真实路径比较，pnpm 的符号链接布局下同样适用）；
- pi 各包的依赖都是精确版本。

## 运行

```sh
cd spikes/pi-contract
npm ci
npx vitest run                          # 契约测试与版本守卫
node src/record.mjs                     # 用合成上游重新录制全部场景（之后回放一次确认一致）
npx vitest run -u                       # 审阅差异后更新黄金文件

# 从真实服务录制（例如 S2 的 DeepSeek），Key 只从环境变量读取，不写入文件：
node src/record.mjs --only=openai-tool --upstream=https://api.deepseek.com \
  --model=deepseek-chat --api-key-env=DEEPSEEK_API_KEY --name=deepseek-tool
npx vitest run -u                       # 为新录制生成黄金文件
```

CI：`.github/workflows/spike-pi-contract.yml` 在 Windows 与 Linux 上运行测试，并重新录制确认录制文件不变。

## 决策标准

能用录制数据稳定复现事件序列。

## 结果

**Linux 容器（x64），2026-11-03**：`vitest run` 31 项全部通过，连续运行多次结果相同；每个录制回放 22 次（共 242 次），整套约 2～3 秒。录制 → 回放的事件轨迹与直连上游时一致（`record.mjs` 对每个场景检查）。

**pi 升级演练**：用 1.5.0 的录制与黄金文件，分别安装 pi 1.4.0、1.3.0 运行同一套测试：

| 版本 | 请求不一致 | 黄金文件不一致 | 差异内容 | 版本守卫 |
|---|---|---|---|---|
| 1.4.0 | 0 | 7 / 11 | 只有 `usage.cost.totalFromProvider`（1.5.0 新增），共 42 处 | 通过 |
| 1.3.0 | 0 | 7 / 11 | 同上 | 通过 |

三个 401 场景与中止场景没有差异：它们的用量没有从响应计算，1.5.0 也不带这个字段。三个版本发出的请求完全相同。

**GitHub Actions（`windows-latest` 与 `ubuntu-latest`），2026-11-03**：31 项全部通过，整套约 6 秒（Windows）/ 4 秒（Linux）；重新录制后录制文件与仓库中的逐字节相同。

## 观察

1. **pi 发布很频繁**：1.0.0（2026-10-05）到 1.5.0（2026-11-02）共 7 个次版本，约每周一个。必须锁定精确版本、有计划地升级，不能用 `^`。
2. **pi 的依赖全部是精确版本**：包括 pi-ai 依赖的 openai 7.19.0、@anthropic-ai/sdk 0.129.0、@google/genai 2.21.0 等。锁定 pi 的版本就锁定了整个依赖树（再由锁文件固定间接依赖）。pi 包的集合也会变：pi-schema 从 1.5.0 起才有。
3. **`message_start` 中的助手消息不可作为契约**：它与 pi-ai 正在填充的消息是同一个对象。Anthropic 的首个 SSE 事件带用量与消息 id，若它与开始事件同一批到达（整块回放时稳定复现），`message_start` 里已经有用量。实际网络中这取决于分块，适配器只应从 `message_start` 取 `role`，用量以 `message_end` / `turn_end` 为准。
4. **中止的轨迹也是稳定的**：在文本增量回调中同步调用 `abort()`，即使整个响应一次到达，也不再有新的增量，只补发进行中内容块的 `thinking_end` / `text_end`，再以 `stopReason: 'aborted'` 结束，15 种分块方式下结果相同。
5. 三种格式的错误信息格式不同（OpenAI 为 `401: {...}`，Anthropic 为 `401 {...}`，Gemini 只有响应体），适配器需要按状态码而不是文本归类错误。
6. **pnpm**：pnpm 10 下 pi-ai 的存储目录名带有 peer 依赖后缀（`@earendil-works+pi-ai@1.5.0_@aws-sdk+credential-provider-node@…_ws@…`）。同一个 workspace 中如果不同包解析出不同的 peer，可能装出两份 pi-ai；"同一份"守卫测试在 pnpm 布局下验证过。npm 下故意把 pi-ai 声明为 1.4.0（pi-agent-core 1.5.0），会在 pi-agent-core 下嵌套一份 1.5.0，守卫测试三项失败。
7. pi 依赖树中只有 protobufjs 有安装脚本（版本号格式检查，只输出警告）；pnpm 10 默认不执行依赖的安装脚本，不需要加入允许列表。

## M1 落地建议

- **M1-01**：`packages/runtime-pi/package.json` 声明 pi-agent-core 与 pi-ai 的同一精确版本；移植 `version.test.mjs` 的守卫（读 `pnpm-lock.yaml` 或按真实路径比较）。
- **M1-02**：把 `record-proxy`、`replay-server`、规范化与录制文件格式移到 `packages/runtime-pi` 的测试工具中，改为 TypeScript。黄金文件比对**适配器输出的 `RuntimeEvent`**（我们的契约），而不是 pi 的原始事件；pi 新增字段若不被适配器使用，不会造成黄金文件变化。请求比对保留，用来发现请求格式变化。
- 录制来源：合成上游保证三种格式都有覆盖且可在 CI 中重新录制；S2（DeepSeek）用真实服务录制的文件直接放入 `cassettes/`，按同样方式回放。
- **升级流程**：pi-agent-core 与 pi-ai 一起升级 → 运行契约测试 → 审阅请求不一致与黄金文件差异 → `vitest -u` 更新黄金文件，在 PR 中说明差异。

## 用本地网关做真实测试（magpie）

网关地址、Key 与模型见 [`docs/dev/local-testing.md`](../../docs/dev/local-testing.md)（`127.0.0.1:3425`，四种格式共用，模型 `group/smart-split`，Key 任意，统一用 `magpie`）。`group/smart-split` 的后端是 **deepseek-v4.1-flash**，经反向代理的 WorkBuddy 提供（`/v1/models` 显示 `magpie-deepseek`），不是 DeepSeek 官方 API，结果可能带有反代引入的差异。只能在那台机器上运行。

### 步骤（PowerShell）

```powershell
cd spikes\pi-contract
npm ci

# 1. 确认网关在运行（应返回 200 和模型列表）
Invoke-WebRequest http://127.0.0.1:3425/v1/models -Headers @{Authorization='Bearer magpie'} | Select-Object StatusCode

# 2. 录制：--upstream 不带路径，record.mjs 会按格式补 /v1、/v1beta。Key 只经环境变量传入，不写入录制文件
$env:MAGPIE_KEY = 'magpie'
foreach ($s in 'openai-tool','openai-parallel','openai-abort','anthropic-tool','anthropic-parallel','gemini-tool','gemini-parallel') {
  node src/record.mjs --only=$s --upstream=http://127.0.0.1:3425 --model=group/smart-split --api-key-env=MAGPIE_KEY --name=magpie-$s
}
# 每行应输出 OK（录制后回放一次，事件轨迹与直连时一致）

# 3. 把录制挪出 cassettes/：这些录制没有黄金文件，留在 cassettes/ 会让 vitest 失败
$out = "$env:TEMP\nexus-magpie"
New-Item -ItemType Directory -Force $out | Out-Null
Move-Item cassettes\magpie-*.json $out -Force

# 4. 查看每轮回复：stopReason、用量、文本、工具调用
node src/inspect.mjs $out magpie-

# 5. Responses 格式不在 pi-ai 场景中，单独验证
Invoke-WebRequest -Method Post http://127.0.0.1:3425/v1/responses -Headers @{Authorization='Bearer magpie'} `
  -ContentType 'application/json' -Body '{"model":"group/smart-split","input":"Reply with exactly: pong"}' |
  Select-Object -ExpandProperty Content
```

认证失败路径（`*-auth-fail`）无法用这个网关测试：网关信任回环请求，任何 Key 都会通过，这三个场景继续用合成上游（`node src/record.mjs --only=openai-auth-fail` 等，不带 `--upstream`）。注意 `gemini-3-tool` 依赖模型 id 以 `gemini-3` 开头，`--model` 覆盖后就失去意义，不必录制。

### 结果（2026-11-04，pi 1.5.0）

| 场景 | 结果 |
|---|---|
| `*-tool`（三种格式） | 通过：调用 `add{"a":2,"b":3}`，最终回复 `2 + 3 = 5`，stop 依次为 `toolUse` → `stop` |
| `*-parallel`（三种格式） | 通过：一条回复中两个调用 `add{2,3}`、`add{10,20}`，最终回复正确 |
| `openai-abort` | 通过：第 2 个文本增量时中止，`stopReason: 'aborted'` |
| Responses（手工请求） | 通过：200，`output_text` 为 `pong`，`status: completed` |
| `*-auth-fail`（错误 Key） | 返回 200 并正常回答，没有 401。这是网关的设计：信任本机回环请求，不校验 Key |

另外的观察：

1. **上游输出乱码 token**：不带工具、提示词为 `Hello` 时，三种格式的回复都混入了垃圾内容，例如 Gemini 的 `Hello! Iu003c｜end▁of▁sentence｜u003e`、OpenAI 的 `What would you# you like…`。原始 SSE 分块中就是这样，像是 DeepSeek 的结束符泄漏，并非 pi 解析错误。带工具的场景中没有出现。网关是反代的 WorkBuddy，不能确定问题出在模型还是反代，不应据此判断 DeepSeek 官方 API 的行为。
2. `/v1/models` 标记 `reasoning: true`，但所有回复都没有思考内容。pi 默认没有请求推理，这是预期行为。
3. Gemini 格式返回的工具调用不带 id，由 pi 生成，回放正常。

## 用 DeepSeek 官方 API 做真实测试

官方 API 的 `/models` 列出 `deepseek-flash`（DeepSeek-V4.1-Flash，与本地网关反代的是同一个模型）和 `deepseek-v4-pro`。支持 OpenAI 格式（`https://api.deepseek.com`）与 Anthropic 格式（`https://api.deepseek.com/anthropic`），不支持 Gemini 格式。Key 只从环境变量读取，不要写进仓库；录制文件不含 Key（已检查）。

```powershell
cd spikes\pi-contract
$env:DEEPSEEK_API_KEY = '<官方 Key>'
foreach ($s in 'openai-tool','openai-parallel','openai-abort') {
  node src/record.mjs --only=$s --upstream=https://api.deepseek.com --model=deepseek-flash --api-key-env=DEEPSEEK_API_KEY --name=ds-$s
}
foreach ($s in 'anthropic-tool','anthropic-parallel') {
  node src/record.mjs --only=$s --upstream=https://api.deepseek.com/anthropic --model=deepseek-flash --api-key-env=DEEPSEEK_API_KEY --name=ds-$s
}
# 认证失败：换成错误的 Key 录制 openai-auth-fail / anthropic-auth-fail
# 不带工具的 "Hello"：用正确的 Key 录制 *-auth-fail 场景，--name 起名为 ds-*-hello
$out = "$env:TEMP\nexus-ds"; New-Item -ItemType Directory -Force $out | Out-Null
Move-Item cassettes\ds-*.json $out -Force
node src/inspect.mjs $out ds-
```

`record-proxy.mjs` 原来用 `new URL(req.url, upstream)` 拼接地址，会丢掉上游地址的路径前缀：`https://api.deepseek.com/anthropic` 被请求成 `https://api.deepseek.com/v1/messages`，返回 404。现已改为保留前缀。

### 结果（2026-11-04，pi 1.5.0，`deepseek-flash`）

| 场景 | OpenAI 格式 | Anthropic 格式 |
|---|---|---|
| `*-tool` | 通过：`add{2,3}` → `2 + 3 = **5**` | 通过：思考内容 + `add{2,3}` → `2 + 3 = 5.` |
| `*-parallel` | 通过：思考内容 + 两个调用 → `5`、`30` | 通过：思考内容 + 两个调用 → `5`、`30` |
| `openai-abort` | 通过：第一轮带思考内容并调用工具，第二轮在第 2 个文本增量时中止，`aborted` | — |
| 不带工具的 `Hello` | 通过：回复正常，**没有乱码** | 通过：回复正常，没有乱码 |
| 错误 Key | `401`，`authentication_error`，错误信息中 Key 被打码为 `****0000` | `401`，`authentication_error` |

与本地网关（反代 WorkBuddy）的对比：

1. 官方 API 返回**思考内容**（OpenAI 格式的 `reasoning_content`、Anthropic 格式的 thinking 块），网关的回复都没有。
2. 官方 API 在 `Hello` 场景中**没有乱码**，说明网关回复里的 `<｜end▁of▁sentence｜>` 等垃圾内容来自反代，而不是模型。
3. 官方 API 能测认证失败路径（真实的 401），网关不能。
4. 两种格式的 401 错误信息格式不同（OpenAI 为 `401: {...}`，Anthropic 为 `401 {...}`），与合成上游一致（见观察 5）。

另：在这台 Windows 机器上用合成上游重新录制（`node src/record.mjs`），有 8 个录制文件的首个分块切分与仓库中的不同（`"data: {\"id\"…` 被切成 `"data: {"` 与 `"\"id\"…"`），改动前的 `record-proxy.mjs` 也一样；`vitest run` 31 项仍全部通过。可能与本机的网络分块时机有关，CI 的"重新录制后逐字节相同"检查在这台机器上不一定成立。
