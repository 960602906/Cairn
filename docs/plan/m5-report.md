# M5 发布验收报告（0.1.0 beta / unsigned）

> 状态：**unsigned beta 可分发，stable 仍被阻塞**。本文记录 M5-00～M5-10 的验收证据、未执行事项与
> 阻塞条件。未执行的矩阵不得用“本地打包成功”替代，也不得据此宣称正式支持。
>
> 相关文档：[M5 计划](m5.md)、[发布前置条件](m5-release-prerequisites.md)、
> [安装说明](../dev/install.md)、[故障排查](../dev/troubleshooting.md)、
> [发布流程](../dev/release.md)。

## 1. 结论摘要

- **可以分发给他人安装（beta）**：按用户 NSIS、无需管理员；安装/启动/卸载/重装与数据保留在
  本机自动化验收中通过；安装包未签名，可能触发 SmartScreen。
- **不可以签发 stable**：签名证书、法务确认、干净 VM/标准用户矩阵、真实 0.1.0→0.1.1 安装升级
  尚未完成（见 §7 与 [前置条件](m5-release-prerequisites.md)）。
- 产品代码在 M5-10 没有变化；本文的构建产物与哈希来自 M5-09 合并后的 `main`。

## 2. 构建信息

| 项目 | 值 |
|---|---|
| 版本 / 通道 | `0.1.0` / `beta` |
| 提交 | `2c8e21acf5b9520ec6fcaeb37ea3c74acd981de7` |
| 构建时间（UTC） | `2026-11-10T01:42:59.718Z` |
| Electron | `45.2.1` |
| Node（构建机） | `26.13.0` |
| electron-builder | `26.18.0` |
| 目标 | Windows x64，按用户 NSIS（`perMachine=false`） |
| 签名 | **未签名**（`CSC_IDENTITY_AUTO_DISCOVERY=false`），无发布者证书 |
| 更新发布者校验 | 未配置 `CAIRN_UPDATE_PUBLISHER`；更新包 `signatureVerified: false` |

## 3. 产物与校验和

在 `apps/desktop/dist` 生成，SHA-256 由本机验收构建计算；发布流水线会在标签构建时重新生成并公开校验。

| 产物 | 字节 | SHA-256 |
|---|---|---|
| `Cairn-0.1.0-x64-setup.exe` | 134,623,491 | `05127245e54415e1384d7a2c9efa906b4289baaf5e2a5a94359de1a6d9fd1334` |
| `Cairn-0.1.0-x64-setup.exe.blockmap` | 141,146 | `97e3c016ccfd1423bcb8fb091edbfda519597219b595ca811ef88e91af8599b0` |
| `win-unpacked/Cairn.exe` | 249,788,928 | `0b64c58396c8cc09dffbd862fb37cf4acb411901662baa4b390a9100af37581a` |
| `win-unpacked/resources/app.asar` | 19,618,993 | `82e48af130ff3444917b1784130f1f23ad4dafa50ee23bb1385727dda5322925` |

安装包包含随包 MinGit `2.56.0.windows.4`（`resources/git`）、内置 skills、`rg.exe` 与
`THIRD_PARTY_NOTICES.txt`，以及 `electron-updater` 下载所需的 `resources/app-update.yml`
（generic provider + HTTPS 源）；未包含 source map、测试、e2e、spikes 或工作区源码
（M5-02 打包校验，M5-10 增加 `app-update.yml` 校验）。

## 4. 自动化证据（本机，2026-11-10）

| 门槛 | 结果 |
|---|---|
| `pnpm format:check` / `typecheck` / `lint` / `check:i18n` / `check:licenses` / `check:version` | 全部通过 |
| `pnpm test:coverage` | 3,552 passed / 21 skipped；语句 97.76%、分支 95.10%、函数 96.97%、行 98.69% |
| `pnpm test:perf`（CI，`CAIRN_PERF=1`） | 通过（M5-08 起纳入 CI） |
| `pnpm build` / `pnpm smoke` | 通过（fake 与 pi 两种运行时） |
| `pnpm e2e` | 55 passed（dev 构建产物） |
| `pnpm package:dir` / `package:verify` / `smoke:packaged` | 通过 |
| `pnpm e2e:packaged` | 2 passed（安装形态冒烟 + 发布验收全流程） |
| `pnpm package:nsis` / `smoke:installed` | 通过 |
| `pnpm acceptance:installed` | 通过（中文长路径 + 仅系统 PATH + 卸载/重装/设置保留） |
| CI（PR #143，Windows + Ubuntu + licenses） | 通过；Windows 一次 `provider.spec.ts` 模型切换用例偶发失败，原样重跑通过（见 §8） |

