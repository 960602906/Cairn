// @ts-check
/**
 * 已打包应用的启动参数与冒烟结果解析（M5-02）。不依赖应用源码，便于单元测试。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { findUnpackedApp } from './verify-package.mjs'

export const DEFAULT_OUTPUT_DIR = path.resolve(import.meta.dirname, '../dist')
export const SMOKE_RESULT_PREFIX = 'CAIRN_SMOKE_RESULT '
export const PACKAGED_SMOKE_TIMEOUT_MS = 120_000

/**
 * 已打包应用的命令行参数；Linux 无显示器时需要 Chromium 的无头参数。
 * @param {NodeJS.Platform} [platform]
 * @returns {string[]}
 */
export function packagedArguments(platform = process.platform) {
  return platform === 'linux' ? ['--ozone-platform=headless', '--disable-gpu', '--no-sandbox'] : []
}

/**
 * @param {{
 *   userData: string;
 *   base?: NodeJS.ProcessEnv;
 *   extra?: Readonly<Record<string, string>>;
 * }} options
 * @returns {NodeJS.ProcessEnv}
 */
export function applicationEnvironment({ userData, base = process.env, extra = {} }) {
  /** @type {NodeJS.ProcessEnv} */
  const environment = {
    ...base,
    ...extra,
    CAIRN_USER_DATA_DIR: userData,
  }
  delete environment['CAIRN_SMOKE']
  delete environment['ELECTRON_RUN_AS_NODE']
  return environment
}

/**
 * @param {{
 *   userData: string;
 *   base?: NodeJS.ProcessEnv;
 *   extra?: Readonly<Record<string, string>>;
 * }} options
 * @returns {NodeJS.ProcessEnv}
 */
export function smokeEnvironment(options) {
  return {
    ...applicationEnvironment(options),
    CAIRN_SMOKE: '1',
    CAIRN_RUNTIME: 'fake',
  }
}

/**
 * @param {string} output
 * @returns {Record<string, unknown> | undefined}
 */
export function parseSmokeResult(output) {
  const line = output.split(/\r?\n/).find((entry) => entry.startsWith(SMOKE_RESULT_PREFIX))
  if (line === undefined) return undefined
  try {
    const parsed = JSON.parse(line.slice(SMOKE_RESULT_PREFIX.length))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? /** @type {Record<string, unknown>} */ (parsed)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * @param {{
 *   output: string;
 *   exitCode: number | null;
 *   signal: NodeJS.Signals | null;
 *   userData: string;
 *   exists?: (file: string) => boolean;
 *   platform?: NodeJS.Platform;
 * }} options
 * @returns {string[]}
 */
export function checkPackagedResult({
  output,
  exitCode,
  signal,
  userData,
  exists = existsSync,
  platform = process.platform,
}) {
  const problems = []
  const result = parseSmokeResult(output)
  if (result === undefined) problems.push('no valid smoke result was printed')
  else {
    if (result['ok'] !== true) problems.push(`smoke checks failed: ${String(result['error'])}`)
    if (result['turnCompleted'] !== true) problems.push('agent host did not complete a turn')
    if (result['search'] === null || result['search'] === undefined) {
      problems.push('bundled ripgrep was not exercised')
    }
    if (!Array.isArray(result['skills']) || !result['skills'].includes('example')) {
      problems.push('built-in skill example was not loaded')
    }
    if (platform === 'win32' && result['native'] !== 'job-object') {
      problems.push(`koffi Job Object was not loaded: ${String(result['native'])}`)
    }
  }
  if (exitCode !== 0) problems.push(`application exited with ${String(exitCode)} (${signal})`)
  for (const relative of ['data/cairn.db', 'data/blobs', 'checkpoints', 'logs']) {
    if (!exists(path.join(userData, relative))) problems.push(`missing ${relative}`)
  }
  return problems
}

/**
 * 创建临时数据目录，保证已打包应用不接触真实 `%APPDATA%\Cairn`。
 * @returns {{ path: string; cleanup: () => void }}
 */
export function temporaryUserData() {
  const directory = mkdtempSync(path.join(tmpdir(), 'cairn-packaged-smoke-'))
  return {
    path: directory,
    cleanup: () =>
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
  }
}

/**
 * @param {{
 *   outputDir?: string;
 *   platform?: NodeJS.Platform;
 *   lookup?: typeof findUnpackedApp;
 * }} [options]
 * @returns {{ directory: string; executable: string }}
 */
export function packagedApp({ outputDir, platform, lookup = findUnpackedApp } = {}) {
  return lookup({
    ...(platform === undefined ? {} : { platform }),
    outputDir: outputDir ?? DEFAULT_OUTPUT_DIR,
  })
}
