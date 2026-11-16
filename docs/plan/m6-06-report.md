# M6-06 开源材料与仓库公开：执行记录

> 状态：已实施（2026-11-16）。
> 上级文档：[M6 计划](m6.md)。检查清单来源：[M6-00 预研报告](m6-spikes.md) §5。
> 许可证与贡献者协议：[ADR-0039](../adr/0039-open-source-license-and-dco.md)。

## 1. 交付

| 项 | 文件 | 说明 |
|---|---|---|
| 许可证 | `LICENSE` | 专有 beta EULA 替换为 MIT 全文（Copyright © 2026 Cairn contributors） |
| 贡献指南 | `CONTRIBUTING.md` | DCO（`git commit -s`）、本地构建/测试命令、PR 检查清单 |
| 行为准则 | `CODE_OF_CONDUCT.md` | Contributor Covenant 2.1，中英对照 |
| 安全策略 | `SECURITY.md` | 支持范围、私有漏洞报告渠道、处理时限、范围与安全模型 |
| Issue 模板 | `.github/ISSUE_TEMPLATE/bug_report.yml`、`feature_request.yml`、`config.yml` | 表单模板；安全与文档走 contact links |
| PR 模板 | `.github/PULL_REQUEST_TEMPLATE.md` | 检查项与 DCO、i18n、截图要求 |
| 英文 README | `README.en.md` | 与 `README.md` 互相链接 |
| 包元数据 | `package.json`、`apps/desktop/package.json` | 增加 `"license": "MIT"` |
| 本地环境文档 | `docs/dev/local-testing.md` | 移除维护者个人路径、用户名与本机网关信息，改为通用指引 |

## 2. 公开前检查清单执行结果

### 2.1 密钥与敏感信息（全量历史）

命令（与 m6-spikes.md §5.1 相同）：

```bash
git rev-list --all | xargs -I{} sh -c \
  'git grep -nE "(AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----)" {} -- 2>/dev/null' \
  | sort -u
```

结果：命中的文件只有两个，均为测试夹具，**没有可用的真实凭据**：

| 文件 | 命中内容 | 判定 |
|---|---|---|
| `packages/core/src/redact.test.ts` | 脱敏测试用的样例 key（GitHub / AWS / Anthropic / OpenAI 等格式） | 合成夹具，用于断言 `redact()` 能识别并替换；不指向任何真实账号 |
| `apps/desktop/e2e/fixtures/localhost-key.pem` | `-----BEGIN PRIVATE KEY-----` | e2e 本地回环 HTTPS 的自签名证书私钥；`CN=localhost`，自签（issuer 同为 `CN=localhost`），仅供 Playwright 测试，不使用于生产或分发 |

内网地址与个人路径扫描（同一命令，匹配 `10.*`、`192.168.*`、`corp.`、`intranet`、
`/Users/`、`C:\Users\`）在历史中没有命中（`C:\Users\` 仅出现在测试断言的样例路径与
`docs/dev/local-testing.md`，见 2.5）。

### 2.2 内部资料与不可分发二进制

- [x] `git ls-files` 中的 `*.pem` / `*.p12` / `*.pfx` / `*.key` / `*.env`：只有
      `apps/desktop/e2e/fixtures/localhost-{cert,key}.pem`，如上确认为本地回环测试自签名证书。
- [x] 没有提交 `.cache/mingit` 或 `apps/desktop/resources/git/`；`.gitignore` 已排除
      `apps/desktop/resources/git/`，随包 Git 由 `pnpm fetch:mingit` 现取。
- [x] 没有提交 `.scratch/`（`.gitignore` 已覆盖）。`design/` 只存在于本机且未入库，
      由 `.git/info/exclude` 排除；`git ls-files` 无 `design/` 条目。
- [x] 测试中的凭据均为样例数据（`redact.test.ts`、`diagnostics-service.test.ts` 的 key 与路径），
      无真实可用 key。

### 2.3 第三方许可证与源码获取

- [x] `pnpm check:licenses` 通过（`License check passed.`）。
- [x] `scripts/license-exceptions.json` 的 5 条例外均有理由，且只覆盖具体 `name@version`：
      caniuse-lite（CC-BY-4.0，构建期）、JetBrains Mono（OFL-1.1，随界面分发）、
      argparse（Python-2.0，构建期）、truncate-utf8-bytes（WTFPL，构建期）、
      MinGit（GPL-2.0-only，作为独立程序聚合分发）。
- [x] `scripts/bundled-binaries.json` 登记 ripgrep 15.0.0（MIT OR Unlicense）与
      MinGit 2.56.0.4（GPL-2.0-only），含来源与许可证目录；`scripts/licenses/mingit/LICENSE`
      为 GPLv2 全文，`THIRD_PARTY_NOTICES.txt` 由构建脚本生成。

### 2.4 开源材料完整性

- [x] `LICENSE` 为 MIT 全文。
- [x] `CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`SECURITY.md`、Issue/PR 模板齐备。
- [x] 英文 README（`README.en.md`），与中文 README 互相链接；外部贡献者可据此安装依赖、
      构建、运行测试并提交 PR。

### 2.5 历史遗留与待决事项

- **个人路径与维护者标识**：`docs/dev/local-testing.md` 的历史提交中包含维护者的 Windows
  用户路径与旧项目名，以及本机模型网关（回环地址、占位 Key）。工作区已改写为通用指引；
  历史提交仍保留旧内容。改写 git 历史会重写全部提交 SHA 并影响已有分支与 PR，
  **需要项目所有者确认后单独执行**（例如 `git filter-repo`），本任务不做。
- 仓库当前在 GitHub 上已是公开状态（`gh repo view` 显示 `PUBLIC`）。若决定改写历史，
  应在改写完成后统一通知已有克隆。

## 3. 验收

| 验收项 | 结果 |
|---|---|
| 外部贡献者能构建、测试与提交 PR | 是：README / README.en.md / CONTRIBUTING.md 给出 Node 24.11+、pnpm 10、`pnpm install` / `typecheck` / `lint` / `test:coverage` / `build` / `e2e` |
| `pnpm check:licenses` 通过 | 是 |
| 没有密钥或内部地址 | 工作区：是（个人路径与网关信息已移除）；历史：无可用凭据，仅有合成夹具与维护者本机路径，见 §2.5 |
| 语言与文化 | 新增文档中英对照；用户可见文案仍由 `check:i18n` 校验 |

## 4. 未完成 / 后续

- DCO 的 CI 强制校验未启用（ADR-0039 交由 M6-07 决定）。
- 历史改写（§2.5）待所有者决定。
- 商标与项目名称使用规则未单独成文（ADR-0039 后果一节）。