### 4.1 发布验收全流程（`apps/desktop/e2e/acceptance.spec.ts`）

在 `dist/win-unpacked/Cairn.exe` 上，用 CDP 驱动真实打包程序，进程 `PATH` 只保留系统目录
（`where.exe git` 必须失败），数据目录与项目路径含中文、空格与较长层级：

1. 干净安装 → 欢迎页 → “稍后” → `settings.json` 写入 `onboardingSeen: true`；
2. `app.info` 返回打包版本、`com.cairn.desktop`、`packaged: true`、`beta` 与提交 SHA；
3. 写入凭据与模型供应商 → 重载界面 → 创建中文长路径项目/会话；
4. 模型调用 `run_command` → 审批卡片显示实际沙箱档位 → 执行后文件内容正确；
5. 无 Git 的 `PATH` 下仍建立检查点；撤销本轮删除新建文件；影子仓库位于数据目录 `checkpoints/*.git`；
6. 本地 HTTPS 静态源：`update.check` → `available 0.1.1`，`update.download` → `downloaded` 且
   `signatureVerified: false`（unsigned beta）；
7. `app.licenses` 可读且包含第三方声明；诊断包 zip 含 `manifest.json`/`app-version.json`，
   不含 API Key 与用户数据目录路径；
8. 关闭并重启：欢迎页不再出现，会话与消息完整恢复。

### 4.2 安装生命周期（`pnpm acceptance:installed`）

真实 NSIS 安装到含中文与空格的较长目录，用户数据目录同样含中文：

1. 安装 → 布局/快捷方式/卸载项检查 → 随包 Git 与 ripgrep 可执行 → 应用冒烟；
2. 写入设置标记 → 静默卸载：程序、快捷方式、卸载项消失，数据目录与设置保留；
3. 重装到同一目录 → 再次冒烟 → 设置仍可读回 → 再次卸载。

### 4.3 验收中发现并修复的问题

1. **打包产物缺少 `app-update.yml`。** `--publish never` 不生成该文件，安装版在
   `update.download` 时以 `ENOENT ... app-update.yml` 失败（此前 dist 中的文件来自更早的构建，
   掩盖了问题）。修复：`scripts/after-pack.cjs` 在打包后按 `CAIRN_UPDATE_URL`（缺省用
   `electron-builder.yml` 的占位源）写入文件；`verify-package.mjs` 增加存在性与 generic/HTTPS
   校验；`packaging.mjs` 通过 `--config.afterPack` 挂接，单测覆盖。重新执行
   `package:dir`/`e2e:packaged`/`package:nsis`/`smoke:installed`/`acceptance:installed` 全部通过。
2. **中文安装路径的卸载项校验误判。** `reg.exe` 输出使用系统 ANSI 代码页（中文为 GBK），
   按 UTF-8 解码后匹配不到中文路径。修复：按“严格 UTF-8 → GBK”解码，单测覆盖 GBK 字节。

## 5. 人工验收矩阵状态

