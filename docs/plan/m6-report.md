# M6 跨平台与开源验收报告

> 状态：**M6-00～M6-08 已完成并合并；M6-09 的 stable 阻塞项（Windows 签名、法务、干净 VM 与
> 真实更新演练）明确延期；M6-10 完成全流程验收、文档同步与分支清理。** 未执行的真机/签名/标签
> 发布矩阵不记为通过，见 §6。
>
> 相关文档：[M6 计划](m6.md)、[预研基线](m6-spikes.md)、[M5 验收报告](m5-report.md)、
> [安装说明](../dev/install.md)、[发布运行手册](../dev/release.md)、[架构设计](../architecture.md)。

## 1. 结论摘要

- **三个平台的 CI 与打包路径可用**：Windows、Ubuntu、macOS 运行器上都完成了
  format、typecheck、lint、format、i18n、单测与覆盖率、build、smoke、`package:dir`、
  `package:verify`、`smoke:packaged`；Windows 另跑打包应用 e2e（解包产物），Windows 与
  Linux 跑 Playwright e2e。
- **发布流水线已按平台拆分**：`prepare` → `build-windows` / `build-macos` / `build-linux` →
  `assemble` → `publish`，各平台产物、更新元数据与签名门禁由单元测试覆盖（ADR-0043）。
- **仓库已公开**：MIT 许可证、DCO、贡献/行为准则/安全策略与 Issue/PR 模板齐备。
- **不能签发 stable**：Windows 代码签名、macOS Developer ID 签名与公证、法务确认、干净 VM
  与标准用户矩阵、真实 `0.1.0 → 0.1.1` 更新演练仍未执行。M6-09 因此延期，重新开启条件见 §7。
- 产品运行时没有为“看起来跨平台”而放宽安全语义：Linux 无密钥环时拒绝保存凭据（ADR-0040），
  非 Windows 平台明确标注“未沙箱化”而不是声称已隔离（ADR-0034）。

## 2. 交付与合并记录

所有任务均以独立 PR 合并到 `main`，每个提交都有 DCO `Signed-off-by`。

| 任务 | PR | 合并提交 | 主要交付 |
|---|---|---|---|
| M6-00 预研与文档基线 | #172 | `87f5b81` | `docs/plan/m6-spikes.md`、平台矩阵、Windows 假设审计、ADR-0039 |
| M6-01 平台抽象收口 | #173 | `0c32987` | `@cairn/core/platform.ts` 适配层，共享包不再散落平台判断 |
| M6-06 开源材料 | #174 | `2f954b7` | MIT、CONTRIBUTING、CODE_OF_CONDUCT、SECURITY、Issue/PR 模板、英文 README、敏感信息扫描记录 |
| M6-04 凭据跨平台策略 | #175 | `34566a9` | 不可用原因分类、Linux 显式拒绝、设置页说明、ADR-0040 |
| M6-05 沙箱语义 | #176 | `71dfd84` | `sandboxPlatformSupport()`、未沙箱化标注、ADR-0034 跨平台语义 |
| M6-08 桌面体验收尾 | #177 | `f064763` | 会话内 Agent 选择器、运行中禁用与快捷键 |
| M6-02 macOS 适配与打包 | #178 | `a38bc9d` | arm64/x64 DMG+ZIP、Developer ID/公证脚本、菜单与校验、ADR-0041 |
| M6-03 Linux 打包 | #179 | `d14e2ba` | AppImage+deb、桌面项、校验、ADR-0042 |
| M6-07 跨平台 CI 与发布 | #180 | `5bfe424` | 三平台 CI 矩阵、DCO job、三平台发布与汇总流水线、ADR-0043 |
| M6-10 验收与收尾 | 本 PR | — | 本报告、文档同步、远程分支清理 |

M6-09 没有代码交付：它是所有者侧的签名、法务与真机验收，状态见 §7。

## 3. 质量门槛与证据

### 3.1 CI（PR #180，run `43814362660`）

| 检查 | 结果 | 耗时 |
|---|---|---|
| check (windows-latest) | pass | 10m50s |
| check (ubuntu-latest) | pass | 4m51s |
| check (macos-latest) | pass | 6m0s |
| dco | pass | 13s |
| licenses | pass | 15s |
| 静态检查（Windows/Ubuntu） | pass | 46s / 19s |

每个 `check` job 都执行了：`check:version`、typecheck、lint、format、`test:coverage`、
`test:perf`、`check:i18n`、build、`smoke`、`package:dir`、`package:verify`、
`smoke:packaged`；Windows 另外执行 `fetch:mingit` 与 `e2e:packaged`，Windows/Linux 执行
Playwright e2e。macOS 的 Playwright e2e 不在 PR 上运行（runner 窗口限制），由打包冒烟
与手工矩阵承担，手工矩阵尚未执行（§6）。

