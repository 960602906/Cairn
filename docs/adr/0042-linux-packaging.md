# ADR-0042 Linux 打包与桌面集成

- 状态：已接受（M6-03 实施）
- 日期：2026-11-16
- 相关决策：ADR-0008、ADR-0014、ADR-0035、ADR-0036、ADR-0040、ADR-0041
- 预研证据：[M6-00 预研](../plan/m6-spikes.md) §2、§3

## 背景

M6 之前只有 Windows 安装包。Linux 首次正式支持需要同时解决分发、桌面集成与安全边界：

- 目标平台以 Ubuntu LTS 为基线，发布 x64；其他发行版 best-effort，不支持 arm64/32 位。
- 分发形式要兼顾两种使用方式：免安装运行与系统级安装/卸载。AppImage 适合前者并支持
  `electron-updater`；deb 适合后者，由 `apt`/`dpkg` 管理依赖与卸载。
- Linux 没有与 Windows Authenticode 对等的统一签名体系；AppImage 与 deb 的完整性先由
  SHA-256 校验和与 HTTPS 更新源保证，仓库签名留给后续分发渠道。
- Chromium 在部分 Ubuntu 版本上无法使用用户命名空间，AppImage 可能只能以
  `--no-sandbox` 启动；这与 Cairn 的命令沙箱是两个独立概念。M6-05 已明确 Linux 尚未实现
  命令沙箱，命令按权限规则在沙箱外运行并标注“未沙箱化”。
- 凭据存储依赖系统密钥环；无密钥环时 M6-04 的决策是显式拒绝保存并由界面说明原因。
- 桌面集成需要 `.desktop` 入口、图标、`StartupWMClass`，以及用系统默认程序打开链接
  （`xdg-open`）。

## 决定

- **electron-builder 产出 AppImage 与 deb，只构建 x64。** 二进制名固定为 `cairn`，应用
  分类为 `Development`，图标使用现有 1024×1024 PNG。产物命名为
  `Cairn-<version>-x64.AppImage` 与 `Cairn-<version>-x64.deb`，并分别生成 `.sha256`。
- **Linux 打包只在 Linux 上执行。** `package:linux` 在非 Linux 平台直接失败并提示 ADR-0042；
  与 NSIS（Windows）和 DMG（macOS）对称。staging、运行时依赖探测与校验与其它平台共用。
- **不随包附带 Git。** Linux 用户通常已有 Git；缺少时检查点降级，写文件类改动仍可撤销
  （ADR-0008）。MinGit 仍只在 Windows 分发。
- **deb 显式声明默认运行库依赖。** 使用 electron-builder 的 `default` 集合（含
  `libsecret-1-0`、`libnss3`、`libxss1` 等），避免默认值变化时静默丢依赖。维护者使用项目
  公开联系地址，主页指向公开仓库；证书与仓库签名不在本轮范围。
- **不默认关闭 Chromium 沙箱。** 只有在系统缺少用户命名空间、AppImage 无法启动时，才由
  用户显式以 `--no-sandbox` 运行，并在故障排查文档中说明风险；这不改变 Cairn 命令执行
  的权限模型，也不会被描述为“已沙箱化”。命令沙箱的平台实现仍是 ADR-0034 的后续工作。
- **更新边界。** AppImage 通过 `electron-updater` 的 generic 源更新，需要
  `latest-linux.yml`；deb 不自动更新，由系统包管理器升级。发布流水线与元数据属于 M6-07；
  本轮只保证产物、校验和与校验脚本。
- **桌面集成交给 electron-builder。** 生成的标准 `.desktop` 文件包含名称、分类、图标与
  `StartupWMClass`；链接与外部文件继续使用 Electron `shell.openExternal`（Linux 上由
  `xdg-open` 处理），不新增平台专属命令。
- **产物校验按平台分支。** `verify-package -- --linux` 检查 `linux-unpacked/cairn`、
  `resources` 内的 asar/skills/app-update.yml、`out/bin/rg`、`linux-<arch>.node`，以及
  AppImage/deb 与 `.sha256`；darwin/Windows 的规则不变。

## 备选方案

- **只发 AppImage**：免安装、可自动更新，但没有系统菜单/卸载与依赖声明，否决。
- **只发 deb**：系统集成好，但无法免安装运行，也没有 AppImage 的更新通道，否决。
- **Flatpak / Snap**：需要额外的运行时、商店与权限模型，超出 M6 范围，后续评估。
- **自建 apt 仓库与包签名**：维护成本高，先由 HTTPS + SHA-256 + 发布门禁保证完整性，后续再引入。
- **默认追加 `--no-sandbox`**：会让所有用户失去 Chromium 沙箱，且容易被误解为命令沙箱，
  否决；只作为无用户命名空间环境的显式排障选项。
- **随包附带 Git**：与 macOS 一致使用系统 Git，避免再分发一份 GPL 产物与持续更新负担。

## 实施结果（M6-03，2026-11-16）

- 配置：`apps/desktop/electron-builder.yml` 新增 `linux`（AppImage + deb、x64、`cairn`、
  `Development`、产物命名）与 `deb.depends: [default]`；`apps/desktop/package.json` 补充
  `homepage`、`repository` 与 `package:linux`，staging 会把这些元数据写入打包清单。
- 命令：`pnpm package:linux`（`packaging.mjs --linux`）与 `pnpm package:verify -- --linux`；
  两个安装包都会生成 `.sha256`。
- 校验：`verify-package` 在 Linux 下检查 unpacked 应用、平台原生模块、ripgrep、skills 与
  两个安装包；`after-pack` 继续把 `app-update.yml` 写入 `<app>/resources`。
- 文档：本 ADR、`docs/dev/install.md` §9（AppImage/deb 安装、校验、升级与卸载）、
  `docs/dev/release.md` §11（构建、更新边界、`--no-sandbox` 排障）。
- 测试：`packaging.test.ts`、`verify-package.test.ts` 用注入的平台标识覆盖 Linux 参数、
  平台守卫、产物缺失与校验和不匹配。
- **未验证（本机为 Windows）**：真实 AppImage/deb 构建、Ubuntu LTS 安装/启动/卸载/重装、
  `xdg-open`、无用户命名空间时的 `--no-sandbox` 启动、AppImage 更新下载与 `latest-linux.yml`
  生成。它们需要在 Linux runner 或真机上执行；发布流水线属于 M6-07。

## 后果

- Linux 发布清单包含两个安装包与两个校验和；AppImage 与 deb 的升级路径不同，文档必须分别说明。
- 不再假设“所有安装包都由 electron-builder 的签名环节保护”；Linux 先以校验和与 HTTPS
  更新源为准，仓库签名与发行版打包留待后续。
- AppImage 的 Chromium 沙箱限制与 Cairn 命令沙箱无关；界面与文档继续明确“未沙箱化”，
  不能因为加了 `--no-sandbox` 就宣称隔离。
- Linux 打包无法在 Windows/macOS CI 上回归，需要 Ubuntu runner；在此之前由单元测试保证
  参数、路径与校验逻辑，真机结论保持“未验证”。
