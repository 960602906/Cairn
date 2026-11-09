// @ts-check
/**
 * 版本单一来源（M5-01）：根 `package.json` 是唯一可编辑的版本号，桌面包与它保持一致。
 *
 * 用法：
 * - `node scripts/sync-version.mjs`：把根版本写入 `apps/desktop/package.json`；
 * - `node scripts/sync-version.mjs --check`：不一致时退出码 1（CI 门禁用）。
 *
 * 只改版本，不重排其他字段；写入保持两空格缩进与末尾换行。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')

/** 允许的版本格式（SemVer，含预发布与构建元数据）。 */
export const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * 读取并解析 `package.json`。
 * @param {string} file
 * @returns {Record<string, unknown>}
 */
export function readPackageJson(file) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(
      `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} is not a JSON object`)
  }
  return /** @type {Record<string, unknown>} */ (parsed)
}

/**
 * 读取一个包的版本；缺失或格式不合法时抛出。
 * @param {string} file
 * @returns {string}
 */
export function readVersion(file) {
  const version = readPackageJson(file).version
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    throw new Error(`${file} has no valid version`)
  }
  return version
}

/**
 * 比较根包与桌面包的版本。
 * @param {string} rootFile
 * @param {string} appFile
 * @returns {{ rootVersion: string; appVersion: string; ok: boolean }}
 */
export function checkVersions(rootFile, appFile) {
  const rootVersion = readVersion(rootFile)
  const appVersion = readVersion(appFile)
  return { rootVersion, appVersion, ok: rootVersion === appVersion }
}

/**
 * 把根版本同步到桌面包；返回是否写入。
 * @param {string} rootFile
 * @param {string} appFile
 * @returns {{ version: string; changed: boolean }}
 */
export function syncVersions(rootFile, appFile) {
  const rootVersion = readVersion(rootFile)
  const appPackage = readPackageJson(appFile)
  if (appPackage.version === rootVersion) return { version: rootVersion, changed: false }
  writeFileSync(appFile, `${JSON.stringify({ ...appPackage, version: rootVersion }, null, 2)}\n`)
  return { version: rootVersion, changed: true }
}

/**
 * 命令行入口。
 * @param {{
 *   argv?: readonly string[];
 *   cwd?: string;
 *   log?: (line: string) => void;
 *   error?: (line: string) => void;
 * }} [options]
 * @returns {number}
 */
export function main({
  argv = process.argv.slice(2),
  cwd = REPO_ROOT,
  log = (line) => console.log(line),
  error = (line) => console.error(line),
} = {}) {
  const rootFile = path.join(cwd, 'package.json')
  const appFile = path.join(cwd, 'apps/desktop/package.json')
  const check = argv.includes('--check')

  if (check) {
    const result = checkVersions(rootFile, appFile)
    if (!result.ok) {
      error(
        `version mismatch: root package.json is ${result.rootVersion}, ` +
          `apps/desktop/package.json is ${result.appVersion}. Run \`pnpm sync:version\`.`,
      )
      return 1
    }
    log(`versions are in sync: ${result.rootVersion}`)
    return 0
  }

  const result = syncVersions(rootFile, appFile)
  log(
    result.changed
      ? `synced apps/desktop/package.json to ${result.version}`
      : `apps/desktop/package.json already at ${result.version}`,
  )
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
