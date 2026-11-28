# ADR-0049 macOS 默认 ad-hoc 签名

- 状态：已接受（实施）
- 日期：2026-11-27
- 相关决策：ADR-0041、ADR-0043
- 相关文档：[发布运行手册 §10](../dev/release.md)

## 背景

ADR-0041 把 `CAIRN_MAC_SIGN_MODE=none` 定义为“unsigned 内部包”，实现上等价于
`mac.identity: null`。实际发布的 0.1.6 DMG 暴露了这条路线的缺陷：

- `identity: null` 只让 electron-builder 跳过签名，`.app` 里仍然是 Electron 官方二进制
  自带的 linker 签名；打包过程写入或修改的 `Contents/Resources`、`Info.plist` 与 helper
  没有被这个签名覆盖。
- 因此 `codesign --verify --deep --strict` 报
  `code has no resources but signature indicates they must be present`。这不是“未签名”，
  而是**签名损坏**。
- Gatekeeper 对损坏签名的应用直接提示“已损坏，无法打开”，用户无法像对待未识别开发者
  那样通过“系统设置 → 隐私与安全性 → 仍要打开”放行；Apple Silicon 上还要求可执行文件
  具有有效签名。
- 发布流水线只在 `developer-id` 模式运行 `sign:verify:mac`，`none` 模式完全跳过了
  `codesign --verify`，所以损坏的包一路通过了构建、打包冒烟与发布门禁。

没有 Apple Developer Program 账号时仍然需要可分发、可启动的 macOS beta。ad-hoc 签名
（`codesign --sign -`）不提供发布者身份、不能公证，但能产生覆盖完整 bundle 的有效签名，
是 Apple 允许的本地/测试签名方式。

## 决定

- **macOS 产物至少做 ad-hoc 签名。** `CAIRN_MAC_SIGN_MODE` 的取值为 `adhoc`（默认）与
  `developer-id`；不再接受 `none`。`adhoc` 通过 `--config.mac.identity=-` 让
  electron-builder 使用 `@electron/osx-sign` 重新签名主程序、helper、嵌套 framework 与
  原生模块，并封存 Resources。
- **ad-hoc 模式关闭 DMG 自身签名。** DMG 不参与 Gatekeeper 校验，且 electron-builder 的
  DMG 签名按身份名称做子串匹配；构建机装有真实证书时可能误用。应用映射内部 `.app` 的
  签名才是准入依据。
- **两种模式都校验 bundle 签名。** 发布流水线在打包成功后始终运行 `sign:verify:mac`：
  `adhoc` 只要求 `codesign --verify --deep --strict` 通过；`developer-id` 额外要求
  `spctl --assess` 与公证 stapling。`spctl` 必然拒绝没有 Developer ID 的构建，不能作为
  ad-hoc 的失败条件。
- **beta 的降级目标是 ad-hoc，而不是 unsigned。** Developer ID 签名/公证失败时，beta 用
  `adhoc` 重试一次；ad-hoc 自身失败不再降级，宁可阻止发布也不产出损坏的包。
- **发布说明如实描述。** `adhoc` 标注为“ad-hoc 签名（未公证）”，并说明首次启动需用户
  显式放行；不得声称“已验证发布者”或“无警告”。stable 仍强制 `developer-id`。
- **修正 ADR-0041 的表述。** ADR-0041 中“`none` 产出 unsigned 内部包”不再成立；它没有
  被整体替代，只有这一条签名模式约定由本 ADR 修正。

## 备选方案

- **保持 `identity: null`，只修文档和安装说明**：签名本身无效，Gatekeeper 不会给出
  “仍要打开”，用户无法绕过。否决。
- **让用户手动 `codesign --force --deep --sign -`**：可行但每个用户都要装 Xcode 命令行
  工具并执行终端命令，且下个版本又会回到损坏状态。否决。
- **自签名根证书**：用户仍需手动安装并信任根证书，体验比 ad-hoc 更差，且容易被误认为
  真实发布者身份。否决。
- **只发 ZIP、让用户从终端运行**：Gatekeeper 与自动更新都不会因此变好，还失去 DMG 的
  常规安装路径。否决。
- **ad-hoc 同时公证**：Apple 只对 Developer ID 签名产物出具公证票据，ad-hoc 无法公证。
  否决。

## 取舍与后果

- 免费方案仍有 Gatekeeper 提示：应用可启动，但首次打开需要在“系统设置 → 隐私与安全性”
  中放行；每次覆盖安装后可能需要再次放行。消除提示仍需要 Apple Developer Program
  （约 ¥688/年）的 Developer ID 证书与公证。
- macOS 原地自动更新依赖有效的发布者签名；ad-hoc beta 只做版本检查：发现新版本后在左栏
  给出 GitHub Releases 下载页入口，由用户手动安装（ADR-0036 修订）。stable 必须 `developer-id`。
- `CAIRN_MAC_SIGN_MODE=none` 从配置中移除；设置该值的流水线或本地脚本会立即失败，而不是
  静默产出损坏的包。
- 发布门禁增加 `codesign --verify` 覆盖：过去只验证 `developer-id`，现在 ad-hoc 包也会
  在发布前验证签名完整性。