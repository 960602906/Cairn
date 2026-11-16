# M6-00 预研报告：平台矩阵、Windows 假设与开源检查清单

> 状态：已实施（2026-11-16，代码审计与文档基线，无真实 macOS/Linux 机器验证）。
> 上级文档：[M6 计划](m6.md)。本报告完成 M6-00 的预研结论，M6-01～M6-05 的平台实现
> 与 M6-06 的开源材料落地分别由后续任务完成。
>
> 重要边界：本报告是**静态审计 + 文档结论**，不是多平台验收。macOS/Linux 上「安装、
> 启动、跑通一次真实编码任务」的结论必须由 M6-02/M6-03/M6-10 在真实或 CI 平台上产生，
> 本报告不得用「代码看起来兼容」替代。

## 1. 结论摘要

| 预研项 | 结论 | 对计划的影响 |
|---|---|---|
| 平台矩阵 | Windows x64（已有）、macOS arm64+x64、Linux x64；最低版本见 §2 | 平台范围与 M6 §2.1 一致，无需变更 |
| Windows 假设审计 | 共享代码已基本平台无关；平台判断集中在 `@cairn/shell` 与少量路径/进程处，均以 `process.platform` 参数注入，可测试 | M6-01 把散落判断收进具名适配层即可，无需重写引擎 |
| 沙箱语义 | 非 Windows 目前是「不支持」的明确降级，未假称已隔离 | 与 ADR-0034 一致；M6-05 补 Linux/macOS 能力边界 |
| 凭据存储 | Linux 无密钥环时 `safeStorage` 后端为 `basic_text`/`unknown`，当前按不可用处理（拒绝保存） | M6-04 补口令派生密钥或明确拒绝的提示 |
| 开源许可证 | **MIT**（项目所有者 2026-11-16 确认） | M6-06 替换专有 beta 许可，写 ADR-0039 |
| 贡献者协议 | **DCO**（`Signed-off-by`），不引入 CLA（2026-11-16 确认） | M6-06 加入 CONTRIBUTING 与 DCO 说明 |
| 敏感信息扫描 | 需在 M6-06 执行 git 历史全量扫描 | §5 给出可复现命令与检查清单 |

## 2. 平台矩阵

### 2.1 范围与最低系统版本

| 平台 | 架构 | 发布形态 | 最低系统版本（基线） | 备注 |
|---|---|---|---|---|
| Windows | x64 | NSIS 按用户安装 | Windows 10（暂定，Electron 45 下限待核实） | M5 已实现；本机 24H2 已验收 |
| macOS | arm64 + x64（Universal 或分架构） | DMG + ZIP（更新用） | macOS 12 Monterey（暂定，待核实） | 首次正式支持，M6-02 落地 |
| Linux | x64 | AppImage + deb | Ubuntu LTS（22.04/24.04 为目标基线，glibc 下限待核实） | 其他发行版 best-effort |