| 场景 | 状态 | 证据 / 说明 |
|---|---|---|
| Windows 11 当前版本（本机 24H2 内核 26100）安装/运行/卸载/重装 | ✅ 本机自动化 | `acceptance:installed`、`e2e:packaged` |
| Windows 10 22H2 | ⛔ 未执行 | 无可用测试机/VM（前置条件 #9） |
| 干净 VM（无开发工具、无旧版 Cairn） | ⛔ 未执行 | 前置条件 #8 未提供；需要 QA 机器 |
| 标准用户账户（非管理员） | ⛔ 未执行 | 当前仅为“未提权的过滤管理员令牌”；真正标准用户待 #8 |
| 中文用户名 | ⛔ 未执行 | 中文安装/数据/项目路径已自动覆盖 |
| 中文安装路径与长路径 | ✅ 自动化 | `acceptance:installed`（安装、数据、项目） |
| 无 Git / 旧版 Git | ✅ 无 Git 自动化；⛔ 旧版 Git 未执行 | 无 Git 时检查点走随包 MinGit |
| 有代理 / 断网 | ⛔ 未执行 | 更新失败模式由单测覆盖，未做真实网络演练 |
| 低磁盘 | ⛔ 未执行 | 同上 |
| 高 DPI / 多显示器 | ⛔ 未执行 | 视觉 e2e 只覆盖窗口尺寸与主题 |
| Windows Defender / SmartScreen | ⛔ 未执行 | unsigned 安装包预期触发 SmartScreen |
| 安装 → 使用 → 卸载 → 重装恢复数据 | ✅ 自动化 | §4.2 |
| 真实 0.1.0 → 0.1.1 安装升级 | ⛔ 未执行 | 更新 e2e 使用假安装包；真实升级需已签名产物与更新源 |

## 6. 已知限制与非目标

- **unsigned beta**：没有代码签名证书；安装包、主程序与卸载程序均未签名，SmartScreen 行为未验证。
- **法律文本**：`LICENSE` 与 `PRIVACY.md` 是工程草案，stable 前需项目负责人与法务确认（#12）。
- **沙箱边界**：默认 `restricted-workspace` 不隔离网络；AppContainer 不是默认档位。界面与诊断
  均标注“网络未隔离”，不得描述为恶意代码安全边界（ADR-0034）。
- **检查点 Git**：随包 MinGit 只在没有可用本机 Git 时兜底；安装版优先使用本机 Git。
- **更新**：公开只读静态源与降级阻断已实现；真实签名包、真实安装重启与代理/断网演练未做。
- **平台**：仅 Windows x64；macOS/Linux 属于 M6。
- **CI 上的打包沙箱（未解决）**：在 GitHub Actions `windows-latest` 上，已打包应用的沙箱派生子进程
  一律以 `3221225794`（`0xC0000142`，DLL 初始化失败）退出，`PowerShell 7.6.9`、Windows PowerShell 5.1
  与 `cmd.exe` 表现相同；本机与开发态 `e2e` 的正常沙箱执行不受影响。因此
  `packaged-sandbox.spec.ts` 与 `acceptance.spec.ts` 的 Windows CI 作业当前失败，发布验收的自动化
  证据以本机结果为准（§3），该问题留待后续单独排查。

## 7. 发布阻塞项（stable）

| # | 阻塞项 | 负责角色 | 依据 |
|---|---|---|---|
| 1 | 代码签名证书与 RFC 3161 时间戳，`signtool verify` 通过 | 发布负责人 | 前置条件 #1～#5、#14；M5-08 |
| 2 | 公开只读更新源与回滚演练（10 分钟内撤包） | 发布负责人 | 前置条件 #6～#7 |
| 3 | 干净 Windows 11 24H2 标准用户 VM 全流程 | QA | 前置条件 #8；本文 §5 |
| 4 | Windows 10 22H2 best-effort 矩阵 | QA | 前置条件 #9 |
| 5 | 中文用户名/长路径的人工确认（自动化已覆盖路径本身） | QA | 前置条件 #10 |
| 6 | EULA 与隐私说明法务确认 | 产品 + 法务 | 前置条件 #12 |
| 7 | 真实 0.1.0 → 0.1.1 安装升级与重装恢复 | 发布负责人 | 本文 §5 |

## 8. 偶发问题记录

- 2026-11-10 PR #143 Windows CI：`provider.spec.ts`“在输入框中切换模型”偶发只发送了第一轮，
  重跑同一作业通过；未在 M5-10 修改该用例，记录为已知偶发，后续若复现再单独排查。
  其余测试未出现重复失败。

## 9. 复现命令

```powershell
pnpm install --frozen-lockfile
pnpm format:check; pnpm typecheck; pnpm lint; pnpm check:i18n; pnpm check:licenses; pnpm check:version
pnpm test:coverage
pnpm build; pnpm smoke; pnpm e2e

$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://npmmirror.com/mirrors/electron-builder-binaries/'
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
pnpm package:dir; pnpm package:verify; pnpm smoke:packaged; pnpm e2e:packaged
pnpm package:nsis; pnpm smoke:installed; pnpm acceptance:installed
```