### 3.2 覆盖率（Windows 本机，`pnpm test:coverage`）

| 指标 | 结果 | 门槛 |
|---|---|---|
| 语句 | 97.74% | ≥ 95% |
| 分支 | 95.02% | ≥ 95% |
| 函数 | 96.97% | ≥ 95% |
| 行 | 98.75% | ≥ 95% |

测试文件 272 passed / 3 skipped；用例 4096 passed / 21 skipped。三个平台的用例数略有差异
（平台相关用例按 `describe.skipIf` 跳过），CI 各自按所在平台重新统计。

### 3.3 打包产物

`package:dir` 在三平台各自产出可启动的解包应用，`smoke:packaged` 在临时数据目录中验证：
窗口与界面、preload 与 IPC、Agent 宿主完成一轮、SQLite、随包 ripgrep、内置技能；
Windows 另外验证随包 MinGit 与 koffi Job Object，macOS 另外验证真实 `safeStorage`。

## 4. 跨平台验收矩阵

| 门槛 | Windows | macOS | Linux |
|---|---|---|---|
| format / typecheck / lint / i18n / licenses | CI 通过 | CI 通过 | CI 通过 |
| 单测 + 四项覆盖率 ≥ 95% | CI 通过 | CI 通过 | CI 通过 |
| build / smoke（fake 与 pi） | CI 通过 | CI 通过 | CI 通过 |
| e2e（核心会话流程） | CI 通过 | 未执行（手工矩阵） | CI 通过 |
| 解包产物启动与冒烟 | CI 通过 | CI 通过 | CI 通过 |
| 安装包构建 | 发布 job 结构 + 单测 | 发布 job 结构 + 单测 | 发布 job 结构 + 单测 |
| 真实安装包安装/卸载 | M5 已验收（NSIS） | **未执行** | **未执行** |
| 更新检查/下载/校验 | 单测覆盖，真实标签未执行 | **未执行**（待签名产物） | 单测覆盖，真实标签未执行 |
| 命令沙箱 | 受限令牌/AppContainer | 明确降级并标注 | 明确降级并标注 |
| 检查点 | 本机 Git + MinGit | 本机 Git | 本机 Git |

“CI 通过”指上表的 PR #180 运行；“未执行”的项目不能用本地打包成功替代。

## 5. M6-07 中修复的跨平台问题

CI 在三个平台真实执行后暴露并修复了三类平台敏感问题，均已写入代码与 ADR：

1. **契约录制的时序不确定性**：`openai-abort` 在客户端收到第 2 个文本增量后中断，录制代理
   仍在读上游；直接读取录制会得到截断位置随事件循环变化的 SSE，macOS 与 Windows/Linux
   不一致。录制代理新增 `drained()`，等上游响应记录完成后才生成录制，录制内容与平台无关。
2. **平台敏感的单元测试**：`verify-package` 测试原先按宿主 `process.arch` 查找预编译，
   arm64 macOS runner 上失败；改为显式注入 `arch: 'x64'`。`pruneStagedDependencies` 的
   no-op 测试也注入 `linux/x64`。
3. **macOS 打包冒烟的钥匙串冲突**：`safeStorage` 的主密钥条目只信任创建它的二进制；
   未打包冒烟先用 Electron 在登录钥匙串创建了同名条目，打包应用（签名身份不同）读取时
   需要用户授权，无桌面 runner 上以 `errSecAuthFailed` 失败。CI 在冒烟前使用空的临时
   钥匙串作为搜索列表与默认钥匙串，让打包应用自己创建条目，仍校验真实的系统加密。

## 6. 未验证与已知限制

以下结论必须由真实账号、证书、真机或标签产生，本报告不将其记为已通过：

- **Windows stable 签名**：没有 Authenticode 证书，未执行 `signtool verify`；beta 的
  签名失败降级路径只由单元测试覆盖。
- **macOS 签名与公证**：没有 Apple Developer ID 证书与公证凭据，未执行 `codesign`、
  `spctl`、`notarytool` 与 `stapler validate`；Gatekeeper 放行未验证。
- **真实标签发布**：`release.yml` 的结构、合并与元数据校验由单元测试覆盖，但没有用真实
  标签执行一次完整发布，三平台产物的下载与 `latest*.yml` 读取未验证。
- **真机安装与更新演练**：macOS DMG、Linux AppImage/deb 的安装/卸载/重装、Windows
  `0.1.0 → 0.1.1` 更新升级均未执行；干净 VM 与标准用户矩阵未执行。
- **macOS e2e 手工矩阵**：PR 上不跑 Playwright，打包冒烟覆盖启动与一轮任务，但完整
  会话流程的手工矩阵尚未执行。