**最低版本依据与待核实项**：Windows 10 起（Electron 23 已放弃 Windows 7/8）、Linux
glibc 2.31+（Ubuntu 20.04 起）、macOS 12 起是基于历史版本的**暂定候选**，不是已确认的
Electron 45 下限；本机无法访问 electronjs.org 在线确认。M6-02/M6-03 在真实机器上启动前，
必须核对 [Electron 官方支持文档](https://www.electronjs.org/docs/latest/tutorial/support) 与
[Electron 45 发布说明](https://www.electronjs.org/blog)，再把经过验证的最低版本更新到此表。
在核实前不得以暂定候选作为发行版对外的最低系统要求。

不在本轮范围（与 M6 §2.1 一致）：Windows ARM64、Linux arm64、32 位、移动端、Web 版、
企业分发与 MSIX。接口层为这些平台留位置（M6-01），本轮不实现。

### 2.2 每平台验证形态

| 平台 | 单测/覆盖率 | build/smoke | e2e | 打包 | 备注 |
|---|---|---|---|---|---|
| Windows | CI | CI | CI | CI（NSIS） | 已有 |
| Ubuntu | CI | CI | CI（`xvfb-run`） | CI（AppImage/deb，M6-03 后） | M6-03 落地 |
| macOS | CI（`macos-latest`） | CI | 手工/打包冒烟 | CI（DMG，M6-02 后） | runner 受签名账号限制时记录 |

## 3. 共享代码里的平台判断审计

### 3.1 现状：已经平台无关

逐包审计 `process.platform` / `win32` / `darwin` / `linux` 的出现位置，结论是共享代码
**总体上没有把 Windows 假设写进平台无关的接口**。大部分平台分支满足：

1. 通过函数参数注入 `platform: NodeJS.Platform`（默认 `process.platform`），测试可传假平台；
2. 平台差异被封装在具名模块里，调用方不直接判断平台。

例外见 §3.2（模块级常量、MCP 子进程结束、沙箱协议枚举），由 M6-01/M6-05 收口。

### 3.2 需要 M6-01 收口的散落判断

| 位置 | 现状 | M6-01 动作 |
|---|---|---|
| `packages/tools/src/paths.ts:16` | `PATH_STYLE = process.platform === 'win32' ? 'win32' : 'posix'`，是模块级常量，测试用 `createPathResolver(root, style)` 注入 | 收进 `@cairn/tools` 的平台适配层或保留注入（已可测，优先级低） |
| `packages/tools/src/ripgrep.ts:9` | `RIPGREP_BINARY = process.platform === 'win32' ? 'rg.exe' : 'rg'`，模块级常量 | 同上 |
| `packages/mcp/src/sdk-client.ts:57` | `stdioCommand` 已用注入的 `platform`；`sdk-client.ts:153` 还有一处 `process.platform` 未注入 | 把 `createSdkClient` 的平台也改为注入（影响面小） |
| `packages/core/src/system-prompt.ts:147` | `operatingSystemName(platform)` 已是纯函数，无平台判断泄漏 | 无需改动 |
| `packages/shell/**` | `select.ts`、`process-tree.ts`、`sandbox/probe.ts`、`sandbox/restricted.ts`、`sandbox/windows-api.ts` 全部以 `options.platform` 注入 | 已是适配层雏形；M6-01 补「不支持时明确错误」的统一出口 |
| `packages/protocol/src/sandbox.ts:85` | `platform: z.enum(['win32', 'other'])` | M6-05 细化为 `win32 | darwin | linux | other` |

**结论**：共享包的少量散落平台判断有封装不充分之处；M6-01 的工作是**收口**而非
重写——把上表散点收进具名适配层，统一「不支持平台」的错误与降级语义，
并让 `createSdkClient` 平台可注入。真实「Windows 专属」代码集中在 `packages/shell/src/sandbox/*`
与 `apps/desktop/src/main/services/*`（safeStorage、git-locator、打包脚本），边界已经清晰。

### 3.3 打包脚本的 Windows 假设

`apps/desktop/scripts/*.mjs`（`packaging.mjs`、`packaged-app.mjs`、`smoke-*.mjs`、
`verify-package.mjs`）当前只实现 Windows 目标（NSIS + `win-unpacked` + MinGit 校验）。这些是
**构建工具脚本**而非共享接口，M6-02/M6-03 在打包脚本里加 `darwin`/`linux` 分支，不触碰
`@cairn/*` 的接口。M6-01 审计结论：打包脚本的 Windows 假设不违反「共享接口平台无关」，
属于平台实现层，可以保留分支。

## 4. 许可证候选与贡献者协议

### 4.1 许可证：MIT（已确认）

候选对比：

| 维度 | MIT | Apache-2.0 |
|---|---|---|
| 宽松程度 | 最宽松 | 宽松 + 明确专利授权与贡献者授权 |
| 文本长度 | 极短 | 较长 |
| 社区熟悉度 | 最高 | 高 |
| 与 ADR-0014 契合 | 完全一致（生产依赖只允许宽松许可） | 一致 |

**决定：MIT。** 项目所有者 2026-11-16 确认。理由：项目自身代码用最宽松的 MIT，与
ADR-0014「依赖只用宽松许可证」一致，零额外法律文本负担；第三方二进制（MinGit GPLv2、
ripgrep MIT/Unlicense、JetBrains Mono OFL）仍各自按自己的许可证分发，不受项目 MIT 影响。
M6-06 用 MIT 全文替换 `LICENSE`，并新增 ADR-0039 记录。

### 4.2 贡献者协议：DCO（已确认）

**决定：DCO（Developer Certificate of Origin），不引入 CLA。** 项目所有者 2026-11-16 确认。
理由：个人开源项目、无集中再许可需求，DCO 的 `Signed-off-by` 足以满足「贡献者有权贡献」的
声明，无法律文书与法务维护成本，是开源项目的现代默认。M6-06 在 CONTRIBUTING 中写明 DCO 要求，
PR 模板带 `Signed-off-by` 提示（CI 是否强制 `--signoff` 校验由 M6-07 决定，避免一开始就
挡住外部贡献者）。

## 5. 仓库公开前检查清单

在 M6-06 执行，每一项都要有可复现命令或文档引用。**本报告只列清单，执行记录由 M6-06 产出。**

### 5.1 密钥与敏感信息

```bash
# 全量历史扫描密钥、令牌与私钥（不只看工作区，要看所有提交）
git rev-list --all | xargs -I{} sh -c \
  'git grep -nE "(AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----)" {} -- 2>/dev/null' \
  | sort -u

# 全量历史扫描常见内网地址与个人路径（按项目实际情况补充域名/IP/路径）
git rev-list --all | xargs -I{} sh -c \
  'git grep -nE "(10\.[0-9]+\.[0-9]+\.[0-9]+|192\.168\.[0-9]+\.[0-9]+|corp\.|intranet|/Users/|C:\\Users\\)" {} -- 2>/dev/null' \
  | sort -u
```

### 5.2 内部资料与不可分发二进制

- [ ] 审核 `git ls-files` 中所有 `*.pem`、`*.p12`、`*.pfx`、`*.key`、`*.env`（含历史）。已知有 `apps/desktop/e2e/fixtures/localhost-{cert,key}.pem` 测试用自签名证书与私钥；核验其仅用于本地回环测试，绝不用于生产，其他条目逐项确认。
- [ ] 确认没有提交过 `.cache/mingit`、`apps/desktop/resources/git`（随包 Git 由 `pnpm fetch:mingit` 现取）。
- [ ] 确认没有 IDE 本地配置、`.scratch/`、`design/` 等本地目录入库（`.gitignore` 已覆盖 `.scratch/`，`design/` 需复核）。
- [ ] 确认测试中的凭据都是样例数据（如 `{{SECRET_*}}` 占位、假 key），无真实可用 key。

### 5.3 第三方许可证与源码获取

- [ ] `pnpm check:licenses` 通过；`scripts/license-exceptions.json` 的例外（MinGit GPLv2、
  JetBrains Mono OFL 等）都有理由且不扩展到其他依赖。
- [ ] `THIRD_PARTY_NOTICES.txt` 由 `scripts/third-party-notices.js` 生成，包含 MinGit 的
  GPLv2 全文与源码获取地址（`scripts/licenses/mingit`）。
- [ ] 随包二进制（MinGit、ripgrep）在 `scripts/bundled-binaries.json` 登记完整（版本、许可证、
  来源、SHA256）。

### 5.4 开源材料完整性

- [ ] `LICENSE` 替换为 MIT 全文（M6-06）。
- [ ] 新增 `CONTRIBUTING.md`（含 DCO 说明、本地构建/测试命令、PR 流程）、`CODE_OF_CONDUCT.md`、
  `SECURITY.md`、`.github/ISSUE_TEMPLATE/*`、`.github/PULL_REQUEST_TEMPLATE.md`。
- [ ] README 有英文版本或双语，外部贡献者能凭它构建、测试、提交 PR。

## 6. 复现命令

本报告结论来自以下静态审计（本机 Windows，2026-11-16）：

```powershell
# 平台判断散点
git grep -nE "process\.platform|platform ===|platform !==|'win32'|'darwin'|'linux'" -- "packages/*/src" "apps/desktop/src" "apps/desktop/scripts"

# 开源材料现状（预期为空，说明尚无 CONTRIBUTING/CODE_OF_CONDUCT/SECURITY 与模板）
git ls-files | grep -iE "CONTRIBUTING|CODE_OF_CONDUCT|SECURITY|ISSUE_TEMPLATE|PULL_REQUEST_TEMPLATE"

# 敏感信息扫描（见 §5.1，M6-06 执行并记录）
```

## 7. 未验证项（不得外推）

- macOS/Linux 上真实安装、启动、跑通任务：需 M6-02/M6-03 在真实或 CI 平台执行。
- Electron 45 的最低系统版本：本机无法访问 electronjs.org 确认，§2.1 的基线下限
  需在 M6-02/M6-03 前复核官方发布说明，不当作已核实事实。
- 历史敏感信息扫描尚未执行：§5 只给出命令，执行结果与清理记录属于 M6-06。
