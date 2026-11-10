// @ts-check
/**
 * `sign:verify` 的命令行入口；实现位于 `@cairn/release-tools`，与打包、发布脚本共用。
 *
 * 用法：node scripts/windows-signing.mjs --dist apps/desktop/dist --version <version>
 *       [--installed <dir>]
 */
import { pathToFileURL } from 'node:url'
import { main } from '@cairn/release-tools'

export { main }

/* v8 ignore start -- CLI bootstrap is executed by the release workflow, not by unit tests. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main()
  } catch (failure) {
    console.error(`sign: ${failure instanceof Error ? failure.message : String(failure)}`)
    process.exitCode = 1
  }
}
/* v8 ignore stop */
