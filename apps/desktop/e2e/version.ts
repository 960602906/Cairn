/**
 * e2e 断言使用的版本号：直接读取 `apps/desktop/package.json`，与 `app.info`、
 * `update.status` 返回的版本同源。发版只需改根 `package.json` 并运行 `pnpm sync:version`，
 * e2e 不再跟着手改版本字符串。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

const packageJson = JSON.parse(
  readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'),
) as { version: string }

/** 当前应用版本。 */
export const APP_VERSION = packageJson.version

/** 比当前版本高一个补丁版本；本地更新源用它模拟“有新版本”。 */
export function nextPatchVersion(version = APP_VERSION): string {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (match === null) throw new Error(`unexpected version: ${version}`)
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`
}