- **Linux 无用户命名空间时的启动**与 AppImage 内更新未在真机验证。
- **git 历史中的维护者本机路径**：仍需所有者确认后重写历史（m6-06-report.md §2.5）。

## 7. M6-09 延期项与重新开启条件

M6-09 不是代码任务，依赖所有者侧资源。当前状态为“明确延期”，不阻塞 M6-10 的文档收尾，
但 stable 发布前必须关闭：

| 项目 | 需要的输入 | 关闭标准 |
|---|---|---|
| Windows 代码签名 | OV/EV 云签名账号或 PFX 证书 | 发布产物 `signtool verify` 通过，stable 构建不允许 unsigned |
| 法务确认 | EULA 与隐私文本的最终确认 | 发布说明与安装文档引用确认后的文本 |
| 干净 VM 与标准用户矩阵 | Windows/macOS/Linux 干净系统与标准用户 | 安装 → 使用 → 更新 → 卸载 → 重装全部通过并留记录 |
| 真实更新演练 | 已签名的 `0.1.0` 与 `0.1.1` 构建 | 自动更新检查、下载、校验与重启恢复通过 |

以上任一项未完成时不得签发 stable；beta 通道继续允许 unsigned，并在发布说明中标注。

## 8. 分支清理记录

按 M6-10 范围核对了已合并或被后续 PR 取代的远程分支。删除命令被执行环境的权限策略
（`Git Destructive`）拦截，因此本报告只记录核对结果与待执行的命令，实际删除由所有者执行。

| 分支 | 对应 PR | 依据 |
|---|---|---|
| `codex/ui-followups-20261109` | #131（已合并） | 内容已进入 `main`，无独有提交 |
| `codex/ui-p0-p1-fixes` | #150（已合并） | 实现已被后续 PR 取代 |
| `codex/composer-slash-commands` | #149（已合并） | 输入框 `/` 指令已由 #149 及其后续落地 |

```bash
git push origin --delete \
  codex/ui-followups-20261109 \
  codex/ui-p0-p1-fixes \
  codex/composer-slash-commands
```

其余早期 `codex/*`、`cursor/*`、`claude/*` 分支不在本次清理范围：它们可能保留阶段性资料，
由所有者按需处理。

## 9. 复现命令

```bash
pnpm install --frozen-lockfile
pnpm check:version && pnpm typecheck && pnpm lint && pnpm format:check
pnpm test:coverage          # 四项覆盖率 ≥ 95%
CAIRN_PERF=1 pnpm test:perf
pnpm check:i18n && pnpm check:licenses && pnpm check:dco -- --base origin/main
pnpm build && pnpm smoke
pnpm package:dir && pnpm package:verify && pnpm smoke:packaged
```

macOS 上执行 `smoke:packaged` 前，若同一作业里已运行过未打包的 `pnpm smoke`，需要按
`.github/workflows/ci.yml` 的做法使用独立钥匙串，否则 `safeStorage` 的钥匙串条目会被
前一个二进制占用。

## 10. M6 完成检查清单

- [x] 共享代码里的平台判断都有具名适配层，新增平台不改调用方（M6-01）。
- [x] 非 Windows 平台的命令沙箱语义写进 ADR 与界面提示，没有“假隔离”（M6-05）。
- [x] 三个平台的 CI 通过并可重复执行（PR #180 三平台全绿）；发布流水线结构由单测覆盖，
      真实标签发布未执行（§6）。
- [x] 许可证、贡献指南、行为准则、安全策略、Issue/PR 模板齐全，仓库可公开（M6-06）。
- [x] 仓库公开前完成敏感信息清理并记录（M6-06；历史改写待所有者确认）。
- [x] 会话内 Agent 选择器接回输入框，入口与快捷键一致（M6-08）。
- [x] Windows stable 阻塞项明确延期（M6-09，§7）。
- [x] 四项覆盖率 ≥ 95%；format、typecheck、lint、i18n、licenses、build、e2e、smoke 全部通过。
- [x] 架构、ADR、README、CHANGELOG 与本文实施记录同步；已合并/被取代的远程分支按 §8 清理。
- [ ] macOS 安装、启动、跑通任务；签名与公证通过（或明确标注 unsigned，不进 stable）——
      运行器冒烟已通过，真实 DMG 安装与签名/公证未执行（§6）。
- [ ] Linux 安装、启动、跑通任务；无密钥环时凭据行为明确且有文档——运行器冒烟与凭据文档
      已完成，真实 AppImage/deb 安装未执行（§6）。

后两项保持未勾选，直到真机/账号验收补齐；这不妨碍 M6 的跨平台实现与开源目标收尾，
但会继续阻止 stable 发布。