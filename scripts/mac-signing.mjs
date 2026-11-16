// @ts-check
/**
 * macOS 签名与公证校验的命令行入口；实现位于 `@cairn/release-tools`，与打包、发布脚本共用。
 *
 * 用法：node scripts/mac-signing.mjs --dist apps/desktop/dist --version <version>
 * 只在 macOS 上运行；未配置 Developer ID 与公证凭据时以“拒绝校验未签名构建”失败。
 */
import { pathToFileURL } from 'node:url'
import { macSigningMain } from '@cairn/release-tools'

export { macSigningMain }

/* v8 ignore start -- CLI bootstrap is executed by the release workflow, not by unit tests. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = macSigningMain()
  } catch (failure) {
    console.error(`sign: ${failure instanceof Error ? failure.message : String(failure)}`)
    process.exitCode = 1
  }
}
/* v8 ignore stop */
