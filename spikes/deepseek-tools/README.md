# S2：DeepSeek 工具调用预研

## 问题

m0.md 第 4 节 S2，ADR-0011、ADR-0021：DeepSeek 推理模型的思考内容字段、多轮工具调用、并行工具调用在 pi-ai 下是否正常，流式字段是否完整。

决策标准：多轮工具调用 10 次中成功 ≥ 9 次；思考内容可被正确区分。

## 版本与目标

- @earendil-works/pi-agent-core、@earendil-works/pi-ai 1.5.0（与 S8 相同）。本目录不属于 pnpm workspace，用 npm 独立安装。
- 模型：DeepSeek V4.1 Flash（pi-ai 内置目录中的 `deepseek-flash`）。

| 目标 | 地址 | 说明 |
|---|---|---|
| `deepseek` | `https://api.deepseek.com` | 官方，openai 格式；模型定义直接取 pi-ai 内置目录 |
| `deepseek-anthropic` | `https://api.deepseek.com/anthropic` | 官方，anthropic 格式 |
| `gateway-openai` | `http://127.0.0.1:3425/v1` | 本地网关（docs/dev/local-testing.md），后端同为 deepseek-v4.1-flash，经 WorkBuddy 反代 |
| `gateway-anthropic` | `http://127.0.0.1:3425` | 同上，anthropic 格式 |
| `gateway-gemini` | `http://127.0.0.1:3425/v1beta` | 同上，gemini 格式 |

Key 只从环境变量读取：官方用 `DEEPSEEK_API_KEY`；网关用 `NEXUS_GATEWAY_KEY`，未设置时用 `magpie`（网关信任本机回环请求）。结果文件不含 Key。

## 场景与检查项

`src/scenarios.mjs`。三个模拟工具：`get_order`（订单 → 客户编号）、`get_customer`（客户编号 → 姓名、城市）、`get_weather`（城市 → 气温）。

| 场景 | 内容 | 成功条件 |
|---|---|---|
| `chain` | “订单 A-1024 的客户所在城市现在多少度？”，再追问“这位客户叫什么名字？” | 依次调用 `get_order(A-1024)` → `get_customer(C-77)` → `get_weather(杭州)`，第一轮回答含 23，第二轮回答含“张晓明” |
| `parallel` | “同时查一下北京和上海现在的气温。” | 两个城市都查了，回答含 12 和 18；另记录是否在同一条回复中并行调用 |

每条助手消息还要通过流式完整性检查：

- 正文、思考内容的增量拼接后与最终内容一致；
- 正文中没有 `<think>` 标签，思考内容没有混进正文；
- 工具参数是合法 JSON；
- 不是错误结束，用量不为 0。

每个目标分思考开启（`thinkingLevel: 'high'`）与关闭（`'off'`）各跑一遍。思考开启时，DeepSeek 要求之后的请求带回上一轮的 `reasoning_content`，否则返回 400，所以 `chain` 能走通本身就检验了这一点。

判定：思考开启时 `chain` 成功 ≥ 9/10，且有思考内容。

## 运行

```sh
cd spikes/deepseek-tools
npm ci
DEEPSEEK_API_KEY=... node src/cli.mjs --targets=deepseek,deepseek-anthropic --runs=10
node src/cli.mjs --targets=gateway-openai,gateway-anthropic,gateway-gemini --runs=10   # 只能在网关所在的机器上运行
```

可选参数：`--scenarios=chain,parallel`、`--thinking=high,off`、`--out=results/result.json`（`results/` 不提交）。

## 结果（2026-11-04）

官方接口在云端容器上运行，网关在 lan 的 Windows 机器上运行。每格为成功次数 / 带思考内容的次数（各 10 次）。

| 目标 | 思考开启 chain | 思考开启 parallel | 思考关闭 chain | 思考关闭 parallel | chain 中位耗时（开启） |
|---|---|---|---|---|---|
| `deepseek` | 10 / 10 | 10 / 8 | 10 / 0 | 10 / 0 | 6.3 s |
| `deepseek-anthropic` | 10 / 10 | 10 / 4 | 10 / 0 | 10 / 0 | 5.6 s |
| `gateway-openai` | 10 / 10 | 10 / 9 | 10 / **10** | 10 / **8** | 9.3 s |
| `gateway-anthropic` | 10 / 10 | 10 / 3 | 10 / 0 | 10 / 0 | 10.5 s |
| `gateway-gemini` | 10 / 10 | 10 / 7 | 10 / **8** | 10 / **8** | 11.4 s |

- 全部 200 次运行成功，流式完整性检查没有发现问题：增量与最终内容一致，思考内容与正文分开，工具参数都是合法 JSON。
- `chain`：每次都按顺序调用 3 个工具。官方接口上每次正好 3 次调用、5 次请求（3 次工具调用、第一轮回答、追问的回答），追问都从上下文中答出，没有重复调用工具。思考开启时多轮工具调用全部成功，pi 正确带回了 `reasoning_content`（openai 格式）和 thinking 块（anthropic 格式）。
- `parallel`：每次都在同一条回复中发出两个工具调用。
- 思考关闭时，官方接口不返回思考内容；网关的 openai、gemini 格式仍然返回。这说明网关（反代）没有转发关闭思考的参数。
- 思考开启时，简单的并行查询有时不产生思考内容，这是模型自己的选择，官方接口同样如此。
- 网关比官方慢约 50%～100%。另外在 S8 的录制中，网关的普通回复会夹带 `<｜end▁of▁sentence｜>` 等乱码，官方接口没有，见 `spikes/pi-contract/README.md`。

## 结论

- **达标**：DeepSeek V4.1 Flash 在 pi-ai 1.5.0 下，多轮工具调用、并行工具调用、思考内容都正常，思考开启时多轮工具调用 10/10。openai、anthropic 两种格式都可用。
- **对 M1 的影响**：
  - pi-ai 按地址（`deepseek.com`）或 provider id 识别 DeepSeek，再自动设置兼容参数：`thinkingFormat: 'deepseek'`、`requiresReasoningContentOnAssistantMessages`、`max_tokens` 等。经代理或自定义 `baseUrl` 接入时识别不到，需要显式给出这些参数，否则思考模式下的多轮工具调用会失败。所以 M1 的提供方配置要支持“兼容模板”：选择模型家族（如 DeepSeek）后带出兼容参数，并允许高级设置覆盖。
  - DeepSeek 默认用 pi-ai 内置目录中的模型定义（id、上下文长度、思考等级映射），不自己维护。
  - 第三方代理可能不遵守关闭思考的参数，界面上应如实显示收到的思考内容，不能假定思考已经关闭。
